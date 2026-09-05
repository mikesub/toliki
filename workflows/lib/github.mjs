// The pipelines' GitHub transport: labels, comments, issue and PR reads and
// writes, all through `gh` and all deterministic. A model step never runs gh
// for the run's own bookkeeping — what an issue is labelled, what a blocker
// comment says and whether a PR was opened are facts this file establishes,
// not claims an agent reports.
//
// Reads throw on failure (a query that errored carries no verdict, so the
// caller's fail-closed branch takes over). Writes that are reporting rather
// than gating return their result and let the caller decide.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { sh, must } from './proc.mjs'

const GH_TIMEOUT_MS = 5 * 60 * 1000

// A terminal label write and everything a run does after it run inside reap's
// settle window: bin/reap.sh starts that clock at the write GitHub processes —
// which it can process while the client is still waiting for the response — and
// kills the session once the issue has been still for TERMINAL_SETTLE_MINUTES. A
// call left on the default timeout is exactly as long as the default window, so
// one stalled swap, readback or comment is enough for a sweep to kill a run
// before it says why it stopped. Those calls take a budget instead, and reap
// floors its window at MIN_TERMINAL_SETTLE_MINUTES so the two cannot be
// configured into a race. The env override exists so a test can inject a short
// budget; the default is the contract.
export const TERMINAL_REPORT_BUDGET_MS = Number(process.env.EPIC_TERMINAL_REPORT_MS) || 60 * 1000

// ONE window shared by the whole stretch, not a timeout per call: the clock does
// not restart between them, so N calls each bounded by the budget are N budgets.
// A budget hands out a SHARE per call — a quarter of the window, so a single
// stall cannot eat the whole thing and starve the report that carries the
// guidance — capped by what is LEFT of the window, so a path with more calls
// than that runs out of window rather than extending it. An exhausted window
// still runs its call, with a millisecond, so it fails fast and is reported
// rather than skipped in silence.
//
// One window per RUN, and this is the only way to open one: opening a second is
// how the invariant is lost. A landing swap that GitHub applied but the client
// could not verify falls through to the blocker path, which transitions the
// labels again and comments again — and a fresh budget there would hand that
// fallback a second reporting window reap never agreed to, while the settle
// clock has been running since the first write. So the call is idempotent: the
// first terminal write opens the window, every caller after it — in this
// process, in any module — gets what is LEFT of that same one.
let openWindow = null
export const terminalBudget = (budgetMs = TERMINAL_REPORT_BUDGET_MS) =>
  (openWindow ||= { deadline: Date.now() + budgetMs, share: Math.max(1, Math.round(budgetMs / 4)) })

const budgeted = ({ deadline, share }) => Math.max(1, Math.min(share, deadline - Date.now()))

// For callers that must not open the window themselves — everything a run does
// BEFORE its first terminal label has no clock running and keeps the default
// timeout, so this is empty until that write.
export const terminalSpend = () => (openWindow ? { budget: openWindow } : undefined)

// The same share, for work inside the window that is not a `gh` call. Local git
// cleanup on a blocker path is on git's own five-minute timeout, which is just
// as fatal to a report as a stalled gh call once the label is resting.
export const terminalTimeout = () => (openWindow ? { timeoutMs: budgeted(openWindow) } : {})

export const gh = (args, { budget, ...opts } = {}) =>
  sh('gh', args, { timeoutMs: budget ? budgeted(budget) : GH_TIMEOUT_MS, ...opts })

// ───────────────────────── bounded readbacks ─────────────────────────
// A readback verifies a write the run itself just made, and GitHub's own state
// lags its writes: a force-pushed head, a label edit and a fresh comment all
// take seconds to become visible to a read. One immediate read then reports a
// write that landed as a write that did not — toliki #13 and #16 both pushed a
// complete, verified repair and blocked on the PR head not having advanced yet.
//
// So a readback reads, and on a MISMATCH waits and reads again, over a window
// well under a minute, stopping at the first read that matches. Retries change
// timing, never verdicts: a readback that never matches still fails, with the
// wording it always had. A read that ERRORS is not retried — a query that
// errored carries no verdict, so it propagates to the caller's fail-closed
// branch exactly as before.
//
// The waits are charged to the surrounding step's budget when it has one (the
// terminal window), so a readback after a terminal label write still finishes
// inside the reporting budget and never extends reap's settle window. The
// interval is overridable so a test can set it to milliseconds; the defaults
// are the contract.
export const READBACK_INTERVAL_MS = Number(process.env.EPIC_READBACK_INTERVAL_MS) || 5 * 1000
export const READBACK_READS = Number(process.env.EPIC_READBACK_READS) || 6

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// How long a readback waited, for the note a refusal writes.
export const waitedFor = ms => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)

