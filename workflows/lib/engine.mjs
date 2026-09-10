// The engine adapter: the one place that knows how a coding-agent CLI is
// invoked. Every pipeline step is a short-lived process spawned through here,
// so the pipeline itself never names a vendor. Which vendor, model and effort
// runs each pipeline step is a row in etc/engines.json (see loadEngines), so
// swapping or mixing vendors is an edit to that file, not to a pipeline.
//
// The contract every adapter implements:
//
//   run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, label, step,
//         conversation })
//     -> { ok, output, exitCode, timedOut, reason, stderrTail, usage,
//          sessionId, sessionMissing, outputFailure?, rejectedOutput? }
// `outputFailure` is set only when a schema-carrying process completed normally
// but its model answer was not structured JSON. Runtime uses that typed signal
// for selected checker-answer repair; missing files and provider failures never
// masquerade as rejected answers.
//
// `conversation` is how ONE run keeps one builder conversation instead of
// making every writable retry and repair rediscover the implementation:
//
//   absent/null   nothing in this run will ever continue the process: it is
//                 given no id to resume and its own id is discarded (Codex
//                 additionally persists no session file at all). Every judging
//                 phase runs this way, so a reviewer never inherits the
//                 builder's own account of what it did.
//   { id: null }  open a persisted session; the id it ran under comes back as
//                 `sessionId`.
//   { id: '…' }   resume exactly that session and append this prompt to it.
//
// The id is held in memory by the caller (runtime.mjs) and never read off disk,
// so a conversation cannot outlive its run or reach another worktree, and no
// adapter ever asks a CLI for "the most recent session". `sessionMissing` is
// true only when a resume failed BECAUSE the session was gone — the one
// failure a caller answers by starting fresh rather than by blocking.
//
// Every spawned process gets EPIC_STEP (the engines.json row) and
// EPIC_STEP_LABEL (the pipeline's label, e.g. review:2) in its environment.
// The CLIs ignore them; the test stub routes its fixtures on the label, so a
// prompt can be reworded without touching a test.
//
//   ok === true  ⇔  the process exited 0 AND a payload was extracted
//                   (the validated object when a schema was asked for, else text)
//   It NEVER throws and NEVER rejects: a step that failed is a value the
//   pipeline's own fail-closed branches read, not an exception that unwinds
//   past them.
//
// Processes are spawned through lib/proc.mjs, in their own process groups and
// tracked alongside the run's git/gh/npm children, so one signal forward from
// runtime.mjs (terminateAll) takes the whole tree.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run, terminateAll } from './proc.mjs'
import { codexCostUsd } from './prices.mjs'

export { terminateAll }

export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// What a run cost. Nulls where a CLI says nothing; the usage log records them
// as unknown rather than as zero. `costSource` says who produced the dollars —
// "cli" is the vendor's own accounting, "table" is lib/prices.mjs applied to
// reported tokens — so a computed estimate is never read back as a bill.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
function claudeUsage(envelope) {
  const u = envelope && typeof envelope.usage === 'object' ? envelope.usage : null
  const input = num(u?.input_tokens), output = num(u?.output_tokens)
  const cacheRead = num(u?.cache_read_input_tokens), cacheCreate = num(u?.cache_creation_input_tokens)
  const parts = [input, output, cacheRead, cacheCreate].filter(x => x !== null)
  const costUsd = num(envelope?.total_cost_usd)
  return {
    tokens: { input, output, cacheRead, cacheCreate, total: parts.length ? parts.reduce((a, b) => a + b, 0) : null },
    costUsd,
    costSource: costUsd === null ? null : 'cli',
    turns: num(envelope?.num_turns),
  }
}
// `codex exec --json` streams JSONL events on stdout: thread.started,
// turn.started, item.completed, then turn.completed (carrying usage) or
// turn.failed. Under --json the CLI's progress AND its API errors leave stderr
// entirely, so both the usage numbers and a failed phase's diagnostic are read
// from these events. Scraping the human-readable stream instead is what this
// replaced: 0.152.1 prints "tokens used\n<N>", never the "Token usage: total=…"
// line the old regex wanted, so every Codex spawn logged its cost as unknown.
function codexEvents(stdout) {
  const events = []
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try { events.push(JSON.parse(trimmed)) } catch { /* a partial or truncated line */ }
  }
  return events
}

