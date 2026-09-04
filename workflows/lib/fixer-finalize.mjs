// Reporting and terminal labels are independent side effects. A failed audit
// comment must never skip the state transition that makes a finished fixer
// safe for dispatch/reap/merge, so every fixer refusal and blocker uses this
// helper and gets a verified label readback even when reporting fails.

import { comment, editLabels, ensureLabels, issueLabels } from './github.mjs'
import { failureReason } from './proc.mjs'

export async function finalizeFixerIssue({ issue, body, add, remove, required = add, absent = remove }) {
  let reportError = ''
  try {
    await comment(issue, body)
  } catch (e) {
    reportError = e?.message || String(e)
  }

  let stateError = ''
  let labels = []
  try {
    await ensureLabels(add)
    const flip = await editLabels(issue, { add, remove })
    labels = await issueLabels(issue)
    if (!required.every(label => labels.includes(label)) || !absent.every(label => !labels.includes(label))) {
      stateError = flip.ok
        ? `observed labels: ${labels.join(', ')}`
        : `${failureReason(flip)}; observed labels: ${labels.join(', ')}`
    }
  } catch (e) {
    stateError = e?.message || String(e)
  }

  return { reported: !reportError, reportError, settled: !stateError, stateError, labels }
}
