#!/usr/bin/env bash
set -euo pipefail

# Exercises bin/reap.sh's third pass — removing the worktree of a run whose
# work has already landed — and the guards that stop it removing anything else.
# Hermetic: stub `tmux` and `gh` on PATH, real `git` against throwaway repos
# under mktemp, and a throwaway etc/repos.conf so REPOS cannot resolve to a
# real clone. Nothing here touches a live host.
#
# The guards ARE the feature: removing a directory is not undoable, so each
# case below is a reason to keep one.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"; printf '%s\n' "$2" | sed 's/^/         /' | head -20
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpected: $3)"; fi; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_dir() { if [[ -d "$2" ]]; then ok "$1"; else nok "$1 (gone: $2)"; fi; }
assert_no_dir() { if [[ ! -d "$2" ]]; then ok "$1"; else nok "$1 (still there: $2)"; fi; }

mkdir -p "$TMP/bin"
# gh: the auth preflight, plus pass 1's one issue query — state, updatedAt and
# labels on a single line. Silent unless a scenario sets FAKE_ISSUE, so the
# worktree passes below can never read a session as terminal.
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
[[ "${1:-}" == "auth" ]] && exit 0
if [[ "${1:-} ${2:-}" == "issue view" && -n "${FAKE_ISSUE:-}" ]]; then
  printf '%s\n' "$FAKE_ISSUE"
fi
exit 0
STUB
# tmux: reports exactly the sessions named in $FAKE_SESSIONS (newline separated).
cat > "$TMP/bin/tmux" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  list-sessions) [[ -n "${FAKE_SESSIONS:-}" ]] && printf '%s\n' "$FAKE_SESSIONS"; exit 0 ;;
  list-panes)    printf '%s\n' "${FAKE_PANE:-node}"; exit 0 ;;
  show-options)  printf '%s\n' "${FAKE_REPO_TAG:-testrepo}"; exit 0 ;;
esac
exit 0
STUB
# Never inspect the real host's process table from a hermetic reap test.
cat > "$TMP/bin/pgrep" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$TMP/bin/gh" "$TMP/bin/tmux" "$TMP/bin/pgrep"

UPSTREAM="$TMP/upstream.git"
CLONE="$TMP/clone"
git init -q --bare -b main "$UPSTREAM"
git -c init.defaultBranch=main clone -q "$UPSTREAM" "$CLONE" 2>/dev/null
git -C "$CLONE" config user.email t@example.com
git -C "$CLONE" config user.name Test
git -C "$CLONE" config commit.gpgsign false
printf 'hello\n' > "$CLONE/README.md"
git -C "$CLONE" add -A && git -C "$CLONE" commit -qm initial
git -C "$CLONE" push -q -u origin main 2>/dev/null

HARNESS="$TMP/harness"
mkdir -p "$HARNESS"
cp -R "$ROOT/bin" "$ROOT/etc" "$HARNESS/"
cat > "$HARNESS/etc/repos.conf" <<EOF
REPOS=( testrepo=$CLONE )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="$HARNESS"
SSH_HOST="unused"
NAMES=(alpha bravo)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
EOF

WT_ROOT="$TMP/worktrees"
mk_worktree() { # session-name age-hours
  local wt="$WT_ROOT/testrepo/$1"
  mkdir -p "$(dirname "$wt")"
  git -C "$CLONE" worktree add -q --detach "$wt" HEAD
  local stamp
  stamp="$(date -v-"$2"H +%Y%m%d%H%M 2>/dev/null || date -d "$2 hours ago" +%Y%m%d%H%M)"
  touch -t "$stamp" "$wt"
}

RUN_OUT=""
RUN_RC=0
run_reap() {
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" \
    EPIC_WORKTREE_ROOT="$WT_ROOT" \
    FAKE_SESSIONS="${FAKE_SESSIONS:-}" \
    FAKE_PANE="${FAKE_PANE:-}" \
    FAKE_ISSUE="${FAKE_ISSUE:-}" \
    TERMINAL_SETTLE_MINUTES="${TERMINAL_SETTLE_MINUTES:-}" \
    bash "$HARNESS/bin/reap.sh" "$@" 2>&1
  )" || RUN_RC=$?
}
ago() { date -u -v-"$1"M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d "$1 minutes ago" +%Y-%m-%dT%H:%M:%SZ; }

printf '\nreap pass 3: a delivered worktree is removed\n'
mk_worktree testrepo-epic-63 48
FAKE_SESSIONS="" run_reap -n
assert_contains "dry run announces it" "$RUN_OUT" "would remove worktree $WT_ROOT/testrepo/testrepo-epic-63"
assert_dir "dry run changed nothing" "$WT_ROOT/testrepo/testrepo-epic-63"
FAKE_SESSIONS="" run_reap
assert_contains "the real sweep reports it" "$RUN_OUT" "removed worktree"
assert_no_dir "the worktree is gone" "$WT_ROOT/testrepo/testrepo-epic-63"