// OpenAI counts cached input inside input_tokens and reasoning inside
// output_tokens, so a turn's total is input+output. Claude's four counters are
// separate additive pools summed instead — same record shape, each vendor's own
// arithmetic, so a mixed engine's rows stay comparable.
function codexUsage(events, model) {
  const add = (a, b) => (b === null ? a : (a === null ? b : a + b))
  let input = null, output = null, cacheRead = null, cacheCreate = null
  for (const e of events) {
    if (e?.type !== 'turn.completed' || !e.usage || typeof e.usage !== 'object') continue
    input = add(input, num(e.usage.input_tokens))
    output = add(output, num(e.usage.output_tokens))
    cacheRead = add(cacheRead, num(e.usage.cached_input_tokens))
    cacheCreate = add(cacheCreate, num(e.usage.cache_write_input_tokens))
  }
  const total = input === null && output === null ? null : (input ?? 0) + (output ?? 0)
  const tokens = { input, output, cacheRead, cacheCreate, total }
  // The CLI reports no cost, so it is priced from the published table; its
  // "turn" is one exec call rather than an agentic loop iteration, so the turn
  // count Claude reports has no honest equivalent and is left unknown.
  const costUsd = codexCostUsd(model, tokens)
  return { tokens, costUsd, costSource: costUsd === null ? null : 'table', turns: null }
}

// A malformed structured answer may be sent back to one fresh checker by the
// runtime's opt-in output-repair policy. Bound what crosses that prompt boundary
// independently of the adapter's stderr diagnostic cap.
const rejectedOutput = value => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  return text.length > 12000 ? `${text.slice(0, 12000)}\n[rejected output truncated]` : text
}

// The conversation a Codex process ran under. `codex exec --json` opens its
// event stream with thread.started, and a resume re-announces the same thread,
// so this is read on every call rather than only on the one that opened it.
function codexSessionId(events) {
  for (const e of events) {
    if (e?.type !== 'thread.started') continue
    const id = e.thread_id ?? e.id ?? e.thread?.id
    if (typeof id === 'string' && id.trim()) return id.trim()
  }
  return null
}

// A resume that failed because the session itself is gone: a rollout the CLI
// no longer has, an id from a process that never persisted one, a vendor that
// dropped the conversation. It is not a verdict on the work and it is not
// transient — the caller answers it by starting a fresh, fully briefed process
// where its own contract allows one. Kept narrow on purpose: anything else
// stays an ordinary failure for the caller's existing fail-closed branch.
const SESSION_MISSING = /\bno (?:conversation|session|thread)s?\b|\b(?:conversation|session|thread|rollout)\b[^\n]{0,80}\bnot found\b|\b(?:could not|cannot|unable to|failed to) resume\b/i
function isSessionMissing(reason, stderrTail) {
  return SESSION_MISSING.test(`${reason || ''}\n${stderrTail || ''}`)
}

// Why a Codex phase failed, for the blocker comment: its own error events, or
// stderr when the CLI died before emitting any (a spawn or config failure).
function codexDiagnostic(events, stderr) {
  const messages = events
    .filter(e => e?.type === 'error' || e?.type === 'turn.failed')
    .map(e => String(e.message ?? e.error?.message ?? '').trim())
    .filter(Boolean)
  return (messages.join('\n') || String(stderr || '').trim()).slice(-2000)
}

// Pull the payload out of whatever the CLI printed. Tolerant on purpose: the
// envelope is pinned (see the claude adapter's notes) but a version skew
// between laptop and host must degrade to "could not parse", never to a wrong
// value silently accepted.
function parseJsonLoose(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  try { return JSON.parse(trimmed) } catch { /* fall through */ }
  // Stray non-JSON lines around the envelope (a warning, a progress line):
  // take the last line that parses on its own.
  const lines = trimmed.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try { return JSON.parse(line) } catch { /* keep looking */ }
  }
  return null
}

// Claude emits the useful API failure as a normal JSON result envelope. It
// may pair is_error:true with subtype:"success" (observed on a live exhausted
// session), so neither the subtype nor the process exit code is the diagnosis.
// Prefer the API status/terminal reason and preserve result verbatim: that is
// where Claude includes the provider-local reset time.
function claudeDiagnostic(envelope, stdout, stderr) {
  const details = []
  if (envelope && typeof envelope === 'object') {
    if (Array.isArray(envelope.errors)) details.push(...envelope.errors.map(String))
    const nested = envelope.error && typeof envelope.error === 'object' ? envelope.error.message : null
    if (nested) details.push(String(nested))
    if (envelope.message) details.push(String(envelope.message))
    if (envelope.result) details.push(String(envelope.result))
  }
  const fallback = String(stderr || stdout || '').trim()
  return (details.map(s => s.trim()).filter(Boolean).join('; ') || fallback).slice(-2000)
}

function claudeErrorName(envelope) {
  const status = num(envelope?.api_error_status)
  if (envelope?.terminal_reason === 'api_error' || status !== null) return `API error${status === null ? '' : ` ${status}`}`
  return String(envelope?.subtype || 'error')
}

