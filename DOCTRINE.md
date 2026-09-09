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
  the system: the human resolves open requirements and confirms the titles of
  a split into multiple issues. A single clear issue is filed immediately;
  the skill writes the bodies without requiring a prose review. The whole
  batch's bodies and dependencies are completed and read back before any
  issue enters the build queue. A human may explicitly mark a clear, low-risk,
  already-settled issue `task`; the skill never infers that choice from size.
- **Build** — cron dispatches one detached run per unblocked `ready` issue: a
  plain Node orchestrator that walks architecture → implementation → blind
  review → fixes after review → an open, green PR, spawning one short-lived
  headless agent process per judgment. Architecture chooses a proportional
  implementation plan and the evidence that proves it: `test-first` for a
  meaningful failing regression, or `direct` implementation with appropriate
  checks for changes that do not need a red/green split. An obvious edit earns
  a short plan; a one-line change with serious consequences can still need TDD.
  Neither choice skips the final project verify gate or independent review.
  Interrupted partial work continues through direct implementation; an existing
  failing test is not presented as newly established RED. The issue body is
  the only requirement the run is judged against; nobody answers follow-up
  questions at 3 a.m., so a spec that needs clarification is a spec that fails.
  Once a technical PR exists, the run appends a candidate-bound delivery
  summary to that same issue: implementation/design rationale, actual verify
  evidence, independent review outcome, remaining work, and the pre-handoff
  gate state. That record is rendered by the script, not written by a model —
  the judgment inside it was collected where it was made, the coding phase
  returning the title, commit rationale, legal marker and deferred work beside
  its own account, and the fixer deciding the follow-up for a finding it
  defers. Paying a separate model call to restate decisions the run already
  had, from a diff it would have to re-read, bought prose rather than judgment;
  what a script must never do is supply the half a model left out, so a missing
  delivery record blocks and an unwritten follow-up is simply not filed. The PR
  description stays a deterministic pointer to the issue. Later fixer audits
  and status remain separate comments instead of rewriting the immutable
  candidate snapshot.
- **Task is a deliberate economy, not a smaller epic.** `ready` plus the
  persistent `task` selector runs one writable tasker process that implements
  and self-reviews the settled issue. Deterministic code still owns the claim,
  engine pin, dependency install, full project verification, moved-base
  rebase and re-verification, candidate commit, push, PR, durable summary and
  handoff. It omits architecture, RED/GREEN orchestration, independent review,
  repair and correction. The accepted trade-off is explicit: the
  candidate is verified but intentionally not independently model-reviewed,
  so this path is only for work where a human has judged that review cost
  disproportionate. Malformed output, a tasker blocker, non-quota
  provider/process failure or timeout still blocks after that one process. A
  genuine red first verification is the bounded exception: its sanitized
  failure diagnostics go back to the SAME tasker conversation in the same
  worktree, followed by one final full verify.
  This spends at most two model processes, never applies to rebase-time verify,
  and never becomes a retry loop. A hard quota from either tasker preserves the
  work and restores `ready` with the selector and route intact. Plain `ready`
  remains the full epic workflow.
- **The pipeline outlives its engine.** Every phase is a process behind one
  adapter, so which vendor's CLI runs an epic is a routing value, not an
  architecture. That is worth the orchestration we now own outright (a
  concurrency gate, timeouts, signal forwarding, and the whole deterministic
  half below — under test): the alternative was writing the pipeline twice,
  once per vendor, and watching the copies drift. It also moves the merge gate
  and the fail-closed branches out of a vendor's runtime and into ordinary code
  we can run in a test harness. The host default chooses only an unpinned first
  claim; winning that claim snapshots the engine on GitHub before model work,
  and every resume or fixer requires the same exact pin. This deliberately makes
  GitHub label persistence and readback a hard gate: refusing an unavailable or
  ambiguous route is safer than silently retiering an existing change after a
  default changes.
