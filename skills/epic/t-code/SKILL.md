---
name: t-code
description: Implement a local epic spec or repair selected review findings in its isolated worktree, run project verification, and write .epics/title/code.md without committing or shipping.
---

Read the [shared contract](EPIC-CONTRACT.md). Locate the workspace with
`status`; read `spec.md`, applicable project instructions, and `architecture.md`
when present. A user invoking t-code authorizes implementation of the settled
scope; a separate architecture document is optional. Resolve material open
decisions before dependent work, while continuing independent work when useful.
For a prewritten spec without a workspace, use `start` from main and preserve/
copy the spec as described in the contract.

Inspect the current diff and handovers to resume without overwriting existing
work. Install dependencies as the project documents. Discover the full verify
command and run it through the shared `verify` helper before implementation;
discuss pre-existing failures with the human before relying on that baseline.
Ignored local settings are not copied automatically.

Implement the requested scope directly. Follow an agreed architecture, and
raise meaningful deviations for discussion. Add regression coverage for changed
behavior and run focused checks during development. Never weaken tests to make
the result pass or refactor unrelated code.

If the user authorizes parallel coders, give them independent units with
exclusive file ownership and complete briefs. Wait for every coder to finish
before full verification. You run the full verification command yourself
through the shared helper; a subagent's report is not that evidence.

Repair failures within the requested scope and verify again. After two
unsuccessful repair attempts against the same failure, report the evidence and
diagnosis for the human to decide. Do not turn a failed check into an accepted
baseline or a completed handover.

For review repairs, read `review.md` and implement the findings selected by the
human. Record each finding's change or evidence for a dispute; do not rewrite
the review or declare your own repairs independently accepted.

Update `code.md` with the scope completed, key decisions, changed files, the
actual verification command/result and snapshot from the helper, repair
dispositions when applicable, deviations and outstanding work. Keep human
decisions distinguishable from your proposals. Report that handover and stop;
do not invoke t-review, stage, commit, or t-ship.
