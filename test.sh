#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ $# -gt 0 ]]; then
  TEST_FILES=("$@")
else
  TEST_FILES=(tests/*.test.sh)
fi

TEST_OUTPUT="$(mktemp "${TMPDIR:-/tmp}/toliki-test.XXXXXX")"
trap 'rm -f "$TEST_OUTPUT"' EXIT

for test_file in "${TEST_FILES[@]}"; do
  bash "$test_file" >"$TEST_OUTPUT" 2>&1
  test_rc=$?

  if [[ $test_rc -eq 0 ]]; then
    printf '%s OK\n' "$test_file"
    continue
  fi

  printf '%s FAILED\n' "$test_file"
  sed '/^[[:space:]]*ok[[:space:]]/d' "$TEST_OUTPUT"
  exit "$test_rc"
done
