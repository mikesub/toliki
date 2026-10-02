#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ $# -gt 0 ]]; then
  TEST_FILES=("$@")
else
  TEST_FILES=(tests/*.test.sh)
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
