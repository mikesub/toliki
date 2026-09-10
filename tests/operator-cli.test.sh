#!/usr/bin/env bash
set -uo pipefail

# Exercises the laptop-side `./toliki` command surface against a throwaway
# registry and fake ssh/git binaries. Nothing here reaches a host, a network or
# the real registry: every assertion is about what the CLI would have sent.
#
# The engine-inheritance, capacity-override and routing semantics behind
# `run`/`route`/`usage` are gated by tests/dispatch-engine.test.sh against the
# real dispatch.sh. This suite gates the surface itself: which commands exist,
# what help says, what each one refuses locally, and the laptop/host boundary.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"; printf '%s\n' "$2" | sed 's/^/         /' | head -20
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi; }
assert_file() { if [[ -f "$2" ]]; then ok "$1"; else nok "$1 (missing: $2)"; fi; }
assert_absent() { if [[ ! -e "$2" ]]; then ok "$1"; else nok "$1 (still present: $2)"; fi; }

# ───────────────────────── the root entry point ─────────────────────────
printf '\nroot: one entry point, no leftovers\n'
assert_file "the CLI lives at the repo root" "$ROOT/toliki"
if [[ -x "$ROOT/toliki" ]]; then ok "and is executable"; else nok "and is executable"; fi
for gone in setup.sh config.sh remote-control.sh deploy.sh; do
  # Explicitly not kept as compatibility wrappers: two ways to launch a
  # pipeline is exactly the drift this CLI exists to remove.
  assert_absent "the old $gone entry point is gone" "$ROOT/$gone"
done
for concern in lib setup config sessions run route usage sync; do
  assert_file "operator/$concern.sh holds its concern" "$ROOT/operator/$concern.sh"
done
# The boundary the layout encodes: laptop-side implementations stay out of bin/.
assert_absent "no laptop CLI leaked into the host-only bin/" "$ROOT/bin/sessions.sh"

# ───────────────────────── hermetic laptop checkout ─────────────────────────
LAPTOP="$TMP/laptop"
mkdir -p "$LAPTOP/etc" "$TMP/bin"
cp "$ROOT/toliki" "$LAPTOP/"
cp -R "$ROOT/operator" "$LAPTOP/"
cp "$ROOT/etc/lib.sh" "$ROOT/etc/engines.json" "$LAPTOP/etc/"
cat > "$LAPTOP/etc/repos.conf" <<CONF
REPOS=( testrepo=$TMP/testrepo otherapp=$TMP/otherapp )
REPO_ORIGINS=( testrepo=owner/testrepo otherapp=owner/otherapp )
HOST_CONTROL_DIR="/remote/toliki"
SSH_HOST="stub-host"
NAMES=(alpha beta)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
HOST_TIMEZONE="UTC"
CONF

# Records both halves of what would have been sent: the argv form (a single
# remote command string) and the stdin form (`bash -s` with a heredoc).
cat > "$TMP/bin/ssh" <<'STUB'
#!/usr/bin/env bash
printf 'host=%s args=%s\n' "$1" "${*:2}" >> "$SSH_LOG"
cat >> "$SSH_LOG"
STUB
cat > "$TMP/bin/git" <<'STUB'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$GIT_LOG"
STUB
chmod +x "$TMP/bin/ssh" "$TMP/bin/git"

OUT=""
RC=0
SSH_SENT=""
GIT_RAN=""
run_cli() { # every argument goes to ./toliki
  : > "$TMP/ssh.log"
  : > "$TMP/git.log"
  # No `set -e` in this suite, so a non-zero CLI exit is just a value to read.
  # ${1+"$@"} rather than "$@": a bare `./toliki` is one of the cases under
  # test, and older bash treats an empty "$@" as unbound under `set -u`.
  OUT="$(PATH="$TMP/bin:$PATH" SSH_LOG="$TMP/ssh.log" GIT_LOG="$TMP/git.log" \
    bash "$LAPTOP/toliki" ${1+"$@"} </dev/null 2>&1)"
  RC=$?
  SSH_SENT="$(cat "$TMP/ssh.log")"
  GIT_RAN="$(cat "$TMP/git.log")"
}

