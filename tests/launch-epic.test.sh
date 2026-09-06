#!/usr/bin/env bash
set -euo pipefail

# Exercises bin/launch.sh's two launch shapes against stub binaries. Hermetic:
# stub `tmux` and `node` on PATH record their argv instead of doing anything,
# `git` is REAL but only ever touches throwaway repos created under mktemp, and
# a throwaway etc/repos.conf points at those. No ssh, no live host, no session.
#
# What it holds: the pane line and the worktree. Those two are where a mistake
# is invisible until production — a session that launches the wrong script, or
# one whose worktree scrub eats node_modules, both look like a successful
# launch right up until the run behaves strangely an hour later.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unset EPIC_ENGINE   # a host default must not leak in; the scenarios that need it export their own

# The host default is read from the installed cron file (/etc/cron.d/harness-dispatch
# on a real box). Pin it at a throwaway path so these launches can never inherit
# — or be refused by — whatever the machine running the tests dispatches on.
# Absent by default; the scenario that wants a host default writes one.
INSTALLED_CRON="$TMP/installed-cron"
export DEFAULT_ENGINE_CRON="$INSTALLED_CRON"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"; printf '%s\n' "$2" | sed 's/^/         /' | head -20
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi; }
assert_file() { if [[ -e "$2" ]]; then ok "$1"; else nok "$1 (missing: $2)"; fi; }
assert_no_file() { if [[ ! -e "$2" ]]; then ok "$1"; else nok "$1 (unexpectedly present: $2)"; fi; }

# ───────────────────────── the fake host ─────────────────────────
mkdir -p "$TMP/bin"

# flock: the admission lock. Linux-only in production, so it is stubbed here
# the way dispatch's suite stubs it — without it these runs would exercise the
# no-flock fallback instead of the locked path the host actually takes.
cat > "$TMP/bin/flock" <<'STUB'
#!/usr/bin/env bash
printf 'flock %s\n' "$*" >> "$TMUX_LOG"
exit 0
STUB
chmod +x "$TMP/bin/flock"

# tmux: records every invocation. has-session answers from STUB_LIVE_SESSIONS
# (a space-separated list) so a scenario can put a session on the fake host and
# check the EXACT-name matching; unset, nothing is running and launch.sh always
# takes the create path. list-sessions/list-panes answer from STUB_SESSIONS /
# STUB_PANE_CMD — unset, the capacity count sees an idle box.
cat > "$TMP/bin/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "${1:-}" in
  has-session)
    # Mirrors tmux: "=name" is an exact match, a bare name matches prefixes.
    want="${3:-}"
    for s in ${STUB_LIVE_SESSIONS:-}; do
      case "$want" in
        "=$s") exit 0 ;;
        =*)    : ;;
        *)     [[ "$s" == "$want"* ]] && exit 0 ;;
      esac
    done
    exit 1 ;;
  list-sessions) [[ -n "${STUB_SESSIONS:-}" ]] && printf '%s\n' $STUB_SESSIONS; exit 0 ;;
  list-panes) echo "${STUB_PANE_CMD:-}"; exit 0 ;;
esac
exit 0
STUB

# node/claude: never actually run — the pane line is typed via send-keys, which
# the tmux stub only records. These exist so a bug that EXECUTES them directly
# fails loudly instead of reaching the real binaries.
for b in node claude; do
  cat > "$TMP/bin/$b" <<STUB
#!/usr/bin/env bash
printf 'UNEXPECTED direct execution of $b: %s\n' "\$*" >> "\$TMUX_LOG"
exit 97
STUB
  chmod +x "$TMP/bin/$b"
done
chmod +x "$TMP/bin/tmux"

# A throwaway clone with an origin, so `git pull --rebase` and `worktree add` work.
UPSTREAM="$TMP/upstream.git"
CLONE="$TMP/clone"
git init -q --bare -b main "$UPSTREAM"
git -c init.defaultBranch=main clone -q "$UPSTREAM" "$CLONE" 2>/dev/null
git -C "$CLONE" config user.email t@example.com
git -C "$CLONE" config user.name Test
git -C "$CLONE" config commit.gpgsign false
mkdir -p "$CLONE/frontend"
printf '{}\n' > "$CLONE/frontend/package.json"
git -C "$CLONE" add -A
git -C "$CLONE" commit -qm "initial"
git -C "$CLONE" push -q -u origin main 2>/dev/null

