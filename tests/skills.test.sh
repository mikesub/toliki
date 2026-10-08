#!/usr/bin/env bash
set -euo pipefail

# Static checks on the skill bundle: every skill is named for its directory,
# reaches the shared contract through its own directory, and names no specific
# agent harness, so one copy works in any harness that loads SKILL.md skills;
# the contract asks the human one question at a time, through the harness's
# question tool when it has one.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/skills/epic"

PASS=0
FAIL=0
ok_test() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

SKILLS=""
for dir in "$BUNDLE"/*/; do
  [[ -f "$dir/SKILL.md" ]] && SKILLS="${SKILLS:+$SKILLS }$(basename "$dir")"
done
if [[ "$SKILLS" == "t-architect t-code t-review t-ship t-spec" ]]; then
  ok_test "the bundle holds the five t-* skills"
else
  nok "unexpected skills: $SKILLS"
fi

for name in $SKILLS; do
  skill="$BUNDLE/$name/SKILL.md"
  if [[ "$(sed -n 1,2p "$skill")" == "$(printf -- '---\nname: %s' "$name")" ]]; then
    ok_test "$name frontmatter names its directory"
  else
    nok "$name frontmatter does not start with name: $name"
  fi
  if grep -q '^description: .' "$skill"; then ok_test "$name has a description"; else nok "$name has no description"; fi
  if grep -q '](EPIC-CONTRACT.md)' "$skill"; then ok_test "$name links the contract"; else nok "$name does not link the contract"; fi
  contract="$BUNDLE/$name/EPIC-CONTRACT.md"
  if [[ -L "$contract" && "$(readlink "$contract")" == "../EPIC-CONTRACT.md" ]]; then
    ok_test "$name reaches the shared contract through its own directory"
  else
    nok "$name/EPIC-CONTRACT.md is not a link to the shared contract"
  fi
done

if grep -q 'one question at a time' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -q 'selectable answers' "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "the contract asks one question at a time through a question tool"
else
  nok "the contract no longer asks one question at a time through a question tool"
fi

for file in "$BUNDLE/EPIC-CONTRACT.md" "$BUNDLE"/t-*/SKILL.md; do
  if grep -qi -e codex -e claude "$file"; then
    nok "${file#"$ROOT/"} names a specific harness"
  else
    ok_test "${file#"$ROOT/"} is harness-neutral"
  fi
done

if [[ $FAIL -eq 0 ]]; then
  printf '%d assertions passed\n' "$PASS"
  exit 0
fi
printf '%d of %d assertions failed\n' "$FAIL" "$((PASS + FAIL))"
exit 1
