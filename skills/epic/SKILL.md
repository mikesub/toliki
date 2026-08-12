---
name: epic
description: Autonomous issue-to-PR delivery: `/epic #N` builds a `/spec`-authored issue to an open, green PR and queues it for the merge worker, with no human sign-offs; bare `/epic` claims the oldest unblocked `ready` issue from the queue.
disable-model-invocation: true
---

You launch the autonomous `epic-run` pipeline for a spec issue (authored earlier via `/spec`). **No human gates** — it runs to an open PR queued for unattended merge, an open PR it deliberately held for review, or a blocker comment, then exits. Built for non-interactive use (`claude -p "/epic #42" --worktree`).

The issue carries state, not commentary: a run self-assigns and applies the `in-progress` label (dequeuing `ready` and clearing any prior `ready-to-merge`/`ready-to-review`/`failed`), and the only comments it ever posts are `🤖 deferred / not done` at ship (when anything was deferred — the PR body points at it and records nothing else) and `🤖 epic-run blocked` on a blocker. How the change was built — approach, verify status, review outcome — lives in the PR body, written from `summary.md`. Work happens on `epic/<N>-<slug>`, branched off a freshly fetched `origin/main` and pushed to origin immediately — that push is the run's **claim** on the issue, and because creating a ref is atomic it is what makes it safe to run epics in parallel (the labels are the readable signal; the ref is the lock). The code and triage phases each end in a local checkpoint commit (durable across an interrupted run, not pushed), and Ship squashes the branch into one commit (`Closes #N`), pushes, opens the PR, and flips `in-progress` to `ready-to-review`. A block instead commits any WIP, pushes the branch, and flips `in-progress` to `failed`. (These labels are automation-managed — never set or cleared by hand.)

**The run never merges.** It ends at an open PR, and the label it leaves behind says what happens next. The merge gate — computed in the pipeline from structured counts, not asked of a model — promotes `ready-to-review` to **`ready-to-merge`** when the run left no human decision behind: nothing deferred that a person was meant to judge, meaning no unfixed confirmed review finding and no deferred defect that would outlive the merge. Anything deferred and it stays `ready-to-review` for a person. Promotion only ever moves in that direction, so anything that goes wrong at the handoff leaves the PR where a human is looking.

`bin/merge-worker.sh` in the harness repo then drains `ready-to-merge`, serially per repo: it rebases each PR onto the current `main`, re-runs its checks on the rebased head, and squash-merges — which closes the issue via `Closes #N`, strips the lifecycle labels via the cleanup Action, and lets `CI + Deploy` roll main to production. A rebase conflict, a red check, or a failed merge leaves the PR open and flips the issue to `failed` with a comment naming which — except a judgment-class rebase conflict, which also gets `needs-judgment` and self-heals: dispatch launches a `/fix-conflict` fixer session that resolves it and returns the issue to `ready-to-review`. None of that happens inside your session, and you never wait for it.

Request: $ARGUMENTS

## What to do

