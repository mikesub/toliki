// One JSON line per agent spawn, appended to EPIC_USAGE_LOG (default
// ~/epic-usage.jsonl on whichever machine ran the pipeline). Host-local by
// design: this is tuning data for etc/engines.json — which step eats the
// tokens, on which vendor, at what effort — not run state, and it is never
// written to GitHub. Best effort: recording never fails a run.
//
// A record: { ts, runId, script, session, issue, engine, step, label, attempt,
//             vendor, model, effort, ok, timedOut, ms, failureKind, failureReason,
//             tokens: { input, output, cacheRead, cacheCreate, total },
//             costUsd, costSource, turns }
// Token fields are null when the CLI did not report them. `costSource` says who
// produced the dollars: "cli" is the vendor's own figure (Claude), "table" is
// lib/prices.mjs applied to reported tokens (Codex, which prices nothing
// itself). Null cost, null source — an unpriced model is unknown, not free.

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const USAGE_LOG = process.env.EPIC_USAGE_LOG === undefined
  ? path.join(homedir(), 'epic-usage.jsonl')
  : process.env.EPIC_USAGE_LOG   // an empty value disables recording

export function recordUsage(record) {
  if (!USAGE_LOG) return
  try {
    appendFileSync(USAGE_LOG, JSON.stringify(record) + '\n')
  } catch { /* reporting never fails a run */ }
}
