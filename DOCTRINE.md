# Why toliki exists

Typing code is no longer the constraint; deciding what to build and checking
what comes back is. The harness splits those two jobs and puts a durable queue
between them: a human writes specs, a VPS builds them unattended. `AGENTS.md`
and the script headers say how the pieces work; this file says why they have
this shape, and records what was considered and turned down — so rejections
don't get re-litigated from memory.

## What it does

- **`/spec`** — an interactive design conversation that ends as GitHub issues,
  each a complete definition of done, labeled `ready`. The only human gate in
  the system.
- **Build** — cron dispatches one detached run per unblocked `ready` issue: a
  plain Node orchestrator that walks a fixed sequence — architecture →
  red-green TDD → blind review → fixes after review → an open, green PR —
  spawning one short-lived headless agent process per judgment. The issue body
  is the only requirement the run is judged against; nobody answers follow-up
  questions at 3 a.m., so a spec that needs clarification is a spec that fails.
- **The pipeline outlives its engine.** Every phase is a process behind one
  adapter, so which vendor's CLI runs an epic is a routing value, not an
  architecture. That is worth the orchestration we now own outright (a
  concurrency gate, timeouts, signal forwarding, and the whole deterministic
  half below — under test): the alternative was writing the pipeline twice,
  once per vendor, and watching the copies drift. It also moves the merge gate
  and the fail-closed branches out of a vendor's runtime and into ordinary code
  we can run in a test harness.
- **Review** — blind and adversarial. Five lenses judge the diff against the
  issue body alone, barred from the builder's notes; every finding goes to a
  skeptic instructed to refute it; survivors are auto-fixed, refuted ones
  recorded as unconfirmed rather than deleted, and the fixes get one pass from
  the same skeptic — a fix it cannot confirm holds the PR instead of starting
  another round inside the same epic. A hold made entirely of concrete defects
  may enter a separate, label-bounded defect-fixer session in repositories that
  explicitly opt in; uncertainty still goes directly to a human. The strong
  model goes to design and adjudication, where being wrong is expensive;
  implementation runs on a cheaper model under the test gate.
- **Merge** — a serial per-repo worker rebases each finished PR onto current
  `main`, gives checks a short registration window, waits for every published
  check on the rebased head, then squash-merges. An empty check rollup after
  that window is the supported no-CI case: there is no result to invent, while
  every check a repo does publish remains binding.
  Serial is not caution: every merge invalidates every other PR's green, so
  there is no parallelism to be had. Its two decline classes that a machine can
  own — a judgment-class conflict and a red check — go to fixer runs rather
  than to a human, each under an adversarial check and each bounded by one
  retry.
- **Repair is a new bounded session, never an in-run loop.** Conflict, CI and
  ship-gate defect repair each have an independent two-attempt ladder in
  GitHub labels. The defect rung is additionally per-repo opt-in because it
  changes an already reviewed PR and returns it to unattended eligibility. It
  may do that only from a durable named-defect envelope authored by the
  automation identity and bound to the selected PR head. Epic-run verifies the
  envelope before queueing; the fixer rejects mutable issue prose, stale heads
  and fork PRs before spending an attempt. After the project verify gate and a
  blind adversarial check over the complete delta, the merge worker still
  rebases and re-runs the real checks before landing it.
- **Crons watch, models act.** Dispatch, reap and merge ticks are plain shell
  reading labels; the first model to run is the epic that got launched.
- **Models judge, the script acts.** The same split inside a run. Everything
  deterministic — the claim, the labels, the checkpoints, the squash, the push,
  the PR, the follow-up issues, the layout discovery, `npm run verify` — is the
  orchestrator's own work, so what a run did is a fact it established rather
  than a claim a model reported. Models are spawned only where a judgment is
  needed: the design, the code, the review lenses and their skeptic, the fixes,
  what the PR says. The rule that falls out of it: an agent's word that it ran
  a gate is never the gate. Verify is red after the red step and green after
  the green one because the orchestrator ran it, not because a step said so.
- **State is GitHub.** Issues, lifecycle and engine-routing labels,
  `blocked_by` edges, claim refs, PRs.
  Workers are disposable: kill any run at any moment, re-run without cleanup.
- **One contract per project.** A package is a directory whose `package.json`
  declares `scripts.verify`; everything the project wants gated goes inside
  that script. The pipeline discovers the rest from the repo itself.

