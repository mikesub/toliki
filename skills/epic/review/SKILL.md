---
name: review
description: Independently review a local epic's complete code change against its spec, writing findings in .epics/title/review.md without fixing code or running verification.
---

Read the [shared contract](../EPIC-CONTRACT.md). Use a fresh Codex context for
independence. If this session built or designed the change, tell the human to
open a fresh review session rather than presenting a self-review as independent.

Locate the workspace with `status`, then run `review-start`. Read `spec.md` and
the mechanically captured verification evidence. Do not read `architecture.md`,
`code.md`, `ship.md`, builder reports or the builder conversation. Read the
project's own instructions and source as needed.

Review the whole change against the base returned by the helper: `git diff
<base>` includes committed and uncommitted changes. Also list and read new files
with `git ls-files --others --exclude-standard`. Do not use only `git diff HEAD`,
which loses changes after a commit. A failed or incomplete evidence capture
cannot produce a clean review.

Establish behavior from code, including what removed code used to provide.
Assess requirements coverage, bugs, regressions, error handling, security, and
whether tests prove the claimed behavior. Report concrete defects that matter;
avoid style findings and speculative hardening. Verification results are
evidence with a particular snapshot, not proof of completeness.

Write only `review.md`, with the content/spec fingerprints returned by
`review-start`, a brief scope statement, and stable finding IDs. For each
finding include severity, `file:line`, the triggering condition and consequence,
and a concrete fix or test that would expose it. List unmet requirements and
verification gaps explicitly. If there are no qualifying defects, say so; a
missing or failed verification must still be disclosed. On a requested repair
review, you may read your prior review and compare its findings against current
code, without relying on the coder's dispositions.

Run `review-finish` after writing the report. If it fails, report that the
read-only check failed and stop; do not seal or claim a valid review. Do not run
tests, builds, installs, or commands that modify project/Git state. The helper's
review records and your review document are the only permitted writes.

Present the findings for discussion and stop. If discussion changes the report,
run `review-finish` again to bind the revised report to the unchanged inspected
code. Do not implement findings or launch another skill.
