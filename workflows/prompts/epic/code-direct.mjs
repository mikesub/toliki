// epic-run's direct-implementation prompt: one coherent pass over the
// architecture with the tests its verification evidence needs, plus the run's
// delivery record. A direct plan skips artificial RED, never the verify gate.

import { DELIVERY_RECORD, ORCHESTRATOR_GATE } from './shared.mjs'

export const codeDirectPrompt = (dir, requirement) =>
`Code phase, direct implementation. Read ${dir}/architecture.md for the plan and public contract, then implement the feature in one coherent pass. Add or update tests where they meaningfully prove the architecture's verification evidence; do not manufacture a test for an untestable surface.

The requirement:
"""
${requirement}
"""

Follow the architecture while preserving its requirement and public contract. If a codebase fact makes a planned detail wrong or impractical, make the smallest justified adjustment.
${ORCHESTRATOR_GATE} ${DELIVERY_RECORD}`