printf '\nreap pass 3: a worktree whose branch is still on origin is kept\n'
mk_worktree testrepo-epic-64 48
git -C "$CLONE" push -q origin HEAD:refs/heads/epic/64-still-open 2>/dev/null
FAKE_SESSIONS="" run_reap
assert_dir "kept — the run's work is still unlanded" "$WT_ROOT/testrepo/testrepo-epic-64"
git -C "$CLONE" push -q origin --delete refs/heads/epic/64-still-open 2>/dev/null

printf '\nreap pass 3: a worktree with a live session is kept\n'
mk_worktree testrepo-epic-65 48
FAKE_SESSIONS="testrepo-epic-65" run_reap
assert_dir "kept — its session still owns the name" "$WT_ROOT/testrepo/testrepo-epic-65"

printf '\nreap pass 3: a recent worktree is kept\n'
mk_worktree testrepo-epic-66 1
FAKE_SESSIONS="" run_reap
assert_dir "kept — inside the grace window" "$WT_ROOT/testrepo/testrepo-epic-66"

printf '\nreap pass 3: an unreadable origin fails closed\n'
mk_worktree testrepo-epic-67 48
git -C "$CLONE" remote set-url origin "$TMP/does-not-exist.git"
FAKE_SESSIONS="" run_reap
assert_dir "kept — the ref listing failed, so nothing is proved delivered" "$WT_ROOT/testrepo/testrepo-epic-67"
assert_contains "and it says why" "$RUN_OUT" "could not list epic refs"
git -C "$CLONE" remote set-url origin "$UPSTREAM"

printf '\nreap pass 3: a hand-made directory is never touched\n'
mkdir -p "$WT_ROOT/testrepo/scratch-notes"
touch -t "$(date -v-48H +%Y%m%d%H%M 2>/dev/null || date -d '48 hours ago' +%Y%m%d%H%M)" "$WT_ROOT/testrepo/scratch-notes"
FAKE_SESSIONS="" run_reap
assert_dir "kept — it isn't a <repo>-epic-<N> worktree" "$WT_ROOT/testrepo/scratch-notes"

# A finished run writes its terminal label FIRST and only then reports: the label
# readback its guidance is composed from, the refusal comment, the status
# comment's last edit. All of that is inside this window, which is why the knob
# has a floor — a window shorter than the reporting it is meant to outlast kills
# the run before the issue ever says why it stopped.
printf '\nreap pass 1: a settle window under the floor is raised, not honoured\n'
FAKE_SESSIONS="testrepo-epic-70" FAKE_ISSUE="OPEN $(ago 2) failed" TERMINAL_SETTLE_MINUTES=1 run_reap -n
assert_contains "the too-short window is reported and raised" "$RUN_OUT" "TERMINAL_SETTLE_MINUTES=1 is below the 3m floor"
assert_contains "so a run two minutes into its terminal label is left to finish" "$RUN_OUT" "may still be finishing, leaving alone"

printf '\nreap pass 1: a genuinely settled terminal label is still reaped\n'
FAKE_SESSIONS="testrepo-epic-70" FAKE_ISSUE="OPEN $(ago 30) failed" TERMINAL_SETTLE_MINUTES=1 run_reap -n
assert_contains "the floor delays a kill, it never prevents one" "$RUN_OUT" "would kill testrepo-epic-70"

printf '\nreap pass 1: a dead ready session becomes terminal only after settling\n'
FAKE_SESSIONS="testrepo-epic-71" FAKE_PANE=bash FAKE_ISSUE="OPEN $(ago 2) ready" run_reap -n
assert_rc "a recently held ready session is not a human warning" 0 "$RUN_RC"
assert_contains "the ready label gets the ordinary settle window" "$RUN_OUT" "issue #71 ready but edited 2m ago — may still be finishing, leaving alone"
assert_not_contains "the recent session is not killed" "$RUN_OUT" "would kill testrepo-epic-71"
FAKE_SESSIONS="testrepo-epic-71" FAKE_PANE=bash FAKE_ISSUE="OPEN $(ago 30) ready" run_reap -n
assert_rc "a settled held session is normal cleanup" 0 "$RUN_RC"
assert_contains "a settled dead ready session is reaped" "$RUN_OUT" "would kill testrepo-epic-71 (issue #71 ready)"

printf '\nreap pass 1: ready is not terminal while its pipeline is alive\n'
FAKE_SESSIONS="testrepo-epic-72" FAKE_PANE=node FAKE_ISSUE="OPEN $(ago 30) ready" run_reap -n
assert_rc "a live ready run is not a warning" 0 "$RUN_RC"
assert_contains "the live run is left working" "$RUN_OUT" "working issue #72, leaving alone"
assert_not_contains "a live ready session is never killed" "$RUN_OUT" "would kill testrepo-epic-72"

printf '\nreap pass 1: a dead in-progress pane remains a human-visible crash\n'
FAKE_SESSIONS="testrepo-epic-73" FAKE_PANE=bash FAKE_ISSUE="OPEN $(ago 30) in-progress" run_reap -n
assert_rc "the dead in-progress session keeps reap nonzero" 1 "$RUN_RC"
assert_contains "the crash keeps its diagnostic scrollback" "$RUN_OUT" "process exited at a bash prompt but issue #73 is not terminal"
assert_not_contains "the crash is not killed" "$RUN_OUT" "would kill testrepo-epic-73"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
