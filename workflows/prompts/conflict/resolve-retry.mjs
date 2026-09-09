// fix-run's resolver retry, spawned when the orchestrator's verify run rejected
// the completed resolution. It starts after the first resolver already finished
// the rebase. Replaying the mid-rebase prompt would ask a fresh process to
// finish a stop that no longer exists, so reconstruct the same intent boundary
// over the completed, still-unpushed resolution instead.

import { renderConflictEvidence } from './evidence.mjs'

export const resolveRetryPrompt = (issue, prep) =>
`Repair a scripted verification failure in the completed judgment-conflict resolution on branch ${prep.branch} (issue #${issue}). The first resolver already finished the rebase: there is no rebase in progress and HEAD is exactly one still-unpushed commit above origin/main. Amend only the working tree; do not restart or continue a rebase.

The original machine classification and numbered judgment worklist remain the boundary:
${prep.report}

${prep.judgmentHunks.map((h, i) => `${i + 1}. ${h.file} hunk ${h.hunk} — ${h.report}`).join('\n')}

Reconstruct both sides' intent from the same durable evidence the first resolver received, captured again below by the orchestrator. The completed resolution itself is current HEAD plus the working tree.

${renderConflictEvidence(issue, prep)}

Repair only a failure caused by how those numbered hunks were resolved. Touch only ${prep.markedFiles.join(', ')}; an edit elsewhere in one of those files is allowed solely where it carries one side's intent to code the other side moved, and must be listed under outsideEdits. Never touch another file, create a file, revisit a mechanical resolution, commit, amend, push, label, or comment. If the reported failure cannot be repaired inside that evidence and boundary, decline the affected item rather than guessing.

Return dispositions with exactly one entry for every numbered judgment hunk: index, action ("repaired" or "declined"), and a non-empty reason. A repaired entry also states mainIntent, prIntent, resolution, and outsideEdits when needed. Also return a short summary. No missing, duplicate, or extra indexes.`
