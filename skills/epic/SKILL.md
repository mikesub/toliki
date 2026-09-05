---
name: epic
description: Autonomous issue-to-PR delivery: `/epic #N` builds a `/spec`-authored issue to an open, green PR and queues it for the merge worker, with no human sign-offs; bare `/epic` claims the oldest unblocked `ready` issue from the queue.
disable-model-invocation: true
---

Launch the autonomous `epic-run` pipeline for one spec issue and report what it returned. It runs to completion on its own, never merges, and nothing here waits for the merge worker.

Request: $ARGUMENTS

## What to do

1. **Resolve the issue number.**
   - Given (`#42` → `42`): use it, whatever labels it carries.
   - Not given: claim from the queue.
     ```
     gh issue list --search "label:ready -label:in-progress -label:failed -label:ready-to-merge -label:ready-to-review sort:created-asc" --state open --json number,title --limit 20
     ```
     Walk it oldest-first and take the first issue with no open blockers, checking each with `gh api repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by --jq '[.[] | select(.state == "open") | .number]'`. Skip a blocked one and leave its labels alone. If the query returns nothing, or every candidate is blocked, say the queue is empty and stop; never fall back to unlabelled issues. Keep the candidate list for step 3.

   Never reserve an issue by editing labels. The pipeline claims it by pushing the `epic/<N>-<slug>` ref, and a run that loses that race refuses on its own.

2. **Launch the pipeline.** It lives in the harness checkout, not this project. Resolve `echo "$CLAUDE_HARNESS_DIR"` to an absolute path, then run:

   ```
   node "$CLAUDE_HARNESS_DIR/workflows/epic-run.mjs" --issue <N>
   ```

   Run it with Bash `run_in_background: true` and poll until the process exits; an epic outlasts the foreground timeout. Its last line is `RESULT <json>`. Exit codes: `0` shipped or held, `2` skipped, `3` blocked, `1` usage error or crash.

3. **Report the outcome and exit.** From the `RESULT` JSON:
   - **Queued for merge** (`readyToMerge: true`): report the PR URL and `git diff origin/main...HEAD --stat`, and say the issue is now `ready-to-merge`. Do not merge it and do not wait for the merge worker; a failure there lands on the issue as `failed`, not here.
   - **Held for review** (`prUrl` with `mergeSkipped`): report the PR URL and the `mergeSkipped` reason verbatim. The issue stays `ready-to-review`; merging is the user's step. Do not merge it.
   - **Skipped** (`skipped: true`): nothing ran and nothing changed. Relay the reason. In queue mode, go back to the candidate list and launch the next unblocked issue, reporting each skip as you go; when the list runs out, say the queue is empty and stop. With an explicit number, stop.
   - **Blocked** (`blocked: true`): report the phase and reason; both are already commented on the issue. A block that carries a PR URL means the change is complete and open but a later step failed: say so, and never merge it or push a fix from here. Do not retry.

## Recovery

- Re-running `/epic #N` resumes a leftover `epic/<N>-*` branch after rebasing it onto `origin/main`; a branch that already carries a code checkpoint skips implementation and goes through the verify gate and review. Its structured architecture artifact preserves the review plan; when that artifact is missing or invalid, a read-only architecture pass reconstructs the plan without replaying code. Delete the branch locally and on origin to force a fresh build.
- Partial work without a code checkpoint gets a direct continuation plan: preserve the existing edits and tests, finish implementation, then pass verify and review. A fresh RED baseline is not required for already interrupted coding.
- A run that died before its first checkpoint left only the claim commit, so a re-run refuses it as `claimed by another run`. Release it with `git push origin --delete epic/<N>-<slug>`, or wait for `bin/reap.sh` to collect it.
- A run that already opened a PR is skipped by any re-run. Finish that PR by hand, unless the issue carries a fixer queue label: `needs-judgment` belongs to `/fix-conflict`, `needs-ci-fix` to `/fix-ci`.
- Manual mode: `node "$CLAUDE_HARNESS_DIR/workflows/epic-run.mjs" --slug <slug>` builds from an existing `.epics/<slug>/requirements.md` on the current tree, with no git and no PR.