# ───────────────────────── navigable help ─────────────────────────
printf '\nhelp: the top level shows every feature group\n'
run_cli
assert_rc "a bare ./toliki prints help and exits 0" 0 "$RC"
for group in "setup" "sync" "config show" "config set" "session list" \
             "session start|stop" "session restart" "session stop-all" \
             "run epic|task|fix|ci|defect <issue>" "route next <engine>" \
             "usage [days] [engine]" "help [command]"; do
  assert_contains "top-level help names '$group'" "$OUT" "$group"
done
assert_contains "help states the laptop/host boundary" "$OUT" "bin/"
assert_eq "help contacts no host" "" "$SSH_SENT"

run_cli --help
assert_rc "--help is the same door" 0 "$RC"
assert_contains "and prints the same groups" "$OUT" "run epic|task|fix|ci|defect <issue>"

run_cli help
assert_rc "so is the help command" 0 "$RC"
assert_contains "with the same groups" "$OUT" "route next <engine>"

printf '\nhelp: each group documents its own commands\n'
run_cli help run
assert_rc "help <command> reaches the group" 0 "$RC"
assert_contains "run help names the capacity override" "$OUT" "--over-capacity"
assert_contains "run help explains engine inheritance" "$OUT" "an inherited default stays a"
for kind in epic task fix ci defect; do
  assert_contains "run help documents $kind" "$OUT" "  $kind <ref>"
done
run_cli run --help
assert_contains "'run --help' is the same text" "$OUT" "--over-capacity"

run_cli help session
assert_contains "session help documents stop-all" "$OUT" "stop-all"
assert_contains "session help documents manual-only cleanup" "$OUT" "stop-manual"
assert_contains "session help documents safe workspace removal" "$OUT" "remove-workspace"
assert_contains "session help documents the pool names" "$OUT" "alpha beta"
run_cli help config
assert_contains "config help documents the setter" "$OUT" "config set --engine <name>"
run_cli help route
assert_contains "route help documents next" "$OUT" "next <engine>"
run_cli help usage
assert_contains "usage help documents the window" "$OUT" "days"
run_cli help sync
assert_contains "sync help says it only pulls" "$OUT" "Pull and rebase"
assert_contains "and points elsewhere for provisioning" "$OUT" "bin/provision.sh"
run_cli help setup
assert_contains "setup help says what it wires" "$OUT" "etc/repos.conf"

run_cli frobnicate
assert_rc "an unknown command is refused" 1 "$RC"
assert_contains "and points at the command list" "$OUT" "unknown command 'frobnicate'"
assert_eq "and contacts no host" "" "$SSH_SENT"

# ───────────────────────── sessions ─────────────────────────
printf '\nsession: host-wide views, repo-scoped names\n'
run_cli session list
assert_rc "list exits 0" 0 "$RC"
assert_contains "list dials the configured host" "$SSH_SENT" "host=stub-host"
assert_contains "and asks the host session owner for its sessions" "$SSH_SENT" "manual-session.sh list"

run_cli session ls
assert_contains "ls is the same command" "$SSH_SENT" "manual-session.sh list"

run_cli session list -r testrepo
assert_rc "a repo is refused on the host-wide list" 1 "$RC"
assert_contains "and says why" "$OUT" "host-wide"
assert_eq "and nothing is sent" "" "$SSH_SENT"

run_cli session stop-all -r testrepo
assert_rc "a repo is refused on stop-all too" 1 "$RC"
assert_eq "and nothing is sent" "" "$SSH_SENT"

run_cli session stop
assert_rc "stop needs a name" 1 "$RC"
assert_contains "and says so" "$OUT" "requires at least one session name"

run_cli session stop epic-7 -r testrepo
assert_contains "a short name is prefixed with its repo" "$SSH_SENT" "'testrepo-epic-7'"
run_cli session rm otherapp-alpha
assert_contains "rm is an alias for stop" "$SSH_SENT" "manual-session.sh stop"
assert_contains "and a full name from list passes through" "$SSH_SENT" "'otherapp-alpha'"

run_cli session stop-manual
assert_contains "manual-only batch cleanup reaches its narrow host action" "$SSH_SENT" "manual-session.sh stop-manual"
assert_not_contains "manual cleanup does not invoke host-wide stop-all" "$SSH_SENT" "kill-server"

