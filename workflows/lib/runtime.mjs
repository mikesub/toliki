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
import { resolveEngine, resolveVendor, STEPS, terminateAll, isTransient } from './engine.mjs'
import { validate } from './schema.mjs'

// The run's engine: a name in etc/engines.json, chosen by --engine (dispatch
// passes the issue's label) or EPIC_ENGINE, claude when neither is set. Every
// agent() call reads its vendor, model and effort from that one table.
let ENGINE_NAME = process.env.EPIC_ENGINE || 'claude'
let ENGINE = null

// Matches the concurrency the workflow engine used to impose, now ours to
// hold: every agent spawn passes this gate, so no fan-out anywhere in a
// pipeline can oversubscribe the box regardless of how it was written.
const MAX_PARALLEL_AGENTS = Number(process.env.EPIC_MAX_PARALLEL_AGENTS) ||
  Math.min(16, Math.max(1, os.cpus().length - 2))

// Generous by design: code:green runs the project's whole verify gate, which
// can legitimately boot a database tier. A step this long is pathological,
// not slow.
const DEFAULT_TIMEOUT_MS = Number(process.env.EPIC_AGENT_TIMEOUT_MS) || 90 * 60 * 1000

// A step that died this quickly with no payload never got to work: an auth or
// rate error, a crash at startup, a dropped connection. The one respawn below
// covers those; a step that failed after minutes of work is usually the model
// failing, and a timeout is never retried — a ninety-minute verify must not
// double.
const FAST_DEATH_MS = Number(process.env.EPIC_FAST_DEATH_MS) || 60 * 1000

let SCRIPT = 'run'
let SESSION = ''
let shuttingDown = false

const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export function initRuntime({ scriptName, sessionName, defaultEngine } = {}) {
  if (scriptName) SCRIPT = scriptName
  if (sessionName) SESSION = sessionName
  if (defaultEngine) ENGINE_NAME = defaultEngine
  // Resolve — and so validate the whole engines file — before status hooks or
  // the first phase can touch GitHub. Letting a bad table degrade to a null
  // first step would also leave the blocker reporter on that same table,
  // stranding the issue without a label.
  ENGINE = resolveEngine(ENGINE_NAME)
  installSignalHandlers()
}

// Observers of the run's own narration. The pane is the primary record; a hook
// lets the issue's status comment mirror it without every call site having to
// report twice, and without this module knowing what GitHub is. A throwing hook
// must never take the run with it — reporting is not a gate.
let phaseHook = null
let logHook = null
export function onPhase(fn) { phaseHook = fn }
export function onLog(fn) { logHook = fn }
const fire = (fn, arg) => { if (fn) { try { fn(arg) } catch { /* reporting never fails a run */ } } }

export function log(message) {
  process.stdout.write(`${ts()} [${SCRIPT}${SESSION ? ` ${SESSION}` : ''}] ${message}\n`)
  fire(logHook, message)
}

export function phase(title) {
  process.stdout.write(`${ts()} [${SCRIPT}${SESSION ? ` ${SESSION}` : ''}] ── ${title} ──\n`)
  fire(phaseHook, title)
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
// One pipeline step = one vendor process. opts:
//   label      short name for the log line (e.g. 'review:2')
//   phase      the phase it belongs to — logging only, kept for parity
//   step       which row of the run's engine this is (a key of STEPS): picks
//              the vendor, model and effort, and fixes the tool boundary
//   schema     JSON Schema; its presence is what makes the return value an object
//   timeoutMs  per-step ceiling
export async function agent(prompt, opts = {}) {
  const { label = 'agent', step, schema, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  const agentType = STEPS[step]
  if (!ENGINE || !agentType) {
    log(`${label}: ${!ENGINE ? 'initRuntime() has not selected an engine' : `unknown step '${step}' (known: ${Object.keys(STEPS).join(', ')})`}`)
    return null
  }
  const { vendor: vendorName, model, effort } = ENGINE[step]
  let vendor
  try {
    vendor = resolveVendor(vendorName)
  } catch (e) {
    log(`${label}: ${e.message}`)
    return null
  }

  const attempt = async (why) => {
    await acquire()
    const started = Date.now()
    try {
      const r = await vendor.run({ prompt, agentType, model, effort, schema, cwd: process.cwd(), timeoutMs })
      return { ...r, elapsedMs: Date.now() - started }
    } catch (e) {
      // An adapter is contracted not to throw; if one ever does, it must still
      // arrive at the call site as a null, not as an unwinding exception.
      return { ok: false, output: null, reason: `adapter threw: ${e && e.message || e}`, stderrTail: '', elapsedMs: Date.now() - started }
    } finally {
      release()
      const secs = Math.round((Date.now() - started) / 1000)
      // Name what ran it: engines can mix vendors per step, so the pane is the
      // record of which model produced which artifact.
      log(`${label}${why ? ` (${why})` : ''}: ${secs}s [${vendorName} ${model}/${effort}]`)
    }
  }

  // One respawn for a transient death, then null. The adapter says what it can
  // (a rate limit, a 5xx, a dropped connection); when it cannot tell, a death
  // faster than FAST_DEATH_MS counts. Timeouts and a run that is shutting down
  // are never retried. Every call site keeps its fail-closed branch: a step
  // that dies twice is a dead step.
  const retryable = (r) => {
    if (shuttingDown || r.timedOut) return false
    const verdict = isTransient(r)
    return verdict === true || (verdict === undefined && r.elapsedMs < FAST_DEATH_MS)
  }

  let r = await attempt()
  if (!r.ok && retryable(r)) {
    log(`${label}: ${r.reason} — respawning once (transient)`)
    r = await attempt('transient retry')
  }
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
