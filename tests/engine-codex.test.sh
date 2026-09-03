#!/usr/bin/env bash
set -euo pipefail

# Exercises the Codex adapter directly against a fake CLI. No credentials,
# network, real repository, or live agent process is used.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_contains() { if [[ "$2" == *"$3"* ]]; then ok "$1"; else nok "$1 (missing: $3)"; fi; }
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpected: $3)"; fi; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }

mkdir -p "$TMP/bin"
mkdir -p "$TMP/.claude/rules"
printf 'PROJECT_CONSTITUTION_MARKER\n' > "$TMP/CLAUDE.md"
printf 'PROJECT_RULE_MARKER\n' > "$TMP/.claude/rules/safety.md"
cat > "$TMP/bin/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'CALL\n' >> "$CODEX_ARG_LOG"
for arg in "$@"; do printf 'ARG:%s\n' "$arg" >> "$CODEX_ARG_LOG"; done
out=""
schema=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-last-message) out="$2"; shift 2 ;;
    --output-schema) schema="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > "$CODEX_PROMPT_LOG"
[[ -z "$schema" ]] || cp "$schema" "$CODEX_SCHEMA_LOG"
case "${CODEX_STUB_MODE:-structured}" in
  structured) printf '{"name":"ok","note":null,"maybe":null,"extra":null}\n' > "$out" ;;
  text) printf 'plain final answer\n' > "$out" ;;
  malformed) printf 'not json\n' > "$out" ;;
  no-output) ;;
  nonzero) printf 'simulated failure\n' >&2; exit 7 ;;
  timeout) trap 'exit 143' TERM; sleep 5 ;;
esac
STUB
chmod +x "$TMP/bin/codex"

cat > "$TMP/run.mjs" <<'NODE'
const { resolveVendor } = await import(process.env.ENGINE_MODULE)
const schema = process.env.USE_SCHEMA === '1' ? {
  type: 'object', additionalProperties: false, required: ['name'],
  properties: {
    name: { type: 'string' },
    note: { type: 'string' },
    maybe: { type: ['string', 'null'] },
  },
} : undefined
const result = await resolveVendor('codex').run({
  prompt: 'adapter probe',
  agentType: process.env.AGENT_TYPE,
  model: process.env.MODEL,
  effort: process.env.EFFORT,
  schema,
  cwd: process.cwd(),
  timeoutMs: Number(process.env.TIMEOUT_MS || 5000),
})
console.log(JSON.stringify(result))
NODE

RUN_OUT=""
RUN_RC=0
run_adapter() {
  : > "$TMP/args"
  : > "$TMP/prompt"
  rm -f "$TMP/schema"
  RUN_RC=0
  RUN_OUT="$(
    cd "$TMP" && \
    ENGINE_MODULE="$ROOT/workflows/lib/engine.mjs" \
    CODEX_BIN="$TMP/bin/codex" \
    CODEX_ARG_LOG="$TMP/args" \
    CODEX_PROMPT_LOG="$TMP/prompt" \
    CODEX_SCHEMA_LOG="$TMP/schema" \
    AGENT_TYPE="$1" MODEL="$2" EFFORT="$3" USE_SCHEMA="$4" \
    CODEX_STUB_MODE="${5:-structured}" TIMEOUT_MS="${6:-5000}" \
    node "$TMP/run.mjs" 2>&1
  )" || RUN_RC=$?
}