run_cli session remove-workspace otherapp-alpha
assert_contains "workspace removal targets the exact retained session" "$SSH_SENT" "remove-workspace --repo 'otherapp' 'otherapp-alpha'"

run_cli session start review -m "look at the logs"
assert_contains "start reaches the host's launch primitive" "$SSH_SENT" "/remote/toliki/bin/launch.sh"
assert_contains "in the default repo" "$SSH_SENT" "--repo 'testrepo'"
assert_contains "with the requested name" "$SSH_SENT" "'review'"
assert_contains "and the initial prompt" "$SSH_SENT" "--message 'look at the logs'"

run_cli session start review --engine codex
assert_rc "Codex is accepted for an interactive session" 0 "$RC"
assert_contains "and reaches the host launch" "$SSH_SENT" "--engine 'codex'"

run_cli session start -r nosuchrepo
assert_rc "an unknown repo is refused locally" 1 "$RC"
assert_contains "and lists the known ones" "$OUT" "testrepo"
assert_eq "and nothing is sent" "" "$SSH_SENT"

run_cli session restart testrepo-epic-7
assert_rc "restarting a pipeline session is refused" 1 "$RC"
assert_contains "and names the epic relaunch" "$OUT" "./toliki run epic 7"
assert_contains "and the fixer relaunch" "$OUT" "./toliki run fix 7"
assert_eq "and nothing is stopped" "" "$SSH_SENT"

run_cli session restart testrepo-epic-7 -m "keep this" --engine codex
assert_rc "pipeline restart is still refused when prompt and engine are present" 1 "$RC"
assert_eq "and remains mutation-free" "" "$SSH_SENT"

run_cli session epic 7
assert_rc "a pipeline name under session is refused" 1 "$RC"
assert_contains "and redirects to the run group" "$OUT" "./toliki run epic 7"

run_cli session start --engine nope
assert_rc "an unknown interactive engine is refused" 1 "$RC"
assert_contains "and names the choices" "$OUT" "claude or codex"
assert_eq "and nothing is sent" "" "$SSH_SENT"

run_cli session list -m hello
assert_rc "a message is refused where no claude is launched" 1 "$RC"
assert_contains "and says where it applies" "$OUT" "session start"

# ───────────────────────── manual pipeline launches ─────────────────────────
printf '\nrun: one pipeline, one issue, validated on the laptop\n'
run_cli run
assert_rc "a bare run prints its help" 0 "$RC"
assert_contains "listing the pipelines" "$OUT" "epic <ref>"

run_cli run frobnicate 7
assert_rc "an unknown pipeline is refused" 1 "$RC"
assert_contains "and lists the real ones" "$OUT" "epic|task|fix|ci|defect"

run_cli run epic
assert_rc "a pipeline needs an issue" 1 "$RC"
assert_contains "and shows the shape" "$OUT" "./toliki run epic 63"

run_cli run epic abc
assert_rc "a non-numeric reference is refused" 1 "$RC"
run_cli run epic 7 8
assert_rc "two references are refused" 1 "$RC"
assert_contains "and say so" "$OUT" "single issue reference"
run_cli run epic 7 --engine nosuchengine
assert_rc "an unknown engine is refused locally" 1 "$RC"
assert_contains "and lists the configured ones" "$OUT" "etc/engines.json"
run_cli run epic 7 -r nosuchrepo
assert_rc "an unknown repo is refused locally" 1 "$RC"
assert_eq "none of those reach the host" "" "$SSH_SENT"

run_cli run epic '#7' --engine claude
assert_contains "a leading # is not doubled" "$SSH_SENT" "--epic '7'"
assert_contains "the engine is persisted before the launch" "$SSH_SENT" "--route-issue '7' 'claude'"
assert_contains "and the launch runs only if that succeeded" "$SSH_SENT" "&&"

run_cli run task 7 -m hello
assert_rc "a message cannot ride a pipeline launch" 1 "$RC"
assert_eq "and nothing is sent" "" "$SSH_SENT"

