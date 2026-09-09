// Sentences shared by more than one epic-run prompt, kept in one place so the
// wording cannot drift between the steps that carry it. Each is a consequence a
// step has to plan around rather than a standing rule: standing rules belong in
// the role's charter, and the shape of an answer belongs in the step's schema.
//
// The one sentence a writable step still needs in its own prompt, because it
// has to plan around the consequence rather than merely obey a rule: the
// orchestrator, not the step, runs the gate.
export const NO_SELF_VERIFY = 'Do not run tests or any verification command.'
export const ORCHESTRATOR_GATE = `${NO_SELF_VERIFY} The orchestrator checkpoints your edits and runs the project's full verify gate itself; if it is red, its captured diagnostics come back to one fresh repair attempt.`
// The other consequence a step that returns a delivery record has to plan
// around: this run has no separate prose phase, so what it returns IS what
// every public artifact is rendered from, and a script may render a judgment
// but never supply one that was left out. Shared by every prompt that asks for
// a delivery record, so the rules cannot drift between them.
export const DELIVERY_RECORD = `Return the schema-enforced JSON result, populating every field as its own description asks. There is no later prose step and no other place this judgment is collected: the title, the durable commit rationale, the project's own legal marker and the deferred-work entries you return are exactly what the orchestrator commits, opens the PR with, records on the source issue, and files follow-up issues from.
Apply THIS project's legal/compliance review trigger only if its AGENTS.md defines one and this change meets the criteria written there — not criteria you remember from elsewhere — and then return the exact marker string that section specifies.
**Never write a bare \`#<number>\` for anything except the issue this change is for.** GitHub turns every \`#N\` into a live cross-reference and renders it as that issue or PR's TITLE, so numbering findings \`#1\`, \`#2\`, \`#3\` splices the titles of three unrelated PRs into your sentences and notifies them. Write \`Finding 3\`, and the same for hunks, steps, requirements and packages, in every field you return.`
