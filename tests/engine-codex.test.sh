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
mkdir -p "$TMP/.claude/rules/nested"
printf 'PROJECT_INSTRUCTIONS_MARKER\n' > "$TMP/AGENTS.md"
# .claude/rules fixtures, mirroring how Claude Code loads them: a bare rule and
# one whose frontmatter names no paths are always in context; one scoped with
# `paths:` loads only when Claude touches a matching file, and a `paths: "**"`
# that matches everything is scoped to nothing, so it is always on again.
printf 'PROJECT_RULE_MARKER\n' > "$TMP/.claude/rules/safety.md"
printf -- '---\ndescription: RULE_FRONTMATTER_MARKER\n---\nDESCRIBED_RULE_MARKER\n' > "$TMP/.claude/rules/described.md"
printf -- '---\npaths:\n  - src/**\n---\nSCOPED_RULE_MARKER\n' > "$TMP/.claude/rules/nested/scoped.md"
printf -- '---\npaths: "**"\n---\nWILDCARD_RULE_MARKER\n' > "$TMP/.claude/rules/nested/wildcard.md"
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
# --json puts the event stream on stdout; the CLI leaves stderr empty there,
# API errors included, which is why the adapter reads its diagnostics here too.
events() {
  printf '{"type":"thread.started","thread_id":"t1"}\n'
  printf '{"type":"turn.started"}\n'
  printf '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"final"}}\n'
}
usage_event() {
  printf '{"type":"turn.completed","usage":{"input_tokens":15882,"cached_input_tokens":10624,"cache_write_input_tokens":40,"output_tokens":218,"reasoning_output_tokens":96}}\n'
}
case "${CODEX_STUB_MODE:-structured}" in
  structured) events; usage_event; printf '{"name":"ok","note":null,"maybe":null,"extra":null}\n' > "$out" ;;
  text) events; usage_event; printf 'plain final answer\n' > "$out" ;;
  malformed) events; usage_event; printf 'not json\n' > "$out" ;;
  no-output) events; usage_event ;;
  nonzero) printf 'simulated failure\n' >&2; exit 7 ;;
  api-error)
    # A refused request: the CLI reports it only as events, with nothing on
    # stderr at all, and exits nonzero.
    events
    printf '{"type":"error","message":"Unsupported value: bad effort"}\n'
    printf '{"type":"turn.failed","error":{"message":"Unsupported value: bad effort"}}\n'
    exit 1 ;;
  quota-error)
    events
    printf '{"type":"error","message":"You have hit your usage limit; resets 3:50pm (Europe/Amsterdam)"}\n'
    printf '{"type":"turn.failed","error":{"message":"You have hit your usage limit; resets 3:50pm (Europe/Amsterdam)"}}\n'
    exit 1 ;;
  timeout) trap 'exit 143' TERM; sleep 5 ;;
  # A resume whose session the CLI no longer has. The adapter must tell this
  # apart from an ordinary failure so the caller can start fresh instead of
  # blocking on a conversation nobody can continue.
  lost-session)
    printf '{"type":"error","message":"No conversation found for thread t1"}\n'
    printf '{"type":"turn.failed","error":{"message":"No conversation found for thread t1"}}\n'
    exit 1 ;;
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
// CONVERSATION: unset for the ephemeral phases every judging step still runs,
// "new" to open a persisted session, or an id to continue that exact one.
const requested = process.env.CONVERSATION || ''
const conversation = requested === '' ? null : { id: requested === 'new' ? null : requested }
const result = await resolveVendor('codex').run({
  prompt: 'adapter probe',
  agentType: process.env.AGENT_TYPE,
  model: process.env.MODEL,
  effort: process.env.EFFORT,
  schema,
  cwd: process.cwd(),
  timeoutMs: Number(process.env.TIMEOUT_MS || 5000),
  conversation,
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
    CONVERSATION="${CONVERSATION:-}" \
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
# The CLI discovers the project's AGENTS.md itself (measured on codex-cli
# 0.152.1 under exactly these flags), so a second copy in argv would only be
# context spent twice on the same bytes.
assert_not_contains "the target AGENTS.md is left to native discovery" "$ARGS" 'PROJECT_INSTRUCTIONS_MARKER'
# Native discovery truncates past project_doc_max_bytes without saying so, and
# its 32 KiB default is smaller than real project instructions.
assert_contains "the project-doc cap is raised explicitly" "$ARGS" 'ARG:project_doc_max_bytes=262144'
assert_contains "an always-on .claude/rule reaches developer instructions" "$ARGS" 'PROJECT_RULE_MARKER'
assert_contains "so does one whose frontmatter names no paths" "$ARGS" 'DESCRIBED_RULE_MARKER'
assert_not_contains "its frontmatter is not carried with it" "$ARGS" 'RULE_FRONTMATTER_MARKER'
assert_contains "a nested rule scoped to everything is still always on" "$ARGS" 'WILDCARD_RULE_MARKER'
# Claude Code would not have this one in context either: it enters only when a
# matching file is touched, so shipping it on every phase imports a rule the
# phase has no use for.
assert_not_contains "a path-scoped rule is not imported" "$ARGS" 'SCOPED_RULE_MARKER'
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
assert_contains "a reviewer is read-only" "$ARGS" 'ARG:read-only'

printf '\nCodex adapter: usage comes from the event stream\n'
run_adapter coder gpt-5.6-sol xhigh 1
ARGS="$(cat "$TMP/args")"
assert_contains "the event stream is requested" "$ARGS" 'ARG:--json'
assert_contains "input tokens are recorded" "$RUN_OUT" '"input":15882'
assert_contains "output tokens are recorded" "$RUN_OUT" '"output":218'
assert_contains "cache reads are recorded" "$RUN_OUT" '"cacheRead":10624'
assert_contains "cache writes are recorded" "$RUN_OUT" '"cacheCreate":40'
# OpenAI nests cached inside input and reasoning inside output, so the total is
# input+output — adding the cache counters again would bill them twice.
assert_contains "the total does not double-count cached input" "$RUN_OUT" '"total":16100'
# gpt-5.6-sol at the short-context rates in lib/prices.mjs: 5218 fresh input
# tokens at $4, 10624 cached at $0.40, 40 cache writes at $5, 218 output at $20
# per 1M — cached and cache-write tokens billed out of input, not added to it.
assert_contains "the spawn is priced from the table" "$RUN_OUT" '"costUsd":0.0296816'
assert_contains "and the estimate is labelled as computed" "$RUN_OUT" '"costSource":"table"'

printf '\nCodex adapter: a model with no price row stays unpriced\n'
run_adapter coder gpt-5.6-unpriced xhigh 1
assert_contains "its tokens are still recorded" "$RUN_OUT" '"total":16100'
# A zero would quietly drag every average that includes it toward free.
assert_contains "cost is unknown, not zero" "$RUN_OUT" '"costUsd":null'
assert_contains "and carries no source" "$RUN_OUT" '"costSource":null'

printf '\nCodex adapter: fail-closed process and payload errors\n'
run_adapter coder gpt-5.6-sol xhigh 1 nonzero
assert_contains "nonzero exit is a failed result" "$RUN_OUT" '"ok":false'
assert_contains "the exit code survives" "$RUN_OUT" '"exitCode":7'
assert_contains "stderr still carries the diagnostic when there are no events" "$RUN_OUT" 'simulated failure'
run_adapter coder gpt-5.6-sol xhigh 1 api-error
assert_contains "an API error is a failed result" "$RUN_OUT" '"ok":false'
# Under --json the CLI writes nothing to stderr, so a phase whose diagnostic
# was only read from there would report a bare exit code to the blocker comment.
assert_contains "the error event reaches the failure reason" "$RUN_OUT" 'Unsupported value: bad effort'
run_adapter coder gpt-5.6-sol xhigh 1 quota-error
assert_contains "a Codex quota error reaches the failure reason" "$RUN_OUT" 'You have hit your usage limit'
assert_contains "a Codex reset time is preserved when the CLI supplies one" "$RUN_OUT" 'resets 3:50pm (Europe/Amsterdam)'
run_adapter coder gpt-5.6-sol xhigh 1 malformed
assert_contains "malformed structured output fails" "$RUN_OUT" 'final output was not the expected schema JSON'
run_adapter coder gpt-5.6-sol xhigh 1 no-output
assert_contains "a missing final file fails" "$RUN_OUT" 'final output file was not written'
run_adapter coder gpt-5.6-sol xhigh 1 timeout 50
assert_contains "a timed-out process is marked" "$RUN_OUT" '"timedOut":true'

# One builder conversation per run: a writable phase opens a persisted session
# and its later retries and repairs continue that exact id. `exec resume` is a
# different subcommand with a smaller flag surface than `exec`, so what it
# cannot take on the command line has to survive as config or the resumed phase
# would silently lose it.
printf '\nCodex adapter: a phase that carries a conversation persists its session\n'
CONVERSATION=new run_adapter coder gpt-5.6-sol xhigh 1
ARGS="$(cat "$TMP/args")"
assert_not_contains "a conversation-carrying phase is not ephemeral" "$ARGS" 'ARG:--ephemeral'
assert_not_contains "and it opens rather than resumes" "$ARGS" 'ARG:resume'
assert_contains "the id the CLI ran under comes back" "$RUN_OUT" '"sessionId":"t1"'
assert_contains "a phase that opened nothing cannot be missing a session" "$RUN_OUT" '"sessionMissing":false'

printf '\nCodex adapter: an ephemeral phase reports no session at all\n'
run_adapter reviewer gpt-5.6-sol xhigh 0 text
assert_contains "the judging phase stays ephemeral" "$(cat "$TMP/args")" 'ARG:--ephemeral'
assert_contains "and records no session to continue" "$RUN_OUT" '"sessionId":null'

printf '\nCodex adapter: continuing a conversation keeps the phase intact\n'
CONVERSATION=t1 run_adapter coder gpt-5.6-sol xhigh 1
ARGS="$(cat "$TMP/args")"
assert_contains "the resume subcommand is used" "$ARGS" 'ARG:resume'
assert_contains "with the exact session id, never a most-recent picker" "$ARGS" 'ARG:t1'
assert_not_contains "no --last shortcut is ever passed" "$ARGS" 'ARG:--last'
assert_not_contains "no exec-only sandbox flag reaches the resume subcommand" "$ARGS" 'ARG:--sandbox'
assert_contains "the write charter's sandbox survives as config" "$ARGS" 'ARG:sandbox_mode="danger-full-access"'
assert_contains "the engine row is still passed explicitly" "$ARGS" 'ARG:model_reasoning_effort="xhigh"'
assert_contains "the charter is re-sent rather than assumed" "$ARGS" 'ARG:developer_instructions='
assert_contains "the prompt still goes on stdin" "$(cat "$TMP/prompt")" 'adapter probe'
assert_contains "the continuation is still ordinary output" "$RUN_OUT" '"output":{"name":"ok"'

printf '\nCodex adapter: a read-only charter resumes read-only\n'
CONVERSATION=t1 run_adapter reviewer gpt-5.6-sol xhigh 0 text
assert_contains "the sandbox is derived from the charter, not the session" "$(cat "$TMP/args")" 'ARG:sandbox_mode="read-only"'

printf '\nCodex adapter: a session the CLI lost is told apart from a failed phase\n'
CONVERSATION=t1 run_adapter coder gpt-5.6-sol xhigh 1 lost-session
assert_contains "the phase still fails closed" "$RUN_OUT" '"ok":false'
assert_contains "and the caller is told the session is what is missing" "$RUN_OUT" '"sessionMissing":true'
run_adapter coder gpt-5.6-sol xhigh 1 api-error
assert_contains "an ordinary failure is never mistaken for a lost session" "$RUN_OUT" '"sessionMissing":false'

printf '\nCodex adapter: missing project instructions fail closed\n'
mv "$TMP/AGENTS.md" "$TMP/AGENTS.saved"
run_adapter coder gpt-5.6-sol xhigh 1 structured
assert_rc "adapter returns a failure record" 0 "$RUN_RC"
assert_contains "the phase is refused" "$RUN_OUT" 'Codex project instructions could not be read'
assert_not_contains "the CLI was never spawned" "$(cat "$TMP/args")" 'CALL'
mv "$TMP/AGENTS.saved" "$TMP/AGENTS.md"

printf '\nCodex adapter: instructions Codex would truncate fail closed\n'
# The preflight only measures the file; the CLI is what loads it. Instructions
# past the cap would arrive cut off mid-sentence with nothing reporting it.
mv "$TMP/AGENTS.md" "$TMP/AGENTS.saved"
head -c 262145 /dev/zero | tr '\0' 'x' > "$TMP/AGENTS.md"
run_adapter coder gpt-5.6-sol xhigh 1 structured
assert_rc "adapter returns a failure record" 0 "$RUN_RC"
assert_contains "the oversized file is named with its size" "$RUN_OUT" 'are 262145 bytes'
assert_contains "and the reason is the silent truncation" "$RUN_OUT" 'silently truncated copy'
assert_not_contains "the CLI was never spawned" "$(cat "$TMP/args")" 'CALL'
mv "$TMP/AGENTS.saved" "$TMP/AGENTS.md"

printf '\nCodex adapter: instructions at the cap still run\n'
mv "$TMP/AGENTS.md" "$TMP/AGENTS.saved"
head -c 262144 /dev/zero | tr '\0' 'x' > "$TMP/AGENTS.md"
run_adapter coder gpt-5.6-sol xhigh 1 structured
assert_contains "the phase runs" "$RUN_OUT" '"ok":true'
assert_contains "the CLI was spawned" "$(cat "$TMP/args")" 'CALL'
mv "$TMP/AGENTS.saved" "$TMP/AGENTS.md"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
