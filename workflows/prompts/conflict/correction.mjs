// fix-run's one scoped correction over the acceptance check's whole blocker
// batch, inside the same invocation.
// The resolution it amends stays exactly where it is; its edits join the same
// amended commit, so a corrected resolution is one commit like any other.

import { correctionContract, renderBlockerBatch } from '../../lib/repair-acceptance.mjs'
import { renderConflictEvidence } from './evidence.mjs'

export const correctionPrompt = (issue, prep, dispositions, { blockers, cumulative, verified }) =>
`Correct the blockers an independent acceptance check found in a judgment-conflict resolution on branch ${prep.branch} (issue #${issue}). That resolution is unpushed and stays exactly where it is: amend it in place, never redo it and never re-litigate a hunk no blocker names.

The resolver's own indexed dispositions:
${dispositions.map(d => `${d.index}. ${d.file} hunk ${d.hunk}: ${d.action} — ${d.reason}`).join('\n')}

The orchestrator ran the project's verify contract on the current tree and it was GREEN (${verified.detail}), so a red result after your edit is your edit's doing.

The complete resolution delta so far:

<repair-delta>
${cumulative}
</repair-delta>

The acceptance blockers, each with the observable outcome that clears it:
${renderBlockerBatch(blockers)}

The same captured evidence the resolver and the acceptance check both read:

${renderConflictEvidence(issue, prep)}

${correctionContract({ blockerCount: blockers.length })}
Both sides' intent is the thing being protected: every correction must leave what origin/main meant and what the PR meant BOTH surviving, and a hunk the resolution declined must keep its exact PR-side text. Touch only ${prep.markedFiles.join(', ')}, and there only for the named blockers. Never revisit a mechanical resolution and never create a file; the pipeline folds your working-tree edits into the same amended commit after it verifies and confirms them.`
