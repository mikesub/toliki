// The engine adapter: the one place that knows how a coding-agent CLI is
// invoked. Every pipeline step is a short-lived process spawned through here,
// so the pipeline itself never names a vendor — swapping or mixing engines is
// a registry entry plus a per-stage `{engine, model}` tuple, not a rewrite.
//
// The contract every adapter implements:
//
//   run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, label })
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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
    child.stderr.on('data', (d) => { stderr += d })

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

const claudeEngine = {
  name: 'claude',
  bin: process.env.CLAUDE_BIN || 'claude',

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
    // No --model = the CLI's configured default. That is the port of the old
    // workflow's "stages not listed in the tier table inherit the session model".
    if (model) args.push('--model', model)
    if (effort) args.push('--effort', effort)
    if (schema) args.push('--json-schema', JSON.stringify(schema))
    return args
  },

  async run({ prompt, agentType, model, effort, schema, cwd, timeoutMs, onStart }) {
    const args = this.buildArgs({ agentType, model, effort, schema })
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

const ENGINES = { claude: claudeEngine }

export function resolveEngine(name = 'claude') {
  const engine = ENGINES[name]
  if (!engine) throw new Error(`unknown engine '${name}' (known: ${Object.keys(ENGINES).join(', ')})`)
  return engine
}