// A structured payload the model wrote as text rather than as structured
// output — fenced or bare JSON. Only consulted as a fallback.
function jsonFromText(text) {
  if (typeof text !== 'string') return null
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  try {
    const v = JSON.parse(unfenced.trim())
    return v && typeof v === 'object' ? v : null
  } catch { return null }
}

// Codex uses strict Structured Outputs, where every object property must be in
// `required`. Toliki's engine contract deliberately has optional fields (for
// example Prepare.refused). Make those fields required-but-nullable only for
// the Codex CLI boundary, then remove the synthetic nulls before the shared
// validator sees the original schema again.
function codexOutputSchema(schema) {
  if (Array.isArray(schema)) return schema.map(codexOutputSchema)
  if (!schema || typeof schema !== 'object') return schema
  const out = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key !== 'properties' && key !== 'required') out[key] = codexOutputSchema(value)
  }
  if (schema.properties && typeof schema.properties === 'object') {
    const originallyRequired = new Set(schema.required || [])
    out.properties = {}
    for (const [key, value] of Object.entries(schema.properties)) {
      let property = codexOutputSchema(value)
      if (!originallyRequired.has(key)) {
        if (typeof property.type === 'string') property = { ...property, type: [property.type, 'null'] }
        else if (Array.isArray(property.type) && !property.type.includes('null')) property = { ...property, type: [...property.type, 'null'] }
        else property = { anyOf: [property, { type: 'null' }] }
      }
      out.properties[key] = property
    }
    out.required = Object.keys(schema.properties)
  } else if (schema.required) {
    out.required = [...schema.required]
  }
  return out
}

function stripCodexOptionalNulls(value, schema) {
  if (Array.isArray(value)) {
    return value.map(item => stripCodexOptionalNulls(item, schema?.items))
  }
  if (!value || typeof value !== 'object' || !schema?.properties) return value
  const required = new Set(schema.required || [])
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const known = Object.hasOwn(schema.properties, key)
    if (item === null && known && !required.has(key) && !schemaAllowsNull(schema.properties[key])) continue
    out[key] = stripCodexOptionalNulls(item, schema.properties[key])
  }
  return out
}

function schemaAllowsNull(schema) {
  if (!schema || typeof schema !== 'object') return false
  if (schema.type === 'null') return true
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true
  if (schema.const === null || (Array.isArray(schema.enum) && schema.enum.includes(null))) return true
  return ['anyOf', 'oneOf'].some(key => Array.isArray(schema[key]) && schema[key].some(schemaAllowsNull))
}

// Run one process to completion. Resolves a result record; never rejects.
// The prompt goes on stdin rather than argv: requirement bodies and review
// prompts run to tens of KB, and stdin has neither an ARG_MAX ceiling nor a
// quoting story to get wrong.
function execute({ bin, args, prompt, cwd, timeoutMs, onStart, label, step, stdoutCap = 0 }) {
  const env = { ...process.env, EPIC_STEP: step || '', EPIC_STEP_LABEL: label || '' }
  return run(bin, args, { cwd, stdin: prompt, timeoutMs, onStart, env, stdoutCap })
}

// ───────────────────────── claude ─────────────────────────
// Envelope, pinned against the CLI's own result schema (2.1.x):
//   success: { type:"result", subtype:"success", is_error:false,
//              result:"<final text>", structured_output?:{…}, … }
//   failure: { type:"result", subtype:"error_during_execution"
//                            | "error_max_turns"
//                            | "error_max_structured_output_retries", …,
//              is_error:true, errors?:[…] }
// `structured_output` appears when --json-schema was passed and the model's
// output validated. The CLI runs its OWN retry loop against the schema first
// and only then gives up with error_max_structured_output_retries — so the
// respawn in runtime.mjs is a second, outer layer, not the only one.
// Charters live in the harness's own agents/ directory — read from the canonical
// file rather than through the ~/.claude/agents symlinks, so a pipeline run does
// not depend on user-level wiring that only interactive sessions need.
const AGENTS_DIR = new URL('../../agents/', import.meta.url)
const charterCache = new Map()

// Which tool boundary each pipeline step runs under. Fixed by the pipeline,
// never by etc/engines.json: the file picks a vendor, model and effort per
// step, not whether the step may write files. architect, review and
// final-review are read-only under both vendors; task carries the tasker
// charter, and the remaining writable steps carry coder. No row buys delivery
// prose: the phase that made a change returns the record it is published from,
// so nothing here pays for a second account of work already done. Every step
// here is a judgment call; the run's git, gh and npm work is done by the
// orchestrator (lib/github.mjs, lib/repo.mjs), never by a model.
export const STEPS = {
  task: 'tasker',
  architect: 'architect',
  code: 'coder',
  review: 'reviewer',
  'final-review': 'reviewer',
  'fixes-after-review': 'coder',
  'fix-conflicts': 'coder',
  'fix-ci': 'coder',
}