1. **Resolve the issue number.**
   - **Given in the request** (e.g. `#42` → `42`): use it, whatever labels it carries.
   - **Not given — claim from the queue.** `/spec` files each finished spec with the `ready` label; take the oldest one that is not already claimed, not blocked, and not already finished (the terminal labels are excluded because the pipeline's label swap is best-effort — a stale `ready` can survive beside one, and that issue must not re-enter the queue):
     ```
     gh issue list --search "label:ready -label:in-progress -label:failed -label:ready-to-merge -label:ready-to-review sort:created-asc" --state open --json number,title --limit 20
     ```
     Walk the list oldest-first and take the **first issue with no open blockers** — check each with `gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by --jq '[.[] | select(.state == "open") | .number]'` and skip any that returns a non-empty list (leave its `ready` label alone; it re-enters the queue once unblocked). If the query returns nothing, or every candidate is blocked, say the queue is empty and stop — do not fall back to unlabelled issues.

   Keep that candidate list — if the run you launch comes back `skipped`, step 3 sends you back to it for the next one.

   Claiming is the pipeline's job, not yours: prepare pushes the `epic/<N>-<slug>` ref to origin before doing any work, and creating a ref is atomic, so exactly one of two racing runs gets it and the other refuses. Do **not** try to reserve an issue yourself by editing labels — the `ready` → `in-progress` swap prepare does is reporting, not the lock, and a second run reaching it a moment later would read the stale value anyway.

2. **Launch the workflow.** The pipeline script lives in the shared harness repo, not this project: run the Workflow tool with `scriptPath: "$CLAUDE_HARNESS_DIR/workflows/epic-run.js"` — resolve the env var to an absolute path first (`echo "$CLAUDE_HARNESS_DIR"`; it's set per machine in `~/.claude/settings.json` env). Pass args `{ issue: <N> }` and let it run to completion. It owns the whole pipeline autonomously, with no sign-offs; on any blocker it comments on issue #<N> and stops instead of shipping.

3. **Report the outcome and exit.** When the workflow returns:
   - **Queued for merge** (`readyToMerge: true`): report the PR URL and `git diff origin/main...HEAD --stat`, and say the issue is now `ready-to-merge` — `bin/merge-worker.sh` rebases it, re-runs its CI and merges it outside this session. Do **not** merge it yourself and do **not** wait for it; if it fails there, the issue turns up as `failed` with a comment, not here.
   - **Held for review** (`prUrl` with `mergeSkipped`): report the PR URL and the `mergeSkipped` reason verbatim — the pipeline deliberately left a human decision on the table, so the PR stays `ready-to-review` and out of the merge queue. Merging is the user's step. Do **not** merge it yourself.
   - **Skipped** (`skipped: true`): nothing ran and nothing changed. The reason is one of: another run claimed the issue first, an open PR already delivers it, the issue is closed, open `blocked_by` dependencies, or a resume conflict. What you do next depends on where the issue came from:
     - **Queue mode** (you chose it in step 1, no number was given): do **not** stop. Go back to the candidate list and launch the next unblocked issue, the same way you skip a blocked candidate in step 1 — a lost claim race should cost one iteration, not an idle slot. Report each skip and its reason as you go, and when the list runs out, say the queue is empty and stop.
     - **Number given explicitly:** relay the reason and stop. The user asked for that specific issue, so there is no next candidate to try.
   - **Blocked:** report the phase and reason (already commented on the issue; branch pushed if any commits exist). A block that carries a PR URL means the change itself is complete and open but something after it failed — say so, and never merge it or push a fix from here. Do **not** retry automatically.

## Recovery

An interrupted or blocked run leaves an `epic/<N>-*` branch holding its checkpoint commits. Re-running `/epic #N` **resumes** from that branch — prepare rebases it onto `origin/main` and continues; to force a fresh build instead, delete the branch locally and on origin first.

A run that died *before its first checkpoint* is the exception, because its branch on origin carries nothing but the claim commit — which is indistinguishable from a run that is claiming the issue right now, so a re-run refuses it as `claimed by another run` instead of resuming. Nothing is lost (that branch holds no work); release the stale claim and re-run:

```bash
git push origin --delete epic/<N>-<slug>
```

Reaping those is the reaper's job (`bin/reap.sh` in the control repo, second pass) — it deletes any `epic/<N>-*` ref still tipped by its claim commit once no live session is working the issue, which puts the issue back in the queue; the command above is how you release one without waiting for its next sweep. A run that already opened a PR is the exception: a re-run skips the issue entirely (an open PR already delivers it), so that PR has to be finished by hand — including one the merge worker flipped to `failed`, unless it also carries `needs-judgment` (then the `/fix-conflict` fixer owns it; see that skill). (Separately, the workflow has a manual `{ slug }` mode that builds on the current tree with no git — see its meta description.)