# A repos.conf pointing only at the throwaway clone, so nothing can resolve to
# a real checkout. lib.sh sources it from beside itself, so the harness is
# copied wholesale into TMP rather than mutated in place.
HARNESS="$TMP/harness"
mkdir -p "$HARNESS"
cp -R "$ROOT/bin" "$ROOT/etc" "$ROOT/workflows" "$HARNESS/"
cat > "$HARNESS/etc/repos.conf" <<EOF
REPOS=( testrepo=$CLONE )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="$HARNESS"
SSH_HOST="unused"
NAMES=(alpha bravo)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
HOST_TIMEZONE="Europe/Amsterdam"
EOF
LAUNCH="$HARNESS/bin/launch.sh"
WT_ROOT="$TMP/worktrees"

RUN_OUT=""
RUN_RC=0
TMUX_LOG_FILE=""
run_launch() {
  TMUX_LOG_FILE="$TMP/tmux.$RANDOM.log"
  : > "$TMUX_LOG_FILE"
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" \
    TMUX_LOG="$TMUX_LOG_FILE" \
    EPIC_WORKTREE_ROOT="$WT_ROOT" \
    HOST_TIMEZONE="Pacific/Honolulu" \
    TZ="Pacific/Honolulu" \
    HOME="$TMP/home" \
    bash "$LAUNCH" "$@" 2>&1
  )" || RUN_RC=$?
}
tmux_log() { cat "$TMUX_LOG_FILE"; }

printf '\nlaunch --epic: worktree + orchestrator pane line\n'
run_launch --epic 63 --repo testrepo
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "session is named <repo>-epic-<N>" "$(tmux_log)" "new-session -d -s testrepo-epic-63"
assert_contains "the pane starts in the worktree" "$(tmux_log)" "-c $WT_ROOT/testrepo/testrepo-epic-63"
assert_contains "the repo tag is set" "$(tmux_log)" "set-option -t testrepo-epic-63 @repo testrepo"
assert_contains "the default engine tag is Claude" "$(tmux_log)" "set-option -t testrepo-epic-63 @engine claude"
assert_contains "the pane runs the epic orchestrator" "$(tmux_log)" "workflows/epic-run.mjs' --issue 63"
assert_contains "the session name is threaded through" "$(tmux_log)" "--session 'testrepo-epic-63'"
assert_contains "the default engine reaches the orchestrator" "$(tmux_log)" "--engine 'claude'"
assert_contains "the pane gets the registry zone despite hostile caller values" "$(tmux_log)" "TZ='Europe/Amsterdam' HOST_TIMEZONE='Europe/Amsterdam' node"
assert_not_contains "no interactive claude is launched" "$(tmux_log)" "--remote-control"
assert_file "the worktree exists" "$WT_ROOT/testrepo/testrepo-epic-63/frontend/package.json"

printf '\nlaunch --fix: same session shape, fixer script\n'
run_launch --fix '#63' --repo testrepo
assert_rc "exits 0 (and strips the leading #)" 0 "$RUN_RC"
assert_contains "session is still <repo>-epic-<N>" "$(tmux_log)" "new-session -d -s testrepo-epic-63"
assert_contains "the pane runs the fixer orchestrator" "$(tmux_log)" "workflows/fix-run.mjs' --issue 63"

printf '\nlaunch: a longer-numbered live session is not this one\n'
# A bare `-t` matches session-name PREFIXES, so epic-63 would read a live
# epic-631 as itself, report "already running" and start nothing.
STUB_LIVE_SESSIONS="testrepo-epic-631" run_launch --epic 63 --repo testrepo
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the session is still created" "$(tmux_log)" "new-session -d -s testrepo-epic-63"
assert_contains "and the check was pinned to the exact name" "$(tmux_log)" "has-session -t =testrepo-epic-63"
unset STUB_LIVE_SESSIONS

printf '\nlaunch: an exactly-named live session is reported, never relaunched\n'
STUB_LIVE_SESSIONS="testrepo-epic-63" run_launch --epic 63 --repo testrepo
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it says the session is already there" "$RUN_OUT" "already running"
assert_not_contains "and creates nothing" "$(tmux_log)" "new-session"
unset STUB_LIVE_SESSIONS

printf '\nlaunch: counting and creating are one critical section\n'
run_launch --epic 63 --repo testrepo
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the admission lock is taken before the count" "$(tmux_log)" "flock 8"
assert_contains "and released once the session exists" "$(tmux_log)" "flock -u 8"

