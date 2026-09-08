// One JSON line per recorded event, appended to EPIC_USAGE_LOG (default
// ~/epic-usage.jsonl on whichever machine ran the pipeline). Host-local by
// design: this is tuning data for etc/engines.json — which step eats the
// tokens, on which vendor, at what effort — plus the run lifecycle an operator
// reads per issue. It is never written to GitHub, and it is never run state.
// Best effort throughout: recording, or failing to record, never fails a run.
//
// Three record shapes, told apart by `type`:
//
//   { type:'run-start', ts, runId, script, engine, session, issue, repo }
//     one per process, written once the engine resolves and before any
//     substantive work. A run killed mid-flight leaves only this.
//
//   { type:'run-finish', ts, runId, script, engine, session, issue, repo,
//     startedAt, ms, outcome, handoff, exit, attempt }
//     one per process, written after the RESULT line. `ms` is that
//     invocation's own wall-clock time; `outcome` is the pipeline's own
//     classification of where it came to rest (see OUTCOMES).
//
//   { type:'spawn', ts, runId, script, session, issue, repo, engine, step,
//     label, attempt, retry, vendor, model, effort, ok, timedOut, ms,
//     tokens: { input, output, cacheRead, cacheCreate, total },
//     costUsd, costSource, turns, failureKind, failureReason }
//     one per agent spawn, failed ones included.
//
// Rows written before lifecycle records existed carry no `type` and are read
// as spawns; their wall time, repository and result are simply unknown.
// Token fields are null when the CLI did not report them. `costSource` says who
// produced the dollars: "cli" is the vendor's own figure (Claude), "table" is
// lib/prices.mjs applied to reported tokens (Codex, which prices nothing
// itself). Null cost, null source — an unpriced model is unknown, not free.
// All ts/startedAt values are canonical UTC ISO 8601; localization belongs to
// whoever renders them.

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const USAGE_LOG = process.env.EPIC_USAGE_LOG === undefined
  ? path.join(homedir(), 'epic-usage.jsonl')
  : process.env.EPIC_USAGE_LOG   // an empty value disables recording

// Where a pipeline invocation came to rest, as the invocation itself observed
// it. `handoff` is the one question the report rates: did this run hand the
// issue to a person? `conclusive` says whether it answers that question at all
// — a queued repair, a quota hold or a refusal leaves the issue mid-flight, so
// counting it either way would make the rate mean nothing.
export const OUTCOMES = {
  'merge-queued':  { handoff: false, conclusive: true },   // ready-to-merge, read back
  'human-review':  { handoff: true,  conclusive: true },   // resting in front of a person
  'human-blocked': { handoff: true,  conclusive: true },   // stopped; a person must act
  'repair-queued': { handoff: false, conclusive: false },  // an automated fixer owns it next
  'quota-held':    { handoff: false, conclusive: false },  // waiting on the provider
  'skipped':       { handoff: false, conclusive: false },  // refused before doing anything
  'error':         { handoff: false, conclusive: false },  // crashed outside its blocker path
  'manual':        { handoff: false, conclusive: false },  // a slug-mode summary, no issue
  'unknown':       { handoff: false, conclusive: false },  // recorded without a classification
}

// The pipelines classify themselves; this only normalizes what they wrote. An
// unrecognized label is `unknown` rather than a guess from other result fields.
export function outcomeOf(result) {
  if (result && typeof result === 'object') {
    if (Object.prototype.hasOwnProperty.call(OUTCOMES, result.outcome)) return result.outcome
    if (result.error) return 'error'
  }
  return 'unknown'
}

export function recordUsage(record) {
  if (!USAGE_LOG) return
  try {
    appendFileSync(USAGE_LOG, JSON.stringify(record) + '\n')
  } catch { /* reporting never fails a run */ }
}

export function recordRunStart(identity) {
  recordUsage({ type: 'run-start', ...identity })
}

export function recordRunFinish(identity, fields) {
  recordUsage({ type: 'run-finish', ...identity, ...fields })
}
