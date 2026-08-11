# Why toliki exists

Typing code is no longer the constraint; deciding what to build and checking
what comes back is. The harness splits those two jobs and puts a durable queue
between them: a human writes specs, a VPS builds them unattended. `CLAUDE.md`
says how the pieces work; this file says why they have this shape, and records
what was considered and turned down — so rejections don't get re-litigated
from memory.

## What it does

- **`/spec`** — an interactive design conversation that ends as GitHub issues,
  each a complete definition of done, labeled `ready`. The only human gate in
  the system.
- **Build** — cron dispatches one detached Claude Code session per unblocked
  `ready` issue. The session runs a deterministic workflow: architecture →
  red-green TDD → review → triage → an open, green PR. The issue body is the
  only requirement the run is judged against; nobody answers follow-up
  questions at 3 a.m., so a spec that needs clarification is a spec that
  fails.
- **Review** — blind and adversarial. Five lenses judge the diff against the
  issue body alone, barred from the builder's notes; every finding goes to a
  skeptic instructed to refute it; survivors are auto-fixed, refuted ones
  recorded as unconfirmed rather than deleted. The strong model goes to design
  and adjudication, where being wrong is expensive; implementation runs on a
  cheaper model under the test gate.
- **Merge** — a serial per-repo worker rebases each finished PR onto current
  `main`, waits for checks to re-run on the rebased head, squash-merges.
  Serial is not caution: every merge invalidates every other PR's green, so
  there is no parallelism to be had.
- **Crons watch, models act.** Dispatch, reap and merge ticks are plain shell
  reading labels; the first model to run is the epic that got launched.
- **State is GitHub.** Issues, labels, `blocked_by` edges, claim refs, PRs.
  Workers are disposable: kill any run at any moment, re-run without cleanup.
- **One contract per project.** A package is a directory whose `package.json`
  declares `scripts.verify`; everything the project wants gated goes inside
  that script. The pipeline discovers the rest from the repo itself.

## What it doesn't

- **No steering.** A run is a script, not a conversation; the only lever is
  kill. A run that needs nudging is nearly always a spec that needed another
  round of questions.
- **No model gates.** Whether a PR merges is counted in code from structured
  values. A model asked "should this merge?" while holding a finished PR can
  talk itself past a slow gate.
- **No cheerful defaults.** "Couldn't check" never becomes "fine": a dead
  review lens blocks the run, an unreadable CI conclusion fails the merge, a
  lost verdict is written down for a human. A gate that lies is worse than no
  gate — an absent check is a known hole; a lying one is trusted exactly when
  it matters.
- **No stub gates**, same reason. A repo with no database tier doesn't get a
  `test:db: exit 0` stub for uniformity's sake — that writes a green result
  into merged PRs for a check that doesn't exist.
- **No per-project config here.** A config file restates facts the repo
  already declares and goes stale silently. `etc/repos.conf` carries only
  what can't be discovered: clone paths and machine facts.
- **No project rules here.** Compliance, deploy policy, conventions live in
  each project's own `CLAUDE.md` and `.claude/rules/`; the harness asserts
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

- `CLAUDE.md` — how every piece works today, including the operational traps.
- `skills/spec/ISSUE-TRACKING.md` — authoritative on how work is sliced and
  filed.