// etc/engines.json: named engines, each mapping every step to
// "<vendor>/<model>/<effort>". Tracked rather than machine-local because an
// engine name on an issue label has to resolve identically on whichever
// machine launches the run. Read once and validated in full: a missing step,
// an unregistered vendor, an effort that vendor's CLI does not accept, or an
// unknown step name refuses the whole file, so a run cannot start on a
// half-read table. EPIC_ENGINES_FILE points the tests at a throwaway copy.
const ENGINES_FILE = process.env.EPIC_ENGINES_FILE || path.join(HARNESS_DIR, 'etc', 'engines.json')
let enginesCache = null

export function loadEngines() {
  if (enginesCache) return enginesCache
  let raw
  try {
    raw = JSON.parse(readFileSync(ENGINES_FILE, 'utf8'))
  } catch (e) {
    throw new Error(`engines file ${ENGINES_FILE} could not be read: ${e.message}`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Object.keys(raw).length) {
    throw new Error(`engines file ${ENGINES_FILE} must be an object of named engines`)
  }
  const engines = {}
  for (const [name, table] of Object.entries(raw)) {
    // The name becomes the engine:<name> issue label and a --engine value.
    if (!/^[a-z0-9][a-z0-9+-]*$/.test(name)) {
      throw new Error(`engines file: engine name '${name}' must match [a-z0-9+-]`)
    }
    if (!table || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error(`engines file: engine '${name}' must map steps to "vendor/model/effort"`)
    }
    for (const step of Object.keys(table)) {
      if (!STEPS[step]) throw new Error(`engines file: engine '${name}' names unknown step '${step}' (known: ${Object.keys(STEPS).join(', ')})`)
    }
    engines[name] = {}
    for (const step of Object.keys(STEPS)) {
      const spec = table[step]
      if (typeof spec !== 'string') throw new Error(`engines file: engine '${name}' has no entry for step '${step}'`)
      const parts = spec.split('/')
      if (parts.length !== 3 || parts.some(p => !p)) {
        throw new Error(`engines file: engine '${name}' step '${step}' must be "vendor/model/effort", got "${spec}"`)
      }
      const [vendorName, model, effort] = parts
      const vendor = VENDORS[vendorName]
      if (!vendor) throw new Error(`engines file: engine '${name}' step '${step}' names unknown vendor '${vendorName}' (known: ${Object.keys(VENDORS).join(', ')})`)
      if (!vendor.efforts.includes(effort)) {
        throw new Error(`engines file: engine '${name}' step '${step}': ${vendorName} does not accept effort '${effort}' (accepts: ${vendor.efforts.join(', ')})`)
      }
      engines[name][step] = { vendor: vendorName, model, effort }
    }
  }
  enginesCache = engines
  return engines
}

function loadCharter(agentType) {
  if (charterCache.has(agentType)) return charterCache.get(agentType)
  const file = new URL(`${agentType}.md`, AGENTS_DIR)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`agent charter "${agentType}" could not be read at ${file.pathname}: ${e.message}. Refusing to run the step uncharted — architect and reviewer rely on this for their tool restrictions.`)
  }
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  if (!m) throw new Error(`agent charter "${agentType}" has no frontmatter block — refusing to run the step uncharted.`)
  const [, front, body] = m
  const toolsLine = front.split(/\r?\n/).find(l => l.startsWith('tools:'))
  const tools = toolsLine
    ? toolsLine.slice('tools:'.length).split(',').map(t => t.trim()).filter(Boolean)
    : []
  const charter = { body: body.trim(), tools }
  if (!charter.body) throw new Error(`agent charter "${agentType}" has an empty body — refusing to run the step uncharted.`)
  charterCache.set(agentType, charter)
  return charter
}

// Project instructions: Codex discovers the target project's AGENTS.md itself,
// so the adapter no longer reads that file into the prompt. Measured on
// codex-cli 0.152.1 against THESE launch flags (exec --ephemeral
// --ignore-user-config --sandbox <mode> -c developer_instructions=… -C <cwd>),
// with the request body captured off a local stand-in provider: the file
// arrives ahead of the task as `# AGENTS.md instructions for <cwd>`, in
// addition to — never instead of — the charter in developer_instructions.
// Injecting a second copy only spent context on the same bytes and would drift
// from whatever the CLI actually read.
//
// Two things native discovery does NOT do, which is why this is not simply a
// deletion:
//
//   * project_doc_max_bytes caps the discovered documents and truncates past
//     it SILENTLY — no event, no warning, the tail is just gone. Its default is
//     32 KiB; a target project can exceed it (Toliki did before its manual was
//     shortened), so the cap is set explicitly (--ignore-user-config means the
//     host's config.toml can neither raise nor zero it) and the preflight below
//     refuses a project file bigger than it. A phase never runs on half its
//     instructions, and never silently.
//   * .claude/rules has no Codex equivalent — see loadCompatRules.
const PROJECT_DOC_MAX_BYTES = 256 * 1024

