// The engine adapter: the one place that knows how a coding-agent CLI is
// invoked. Every pipeline step is a short-lived process spawned through here,
// so the pipeline itself never names a vendor — swapping or mixing engines is
// a registry entry plus a per-stage `{engine, tier}` tuple, not a rewrite.
//
// The contract every adapter implements:
//
//   run({ prompt, agentType, tier, effort, schema, cwd, timeoutMs, label })
//     -> { ok, output, exitCode, timedOut, reason, stderrTail }
//
//   ok === true  ⇔  the process exited 0 AND a payload was extracted
//                   (the validated object when a schema was asked for, else text)
//   It NEVER throws and NEVER rejects: a step that failed is a value the
//   pipeline's own fail-closed branches read, not an exception that unwinds
//   past them.
//
// Children are spawned into their OWN PROCESS GROUP (detached). That is what
// makes a timeout able to kill the whole tree — an agent running `npm run
// verify` has a subtree of its own, and killing only the CLI would orphan it.
// The cost is that a signal sent to this orchestrator's group does not reach
// them, which is why runtime.mjs forwards signals through terminateAll().

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const HARNESS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// Live children, so a signal to the orchestrator can take the tree with it.
const LIVE = new Set()

// SIGTERM every live child's process group, then SIGKILL what is still up
// after the grace. Used both by the timeout path and by signal forwarding.
export function terminateAll(graceMs = 5000) {
  const groups = [...LIVE]
  for (const pid of groups) killGroup(pid, 'SIGTERM')
  if (!groups.length) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const pid of groups) if (LIVE.has(pid)) killGroup(pid, 'SIGKILL')
      resolve()
    }, graceMs).unref?.()
  })
}

function killGroup(pid, signal) {
  // Negative pid = the whole process group. ESRCH just means it already died.
  try { process.kill(-pid, signal) } catch { /* already gone */ }
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
function execute({ bin, args, prompt, cwd, timeoutMs, onStart }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
    } catch (e) {
      resolve({ spawnError: e, stdout: '', stderr: String(e && e.message || e), code: null, timedOut: false })
      return
    }

    LIVE.add(child.pid)
    onStart?.(child.pid)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child.pid, 'SIGTERM')
      setTimeout(() => { if (LIVE.has(child.pid)) killGroup(child.pid, 'SIGKILL') }, 10_000).unref?.()
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d })
    // Progress streams can be very chatty on a long run. Only the tail is ever
    // reported, so bound it here rather than retaining hours of diagnostics.
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-64 * 1024) })

    const finish = (code, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      LIVE.delete(child.pid)
      resolve({ spawnError, stdout, stderr, code, timedOut })
    }

    child.on('error', (e) => finish(null, e))
    child.on('close', (code) => finish(code, undefined))

    // The prompt goes on stdin rather than argv: requirement bodies and review
    // prompts run to tens of KB, and stdin has neither an ARG_MAX ceiling nor a
    // quoting story to get wrong.
    child.stdin.on('error', () => { /* child exited before reading; close() reports it */ })
    child.stdin.end(prompt)
  })
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

const CLAUDE_TIERS = {
  default: { model: 'opus', effort: 'xhigh' },
  mechanical: { model: 'sonnet', effort: 'xhigh' },
  design: { model: 'fable', effort: 'xhigh' },
  adjudicate: { model: 'fable', effort: 'xhigh' },
}

// Every tier runs the strongest catalog model at high effort until an eval says
// a cheaper tier is safe (decided 2026-09-02). The IDs were verified against the
// authenticated Codex catalog on the host. Environment overrides let an operator
// move a tier after a deliberate eval without teaching the engine-neutral
// pipelines model names.
const CODEX_TIERS = {
  default: {
    model: process.env.CODEX_MODEL_DEFAULT || 'gpt-5.6-sol',
    effort: process.env.CODEX_EFFORT_DEFAULT || 'high',
  },
  mechanical: {
    model: process.env.CODEX_MODEL_MECHANICAL || 'gpt-5.6-sol',
    effort: process.env.CODEX_EFFORT_MECHANICAL || 'high',
  },
  design: {
    model: process.env.CODEX_MODEL_DESIGN || 'gpt-5.6-sol',
    effort: process.env.CODEX_EFFORT_DESIGN || 'high',
  },
  adjudicate: {
    model: process.env.CODEX_MODEL_ADJUDICATE || 'gpt-5.6-sol',
    effort: process.env.CODEX_EFFORT_ADJUDICATE || 'high',
  },
}

function resolveTier(engineName, table, tier, effort) {
  const key = tier || 'default'
  const selected = table[key]
  if (!selected) {
    throw new Error(`unknown ${engineName} tier '${key}' (known: ${Object.keys(table).join(', ')})`)
  }
  return { ...selected, effort: effort || selected.effort }
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

// Claude Code loads a target repo's CLAUDE.md and .claude/rules itself. Codex
// discovers AGENTS.md instead, so relying on its native discovery would give
// the two engines different project constitutions. Read the existing Claude
// contract explicitly for Codex; missing/unreadable instructions fail closed.
function loadProjectInstructions(cwd) {
  const constitution = path.join(cwd, 'CLAUDE.md')
  let body
  try {
    body = readFileSync(constitution, 'utf8').trim()
  } catch (e) {
    throw new Error(`Codex project constitution could not be read at ${constitution}: ${e.message}`)
  }
  if (!body) throw new Error(`Codex project constitution is empty at ${constitution}`)

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
    `<project-constitution source="CLAUDE.md">\n${body}\n</project-constitution>`,
    ...rules.map(rule => `<project-rule source="${rule.file}">\n${rule.body}\n</project-rule>`),
  ].join('\n\n')
}

