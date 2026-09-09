// epic-run's one implementation retry, appended to a writable step's own
// prompt when the orchestrator's verify run came back red. A second red blocks
// the run, so the wording promises no further attempt.

export const verifyRetryPrompt = (gate) =>
`

The pipeline ran \`npm run verify\` after your previous attempt and it is RED. This is your one retry; a second red blocks the run for a human.
${gate.tail}
Repair the reported cause — never by weakening, skipping or deleting a test. Do not run tests or verification yourself; leave the updated working tree for the pipeline's final scripted retry.`