printf '\nlaunch --ci: same session shape, CI fixer script\n'
run_launch --ci '#63' --repo testrepo
assert_rc "exits 0 (and strips the leading #)" 0 "$RUN_RC"
assert_contains "session is still <repo>-epic-<N>" "$(tmux_log)" "new-session -d -s testrepo-epic-63"
assert_contains "the pane runs the CI orchestrator" "$(tmux_log)" "workflows/ci-run.mjs' --issue 63"

printf '\nlaunch --defect: same worktree/session shape, defect fixer script\n'
run_launch --defect '#63' --repo testrepo --engine codex
assert_rc "exits 0 (and strips the leading #)" 0 "$RUN_RC"
assert_contains "session is still <repo>-epic-<N>" "$(tmux_log)" "new-session -d -s testrepo-epic-63"
assert_contains "the existing pipeline worktree is reused" "$RUN_OUT" "reusing worktree"
assert_contains "the pane runs the defect orchestrator" "$(tmux_log)" "workflows/defect-run.mjs' --issue 63"
assert_contains "the session name reaches the defect orchestrator" "$(tmux_log)" "--session 'testrepo-epic-63'"
assert_contains "the selected engine reaches the defect orchestrator" "$(tmux_log)" "--engine 'codex'"

printf '\nlaunch --epic --engine codex: engine is tagged and forwarded\n'
run_launch --epic 64 --repo testrepo --engine codex
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the Codex engine tag is set" "$(tmux_log)" "set-option -t testrepo-epic-64 @engine codex"
assert_contains "Codex reaches the orchestrator" "$(tmux_log)" "--engine 'codex'"

printf '\nlaunch --epic: with no installed cron file the default is the built-in claude\n'
# This process's EPIC_ENGINE never selects: cron exports one into a tick and an
# ssh command has none, so reading it here would split the host default in two.
export EPIC_ENGINE=codex
run_launch --epic 65 --repo testrepo
unset EPIC_ENGINE
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "an ambient EPIC_ENGINE is ignored" "$(tmux_log)" "set-option -t testrepo-epic-65 @engine claude"
assert_contains "and claude reaches the orchestrator" "$(tmux_log)" "--engine 'claude'"
printf 'EPIC_ENGINE=nope\n' > "$INSTALLED_CRON"
run_launch --epic 66 --repo testrepo
rm -f "$INSTALLED_CRON"
assert_rc "an unknown installed EPIC_ENGINE exits 1" 1 "$RUN_RC"
assert_contains "and names the knob" "$RUN_OUT" "EPIC_ENGINE must name an engine"
assert_not_contains "before any session is created" "$(tmux_log)" "new-session -d -s testrepo-epic-66"

printf '\nlaunch --epic: the installed cron file is the host default\n'
# cron and an ssh command have different process environments, so a manual
# launch cannot read the host default out of its own env: it reads the same
# installed file the dispatch tick does, and the two must never disagree.
printf 'EPIC_ENGINE=codex\n' > "$INSTALLED_CRON"
run_launch --epic 67 --repo testrepo
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the installed default is tagged" "$(tmux_log)" "set-option -t testrepo-epic-67 @engine codex"
assert_contains "and reaches the orchestrator" "$(tmux_log)" "--engine 'codex'"

export EPIC_ENGINE=claude
run_launch --epic 68 --repo testrepo
unset EPIC_ENGINE
assert_rc "an env default disagreeing with the installed file exits 1" 1 "$RUN_RC"
assert_contains "and names the knob" "$RUN_OUT" "EPIC_ENGINE"
assert_not_contains "before any session is created" "$(tmux_log)" "new-session -d -s testrepo-epic-68"

printf 'EPIC_ENGINE=codex\nEPIC_ENGINE=claude\n' > "$INSTALLED_CRON"
run_launch --epic 69 --repo testrepo
assert_rc "an installed file with two EPIC_ENGINE lines exits 1" 1 "$RUN_RC"
assert_not_contains "and starts nothing" "$(tmux_log)" "new-session -d -s testrepo-epic-69"

# The probes answer a counting question. They must not acquire an opinion about
# engine config, or a malformed cron file would stop dispatch's capacity probe
# and update-claude's idle check along with the launches.
run_launch --check-capacity
assert_rc "the capacity probe ignores a malformed installed file" 0 "$RUN_RC"
run_launch --check-idle
assert_rc "the idle probe ignores a malformed installed file" 0 "$RUN_RC"
rm -f "$INSTALLED_CRON"

