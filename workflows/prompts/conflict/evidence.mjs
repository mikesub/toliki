// The conflict prompts' shared evidence rendering: both sides of the stop, in
// one order, for the resolver, its retry, the blind acceptance check and the
// scoped correction. Capture itself stays in fix-run.mjs — this only lays the
// captured bytes out, so no two conflict prompts can present them differently.

import { evidenceBlock, renderIssueRecords } from '../../lib/evidence.mjs'

export const renderConflictEvidence = (issue, prep) => `The PR side — what this branch changed in the marked files (${prep.mergeBase}..${prep.prHead}):
${evidenceBlock('pr-side-diff', prep.evidence?.prSide, '(the PR-side diff could not be captured)')}

What the PR set out to do:
${evidenceBlock('pr-issue', prep.evidence?.prIssue ? renderIssueRecords([prep.evidence.prIssue]) : '', `(issue #${issue} could not be read)`)}

The main side — what landed on main in those files since the PR branched (${prep.mergeBase}..origin/main):
${evidenceBlock('main-side-diff', prep.evidence?.mainSide, '(the main-side diff could not be captured)')}

The commits behind main's side:
${evidenceBlock('main-commits', prep.evidence?.mainCommits, '(the main-side commit list could not be captured)')}

What those commits set out to do:
${evidenceBlock('main-issues', renderIssueRecords(prep.evidence?.mainIssueRecords), '(their commit subjects above are the whole intent record — no Closes #N references were found)')}${prep.evidence?.omittedMainIssues > 0 ? `
(${prep.evidence.omittedMainIssues} further issue(s) main delivered are not included; their commit subjects above are the intent record for those.)` : ''}`
