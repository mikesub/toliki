#!/usr/bin/env bash
set -euo pipefail

# Exercises routing and dispatch against fake gh/tmux/flock/launch commands.
# All issue state lives in throwaway files; no network or live host is touched.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else nok "$1 (missing: $3)"; fi; }
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpected: $3)"; fi; }

HARNESS="$TMP/harness"
REPO="$TMP/repo"
mkdir -p "$HARNESS" "$REPO/.git" "$TMP/bin" "$TMP/labels" "$TMP/blockers" "$TMP/locks"
cp -R "$ROOT/bin" "$ROOT/etc" "$HARNESS/"
cp "$ROOT/remote-control.sh" "$HARNESS/"
cat > "$HARNESS/etc/repos.conf" <<EOF
REPOS=( testrepo=$REPO )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="$HARNESS"
SSH_HOST="unused"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
EOF

cat > "$HARNESS/bin/launch.sh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$LAUNCH_LOG"
exit "${LAUNCH_RC:-0}"
STUB
chmod +x "$HARNESS/bin/launch.sh"

cat > "$TMP/bin/flock" <<'STUB'
#!/usr/bin/env bash
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
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" TMPDIR="$TMP/locks" \
    LAUNCH_LOG="$TMP/launch.log" GH_LOG="$TMP/gh.log" \
    LABEL_DIR="$TMP/labels" BLOCKER_DIR="$TMP/blockers" \
    READY_QUEUE="${READY_QUEUE:-}" FIXER_QUEUE="${FIXER_QUEUE:-}" CI_QUEUE="${CI_QUEUE:-}" \
    FAIL_VIEW_ISSUE="${FAIL_VIEW_ISSUE:-}" FAIL_EDIT_ISSUE="${FAIL_EDIT_ISSUE:-}" \
    FAIL_BLOCKER_ISSUE="${FAIL_BLOCKER_ISSUE:-}" \
    FAIL_QUEUE="${FAIL_QUEUE:-}" \
    COMMA_LABEL_ISSUE="${COMMA_LABEL_ISSUE:-}" \
    FLOCK_BUSY="${FLOCK_BUSY:-}" STUB_SESSION_NAME="${STUB_SESSION_NAME:-}" \
    bash "$DISPATCH" "$@" 2>&1
  )" || RUN_RC=$?
}

reset_state() {
  rm -f "$TMP/labels"/* "$TMP/blockers"/*
  READY_QUEUE=""
  FIXER_QUEUE=""
  CI_QUEUE=""
  FAIL_VIEW_ISSUE=""
  FAIL_EDIT_ISSUE=""
  FAIL_BLOCKER_ISSUE=""
  FAIL_QUEUE=""
  COMMA_LABEL_ISSUE=""
  FLOCK_BUSY=""
  STUB_SESSION_NAME=""
}

printf '\ndispatch: unlabeled ready work defaults to Claude\n'
reset_state
READY_QUEUE=1
printf 'ready' > "$TMP/labels/1"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "Claude is passed to launch" "$(cat "$TMP/launch.log")" '--epic 1 --repo testrepo --engine claude'

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

printf '\nfixer: a red check goes to the CI fixer, not the conflict fixer\n'
reset_state
CI_QUEUE=21
printf 'failed,needs-ci-fix,engine:claude' > "$TMP/labels/21"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "it launches the CI pipeline" "$(cat "$TMP/launch.log")" '--ci 21 --repo testrepo --engine claude'
assert_not_contains "and never the conflict fixer" "$(cat "$TMP/launch.log")" '--fix 21'
assert_contains "the shield swap ran before the launch" "$(cat "$TMP/labels/21")" 'in-progress'

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
printf 'failed,needs-judgment' > "$TMP/labels/23"
printf 'failed,needs-ci-fix' > "$TMP/labels/24"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_contains "the conflict queue is walked first" "$(cat "$TMP/launch.log")" '--fix 23'
assert_not_contains "and the CI queue waits for the next tick" "$(cat "$TMP/launch.log")" '--ci 24'

printf '\nfixer: a live session parks both fixer walks in that repo\n'
reset_state
FIXER_QUEUE=25
CI_QUEUE=26
printf 'failed,needs-judgment' > "$TMP/labels/25"
printf 'failed,needs-ci-fix' > "$TMP/labels/26"
STUB_SESSION_NAME="testrepo-epic-25"
run_dispatch
assert_rc "tick exits 0" 0 "$RUN_RC"
assert_not_contains "the busy conflict candidate launches nothing" "$(cat "$TMP/launch.log")" '--fix 25'
assert_not_contains "and the CI queue is parked too" "$(cat "$TMP/launch.log")" '--ci 26'

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
SSH_LOG="$TMP/ssh.log" PATH="$TMP/bin:$PATH" bash "$HARNESS/remote-control.sh" epic '#' --engine codex >/dev/null 2>&1
CONTROL_RC=$?
set -e
assert_rc "a bare # manual ref is rejected locally" 1 "$CONTROL_RC"
assert_not_contains "no remote command is sent" "$(cat "$TMP/ssh.log")" 'unused'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
