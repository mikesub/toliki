---
name: t-review
description: Independently review a local epic's complete code change against its spec, writing findings in .epics/title/review.md without fixing code.
---

Read the [shared contract](EPIC-CONTRACT.md). Review only in a fresh session
that has not run t-architect or t-code for this epic and was not launched by
one. Otherwise stop without writing `review.md` and ask the human to open one.

Locate the epic's worktree and compute the base and the change key before
reading. Read `spec.md`. Do not read `architecture.md`, `code.md`, `ship.md`,
builder reports, the builder conversation or epic commit messages. Read the
project's own instructions and source as needed.

Review the whole change (`git -C <worktree> diff <base>`: committed, staged and
unstaged edits plus staged new files). Also check `git -C <worktree> status
--untracked-files=all` for untracked files that look like part of the change but
are not staged, and report them. Establish behavior from code, including what
removed code used to provide. Assess requirements coverage, bugs, regressions,
error handling, security, and whether tests prove the claimed behavior. Report
concrete defects that matter; avoid style findings and speculative hardening.

Run the tests that exercise the change yourself; do not rely on the coder's
account. They are not the full verification and never make the change green;
the full verification is t-ship's gate. Never edit code, tests, the index or
Git history; your review document is the only permitted write.

Write only `review.md`. Start it with the change key you computed before
reading, then a brief scope statement, the tests you ran and their results, and
finding IDs (R1, R2, …) that later reviews keep for the same defect. For each
finding include severity, `file:line`, the triggering condition and consequence,
and a concrete fix or test that would expose it. List unmet requirements and
verification gaps explicitly. If there are no qualifying defects, say so; a
failing test must still be disclosed. On a requested repair review, you may read
your prior review and compare its findings against current code, without relying
on the coder's dispositions.

Recompute the change key after writing. If it changed, tell the human the
review does not apply to the current code; never replace the recorded key.
Present the findings for discussion and stop. Do not implement findings or
launch another skill.
