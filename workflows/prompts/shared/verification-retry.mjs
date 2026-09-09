// The verification-driven repair retry every fixer appends to its own repair
// prompt. One shared module because the conflict, CI and defect fixers must
// hand a red gate back in the same words: the retry is bounded at one, and a
// wording that differed per cause would let one fixer promise a second.
//
// Writable agents do not execute project gates. When their first repair leaves
// the tree red, the orchestrator gives one fresh process its own bounded,
// sanitized output and then runs the complete gate once more. This is separate
// from a provider/process respawn inside agent() and from the fixer's durable
// two-rung attempt ladder.
export const verificationRetryPrompt = verified => `

The orchestrator ran the project's full verification command after your repair and it is RED. This is the one verification-driven repair retry in this run; a second red result blocks before the acceptance check.

Captured failure diagnostics:
${verified.tail || verified.detail}

Repair the reported cause without weakening, skipping, deleting or loosening a test, assertion, type, lint rule, check, or security guard. Do not run tests or verification yourself. Leave the updated working tree for the orchestrator to verify, and return the complete structured result requested above again.`