// The one fail-closed check kept from the old injection path: a project with no
// readable AGENTS.md, or one Codex would truncate, refuses the phase before the
// CLI is spawned. It reads the file to measure it and passes none of it on.
// The cap is Codex's budget for every document it discovers (a $CODEX_HOME
// AGENTS.md and any directory doc above cwd count against the same total), so
// the bound here is deliberately far above any real project file.
function preflightProjectInstructions(cwd) {
  const instructions = path.join(cwd, 'AGENTS.md')
  let raw
  try {
    raw = readFileSync(instructions, 'utf8')
  } catch (e) {
    throw new Error(`Codex project instructions could not be read at ${instructions}: ${e.message}`)
  }
  if (!raw.trim()) throw new Error(`Codex project instructions are empty at ${instructions}`)
  const bytes = Buffer.byteLength(raw)
  if (bytes > PROJECT_DOC_MAX_BYTES) {
    throw new Error(`Codex project instructions at ${instructions} are ${bytes} bytes, past the ${PROJECT_DOC_MAX_BYTES}-byte project_doc_max_bytes this adapter sets — Codex would load a silently truncated copy. Split the file or raise PROJECT_DOC_MAX_BYTES in workflows/lib/engine.mjs.`)
  }
}

// One .claude/rules file, read the way Claude Code reads it: its body without
// the frontmatter, or null when the rule is path-scoped rather than always on.
// Claude loads .claude/rules/**/*.md alongside CLAUDE.md, but a file whose
// frontmatter carries `paths:` is CONDITIONAL — it enters context only once
// Claude touches a file those patterns match. A missing key, an empty list, or
// patterns that all reduce to `**` mean the rule is unconditional, and so does
// a file with no frontmatter at all. Matching that split is what keeps this a
// compatibility layer rather than a second, larger rule loader.
function unconditionalRuleBody(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/)
  if (!m) return raw.trim()
  const [, front, rest = ''] = m
  const lines = front.split(/\r?\n/)
  const at = lines.findIndex(l => /^paths\s*:/.test(l))
  if (at === -1) return rest.trim()
  const patterns = []
  const push = (value) => {
    for (const part of value.replace(/^\s*\[|\]\s*$/g, '').split(',')) {
      const pattern = part.trim().replace(/^['"]|['"]$/g, '').replace(/\/\*\*$/, '')
      if (pattern) patterns.push(pattern)
    }
  }
  push(lines[at].replace(/^paths\s*:/, ''))
  // A block list: `paths:` alone on its line, then `- pattern` items under it.
  for (let i = at + 1; i < lines.length && /^\s*-\s/.test(lines[i]); i++) {
    push(lines[i].replace(/^\s*-\s*/, ''))
  }
  const scoped = patterns.length > 0 && !patterns.every(pattern => pattern === '**')
  return scoped ? null : rest.trim()
}

// .claude/rules compatibility, and only that. Codex has no rules directory of
// its own, so a project that keeps required guidance there would lose it under
// a Codex engine. What the old code did instead — flatten every Markdown file
// under .claude/rules into every phase — imported rules Claude Code itself
// would not have loaded: a rule scoped with `paths:` to a corner of the repo
// reached an architect that never opens that corner, on every phase, priced per
// token. Only the unconditional rules are carried, so a Codex phase starts with
// what a Claude phase starts with, no more. Unreadable rules fail closed: a
// present-but-unreadable rule directory is a broken checkout, not an empty one.
function loadCompatRules(cwd) {
  const ruleRoot = path.join(cwd, '.claude', 'rules')
  const rules = []
  const visit = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (e) {
      if (e.code === 'ENOENT' && dir === ruleRoot) return
      throw new Error(`Codex project rules could not be read at ${dir}: ${e.message}`)
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const body = unconditionalRuleBody(readFileSync(file, 'utf8'))
        if (body) rules.push({ file: path.relative(cwd, file), body })
      }
    }
  }
  visit(ruleRoot)
  return rules.map(rule => `<project-rule source="${rule.file}">\n${rule.body}\n</project-rule>`).join('\n\n')
}

