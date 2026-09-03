// Process primitives for everything a run spawns: the agent CLIs (engine.mjs)
// and the deterministic half's git, gh and npm (github.mjs, repo.mjs).
//
// Children are spawned into their OWN PROCESS GROUP (detached). That is what
// makes a timeout able to kill the whole tree — `npm run verify` has a subtree
// of its own, and killing only the parent would orphan it. The cost is that a
// signal sent to the orchestrator's group does not reach them, which is why
// runtime.mjs forwards signals through terminateAll(). Every child, agent or
// not, is tracked in the same set so one forward covers the lot.

import { spawn } from 'node:child_process'

// Live children, so a signal to the orchestrator can take the tree with it.
const LIVE = new Set()

export function killGroup(pid, signal) {
  // Negative pid = the whole process group. ESRCH just means it already died.
  try { process.kill(-pid, signal) } catch { /* already gone */ }
}

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

// run(bin, args, { cwd, stdin, timeoutMs, env, onStart, stdoutCap })
//   -> { code, stdout, stderr, timedOut, spawnError }
// Never rejects: a process that could not be spawned, died, or timed out is a
// value the caller reads, so a fail-closed branch is never unwound past.
export function run(bin, args, { cwd = process.cwd(), stdin, timeoutMs = 5 * 60 * 1000, env = process.env, onStart, stdoutCap = 0 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env })
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

    // stdout is the payload (an agent's JSON envelope, a command's answer), so
    // it is kept whole unless the caller asks for a tail — a verify run can
    // print megabytes, and only its last lines are ever reported.
    child.stdout.on('data', (d) => { stdout += d; if (stdoutCap && stdout.length > stdoutCap) stdout = stdout.slice(-stdoutCap) })
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

    // Input goes on stdin rather than argv: requirement bodies and review
    // prompts run to tens of KB, and stdin has neither an ARG_MAX ceiling nor a
    // quoting story to get wrong.
    child.stdin.on('error', () => { /* child exited before reading; close() reports it */ })
    child.stdin.end(stdin === undefined ? '' : stdin)
  })
}

// The shape the deterministic half reads: trimmed output and one `ok`.
export async function sh(bin, args, opts) {
  const r = await run(bin, args, opts)
  const ok = !r.spawnError && !r.timedOut && r.code === 0
  return { ok, code: r.code, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), timedOut: r.timedOut, spawnError: r.spawnError }
}

// Why a command failed, in one line, for a blocker comment or a log line.
export function failureReason(r) {
  if (r.spawnError) return r.spawnError.code === 'ENOENT' ? 'not found on PATH' : String(r.spawnError.message || r.spawnError)
  if (r.timedOut) return 'timed out'
  const tail = (r.err || r.out || '').split('\n').filter(Boolean).slice(-3).join(' | ')
  return `exit ${r.code}${tail ? `: ${tail}` : ''}`
}

// Throws unless the command succeeded; returns its stdout. The message names
// the command, so a run's blocker comment says what broke, not just that
// something did.
export function must(r, what) {
  if (!r.ok) throw new Error(`${what} failed (${failureReason(r)})`)
  return r.out
}
