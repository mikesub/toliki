// epic-run's RED prompt: tests only, derived from the requirement and the
// architecture's public contract. The orchestrator runs the gate itself and
// accepts RED only when its own failure output contains the returned excerpt.

import { NO_SELF_VERIFY } from './shared.mjs'

export const codeRedPrompt = (dir, requirement) =>
`Code phase, RED step. Write tests ONLY (no implementation). Read ${dir}/architecture.md for the plan and public contract, and derive tests from the requirement below + that contract/API surface.

The requirement:
"""
${requirement}
"""

Cover what is genuinely testable in this stack (units, pure logic, backend handlers, frontend component behavior); for a hard-to-test surface (canvas/visual, external I/O), SKIP it and return it in uncovered rather than faking a test.
${NO_SELF_VERIFY} The pipeline runs \`npm run verify\` itself and requires the excerpt you return in its own failure output, so a typo, missing import, infrastructure error, timeout, or unrelated failure is not valid RED.`