const claudeVendor = {
  name: 'claude',
  bin: process.env.CLAUDE_BIN || 'claude',
  // What --effort accepts on the 2.1.x CLI; loadEngines checks the file against it.
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],

  buildArgs({ agentType, model, effort, schema, resumeId }) {
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
    // Continue this run's own builder conversation. No --fork-session, so the
    // resumed conversation keeps the id it was opened under and one builder
    // stays one id for the whole run. The charter is re-sent rather than
    // snapshotted: passing --append-system-prompt turns --system-prompt-snapshot
    // off, so a resumed phase runs under exactly the charter bytes a fresh one
    // would get, and a charter edit between phases cannot be silently ignored.
    if (resumeId) args.push('--resume', resumeId)
    // Charter + tool restrictions, applied as a system prompt plus an explicit
    // tool list rather than with `--agent <name>`.
    //
    // `--agent` SILENTLY DISABLES `--json-schema`. Measured on 2026-08-20
    // against claude in print mode: the same call that returns
    // structured_output {"n":7,"w":"seven"} without --agent returns
    // structured_output null and a prose result with `--agent coder`. The
    // named agent's own output contract replaces the schema's, and nothing
    // reports it — the run just gets no structured payload, which is what
    // failed vms#66's prepare phase. Every stage that matters here carries a
    // schema, so --agent is unusable for this pipeline.
    //
    // Reading the charter from agents/*.md keeps the SAME two guarantees the
    // --agent path had: the charter body reaches the model, and the tool list
    // is enforced (architect/reviewer have no Bash/Write/Edit, so they
    // cannot inspect by shell or patch what they judge). It also fails LOUDLY
    // on a missing or malformed file
    // instead of running on without the restrictions, which is the only
    // acceptable failure mode for something whose whole job is to take tools
    // away.
    if (agentType) {
      const { body, tools } = loadCharter(agentType)
      args.push('--append-system-prompt', body)
      // One comma-separated argument, never `--tools A B C`: the flag is
      // variadic, so a space-separated list would swallow the flags that
      // follow it here.
      if (tools.length) args.push('--tools', tools.join(','))
    }
    // Model and effort come from the run's engine row, never from the CLI's own
    // default, so two vendors run comparable work.
    args.push('--model', model, '--effort', effort)
    if (schema) args.push('--json-schema', JSON.stringify(schema))
    return args
  },

  async run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, onStart, label, step, conversation }) {
    const resumeId = conversation?.id || null
    const args = this.buildArgs({ agentType, model, effort, schema, resumeId })
    const r = await execute({ bin: this.bin, args, prompt, cwd, timeoutMs, onStart, label, step })
    const stderrTail = String(r.stderr || '').trim().slice(-2000)
    const envelope = parseJsonLoose(r.stdout)
    const usage = claudeUsage(envelope)
    const diagnostic = claudeDiagnostic(envelope, r.stdout, r.stderr)
    // The envelope names the conversation the CLI actually ran under. Read back
    // rather than assumed: a caller that never sees an id learns its context is
    // not resumable instead of resuming something that does not exist.
    const reported = typeof envelope?.session_id === 'string' ? envelope.session_id.trim() : ''
    const sessionId = conversation ? (reported || null) : null
    const conversed = (result) => ({
      ...result,
      sessionId,
      sessionMissing: !!resumeId && !result.ok && isSessionMissing(result.reason, result.stderrTail),
    })

    if (r.spawnError) {
      const enoent = r.spawnError.code === 'ENOENT'
      return conversed({
        ok: false, output: null, exitCode: null, timedOut: false, stderrTail,
        reason: enoent
          // Loud and specific: mid-run this would otherwise look exactly like a
          // model that produced nothing, and the cause is a PATH line.
          ? `'${this.bin}' not found on PATH — a cron-launched pane inherits the PATH set in etc/dispatch.cron, which must include the directory holding it`
          : `could not spawn '${this.bin}': ${r.spawnError.message}`,
      })
    }
    if (r.timedOut) {
      return conversed({ ok: false, output: null, exitCode: r.code, timedOut: true, stderrTail, reason: `timed out after ${Math.round(timeoutMs / 60000)} min (process group killed)`, usage })
    }
    if (r.code !== 0) {
      return conversed({ ok: false, output: null, exitCode: r.code, timedOut: false, stderrTail, reason: `exited ${r.code}${diagnostic ? `: ${diagnostic}` : ''}`, usage })
    }

    if (!envelope || typeof envelope !== 'object') {
      return conversed({ ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: 'output was not the expected JSON envelope' })
    }
    if (envelope.is_error) {
      const detail = diagnostic || 'unknown error'
      return conversed({ ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: `${claudeErrorName(envelope)}: ${detail}`, usage })
    }

    if (schema) {
      const structured = envelope.structured_output ?? jsonFromText(envelope.result)
      if (!structured || typeof structured !== 'object') {
        return conversed({
          ok: false, output: null, exitCode: 0, timedOut: false, stderrTail,
          reason: 'no structured output in a schema-carrying result', usage,
          outputFailure: 'invalid-structured-output', rejectedOutput: rejectedOutput(envelope.result),
        })
      }
      return conversed({ ok: true, output: structured, exitCode: 0, timedOut: false, stderrTail, reason: null, usage })
    }

    return conversed({ ok: true, output: String(envelope.result ?? ''), exitCode: 0, timedOut: false, stderrTail, reason: null, usage })
  },
}