const claudeEngine = {
  name: 'claude',
  bin: process.env.CLAUDE_BIN || 'claude',

  buildArgs({ agentType, tier, effort, schema }) {
    const selected = resolveTier(this.name, CLAUDE_TIERS, tier, effort)
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
    // Every tier names a model and an effort explicitly: the default tier is no
    // longer "whatever the CLI would pick", so two engines can be compared fairly.
    if (selected.model) args.push('--model', selected.model)
    if (selected.effort) args.push('--effort', selected.effort)
    if (schema) args.push('--json-schema', JSON.stringify(schema))
    return args
  },

  async run({ prompt, agentType, tier, effort, schema, cwd, timeoutMs, onStart }) {
    const args = this.buildArgs({ agentType, tier, effort, schema })
    const r = await execute({ bin: this.bin, args, prompt, cwd, timeoutMs, onStart })
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
    if (envelope.is_error) {
      const detail = Array.isArray(envelope.errors) && envelope.errors.length
        ? envelope.errors.join('; ')
        : String(envelope.result || envelope.subtype || 'unknown error')
      return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: `${envelope.subtype || 'error'}: ${detail}` }
    }

    if (schema) {
      const structured = envelope.structured_output ?? jsonFromText(envelope.result)
      if (!structured || typeof structured !== 'object') {
        return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: 'no structured output in a schema-carrying result' }
      }
      return { ok: true, output: structured, exitCode: 0, timedOut: false, stderrTail, reason: null }
    }

    return { ok: true, output: String(envelope.result ?? ''), exitCode: 0, timedOut: false, stderrTail, reason: null }
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
const codexEngine = {
  name: 'codex',
  bin: process.env.CODEX_BIN || 'codex',

  buildArgs({ charter, developerInstructions, tier, effort, schemaFile, outputFile, cwd }) {
    const selected = resolveTier(this.name, CODEX_TIERS, tier, effort)
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
      '--model', selected.model,
      '-c', `model_reasoning_effort="${selected.effort}"`,
      '--output-last-message', outputFile,
    ]
    if (schemaFile) args.push('--output-schema', schemaFile)
    args.push('-')
    return args
  },

  async run({ prompt, agentType, tier, effort, schema, cwd, timeoutMs, onStart }) {
    const work = mkdtempSync(path.join(tmpdir(), 'toliki-codex-'))
    const outputFile = path.join(work, 'final.txt')
    const schemaFile = schema ? path.join(work, 'schema.json') : null
    try {
      if (schemaFile) writeFileSync(schemaFile, JSON.stringify(codexOutputSchema(schema)))
      const charter = agentType ? loadCharter(agentType) : null
      const projectInstructions = loadProjectInstructions(cwd)
      const developerInstructions = [charter?.body, projectInstructions].filter(Boolean).join('\n\n')
      const args = this.buildArgs({ charter, developerInstructions, tier, effort, schemaFile, outputFile, cwd })
      const r = await execute({ bin: this.bin, args, prompt, cwd, timeoutMs, onStart })
      const stderrTail = String(r.stderr || '').trim().slice(-2000)

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
        return { ok: false, output: null, exitCode: r.code, timedOut: true, stderrTail, reason: `timed out after ${Math.round(timeoutMs / 60000)} min (process group killed)` }
      }
      if (r.code !== 0) {
        return { ok: false, output: null, exitCode: r.code, timedOut: false, stderrTail, reason: `exited ${r.code}${stderrTail ? `: ${stderrTail.split('\n').pop()}` : ''}` }
      }

      let finalText
      try {
        finalText = readFileSync(outputFile, 'utf8')
      } catch (e) {
        return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: `final output file was not written: ${e.message}` }
      }
      if (schema) {
        const structured = jsonFromText(finalText)
        if (!structured) {
          return { ok: false, output: null, exitCode: 0, timedOut: false, stderrTail, reason: 'final output was not the expected schema JSON' }
        }
        return { ok: true, output: stripCodexOptionalNulls(structured, schema), exitCode: 0, timedOut: false, stderrTail, reason: null }
      }
      return { ok: true, output: finalText.trim(), exitCode: 0, timedOut: false, stderrTail, reason: null }
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

const ENGINES = { claude: claudeEngine, codex: codexEngine }

export function engineNames() {
  return Object.keys(ENGINES)
}

export function resolveEngine(name = 'claude') {
  const engine = ENGINES[name]
  if (!engine) throw new Error(`unknown engine '${name}' (known: ${engineNames().join(', ')})`)
  return engine
}
