#!/usr/bin/env bash
set -euo pipefail

# Runs setup.sh from a throwaway Git copy of this checkout against throwaway
# homes, so commits, uncommitted edits and removed skills can be exercised.
# Fake claude and codex sit first on PATH and record any call, since setup
# never needs either CLI.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok_test() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_absent() {
  if [[ ! -e "$2" && ! -L "$2" ]]; then ok_test "$1"; else nok "$1 ($2 remains)"; fi
}
assert_exists() {
  if [[ -e "$2" || -L "$2" ]]; then ok_test "$1"; else nok "$1 ($2 is missing)"; fi
}
assert_regular() {
  if [[ -f "$2" && ! -L "$2" ]]; then ok_test "$1"; else nok "$1 ($2 is not a regular file)"; fi
}
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok_test "$1"; else nok "$1 (missing: $3)"; fi
}
assert_not_contains() {
  if [[ "$2" != *"$3"* ]]; then ok_test "$1"; else nok "$1 (unexpected: $3)"; fi
}
assert_eq() {
  if [[ "$2" == "$3" ]]; then ok_test "$1"; else nok "$1 (wanted $3, got $2)"; fi
}

mkdir -p "$TMP/bin"
for cli in claude codex; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/cli-calls"\nexit 99\n' "$TMP" > "$TMP/bin/$cli"
  chmod +x "$TMP/bin/$cli"
done
export PATH="$TMP/bin:$PATH"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

# A Git copy of this checkout's setup and skills, links included.
REPO="$TMP/repo"
mkdir -p "$REPO"
cp "$ROOT/setup.sh" "$REPO/"
cp -R "$ROOT/skills" "$REPO/"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "Fixture release"
commit() { git -C "$REPO" add -A && git -C "$REPO" commit -q -m "$1"; }

SKILLS="t-architect t-code t-review t-ship t-spec"
OUT=""
RC=0
setup() { # home, args...
  local home="$1"
  shift
  RC=0
  OUT="$(HOME="$home" bash "$REPO/setup.sh" "$@" 2>&1)" || RC=$?
}
assert_installed() { # skill dir, label
  local name
  for name in $SKILLS; do
    if [[ -d "$1/$name" && ! -L "$1/$name" ]] && diff -r -x .toliki-install "$REPO/skills/epic/$name" "$1/$name" >/dev/null; then
      ok_test "$2 $name is a copy of the release"
    else
      nok "$2 $name is not a copy of the release"
    fi
  done
}

printf '\nfresh home: self-contained copies for both harnesses\n'
H="$TMP/fresh"
setup "$H"
assert_eq "exits zero" "$RC" 0
assert_installed "$H/.claude/skills" "Claude"
assert_installed "$H/.agents/skills" "Codex"
assert_regular "the shared contract is copied, not linked" "$H/.claude/skills/t-spec/EPIC-CONTRACT.md"
assert_regular "each skill carries its own contract" "$H/.agents/skills/t-ship/EPIC-CONTRACT.md"
assert_contains "the marker names the released commit" "$(cat "$H/.claude/skills/t-spec/.toliki-install")" "commit=$(git -C "$REPO" rev-parse HEAD)"
setup "$H"
assert_eq "second run exits zero" "$RC" 0
assert_contains "second run changes nothing" "$OUT" "nothing changed"

