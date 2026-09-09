// fix-run's narrow confirmation of that correction: read-only and blind to the
// correction's own account. It proves the batch cleared and nothing else broke;
// it is explicitly not a second review.

import { confirmationContract, renderAcceptanceVerdicts, renderBlockerBatch } from '../../lib/repair-acceptance.mjs'

export const confirmPrompt = (issue, prep, { blockers, verdicts, cumulative, correction }) =>
`Narrowly confirm a correction you did not write. The PR branch ${prep.branch} (issue #${issue}) carried a judgment-conflict resolution that an acceptance check accepted with blockers, and one scoped correction was then made over exactly those blockers.

The acceptance blockers the correction was given:
${renderBlockerBatch(blockers)}

What the acceptance check decided about each original claim:
${renderAcceptanceVerdicts(verdicts)}

The complete cumulative resolution delta, correction included:

<repair-delta>
${cumulative}
</repair-delta>

The exact correction delta — only what the correction changed:

<correction-delta>
${correction}
</correction-delta>

Both sides' intent is what is being protected: a correction that clears a blocker by dropping what origin/main meant, or what the PR meant, is a regression. A hunk the resolution declined must still carry its exact PR-side text.

${confirmationContract({ blockerCount: blockers.length })}`