- **Review** — blind and adversarial. ONE broad reviewer judges the diff
  against the issue body, barred from the builder's notes, and it is the only
  broad review the change gets. An architect-selected focused reviewer used to
  run beside it and was removed: a second pre-repair opinion bought less than
  one exhaustive acceptance check after the repair, and two broad passes over
  one diff mostly re-litigated each other. Judging is read-only, and that is enforced
  rather than trusted: Claude's reviewer charter withholds shell and
  write tools, Codex runs it in a read-only sandbox, and the orchestrator
  supplies inert diff evidence. It also snapshots the shippable worktree, index,
  Git configuration, hooks and ancestry metadata around review, final review
  and the narrow confirmation, blocking when a phase changed what it was
  judging. Orchestrator Git calls neutralize repository hooks. Their
  findings are actionable as they stand: one fixer either repairs each
  one, disputes it with code evidence, or defers it as unsafe to repair.
  Assessment and repair share that one pass rather than confirming every
  finding first, and the accepted cost is
  that a mistaken finding can consume the fixer's time and prompt an
  unnecessary edit. The adjudication is a single independent final review over
  the final tree: it decides each finding resolved, disproved or unresolved,
  and names what the repair broke and what the requirement still lacks. It is
  given the requirement, the findings, the complete diff and the exact repair
  delta, and deliberately not the fixer's explanation — agreeing with a
  narrative is not independent judgment. A builder's dismissal never clears
  itself, and uncertainty is unresolved, never a disproof. Every finding keeps
  an indexed disposition and verdict; disproved findings remain in the audit
  record. There is no second repair round: what the final review leaves open
  ends the epic at a human, because another round is a round that is not
  converging. What it may earn instead is ONE scoped correction — see the
  bounded repair contract below. The final reviewer is a fresh process that
  reconstructs its context and ends when it returns, which repeats some
  exploration and buys an adjudication that owes the previous process nothing.
  The fixer is not: it continues the run's builder conversation, so the findings
  reach the process that wrote the code instead of a stranger re-reading it.
  The strong model goes to design and adjudication, where being wrong is
  expensive; implementation runs on a cheaper model under the test gate.
- **One builder conversation per run; judgment always fresh.** A writable retry
  used to be a stranger to work that was minutes old. The verify failure, the
  review findings and the authorized correction all went to a new process that
  re-read the tree to rediscover an implementation this same run had just
  written, and paid for that rediscovery in tokens, wall time and occasionally
  in a repair that misread its own change. Inside one epic-run or task-run
  invocation the writable steps now continue one conversation. Four boundaries
  are what make that safe, and each was chosen against a cheaper alternative.
  Judgment never joins it: an architect, reviewer, final reviewer or confirmer
  that inherited the builder's account of its own work would be agreeing
  with a narrative, which is the one thing the adjudication exists not to do.
  Routing is never bent to keep talking: a phase whose `etc/engines.json` row
  differs opens its own conversation rather than being silently retiered into an
  existing one, so a mixed engine keeps two compatible builders instead of one
  wrong model. Identity is scoped to the run and the worktree and lives only in
  the running process — no cross-issue reuse, no persisted id, and no CLI ever
  asked for "its most recent session", because context from another change is
  contamination, not economy. And the prompts did not shrink: every phase still
  carries its complete captured brief, so a session a CLI never reported or can
  no longer find is dropped with a stated reason and the phase simply pays the
  old price. Reuse buys context, never correctness, and never another attempt:
  every repair, correction and retry limit is exactly what it was, task's
  two-invocation ceiling included. The standalone conflict, CI and defect fixers
  stay fully ephemeral for now — the same handle would fit their repair ladder,
  and extending it there is a separate change that has to argue its own case.
- **Repairs stay proportional.** Fix the named defect and add meaningful
  regression coverage. A review finding does not automatically require a new
  abstraction, lint rule or instruction to prevent an entire class of problems.
  Follow-up issues remain durable delivery units, filed and queued for concrete
  material work with a self-contained definition of done. Three per run is a
  ceiling, never a target; speculative hardening and accepted trade-offs do not
  earn an issue merely because more work is possible. A follow-up never clears
  an unresolved blocker in the current delivery.
- **Merge** — a serial per-repo worker rebases each finished PR onto current
  `main`, gives checks a short registration window, waits for every published
  check on the rebased head, then squash-merges with the complete subject and
  body read from that exact checked commit. Passing the message explicitly
  keeps rationale, project markers, and closing metadata independent of mutable
  PR prose and repository squash-message defaults; an unreadable or empty
  message fails closed. An empty check rollup after that window is the supported
  no-CI case: there is no result to invent, while every check a repo does publish
  remains binding.
  Serial is not caution: every merge invalidates every other PR's green, so
  there is no parallelism to be had. Its two decline classes that a machine can
  own — a judgment-class conflict and a red check — go to fixer runs rather
  than to a human, each under an adversarial check and each bounded by one
  retry. An epic already rebases onto current `main` at ship, so this rebase
  usually finds nothing left to do and a conflict here means `main` moved in
  the window between ship and merge.
