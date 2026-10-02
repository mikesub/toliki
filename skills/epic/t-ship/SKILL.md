---
name: t-ship
description: Ship a local epic as one verified commit fast-forwarded onto local main, archive its handovers, and safely clean up its worktree and branch. Never pushes or opens a PR.
---

Read the [shared contract](EPIC-CONTRACT.md). The user's invocation authorizes
the commit, rebase, fast-forward of main and safe cleanup; do not ask for
routine permission. Never publish or deploy, and do not launch reviewers or
coders.

If `ship.md`, in the worktree or under `<main>/.epics/<title>/releases/`,
records a commit that main already contains (`git -C <main> merge-base
--is-ancestor <commit> main`), the epic has landed: go to step 5. Otherwise
locate the worktree and read `spec.md`, `code.md` and `review.md`. If there is
no change, report that there is nothing to ship. If a rebase is in progress,
continue with step 3.

1. Review. Compare the current change key with `review.md`'s and handle a
   missing or stale review as the contract requires. List the review's open
   findings and unmet requirements and any open decisions in the handovers;
   each needs the human's explicit acceptance, and `code.md` dispositions
   never clear a finding.
2. Commit. If `git -C <worktree> status --porcelain --untracked-files=all`
   lists untracked files, stop and ask the human to stage, move or ignore
   them. Commit every tracked edit, which is exactly what the fingerprint
   covers: `git -C <worktree> commit -a` with no epic commit, `commit -a
   --amend` with one. With several, show `git -C <worktree> log --oneline
   main..HEAD`; stop if a commit holds unrelated work, otherwise ask to squash
   and, with consent, run
   `git -C <worktree> reset --soft "$(git -C <worktree> merge-base main HEAD)"`
   and `commit -a`. Title: imperative, at most 72 characters; body: why, key
   decisions, accepted exclusions.
3. Rebase. Finish a rebase in progress; otherwise rebase only if `git -C
   <worktree> merge-base --is-ancestor main HEAD` fails. Follow the contract,
   preserving both sides' intent in conflicts.
4. Land. Check the contract's landing gate, running the full verification on
   the clean worktree, even on resume. If verification fails, keep everything
   and report it for t-code; if the change key no longer matches, return to
   step 1. Record the commit and its verification in `ship.md`, then
   fast-forward main with the contract's command; if Git refuses, report why
   and stop.
5. Archive the handovers and clean up as the contract describes.

Report the commit on main, verification, review status and acceptances, the
archive and preserved paths, and what cleanup removed or kept.
