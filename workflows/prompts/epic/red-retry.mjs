// epic-run's one RED retry, appended to the RED step's own prompt.
// The orchestrator, not the RED writer, decides whether RED was meaningful:
// this is appended when its own verify run did not contain the declared
// assertion, and it is the only retry that step gets.

export const redRetryPrompt = (gate) =>
`

The pipeline rejected your previous RED step: ${gate}. This is your one retry. Rewrite the tests so the project's verify command should fail on a distinctive unmet assertion against the public contract in architecture.md, then identify that exact expected assertion excerpt. Do not run the tests yourself, and do not use an import error, timeout, infrastructure failure, or unrelated failure.`