printf '\nlaunch --epic: a reused worktree is scrubbed but keeps ignored files\n'
WT="$WT_ROOT/testrepo/testrepo-epic-63"
mkdir -p "$WT/frontend/node_modules/left-pad" "$WT/.epics/63-slug"
printf 'installed\n' > "$WT/frontend/node_modules/left-pad/index.js"
printf '# phase log\n' > "$WT/.epics/63-slug/epic.md"
printf 'node_modules/\n.epics/\n' > "$WT/.gitignore"
printf 'uncommitted junk\n' > "$WT/frontend/scratch.ts"     # untracked, NOT ignored
git -C "$WT" add .gitignore && git -C "$WT" -c user.email=t@e.com -c user.name=T -c commit.gpgsign=false commit -qm "ignore rules"
run_launch --epic 63 --repo testrepo
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it reports the reuse" "$RUN_OUT" "reusing worktree"
assert_file "node_modules survives the scrub" "$WT/frontend/node_modules/left-pad/index.js"
assert_file ".epics/ survives the scrub (resume appends to epic.md)" "$WT/.epics/63-slug/epic.md"
assert_no_file "untracked non-ignored junk is cleaned" "$WT/frontend/scratch.ts"

printf '\nlaunch: the interactive path is unchanged\n'
run_launch --repo testrepo -m "look at the logs"
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it launches interactive claude" "$(tmux_log)" "claude --remote-control testrepo-look-at-the-logs --dangerously-skip-permissions --worktree testrepo-look-at-the-logs"
assert_contains "interactive panes get the same registry zone" "$(tmux_log)" "TZ='Europe/Amsterdam' HOST_TIMEZONE='Europe/Amsterdam' claude"
assert_contains "the message is passed as a positional prompt" "$(tmux_log)" "'look at the logs'"
assert_contains "the pane starts in the clone, not a pipeline worktree" "$(tmux_log)" "-c $CLONE"

printf '\nlaunch: conflicting flags are refused\n'
run_launch --epic 63 --fix 64 --repo testrepo
assert_rc "--epic with --fix exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "mutually exclusive"

run_launch --fix 63 --ci 64 --repo testrepo
assert_rc "--fix with --ci exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "mutually exclusive"

run_launch --defect 63 --ci 64 --repo testrepo
assert_rc "--defect with --ci exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "mutually exclusive"

run_launch --defect 63 -m "hello" --repo testrepo
assert_rc "--defect with -m exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "takes no -m"

run_launch --defect 63 somename --repo testrepo
assert_rc "--defect with an explicit name exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "derives its own session name"

run_launch --epic 63 -m "hello" --repo testrepo
assert_rc "--epic with -m exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "takes no -m"

run_launch --epic 63 somename --repo testrepo
assert_rc "--epic with an explicit name exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "derives its own session name"

run_launch --epic not-a-number --repo testrepo
assert_rc "a non-numeric issue exits 1" 1 "$RUN_RC"
assert_contains "and says why" "$RUN_OUT" "takes an issue number"

run_launch --epic 63 --engine unknown --repo testrepo
assert_rc "an unknown engine exits 1" 1 "$RUN_RC"
assert_contains "and names the allowed engines" "$RUN_OUT" "must name an engine"
assert_not_contains "validation happens before any session is created" "$(tmux_log)" "new-session"

run_launch --engine codex --repo testrepo
assert_rc "--engine is refused for interactive sessions" 1 "$RUN_RC"
assert_contains "and says it is pipeline-only" "$RUN_OUT" "only applies to --epic/--fix/--ci/--defect"

printf '\nlaunch --check-idle: the cap'"'"'s own count, against zero\n'
run_launch --check-idle
assert_rc "an empty host is idle (exit 0)" 0 "$RUN_RC"
assert_contains "and says so" "$RUN_OUT" "idle"
assert_not_contains "it starts nothing" "$(tmux_log)" "new-session"
export STUB_SESSIONS="testrepo-epic-63" STUB_PANE_CMD="node"
run_launch --check-idle
assert_rc "a running pane is not idle (exit 3, same code as the cap)" 3 "$RUN_RC"
assert_contains "and names the count" "$RUN_OUT" "1 session(s) running"
export STUB_PANE_CMD="bash"
run_launch --check-idle
assert_rc "a dead pane at a shell prompt is idle" 0 "$RUN_RC"
unset STUB_SESSIONS STUB_PANE_CMD

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
