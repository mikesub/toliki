#!/usr/bin/env bash
set -euo pipefail

# Exercises the exact Claude and Codex wiring helpers used by setup and host
# provisioning. Hermetic: all links and settings live under throwaway homes;
# a fake Codex config API exposes parsed fixtures, never the real CLI or TOML
# parser. Registration must reach the regular source file, preserve other
# settings, and refuse conflicting or unconfirmed writes.

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
assert_registered() {
  if node - "$HOME/.codex/config.toml" "$ROOT/agents/spec-explorer.toml" <<'NODE'
const fs = require('node:fs');
const [configPath, charterPath] = process.argv.slice(2);
const registered = JSON.parse(fs.readFileSync(configPath)).agents?.['spec-explorer']?.config_file;
if (registered !== fs.realpathSync(charterPath) || !fs.lstatSync(registered).isFile()) process.exit(1);
NODE
  then ok_test "$1"; else nok "$1"; fi
}

mkdir -p "$TMP/bin"
export WIRING_TEST_ROOT="$TMP"
cat > "$TMP/bin/codex" <<'NODE'
#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const configPath = path.join(process.env.HOME, '.codex/config.toml');
if (!configPath.startsWith(process.env.WIRING_TEST_ROOT + '/') ||
    process.argv.slice(2).join(' ') !== 'app-server --stdio') process.exit(99);
const mode = process.env.WIRING_CODEX_MODE;
const raw = () => fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '{}';
const version = () => 'sha256:' + crypto.createHash('sha256').update(raw()).digest('hex');
const reply = (id, result) => console.log(JSON.stringify({ id, result }));
const error = id => console.log(JSON.stringify({ id, error: { code: -32000, message: 'fixture refusal' } }));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(path.join(path.dirname(configPath), 'config-api.jsonl'), line + '\n');
  if (r.method === 'initialize') {
    if (mode === 'timeout') return;
    return reply(r.id, {});
  }
  if (r.method === 'initialized') return;
  if (r.method === 'config/read') {
    if (mode === 'exit') process.exit(2);
    if (mode === 'read-error') return error(r.id);
    if (mode === 'malformed') return console.log('{broken');
    const layer = { name: { type: 'user', file: configPath }, version: version(), config: JSON.parse(raw()) };
    if (mode === 'missing-config') delete layer.config;
    return reply(r.id, { layers: mode === 'missing-user' ? [] : [layer] });
  }
  if (r.method === 'config/batchWrite') {
    const { edits, filePath, expectedVersion } = r.params;
    if (mode === 'write-error' || mode === 'concurrent-edit') return error(r.id);
    const allowedKeys = ['agents.spec-explorer.config_file', 'agents.spec-explorer.description'];
    if (filePath !== configPath || expectedVersion !== version() || !edits.length ||
        edits.some(edit => !allowedKeys.includes(edit.keyPath) || edit.mergeStrategy !== 'replace')) {
      return error(r.id);
    }
    const config = JSON.parse(raw());
    config.agents ??= {};
    config.agents['spec-explorer'] ??= {};
    for (const edit of edits) config.agents['spec-explorer'][edit.keyPath.split('.').pop()] = edit.value;
    if (mode !== 'drop-write') fs.writeFileSync(configPath, JSON.stringify(config));
    if (mode === 'replace-link') {
      const link = path.join(path.dirname(configPath), 'agents/spec-explorer.toml');
      fs.unlinkSync(link);
      fs.symlinkSync(path.join(process.env.WIRING_TEST_ROOT, 'foreign-agent.toml'), link);
    }
    return reply(r.id, {});
  }
  process.exit(98);
});
NODE
chmod +x "$TMP/bin/codex"
export PATH="$TMP/bin:$PATH"

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
printf '{"model":"keep-me","agents":{"mine":{"description":"user role"}}}\n' > "$HOME/.codex/config.toml"
ln -s "$ROOT/agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"
ln -s "$ROOT/agents/spec-explorer.toml" "$HOME/.codex/agents/spec-explorer.toml"

wire_codex_content "$ROOT"

assert_link "links /spec for Codex" "$HOME/.agents/skills/spec" "$ROOT/skills/spec"
assert_absent "removes the obsolete spec-explorer link to avoid duplicate definitions" "$HOME/.codex/agents/spec-explorer.toml"
assert_registered "registers the regular charter source, not its discovery symlink"
assert_contains "registers the role description for discovery" "$(cat "$HOME/.codex/config.toml")" 'Read-only codebase exploration for the /spec skill.'
assert_contains "preserves other Codex settings" "$(cat "$HOME/.codex/config.toml")" '"model":"keep-me"'
assert_contains "preserves other Codex role registrations" "$(cat "$HOME/.codex/config.toml")" '"mine":{"description":"user role"}'
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
assert_eq "idempotent run writes configuration only once" "$(rg -c 'config/batchWrite' "$HOME/.codex/config-api.jsonl")" "1"

