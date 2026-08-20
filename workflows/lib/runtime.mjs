// The orchestration primitives the pipelines are written against — the plain
// replacement for the harness-provided workflow engine. `agent`, `parallel`,
// `phase` and `log` keep the exact semantics the pipeline scripts rely on, so
// the pipelines themselves are engine- and harness-agnostic:
//
//   - agent() NEVER rejects. A step that died, timed out, or came back the
//     wrong shape resolves null, which is what every `if (!x) return fail(…)`
//     in the pipelines already reads. An exception here would unwind PAST
//     those fail-closed branches — the one failure mode this design cannot
//     have, since they are what stop a half-run from shipping.
//   - parallel() never rejects either: a thunk that throws lands as null in
//     its slot, and its siblings keep running.
//
// Signal forwarding is mandatory rather than tidy: engine children run in
// their own process groups (so a timeout can kill an `npm run verify` tree),
// which means the SIGHUP tmux sends when a session is killed reaches this
// process and NOT them. Without the forwarding below, `stop`-ing a session
// would leave orphaned agents writing into a worktree nobody is watching.
//
// The hole that remains: SIGKILL (or the OOM killer) takes this process with
// no chance to forward, orphaning whatever was in flight. It is bounded and
// decays safely — a claim ref with no session is what reap's second pass
// exists for, and a shipped-but-unpromoted run stays `ready-to-review`, which
// is the direction the merge gate is designed to fail in.

import os from 'node:os'
import { resolveEngine, terminateAll } from './engine.mjs'
import { validate } from './schema.mjs'

const DEFAULT_ENGINE = process.env.EPIC_ENGINE || 'claude'

// Matches the concurrency the workflow engine used to impose, now ours to
// hold: every agent spawn passes this gate, so no fan-out anywhere in a
// pipeline can oversubscribe the box regardless of how it was written.
const MAX_PARALLEL_AGENTS = Number(process.env.EPIC_MAX_PARALLEL_AGENTS) ||
  Math.min(16, Math.max(1, os.cpus().length - 2))

// Generous by design: code:green runs the project's whole verify gate, which
// can legitimately boot a database tier. A step this long is pathological,
// not slow.
const DEFAULT_TIMEOUT_MS = Number(process.env.EPIC_AGENT_TIMEOUT_MS) || 90 * 60 * 1000

let SCRIPT = 'run'
let SESSION = ''
let shuttingDown = false

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export function initRuntime({ scriptName, sessionName } = {}) {
  if (scriptName) SCRIPT = scriptName
  if (sessionName) SESSION = sessionName
  installSignalHandlers()
}

export function log(message) {
  process.stdout.write(`${ts()} [${SCRIPT}${SESSION ? ` ${SESSION}` : ''}] ${message}\n`)
}

export function phase(title) {
  process.stdout.write(`${ts()} [${SCRIPT}${SESSION ? ` ${SESSION}` : ''}] ── ${title} ──\n`)
}

function installSignalHandlers() {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]]) {
    process.on(signal, async () => {
      if (shuttingDown) process.exit(code) // a second signal means stop asking nicely
      shuttingDown = true
      log(`received ${signal} — terminating in-flight agents`)
      await terminateAll()
      process.exit(code)
    })
  }
}

// ───────────────────────── the semaphore ─────────────────────────
let inFlight = 0
const waiting = []

function acquire() {
  if (inFlight < MAX_PARALLEL_AGENTS) {
    inFlight++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else inFlight--
}

// ───────────────────────── agent ─────────────────────────
// One pipeline step = one engine process. opts:
//   label      short name for the log line (e.g. 'review:2')
//   phase      the phase it belongs to — logging only, kept for parity
//   agentType  charter from the shared agents/ registry ('coder' | 'architect' | 'reviewer')
//   model      engine model tier; omitted means the engine's configured default
//   effort     reasoning effort, when a stage wants it lowered
//   schema     JSON Schema; its presence is what makes the return value an object
//   engine     which adapter runs it (defaults to EPIC_ENGINE, today 'claude')
//   timeoutMs  per-step ceiling
export async function agent(prompt, opts = {}) {
  const { label = 'agent', agentType, model, effort, schema, engine: engineName, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  let engine
  try {
    engine = resolveEngine(engineName || DEFAULT_ENGINE)
  } catch (e) {
    log(`${label}: ${e.message}`)
    return null
  }

  const attempt = async (why) => {
    await acquire()
    const started = Date.now()
    try {
      return await engine.run({ prompt, agentType, model, effort, schema, cwd: process.cwd(), timeoutMs })
    } catch (e) {
      // An adapter is contracted not to throw; if one ever does, it must still
      // arrive at the call site as a null, not as an unwinding exception.
      return { ok: false, output: null, reason: `adapter threw: ${e && e.message || e}`, stderrTail: '' }
    } finally {
      release()
      const secs = Math.round((Date.now() - started) / 1000)
      log(`${label}${why ? ` (${why})` : ''}: ${secs}s`)
    }
  }

  let r = await attempt()
  if (!r.ok) {
    log(`${label}: FAILED — ${r.reason}`)
    return null
  }

  if (!schema) return r.output

  // Shape check. The engine already validated against the schema on its side
  // (and retried the model until it matched), so reaching here means either a
  // vocabulary the engine does not enforce or a payload that got past it. One
  // fresh respawn, then null: retrying twice would just spend a second failure.
  let errors = validateOrEmpty(schema, r.output)
  if (errors.length) {
    log(`${label}: structured output did not match the schema (${errors.slice(0, 3).join('; ')}) — respawning once`)
    r = await attempt('schema retry')
    if (!r.ok) {
      log(`${label}: FAILED on the schema retry — ${r.reason}`)
      return null
    }
    errors = validateOrEmpty(schema, r.output)
    if (errors.length) {
      log(`${label}: FAILED — structured output still off-schema (${errors.slice(0, 3).join('; ')})`)
      return null
    }
  }
  return r.output
}

function validateOrEmpty(schema, value) {
  // A broken validator must never fail a good step: fall open here, since the
  // engine's own schema enforcement is the primary gate and this is the belt.
  try {
    return validate(schema, value)
  } catch {
    return []
  }
}

// ───────────────────────── parallel ─────────────────────────
// Runs every thunk concurrently and waits for all of them. Bounding lives in
// the semaphore above, not here, so a 5-lens fan-out is written the same way
// whether the box can run 5 at once or 2.
export async function parallel(thunks) {
  return Promise.all(thunks.map(async (fn) => {
    try {
      return await fn()
    } catch (e) {
      log(`parallel: a task threw (${e && e.message || e}) — recorded as null`)
      return null
    }
  }))
}

export { MAX_PARALLEL_AGENTS, DEFAULT_TIMEOUT_MS }
