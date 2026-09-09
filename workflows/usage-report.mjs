#!/usr/bin/env node
// Two read-only views over the usage log lib/usage.mjs writes. Runs wherever
// the log is (the host, via `./remote-control.sh usage`, or a laptop that ran
// a pipeline itself), reads that one file and nothing else — no GitHub, no
// network.
//
// Usage: usage-report.mjs [--log <file>] [--since <N>d] [--engine <name>] [--script epic-run|task-run|fix-run|ci-run|defect-run]
//
// 1. The per-step tuning view: which steps of an average run cost what, so
//    etc/engines.json can be tuned from data. "tokens" is everything the model
//    processed (input + output + cache reads + cache writes); "out" is output
//    tokens alone. Percentages are a step's share of the tokens of all runs of
//    that script, which equals its share of the average run. Its time column is
//    model-active — summed spawn duration — because two steps running in
//    parallel spend two minutes of it per minute of the run. Its --since,
//    --engine and --script filters select individual records.
//
// 2. The issue-lifetime view: every recorded epic, conflict-fixer, CI-fixer and
//    defect-fixer invocation for one (repository, issue) pair, across runIds and
//    engines. Log-known by construction — rotation, deletion or a failed append
//    make it partial, and it says so rather than claiming a completeness it
//    cannot prove. Its --since selects a LIFETIME by its latest activity and
//    then totals every retained record of it, so a recent fixer does not
//    truncate the epic it repairs; --engine and --script select a lifetime by
//    its latest completed run and likewise keep its whole totals.
//
// A row's `result` is what the pipeline recorded about itself at the end of the
// invocation — not whether a PR later merged, an issue later closed or a human
// later changed a label. Nothing here re-derives it from prose or result shape.
//
// Spawns the CLI reported no usage for count as zero and are listed, so a gap in
// the data never passes as a cheap step; a model with no row in lib/prices.mjs
// is named as missing money rather than as free.

import { readFileSync } from 'node:fs'
import { OUTCOMES, USAGE_LOG } from './lib/usage.mjs'
import { humanTimestamp } from './lib/time.mjs'

const SCRIPTS = ['epic-run', 'task-run', 'fix-run', 'ci-run', 'defect-run']
const FIXER_SCRIPTS = ['fix-run', 'ci-run', 'defect-run']
const USAGE = `Usage: usage-report.mjs [--log <file>] [--since <N>d] [--engine <name>] [--script ${SCRIPTS.join('|')}]`

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback }
if (args.includes('-h') || args.includes('--help')) {
  console.log(USAGE)
  process.exit(0)
}
const file = opt('--log', USAGE_LOG)
const since = opt('--since', null)
const engineFilter = opt('--engine', null)
const scriptFilter = opt('--script', null)

let raw
try {
  raw = readFileSync(file, 'utf8')
} catch (e) {
  console.error(`usage-report: cannot read ${file}: ${e.message}`)
  process.exit(1)
}
let cutoff = 0
if (since) {
  const m = String(since).match(/^(\d+)([dh])?$/)
  if (!m) { console.error(`usage-report: --since wants <N>d or <N>h, got '${since}'`); process.exit(1) }
  cutoff = Date.now() - Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3)
}

