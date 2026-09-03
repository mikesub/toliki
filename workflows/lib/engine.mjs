// The engine adapter: the one place that knows how a coding-agent CLI is
// invoked. Every pipeline step is a short-lived process spawned through here,
// so the pipeline itself never names a vendor. Which vendor, model and effort
// runs each pipeline step is a row in etc/engines.json (see loadEngines), so
// swapping or mixing vendors is an edit to that file, not to a pipeline.
//
// The contract every adapter implements:
//
//   run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, label, step })
//     -> { ok, output, exitCode, timedOut, reason, stderrTail, usage }
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

export { terminateAll }

export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// What a run cost, from each CLI's own report. Nulls where a CLI says nothing;
// the usage log records them as unknown rather than as zero.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
function claudeUsage(envelope) {
  const u = envelope && typeof envelope.usage === 'object' ? envelope.usage : null
  const input = num(u?.input_tokens), output = num(u?.output_tokens)
  const cacheRead = num(u?.cache_read_input_tokens), cacheCreate = num(u?.cache_creation_input_tokens)
  const parts = [input, output, cacheRead, cacheCreate].filter(x => x !== null)
  return {
    tokens: { input, output, cacheRead, cacheCreate, total: parts.length ? parts.reduce((a, b) => a + b, 0) : null },
    costUsd: num(envelope?.total_cost_usd),
    turns: num(envelope?.num_turns),
  }
}
// codex exec ends its progress stream with "Token usage: total=N input=N (+ N cached) output=N".
function codexUsage(stderr) {
  const m = String(stderr || '').match(/Token usage:\s*total=([\d,]+)(?:\s+input=([\d,]+))?(?:\s*\(\+\s*([\d,]+)\s*cached\))?(?:\s+output=([\d,]+))?/i)
  const n = (s) => (s === undefined ? null : Number(String(s).replace(/,/g, '')))
  if (!m) return { tokens: { input: null, output: null, cacheRead: null, cacheCreate: null, total: null }, costUsd: null, turns: null }
  return { tokens: { input: n(m[2]), output: n(m[4]), cacheRead: n(m[3]), cacheCreate: null, total: n(m[1]) }, costUsd: null, turns: null }
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
function execute({ bin, args, prompt, cwd, timeoutMs, onStart, label, step }) {
  const env = { ...process.env, EPIC_STEP: step || '', EPIC_STEP_LABEL: label || '' }
  return run(bin, args, { cwd, stdin: prompt, timeoutMs, onStart, env })
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
// confirm-review are read-only under both vendors; the rest carry the coder
// charter and may edit the worktree. Every step here is a judgment call; the
// run's git, gh and npm work is done by the orchestrator (lib/github.mjs,
// lib/repo.mjs), never by a model.
export const STEPS = {
  architect: 'architect',
  code: 'coder',
  review: 'reviewer',
  'confirm-review': 'reviewer',
  'fixes-after-review': 'coder',
  'fix-conflicts': 'coder',
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

// A target project's instructions live in its AGENTS.md (CLAUDE.md is a
// pointer to it) plus any .claude/rules it still keeps. Claude Code loads both
// itself; Codex's own AGENTS.md discovery is a CLI setting rather than a
// guarantee and never covers .claude/rules, so read both explicitly for Codex
// so a Codex phase gets what a Claude phase gets. Missing or unreadable
// instructions fail closed.
function loadProjectInstructions(cwd) {
  const instructions = path.join(cwd, 'AGENTS.md')
  let body
  try {
    body = readFileSync(instructions, 'utf8').trim()
  } catch (e) {
    throw new Error(`Codex project instructions could not be read at ${instructions}: ${e.message}`)
  }
  if (!body) throw new Error(`Codex project instructions are empty at ${instructions}`)

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
        rules.push({ file: path.relative(cwd, file), body: readFileSync(file, 'utf8').trim() })
      }
    }
  }
  visit(ruleRoot)

  return [
    `<project-instructions source="AGENTS.md">\n${body}\n</project-instructions>`,
    ...rules.map(rule => `<project-rule source="${rule.file}">\n${rule.body}\n</project-rule>`),
  ].join('\n\n')
}

const claudeVendor = {
  name: 'claude',
  bin: process.env.CLAUDE_BIN || 'claude',
  // What --effort accepts on the 2.1.x CLI; loadEngines checks the file against it.
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],

  buildArgs({ agentType, model, effort, schema }) {
    const args = ['-p', '--output-format', 'json', '--dangerously-skip-permissions']
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
    // is enforced (architect/reviewer have no Write/Edit, so they cannot patch
    // what they judge). It also fails LOUDLY on a missing or malformed file
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

  async run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, onStart, label, step }) {
    const args = this.buildArgs({ agentType, model, effort, schema })
    const r = await execute({ bin: this.bin, args, prompt, cwd, timeoutMs, onStart, label, step })
    const stderrTail = String(r.stderr || '').trim().slice(-2000)

    if (r.spawnError) {
      const enoent = r.spawnError.code === 'ENOENT'
      return {
        ok: false, output: null, exitCode: null, timedOut: false, stderrTail,
        reason: enoent
          // Loud and specific: mid-run this would otherwise look exactly like a
          // model that produced nothing, and the cause is a PATH line.
          ? `'${this.bin}' not found on PATH — a cron-launched pane inherits the PATH set in etc/dispatch.cron, which must include the directory holding it`
          : `could not spawn '${this.bin}': ${r.spawnError.message}`,
      }
    }
    if (r.timedOut) {
      return { ok: false, output: null, exitCode: r.code, timedOut: true, stderrTail, reason: `timed out after ${Math.round(timeoutMs / 60000)} min (process group killed)` }
    }
    if (r.code !== 0) {
      return { ok: false, output: null, exitCode: r.code, timedOut: false, stderrTail, reason: `exited ${r.code}${stderrTail ? `: ${stderrTail.split('\n').pop()}` : ''}` }
    }

    const envelope = parseJsonLoose(r.stdout)
    if (!envelope || typeof envelope !== 'object') {
      return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: 'output was not the expected JSON envelope' }
    }
    const usage = claudeUsage(envelope)
    if (envelope.is_error) {
      const detail = Array.isArray(envelope.errors) && envelope.errors.length
        ? envelope.errors.join('; ')
        : String(envelope.result || envelope.subtype || 'unknown error')
      return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: `${envelope.subtype || 'error'}: ${detail}`, usage }
    }

    if (schema) {
      const structured = envelope.structured_output ?? jsonFromText(envelope.result)
      if (!structured || typeof structured !== 'object') {
        return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: 'no structured output in a schema-carrying result', usage }
      }
      return { ok: true, output: structured, exitCode: 0, timedOut: false, stderrTail, reason: null, usage }
    }

    return { ok: true, output: String(envelope.result ?? ''), exitCode: 0, timedOut: false, stderrTail, reason: null, usage }
  },
}

