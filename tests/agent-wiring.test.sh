#!/usr/bin/env bash
set -euo pipefail

# Exercises the exact Claude and Codex wiring helpers used by setup and host
# provisioning. Hermetic: all links and settings live under throwaway homes.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok_test() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_link() {
  if [[ -L "$2" && "$(readlink "$2")" == "$3" ]]; then
    ok_test "$1"
  else
    nok "$1 (wanted link $2 -> $3)"
  fi
}
assert_absent() {
  if [[ ! -e "$2" && ! -L "$2" ]]; then ok_test "$1"; else nok "$1 ($2 remains)"; fi
}
assert_exists() {
  if [[ -e "$2" || -L "$2" ]]; then ok_test "$1"; else nok "$1 ($2 is missing)"; fi
}
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok_test "$1"; else nok "$1 (missing: $3)"; fi
}
assert_eq() {
  if [[ "$2" == "$3" ]]; then ok_test "$1"; else nok "$1 (values differ)"; fi
}

source "$ROOT/etc/wire-claude-content.sh"
source "$ROOT/etc/wire-codex-content.sh"

CHANGES=""
BLOCKERS=""
ok() { :; }
changed() { CHANGES="${CHANGES}${CHANGES:+\n}$*"; }
blocked() { BLOCKERS="${BLOCKERS}${BLOCKERS:+\n}$*"; }

printf '\nselected content and safe pruning\n'
HOME="$TMP/home"
export HOME
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/agents" "$TMP/other"
printf '{"env":{"KEEP_ME":"yes","CLAUDE_HARNESS_DIR":"legacy"}}\n' > "$HOME/.claude/settings.json"
printf 'mine\n' > "$HOME/.claude/skills/mine"
ln -s "$TMP/other" "$HOME/.claude/skills/other-source"
for name in epic fix-ci fix-conflict commit bugreport; do
  ln -s "$ROOT/skills/$name" "$HOME/.claude/skills/$name"
done
for name in architect.md coder.md reviewer.md explorer.md; do
  ln -s "$ROOT/agents/$name" "$HOME/.claude/agents/$name"
done

wire_claude_content "$ROOT"

assert_link "links /spec" "$HOME/.claude/skills/spec" "$ROOT/skills/spec"
assert_link "links spec-explorer" "$HOME/.claude/agents/spec-explorer.md" "$ROOT/agents/spec-explorer.md"
for name in epic fix-ci fix-conflict commit bugreport; do
  assert_absent "prunes skill $name" "$HOME/.claude/skills/$name"
done
for name in architect.md coder.md reviewer.md explorer.md; do
  assert_absent "prunes agent $name" "$HOME/.claude/agents/$name"
done
assert_exists "preserves a user file" "$HOME/.claude/skills/mine"
assert_link "preserves another source's link" "$HOME/.claude/skills/other-source" "$TMP/other"
assert_contains "leaves existing Claude settings untouched" "$(cat "$HOME/.claude/settings.json")" '"CLAUDE_HARNESS_DIR":"legacy"'
if [[ -z "$BLOCKERS" ]]; then ok_test "healthy wiring has no blockers"; else nok "healthy wiring blocked: $BLOCKERS"; fi

CHANGES=""
wire_claude_content "$ROOT"
if [[ -z "$CHANGES" ]]; then ok_test "second run is idempotent"; else nok "second run changed: $CHANGES"; fi

printf '\nshadowing content refuses safely\n'
HOME="$TMP/shadow-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.claude/skills/spec"
printf 'owned elsewhere\n' > "$HOME/.claude/skills/spec/marker"

wire_claude_content "$ROOT"

assert_exists "does not replace shadowing /spec" "$HOME/.claude/skills/spec/marker"
assert_contains "reports the shadowing blocker" "$BLOCKERS" "would shadow the harness copy"

printf '\nCodex uses the shared spec and spec-explorer\n'
HOME="$TMP/codex-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.agents/skills" "$HOME/.codex/agents"
printf 'mine\n' > "$HOME/.agents/skills/mine"
printf 'name = "mine"\n' > "$HOME/.codex/agents/mine.toml"
ln -s "$ROOT/agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"

