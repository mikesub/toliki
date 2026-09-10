# Toliki workflow

This is a flow map and navigation index, not another implementation manual.
Detailed contracts, schemas, limits and failure ordering live with the
[owners below](#contract-owners). [DOCTRINE.md](DOCTRINE.md) records why those
choices were made; [AGENTS.md](AGENTS.md) governs changes and live-host safety.

## At a glance

```text
ready
  -> prepare -> architect -> code + verify -> independent review
  -> repair + verify -> final review                 (when findings need it)
  -> scoped correction + verify + narrow confirmation (when authorized)
  -> ship PR -> computed merge gate -> merge worker -> main

ready + task
  -> shared prepare -> tasker implements + self-reviews -> verify
  -> shared candidate + handoff -> merge worker -> main
```

An epic buys independent review; a task explicitly trades that review away.
Issue runs deliver a PR or stop with a quota hold, skip, blocker or error;
manual slug mode publishes nothing. A run never merges its own PR, and there
is no separate delivery-prose model step.

Within one epic/task invocation, compatible writable calls share builder
context. Judging calls remain fresh and read-only; standalone fixer calls
remain ephemeral. The conversation contract is in
[runtime](workflows/lib/runtime.mjs), not a second set of rules here.
Step-to-charter boundaries and vendor/model/effort routing are defined by
[engine](workflows/lib/engine.mjs) and [engines.json](etc/engines.json).

## Sessions and durable state

Pipeline sessions use `<repo>-epic-<N>` for epic, task and all fixers. Their
tmux pane runs a plain Node orchestrator, displays the phase log and ends with
`RESULT <json>`; it has no interactive steering channel. Interactive sessions
are normal remotely controlled Claude sessions. Do not confuse the two.

The source issue holds the specification, append-only delivery/audit records
and a mutable live status comment.
An `epic/<N>-<slug>` ref is the durable claim and recovery branch; the PR is
the technical diff/check surface. Worktrees isolate runs. Local conversation
ids are disposable, not resume records.

Lifecycle labels are automation-owned:

| Label | Resting meaning |
| --- | --- |
| `ready` | Queued new/resumable work |
| `in-progress` | A claimed or admitted run is working |
| `ready-to-merge` | PR eligible for the unattended merge worker |
| `ready-to-review` | PR held for a human, unless an authorized defect fixer owns its blockers |
| `failed` | Blocked; may also carry a bounded fixer queue |
| `needs-judgment` | Conflict-fixer queue beside `failed` |
| `needs-ci-fix` | CI-fixer queue beside `failed` |
| `needs-defect-fix` | Legacy/manual defect-repair queue beside `ready-to-review` |
| `fix-attempted` / `fix-retried` | Conflict attempt ladder |
| `ci-attempted` / `ci-retried` | Independent CI attempt ladder |
| `defect-attempted` / `defect-retried` | Independent defect attempt ladder |

The persistent human-selected `task` label chooses the task workflow;
`engine:<name>` pins routing. Neither is a lifecycle label. Closing the issue
is the normal consequence of merging its `Closes #N` commit.
[Issue tracking](skills/spec/ISSUE-TRACKING.md) owns filing and dependency rules.

## Lightweight task path

[task-run.mjs](workflows/task-run.mjs) owns the one primary tasker and its
single permitted verification-diagnostics repair. It intentionally has no
architect, RED/GREEN orchestration, independent review or correction.
Invalid output and process failures do not purchase another tasker.

Task shares claim, engine pin, interrupted-branch preparation, dependencies,
candidate creation and terminal handoff with epic. If a resumed branch needs
conflict integration, the ordinary primary tasker does that and completes the
task in the same call. Its delivery record explicitly states the missing
independent review; later fixers preserve that disclosure.

## 1. Prepare

[dispatch](bin/dispatch.sh) selects an eligible issue;
[launch](bin/launch.sh) owns slot admission and its worktree.
[issue-delivery](workflows/lib/issue-delivery.mjs) owns preflight, claim/resume,
engine pin, requirements capture and dependency preparation for both workflows.

A saved branch is rebased onto captured current main. A conflict can enter
[bounded resume recovery](workflows/lib/resume-recovery.mjs): aggregate the
checkpoint chain, integrate a remaining stop, preserve both sides' evidence,
then continue through the ordinary gates. An epic may spend one narrow
recovery call; task uses its ordinary primary call. Unsafe recovery preserves
work and terminates instead of repeatedly refusing the same queued branch.

Package discovery and dependency installation wait for conflict settlement.
For their ordering and failure behavior, read `prepareIssueDelivery` and
`finishIssuePreparation`; recovery can run before package discovery completes.
Manual `--slug` mode skips issue preparation and uses existing local
requirements without publishing to GitHub.

## 2. Architect

[epic-run.mjs](workflows/epic-run.mjs) owns the architecture schema and phase.
Architecture selects a proportional direct or test-first plan. Partial work
continues directly; a completed code checkpoint reuses its plan/delivery
artifacts or reconstructs missing ones read-only, without replaying coding.

## 3. Code

[epic-run.mjs](workflows/epic-run.mjs) owns baseline/RED/GREEN orchestration,
direct implementation, delivery-record validation and coding retries.
[repo.mjs](workflows/lib/repo.mjs) owns actual verification and checkpoints.

The orchestrator must establish meaningful RED evidence for test-first, and
must establish green after implementation in either mode. A builder's report
is not the gate. Verification evidence includes the actual command, status,
full wall duration and bounded output, including waits after assertions finish.

## 4. Review

[epic-run.mjs](workflows/epic-run.mjs) owns the single broad review, finding
ledger and read-only state-integrity checks. Its reviewer gets the requirement,
actual diff and verification evidence, plus preserved integration context on
recovered branches, but no builder narrative. An empty valid finding list is
different from a dead reviewer.

## 5. Repair

The `fixes-after-review` phase in [epic-run.mjs](workflows/epic-run.mjs)
requires an indexed disposition for every finding, applies the verification
gate and captures the exact repair delta. The builder may repair, dispute with
code evidence or defer unsafe work; it cannot clear its own findings.

## 6. Final review

[epic-run.mjs](workflows/epic-run.mjs) owns the final-review schema, invocation
conditions and conversion of its verdicts into merge blockers. This is the
repair's independent acceptance check, not another broad pre-repair review.
It judges every original finding, repair regressions and unmet requirements
from the code and captured deltas, not the fixer's explanation.

## 7. Correction

[repair-acceptance.mjs](workflows/lib/repair-acceptance.mjs) is the shared
acceptance/correction/confirmation contract. Epic's adapter lives in
[epic-run.mjs](workflows/epic-run.mjs). A complete batch of positively proved
implementation defects can earn one scoped correction and narrow confirmation;
uncertainty or a human decision cannot. This is not a loop or another whole
fixer run.

## 8. Ship

[issue-delivery.mjs](workflows/lib/issue-delivery.mjs) owns candidate formation;
[epic-run.mjs](workflows/epic-run.mjs) owns the epic's delivery summary,
deferrals and follow-up publication. All judgment is collected before ship.

Shipping refreshes main before squashing and re-verifies a clean moved base.
A conflicting rebase or failed fetch leaves merge-time integration to the
worker. The candidate commit carries the rationale and closing link.
Irreversible GitHub artifacts follow PR creation and confirmed delivery
summary, so an ordinary pre-PR retry cannot duplicate them.

## 9. Merge gate

[epic-run.mjs](workflows/epic-run.mjs) computes eligibility from structured
review/correction results. [github.mjs](workflows/lib/github.mjs) owns terminal
transitions, readbacks and their shared reporting budget.

Clear evidence permits `ready-to-merge`; remaining blockers hold the PR at
`ready-to-review`. An unconfirmed promotion must not remain a merge
authorization. Epic-run no longer queues `needs-defect-fix`: the eligible
concrete-defect case gets correction inside the invocation.

## 10. Merge worker

[merge-worker.sh](bin/merge-worker.sh) owns the serial per-repo drain, rebase,
exact-head CI gate and pinned squash merge.
[merge-autoresolve.sh](bin/merge-autoresolve.sh) owns containment-proven
mechanical conflict resolution.

Judgment conflicts and red checks enter their respective bounded repair queues.
A readable empty rollup after registration grace supports no-CI repositories;
unreadable results are not green. Every published check and the merge must
refer to the same candidate SHA.

## Repair and re-entry workflows

All three fixers share [fixer-lifecycle.mjs](workflows/lib/fixer-lifecycle.mjs)
for sequencing repair, verify, acceptance, optional correction/confirmation and
the call into publication. Each cause adapter owns its publication implementation
and evidence ordering. The lifecycle also distinguishes operational retry from
semantic human hold; [fixer-finalize.mjs](workflows/lib/fixer-finalize.mjs)
implements terminal labels and quota refunds. Keep shared execution/finalization
contracts there, not copied into each cause adapter.

Their standalone acceptance call may replace one mechanically invalid checker
answer once. JSON shape and exact coverage/identity/consistency diagnostics
share that single answer-repair budget against the same captured diff,
verification and protected Git snapshot; a second invalid answer is human-held,
while a valid negative or uncertain judgment is never retried toward approval.
[runtime.mjs](workflows/lib/runtime.mjs) owns the opt-in spawn budget and
[repair-acceptance.mjs](workflows/lib/repair-acceptance.mjs) owns the structural
classification. Task and other model calls retain their existing budgets.

| Workflow | Cause-specific owner |
| --- | --- |
| Judgment-conflict fixer | [fix-run.mjs](workflows/fix-run.mjs): captured conflict sides, mechanical resolution, scripted rebase settlement and partial-conflict evidence |
| CI fixer | [ci-run.mjs](workflows/ci-run.mjs): failing-check/log capture and local reproduction |
| Defect fixer | [defect-run.mjs](workflows/defect-run.mjs): authenticated head-bound evidence, partial-evidence refresh and landing-only recovery |

Defect repair remains for evidence older runs published and explicit manual
launches; automatic admission is per-repo opt-in. Complete repairs return to
the merge worker for fresh checks. Verified partial repairs preserve useful
work but remain human-held. Each fixer's durable attempt ladder is independent
of in-run repair/correction calls.

## Run telemetry and usage report

[usage.mjs](workflows/lib/usage.mjs) owns host-local spawn and run-lifecycle
records; [usage-report.mjs](workflows/usage-report.mjs) owns filters, attribution,
cost and handoff calculations. `./toliki usage` displays per-step model-active
time and issue-lifetime outcomes separately. A telemetry failure cannot change
a pipeline gate. Incomplete runs and unknown prices are not invented successes
or zero costs.

## Shared failure behavior

- [runtime.mjs](workflows/lib/runtime.mjs): timeouts, permitted schema/transient
  respawns, conversation fallback, concurrency and signal forwarding.
- [quota-hold.mjs](workflows/quota-hold.mjs): validated vendor holds and admission;
  [issue-delivery.mjs](workflows/lib/issue-delivery.mjs) and
  [fixer-finalize.mjs](workflows/lib/fixer-finalize.mjs): preservation/refunds.
- [github.mjs](workflows/lib/github.mjs): readback, terminal-state exclusivity and
  the reporting window that forbids further model calls.
- [reap.sh](bin/reap.sh): liveness, settle windows and positive staleness proofs
  before collecting sessions, claim refs or worktrees.

## Contract owners

Use this index to find the **one detailed home** for a contract. Read the
owning implementation, its adjacent comments and tests; the summaries above
are navigation, not extra gates.

| Contract | Authoritative home |
| --- | --- |
| Work slicing, issue relationships and filing | [ISSUE-TRACKING.md](skills/spec/ISSUE-TRACKING.md) |
| Laptop CLI, registry and host boundary | [operator/lib.sh](operator/lib.sh) and the selected `operator/<command>.sh` |
| Host configuration values/validation | [repos.conf.template](etc/repos.conf.template), [etc/lib.sh](etc/lib.sh); installed default format in [dispatch.cron](etc/dispatch.cron) |
| Session admission and worktree creation | [launch.sh](bin/launch.sh) |
| Queue selection | [dispatch.sh](bin/dispatch.sh) |
| Shared claim, engine pin, candidate and issue preservation | [issue-delivery.mjs](workflows/lib/issue-delivery.mjs) |
| Interrupted checkpoint integration | [resume-recovery.mjs](workflows/lib/resume-recovery.mjs) |
| Epic sequencing, schemas and merge-blocker calculation | [epic-run.mjs](workflows/epic-run.mjs) |
| Lightweight task economy and result validation | [task-run.mjs](workflows/task-run.mjs) |
| Shared fixer execution and terminal finalization | [fixer-lifecycle.mjs](workflows/lib/fixer-lifecycle.mjs), [fixer-finalize.mjs](workflows/lib/fixer-finalize.mjs) |
| Repair verdicts, correction and confirmation | [repair-acceptance.mjs](workflows/lib/repair-acceptance.mjs) |
| Read-only judging state snapshots | [judged-state.mjs](workflows/lib/judged-state.mjs) |
| Authenticated defect evidence | [defect-evidence.mjs](workflows/lib/defect-evidence.mjs) |
| Run-local blocker identity | [blocker-identity.mjs](workflows/lib/blocker-identity.mjs) |
| Evidence capture/rendering | [evidence.mjs](workflows/lib/evidence.mjs); diff/CI transport in [repo.mjs](workflows/lib/repo.mjs) and [github.mjs](workflows/lib/github.mjs) |
| Git, package discovery and verification | [repo.mjs](workflows/lib/repo.mjs) |
| GitHub writes, readback and terminal budget | [github.mjs](workflows/lib/github.mjs) |
| Model phase execution and process cleanup | [runtime.mjs](workflows/lib/runtime.mjs), [proc.mjs](workflows/lib/proc.mjs) |
| Vendor invocation and project instruction discovery | [engine.mjs](workflows/lib/engine.mjs) |
| Standing role rules / response shape / per-call task | [agents/](agents/) / calling phase's schema / [prompts/](workflows/prompts/) (task's ordinary prompts are inline) |
| Provider quota admission holds | [quota-hold.mjs](workflows/quota-hold.mjs) |
| Usage records / report semantics / model pricing | [usage.mjs](workflows/lib/usage.mjs) / [usage-report.mjs](workflows/usage-report.mjs) / [prices.mjs](workflows/lib/prices.mjs) |
| Operator time formatting | [etc/lib.sh](etc/lib.sh), [time.mjs](workflows/lib/time.mjs) |
| Setup and shared-content registration | [operator/setup.sh](operator/setup.sh), [provision.sh](bin/provision.sh), [wire-claude-content.sh](etc/wire-claude-content.sh) |
| Merge, mechanical conflict resolution and cleanup | [merge-worker.sh](bin/merge-worker.sh), [merge-autoresolve.sh](bin/merge-autoresolve.sh), [reap.sh](bin/reap.sh) |

A change to behavior updates its owner and only the affected map or rationale.
Do not append another full contract to AGENTS, README or every source header.