// ───────────────────────── codex ─────────────────────────
// `codex exec` writes its final answer to --output-last-message while progress
// stays out of the payload. When --output-schema is present, that file is the
// schema-validated JSON object. A fresh temp directory per process prevents
// concurrent review lenses from racing on either artifact.
//
// --json moves progress from the human-readable stream onto stdout as JSONL
// events, which is where the usage numbers and the API errors live; the payload
// still comes from the file, so stdout is only ever read for those two.
//
// The CLI has no Claude-style per-run tool allow-list. The charter body is
// therefore injected as developer instructions, and the tool boundary is
// enforced by the Codex sandbox: charters without Edit/Write are read-only;
// mutating phases retain the existing autonomous pipeline's full authority.
// Only the charter and the .claude/rules compatibility block travel that way:
// the project's AGENTS.md is the CLI's own discovery (see
// preflightProjectInstructions), so nothing here re-sends it.
//
// --json makes stdout the event stream, which a long phase runs into megabytes.
// Only its tail is ever read — turn.completed and the error events come last —
// and the payload comes from --output-last-message, so a bounded tail is whole.
const CODEX_STDOUT_CAP = 1024 * 1024

// A conversation-carrying phase cannot run --ephemeral: that flag is exactly
// "persist no session file", so the process that opened the conversation has to
// keep its rollout for the process that continues it. Every judging phase keeps
// the flag and leaves nothing behind.
//
// `exec resume` is its own subcommand with a smaller flag surface than `exec`
// (measured against codex-cli 0.152.1's own --help): it takes no -C, no
// --sandbox and no --color, and its positional order is
// `resume [OPTIONS] <SESSION_ID> [PROMPT]`. What those flags carried is set
// through -c overrides instead — sandbox_mode is the config key behind
// --sandbox — and the working directory rides on the spawned process itself,
// which lib/proc.mjs already sets to the run's worktree. Anything the resumed
// phase must not inherit silently (its model and effort) is still passed
// explicitly, and runtime.mjs refuses to resume across a changed engine row.

