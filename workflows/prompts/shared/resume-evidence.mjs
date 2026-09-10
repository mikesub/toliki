// Immutable evidence shared by the interrupted-branch builder and the
// reviewers that later judge its integrated tree. Keeping one renderer makes
// each process read the same captured bytes.

import { evidenceBlock, renderIssueRecords } from '../../lib/evidence.mjs'

export const resumeEvidencePrompt = recovery => `Immutable recovery identity:
- saved branch head: ${recovery.savedHead || '(the original saved checkpoint SHA is not reconstructed on this later run)'}
- current main head: ${recovery.mainHead}
- current recovery merge base: ${recovery.mergeBase}
- cumulative main-intent base: ${recovery.evidenceMergeBase || recovery.mergeBase}

${recovery.savedDiff !== null ? `What the interrupted branch changed from the current recovery merge base:
${evidenceBlock('saved-branch-diff', recovery.savedDiff, '(the saved-branch diff could not be captured)')}` : 'The original saved-branch diff is not claimed as reconstructed on this later run; judge the actual integrated change diff supplied separately.'}

What current main changed from the cumulative main-intent base:
${evidenceBlock('current-main-diff', recovery.mainDiff, '(the current-main diff could not be captured)')}

The commits behind current main's side:
${evidenceBlock('current-main-commits', recovery.mainCommits, '(the current-main commit list could not be captured)')}

What those commits set out to do (integration context for preserving relevant main behavior, not extra delivery scope):
${evidenceBlock('current-main-issues', renderIssueRecords(recovery.mainIssueRecords), '(their commit subjects above are the whole intent record — no Closes #N references were found)')}${recovery.omittedMainIssues > 0 ? `
(${recovery.omittedMainIssues} further issue(s) main delivered are not included; their commit subjects above are the intent record for those.)` : ''}

${recovery.markerText?.length ? `Exact conflict-marker bytes from the bounded aggregate stop:
${recovery.markerText.map(entry => evidenceBlock(`conflict:${entry.file}`, entry.text, `(conflict bytes for ${entry.file} could not be captured)`)).join('\n\n')}` : recovery.reloaded
    ? 'This later run does not claim the original conflict-marker bytes were reconstructed; judge the actual integrated diff and recaptured main intent.'
    : 'The aggregate replay applied cleanly; there were no stopped conflict-marker bytes.'}`
