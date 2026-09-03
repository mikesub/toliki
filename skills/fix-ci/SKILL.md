---
name: fix-ci
description: "Autonomous red-check fixer: `/fix-ci #N` takes a `needs-ci-fix` issue (a finished epic whose PR came back red on its checks after the merge worker rebased it), reads the failing job logs, repairs the cause, re-verifies, adversarially checks the fix, amends the branch and lands the issue back on ready-to-merge. An issue number is required; on the host, dispatch launches it."
disable-model-invocation: true
---

Launch the autonomous `ci-run` pipeline for a `needs-ci-fix` issue and report what it returned. It exits at `ready-to-merge` or at a blocker comment. It never merges: the merge worker rebases the PR onto current main and re-runs the real checks before anything lands, which is what makes returning it to the unattended queue safe — a fix that is still red cannot merge. It escalates instead of guessing: a failure no code change here can fix (infrastructure, a missing secret, a flake), a red `npm run verify` after the fix, or a refuted adversarial check leaves the issue `failed` with the reason.

Request: $ARGUMENTS

## What to do

1. **Resolve the issue number.** Required (`#42` → `42`). There is no queue mode: dispatch owns the `needs-ci-fix` queue, so a bare `/fix-ci` stops and asks for an issue number.
2. **Launch the pipeline.** It lives in the harness checkout, not this project. Resolve `echo "$CLAUDE_HARNESS_DIR"` to an absolute path, then run with Bash `run_in_background: true` and poll until it exits:

   ```
   node "$CLAUDE_HARNESS_DIR/workflows/ci-run.mjs" --issue <N>
   ```

   Its last line is `RESULT <json>`. Exit codes: `0` fixed, `2` skipped, `3` blocked, `1` usage error or crash.
3. **Report the outcome and exit.** From the `RESULT` JSON:
   - **Fixed** (`readyToMerge: true`): report the PR URL, which checks had been red (`failedChecks`), the `cause` the fixer named, `checkConfidence`, and that the issue is back on `ready-to-merge` for the merge worker. Do not merge anything yourself.
   - **Skipped** (`skipped: true`): nothing ran. Relay the reason. `refusalFinal: true` means the refusal is already commented on the issue, which stays `failed` for a human.
   - **Blocked** (`blocked: true`): report the phase and reason, already commented on the issue. `attempt: 1` means dispatch retries once on its own after the session is reaped; `attempt: 2` means the ladder is exhausted and a human decides. Do not retry from here.

## Recovery

A blocked or killed CI fixer leaves the PR branch on origin as it found it, so re-running is always safe; `./remote-control.sh ci N` is the manual override. To take an issue away from the fixer, strip `needs-ci-fix`. To grant a fresh pair of attempts after the ladder is spent, strip `ci-attempted` and `ci-retried`.