wire_codex_content "$ROOT"

assert_link "links /spec for Codex" "$HOME/.agents/skills/spec" "$ROOT/skills/spec"
assert_link "links spec-explorer for Codex" "$HOME/.codex/agents/spec-explorer.toml" "$ROOT/agents/spec-explorer.toml"
assert_absent "prunes Toliki's old explorer override" "$HOME/.codex/agents/explorer.toml"
assert_exists "preserves another Codex skill" "$HOME/.agents/skills/mine"
assert_exists "preserves another Codex agent" "$HOME/.codex/agents/mine.toml"
if [[ -z "$BLOCKERS" ]]; then ok_test "healthy Codex wiring has no blockers"; else nok "healthy Codex wiring blocked: $BLOCKERS"; fi

CLAUDE_SPEC_EXPLORER="$(awk 'BEGIN { front = 0 } /^---$/ { front++; next } front >= 2 { if (!body && $0 == "") next; body = 1; print }' "$ROOT/agents/spec-explorer.md")"
CODEX_SPEC_EXPLORER="$(awk '/^developer_instructions = """$/ { body = 1; next } body && /^"""$/ { exit } body { print }' "$ROOT/agents/spec-explorer.toml")"
assert_eq "Claude and Codex spec-explorer instructions match" "$CLAUDE_SPEC_EXPLORER" "$CODEX_SPEC_EXPLORER"
assert_contains "Codex spec-explorer is read-only" "$(cat "$ROOT/agents/spec-explorer.toml")" 'sandbox_mode = "read-only"'

CHANGES=""
wire_codex_content "$ROOT"
if [[ -z "$CHANGES" ]]; then ok_test "second Codex run is idempotent"; else nok "second Codex run changed: $CHANGES"; fi

printf '\nforeign Codex explorer override is preserved\n'
HOME="$TMP/codex-foreign-explorer-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.codex/agents" "$TMP/external-agents"
printf 'name = "explorer"\n' > "$TMP/external-agents/explorer.toml"
ln -s "$TMP/external-agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"

wire_codex_content "$ROOT"

assert_link "links spec-explorer beside a foreign explorer" "$HOME/.codex/agents/spec-explorer.toml" "$ROOT/agents/spec-explorer.toml"
assert_link "preserves another source's explorer" "$HOME/.codex/agents/explorer.toml" "$TMP/external-agents/explorer.toml"

printf '\nCodex shadowing content refuses safely\n'
HOME="$TMP/codex-shadow-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.agents/skills/spec"
printf 'owned elsewhere\n' > "$HOME/.agents/skills/spec/marker"

wire_codex_content "$ROOT"

assert_exists "does not replace shadowing Codex /spec" "$HOME/.agents/skills/spec/marker"
assert_contains "reports the Codex shadowing blocker" "$BLOCKERS" "would shadow the harness copy"

printf '\nCodex spec-explorer shadow refuses safely\n'
HOME="$TMP/codex-agent-shadow-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.codex/agents"
printf 'owned elsewhere\n' > "$HOME/.codex/agents/spec-explorer.toml"

wire_codex_content "$ROOT"

assert_contains "does not replace shadowing Codex spec-explorer" "$(cat "$HOME/.codex/agents/spec-explorer.toml")" "owned elsewhere"
assert_contains "reports the Codex spec-explorer blocker" "$BLOCKERS" "would shadow the harness copy"

printf '\nCodex skill-directory symlink refuses safely\n'
HOME="$TMP/codex-linked-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.agents" "$TMP/external-skills"
printf 'owned elsewhere\n' > "$TMP/external-skills/marker"
ln -s "$TMP/external-skills" "$HOME/.agents/skills"

wire_codex_content "$ROOT"

assert_exists "does not write through another source's directory link" "$TMP/external-skills/marker"
assert_absent "does not add /spec through that directory link" "$TMP/external-skills/spec"
assert_contains "reports the linked-directory blocker" "$BLOCKERS" "~/.agents/skills is a symlink"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
