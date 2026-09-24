#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# Pipeline and host suites are parked while there is no host: a plain run
# covers the local epic workflow (its skills, helper and wiring) and this
# runner. Name a parked suite to run it anyway.
PARKED_TESTS="dispatch-engine engine-codex epic-run launch-epic manual-session
  merge-autoresolve merge-worker operator-cli provision-agent-clis
  reap-worktree timezone update-claude usage-report workflow-prompts"

is_parked() {
  local name
  for name in $PARKED_TESTS; do
    [[ "$1" != "tests/$name.test.sh" ]] || return 0
  done
  return 1
}

if [[ $# -gt 0 ]]; then
  TEST_FILES=("$@")
else
  TEST_FILES=()
  PARKED=0
  for test_file in tests/*.test.sh; do
    if is_parked "$test_file"; then
      PARKED=$((PARKED + 1))
    else
      TEST_FILES+=("$test_file")
    fi
  done
  printf '%d pipeline/host suite(s) parked; see PARKED_TESTS in test.sh\n' "$PARKED"
fi

# Suites are hermetic and own separate temporary directories, so run a bounded
# set together. TEST_JOBS=1 retains strict serial/fail-fast execution for
# debugging a runner failure or a machine with very little spare capacity.
TEST_JOBS="${TEST_JOBS:-4}"
if [[ ! "$TEST_JOBS" =~ ^[1-9][0-9]*$ ]]; then
  printf 'TEST_JOBS must be a positive integer, got %s\n' "$TEST_JOBS" >&2
  exit 2
fi

TEST_RUN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/toliki-test.XXXXXX")"
PIDS=()
cleanup() {
  local pid
  trap - EXIT
  for pid in ${PIDS[*]-}; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in ${PIDS[*]-}; do
    wait "$pid" 2>/dev/null || true
  done
  rm -rf "$TEST_RUN_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

FIFO="$TEST_RUN_DIR/completed"
mkfifo "$FIFO"
exec 9<>"$FIFO"
rm "$FIFO"

start_test() {
  local index="$1" test_file="${TEST_FILES[$1]}"
  (
    local test_rc=0
    bash "$test_file" >"$TEST_RUN_DIR/$index.output" 2>&1 || test_rc=$?
    printf '%s\n' "$test_rc" >"$TEST_RUN_DIR/$index.status"
    printf '%s\n' "$index" >&9
  ) &
  PIDS[$index]=$!
}

next=0
active=0
total=${#TEST_FILES[@]}
failure_rc=0
stop_scheduling=0

while (( next < total && active < TEST_JOBS )); do
  start_test "$next"
  next=$((next + 1))
  active=$((active + 1))
done

while (( active > 0 )); do
  IFS= read -r finished <&9
  wait "${PIDS[$finished]}" 2>/dev/null || true
  unset 'PIDS[$finished]'
  active=$((active - 1))

  test_file="${TEST_FILES[$finished]}"
  test_rc="$(cat "$TEST_RUN_DIR/$finished.status")"
  if [[ "$test_rc" == "0" ]]; then
    printf '%s OK\n' "$test_file"
  else
    printf '%s FAILED\n' "$test_file"
    sed '/^[[:space:]]*ok[[:space:]]/d' "$TEST_RUN_DIR/$finished.output"
    if (( failure_rc == 0 )); then failure_rc="$test_rc"; fi
    stop_scheduling=1
  fi

  if (( ! stop_scheduling && next < total )); then
    start_test "$next"
    next=$((next + 1))
    active=$((active + 1))
  fi
done

exit "$failure_rc"
