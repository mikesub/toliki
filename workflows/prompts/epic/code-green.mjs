// epic-run's GREEN prompt: implement the architecture against the failing tests
// the RED step already wrote. It also returns the run's delivery record, since
// the phase that made the change is the one that can say why it was made.

import { DELIVERY_RECORD, ORCHESTRATOR_GATE } from './shared.mjs'

export const codeGreenPrompt = (dir, requirement, red) =>
`Code phase, GREEN step. Read ${dir}/architecture.md for the plan and public contract.

The requirement:
"""
${requirement}
"""

The existing failing tests:
${JSON.stringify(red, null, 2)}

Implement the feature to make those tests pass, following architecture.md's build steps.
${ORCHESTRATOR_GATE} ${DELIVERY_RECORD}`
