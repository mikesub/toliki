#!/usr/bin/env bash
set -euo pipefail

# Exercises routing and dispatch against fake gh/tmux/flock/launch commands.
# All issue state lives in throwaway files; no network or live host is touched.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unset EPIC_ENGINE   # a host default must not leak in; the scenarios that need it export their own

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi; }
assert_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else nok "$1 (missing: $3)"; fi; }
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpected: $3)"; fi; }
assert_matches() { if [[ "$2" =~ $3 ]]; then ok "$1"; else nok "$1 (got '$2')"; fi; }
issue_labels() { tr ',' '\n' < "$TMP/labels/$1" | sed '/^$/d' | sort | tr '\n' ','; }

HARNESS="$TMP/harness"
REPO="$TMP/repo"
mkdir -p "$HARNESS" "$REPO/.git" "$TMP/bin" "$TMP/labels" "$TMP/blockers" "$TMP/locks"
cp -R "$ROOT/bin" "$ROOT/etc" "$HARNESS/"
cp "$ROOT/remote-control.sh" "$HARNESS/"
cp "$ROOT/default-engine.sh" "$HARNESS/"
# dispatch resolves the shared hold CLI relative to its own copied harness.
# During RED the module intentionally does not exist yet.
mkdir -p "$HARNESS/workflows"
[[ ! -f "$ROOT/workflows/quota-hold.mjs" ]] || cp "$ROOT/workflows/quota-hold.mjs" "$HARNESS/workflows/"
cat > "$HARNESS/etc/repos.conf" <<EOF
REPOS=( testrepo=$REPO )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="$HARNESS"
SSH_HOST="unused"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
DEFECT_FIX_REPOS=()
HOST_TIMEZONE="Europe/Amsterdam"
EOF

set_defect_fix_repos() {
  grep -v '^DEFECT_FIX_REPOS=' "$HARNESS/etc/repos.conf" > "$HARNESS/etc/repos.conf.next"
  printf 'DEFECT_FIX_REPOS=(%s)\n' "$1" >> "$HARNESS/etc/repos.conf.next"
  mv "$HARNESS/etc/repos.conf.next" "$HARNESS/etc/repos.conf"
}
unset_defect_fix_repos() {
  grep -v '^DEFECT_FIX_REPOS=' "$HARNESS/etc/repos.conf" > "$HARNESS/etc/repos.conf.next"
  mv "$HARNESS/etc/repos.conf.next" "$HARNESS/etc/repos.conf"
}
set_host_timezone() {
  grep -v '^HOST_TIMEZONE=' "$HARNESS/etc/repos.conf" > "$HARNESS/etc/repos.conf.next"
  printf 'HOST_TIMEZONE="%s"\n' "$1" >> "$HARNESS/etc/repos.conf.next"
  mv "$HARNESS/etc/repos.conf.next" "$HARNESS/etc/repos.conf"
}

cat > "$HARNESS/bin/launch.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LAUNCH_LOG"
if [[ "$*" == "--check-capacity" ]]; then exit "${CAPACITY_RC:-0}"; fi
exit "${LAUNCH_RC:-0}"
STUB
chmod +x "$HARNESS/bin/launch.sh"

cat > "$TMP/bin/flock" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FLOCK_LOG"
[[ "${FLOCK_BUSY:-}" != "1" ]] || exit 1
exit 0
STUB
cat > "$TMP/bin/tmux" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  has-session)
    [[ "$*" != *"=${STUB_SESSION_NAME:-__none__}"* ]] || exit 0
    exit 1 ;;
esac
exit 0
STUB
cat > "$TMP/bin/ssh" <<'STUB'
#!/usr/bin/env bash
if [[ "${EXEC_SSH_STDIN:-}" == "1" ]]; then
  shift
  exec "$@"
fi
printf '%s\n' "$*" > "$SSH_LOG"
STUB

cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GH_LOG"
case "${1:-} ${2:-}" in
  "issue list")
    [[ "${FAIL_QUEUE:-}" != "1" ]] || exit 6
    if [[ "$*" == *needs-judgment* ]]; then
      [[ -z "${FIXER_QUEUE:-}" ]] || printf '%b\n' "$FIXER_QUEUE"
    elif [[ "$*" == *needs-ci-fix* ]]; then
      [[ -z "${CI_QUEUE:-}" ]] || printf '%b\n' "$CI_QUEUE"
    elif [[ "$*" == *needs-defect-fix* ]]; then
      [[ -z "${DEFECT_QUEUE:-}" ]] || printf '%b\n' "$DEFECT_QUEUE"
    else
      [[ -z "${READY_QUEUE:-}" ]] || printf '%b\n' "$READY_QUEUE"
    fi
    ;;
  "issue view")
    n="$3"
    [[ "${FAIL_VIEW_ISSUE:-}" != "$n" ]] || exit 9
    labels="$(cat "$LABEL_DIR/$n" 2>/dev/null || true)"
    printf 'OPEN\n'
    if [[ "${COMMA_LABEL_ISSUE:-}" == "$n" ]]; then
      printf 'ready\ncustomer,engine:codex\n'
    elif [[ -n "$labels" ]]; then
      printf '%s\n' "$labels" | tr ',' '\n'
    fi
    ;;
  "issue edit")
    n="$3"
    [[ "${FAIL_EDIT_ISSUE:-}" != "$n" ]] || exit 8
    shift 3
    adds=()
    removes=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --add-label) adds+=("$2"); shift 2 ;;
        --remove-label) removes+=("$2"); shift 2 ;;
        *) shift ;;
      esac
    done
    labels="$(cat "$LABEL_DIR/$n" 2>/dev/null || true)"
    kept=""
    old_ifs="$IFS"; IFS=','
    for label in $labels; do
      drop=0
      for remove in "${removes[@]}"; do [[ "$label" == "$remove" ]] && drop=1; done
      if (( ! drop )); then kept="${kept:+$kept,}$label"; fi
    done
    IFS="$old_ifs"
    labels="$kept"
    for add in "${adds[@]}"; do
      if [[ ",$labels," != *",$add,"* ]]; then labels="${labels:+$labels,}$add"; fi
    done
    if [[ "${REROUTE_AFTER_SHIELD_ISSUE:-}" == "$n" && " ${adds[*]} " == *" in-progress "* ]]; then
      kept=""
      old_ifs="$IFS"; IFS=','
      for label in $labels; do
        [[ "$label" == engine:* ]] || kept="${kept:+$kept,}$label"
      done
      IFS="$old_ifs"
      labels="${kept:+$kept,}engine:${REROUTE_AFTER_SHIELD_ENGINE}"
    fi
    printf '%s' "$labels" > "$LABEL_DIR/$n"
    ;;
  "label create") ;;
  api*)
    n="$(printf '%s' "$2" | sed -n 's#.*issues/\([0-9][0-9]*\)/dependencies.*#\1#p')"
    [[ "${FAIL_BLOCKER_ISSUE:-}" != "$n" ]] || exit 7
    cat "$BLOCKER_DIR/$n" 2>/dev/null || true
    ;;
