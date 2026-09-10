# Why Toliki exists

Typing code is no longer the constraint; deciding what to build and checking
what comes back is. A human settles the specification, GitHub holds the queue,
and disposable workers implement it.

This file records **rationale and rejected alternatives**, not runtime
procedures. [WORKFLOW.md](WORKFLOW.md) maps the flows to their authoritative
implementation. [AGENTS.md](AGENTS.md) holds maintenance and live-host safety
rules; [README.md](README.md#setup) holds setup instructions.

## Design decisions

### GitHub is the durable work store

Issues are specifications; delivery and audit comments are append-only records,
while one live status comment is updated in place. Labels, dependency edges,
claim refs and PRs hold delivery state. A colleague can
inspect the work without learning another tracker. Machine-local locks,
telemetry and expiring provider holds are host facts, not a second project
database. Workers may disappear; work must remain recoverable.

Issue slicing and ordering belong to
[the filing doctrine](skills/spec/ISSUE-TRACKING.md), not another copy here.

### Models judge; deterministic code acts

A gate based on an agent saying it ran tests is a claim, not verification.
Scripts capture known evidence, run commands, validate structured answers and
publish facts. Models explore source and make the decisions that cannot be
scripted. Capturing evidence once also lets the builder and its independent
checker reason about the same bytes.

The coding phase already knows why it made the change. Asking another model
to reconstruct that rationale at ship time bought prose and re-exploration,
not a new judgment. Delivery renders the decisions already returned; it must
not invent a missing rationale or a follow-up no model proposed.

### Verification is a project contract

A project's `scripts.verify` declares what must pass; Toliki does not invent
fake uniform tiers or a per-project configuration copy. A stub green gate is
worse than an absent one. A readable empty CI rollup means something different
from an unreadable or failed check.

Verification runs concurrently across worktrees and repositories. Fixed ports,
containers, caches and fixtures are the project's responsibility to isolate or
serialize: a whole-session harness lock would sacrifice useful parallelism and
would not protect that project on a laptop or in ordinary CI.

### Epic and task are different economic choices

Epic buys independent design and review. Proportional planning permits direct
implementation where manufactured RED evidence would add little; meaningful
regressions can still justify test-first even for a small edit.

Task is a human-selected economy for settled work, not an automatic size
classification. Its verified delivery deliberately omits independent model
review. The bounded verification-diagnostics repair buys concrete feedback
without silently turning it into an epic or an open-ended retry loop.
[Task-run](workflows/task-run.mjs) owns that limit and its failure paths.

### Review must remain independent

A second broad pre-repair opinion mostly repeated exploration and
re-litigated findings. The useful second look is after repair: judge what
actually changed, account for every original finding and detect regressions.
A builder's explanation cannot disprove its own defect, and uncertainty cannot
be merge clearance. Read-only tools plus state-integrity checks enforce this
separation instead of merely asking for it.

Initial findings go directly to repair. The accepted cost is that an incorrect
finding can consume repair effort; independent adjudication then decides the
claim against code. Confirming every finding before repair spent another pass
without removing the need to inspect the repaired result.

### Reuse builder context, not reviewer conclusions

A fresh repair process used to rediscover code the run had just written.
Continuing the builder conversation saves that work. Fresh judging processes
remain blind to the builder's account. Routing is not bent to preserve a
conversation, and complete briefs make lost context a cost rather than a
correctness dependency. Identity and fallback rules live in
[runtime](workflows/lib/runtime.mjs); standalone fixer conversations are a
separate, deliberately unextended optimization.

### Bounded correction replaces repeated whole repairs

A checker that stops at one sufficient refutation produces a refusal, not an
actionable worklist. An exhaustive blocker batch gives automation one informed
correction opportunity. Concrete implementation defects can justify that
opportunity; uncertainty, scope choices and missing authority cannot.

The trade-off is explicit: bounded automation may still leave work for a human.
It must not relaunch a whole fixer merely because its authorized correction
did not converge. Operational interruption is different from semantic refusal.
The exact acceptance, correction and confirmation contract lives in
[repair-acceptance](workflows/lib/repair-acceptance.mjs), and shared sequencing
in [fixer-lifecycle](workflows/lib/fixer-lifecycle.mjs).

### Preserve useful work through interruption and partial repair

Replaying historical checkpoints can conflict even when their cumulative
change is coherent. A bounded aggregate integration preserves the original
chain and its intent without an endless queue-refusal loop or discarding
partial work. [Resume recovery](workflows/lib/resume-recovery.mjs) owns the
evidence, editing boundary and preservation contract.

Likewise, verified partial fixer work can be useful without earning unattended
merge. Preserve it with authenticated remaining-work evidence and a human hold.
When a repair was already pushed, landing-only recovery avoids repairing it
again. Cause-specific evidence and publication ordering stay in the respective
fixer adapters rather than a generic configurable workflow framework.

### Merge is serial and pinned to checked bytes

Every merge moves main and invalidates the base other queued PRs were tested
against. Per-repo serialization therefore buys real correctness, not merely
caution. Rechecking the rebased head and pinning the merge prevents a later
push from borrowing an earlier green result. The commit's own rationale must
survive mutable PR prose and repository squash defaults.

Conflict and CI repair are bounded opportunities because some concurrent
changes compose safely and some red checks have a concrete repair. A green
resolution can still be wrong, which is why deterministic checks do not replace
independent assessment of intent.

### Routing and provider quota are not interchangeable

The engine is a pinned choice of who codes and judges. A later host default
must not retier work already claimed. Refusing an ambiguous route is safer than
guessing. A provider's exhausted allowance, however, is a temporary host
condition, not a project defect: pause affected automatic admission without
rerouting candidates or stopping other providers. Explicit manual admission
remains an operator decision.

### Keep instructions at their owner

Repeated contracts drift and create conflicts between otherwise unrelated
changes. Toliki #73 needed repair over contradictory instruction/header
copies; adding yet another rule to every copy would preserve the cause.
Root instructions should route a maintainer to the relevant contract, not
restate the pipeline. Implementation comments explain local ordering and
incidents; this file preserves the architectural reasons for them.

Standing model rules, structured output schemas and per-call evidence are
different responsibilities. Editing one should not require synchronizing three
copies of the same instruction. Project-specific policy stays in the target
project, never in the harness's shared charter.

### One operator clock, canonical machine time

A single host timezone keeps pane, status and cron timestamps comparable for
the operator. Machine records remain UTC so timezone or daylight-saving changes
cannot reorder durable history. Per-user presentation was declined as
unnecessary complexity.

## Deliberate exclusions

- **No steering channel.** Pipelines are scripts, not interactive agents.
  Specifications must settle product choices before unattended execution.
- **No model sign-off gate or cheerful default.** A model's confidence cannot
  turn missing evidence into a passed command, review or CI result.
- **No per-project facts in harness configuration.** Discover what the repo
  already declares; registry values are machine facts.
- **No speculative repair scaffolding.** Repairs should be proportional.
  Follow-ups are coherent delivery units, not a target count or a way to clear
  the current PR's blockers.
- **No parallel merge within a repo.** It would reuse invalidated green results.
- **No generic workflow framework.** Shared lifecycle mechanics are useful;
  hiding cause-specific evidence and publication order in configuration is not.

## From Yegge's *The Shape of Things to Come* (Aug 2026)

Wheelhouse operates beyond our scale. We adopted the durable producer/consumer
queue, cheap cron observation before expensive model judgment, automated
landing work, disposable workers with durable records, and the refusal to
falsify those records.

We declined:

- **Land Rush:** sending everything to main and sorting out breakage fits a
  different throughput. Here, red main costs more than serialization.
- **Laurels:** persistent agent recognition needs persistent seats; our workers
  are disposable.
- **Beads:** GitHub and its one dependency primitive already serve our flat
  issue model without another tracker.
- **Stacked PRs:** tried; repeated rebases cost more than the parallelism gained.
  Independent mergeable slices are preferable to avoidable dependency chains.
- **Steerable live workers:** traded for deterministic, resumable scripts.