## What it doesn't

- **No steering.** A run is a script, not a conversation; the only lever is
  kill. A run that needs nudging is nearly always a spec that needed another
  round of questions. This is now structural rather than merely discouraged: a
  pipeline session holds no interactive agent, so there is no input channel to
  type into. The cost is knowing: watching a run means reading its pane, not
  attaching to it from a phone. Traded on purpose — see "Steerable live
  workers" below, which this only sharpens.
- **No model gates.** Whether a PR merges is counted in code from structured
  values. A model asked "should this merge?" while holding a finished PR can
  talk itself past a slow gate.
- **No cheerful defaults.** "Couldn't check" never becomes "fine": a dead
  review lens blocks the run, an unreadable CI conclusion fails the merge, a
  lost verdict is written down for a human. A gate that lies is worse than no
  gate. An empty, readable check rollup is different: after the registration
  grace it means this repo publishes no CI, so there is no check verdict to
  invent; any check that does register remains binding.
- **No stub gates**, same reason. A repo with no database tier doesn't get a
  `test:db: exit 0` stub for uniformity's sake — that writes a green result
  into merged PRs for a check that doesn't exist.
- **No per-project config here.** A config file restates facts the repo
  already declares and goes stale silently. `etc/repos.conf` carries only
  what can't be discovered: clone paths and machine facts.
- **No project rules here.** Compliance, deploy policy, conventions live in
  each project's own `AGENTS.md` and `.claude/rules/`; the harness asserts
  only what is universal.
- **No shared-resource guards here**, though the harness does assert the
  constraint that makes them necessary: a verify run owns its worktree and
  nothing else, and it runs concurrently with other worktrees and other repos
  on one box. Guarding what it reaches outside — fixed ports, container names,
  `/tmp` paths, shared fixtures — stays in the project. There is nothing to
  centralize: the tier is invoked by an agent mid-session, not by any harness
  script, so the only thing the harness could lock is a whole session, which
  gives back exactly the parallelism it exists to provide. And the project has
  to stay correct where the harness doesn't exist — CI, a laptop — which a
  guard living in `toliki` cannot do. The constraint is universal, so it is
  stated here; the guard is local, so it is written there.

## From Yegge's *The Shape of Things to Come* (Aug 2026)

Wheelhouse runs far past our scale; some of its ideas are load-bearing here
and some were declined on purpose.

Taken:

- **Producer/consumer with a durable queue.** His crew designs, his fleet
  implements. Here: `/spec` on the laptop, the `ready` label as the queue,
  the VPS draining it. Everything else is downstream of this.
- **"Crons watch, models act."** Cheap pollers detect; expensive judgment
  wakes only when there's something to judge.
- **Design out the drudgery.** His crew idled while builds landed; our
  version is the merge worker — an epic ends at "PR open, green" instead of
  holding a build slot while waiting its turn to merge.
- **Identity as durable record, not live process.** What persists is the
  issue, the branch, the PR; the worker is disposable.
- **Never falsify the record** — sharpened into the gate-that-lies rule
  above.

Declined:

- **Land Rush** (everything onto main, sort out the wreckage) is right at
  175–250 commits/day against a 30-minute build. We're orders of magnitude
  below; a red main costs more than the serialization saves.
- **Laurels** (recognition feeding back to agents) needs persistent seats to
  accrue to. Our workers are disposable; there's nowhere for one to land.
- **Beads as the tracker.** Its value is a rich dependency graph; we run a
  deliberately flat issue model (`skills/spec/ISSUE-TRACKING.md` is
  authoritative), GitHub is readable by colleagues without learning a new
  tool, and `blocked_by` is the one ordering primitive we need.
- **Stacked PRs.** Tried; the rebases cost more than the parallelism gained.
  Epics branch from fresh `origin/main` and wait on `blocked_by`; `/spec`
  slices wide rather than deep, because an edge serializes a slice through
  the blocker's entire build–PR–CI–merge cycle.
- **Steerable live workers.** Traded knowingly for deterministic, resumable
  scripts — see "No steering."

## The rest

- `AGENTS.md` — the working rules, the glossary, and the traps the code cannot
  show; the script headers in `bin/` and `workflows/` hold the rest.
- `skills/spec/ISSUE-TRACKING.md` — authoritative on how work is sliced and
  filed.