esac
STUB
chmod +x "$TMP/bin/flock" "$TMP/bin/tmux" "$TMP/bin/ssh" "$TMP/bin/gh"

DISPATCH="$HARNESS/bin/dispatch.sh"
RUN_OUT=""
RUN_RC=0
run_dispatch() {
  : > "$TMP/launch.log"
  : > "$TMP/gh.log"
  : > "$TMP/flock.log"
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" TMPDIR="$TMP/locks" \
    LAUNCH_LOG="$TMP/launch.log" GH_LOG="$TMP/gh.log" FLOCK_LOG="$TMP/flock.log" \
    LABEL_DIR="$TMP/labels" BLOCKER_DIR="$TMP/blockers" \
    READY_QUEUE="${READY_QUEUE:-}" FIXER_QUEUE="${FIXER_QUEUE:-}" CI_QUEUE="${CI_QUEUE:-}" DEFECT_QUEUE="${DEFECT_QUEUE:-}" \
    FAIL_VIEW_ISSUE="${FAIL_VIEW_ISSUE:-}" FAIL_EDIT_ISSUE="${FAIL_EDIT_ISSUE:-}" \
    FAIL_BLOCKER_ISSUE="${FAIL_BLOCKER_ISSUE:-}" \
    FAIL_QUEUE="${FAIL_QUEUE:-}" \
    COMMA_LABEL_ISSUE="${COMMA_LABEL_ISSUE:-}" \
    REROUTE_AFTER_SHIELD_ISSUE="${REROUTE_AFTER_SHIELD_ISSUE:-}" \
    REROUTE_AFTER_SHIELD_ENGINE="${REROUTE_AFTER_SHIELD_ENGINE:-}" \
    FLOCK_BUSY="${FLOCK_BUSY:-}" STUB_SESSION_NAME="${STUB_SESSION_NAME:-}" \
    CAPACITY_RC="${CAPACITY_RC:-}" LAUNCH_RC="${LAUNCH_RC:-}" \
    EPIC_PROVIDER_HOLD_FILE="$TMP/provider-hold.json" \
    HOST_TIMEZONE="Pacific/Honolulu" TZ="Pacific/Honolulu" \
    bash "$DISPATCH" "$@" 2>&1
  )" || RUN_RC=$?
}