printf '\nregistration through the old symlink is repaired without replacing the role\n'
ln -s "$ROOT/agents/spec-explorer.toml" "$HOME/.codex/agents/spec-explorer.toml"
node - "$HOME/.codex/config.toml" "$HOME/.codex/agents/spec-explorer.toml" <<'NODE'
const fs = require('node:fs');
const [file, link] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file));
config.agents['spec-explorer'] = { config_file: link, description: 'keep this description' };
fs.writeFileSync(file, JSON.stringify(config));
NODE
wire_codex_content "$ROOT"
assert_registered "replaces the symlink registration with its real source path"
assert_absent "retires the repaired symlink after confirming registration" "$HOME/.codex/agents/spec-explorer.toml"
assert_contains "preserves an existing role description" "$(cat "$HOME/.codex/config.toml")" '"description":"keep this description"'

printf '\nforeign Codex explorer override is preserved\n'
HOME="$TMP/codex-foreign-explorer-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.codex/agents" "$TMP/external-agents"
printf 'name = "explorer"\n' > "$TMP/external-agents/explorer.toml"
ln -s "$TMP/external-agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"

wire_codex_content "$ROOT"

assert_registered "registers spec-explorer beside a foreign explorer"
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
assert_absent "does not register a shadowing charter" "$HOME/.codex/config.toml"

printf '\nforeign Codex role registration refuses safely\n'
HOME="$TMP/codex-registration-shadow-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.codex/agents"
printf 'name = "foreign"\n' > "$HOME/.codex/agents/foreign.toml"
printf '{"agents":{"spec-explorer":{"config_file":"agents/foreign.toml"}}}\n' > "$HOME/.codex/config.toml"
BEFORE="$(cat "$HOME/.codex/config.toml")"
ln -s "$ROOT/agents/explorer.toml" "$HOME/.codex/agents/explorer.toml"
wire_codex_content "$ROOT"
assert_eq "does not overwrite a foreign role registration" "$(cat "$HOME/.codex/config.toml")" "$BEFORE"
assert_contains "reports the foreign role blocker" "$BLOCKERS" "not this checkout"
assert_link "retains the legacy agent until registration succeeds" "$HOME/.codex/agents/explorer.toml" "$ROOT/agents/explorer.toml"

printf '\nsymlinked user configuration refuses safely\n'
HOME="$TMP/codex-linked-config-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.codex"
printf '{"model":"leave-me-alone"}\n' > "$TMP/foreign-config.toml"
ln -s "$TMP/foreign-config.toml" "$HOME/.codex/config.toml"
wire_codex_content "$ROOT"
assert_link "preserves a linked user config" "$HOME/.codex/config.toml" "$TMP/foreign-config.toml"
assert_eq "does not edit the linked config's target" "$(cat "$TMP/foreign-config.toml")" '{"model":"leave-me-alone"}'
assert_contains "reports the linked config blocker" "$BLOCKERS" "not a regular file"

printf '\ndiscovery link replaced during registration is preserved\n'
HOME="$TMP/codex-replaced-link-home"
export HOME
CHANGES=""
BLOCKERS=""
mkdir -p "$HOME/.codex/agents"
ln -s "$ROOT/agents/spec-explorer.toml" "$HOME/.codex/agents/spec-explorer.toml"
export WIRING_CODEX_MODE=replace-link
wire_codex_content "$ROOT"
assert_link "does not remove a newly replaced link" "$HOME/.codex/agents/spec-explorer.toml" "$TMP/foreign-agent.toml"
assert_contains "reports the changed discovery link" "$BLOCKERS" "changed during registration"
unset WIRING_CODEX_MODE

printf '\nCodex registration failures refuse safely\n'
for mode in read-error malformed missing-user missing-config write-error concurrent-edit drop-write exit timeout; do
  HOME="$TMP/codex-$mode-home"
  export HOME
  CHANGES=""
  BLOCKERS=""
  export WIRING_CODEX_MODE="$mode"
  mkdir -p "$HOME/.codex/agents"
  ln -s "$ROOT/agents/spec-explorer.toml" "$HOME/.codex/agents/spec-explorer.toml"
  wire_codex_content "$ROOT"
  if [[ -n "$BLOCKERS" ]]; then ok_test "$mode is blocked"; else nok "$mode was reported as success"; fi
  assert_absent "$mode does not create unverified configuration" "$HOME/.codex/config.toml"
  assert_link "$mode preserves the old link until registration succeeds" "$HOME/.codex/agents/spec-explorer.toml" "$ROOT/agents/spec-explorer.toml"
done
unset WIRING_CODEX_MODE

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