- **A repair checker returns the whole worklist, and automation gets exactly one
  correction over it.** A checker that answered a global `survives` boolean and
  stopped at the first sufficient counterexample produced something automation
  could not act on: "no" is not a worklist, so every refutation cost a fresh
  whole repair that re-read the requirement, re-derived the fix and produced a
  new answer to check. The alternative is not a loop but one exhaustive answer.
  Every place Toliki independently checks a model-written repair — epic-run's
  post-review repair and the conflict, CI and defect fixers — now shares one
  contract: keep examining every original disposition and the complete repair
  delta after a refutation is found, return an exact verdict for each, and
  return the COMPLETE blocker batch. Each blocker carries a run-local identity,
  its kind, its location, concrete code evidence and the observable outcome that
  clears it, and the outcome is `clear`, `correction-required` (every blocker is
  a concrete implementation defect) or `human` (anything uncertain, unsupported,
  unsafe, or a decision rather than an implementation). Malformed, incomplete,
  duplicate, extra, ambiguous or low-confidence evidence authorizes nothing.
  On `correction-required` the current unpushed repair is preserved exactly as
  it is and one writable correction runs over the whole batch inside the
  same invocation — no cleanup, no restored queue, no consumed retry rung, no
  second whole fixer — followed by the full verification contract again and one
  narrow read-only confirmation that receives both deltas but not the
  correction's narrative. There is no second correction batch. The accepted
  trade-off is that one correction may still leave concrete work for a human:
  exhaustive batching buys automation one informed opportunity without
  recreating the hours-long review/fix loop, and exhaustive checking costs more
  than producing one refutation but replaces repeated full preparation, repair,
  verification and checker invocations.
  Semantic completion and operational relaunch are separate, and the difference
  is where the run rests. A semantic dead end — `human`, a declined or empty
  correction, a red second verification, a refused or malformed confirmation —
  removes that fixer's queue label and verifies the human-held state, so
  dispatch cannot send another complete fixer at work a correction already had
  its chance at; no spent retry label is manufactured to achieve that. Provider
  quota, process interruption, transport failure and landing-only recovery keep
  their existing refund, retry and durable-recovery behavior.
  In the epic this is why nothing queues `needs-defect-fix` any more: a hold
  made entirely of concrete defects the final review positively showed is
  exactly the case the correction takes, in the run that still has the context,
  before the PR exists. Mixed or uncertain holds never earned an automated
  repair and still go straight to a human. `defect-run` remains so durable
  evidence older runs already published stays serviceable.
- **Repair is bounded: one repair round inside the epic, then a new bounded
  session, never an unbounded loop.** Conflict, CI and ship-gate defect repair
  each have an independent two-attempt ladder in GitHub labels. The defect rung
  is additionally per-repo opt-in because it changes an already reviewed PR and
  returns it to unattended eligibility. It may do that only from a durable
  named-defect envelope authored by the automation identity and bound to the
  selected PR head. Epic-run verifies the envelope before queueing; the fixer
  rejects mutable issue prose, stale heads and fork PRs before spending an
  attempt. After the project verify gate and the exhaustive acceptance check
  over the complete delta, the merge worker still rebases and re-runs the real checks
  before landing it. What a rung may repeat is bounded the same way: an attempt
  that pushed a verified and checked repair and could not confirm the label
  swap left work to finish, but it is the LANDING, not the repair, so the next
  rung redoes only that — from its own durable head-bound record — rather than
  sending a second repair at defects that are already repaired.
  Each fixer also preserves a verified partial round instead of throwing its
  safe work away: exact indexed repaired/declined claims pass through the same
  project verify and acceptance check, then the amended branch rests at
  `ready-to-review` with its fixer queue removed. That spends the rung and
  requires a human because a decline is still unresolved; it does not erase
  repairs the human would otherwise have to repeat. Partial conflict evidence
  is likewise authenticated and bound to the amended head, with only the
  declined hunk identities and their original diff3 sides. A retained queue
  can therefore never reinterpret the already-rebased head as a clean complete
  repair; clearing both ladder labels explicitly grants one round over only
  those declines, provided main has not moved. A partial defect round reissues
  the authenticated evidence on the amended head with only declined items, so
  a human-granted later round cannot repair completed work again.
  These three sessions use one fixed-purpose lifecycle runner for the common
  repair, verify, accept, correct, confirm, failure/refund and reporting path. They are
  adapters rather than rows in a generic workflow framework: the conflict stop
  is finished by that adapter's own scripted step — markers checked, exactly
  the judgment files staged, the rebase continued once — rather than by the
  model that rewrote the text, so a claim of completion cannot advance the
  branch and a further stop blocks instead of passing as a repair; conflict
  evidence must exist before its prospective partial head is pushed, defect
  evidence can be refreshed only after the pushed head is observed, and defect
  landing-only recovery intentionally bypasses model and verification work.
  Keeping those cause-specific operations local makes their ordering visible
  while ensuring a common failure fix is maintained once. A pushed partial is
  monotonic shared state, so no later error can restore its autonomous queue.
