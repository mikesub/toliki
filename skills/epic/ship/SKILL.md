---
name: ship
description: Ship a local epic as one verified commit fast-forwarded onto local main, archive its handovers, and safely clean up its worktree and branch. Never pushes or opens a PR.
---

Read the [shared contract](../EPIC-CONTRACT.md). Run `status` with the requested
title, and inspect the actual changes, spec, verification and review evidence.
The user's invocation authorizes local commit, integration, release and safe
cleanup; do not ask for routine permission again. Installation, publishing and
host operations are outside this skill.

Check scope and review findings before committing. Resolve outstanding human
decisions from the recorded evidence and conversation; do not silently clear
findings based on a coder's claim. Surface missing/stale review as the contract
requires. The human can choose another review or explicitly accept the current
unreviewed state. Do not launch reviewers or coders yourself.

Prepare one commit on the epic branch:

1. Inspect staged, unstaged, and untracked changes. Include only the intended
   change, never handover artifacts. If no epic commit exists, stage the selected
   files and commit. If exactly one exists, fold intended new changes into it
   with `git commit --amend`. More than one existing commit needs an explicit
   history decision; do not silently discard or squash unrelated work.
2. Use an imperative title of at most 72 characters and a body explaining why,
   key decisions and accepted exclusions. Keep transcripts in the handovers.
3. If main is no longer an ancestor, rebase onto local main. Preserve both sides'
   intent in conflicts; ask about unresolved intent. Resume an interrupted
   rebase explicitly. Integration can invalidate review, so inspect `status`
   again after it and resolve missing/stale review before release.
4. Run the documented full command through `verify` on the final commit even
   on resume. If it fails, preserve the workspace and report the failure for the
   human to return to code. Any later amendment requires another verification.

Write `ship.md` with the commit, verification result, review status, any explicit
acceptance of missing/stale review, outstanding accepted trade-offs, and the
intended archive location. Run `release` from the main checkout, using
`--accept-unreviewed` only for the explicit human decision described above. The
helper pins verification and fast-forwarding to the actual commit.

After release, run `cleanup` from main. Before deleting any extra ignored files
that block cleanup, establish whether they are reproducible outputs or user
data; preserve the latter. Never force cleanup. If cleanup stops, report that
release succeeded, the reason, and exactly which resources were removed or
retained. On a later cleanup-only request, use the release receipt and helper;
do not recommit or
re-release an already landed change.

Report the main commit, verification and review outcome, archive path, and what
cleanup removed or retained. Archived handovers and the commit on main remain
recoverable after worktree and branch removal.
