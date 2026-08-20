---
name: fix-conflict
description: "Autonomous judgment-conflict fixer: `/fix-conflict #N` takes a `needs-judgment` issue (a finished epic whose PR the merge worker declined on a judgment-class rebase conflict), rebases the PR onto current main, machine-resolves the mechanical hunks, resolves the judgment hunks under an adversarial gate, re-verifies, force-pushes, and lands the issue ready-to-review. Launched by dispatch; an issue number is required."
disable-model-invocation: true
---

You launch the autonomous `fix-run` pipeline for a `needs-judgment` issue — one whose epic already finished at an open PR, but whose rebase onto current `main` hit a conflict the deterministic rung (`bin/merge-autoresolve.sh`) declined as needing judgment. **No human gates** — the run resolves, verifies, adversarially checks, pushes, and exits at `ready-to-review` or at a blocker comment.

The pipeline is a plain Node orchestrator (`workflows/fix-run.mjs`) that spawns one headless agent process per phase; you start it and report what it returns. **On the VPS this skill is not involved** — `bin/dispatch.sh` launches `bin/launch.sh --fix N`, which runs the same orchestrator directly in a session named `<repo>-epic-<N>` like any epic, one fixer per repo at a time. This skill is the manual, laptop-side entry point.

The issue carries state, not commentary. Dispatch swaps `failed` → `in-progress` at launch (shielding the session from the reaper's terminal-label sweep); the pipeline's prepare then records the attempt on the ladder — `fix-attempted` on the first run, `fix-retried` on the retry — and **refuses when `fix-retried` is already present**: one retry, then a human. The ladder never resets on success; stripping the two `fix-*` labels is how a human grants another round. The only comments the run posts are the audit record on success (files, hunks, both sides' intents, gates passed), `🤖 fix-conflict blocked` on a blocker, and `🤖 fix-conflict refused` when it must not run at all.

**The run never merges and never lands `ready-to-merge`.** Whether the original PR could merge unattended was decided before this conflict existed; a rewritten resolution resets that to "a human glances". The human promotes `ready-to-review` → `ready-to-merge`, and `bin/merge-worker.sh` re-rebases and re-runs CI on the true base before anything lands — a wrong resolution still cannot reach `main` unreviewed.

**Escalate, never guess** is the run's core boundary: a resolver that cannot state what each side intended and show both surviving leaves the PR `failed` with the reason, and the same goes for a red `npm run verify` (the fixer never fixes code) and a refuted adversarial check.

Request: $ARGUMENTS

## What to do

1. **Resolve the issue number.** It is required (`#42` → `42`). There is no queue mode: dispatch owns the `needs-judgment` queue and serializes fixers per repo — a bare `/fix-conflict` should stop with a message saying to name an issue (or let dispatch pick).
2. **Launch the pipeline.** It lives in the shared harness repo, not this project. Resolve the env var to an absolute path first (`echo "$CLAUDE_HARNESS_DIR"`), then run with Bash **`run_in_background: true`** and poll until it exits:

   ```
   node "$CLAUDE_HARNESS_DIR/workflows/fix-run.mjs" --issue <N>
   ```

   It streams a timestamped phase log, and its **last line is `RESULT <json>`** — that JSON is what you report from. Exit codes: `0` fixed, `2` skipped, `3` blocked, `1` a usage error or crash.
3. **Report the outcome and exit.** Read the `RESULT` JSON:
   - **Fixed** (`readyToReview: true`): report the PR URL, how many judgment hunks were resolved (`resolvedHunks`; 0 means the conflict had turned mechanical or evaporated — no judgment was exercised), the check confidence, and that the issue now sits `ready-to-review` — promoting it to `ready-to-merge` is the user's call, and the merge worker re-runs CI before landing. Do **not** merge or promote anything yourself.
   - **Skipped** (`skipped: true`): nothing ran. Relay the reason (closed issue, not a `needs-judgment` issue, attempt ladder exhausted, no open PR). `refusalFinal: true` means the refusal was already commented on the issue and it stays `failed` for a human.
   - **Blocked** (`blocked: true`): report the phase and reason (already commented on the issue; the branch on origin is untouched unless the block came after the push). `attempt: 1` means dispatch retries once automatically after this session is reaped; `attempt: 2` means the ladder is exhausted and a human decides. Do **not** retry from here.

## Recovery

A blocked or killed fixer leaves the PR branch on origin exactly as it found it (the force-with-lease push is the last step before labels), so re-running is always safe: dispatch relaunches on its own while the ladder has room, and `./remote-control.sh fix N` is the manual override — it produces exactly the session dispatch would have. To take an issue away from the fixer entirely (hand-resolving instead), strip its `needs-judgment` label; to grant a fresh pair of attempts after the ladder is spent, strip `fix-attempted` and `fix-retried`.