// ───────────────────────── parsing ─────────────────────────
// One pass, every line classified. A JSON-invalid FINAL line is the one thing
// dropped in silence: an appender can be caught mid-write, and that half-line is
// not lost history. Everything else that does not parse — or that carries a type
// this version does not know — is counted and reported, because silently
// omitting historical records is how a report starts lying about its totals.
// A row with no `type` predates lifecycle records and is read as a spawn.
const spawns = []
const starts = []
const finishes = []
let malformed = 0
const lines = raw.split('\n')
let finalLine = -1
for (let i = lines.length - 1; i >= 0; i--) { if (lines[i].trim()) { finalLine = i; break } }
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].trim()) continue
  let record
  try {
    record = JSON.parse(lines[i])
  } catch {
    // Only an unterminated final fragment can be an append observed halfway
    // through. A newline-terminated bad row is complete historical damage and
    // must be disclosed even when it is the last non-empty line.
    if (i !== finalLine || raw.endsWith('\n')) malformed++
    continue
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) { malformed++; continue }
  // Internal provenance for records that do not carry a runId. Those rows
  // cannot be paired safely, so their physical line is their unique report key.
  record = { ...record, _line: i + 1 }
  if (record.type === undefined) spawns.push({ ...record, type: 'spawn', legacy: true })
  else if (record.type === 'spawn') spawns.push(record)
  else if (record.type === 'run-start') starts.push(record)
  else if (record.type === 'run-finish') finishes.push(record)
  else malformed++
}
const records = [...spawns, ...starts, ...finishes]
// Said for an empty log and again once the filters have run: a window, engine
// or script that selects nothing prints no tuning table, no lifetime header and
// no totals, and silence at the end of an ssh reads as a broken connection
// rather than as a quiet week.
const nothingSelected = () => {
  console.log(`no usage records in ${file}${since ? ` since ${since}` : ''}${engineFilter ? ` for engine ${engineFilter}` : ''}${scriptFilter ? ` for script ${scriptFilter}` : ''}`)
  if (malformed) console.log(`malformed records skipped: ${malformed}`)
  process.exit(0)
}
if (!records.length) nothingSelected()

// ───────────────────────── formatting ─────────────────────────
const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n)) ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
const pad = (s, w, left = false) => { s = String(s); return left ? s.padEnd(w) : s.padStart(w) }
const money = n => `$${Number(n || 0).toFixed(2)}`

// Durations a human reads at a glance, never rounded into a lie: a run of forty
// seconds is `<1m`, not `0m`.
function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  if (ms < 60000) return '<1m'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const at = record => { const t = Date.parse(record?.ts); return Number.isFinite(t) ? t : null }
// humanTimestamp() shells out to `date` in HOST_TIMEZONE; the same instant
// appears on many rows, so each one is rendered once.
const stamps = new Map()
const stamp = millis => {
  if (!stamps.has(millis)) stamps.set(millis, humanTimestamp(millis))
  return stamps.get(millis)
}

// ───────────────────────── the per-step tuning view ─────────────────────────
// Record-level filtering, unchanged: this view answers "what does a step of this
// script cost", so a window that cuts a run in half is exactly what it wants.
const tuned = spawns.filter(r => {
  const t = at(r)
  if (cutoff && (t === null || t < cutoff)) return false
  if (engineFilter && r.engine !== engineFilter) return false
  if (scriptFilter && r.script !== scriptFilter) return false
  return true
})

const byScript = new Map()
for (const r of tuned) {
  if (!byScript.has(r.script)) byScript.set(r.script, [])
  byScript.get(r.script).push(r)
}