// readBack(read, matches, { reads, intervalMs, budget })
//   -> { matched, observed, reads, waitedMs }
// `observed` is the LAST observation either way, so a caller can name what it
// saw. The first read is immediate: a match costs one call and no delay.
export async function readBack(read, matches, { reads = READBACK_READS, intervalMs = READBACK_INTERVAL_MS, budget } = {}) {
  const started = Date.now()
  // The whole readback — its waits included — spends one step's share of the
  // window, and the window's own deadline still caps every read underneath it.
  const waitCap = budget ? budgeted(budget) : Infinity
  let observed
  let n = 0
  while (true) {
    observed = await read()
    n++
    if (matches(observed)) return { matched: true, observed, reads: n, waitedMs: Date.now() - started }
    if (n >= reads) break
    const wait = Math.min(intervalMs, waitCap - (Date.now() - started), budget ? budget.deadline - Date.now() : Infinity)
    if (!(wait > 0)) break
    await sleep(wait)
  }
  return { matched: false, observed, reads: n, waitedMs: Date.now() - started }
}

export async function ghJson(args, what, opts) {
  const out = must(await gh(args, opts), what)
  try {
    return JSON.parse(out)
  } catch {
    throw new Error(`${what} printed no JSON (${out.slice(0, 200)})`)
  }
}

// The lifecycle labels the pipelines write, in one place so every run creates
// the same label with the same colour and description. `ready` is /spec's to
// apply, and here too because ship queues the follow-ups it files: a repo whose
// first epic files one may never have been touched by /spec, so the label has
// to be creatable from this side as well.
export const LABELS = {
  ready:             { color: '1D76DB', description: 'Spec complete; queued for the epic-run pipeline' },
  'in-progress':     { color: 'FBCA04', description: 'Actively being worked by epic-run' },
  'ready-to-merge':  { color: '0E8A16', description: 'epic-run finished; PR open and gates cleared — queued for bin/merge-worker.sh' },
  'ready-to-review': { color: '0E8A16', description: 'epic-run finished; PR is open and awaiting review' },
  failed:            { color: 'B60205', description: 'epic-run stopped at a blocker; needs human attention' },
  'needs-judgment':  { color: 'D93F0B', description: 'rebase conflict needs judgment — queued for an automated fixer session' },
  'fix-attempted':   { color: 'FEF2C0', description: 'a fixer session has attempted this conflict once' },
  'fix-retried':     { color: 'F9D0C4', description: 'the fixer retry is spent — the next failure waits for a human' },
  'needs-ci-fix':    { color: 'D93F0B', description: 'checks were red on the rebased head — queued for an automated CI fixer session' },
  'ci-attempted':    { color: 'FEF2C0', description: 'a CI fixer session has attempted this red check once' },
  'ci-retried':      { color: 'F9D0C4', description: 'the CI fixer retry is spent — the next failure waits for a human' },
  'needs-defect-fix': { color: 'D93F0B', description: 'ship gate held on concrete defects — queued for an automated defect fixer session' },
  'defect-attempted': { color: 'FEF2C0', description: 'a defect fixer session has attempted this ship-gate repair once' },
  'defect-retried':   { color: 'F9D0C4', description: 'the defect fixer retry is spent — the next failure waits for a human' },
}

// The three labels a run can come to REST at, and they are mutually exclusive:
// bin/merge-worker.sh selects on `ready-to-merge` alone, so a run that comes to
// rest at `failed` while a landing label it already applied is still on the
// issue is a failure path that becomes success. That is the whole hazard, and it
// is one a hand-written remove list loses the moment a landing swap half-lands:
// the fallback adds `failed`, strips `in-progress`, and leaves `ready-to-merge`
// exactly where the merge worker looks.
export const RESTING_LABELS = ['failed', 'ready-to-merge', 'ready-to-review']

// So a terminal transition is written as the ONE label the run rests at plus the
// queue labels that belong beside it, and the removes are DERIVED: every other
// resting label, and `in-progress`. `queue` is a retry ladder's queue label,
// restored because a landing swap may have stripped it on its way out; `drop` is
// a queue label a final refusal takes off on purpose.
export const terminalTransition = ({ rest, queue = [], drop = [] }) => ({
  add: [rest, ...queue],
  remove: ['in-progress', ...RESTING_LABELS.filter(l => l !== rest), ...drop],
})

// Idempotent and best-effort: `gh label create` fails when the label exists,
// which is the common case and not an error.
export async function ensureLabels(names, opts) {
  for (const name of names) {
    const def = LABELS[name]
    if (!def) throw new Error(`ensureLabels: '${name}' is not a pipeline label`)
    await gh(['label', 'create', name, '--color', def.color, '--description', def.description], opts)
  }
}

// ONE `gh issue edit` for a whole swap, never an add call plus a separate strip
// call: two calls allow a lossy half-success (the add lands, the strip fails)
// that leaves `ready` beside a terminal label, where dispatch re-picks the
// issue every tick.
export async function editLabels(issue, { add = [], remove = [] } = {}, opts) {
  const args = ['issue', 'edit', String(issue)]
  for (const l of add) args.push('--add-label', l)
  for (const l of remove) args.push('--remove-label', l)
  return gh(args, opts)
}

