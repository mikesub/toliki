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

export const gh = (args, opts = {}) => sh('gh', args, { timeoutMs: GH_TIMEOUT_MS, ...opts })

export async function ghJson(args, what) {
  const out = must(await gh(args), what)
  try {
    return JSON.parse(out)
  } catch {
    throw new Error(`${what} printed no JSON (${out.slice(0, 200)})`)
  }
}

// The lifecycle labels the pipelines write, in one place so every run creates
// the same label with the same colour and description. `ready` is /spec's.
export const LABELS = {
  'in-progress':     { color: 'FBCA04', description: 'Actively being worked by epic-run' },
  'ready-to-merge':  { color: '0E8A16', description: 'epic-run finished; PR open and gates cleared — queued for bin/merge-worker.sh' },
  'ready-to-review': { color: '0E8A16', description: 'epic-run finished; PR is open and awaiting review' },
  failed:            { color: 'B60205', description: 'epic-run stopped at a blocker; needs human attention' },
  'fix-attempted':   { color: 'FEF2C0', description: 'a fixer session has attempted this conflict once' },
  'fix-retried':     { color: 'F9D0C4', description: 'the fixer retry is spent — the next failure waits for a human' },
  'needs-ci-fix':    { color: 'D93F0B', description: 'checks were red on the rebased head — queued for an automated CI fixer session' },
  'ci-attempted':    { color: 'FEF2C0', description: 'a CI fixer session has attempted this red check once' },
  'ci-retried':      { color: 'F9D0C4', description: 'the CI fixer retry is spent — the next failure waits for a human' },
}

// Idempotent and best-effort: `gh label create` fails when the label exists,
// which is the common case and not an error.
export async function ensureLabels(names) {
  for (const name of names) {
    const def = LABELS[name]
    if (!def) throw new Error(`ensureLabels: '${name}' is not a pipeline label`)
    await gh(['label', 'create', name, '--color', def.color, '--description', def.description])
  }
}

// ONE `gh issue edit` for a whole swap, never an add call plus a separate strip
// call: two calls allow a lossy half-success (the add lands, the strip fails)
// that leaves `ready` beside a terminal label, where dispatch re-picks the
// issue every tick.
export async function editLabels(issue, { add = [], remove = [] } = {}) {
  const args = ['issue', 'edit', String(issue)]
  for (const l of add) args.push('--add-label', l)
  for (const l of remove) args.push('--remove-label', l)
  return gh(args)
}

export async function issueLabels(issue) {
  const v = await ghJson(['issue', 'view', String(issue), '--json', 'labels'], `gh issue view ${issue} --json labels`)
  return Array.isArray(v.labels) ? v.labels.map(l => l.name) : []
}

export async function issueView(issue, fields) {
  return ghJson(['issue', 'view', String(issue), '--json', fields], `gh issue view ${issue}`)
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

export async function comment(issue, body) {
  return withBodyFile(body, async (file) =>
    must(await gh(['issue', 'comment', String(issue), '--body-file', file]), `gh issue comment ${issue}`))
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