const codexVendor = {
  name: 'codex',
  bin: process.env.CODEX_BIN || 'codex',
  // The CLI's ReasoningEffort enum (0.152.x); loadEngines checks the file against it.
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],

  buildArgs({ charter, developerInstructions, model, effort, schemaFile, outputFile, cwd, conversation, resumeId }) {
    // Derive write authority from the charter itself. A new charter therefore
    // starts read-only unless it explicitly names Edit or Write.
    const sandbox = charter?.tools.some(tool => tool === 'Edit' || tool === 'Write')
      ? 'danger-full-access'
      : 'read-only'
    const args = ['exec']
    if (resumeId) args.push('resume')
    if (!conversation) args.push('--ephemeral')
    args.push('--ignore-user-config', '--json', '--disable', 'multi_agent', '--disable', 'enable_fanout')
    if (resumeId) args.push('-c', `sandbox_mode="${sandbox}"`)
    else args.push('--color', 'never', '--sandbox', sandbox, '-C', cwd)
    args.push(
      '-c', 'approval_policy="never"',
      // The project's own AGENTS.md is discovered by the CLI, not injected
      // here; this raises its silent 32 KiB truncation point to the bound
      // preflightProjectInstructions enforces.
      '-c', `project_doc_max_bytes=${PROJECT_DOC_MAX_BYTES}`,
      '--model', model,
      '-c', `model_reasoning_effort="${effort}"`,
      '--output-last-message', outputFile,
    )
    // Empty only for a phase with no charter and a project with no always-on
    // rules; an empty developer message is worth nothing and is left out.
    if (developerInstructions) {
      args.push('-c', `developer_instructions=${JSON.stringify(developerInstructions)}`)
    }
    if (schemaFile) args.push('--output-schema', schemaFile)
    if (resumeId) args.push(resumeId)
    args.push('-')
    return args
  },

  async run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, onStart, label, step, conversation }) {
    const work = mkdtempSync(path.join(tmpdir(), 'toliki-codex-'))
    const outputFile = path.join(work, 'final.txt')
    const schemaFile = schema ? path.join(work, 'schema.json') : null
    const resumeId = conversation?.id || null
    try {
      if (schemaFile) writeFileSync(schemaFile, JSON.stringify(codexOutputSchema(schema)))
      const charter = agentType ? loadCharter(agentType) : null
      preflightProjectInstructions(cwd)
      const developerInstructions = [charter?.body, loadCompatRules(cwd)].filter(Boolean).join('\n\n')
      const args = this.buildArgs({ charter, developerInstructions, model, effort, schemaFile, outputFile, cwd, conversation, resumeId })
      const r = await execute({ bin: this.bin, args, prompt, cwd, timeoutMs, onStart, label, step, stdoutCap: CODEX_STDOUT_CAP })
      const events = codexEvents(r.stdout)
      const stderrTail = codexDiagnostic(events, r.stderr)
      const usage = codexUsage(events, model)
      const sessionId = conversation ? codexSessionId(events) : null
      const conversed = (result) => ({
        ...result,
        sessionId,
        sessionMissing: !!resumeId && !result.ok && isSessionMissing(result.reason, result.stderrTail),
      })

      if (r.spawnError) {
        const enoent = r.spawnError.code === 'ENOENT'
        return conversed({
          ok: false, output: null, exitCode: null, timedOut: false, stderrTail,
          reason: enoent
            ? `'${this.bin}' not found on PATH — a cron-launched pane inherits the PATH set in etc/dispatch.cron, which must include the directory holding it`
            : `could not spawn '${this.bin}': ${r.spawnError.message}`,
        })
      }
      if (r.timedOut) {
        return conversed({ ok: false, output: null, exitCode: r.code, timedOut: true, stderrTail, reason: `timed out after ${Math.round(timeoutMs / 60000)} min (process group killed)`, usage })
      }
      if (r.code !== 0) {
        return conversed({ ok: false, output: null, exitCode: r.code, timedOut: false, stderrTail, reason: `exited ${r.code}${stderrTail ? `: ${stderrTail.split('\n').pop()}` : ''}`, usage })
      }

      let finalText
      try {
        finalText = readFileSync(outputFile, 'utf8')
      } catch (e) {
        return conversed({ ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: `final output file was not written: ${e.message}`, usage })
      }
      if (schema) {
        const structured = jsonFromText(finalText)
        if (!structured) {
          return conversed({
            ok: false, output: null, exitCode: 0, timedOut: false, stderrTail,
            reason: 'final output was not the expected schema JSON', usage,
            outputFailure: 'invalid-structured-output', rejectedOutput: rejectedOutput(finalText),
          })
        }
        return conversed({ ok: true, output: stripCodexOptionalNulls(structured, schema), exitCode: 0, timedOut: false, stderrTail, reason: null, usage })
      }
      return conversed({ ok: true, output: finalText.trim(), exitCode: 0, timedOut: false, stderrTail, reason: null, usage })
    } catch (e) {
      return {
        ok: false, output: null, exitCode: null, timedOut: false, stderrTail: '',
        reason: `Codex adapter setup failed: ${e.message}`,
        sessionId: null, sessionMissing: false,
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  },
}

// Vendors are the CLIs this file knows how to drive. Engines are the named
// step tables in etc/engines.json that pick a vendor per step.
const VENDORS = { claude: claudeVendor, codex: codexVendor }

// Whether a failed result looks like the infrastructure rather than the model:
// true for a rate limit, a 5xx, an overload or a dropped connection in what the
// CLI printed; false for a missing binary, a bad spawn, a timeout or a spent
// turn budget; undefined when the output says nothing either way (runtime.mjs
// then falls back to how fast the process died). Vendor knowledge stays here;
// the retry policy lives in runtime.mjs.
const TRANSIENT = /\b(429|500|502|503|504|529)\b|rate.?limit|overloaded|too many requests|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network error|service unavailable|internal server error|bad gateway|gateway timeout|api_error/i
const NOT_TRANSIENT = /not found on PATH|could not spawn|timed out|max.?turns|budget|adapter threw/i
export function isTransient(result) {
  if (!result || result.ok) return false
  if (result.timedOut) return false
  const text = `${result.reason || ''}\n${result.stderrTail || ''}`
  if (NOT_TRANSIENT.test(text)) return false
  if (TRANSIENT.test(text)) return true
  return undefined
}

export function vendorNames() {
  return Object.keys(VENDORS)
}

export function resolveVendor(name) {
  const vendor = VENDORS[name]
  if (!vendor) throw new Error(`unknown vendor '${name}' (known: ${vendorNames().join(', ')})`)
  return vendor
}

export function engineNames() {
  return Object.keys(loadEngines())
}

// The step table of one named engine, every row resolved and validated.
export function resolveEngine(name = 'claude') {
  const engine = loadEngines()[name]
  if (!engine) throw new Error(`unknown engine '${name}' (known: ${engineNames().join(', ')})`)
  return engine
}
