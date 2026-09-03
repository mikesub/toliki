#!/usr/bin/env node
// Per-step token and time report from the usage log lib/usage.mjs writes:
// which steps of an average run cost what, so etc/engines.json can be tuned
// from data. Read-only; runs wherever the log is (the host, via
// `./remote-control.sh usage`, or a laptop that ran /epic).
//
// Usage: usage-report.mjs [--log <file>] [--since <N>d] [--engine <name>] [--script epic-run|fix-run]
//
// "tokens" is everything the model processed (input + output + cache reads +
// cache writes); "out" is output tokens alone. Percentages are a step's share
// of the tokens of all runs of that script, which equals its share of the
// average run. Spawns the CLI reported no usage for count as zero and are
// listed, so a gap in the data never passes as a cheap step.

import { readFileSync } from 'node:fs'
import { USAGE_LOG } from './lib/usage.mjs'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback }
if (args.includes('-h') || args.includes('--help')) {
  console.log('Usage: usage-report.mjs [--log <file>] [--since <N>d] [--engine <name>] [--script epic-run|fix-run]')
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

const records = []
for (const line of raw.split('\n')) {
  if (!line.trim()) continue
  try {
    const r = JSON.parse(line)
    if (cutoff && Date.parse(r.ts) < cutoff) continue
    if (engineFilter && r.engine !== engineFilter) continue
    if (scriptFilter && r.script !== scriptFilter) continue
    records.push(r)
  } catch { /* a torn line from a concurrent append; skip it */ }
}
if (!records.length) {
  console.log(`no usage records in ${file}${since ? ` since ${since}` : ''}${engineFilter ? ` for engine ${engineFilter}` : ''}`)
  process.exit(0)
}

const fmt = (n, d = 0) => (n === null || n === undefined || Number.isNaN(n)) ? '-' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d })
const pad = (s, w, left = false) => { s = String(s); return left ? s.padEnd(w) : s.padStart(w) }

const byScript = new Map()
for (const r of records) {
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
    if (typeof r.costUsd === 'number') { allCost += r.costUsd; costRuns.add(r.runId) }
  }
  const n = runs.size
  console.log(`${script} — ${n} run(s): ${[...engines.entries()].map(([e, c]) => `${e} ${c}`).join(', ')}`)
  console.log(`avg per run: ${fmt(allTokens / n)} tokens (out ${fmt(allOut / n)}) · ${fmt(allMs / n / 60000, 1)} min${costRuns.size ? ` · $${fmt(allCost / costRuns.size, 2)} (${costRuns.size} run(s) with cost)` : ''}`)
  console.log('')
  const header = `${pad('step', 20, true)} ${pad('spawns/run', 10)} ${pad('tokens/run', 12)} ${pad('%', 6)} ${pad('out/run', 9)} ${pad('min/run', 8)} ${pad('$/run', 7)}`
  console.log(header)
  console.log('-'.repeat(header.length))
  const rows = [...steps.entries()].sort((a, b) => b[1].tokens - a[1].tokens)
  for (const [step, s] of rows) {
    const share = allTokens ? (100 * s.tokens / allTokens) : 0
    console.log(`${pad(step, 20, true)} ${pad(fmt(s.spawns / n, 1), 10)} ${pad(fmt(s.tokens / n), 12)} ${pad(fmt(share, 1), 6)} ${pad(fmt(s.out / n), 9)} ${pad(fmt(s.ms / n / 60000, 1), 8)} ${pad(costRuns.size ? fmt(s.cost / costRuns.size, 2) : '-', 7)}${s.unknown ? `   (${s.unknown} spawn(s) without usage)` : ''}`)
  }
  if (unknown.length) {
    const by = new Map()
    for (const r of unknown) by.set(r.vendor, (by.get(r.vendor) || 0) + 1)
    console.log(`\nspawns with no token usage reported (counted as 0): ${[...by.entries()].map(([v, c]) => `${v} ${c}`).join(', ')}`)
  }
  console.log('')
}
