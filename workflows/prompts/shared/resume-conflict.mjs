// Shared rendering for the one pre-PR interrupted-branch integration call.
// Epic and task use different process contracts around it, but both must see
// the same immutable saved-branch/current-main evidence and exact marker set.

import { evidenceBlock } from '../../lib/evidence.mjs'
import { resumeEvidencePrompt } from './resume-evidence.mjs'

export const resumeConflictPrompt = (recovery, requirement, { completeTask = false } = {}) => `Recover interrupted work on ${recovery.branch} by integrating its saved implementation with the captured current main head.

Original requirement:
${evidenceBlock('requirement', requirement, '(the requirement could not be read)')}

${resumeEvidencePrompt(recovery)}

The checkpoint chain has been flattened locally so there is exactly one bounded diff3 rebase stop. Its unresolved files are: ${recovery.markedFiles.join(', ')}. In each marker block, ours is current main, the ||||||| section is the common base, and theirs is the saved interrupted branch.

Resolve every marker only when both sides' intent can survive. Replace the marker block with the integrated code; do not concatenate duplicate imports, keys, declarations, or stale call shapes. If the evidence does not establish a safe composition, leave the stop intact and ${completeTask ? 'return blocked with the concrete unresolved condition' : 'return declined'} instead of guessing. Do not stage, commit, rebase, push, label, or comment; the pipeline validates and continues the stop.${completeTask ? `

This is also the lightweight task's ordinary primary tasker process. After resolving the markers, finish the complete requirement and self-review the integrated tree in this same worktree. You may edit any file required by the original task. Return the normal structured task result; a completed result asserts both that every marker is resolved and that the task itself is complete.` : `

Touch only the unresolved files named above. Return status resolved or declined and a non-empty summary. This recovery only integrates preserved work; the ordinary epic continuation, verification, and independent broad review still follow.`}`
