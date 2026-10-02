---
name: t-review
description: Independently review a local epic's complete code change against its spec, writing findings in .epics/title/review.md without fixing code.
---

Read the [shared contract](EPIC-CONTRACT.md). Use a fresh agent session for
independence. If this session built or designed the change, tell the human to
open a fresh review session rather than presenting a self-review as independent.

Locate the epic's worktree and compute the base, the change fingerprint and
the spec hash before reading. Read `spec.md`. Do not read `architecture.md`,
`code.md`, `ship.md`, builder reports or the builder conversation. Read the
project's own instructions and source as needed.

Review the whole change: `git diff <base>` includes committed and staged
changes. Also check `git status` for untracked files that look like part of the
change but are not staged, and report them. Establish behavior from code,
including what removed code used to provide. Assess requirements coverage,
bugs, regressions, error handling, security, and whether tests prove the
claimed behavior. Report concrete defects that matter; avoid style findings and
speculative hardening.

Run the project's full verification command yourself and report its exit
status; do not rely on the coder's account of it. Verification is evidence for
one fingerprint, not proof of completeness. Never edit code, tests, the index
or Git history; your review document is the only permitted write.

Write only `review.md`, with the fingerprint and spec hash, a brief scope
statement, the verification result, and stable finding IDs. For each finding
include severity, `file:line`, the triggering condition and consequence, and a
concrete fix or test that would expose it. List unmet requirements and
verification gaps explicitly. If there are no qualifying defects, say so; a failed verification
must still be disclosed. On a requested repair review, you may read your prior
review and compare its findings against current code, without relying on the
coder's dispositions.

Recompute both after writing. If either changed during the review, report
that the change moved under you and that the review does not apply to the
current code. Present the findings for discussion and stop. Do not
implement findings or launch another skill.