# ───────────────────────── routing and reporting ─────────────────────────
printf '\nroute and usage: assign work, read what it cost\n'
run_cli route next
assert_rc "route next needs an engine" 1 "$RC"
assert_contains "and names the source of truth" "$OUT" "etc/engines.json"
run_cli route sideways
assert_rc "an unknown route command is refused" 1 "$RC"
run_cli route next claude
assert_contains "route next reaches dispatch" "$SSH_SENT" "--route-next 'claude'"
assert_not_contains "host-wide selection is not narrowed to a repo" "$SSH_SENT" "--repo"
run_cli route next claude -r otherapp
assert_contains "an explicit repo is forwarded" "$SSH_SENT" "--repo 'otherapp'"

run_cli usage 7 claude
assert_contains "usage runs the report on the host" "$SSH_SENT" "workflows/usage-report.mjs"
assert_contains "with the requested window" "$SSH_SENT" "--since '7d'"
assert_contains "and engine" "$SSH_SENT" "--engine 'claude'"
assert_contains "after loading the host's own registry" "$SSH_SENT" "source '/remote/toliki/etc/lib.sh'"
run_cli usage
assert_contains "a bare usage still runs the report" "$SSH_SENT" "usage-report.mjs"
assert_not_contains "and invents no window" "$SSH_SENT" "--since"
run_cli usage abc
assert_rc "a non-numeric window is refused" 1 "$RC"
run_cli usage 7 nosuchengine
assert_rc "an unknown engine filter is refused" 1 "$RC"
run_cli usage -r testrepo
assert_rc "the report has no repo filter" 1 "$RC"
assert_eq "and none of those reach the host" "" "$SSH_SENT"

# ───────────────────────── sync ─────────────────────────
printf '\nsync: both checkouts, from the registry\n'
run_cli sync
assert_rc "sync exits 0" 0 "$RC"
assert_contains "the laptop checkout is rebased in place" "$GIT_RAN" "git -C $LAPTOP pull --rebase"
assert_contains "the host is the configured one" "$SSH_SENT" "host=stub-host"
assert_contains "and its checkout is the registered one" "$SSH_SENT" "git -C '/remote/toliki' pull --rebase"
assert_not_contains "no host name is hard-coded" "$SSH_SENT" "host=toliki"
run_cli sync --force
assert_rc "sync takes no arguments" 1 "$RC"
assert_eq "and does nothing when refused" "" "$GIT_RAN"

# ───────────────────────── a laptop with no registry yet ─────────────────────────
# setup seeds etc/repos.conf, so it must work before one exists — which is why
# the dispatcher loads nothing itself and operator/setup.sh skips operator/lib.sh.
printf '\nno registry: setup is still reachable, everything else refuses clearly\n'
FRESH="$TMP/fresh"
mkdir -p "$FRESH/etc"
cp "$ROOT/toliki" "$FRESH/"
cp -R "$ROOT/operator" "$FRESH/"
cp "$ROOT/etc/lib.sh" "$ROOT/etc/engines.json" "$FRESH/etc/"

FRESH_OUT="$(bash "$FRESH/toliki" help 2>&1)"; FRESH_RC=$?
assert_rc "top-level help needs no registry" 0 "$FRESH_RC"
assert_contains "and still lists the groups" "$FRESH_OUT" "session list"
FRESH_OUT="$(bash "$FRESH/toliki" setup --help 2>&1)"; FRESH_RC=$?
assert_rc "setup's own help needs no registry" 0 "$FRESH_RC"
FRESH_OUT="$(bash "$FRESH/toliki" session list 2>&1)"; FRESH_RC=$?
assert_rc "a host command without a registry refuses" 1 "$FRESH_RC"
assert_contains "naming the path it checked" "$FRESH_OUT" "$FRESH/etc/repos.conf"

# ───────────────────────── a registry with no SSH_HOST ─────────────────────────
printf '\nno SSH_HOST: every host command says where to set it\n'
grep -v '^SSH_HOST=' "$LAPTOP/etc/repos.conf" > "$LAPTOP/etc/repos.conf.next"
mv "$LAPTOP/etc/repos.conf.next" "$LAPTOP/etc/repos.conf"
for command in "session list" "route next claude" "usage" "sync" "config show"; do
  run_cli $command
  assert_rc "'$command' refuses without SSH_HOST" 1 "$RC"
  assert_contains "'$command' names the registry" "$OUT" "etc/repos.conf"
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