// ───────────────────────── codex ─────────────────────────
// `codex exec` writes its final answer to --output-last-message while progress
// stays out of the payload. When --output-schema is present, that file is the
// schema-validated JSON object. A fresh temp directory per process prevents
// concurrent review lenses from racing on either artifact.
//
// The CLI has no Claude-style per-run tool allow-list. The charter body is
// therefore injected as developer instructions, and the tool boundary is
// enforced by the Codex sandbox: charters without Edit/Write are read-only;
// mutating phases retain the existing autonomous pipeline's full authority.
const codexVendor = {
  name: 'codex',
  bin: process.env.CODEX_BIN || 'codex',
  // The CLI's ReasoningEffort enum (0.152.x); loadEngines checks the file against it.
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],

  buildArgs({ charter, developerInstructions, model, effort, schemaFile, outputFile, cwd }) {
    // Derive write authority from the charter itself. A new charter therefore
    // starts read-only unless it explicitly names Edit or Write.
    const sandbox = charter?.tools.some(tool => tool === 'Edit' || tool === 'Write')
      ? 'danger-full-access'
      : 'read-only'
    const args = [
      'exec', '--ephemeral', '--ignore-user-config', '--color', 'never',
      '--disable', 'multi_agent', '--disable', 'enable_fanout',
      '--sandbox', sandbox,
      '-c', 'approval_policy="never"',
      '-c', `developer_instructions=${JSON.stringify(developerInstructions)}`,
      '-C', cwd,
      '--model', model,
      '-c', `model_reasoning_effort="${effort}"`,
      '--output-last-message', outputFile,
    ]
    if (schemaFile) args.push('--output-schema', schemaFile)
    args.push('-')
    return args
  },

  async run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, onStart, label, step }) {
    const work = mkdtempSync(path.join(tmpdir(), 'toliki-codex-'))
    const outputFile = path.join(work, 'final.txt')
    const schemaFile = schema ? path.join(work, 'schema.json') : null
    try {
      if (schemaFile) writeFileSync(schemaFile, JSON.stringify(codexOutputSchema(schema)))
      const charter = agentType ? loadCharter(agentType) : null
      const projectInstructions = loadProjectInstructions(cwd)
      const developerInstructions = [charter?.body, projectInstructions].filter(Boolean).join('\n\n')
      const args = this.buildArgs({ charter, developerInstructions, model, effort, schemaFile, outputFile, cwd })
      const r = await execute({ bin: this.bin, args, prompt, cwd, timeoutMs, onStart, label, step })
      const stderrTail = String(r.stderr || '').trim().slice(-2000)
      const usage = codexUsage(r.stderr)

      if (r.spawnError) {
        const enoent = r.spawnError.code === 'ENOENT'
        return {
          ok: false, output: null, exitCode: null, timedOut: false, stderrTail,
          reason: enoent
            ? `'${this.bin}' not found on PATH — a cron-launched pane inherits the PATH set in etc/dispatch.cron, which must include the directory holding it`
            : `could not spawn '${this.bin}': ${r.spawnError.message}`,
        }
      }
      if (r.timedOut) {
        return { ok: false, output: null, exitCode: r.code, timedOut: true, stderrTail, reason: `timed out after ${Math.round(timeoutMs / 60000)} min (process group killed)`, usage }
      }
      if (r.code !== 0) {
        return { ok: false, output: null, exitCode: r.code, timedOut: false, stderrTail, reason: `exited ${r.code}${stderrTail ? `: ${stderrTail.split('\n').pop()}` : ''}`, usage }
      }

      let finalText
      try {
        finalText = readFileSync(outputFile, 'utf8')
      } catch (e) {
        return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: `final output file was not written: ${e.message}`, usage }
      }
      if (schema) {
        const structured = jsonFromText(finalText)
        if (!structured) {
          return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: 'final output was not the expected schema JSON', usage }
        }
        return { ok: true, output: stripCodexOptionalNulls(structured, schema), exitCode: 0, timedOut: false, stderrTail, reason: null, usage }
      }
      return { ok: true, output: finalText.trim(), exitCode: 0, timedOut: false, stderrTail, reason: null, usage }
    } catch (e) {
      return {
        ok: false, output: null, exitCode: null, timedOut: false, stderrTail: '',
        reason: `Codex adapter setup failed: ${e.message}`,
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
