// ci-run's one scoped correction over the acceptance check's whole blocker
// batch, inside the same invocation. The repair it amends is still unpushed and
// is NOT rebuilt: relaunching a whole fixer to redo work that is already 90%
// right is exactly what this replaces.

import { evidenceBlock, renderIssueRecord } from '../../lib/evidence.mjs'
import { correctionContract, renderBlockerBatch } from '../../lib/repair-acceptance.mjs'

export const correctionPrompt = (issue, prep, dispositions, { blockers, cumulative, verified }) =>
`Correct the blockers an independent acceptance check found in a red-check repair on branch ${prep.branch} (issue #${issue}). That repair is still unpushed and stays exactly where it is: amend it in place, never redo it.

Checks that were red: ${prep.failedChecks.join(', ')}.
The repair's own indexed dispositions:
${dispositions.map(d => `${d.index}. ${d.name}: ${d.action} — ${d.reason}`).join('\n')}

The orchestrator ran the project's verify contract on the current tree and it was GREEN (${verified.detail}), so a red result after your edit is your edit's doing.

The complete repair delta so far, including new and untracked files:

<repair-delta>
${cumulative}
</repair-delta>

The acceptance blockers, each with the observable outcome that clears it:
${renderBlockerBatch(blockers)}

The requirement the PR was built against, captured by the orchestrator — the boundary you are correcting inside:
${evidenceBlock('requirement-issue', renderIssueRecord(prep.issueRecord), `(issue #${issue} could not be read)`)}

${correctionContract({ blockerCount: blockers.length })}
Stay inside the captured failing checks: this is still a bounded CI repair, not a new change, and you may never weaken a test, assertion, type, lint rule or other gate to clear a blocker.`
