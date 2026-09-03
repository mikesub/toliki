---
name: fix-conflict
description: "Autonomous judgment-conflict fixer: `/fix-conflict #N` takes a `needs-judgment` issue (a finished epic whose PR the merge worker declined on a judgment-class rebase conflict), rebases the PR onto current main, resolves the judgment hunks under an adversarial check, re-verifies, force-pushes, and lands the issue ready-to-review. An issue number is required; on the host, dispatch launches it."
disable-model-invocation: true
---

Launch the autonomous `fix-run` pipeline for a `needs-judgment` issue and report what it returned. It exits at `ready-to-review` or at a blocker comment. It never merges and never lands `ready-to-merge`: promoting is a human's call, and the merge worker re-runs CI before anything lands. It escalates instead of guessing and never fixes code: a resolution that cannot show both sides' intent surviving, a red `npm run verify`, or a refuted check leaves the issue `failed` with the reason.

Request: $ARGUMENTS

## What to do

1. **Resolve the issue number.** Required (`#42` → `42`). There is no queue mode: dispatch owns the `needs-judgment` queue, so a bare `/fix-conflict` stops and asks for an issue number.
2. **Launch the pipeline.** It lives in the harness checkout, not this project. Resolve `echo "$CLAUDE_HARNESS_DIR"` to an absolute path, then run with Bash `run_in_background: true` and poll until it exits:

   ```
   node "$CLAUDE_HARNESS_DIR/workflows/fix-run.mjs" --issue <N>
   ```

   Its last line is `RESULT <json>`. Exit codes: `0` fixed, `2` skipped, `3` blocked, `1` usage error or crash.
3. **Report the outcome and exit.** From the `RESULT` JSON:
   - **Fixed** (`readyToReview: true`): report the PR URL, `resolvedHunks` (0 means the conflict had turned mechanical or evaporated, so no judgment was exercised), `checkConfidence`, and that the issue now sits `ready-to-review`. Do not merge or promote anything.
   - **Skipped** (`skipped: true`): nothing ran. Relay the reason. `refusalFinal: true` means the refusal is already commented on the issue, which stays `failed` for a human.
   - **Blocked** (`blocked: true`): report the phase and reason, already commented on the issue. `attempt: 1` means dispatch retries once on its own after the session is reaped; `attempt: 2` means the ladder is exhausted and a human decides. Do not retry from here.

## Recovery

A blocked or killed fixer leaves the PR branch on origin as it found it, so re-running is always safe; `./remote-control.sh fix N` is the manual override. To take an issue away from the fixer, strip `needs-judgment`. To grant a fresh pair of attempts after the ladder is spent, strip `fix-attempted` and `fix-retried`.