for (const [script, recs] of [...byScript.entries()].sort()) {
  const runs = new Set(recs.map(r => r.runId))
  const engines = new Map()
  for (const id of runs) {
    const e = recs.find(r => r.runId === id)?.engine || '?'
    engines.set(e, (engines.get(e) || 0) + 1)
  }
  const steps = new Map()
  let allTokens = 0, allOut = 0, allMs = 0, allCost = 0, costRuns = new Set(), unknown = []
  // Dollars a price table produced, tracked apart from the total so the report
  // can say how much of it is an estimate rather than a vendor's own number.
  let estimated = 0, unpriced = new Map()
  for (const r of recs) {
    const t = r.tokens || {}
    const total = typeof t.total === 'number' ? t.total : null
    if (total === null) unknown.push(r)
    const s = steps.get(r.step) || { spawns: 0, tokens: 0, out: 0, ms: 0, cost: 0, runs: new Set(), unknown: 0 }
    s.spawns++
    s.tokens += total || 0
    s.out += typeof t.output === 'number' ? t.output : 0
    s.ms += r.ms || 0
    s.cost += typeof r.costUsd === 'number' ? r.costUsd : 0
    if (total === null) s.unknown++
    s.runs.add(r.runId)
    steps.set(r.step, s)
    allTokens += total || 0
    allOut += typeof t.output === 'number' ? t.output : 0
    allMs += r.ms || 0
    if (typeof r.costUsd === 'number') {
      allCost += r.costUsd
      costRuns.add(r.runId)
      if (r.costSource === 'table') estimated += r.costUsd
    } else if (total !== null) {
      // Tokens but no price: a model with no row in lib/prices.mjs. Worth
      // naming — its spend is silently missing from every figure below.
      unpriced.set(r.model, (unpriced.get(r.model) || 0) + 1)
    }
  }
  const n = runs.size
  console.log(`${script} — ${n} run(s): ${[...engines.entries()].map(([e, c]) => `${e} ${c}`).join(', ')}`)
  console.log(`avg per run: ${fmt(allTokens / n)} tokens (out ${fmt(allOut / n)}) · ${fmt(allMs / n / 60000, 1)} model-active min${costRuns.size ? ` · $${fmt(allCost / costRuns.size, 2)} (${costRuns.size} run(s) with cost)` : ''}`)
  if (estimated) {
    console.log(`  of which $${fmt(estimated / costRuns.size, 2)}/run priced from lib/prices.mjs at short-context rates, not billed by the vendor`)
  }
  for (const [model, count] of [...unpriced.entries()].sort()) {
    console.log(`  ${count} spawn(s) on ${model} have tokens but no price row — their spend is missing from every $ below`)
  }
  console.log('')
  const header = `${pad('step', 20, true)} ${pad('spawns/run', 10)} ${pad('tokens/run', 12)} ${pad('%', 6)} ${pad('out/run', 9)} ${pad('model-min/run', 13)} ${pad('$/run', 7)}`
  console.log(header)
  console.log('-'.repeat(header.length))
  const rows = [...steps.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
  for (const [step, s] of rows) {
    const share = allTokens ? (100 * s.tokens / allTokens) : 0
    console.log(`${pad(step, 20, true)} ${pad(fmt(s.spawns / n, 1), 10)} ${pad(fmt(s.tokens / n), 12)} ${pad(fmt(share, 1), 6)} ${pad(fmt(s.out / n), 9)} ${pad(fmt(s.ms / n / 60000, 1), 13)} ${pad(costRuns.size ? fmt(s.cost / costRuns.size, 2) : '-', 7)}${s.unknown ? `   (${s.unknown} spawn(s) without usage)` : ''}`)
  }
  if (unknown.length) {
    const by = new Map()
    for (const r of unknown) by.set(r.vendor, (by.get(r.vendor) || 0) + 1)
    console.log(`\nspawns with no token usage reported (counted as 0): ${[...by.entries()].map(([v, c]) => `${v} ${c}`).join(', ')}`)
  }
  console.log('')
}
if (byScript.size) {
  console.log("model-min/run above is summed spawn duration, not wall-clock: parallel steps spend more of it than the run lasts. A run's own wall time is per issue below.")
  console.log('')
}

// ───────────────────────── the issue-lifetime view ─────────────────────────
// A lifetime is keyed by (repository, issue) and by nothing else. A record that
// cannot state both — a legacy row, a hand-run with no --repo, a slug-mode run
// with no issue — becomes its own row keyed by runId. A row with no usable
// runId is keyed by its source line instead: there is no evidence that two such
// rows came from one invocation, so joining them would invent a history.
const lifetimes = new Map()
const orphans = new Map()
for (const record of records) {
  const identified = !record.legacy && record.repo != null && record.issue != null
  const hasRunId = ['string', 'number'].includes(typeof record.runId) && String(record.runId).length > 0
  const orphanId = hasRunId ? String(record.runId) : `line ${record._line}`
  const key = identified ? `${record.repo} #${record.issue}` : `run ${orphanId}`
  const into = identified ? lifetimes : orphans
  let entry = into.get(key)
  if (!entry) {
    entry = { identified, repo: identified ? record.repo : null, issue: identified ? record.issue : null, runId: hasRunId ? record.runId : orphanId, records: [] }
    into.set(key, entry)
  }
  // An unattributed row still shows whatever identity it does have.
  if (!identified) {
    if (entry.repo == null && record.repo != null) entry.repo = record.repo
    if (entry.issue == null && record.issue != null) entry.issue = record.issue
  }
  entry.records.push(record)
}

function summarize(entry) {
  const own = entry.records
  const ownStarts = own.filter(r => r.type === 'run-start')
  const ownFinishes = own.filter(r => r.type === 'run-finish').sort((a, b) => (at(a) ?? 0) - (at(b) ?? 0))
  const ownSpawns = own.filter(r => r.type === 'spawn')
  const times = own.map(at).filter(t => t !== null)
  const startTimes = ownStarts.map(at).filter(t => t !== null)
  const lifecycleTimes = [...ownStarts, ...ownFinishes].map(at).filter(t => t !== null)
  const lastFinish = ownFinishes[ownFinishes.length - 1] || null
  const runKey = record => {
    const value = record?.runId
    return ['string', 'number'].includes(typeof value) && String(value).length
      ? `${typeof value}:${String(value)}`
      : null
  }
  // Pair starts and finishes by runId, not by aggregate counts. A finish from
  // retained run B cannot hide the fact that retained run A never finished.
  const unmatchedFinishes = new Map()
  for (const finish of ownFinishes) {
    const key = runKey(finish)
    if (key === null) continue
    unmatchedFinishes.set(key, (unmatchedFinishes.get(key) || 0) + 1)
  }
  let incomplete = 0
  for (const start of ownStarts) {
    const key = runKey(start)
    const available = key === null ? 0 : unmatchedFinishes.get(key) || 0
    if (!available) incomplete++
    else if (available === 1) unmatchedFinishes.delete(key)
    else unmatchedFinishes.set(key, available - 1)
  }
  const missingStarts = [...unmatchedFinishes.values()].reduce((total, count) => total + count, 0) +
    ownFinishes.filter(finish => runKey(finish) === null).length

  const s = {
    entry,
    repo: entry.repo, issue: entry.issue, runId: entry.runId,
    legacyRows: own.filter(r => r.legacy).length,
    launches: ownStarts.length,
    byScript: new Map(),
    // Never infer a missing first start from a spawn. For identified issue
    // lifetimes, "latest" is likewise lifecycle activity only; --since is
    // explicitly a lifecycle selector even though the tuning view still
    // filters individual spawn rows.
    first: startTimes.length ? Math.min(...startTimes) : null,
    latest: entry.identified
      ? (lifecycleTimes.length ? Math.max(...lifecycleTimes) : null)
      : (times.length ? Math.max(...times) : null),
    lastFinish,
    wallMs: 0, spawns: ownSpawns.length, modelMs: 0,
    input: 0, cacheRead: 0, cacheCreate: 0, output: 0,
    billed: 0, estimated: 0, unpriced: 0, noUsage: 0,
    respawns: 0, retries: 0, relaunches: 0, fixerAttempts: 0,
    incomplete,
    missingStarts,
    missingWall: ownFinishes.filter(r => !Number.isFinite(r.ms) || r.ms < 0).length,
    hasLifecycle: ownStarts.length > 0 || ownFinishes.length > 0,
  }
  s.partialHistory = !!(s.incomplete || s.missingStarts || s.missingWall || (entry.identified && !s.hasLifecycle && ownSpawns.length))
  for (const r of ownStarts) s.byScript.set(r.script, (s.byScript.get(r.script) || 0) + 1)
  for (const r of ownFinishes) {
    if (Number.isFinite(r.ms) && r.ms >= 0) s.wallMs += r.ms
    if (FIXER_SCRIPTS.includes(r.script) && typeof r.attempt === 'number' && r.attempt >= 1) s.fixerAttempts++
  }
  for (const r of ownSpawns) {
    s.modelMs += typeof r.ms === 'number' ? r.ms : 0
    const t = r.tokens || {}
    const total = typeof t.total === 'number' ? t.total : null
    s.input += typeof t.input === 'number' ? t.input : 0
    s.cacheRead += typeof t.cacheRead === 'number' ? t.cacheRead : 0
    s.cacheCreate += typeof t.cacheCreate === 'number' ? t.cacheCreate : 0
    s.output += typeof t.output === 'number' ? t.output : 0
    if (typeof r.costUsd === 'number') {
      if (r.costSource === 'table') s.estimated += r.costUsd
      else s.billed += r.costUsd
    } else if (total !== null) s.unpriced++
    else s.noUsage++
    // Four separate things, deliberately never summed: a respawn is one agent()
    // call trying again inside itself, a retry is the pipeline re-running a step
    // it already ran, a relaunch is a whole new epic process, and a fixer
    // attempt is a rung of the conflict/CI/defect ladder.
    if (typeof r.attempt === 'number' && r.attempt > 1) s.respawns++
    else if (r.retry) s.retries++
  }
  s.relaunches = Math.max(0, (s.byScript.get('epic-run') || 0) + (s.byScript.get('task-run') || 0) - 1)
  s.result = lastFinish
    ? (Object.prototype.hasOwnProperty.call(OUTCOMES, lastFinish.outcome) ? lastFinish.outcome : 'unknown')
    : (s.hasLifecycle ? 'incomplete' : 'unknown')
  // The normalized outcome is authoritative, but the finish row deliberately
  // stores the derived flag too. Validate that redundancy so damaged telemetry
  // is visible instead of silently presenting a contradictory handoff.
  s.handoff = !!OUTCOMES[s.result]?.handoff
  s.handoffFieldIssue = lastFinish
    ? (typeof lastFinish.handoff !== 'boolean'
        ? 'missing'
        : (lastFinish.handoff !== s.handoff ? 'mismatch' : null))
    : null
  if (s.handoffFieldIssue) s.partialHistory = true
  s.spanMs = (lastFinish && s.first !== null && at(lastFinish) !== null) ? at(lastFinish) - s.first : null
  return s
}

const inWindow = s => !cutoff || (s.latest !== null && s.latest >= cutoff)
const lifetimeRows = [...lifetimes.values()].map(summarize).filter(s => {
  if (!inWindow(s)) return false
  // A lifetime is selected by the run that finished it last: filtering its
  // records instead would report a fraction of an issue's history as the whole.
  if (engineFilter || scriptFilter) {
    if (!s.lastFinish) return false
    if (engineFilter && s.lastFinish.engine !== engineFilter) return false
    if (scriptFilter && s.lastFinish.script !== scriptFilter) return false
  }
  return true
})
// An unattributed row is one runId, so its own records are all a filter has to
// match against — there is no "latest completed run" to select it by.
const orphanRows = [...orphans.values()].map(summarize).filter(s => {
  if (!inWindow(s)) return false
  if (engineFilter && !s.entry.records.some(r => r.engine === engineFilter)) return false
  if (scriptFilter && !s.entry.records.some(r => r.script === scriptFilter)) return false
  return true
})
if (!tuned.length && !lifetimeRows.length && !orphanRows.length) nothingSelected()

const byLatest = (a, b) => (b.latest ?? 0) - (a.latest ?? 0)
const scriptCounts = s => [...s.byScript.entries()]
  .sort((a, b) => {
    const rank = name => { const i = SCRIPTS.indexOf(name); return i < 0 ? SCRIPTS.length : i }
    return rank(a[0]) - rank(b[0]) || String(a[0]).localeCompare(String(b[0]))
  })
  .map(([script, count]) => `${script} ${count}`).join(', ')
const costOf = s => `${money(s.billed)} (+${money(s.estimated)} estimated, ${s.unpriced} unpriced)`
const tokensOf = s => `in ${fmt(s.input)} · cache-read ${fmt(s.cacheRead)} · cache-create ${fmt(s.cacheCreate)} · out ${fmt(s.output)}`
const when = t => t === null ? 'unknown' : stamp(t)

if (lifetimeRows.length || orphanRows.length) {
  console.log('issue lifetimes (log-known)')
  console.log('')
}

const groups = new Map()
for (const s of lifetimeRows) {
  if (!groups.has(s.repo)) groups.set(s.repo, [])
  groups.get(s.repo).push(s)
}
for (const [repo, rows] of [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
  console.log(repo)
  for (const s of rows.sort(byLatest)) {
    const counts = s.byScript.size ? ` (${scriptCounts(s)})` : ''
    console.log(`  #${s.issue}  launches ${s.launches}${counts} · first ${when(s.first)} · latest ${when(s.latest)}` +
      ` · wall ${duration(s.wallMs)} · span ${s.spanMs === null ? '-' : duration(s.spanMs)}` +
      ` · result ${s.result} · handoff ${s.handoff ? 'yes' : 'no'}` +
      `${s.partialHistory ? ' · partial history' : ''}${s.incomplete ? ` · incomplete ${s.incomplete}` : ''}` +
      `${s.missingStarts ? ` · finish-without-start ${s.missingStarts}` : ''}` +
      `${s.missingWall ? ` · wall-missing ${s.missingWall}` : ''}` +
      `${s.handoffFieldIssue ? ` · handoff-field-${s.handoffFieldIssue}` : ''}`)
    console.log(`        spawns ${s.spawns} · model-active ${duration(s.modelMs)} · ${tokensOf(s)} · ${costOf(s)}` +
      ` · respawns ${s.respawns} · retries ${s.retries} · relaunches ${s.relaunches} · fixer attempts ${s.fixerAttempts}` +
      (s.noUsage ? ` · partial: ${s.noUsage} spawn(s) reported no usage` : ''))
  }
  console.log('')
}

if (orphanRows.length) {
  console.log('runs without repository/issue identity (never joined to an issue lifetime)')
  for (const s of orphanRows.sort(byLatest)) {
    console.log(`  ${s.runId} · ${s.issue == null ? 'issue unknown' : `issue ${s.issue}`} · ${s.repo == null ? 'repo unknown' : `repo ${s.repo}`}` +
      ` · latest ${when(s.latest)} · wall ${s.hasLifecycle ? duration(s.wallMs) : 'unknown'}` +
      ` · spawns ${s.spawns} · model-active ${duration(s.modelMs)} · ${costOf(s)} · result ${s.result}`)
  }
  console.log(`  ${orphanRows.length} run(s) above state no repository or issue and are listed one per runId, never joined to an issue lifetime.`)
  const legacyRuns = orphanRows.filter(s => s.legacyRows)
  if (legacyRuns.length) {
    const rows = legacyRuns.reduce((total, s) => total + s.legacyRows, 0)
    console.log(`  ${rows} of those row(s), in ${legacyRuns.length} run(s), predate lifecycle records: tokens and cost are counted, wall time, repository and result unknown.`)
  }
  console.log('')
}

// ───────────────────────── totals and the handoff rate ─────────────────────────
if (lifetimeRows.length) {
  const sum = key => lifetimeRows.reduce((total, s) => total + s[key], 0)
  console.log(`all repositories: ${lifetimeRows.length} issue lifetime(s) · ${sum('launches')} launch(es)` +
    ` · wall ${duration(sum('wallMs'))} · spawns ${sum('spawns')} · model-active ${duration(sum('modelMs'))}` +
    ` · ${tokensOf({ input: sum('input'), cacheRead: sum('cacheRead'), cacheCreate: sum('cacheCreate'), output: sum('output') })}` +
    ` · ${costOf({ billed: sum('billed'), estimated: sum('estimated'), unpriced: sum('unpriced') })}` +
    ` · respawns ${sum('respawns')} · retries ${sum('retries')} · relaunches ${sum('relaunches')} · fixer attempts ${sum('fixerAttempts')}` +
    ` · missing usage ${sum('noUsage')} spawn(s) · partial history ${lifetimeRows.filter(s => s.partialHistory).length} lifetime(s)`)

  // The rate answers one question — how often does automation end by handing an
  // issue to a person — so only lifetimes that answer it are in the denominator.
  // A queued repair, a quota hold, a refusal or a crash left the issue in
  // flight: they are named and counted, never folded in either direction.
  const conclusive = lifetimeRows.filter(s => OUTCOMES[s.result]?.conclusive)
  const handed = conclusive.filter(s => s.handoff)
  const percent = conclusive.length ? `${(100 * handed.length / conclusive.length).toFixed(1)}%` : 'n/a'
  console.log(`human handoff: ${handed.length} of ${conclusive.length} conclusive lifetime(s) (${percent})`)
  const setAside = ['repair-queued', 'quota-held', 'skipped', 'error', 'manual', 'incomplete', 'unknown']
  console.log(`not counted: ${setAside.map(name => `${name} ${lifetimeRows.filter(s => s.result === name).length}`).join(', ')}`)
}
if (malformed) console.log(`malformed records skipped: ${malformed}`)
