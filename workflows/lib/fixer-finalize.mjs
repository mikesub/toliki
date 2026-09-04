// Reporting and terminal labels are independent side effects. A failed audit
// comment must never skip the state transition that makes a finished fixer
// safe for dispatch/reap/merge, so every fixer refusal and blocker uses this
// helper and gets a verified label readback even when reporting fails.
//
// The transition runs FIRST and the comment is written from its verified
// readback. Guidance that names a label — "removed from the queue", "rests at
// failed" — is a claim about state, and a body composed before the swap keeps
// asserting it after the swap failed, leaving the issue dispatchable under a
// durable comment that says it is not. Pass a function for any body that makes
// such a claim; it receives the state below and is called after the readback. A
// plain string is only for guidance that claims nothing about the transition.
// The comment is attempted either way, so a failed swap still reports itself.
//
// A swap is not one fact but several, and guidance composed from `settled`
// alone is wrong whenever it half-lands: it tells the operator to strip a label
// that is already gone, or to set one that is already there. So the readback is
// reported per label — `missing` (required, not observed) and `stuck`
// (must-be-absent, still observed) — with `readable` saying whether the labels
// are observed fact at all. Only an unreadable state deserves fully
// conservative guidance; a readable partial one names the repairs it still
// needs and nothing else.
//
// The swap, the readback and the comment are all the work left at the end of a
// run, and one budget covers all three (see terminalBudget in github.mjs). The
// budget opens BEFORE the write, not after it: GitHub can apply the label — and
// start reap's settle clock — while the client is still waiting for the
// response, so a swap on the default gh timeout can be killed by a sweep that
// already considers the label settled, before the reporting has even begun.

import { comment, editLabels, ensureLabels, issueLabels, terminalBudget } from './github.mjs'
import { failureReason } from './proc.mjs'

export async function finalizeFixerIssue({ issue, body, add, remove, required = add, absent = remove }) {
  const budget = terminalBudget()
  let stateError = ''
  let labels = []
  let readable = false
  let missing = []
  let stuck = []
  try {
    await ensureLabels(add, { budget })
    const flip = await editLabels(issue, { add, remove }, { budget })
    labels = await issueLabels(issue, { budget })
    readable = true
    missing = required.filter(label => !labels.includes(label))
    stuck = absent.filter(label => labels.includes(label))
    if (missing.length || stuck.length) {
      const observed = `observed labels: ${labels.join(', ') || 'none'}`
      stateError = flip.ok ? observed : `${failureReason(flip)}; ${observed}`
    }
  } catch (e) {
    stateError = e?.message || String(e)
  }
  const state = { settled: !stateError, stateError, labels, readable, missing, stuck }

  let reportError = ''
  try {
    await comment(issue, typeof body === 'function' ? body(state) : body, { budget })
  } catch (e) {
    reportError = e?.message || String(e)
  }

  return { reported: !reportError, reportError, ...state }
}
