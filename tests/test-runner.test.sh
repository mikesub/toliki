#!/usr/bin/env bash
set -uo pipefail

# Exercises the root test runner against tiny fixture suites. The fixtures make
# both streams noisy so a green run proves the runner, rather than each suite,
# owns the concise output contract. Nothing outside the mktemp directory is
# executed or changed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$ROOT/test.sh"
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); }
nok() { FAIL=$((FAIL + 1)); printf 'FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok; else nok "$1 (want rc $2, got $3)"; fi; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok; else nok "$1 (want '$2', got '$3')"; fi; }
assert_contains() { if [[ "$2" == *"$3"* ]]; then ok; else nok "$1 (missing: $3)"; fi; }
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok; else nok "$1 (unexpected: $3)"; fi; }

PASS_FILE="$TEST_TMP/passing test.sh"
cat > "$PASS_FILE" <<'FIXTURE'
#!/usr/bin/env bash
printf '  ok   first passing assertion\n'
printf 'scenario chatter\n'
printf 'harmless stderr\n' >&2
FIXTURE

FAIL_FILE="$TEST_TMP/failing.test.sh"
cat > "$FAIL_FILE" <<'FIXTURE'
#!/usr/bin/env bash
printf '  ok   passing assertion before the failure\n'
printf '  FAIL broken behavior\n'
printf '       missing: required value\n'
printf 'failure detail from stderr\n' >&2
exit 7
FIXTURE

LATE_FILE="$TEST_TMP/late.test.sh"
cat > "$LATE_FILE" <<'FIXTURE'
#!/usr/bin/env bash
printf 'LATE TEST RAN\n'
FIXTURE

run_runner() {
  RUN_ERR="$TEST_TMP/stderr"
  RUN_RC=0
  RUN_OUT="$(TEST_JOBS="${RUNNER_JOBS:-4}" "$RUNNER" "$@" 2>"$RUN_ERR")" || RUN_RC=$?
}

run_runner "$PASS_FILE"
assert_rc "a passing run exits zero" 0 "$RUN_RC"
assert_eq "a passing run prints only the file result" "$PASS_FILE OK" "$RUN_OUT"
assert_eq "a passing run has no stderr" "" "$(cat "$RUN_ERR")"

RUNNER_JOBS=1 run_runner "$FAIL_FILE" "$LATE_FILE"
assert_rc "a failing run preserves the suite's exit code" 7 "$RUN_RC"
assert_contains "a failing run names its suite" "$RUN_OUT" "$FAIL_FILE FAILED"
assert_contains "a failing run prints the failed case" "$RUN_OUT" "FAIL broken behavior"
assert_contains "a failing run prints stdout diagnostics" "$RUN_OUT" "missing: required value"
assert_contains "a failing run prints stderr diagnostics" "$RUN_OUT" "failure detail from stderr"
assert_not_contains "passing ok lines stay suppressed on failure" "$RUN_OUT" "ok   passing assertion"
assert_not_contains "the runner stops after the first failed suite" "$RUN_OUT" "LATE TEST RAN"

printf '\nparallel runner starts independent suites together\n'
BARRIER="$TEST_TMP/barrier"
mkdir -p "$BARRIER"
export BARRIER
FIRST_FILE="$TEST_TMP/parallel-first.test.sh"
SECOND_FILE="$TEST_TMP/parallel-second.test.sh"
cat > "$FIRST_FILE" <<'FIXTURE'
#!/usr/bin/env bash
touch "$BARRIER/first"
for _ in {1..100}; do
  [[ -e "$BARRIER/second" ]] && exit 0
  sleep 0.01
done
exit 9
FIXTURE
cat > "$SECOND_FILE" <<'FIXTURE'
#!/usr/bin/env bash
touch "$BARRIER/second"
for _ in {1..100}; do
  [[ -e "$BARRIER/first" ]] && exit 0
  sleep 0.01
done
exit 9
FIXTURE
RUNNER_JOBS=2 run_runner "$FIRST_FILE" "$SECOND_FILE"
assert_rc "two-worker run exits zero" 0 "$RUN_RC"
assert_contains "first parallel suite completed" "$RUN_OUT" "$FIRST_FILE OK"
assert_contains "second parallel suite completed" "$RUN_OUT" "$SECOND_FILE OK"

RUNNER_JOBS=invalid run_runner "$PASS_FILE"
assert_rc "an invalid worker count is refused" 2 "$RUN_RC"
assert_contains "the refusal names TEST_JOBS" "$(cat "$RUN_ERR")" "TEST_JOBS must be a positive integer"

if [[ $FAIL -eq 0 ]]; then
  printf '%s OK\n' "${BASH_SOURCE[0]}"
  exit 0
fi

printf '%d test-runner assertion(s) failed\n' "$FAIL"
exit 1
