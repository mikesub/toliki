// ci-run's narrow confirmation of that correction: read-only and blind to the
// correction's own account. It proves the batch cleared and nothing else broke;
// it is explicitly not a second review.

import { confirmationContract, renderAcceptanceVerdicts, renderBlockerBatch } from '../../lib/repair-acceptance.mjs'

export const confirmPrompt = (issue, prep, { blockers, verdicts, cumulative, correction }) =>
`Narrowly confirm a correction you did not write. The PR on branch ${prep.branch} (issue #${issue}) had these red checks: ${prep.failedChecks.join(', ')}. A repair was accepted with blockers, and one scoped correction was made over exactly those blockers.

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

${confirmationContract({ blockerCount: blockers.length })}`
