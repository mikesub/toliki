#!/usr/bin/env bash
set -euo pipefail

# Exercises the exact Claude and Codex wiring helpers used by setup and host
# provisioning. Hermetic: all links live under throwaway homes, and a fake
# codex on PATH records any call, since local wiring never needs the CLI.
# Only the local epic skills are published; links this checkout made for the
# parked /spec and spec-explorer are pruned, and foreign content is untouched.

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

SKILLS="t-architect t-code t-review t-ship t-spec"
assert_published() {
  local dir="$1" name
  for name in $SKILLS; do
    assert_link "$2 $name" "$dir/$name" "$ROOT/skills/epic/$name"
  done
}

mkdir -p "$TMP/bin"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/codex-calls"\nexit 99\n' "$TMP" > "$TMP/bin/codex"
chmod +x "$TMP/bin/codex"
export PATH="$TMP/bin:$PATH"

source "$ROOT/etc/wire-claude-content.sh"
source "$ROOT/etc/wire-codex-content.sh"

CHANGES=""
BLOCKERS=""
ok() { :; }
changed() { CHANGES="${CHANGES}${CHANGES:+\n}$*"; }
blocked() { BLOCKERS="${BLOCKERS}${BLOCKERS:+\n}$*"; }

printf '\nClaude: local skills only, with safe pruning\n'
HOME="$TMP/home"
export HOME
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/agents" "$TMP/other"
printf '{"env":{"KEEP_ME":"yes","CLAUDE_HARNESS_DIR":"legacy"}}\n' > "$HOME/.claude/settings.json"
printf 'mine\n' > "$HOME/.claude/skills/mine"
ln -s "$TMP/other" "$HOME/.claude/skills/other-source"
# Names this checkout once published, including ones it no longer holds: an
# older install must still be pruned, dangling or not.
for name in spec epic fix-ci fix-conflict commit bugreport; do
  ln -s "$ROOT/skills/$name" "$HOME/.claude/skills/$name"
done
for name in spec-explorer.md architect.md coder.md reviewer.md explorer.md; do
  ln -s "$ROOT/agents/$name" "$HOME/.claude/agents/$name"
done
printf 'mine\n' > "$HOME/.claude/agents/mine.md"
# A published name still pointing at an older layout of this checkout.
ln -s "$ROOT/skills/t-spec" "$HOME/.claude/skills/t-spec"

wire_claude_content "$ROOT"

assert_published "$HOME/.claude/skills" "links"
for name in spec epic fix-ci fix-conflict commit bugreport; do
  assert_absent "prunes skill $name" "$HOME/.claude/skills/$name"
done
for name in spec-explorer.md architect.md coder.md reviewer.md explorer.md; do
  assert_absent "prunes agent $name" "$HOME/.claude/agents/$name"
done
assert_exists "preserves a user skill file" "$HOME/.claude/skills/mine"
assert_exists "preserves a user agent" "$HOME/.claude/agents/mine.md"
assert_link "preserves another source's link" "$HOME/.claude/skills/other-source" "$TMP/other"
assert_contains "leaves existing Claude settings untouched" "$(cat "$HOME/.claude/settings.json")" '"CLAUDE_HARNESS_DIR":"legacy"'
assert_exists "an installed skill reaches the shared contract" "$HOME/.claude/skills/t-spec/EPIC-CONTRACT.md"
assert_exists "an installed skill reaches the helper" "$HOME/.claude/skills/t-ship/scripts/workspace.mjs"
if [[ -z "$BLOCKERS" ]]; then ok_test "healthy wiring has no blockers"; else nok "healthy wiring blocked: $BLOCKERS"; fi

CHANGES=""
wire_claude_content "$ROOT"
if [[ -z "$CHANGES" ]]; then ok_test "second run is idempotent"; else nok "second run changed: $CHANGES"; fi

printf '\nClaude: legacy whole-directory links are retired only when ours\n'
HOME="$TMP/legacy-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.claude"
ln -s "$ROOT/skills" "$HOME/.claude/skills"
ln -s "$ROOT/agents" "$HOME/.claude/agents"
wire_claude_content "$ROOT"
if [[ -d "$HOME/.claude/skills" && ! -L "$HOME/.claude/skills" ]]; then ok_test "converts the skills link to a directory"; else nok "skills link was not converted"; fi
assert_published "$HOME/.claude/skills" "then links"
assert_absent "removes the whole-directory agents link" "$HOME/.claude/agents"
assert_exists "never deletes through the old link" "$ROOT/agents/spec-explorer.md"

HOME="$TMP/foreign-dir-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.claude" "$TMP/foreign-skills" "$TMP/foreign-agents"
ln -s "$TMP/foreign-skills" "$HOME/.claude/skills"
ln -s "$TMP/foreign-agents" "$HOME/.claude/agents"
wire_claude_content "$ROOT"
assert_link "preserves another source's skills directory" "$HOME/.claude/skills" "$TMP/foreign-skills"
assert_link "preserves another source's agents directory" "$HOME/.claude/agents" "$TMP/foreign-agents"
assert_absent "does not add skills through that directory link" "$TMP/foreign-skills/t-spec"
assert_contains "reports the linked-directory blocker" "$BLOCKERS" "isn't this checkout"