printf '\nCodex adapter: structured coder phase\n'
run_adapter coder gpt-5.6-sol xhigh 1
assert_rc "runner exits 0" 0 "$RUN_RC"
assert_contains "structured output is returned" "$RUN_OUT" '"output":{"name":"ok"'
assert_not_contains "the optional field does not leak" "$RUN_OUT" '"note":null'
assert_contains "an originally nullable optional null survives" "$RUN_OUT" '"maybe":null'
assert_contains "an unknown null survives for the shared validator to reject" "$RUN_OUT" '"extra":null'
ARGS="$(cat "$TMP/args")"
assert_contains "the model reaches argv verbatim" "$ARGS" 'ARG:gpt-5.6-sol'
assert_contains "the effort reaches argv verbatim" "$ARGS" 'ARG:model_reasoning_effort="xhigh"'
assert_contains "a write charter gets full sandbox authority" "$ARGS" 'ARG:danger-full-access'
assert_contains "approval prompts are disabled" "$ARGS" 'ARG:approval_policy="never"'
PHYSICAL_TMP="$(cd "$TMP" && pwd -P)"
assert_contains "the working root is explicit" "$ARGS" "ARG:$PHYSICAL_TMP"
assert_contains "hidden multi-agent fan-out is disabled" "$ARGS" 'ARG:multi_agent'
assert_contains "the secondary fan-out flag is disabled" "$ARGS" 'ARG:enable_fanout'
assert_contains "the coder charter has developer-role delivery" "$ARGS" 'ARG:developer_instructions='
assert_contains "the target CLAUDE.md reaches developer instructions" "$ARGS" 'PROJECT_CONSTITUTION_MARKER'
assert_contains "the target .claude/rules reach developer instructions" "$ARGS" 'PROJECT_RULE_MARKER'
assert_contains "the task itself stays on stdin" "$(cat "$TMP/prompt")" 'adapter probe'
SCHEMA="$(cat "$TMP/schema")"
assert_contains "Codex schema requires every property" "$SCHEMA" '"required":["name","note","maybe"]'
assert_contains "that field becomes nullable at the boundary" "$SCHEMA" '"type":["string","null"]'
OUT_PATH="$(awk '/^ARG:--output-last-message$/{getline; sub(/^ARG:/, ""); print; exit}' "$TMP/args")"
if [[ -n "$OUT_PATH" && ! -d "$(dirname "$OUT_PATH")" ]]; then ok "temporary artifacts are removed"; else nok "temporary artifacts are removed"; fi

printf '\nCodex adapter: read-only strong phase\n'
run_adapter architect gpt-5.6-sol high 0 text
ARGS="$(cat "$TMP/args")"
assert_contains "a second pair: model" "$ARGS" 'ARG:gpt-5.6-sol'
assert_contains "a second pair: effort" "$ARGS" 'ARG:model_reasoning_effort="high"'
assert_contains "an architect is read-only" "$ARGS" 'ARG:read-only'
assert_contains "schema-less final text is returned" "$RUN_OUT" '"output":"plain final answer"'

printf '\nCodex adapter: a third model/effort pair\n'
run_adapter reviewer gpt-5.6-terra medium 0 text
ARGS="$(cat "$TMP/args")"
assert_contains "a third pair: model" "$ARGS" 'ARG:gpt-5.6-terra'
assert_contains "a third pair: effort" "$ARGS" 'ARG:model_reasoning_effort="medium"'

printf '\nCodex adapter: fail-closed process and payload errors\n'
run_adapter coder gpt-5.6-sol xhigh 1 nonzero
assert_contains "nonzero exit is a failed result" "$RUN_OUT" '"ok":false'
assert_contains "the exit code survives" "$RUN_OUT" '"exitCode":7'
run_adapter coder gpt-5.6-sol xhigh 1 malformed
assert_contains "malformed structured output fails" "$RUN_OUT" 'final output was not the expected schema JSON'
run_adapter coder gpt-5.6-sol xhigh 1 no-output
assert_contains "a missing final file fails" "$RUN_OUT" 'final output file was not written'
run_adapter coder gpt-5.6-sol xhigh 1 timeout 50
assert_contains "a timed-out process is marked" "$RUN_OUT" '"timedOut":true'

printf '\nCodex adapter: missing project constitution fails closed\n'
mv "$TMP/CLAUDE.md" "$TMP/CLAUDE.saved"
run_adapter coder gpt-5.6-sol xhigh 1 structured
assert_rc "adapter returns a failure record" 0 "$RUN_RC"
assert_contains "the phase is refused" "$RUN_OUT" 'Codex project constitution could not be read'
assert_not_contains "the CLI was never spawned" "$(cat "$TMP/args")" 'CALL'
mv "$TMP/CLAUDE.saved" "$TMP/CLAUDE.md"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