export async function issueLabels(issue, opts) {
  const v = await ghJson(['issue', 'view', String(issue), '--json', 'labels'], `gh issue view ${issue} --json labels`, opts)
  return Array.isArray(v.labels) ? v.labels.map(l => l.name) : []
}

export async function issueView(issue, fields, opts) {
  return ghJson(['issue', 'view', String(issue), '--json', fields], `gh issue view ${issue}`, opts)
}

export async function authenticatedLogin(opts) {
  const value = await ghJson(['api', 'user'], 'gh api user', opts)
  const login = String(value?.login || '').trim()
  if (!login) throw new Error('gh api user returned no authenticated login')
  return login
}

// Open blockers of an issue. Never throws: the preflight is advisory when the
// dependency API itself errors, exactly as it was when a model ran it.
export async function openBlockers(issue) {
  const r = await gh(['api', `repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by`])
  if (!r.ok) return { blockers: [], error: r.err || r.out || `exit ${r.code}` }
  try {
    const list = JSON.parse(r.out)
    return { blockers: (Array.isArray(list) ? list : []).filter(i => i && i.state === 'open').map(i => i.number) }
  } catch {
    return { blockers: [], error: 'unparseable dependency list' }
  }
}

// Body text goes through a file: comment bodies carry markdown, backticks and
// multi-line blocks, and a file has no quoting story to get wrong.
export async function withBodyFile(body, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toliki-body-'))
  const file = path.join(dir, 'body.md')
  writeFileSync(file, body)
  try {
    return await fn(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function comment(issue, body, opts) {
  return withBodyFile(body, async (file) =>
    must(await gh(['issue', 'comment', String(issue), '--body-file', file], opts), `gh issue comment ${issue}`))
}

// Whether a run already posted the deferred record on this issue. Read-only and
// best effort: a query that fails answers "no", because failing to record the
// deferrals at all is worse than recording them twice.
export async function hasDeferredRecord(issue) {
  const r = await gh(['issue', 'view', String(issue), '--json', 'comments'])
  if (!r.ok) return false
  try {
    const v = JSON.parse(r.out)
    return (v.comments || []).some(c => String(c.body || '').startsWith('🤖 deferred / not done'))
  } catch {
    return false
  }
}

export async function assignSelf(issue) {
  return gh(['issue', 'edit', String(issue), '--add-assignee', '@me'])
}

export async function openPrs(fields = 'number,url,headRefName,headRefOid') {
  const v = await ghJson(['pr', 'list', '--state', 'open', '--json', fields], 'gh pr list')
  return Array.isArray(v) ? v : []
}

export async function prView(pr, fields = 'number,url,headRefName,headRefOid') {
  return ghJson(['pr', 'view', String(pr), '--json', fields], `gh pr view ${pr}`)
}

export async function repositoryView(fields = 'nameWithOwner') {
  return ghJson(['repo', 'view', '--json', fields], 'gh repo view')
}

export async function searchOpenPrs(query, fields = 'number,title') {
  const v = await ghJson(['pr', 'list', '--state', 'open', '--search', query, '--json', fields], 'gh pr list --search')
  return Array.isArray(v) ? v : []
}

const urlIn = (out, what) => {
  const m = String(out).match(/https?:\/\/\S+/)
  if (!m) throw new Error(`${what} printed no URL (${String(out).slice(0, 200)})`)
  return m[0]
}

export async function prCreate({ head, title, bodyFile }) {
  const out = must(await gh(['pr', 'create', '--head', head, '--title', title, '--body-file', bodyFile]), 'gh pr create')
  return urlIn(out, 'gh pr create')
}

export async function issueCreate({ title, body }) {
  return withBodyFile(body, async (file) =>
    urlIn(must(await gh(['issue', 'create', '--title', title, '--body-file', file]), 'gh issue create'), 'gh issue create'))
}

// The issue's database id, which the dependency API takes instead of its
// number. Null when it cannot be read, so a caller degrades rather than throws.
export async function issueId(issue) {
  const r = await gh(['api', `repos/{owner}/{repo}/issues/${issue}`, '--jq', '.id'])
  if (!r.ok) return null
  const id = Number(String(r.out).trim())
  return Number.isInteger(id) && id > 0 ? id : null
}

// Record that `issue` is blocked by `blockerId` (a database id from issueId).
// Best effort and never throws: the dependency is ordering, and a run that
// already opened its PR must not fail on a link it could not draw. `-F` sends
// a typed integer — `-f` would send a string and the API rejects it 422.
export async function addBlockedBy(issue, blockerId) {
  if (!blockerId) return { ok: false, err: 'no blocker id' }
  return gh(['api', '--method', 'POST', `repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by`, '-F', `issue_id=${blockerId}`])
}