reset_state() {
  rm -f "$TMP/labels"/* "$TMP/blockers"/*
  rm -rf "$TMP/provider-hold.json"
  READY_QUEUE=""
  FIXER_QUEUE=""
  CI_QUEUE=""
  DEFECT_QUEUE=""
  FAIL_VIEW_ISSUE=""
  FAIL_EDIT_ISSUE=""
  FAIL_BLOCKER_ISSUE=""
  FAIL_QUEUE=""
  COMMA_LABEL_ISSUE=""
  REROUTE_AFTER_SHIELD_ISSUE=""
  REROUTE_AFTER_SHIELD_ENGINE=""
  FLOCK_BUSY=""
  STUB_SESSION_NAME=""
  LAUNCH_RC=""
  CAPACITY_RC=""
  set_defect_fix_repos ""
}

assert_contains "the tracked config documents an empty-by-default defect allowlist" "$(cat "$ROOT/etc/repos.conf.template")" "DEFECT_FIX_REPOS=("

printf '\ndefault engine: reports, validates, updates, and reads back live cron state\n'
ENGINE_CRON="$TMP/harness-dispatch"
cp "$HARNESS/etc/dispatch.cron" "$ENGINE_CRON"
ENGINE_OUT="$(PATH="$TMP/bin:$PATH" EXEC_SSH_STDIN=1 DEFAULT_ENGINE_CRON="$ENGINE_CRON" bash "$HARNESS/default-engine.sh")"
assert_contains "the current installed default is shown" "$ENGINE_OUT" "default: codex"
assert_contains "every configured engine is shown" "$ENGINE_OUT" "available: claude codex codex+claude"
PATH="$TMP/bin:$PATH" EXEC_SSH_STDIN=1 DEFAULT_ENGINE_CRON="$ENGINE_CRON" bash "$HARNESS/default-engine.sh" claude >/dev/null
assert_eq "the selected engine is written once" "EPIC_ENGINE=claude" "$(grep '^EPIC_ENGINE=' "$ENGINE_CRON")"
assert_contains "the rest of the cron file is preserved" "$(cat "$ENGINE_CRON")" "bin/merge-tick.sh"
set +e
ENGINE_OUT="$(PATH="$TMP/bin:$PATH" EXEC_SSH_STDIN=1 DEFAULT_ENGINE_CRON="$ENGINE_CRON" bash "$HARNESS/default-engine.sh" missing 2>&1)"
ENGINE_RC=$?
set -e
assert_rc "an unknown engine is rejected" 1 "$ENGINE_RC"
assert_contains "the rejection lists valid choices" "$ENGINE_OUT" "available: claude codex codex+claude"
assert_eq "a rejected engine leaves the default unchanged" "EPIC_ENGINE=claude" "$(grep '^EPIC_ENGINE=' "$ENGINE_CRON")"

printf '\ndispatch hold: a Claude hold skips Claude and mixed engines but admits Codex\n'
reset_state
READY_QUEUE='1\n2\n3'
printf 'ready' > "$TMP/labels/1"
printf 'ready,engine:claude' > "$TMP/labels/2"
printf 'ready,engine:codex' > "$TMP/labels/3"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
export EPIC_ENGINE=codex+claude
run_dispatch
unset EPIC_ENGINE
assert_rc "selective admission is a clean tick" 0 "$RUN_RC"
assert_eq "the default mixed engine logs one Claude hold line" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#1: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"
assert_eq "the explicit Claude engine logs one Claude hold line" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#2: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"
assert_not_contains "selective held lines do not expose the canonical UTC deadline" "$RUN_OUT" "2099-01-01T00:00:00.000Z"
assert_contains "engine:codex candidate launches while claude is held" "$(cat "$TMP/launch.log")" '--epic 3 --repo testrepo --engine codex'
assert_not_contains "the mixed engine is not launched" "$(cat "$TMP/launch.log")" '--epic 1'
assert_not_contains "the Claude engine is not launched" "$(cat "$TMP/launch.log")" '--epic 2'
assert_eq "held ready issues receive no label write" "" "$(grep 'issue edit [12] ' "$TMP/gh.log" || true)"

printf '\ndispatch hold: dry-run uses the same selective gate and keeps walking\n'
reset_state
READY_QUEUE='4\n5'
printf 'ready,engine:codex' > "$TMP/labels/4"
printf 'ready,engine:claude' > "$TMP/labels/5"
printf '%s\n' '{"codex":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"limit without reset","fallback":true}}' > "$TMP/provider-hold.json"
run_dispatch --dry-run
assert_rc "selective dry-run exits cleanly" 0 "$RUN_RC"
assert_eq "dry-run logs the held Codex candidate once" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#4: held (codex quota until 2099-01-01 01:00:00 CET)' || true)"
assert_contains "dry-run still reports an unheld Claude launch" "$RUN_OUT" "#5 (testrepo): would launch 'testrepo-epic-5' with claude"
assert_not_contains "dry-run does not report the held candidate as launchable" "$RUN_OUT" "would launch 'testrepo-epic-4'"
assert_eq "dry-run calls no launch command" "" "$(cat "$TMP/launch.log")"

printf '\ndispatch hold: every matching vendor is named and both vendors stop all candidates\n'
reset_state
READY_QUEUE='6\n7\n8'
printf 'ready,engine:codex+claude' > "$TMP/labels/6"
printf 'ready,engine:claude' > "$TMP/labels/7"
printf 'ready,engine:codex' > "$TMP/labels/8"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false},"codex":{"holdUntil":"2099-01-02T00:00:00.000Z","reason":"usage limit","fallback":true}}' > "$TMP/provider-hold.json"
run_dispatch
assert_rc "an all-held tick is clean" 0 "$RUN_RC"
assert_eq "the mixed candidate gets exactly one held line" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#6: held (' || true)"
assert_contains "the mixed held line names Claude" "$RUN_OUT" "#6: held (claude quota until 2099-01-01 01:00:00 CET"
assert_contains "the mixed held line also names Codex" "$RUN_OUT" "codex quota until 2099-01-02 01:00:00 CET"
assert_not_contains "mixed-vendor held lines do not expose Claude's canonical UTC deadline" "$RUN_OUT" "2099-01-01T00:00:00.000Z"
assert_not_contains "mixed-vendor held lines do not expose Codex's canonical UTC deadline" "$RUN_OUT" "2099-01-02T00:00:00.000Z"
assert_eq "both held vendors launch no candidate" "" "$(grep -- '--epic' "$TMP/launch.log" || true)"
assert_eq "an all-held tick writes no labels" "" "$(grep 'issue edit' "$TMP/gh.log" || true)"

printf '\ndispatch hold: all-held candidates are reported even when the host is full\n'
reset_state
FIXER_QUEUE=44
READY_QUEUE='45\n46'
printf 'failed,needs-judgment,engine:claude' > "$TMP/labels/44"
printf 'ready,engine:codex+claude' > "$TMP/labels/45"
printf 'ready,engine:claude' > "$TMP/labels/46"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
CAPACITY_RC=3
run_dispatch
assert_rc "an all-held full-host tick is clean" 0 "$RUN_RC"
for num in 44 45 46; do
  assert_eq "held candidate #$num is reported exactly once" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c "#$num: held (claude quota until 2099-01-01 01:00:00 CET)" || true)"
done
assert_not_contains "capacity is not probed without an unheld candidate" "$(cat "$TMP/launch.log")" '--check-capacity'
assert_eq "no fixer or epic launch is attempted" "" "$(grep -E -- '--(fix|ci|defect|epic)' "$TMP/launch.log" || true)"
assert_eq "the full-host all-held scan writes no labels" "" "$(grep 'issue edit' "$TMP/gh.log" || true)"

printf '\ndispatch hold: cached full capacity stays a clean read-only scan\n'
reset_state
READY_QUEUE='47\n48\n49'
printf 'ready,engine:codex' > "$TMP/labels/47"
printf 'ready,engine:codex' > "$TMP/labels/48"
printf 'ready,engine:claude' > "$TMP/labels/49"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
CAPACITY_RC=3
run_dispatch
assert_rc "cached full capacity is a clean deferral" 0 "$RUN_RC"
assert_eq "capacity is probed exactly once" 1 "$(grep -c '^--check-capacity$' "$TMP/launch.log" || true)"
assert_eq "full capacity is reported exactly once" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c 'host at capacity — nothing can launch, continuing held-candidate reporting' || true)"
assert_eq "no launch is attempted after the full-capacity probe" "" "$(grep -E -- '--(fix|ci|defect|epic)' "$TMP/launch.log" || true)"
assert_eq "the full-host scan writes no labels" "" "$(grep 'issue edit' "$TMP/gh.log" || true)"
assert_eq "the later held candidate is still reported" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#49: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"

printf '\ndispatch hold: expiry is cleared and normal dispatch resumes\n'
reset_state
READY_QUEUE=9
printf 'ready' > "$TMP/labels/9"
printf '%s\n' '{"claude":{"holdUntil":"2000-01-01T00:00:00.000Z","reason":"old limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch
assert_rc "an expired hold does not block the tick" 0 "$RUN_RC"
if [[ ! -e "$TMP/provider-hold.json" ]]; then ok "the expired hold is cleared under the tick lock"; else nok "the expired hold is cleared under the tick lock"; fi
assert_contains "capacity is probed after expiry" "$(cat "$TMP/launch.log")" "--check-capacity"
assert_contains "the ready issue launches after expiry" "$(cat "$TMP/launch.log")" "--epic 9 --repo testrepo --engine claude"

printf '\ndispatch hold: malformed and unreadable host state fail closed\n'
reset_state
READY_QUEUE=4
printf 'ready' > "$TMP/labels/4"
printf '%s\n' '{broken' > "$TMP/provider-hold.json"
run_dispatch
assert_rc "malformed hold state makes the tick non-clean" 1 "$RUN_RC"
assert_eq "malformed state blocks capacity and launch" "" "$(cat "$TMP/launch.log")"
assert_eq "malformed state blocks every GitHub call" "" "$(cat "$TMP/gh.log")"
reset_state
READY_QUEUE=5
printf 'ready' > "$TMP/labels/5"
mkdir "$TMP/provider-hold.json"
run_dispatch
assert_rc "unreadable hold state makes the tick non-clean" 1 "$RUN_RC"
assert_eq "unreadable state blocks capacity and launch" "" "$(cat "$TMP/launch.log")"
assert_eq "unreadable state blocks every GitHub call" "" "$(cat "$TMP/gh.log")"

printf '\ndispatch hold: routing-only modes bypass launch admission\n'
reset_state
READY_QUEUE=10
printf 'ready' > "$TMP/labels/10"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch --route-next codex
assert_rc "route-next remains available during a hold" 0 "$RUN_RC"
assert_contains "route-next persists its label" "$(cat "$TMP/labels/10")" "engine:codex"
assert_not_contains "route-next does not report launch admission" "$RUN_OUT" "quota until"
assert_eq "route-next never probes capacity" "" "$(cat "$TMP/launch.log")"
printf 'ready,engine:claude' > "$TMP/labels/11"
run_dispatch --route-issue 11 codex --repo testrepo
assert_rc "route-issue remains available during a hold" 0 "$RUN_RC"
assert_contains "route-issue persists its label" "$(cat "$TMP/labels/11")" "engine:codex"
assert_not_contains "route-issue does not report launch admission" "$RUN_OUT" "quota until"
assert_eq "the routing bypass leaves the active hold intact" "2099-01-01T00:00:00.000Z" "$(jq -r '.claude.holdUntil' "$TMP/provider-hold.json" 2>/dev/null || true)"

printf '\ndispatch: an invalid registry timezone fails before host-facing work\n'
reset_state
set_host_timezone "Mars/Olympus"
run_dispatch
assert_rc "an unknown HOST_TIMEZONE aborts the tick" 1 "$RUN_RC"
assert_contains "the refusal names HOST_TIMEZONE" "$RUN_OUT" "HOST_TIMEZONE"
assert_contains "the refusal names the rejected zone" "$RUN_OUT" "Mars/Olympus"
assert_eq "the dispatch lock is never attempted" "" "$(cat "$TMP/flock.log")"
assert_eq "GitHub is never queried" "" "$(cat "$TMP/gh.log")"
assert_eq "launch.sh is never invoked" "" "$(cat "$TMP/launch.log")"

set_host_timezone "zone.tab"
run_dispatch
assert_rc "an existing zoneinfo metadata file aborts the tick" 1 "$RUN_RC"
assert_contains "the metadata refusal names HOST_TIMEZONE" "$RUN_OUT" "HOST_TIMEZONE"
assert_contains "the metadata refusal names the rejected entry" "$RUN_OUT" "zone.tab"
assert_eq "metadata validation happens before the dispatch lock" "" "$(cat "$TMP/flock.log")"
assert_eq "metadata validation happens before GitHub" "" "$(cat "$TMP/gh.log")"
assert_eq "metadata validation happens before launch.sh" "" "$(cat "$TMP/launch.log")"
set_host_timezone "Europe/Amsterdam"

printf '\ndispatch: an unknown defect-fixer opt-in fails before mutation or launch\n'
reset_state
set_defect_fix_repos "missingrepo"
run_dispatch
assert_rc "an unknown configured repo aborts the tick" 1 "$RUN_RC"
assert_contains "the refusal names DEFECT_FIX_REPOS" "$RUN_OUT" "DEFECT_FIX_REPOS"
assert_not_contains "no issue label is mutated" "$(cat "$TMP/gh.log")" "issue edit"
assert_eq "launch.sh is never invoked, even for capacity" "" "$(cat "$TMP/launch.log")"

printf '\ndispatch: unlabeled ready work defaults to Claude\n'
reset_state
READY_QUEUE=1
printf 'ready' > "$TMP/labels/1"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "Claude is passed to launch" "$(cat "$TMP/launch.log")" '--epic 1 --repo testrepo --engine claude'
assert_matches "human dispatch logs use the configured zone" "$RUN_OUT" '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} (CET|CEST) \[dispatch\]'

printf '\ndispatch: EPIC_ENGINE sets the default for unlabeled work\n'
reset_state
READY_QUEUE=1
printf 'ready' > "$TMP/labels/1"
export EPIC_ENGINE=codex
run_dispatch
unset EPIC_ENGINE
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "the env default reaches launch" "$(cat "$TMP/launch.log")" '--epic 1 --repo testrepo --engine codex'
reset_state
READY_QUEUE=1
printf 'ready' > "$TMP/labels/1"
export EPIC_ENGINE=future
run_dispatch
unset EPIC_ENGINE
assert_rc "an unknown EPIC_ENGINE stops the tick" 1 "$RUN_RC"
assert_contains "and names the knob" "$RUN_OUT" "EPIC_ENGINE must name an engine"
assert_not_contains "nothing is launched on it" "$(cat "$TMP/launch.log")" '--epic'

printf '\ndispatch: an explicit Codex route is preserved\n'
reset_state
READY_QUEUE=2
printf 'ready,engine:codex' > "$TMP/labels/2"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "Codex is passed to launch" "$(cat "$TMP/launch.log")" '--epic 2 --repo testrepo --engine codex'

printf '\ndispatch: unknown and conflicting routes fail closed\n'
reset_state
READY_QUEUE=3
printf 'ready,engine:future' > "$TMP/labels/3"
run_dispatch
assert_rc "unknown engine makes the tick non-clean" 1 "$RUN_RC"
assert_not_contains "the issue is not launched" "$(cat "$TMP/launch.log")" '--epic 3'
reset_state
READY_QUEUE=4
printf 'ready,engine:claude,engine:codex' > "$TMP/labels/4"
run_dispatch
assert_rc "conflicting engines make the tick non-clean" 1 "$RUN_RC"
assert_not_contains "the issue is not launched" "$(cat "$TMP/launch.log")" '--epic 4'
reset_state
READY_QUEUE=8
printf 'ready' > "$TMP/labels/8"
COMMA_LABEL_ISSUE=8
run_dispatch
assert_rc "a comma inside another label is harmless" 0 "$RUN_RC"
assert_contains "it does not invent a Codex route" "$(cat "$TMP/launch.log")" '--epic 8 --repo testrepo --engine claude'

printf '\ndispatch: any engine named in etc/engines.json is routable\n'
reset_state
jq '. + {mixed: .claude}' "$ROOT/etc/engines.json" > "$HARNESS/etc/engines.json"
READY_QUEUE=15
printf 'ready,engine:mixed' > "$TMP/labels/15"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "the engine name is forwarded as-is" "$(cat "$TMP/launch.log")" '--epic 15 --repo testrepo --engine mixed'
cp "$ROOT/etc/engines.json" "$HARNESS/etc/engines.json"

printf '\ndispatch hold: vendor sets come from every step in the engine table\n'
reset_state
jq '. + {"future-mixed": .["codex+claude"]}' "$ROOT/etc/engines.json" > "$HARNESS/etc/engines.json"
READY_QUEUE=16
printf 'ready,engine:future-mixed' > "$TMP/labels/16"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch --dry-run
assert_rc "a future mixed engine is resolved cleanly" 0 "$RUN_RC"
assert_eq "a vendor found only through the engine table holds the candidate" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#16: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"
assert_not_contains "the future mixed engine is not treated as launchable" "$RUN_OUT" "would launch 'testrepo-epic-16'"

reset_state
jq '. + {broken: {architect: 7}}' "$ROOT/etc/engines.json" > "$HARNESS/etc/engines.json"
READY_QUEUE=17
printf 'ready,engine:broken' > "$TMP/labels/17"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch --dry-run
assert_rc "an unresolvable engine vendor set fails closed" 1 "$RUN_RC"
assert_not_contains "an unresolvable engine is never launchable" "$RUN_OUT" "would launch 'testrepo-epic-17'"
cp "$ROOT/etc/engines.json" "$HARNESS/etc/engines.json"

printf '\nroute-next: exact queue order, blockers, and explicit routes are respected\n'
reset_state
READY_QUEUE='1\n2\n3'
printf 'ready,engine:claude' > "$TMP/labels/1"
printf 'ready' > "$TMP/labels/2"
printf 'ready' > "$TMP/labels/3"
printf '55' > "$TMP/blockers/2"
run_dispatch --route-next codex
assert_rc "selector exits 0" 0 "$RUN_RC"
assert_contains "it selects the first unrouted unblocked issue" "$RUN_OUT" '#3 (testrepo): routed next epic to codex'
assert_contains "the verified label is durable state" "$(cat "$TMP/labels/3")" 'engine:codex'
assert_not_contains "routing never probes or launches" "$(cat "$TMP/launch.log")" '--check-capacity'

printf '\nroute-next: write and read failures never claim success\n'
reset_state
READY_QUEUE=5
printf 'ready' > "$TMP/labels/5"
FAIL_EDIT_ISSUE=5
run_dispatch --route-next claude
assert_rc "failed label write exits 1" 1 "$RUN_RC"
assert_not_contains "the label did not appear" "$(cat "$TMP/labels/5")" 'engine:claude'
reset_state
READY_QUEUE=6
printf 'ready' > "$TMP/labels/6"
FAIL_VIEW_ISSUE=6
run_dispatch --route-next codex
assert_rc "failed strong read exits 1" 1 "$RUN_RC"
reset_state
READY_QUEUE=7
printf 'ready' > "$TMP/labels/7"
FAIL_BLOCKER_ISSUE=7
run_dispatch --route-next codex
assert_rc "failed dependency read exits 1" 1 "$RUN_RC"
assert_not_contains "it does not route past dependency uncertainty" "$(cat "$TMP/labels/7")" 'engine:codex'
reset_state
FAIL_QUEUE=1
run_dispatch --route-next codex
assert_rc "failed queue read exits 1" 1 "$RUN_RC"

printf '\nfixer: the epic route survives into conflict repair\n'
reset_state
FIXER_QUEUE=9
printf 'failed,needs-judgment,engine:codex' > "$TMP/labels/9"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "fixer launch keeps Codex" "$(cat "$TMP/launch.log")" '--fix 9 --repo testrepo --engine codex'

printf '\ndispatch hold: held fixers are skipped before their terminal-label shield\n'
reset_state
FIXER_QUEUE='40\n41'
printf 'failed,needs-judgment,engine:claude' > "$TMP/labels/40"
printf 'failed,needs-judgment,engine:codex' > "$TMP/labels/41"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch
assert_rc "a held fixer does not make the tick fail" 0 "$RUN_RC"
assert_eq "the held fixer logs exactly once" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#40: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"
assert_eq "the held fixer's labels are untouched" "engine:claude,failed,needs-judgment," "$(issue_labels 40)"
assert_eq "the held fixer receives no label write" "" "$(grep 'issue edit 40 ' "$TMP/gh.log" || true)"
assert_contains "the fixer walk continues to an unheld engine" "$(cat "$TMP/launch.log")" '--fix 41 --repo testrepo --engine codex'
assert_eq "only the launched fixer gets the in-progress shield" "engine:codex,in-progress,needs-judgment," "$(issue_labels 41)"

printf '\ndispatch hold: a fixer rerouted after admission is reverted and skipped\n'
reset_state
FIXER_QUEUE='47\n48'
printf 'failed,needs-judgment,engine:codex' > "$TMP/labels/47"
printf 'failed,needs-judgment,engine:codex' > "$TMP/labels/48"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
REROUTE_AFTER_SHIELD_ISSUE=47
REROUTE_AFTER_SHIELD_ENGINE=claude
run_dispatch
assert_rc "a racing fixer reroute is a clean skip" 0 "$RUN_RC"
assert_not_contains "the fixer is not launched on its newly held engine" "$(cat "$TMP/launch.log")" '--fix 47'
assert_eq "the changed fixer is restored to its queue" "engine:claude,failed,needs-judgment," "$(issue_labels 47)"
assert_contains "the fixer walk continues to a stable unheld candidate" "$(cat "$TMP/launch.log")" '--fix 48 --repo testrepo --engine codex'
assert_eq "the stable fixer alone receives the shield" "engine:codex,in-progress,needs-judgment," "$(issue_labels 48)"

reset_state
CI_QUEUE=42
printf 'failed,needs-ci-fix,engine:claude' > "$TMP/labels/42"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch
assert_rc "a held CI fixer is a clean skip" 0 "$RUN_RC"
assert_eq "the held CI fixer logs once" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#42: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"
assert_eq "a held CI fixer receives no label write" "" "$(grep 'issue edit 42 ' "$TMP/gh.log" || true)"
assert_eq "a held CI fixer keeps its resting labels" "engine:claude,failed,needs-ci-fix," "$(issue_labels 42)"

reset_state
set_defect_fix_repos "testrepo"
DEFECT_QUEUE=43
printf 'ready-to-review,needs-defect-fix,engine:claude' > "$TMP/labels/43"
printf '%s\n' '{"claude":{"holdUntil":"2099-01-01T00:00:00.000Z","reason":"session limit","fallback":false}}' > "$TMP/provider-hold.json"
run_dispatch
assert_rc "a held defect fixer is a clean skip" 0 "$RUN_RC"
assert_eq "the held defect fixer logs once" 1 "$(printf '%s\n' "$RUN_OUT" | grep -c '#43: held (claude quota until 2099-01-01 01:00:00 CET)' || true)"
assert_eq "a held defect fixer receives no label write" "" "$(grep 'issue edit 43 ' "$TMP/gh.log" || true)"
assert_eq "a held defect fixer keeps ready-to-review" "engine:claude,needs-defect-fix,ready-to-review," "$(issue_labels 43)"

printf '\nfixer: a red check goes to the CI fixer, not the conflict fixer\n'
reset_state
CI_QUEUE=21
printf 'failed,needs-ci-fix,engine:claude' > "$TMP/labels/21"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "it launches the CI pipeline" "$(cat "$TMP/launch.log")" '--ci 21 --repo testrepo --engine claude'
assert_not_contains "and never the conflict fixer" "$(cat "$TMP/launch.log")" '--fix 21'
assert_contains "the shield swap ran before the launch" "$(cat "$TMP/labels/21")" 'in-progress'

printf '\ndefect fixer: repositories are opted in explicitly\n'
reset_state
unset_defect_fix_repos
DEFECT_QUEUE=30
printf 'ready-to-review,needs-defect-fix,engine:codex' > "$TMP/labels/30"
run_dispatch
assert_rc "an unset allowlist ignores the marker queue" 0 "$RUN_RC"
assert_not_contains "no autonomous defect fixer is launched" "$(cat "$TMP/launch.log")" '--defect 30'
assert_not_contains "dispatch does not even walk an opted-out queue" "$(cat "$TMP/gh.log")" 'needs-defect-fix'
assert_eq "the resting review labels are untouched" "ready-to-review,needs-defect-fix,engine:codex" "$(cat "$TMP/labels/30")"

reset_state
set_defect_fix_repos "testrepo"
DEFECT_QUEUE=30
printf 'ready-to-review,needs-defect-fix,engine:codex' > "$TMP/labels/30"
run_dispatch
assert_rc "an opted-in tick exits 0" 0 "$RUN_RC"
assert_contains "it launches the dedicated defect pipeline" "$(cat "$TMP/launch.log")" '--defect 30 --repo testrepo --engine codex'
assert_contains "the existing engine route is preserved" "$(cat "$TMP/launch.log")" '--engine codex'
assert_contains "the terminal shield is replaced before launch" "$(cat "$TMP/labels/30")" 'in-progress'
assert_not_contains "ready-to-review is removed while the session is live" "$(cat "$TMP/labels/30")" 'ready-to-review'

printf '\ndefect fixer: an exhausted ladder is excluded and the exact terminal state is restored\n'
reset_state
set_defect_fix_repos "testrepo"
DEFECT_QUEUE=31
printf 'ready-to-review,needs-defect-fix,defect-attempted,defect-retried' > "$TMP/labels/31"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "the queue query excludes the spent ladder" "$(cat "$TMP/gh.log")" '-label:defect-retried'
assert_not_contains "nothing is launched on a spent ladder" "$(cat "$TMP/launch.log")" '--defect 31'
assert_contains "the stale search hit was shielded first" "$(cat "$TMP/gh.log")" 'issue edit 31 --remove-label ready-to-review --add-label in-progress'
assert_contains "the direct reread restores ready-to-review" "$(cat "$TMP/gh.log")" 'issue edit 31 --add-label ready-to-review --remove-label in-progress'
assert_eq "the issue is never stranded in-progress or changed to failed" "defect-attempted,defect-retried,needs-defect-fix,ready-to-review," "$(issue_labels 31)"

printf '\ndefect fixer: a launch failure restores ready-to-review, not failed\n'
reset_state
set_defect_fix_repos "testrepo"
DEFECT_QUEUE=32
printf 'ready-to-review,needs-defect-fix' > "$TMP/labels/32"
LAUNCH_RC=4
run_dispatch
assert_rc "an issue-specific launch failure makes the tick non-clean" 1 "$RUN_RC"
assert_contains "the defect launch was attempted" "$(cat "$TMP/launch.log")" '--defect 32'
assert_eq "the exact resting terminal label is restored" "needs-defect-fix,ready-to-review," "$(issue_labels 32)"
assert_not_contains "a defect repair failure never invents failed" "$(cat "$TMP/labels/32")" 'failed'

printf '\ndefect fixer: a full host defers before touching review labels\n'
reset_state
set_defect_fix_repos "testrepo"
DEFECT_QUEUE=33
printf 'ready-to-review,needs-defect-fix' > "$TMP/labels/33"
CAPACITY_RC=3
run_dispatch
assert_rc "capacity is a clean deferral" 0 "$RUN_RC"
assert_not_contains "no defect session is attempted" "$(cat "$TMP/launch.log")" '--defect 33'
assert_not_contains "no label write occurs" "$(cat "$TMP/gh.log")" 'issue edit 33'
assert_eq "the issue remains ready-to-review" "needs-defect-fix,ready-to-review," "$(issue_labels 33)"

printf '\nfixer: an exhausted CI ladder stays out of the queue\n'
reset_state
CI_QUEUE=22
printf 'failed,needs-ci-fix,ci-retried' > "$TMP/labels/22"
# The queue query excludes ci-retried, so the stub is asked and answers with it;
# the post-swap re-read is what refuses. Either way nothing launches.
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_not_contains "nothing is launched on a spent ladder" "$(cat "$TMP/launch.log")" '--ci 22'
assert_contains "and the shield swap is reverted" "$(cat "$TMP/labels/22")" 'failed'
assert_not_contains "leaving no stranded in-progress" "$(cat "$TMP/labels/22")" 'in-progress'

printf '\nfixer: one fixer of either kind per repo per tick\n'
reset_state
FIXER_QUEUE=23
CI_QUEUE=24
DEFECT_QUEUE=28
printf 'failed,needs-judgment' > "$TMP/labels/23"
printf 'failed,needs-ci-fix' > "$TMP/labels/24"
printf 'ready-to-review,needs-defect-fix' > "$TMP/labels/28"
set_defect_fix_repos "testrepo"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "the conflict queue is walked first" "$(cat "$TMP/launch.log")" '--fix 23'
assert_not_contains "and the CI queue waits for the next tick" "$(cat "$TMP/launch.log")" '--ci 24'
assert_not_contains "and the defect queue waits behind both" "$(cat "$TMP/launch.log")" '--defect 28'

printf '\nfixer: a live session parks both fixer walks in that repo\n'
reset_state
FIXER_QUEUE=25
CI_QUEUE=26
DEFECT_QUEUE=29
printf 'failed,needs-judgment' > "$TMP/labels/25"
printf 'failed,needs-ci-fix' > "$TMP/labels/26"
printf 'ready-to-review,needs-defect-fix' > "$TMP/labels/29"
set_defect_fix_repos "testrepo"
STUB_SESSION_NAME="testrepo-epic-25"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_not_contains "the busy conflict candidate launches nothing" "$(cat "$TMP/launch.log")" '--fix 25'
assert_not_contains "and the CI queue is parked too" "$(cat "$TMP/launch.log")" '--ci 26'
assert_not_contains "and the defect queue is parked too" "$(cat "$TMP/launch.log")" '--defect 29'

printf '\nfixer: a CI queue that cannot be read never launches\n'
reset_state
CI_QUEUE=27
printf 'failed,needs-ci-fix' > "$TMP/labels/27"
FAIL_QUEUE=1
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_not_contains "an unreadable queue launches nothing" "$(cat "$TMP/launch.log")" '--ci 27'

printf '\nroute-issue: a manual choice becomes durable before launch\n'
reset_state
printf 'ready,engine:claude' > "$TMP/labels/10"
run_dispatch --route-issue 10 codex --repo testrepo
assert_rc "explicit route exits 0" 0 "$RUN_RC"
assert_contains "Codex is persisted" "$(cat "$TMP/labels/10")" 'engine:codex'
assert_not_contains "the prior route is removed" "$(cat "$TMP/labels/10")" 'engine:claude'
assert_not_contains "the routing operation launches nothing" "$(cat "$TMP/launch.log")" '--epic'
reset_state
printf 'ready,engine:claude' > "$TMP/labels/11"
FLOCK_BUSY=1
run_dispatch --route-issue 11 codex --repo testrepo
assert_rc "lock contention makes manual routing fail" 1 "$RUN_RC"
assert_not_contains "the label stays unchanged" "$(cat "$TMP/labels/11")" 'engine:codex'
reset_state
printf 'ready,engine:claude' > "$TMP/labels/12"
STUB_SESSION_NAME=testrepo-epic-12
run_dispatch --route-issue 12 codex --repo testrepo
assert_rc "an existing session blocks rerouting" 1 "$RUN_RC"
assert_not_contains "the running session's label stays unchanged" "$(cat "$TMP/labels/12")" 'engine:codex'
reset_state
READY_QUEUE=13
printf 'ready' > "$TMP/labels/13"
run_dispatch --route-next=
assert_rc "an empty route-next value is rejected" 1 "$RUN_RC"
assert_not_contains "it cannot fall through into a real tick" "$(cat "$TMP/launch.log")" '--epic 13'
reset_state
READY_QUEUE=14
printf 'ready' > "$TMP/labels/14"
run_dispatch --route-issue '#' codex --repo testrepo
assert_rc "an empty stripped route-issue is rejected" 1 "$RUN_RC"
assert_not_contains "it cannot fall through into a real tick" "$(cat "$TMP/launch.log")" '--epic 14'

printf '\nremote control: next preserves host-wide selection unless narrowed\n'
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" next codex
assert_contains "host-wide next omits a repo filter" "$(cat "$TMP/ssh.log")" 'dispatch.sh --route-next'
assert_not_contains "host-wide next does not default to the first repo" "$(cat "$TMP/ssh.log")" '--repo'
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" next claude -r testrepo
assert_contains "an explicit repo is forwarded" "$(cat "$TMP/ssh.log")" "--repo 'testrepo'"
set +e
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" epic 10 >/dev/null 2>&1
CONTROL_RC=$?
set -e
assert_rc "manual epic requires an explicit engine" 1 "$CONTROL_RC"
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" epic 10 --engine codex
assert_contains "manual epic forwards its explicit engine" "$(cat "$TMP/ssh.log")" "--engine 'codex'"
assert_contains "manual epic persists the engine first" "$(cat "$TMP/ssh.log")" "--route-issue '10' 'codex'"
: > "$TMP/ssh.log"
set +e
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" defect 10 --engine codex -r testrepo >/dev/null 2>&1
CONTROL_RC=$?
set -e
assert_rc "manual defect repair is accepted even without repo opt-in" 0 "$CONTROL_RC"
assert_contains "manual defect repair persists the engine before launching" "$(cat "$TMP/ssh.log")" "--route-issue '10' 'codex'"
assert_contains "manual defect repair uses the dedicated launch mode" "$(cat "$TMP/ssh.log")" "--defect '10' --engine 'codex'"
: > "$TMP/ssh.log"
set +e
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" epic '#' --engine codex >/dev/null 2>&1
CONTROL_RC=$?
set -e
assert_rc "a bare # manual ref is rejected locally" 1 "$CONTROL_RC"
assert_not_contains "no remote command is sent" "$(cat "$TMP/ssh.log")" 'unused'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