printf '\nonly committed changes are released\n'
printf '\nWork in progress.\n' >> "$REPO/skills/epic/t-spec/SKILL.md"
setup "$H"
assert_eq "an uncommitted edit does not block" "$RC" 0
assert_contains "warns that the edit is not installed" "$OUT" "uncommitted changes under skills/epic are not installed"
assert_not_contains "the installed copy keeps the release" "$(cat "$H/.claude/skills/t-spec/SKILL.md")" "Work in progress."
commit "Refine t-spec"
setup "$H"
assert_eq "the release exits zero" "$RC" 0
assert_contains "reports the update" "$OUT" "updated ~/.claude/skills/t-spec"
assert_contains "the installed Claude copy is updated" "$(cat "$H/.claude/skills/t-spec/SKILL.md")" "Work in progress."
assert_contains "the installed Codex copy is updated" "$(cat "$H/.agents/skills/t-spec/SKILL.md")" "Work in progress."
assert_not_contains "unchanged skills are not rewritten" "$OUT" "updated ~/.claude/skills/t-code"
printf 'Shared rule.\n' >> "$REPO/skills/epic/EPIC-CONTRACT.md"
commit "Extend the contract"
setup "$H"
assert_contains "a shared contract change updates every skill" "$(cat "$H/.agents/skills/t-review/EPIC-CONTRACT.md")" "Shared rule."
assert_contains "the marker follows the new release" "$(cat "$H/.agents/skills/t-review/.toliki-install")" "commit=$(git -C "$REPO" rev-parse HEAD)"

printf '\nskills removed from the release are removed; other content stays\n'
mkdir -p "$H/.claude/skills/mine"
printf 'mine\n' > "$H/.claude/skills/mine/SKILL.md"
git -C "$REPO" rm -rq skills/epic/t-architect
commit "Retire t-architect"
setup "$H"
assert_eq "exits zero" "$RC" 0
assert_absent "removes the retired Claude copy" "$H/.claude/skills/t-architect"
assert_absent "removes the retired Codex copy" "$H/.agents/skills/t-architect"
assert_exists "preserves a user skill" "$H/.claude/skills/mine/SKILL.md"
assert_exists "keeps the released skills" "$H/.claude/skills/t-code/SKILL.md"
git -C "$REPO" revert --no-edit HEAD >/dev/null

printf '\ncontent this setup did not install is never overwritten\n'
H="$TMP/foreign"
mkdir -p "$H/.claude/skills/t-code" "$TMP/elsewhere/t-review"
printf 'owned elsewhere\n' > "$H/.claude/skills/t-code/marker"
ln -s "$TMP/elsewhere/t-review" "$H/.claude/skills/t-review"
setup "$H"
assert_eq "exits non-zero while blocked" "$RC" 1
assert_exists "keeps the foreign directory" "$H/.claude/skills/t-code/marker"
assert_absent "adds nothing into it" "$H/.claude/skills/t-code/SKILL.md"
assert_eq "keeps the link" "$(readlink "$H/.claude/skills/t-review")" "$TMP/elsewhere/t-review"
assert_absent "writes nothing through the link" "$TMP/elsewhere/t-review/SKILL.md"
assert_contains "reports the blocker" "$OUT" "~/.claude/skills/t-code exists and wasn't installed by this setup"
assert_exists "still installs the other skills" "$H/.claude/skills/t-spec/SKILL.md"
assert_installed "$H/.agents/skills" "still installs Codex"

H="$TMP/file"
mkdir -p "$H/.agents"
printf 'not a directory\n' > "$H/.agents/skills"
setup "$H"
assert_eq "a non-directory skill dir blocks" "$RC" 1
assert_eq "and is left alone" "$(cat "$H/.agents/skills")" "not a directory"
assert_installed "$H/.claude/skills" "Claude is still installed"

printf '\narguments\n'
setup "$TMP/args" --help
assert_eq "--help exits zero" "$RC" 0
assert_absent "--help changes nothing" "$TMP/args/.claude"
setup "$TMP/args" extra
assert_eq "an unknown argument is refused" "$RC" 1
assert_absent "a refusal changes nothing" "$TMP/args/.claude"

assert_absent "never calls an agent CLI" "$TMP/cli-calls"

if [[ $FAIL -eq 0 ]]; then
  printf '%d assertions passed\n' "$PASS"
  exit 0
fi
printf '%d of %d assertions failed\n' "$FAIL" "$((PASS + FAIL))"
exit 1
