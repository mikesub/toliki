// defect-run's narrow confirmation of that correction: read-only, and blind to
// the correction's own account.

import { confirmationContract, renderAcceptanceVerdicts, renderBlockerBatch } from '../../lib/repair-acceptance.mjs'
import { renderDefectBrief } from '../../lib/defect-evidence.mjs'

export const confirmPrompt = (issue, prep, { blockers, verdicts, cumulative, correction }) =>
`Narrowly confirm a correction you did not write. The finished PR on branch ${prep.branch} (issue #${issue}) carried a ship-gate defect repair that an acceptance check accepted with blockers, and one scoped correction was then made over exactly those blockers.

${renderDefectBrief(prep.evidence)}

The acceptance blockers the correction was given:
${renderBlockerBatch(blockers)}

What the acceptance check decided about each original claim:
${renderAcceptanceVerdicts(verdicts)}

The complete cumulative repair delta, correction included:

<repair-delta>
${cumulative}
</repair-delta>

The exact correction delta — only what the correction changed:

<correction-delta>
${correction}
</correction-delta>

A correction that clears a blocker by weakening a gate, or by reclassifying a named defect rather than repairing it, is a refutation.

${confirmationContract({ blockerCount: blockers.length })}`