- **Crons watch, models act.** Dispatch, reap and merge ticks are plain shell
  reading labels; the first model to run is the epic that got launched.
- **Exhausted allowance pauses admission, not work.** A provider's hard quota
  is a host condition, so the run preserves its checkpoint and returns the
  issue to its queue instead of manufacturing a project failure. The
  lock-serialized hold map pauses automatic admission only for engines that use
  the exhausted vendor, so a single-vendor engine on another provider keeps the
  box productive. A mixed engine waits on the union of its vendors and is never
  rerouted: changing who codes or reviews is a routing decision, not a queue
  optimization. Explicit manual launches remain the operator's override. The
  30-minute fallback for unparseable reset text trades bounded idle capacity on
  that vendor for avoiding a repeated failure storm.
- **Models judge, the script acts.** The same split inside a run. Everything
  deterministic — the claim, the labels, the checkpoints, the squash, the push,
  the PR, the follow-up issues, the layout discovery, `npm run verify` — is the
  orchestrator's own work, so what a run did is a fact it established rather
  than a claim a model reported. Models are spawned only where a judgment is
  needed: the design, the code, the reviewer, the fixer, the final reviewer,
  and the human delivery narrative and durable commit rationale. The script
  renders the PR linkage and factual evidence. The rule that falls out of it:
  an agent's word that it ran a gate is never the gate. Test-first establishes
  a clean baseline and requires
  the red step's expected assertion failure to appear in the orchestrator's
  verify output; a failed command or timeout is not a regression test. Both
  coding paths must finish with verify green because the orchestrator ran it,
  not because a step said so.
  The same split runs through the prompts, in both directions. Inputs: what a
  step is KNOWN to need — the issue bodies, the pinned diffs, both sides of a
  conflict and the commit subjects behind them, the CI job logs, the final
  review ledger — is captured before the call and pasted in, never named as a
  `git` or `gh` command for the step to run. A judging step has no shell to run
  one with, evidence a step fetched for itself is evidence nothing proved it
  received, and a builder and the blind checker that judges it have to read the
  same bytes or the checker refutes a repair made against something else. What
  stays open is EXPLORATION: writable steps read the tree and reviewers grep it.
  Outputs: a step returns decisions and reasons, and the script writes the
  records — the changed-file list is derived from the delta rather than copied
  from the step's account of what it touched, and the run's phase log is written
  from what each step returned rather than appended to by the steps it
  describes. A factual record maintained by the models it records is a claim,
  and one of them forgetting to write a line is a hole nothing can see.
- **Work state is GitHub.** An issue body is the specification and its
  append-only comments are the human run record; lifecycle and engine-routing
  labels, `blocked_by` edges, claim refs, and technical PRs carry the remaining
  durable state. Ephemeral machine facts stay on the
  machine: locks, usage telemetry, and the provider-quota hold that answers
  whether this host may currently admit another automatic run. The hold orders
  no issue and expires without becoming a second work database.
  Workers are disposable: kill any run at any moment, re-run without cleanup.
- **One contract per project.** A package is a directory whose `package.json`
  declares `scripts.verify`; everything the project wants gated goes inside
  that script. The pipeline discovers the rest from the repo itself.
- **One human clock, UTC machine records.** Every timestamp the harness renders
  for an operator uses one host-wide IANA zone from the machine registry,
  including the real abbreviation at that instant. Values another script must
  parse or compare stay UTC ISO 8601. A viewer elsewhere may need to convert a
  stated host time, but daylight-saving changes can never reorder durable
  records; per-user presentation was declined to keep panes, comments, cron,
  and system tools on one clock.

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
  requested reviewer blocks the run, an unreadable CI conclusion fails the
  merge, and a missing finding verdict blocks for a human. A gate that lies is worse than no
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
