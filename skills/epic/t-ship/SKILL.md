---
name: t-ship
description: Ship a local epic as one verified commit fast-forwarded onto local main, archive its handovers, and safely clean up its worktree and branch. Never pushes or opens a PR.
---

Read the [shared contract](EPIC-CONTRACT.md). Locate the epic's worktree and
inspect the actual change, spec, `code.md` and `review.md`. The user's
invocation authorizes local commit, integration, release and safe cleanup; do
not ask for routine permission again. Installation and publishing are outside
this skill.

Check scope and review findings before committing. Resolve outstanding human
decisions from the recorded evidence and conversation; do not silently clear
findings based on a coder's claim. Compare the current fingerprint and spec
hash with those the review recorded, and surface a missing or stale review as
the contract requires. The human can choose another review or explicitly accept
the current unreviewed state. Do not launch reviewers or coders yourself.

Prepare one commit on the epic branch:

1. Inspect staged, unstaged, and untracked changes. Include only the intended
   change, never handover artifacts. If no epic commit exists, commit the
   staged change. If exactly one exists, fold intended new changes into it with
   `git commit --amend`. More than one existing commit needs an explicit
   history decision; do not silently discard or squash unrelated work.
2. Use an imperative title of at most 72 characters and a body explaining why,
   key decisions and accepted exclusions. Keep transcripts in the handovers.
3. If main is no longer an ancestor, rebase onto local main. Preserve both
   sides' intent in conflicts; ask about unresolved intent. Resume an
   interrupted rebase explicitly. A rebase that changes the fingerprint makes
   the review stale; resolve that before release.
4. With a clean worktree, run the full verification command on the final
   commit, even on resume. If it fails, preserve the workspace and report the
   failure for the human to return to t-code. Any later amendment requires
   another verification.

Write `ship.md` with the commit, verification result, review status, any
explicit acceptance of a missing/stale review, outstanding accepted trade-offs,
and the archive location. Fast-forward main to the verified commit from the
main checkout as the contract describes; if Git refuses, report why and stop.

Then archive the handovers and clean up as the contract describes. Before
deleting any extra ignored files that block cleanup, establish whether they are
reproducible outputs or user data; preserve the latter. Never force cleanup. If
cleanup stops, report that release succeeded, the reason, and exactly which
resources were removed or retained. On a later cleanup-only request, confirm
main already contains the commit; do not recommit or re-release.

Report the main commit, verification and review outcome, archive path, and what
cleanup removed or retained. Archived handovers and the commit on main remain
recoverable after worktree and branch removal.
