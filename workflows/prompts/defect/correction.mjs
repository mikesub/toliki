// defect-run's one scoped correction over the acceptance check's whole blocker
// batch, inside the same invocation. The repair it amends is still unpushed and
// is NOT rebuilt.

import { correctionContract, renderBlockerBatch } from '../../lib/repair-acceptance.mjs'
import { renderDefectBrief } from '../../lib/defect-evidence.mjs'

export const correctionPrompt = (issue, prep, dispositions, { blockers, cumulative, verified }) =>
`Correct the blockers an independent acceptance check found in a ship-gate defect repair on branch ${prep.branch} (issue #${issue}). That repair is still unpushed and stays exactly where it is: amend it in place, never redo it.

${renderDefectBrief(prep.evidence)}

That evidence is the entire repair brief, and still the boundary.

The repair's own indexed dispositions:
${dispositions.map(d => `${d.index}. ${d.title}: ${d.action} — ${d.reason}`).join('\n')}

The orchestrator ran the project's verify contract on the current tree and it was GREEN (${verified.detail}), so a red result after your edit is your edit's doing.

The complete repair delta so far, including new and untracked files:

<repair-delta>
${cumulative}
</repair-delta>

The acceptance blockers, each with the observable outcome that clears it:
${renderBlockerBatch(blockers)}

${correctionContract({ blockerCount: blockers.length })}
Stay bound to the authenticated evidence above: never reclassify or dismiss a named defect, never weaken a test, check, assertion, type, lint rule or security guard, and make no change the blockers did not name.`
