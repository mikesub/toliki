#!/usr/bin/env bash
set -euo pipefail

# Exercises bin/update-claude.sh against stub binaries. Hermetic: stub
# `claude`, `tmux` and `flock` on PATH answer from environment variables and
# record their argv; launch.sh's --check-idle probe is REAL and reads the tmux
# stub, so "busy" here is decided by the same count the cap uses. A throwaway
# etc/repos.conf keeps lib.sh away from any real registry. No network, no
# host, no session.
#
# What it holds: the binary only moves on an idle box. Every scenario but two
# is a reason NOT to run `claude update` — a live pane, a held lock, a dry
# run — plus the two where it does, and the one where the update itself fails.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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

# ───────────────────────── the fake host ─────────────────────────
mkdir -p "$TMP/bin" "$TMP/tmp" "$TMP/home"

# claude: --version reads VERSION_FILE; `update` rewrites it to NEXT_VERSION
# when set (an update landed), leaves it alone otherwise (already current),
# and fails when UPDATE_FAIL is set.
cat > "$TMP/bin/claude" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CLAUDE_LOG"
case "${1:-}" in
  --version) echo "$(cat "$VERSION_FILE") (Claude Code)" ;;
  update)
    if [[ -n "${UPDATE_FAIL:-}" ]]; then echo "Failed to install update: boom"; exit 1; fi
    if [[ -n "${NEXT_VERSION:-}" ]]; then
      printf '%s' "$NEXT_VERSION" > "$VERSION_FILE"; echo "Successfully updated"
    else
      echo "Claude Code is up to date"
    fi ;;
esac
exit 0
STUB

# tmux: STUB_SESSIONS lists the sessions, STUB_PANE_CMD is every pane's
# foreground command (a shell name means "dead at a prompt").
cat > "$TMP/bin/tmux" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  list-sessions) [[ -n "${STUB_SESSIONS:-}" ]] && printf '%s\n' $STUB_SESSIONS; exit 0 ;;
  list-panes) echo "${STUB_PANE_CMD:-bash}"; exit 0 ;;
esac
exit 0
STUB

# flock: succeeds unless LOCK_HELD is set (macOS has no flock at all).
cat > "$TMP/bin/flock" <<'STUB'
#!/usr/bin/env bash
[[ -n "${LOCK_HELD:-}" ]] && exit 1
exit 0
STUB
chmod +x "$TMP/bin/claude" "$TMP/bin/tmux" "$TMP/bin/flock"

HARNESS="$TMP/harness"
mkdir -p "$HARNESS"
cp -R "$ROOT/bin" "$ROOT/etc" "$HARNESS/"
cat > "$HARNESS/etc/repos.conf" <<EOF2
REPOS=( testrepo=$TMP/nowhere )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="$HARNESS"
SSH_HOST="unused"
NAMES=(alpha bravo)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
EOF2
UPDATE="$HARNESS/bin/update-claude.sh"

RUN_OUT=""
RUN_RC=0
CLAUDE_LOG_FILE=""
VERSION_FILE="$TMP/version"
# run_update <installed-version> [args...]; scenario knobs come in via the
# environment: STUB_SESSIONS, STUB_PANE_CMD, NEXT_VERSION, UPDATE_FAIL, LOCK_HELD.
run_update() {
  printf '%s' "$1" > "$VERSION_FILE"; shift
  CLAUDE_LOG_FILE="$TMP/claude.$RANDOM.log"
  : > "$CLAUDE_LOG_FILE"
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" \
    HOME="$TMP/home" \
    TMPDIR="$TMP/tmp" \
    CLAUDE_LOG="$CLAUDE_LOG_FILE" \
    VERSION_FILE="$VERSION_FILE" \
    bash "$UPDATE" "$@" 2>&1
  )" || RUN_RC=$?
}
claude_log() { cat "$CLAUDE_LOG_FILE"; }
reset_knobs() { unset STUB_SESSIONS STUB_PANE_CMD NEXT_VERSION UPDATE_FAIL LOCK_HELD; }

printf '\nbusy host: a running pane blocks the update\n'
reset_knobs; export STUB_SESSIONS="testrepo-epic-63" STUB_PANE_CMD="node" NEXT_VERSION="2.1.258"
run_update 2.1.233
assert_rc "exits 0 (skipping is a clean outcome)" 0 "$RUN_RC"
assert_contains "it says the host is busy" "$RUN_OUT" "host busy (1 session(s) running"
assert_not_contains "claude update is never called" "$(claude_log)" "update"

printf '\nidle host, update available\n'
reset_knobs; export NEXT_VERSION="2.1.258"
run_update 2.1.233
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "claude update is called" "$(claude_log)" "update"
assert_contains "the version diff is logged" "$RUN_OUT" "updated 2.1.233 -> 2.1.258"

printf '\na dead pane at a shell prompt does not count as busy\n'
reset_knobs; export STUB_SESSIONS="testrepo-epic-63" STUB_PANE_CMD="bash" NEXT_VERSION="2.1.258"
run_update 2.1.233
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the update still runs" "$RUN_OUT" "updated 2.1.233 -> 2.1.258"

printf '\nidle host, already current\n'
reset_knobs
run_update 2.1.258
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it reports up to date with the version" "$RUN_OUT" "up to date (2.1.258)"

printf '\ndispatch lock held: skip, touch nothing\n'
reset_knobs; export LOCK_HELD=1 NEXT_VERSION="2.1.258"
run_update 2.1.233
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it says why" "$RUN_OUT" "could not take the dispatch lock"
assert_not_contains "claude update is never called" "$(claude_log)" "update"

printf '\ndry run: probe, report, do not install\n'
reset_knobs; export NEXT_VERSION="2.1.258"
run_update 2.1.233 -n
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it names what it would do and the current version" "$RUN_OUT" "would run 'claude update' (current 2.1.233)"
assert_not_contains "claude update is never called" "$(claude_log)" "update"

printf '\nthe update itself fails\n'
reset_knobs; export UPDATE_FAIL=1
run_update 2.1.233
assert_rc "exits 1 (needs a human)" 1 "$RUN_RC"
assert_contains "it reports the failure with the unchanged version" "$RUN_OUT" "claude update failed (still 2.1.233)"
assert_contains "and relays the installer's output" "$RUN_OUT" "boom"

printf '\nusage\n'
reset_knobs
run_update 2.1.233 --bogus
assert_rc "an unknown flag exits 1" 1 "$RUN_RC"
assert_contains "and prints usage" "$RUN_OUT" "Usage:"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