printf '\nClaude: shadowing content refuses safely\n'
HOME="$TMP/shadow-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.claude/skills/t-spec" "$TMP/elsewhere/t-code"
printf 'owned elsewhere\n' > "$HOME/.claude/skills/t-spec/marker"
ln -s "$TMP/elsewhere/t-code" "$HOME/.claude/skills/t-code"

wire_claude_content "$ROOT"

assert_exists "does not replace a shadowing directory" "$HOME/.claude/skills/t-spec/marker"
assert_link "does not replace a live foreign link" "$HOME/.claude/skills/t-code" "$TMP/elsewhere/t-code"
assert_contains "reports the shadowing blocker" "$BLOCKERS" "would shadow the harness copy"
assert_link "still links the unshadowed skills" "$HOME/.claude/skills/t-review" "$ROOT/skills/epic/t-review"

printf '\nCodex: local skills only, with safe pruning\n'
HOME="$TMP/codex-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.agents/skills" "$HOME/.codex/agents"
printf 'mine\n' > "$HOME/.agents/skills/mine"
printf 'name = "mine"\n' > "$HOME/.codex/agents/mine.toml"
printf '{"model":"keep-me","agents":{"spec-explorer":{"config_file":"%s"}}}\n' "$ROOT/agents/spec-explorer.toml" > "$HOME/.codex/config.toml"
CONFIG_BEFORE="$(cat "$HOME/.codex/config.toml")"
ln -s "$ROOT/skills/spec" "$HOME/.agents/skills/spec"
ln -s "$ROOT/agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"
ln -s "$ROOT/agents/spec-explorer.toml" "$HOME/.codex/agents/spec-explorer.toml"

wire_codex_content "$ROOT"

assert_published "$HOME/.agents/skills" "links for Codex"
assert_absent "prunes the parked /spec" "$HOME/.agents/skills/spec"
assert_absent "prunes Toliki's old explorer override" "$HOME/.codex/agents/explorer.toml"
assert_absent "prunes the spec-explorer discovery link" "$HOME/.codex/agents/spec-explorer.toml"
assert_exists "preserves another Codex skill" "$HOME/.agents/skills/mine"
assert_exists "preserves another Codex agent" "$HOME/.codex/agents/mine.toml"
assert_eq "leaves the Codex configuration untouched" "$(cat "$HOME/.codex/config.toml")" "$CONFIG_BEFORE"
assert_absent "never runs the Codex CLI" "$TMP/codex-calls"
if [[ -z "$BLOCKERS" ]]; then ok_test "healthy Codex wiring has no blockers"; else nok "healthy Codex wiring blocked: $BLOCKERS"; fi

CHANGES=""
wire_codex_content "$ROOT"
if [[ -z "$CHANGES" ]]; then ok_test "second Codex run is idempotent"; else nok "second Codex run changed: $CHANGES"; fi

printf '\nCodex: foreign roles and shadowing content are preserved\n'
HOME="$TMP/codex-foreign-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.agents/skills/t-review" "$HOME/.codex/agents" "$TMP/external-agents"
printf 'owned elsewhere\n' > "$HOME/.agents/skills/t-review/marker"
printf 'name = "explorer"\n' > "$TMP/external-agents/explorer.toml"
ln -s "$TMP/external-agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"

wire_codex_content "$ROOT"

assert_link "preserves another source's explorer" "$HOME/.codex/agents/explorer.toml" "$TMP/external-agents/explorer.toml"
assert_exists "does not replace a shadowing Codex skill" "$HOME/.agents/skills/t-review/marker"
assert_contains "reports the Codex shadowing blocker" "$BLOCKERS" "would shadow the harness copy"

printf '\nCodex: skill-directory symlink refuses safely\n'
HOME="$TMP/codex-linked-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.agents" "$TMP/external-skills"
printf 'owned elsewhere\n' > "$TMP/external-skills/marker"
ln -s "$TMP/external-skills" "$HOME/.agents/skills"

wire_codex_content "$ROOT"

assert_exists "does not write through another source's directory link" "$TMP/external-skills/marker"
assert_absent "does not add skills through that directory link" "$TMP/external-skills/t-spec"
assert_contains "reports the linked-directory blocker" "$BLOCKERS" "~/.agents/skills is a symlink"

printf '\nparked spec-explorer charters stay in step\n'
CLAUDE_SPEC_EXPLORER="$(awk 'BEGIN { front = 0 } /^---$/ { front++; next } front >= 2 { if (!body && $0 == "") next; body = 1; print }' "$ROOT/agents/spec-explorer.md")"
CODEX_SPEC_EXPLORER="$(awk '/^developer_instructions = """$/ { body = 1; next } body && /^"""$/ { exit } body { print }' "$ROOT/agents/spec-explorer.toml")"
assert_eq "Claude and Codex spec-explorer instructions match" "$CLAUDE_SPEC_EXPLORER" "$CODEX_SPEC_EXPLORER"
assert_contains "Codex spec-explorer is read-only" "$(cat "$ROOT/agents/spec-explorer.toml")" 'sandbox_mode = "read-only"'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
