# toliki project instructions

Instructions for any agent working in this repository. Claude Code reaches this
file through the pointer in `CLAUDE.md`; Codex reads it natively. Links are
relative markdown links, never `@file` includes.

## What this is

Toliki is a self-hosted coding-agent harness. A VPS turns `ready` GitHub issues
into verified pull requests using cron, tmux, git worktrees, plain Node
orchestrators and short-lived headless agent processes. Epic deliveries are
independently reviewed; explicitly selected lightweight tasks are not. There is no
daemon, database, web UI or npm dependency tree. GitHub holds durable state;
tmux holds live processes; git worktrees isolate runs.

Two session kinds exist, and they must never be conflated:

- **Pipeline sessions** (`<repo>-epic-<N>`), launched by dispatch. The pane runs
  one of `workflows/{epic,task,fix,ci,defect}-run.mjs`, which spawns one headless
  agent process per step through the engine adapter. No interactive agent wraps
  it and there is no steering channel; the only intervention is kill. Read one
  with `tmux attach` or `capture-pane`: the pane holds the whole phase log and a
  final `RESULT <json>` line.
- **Interactive sessions** (pool names, or any `-m` message): a normal Claude
  Code session started with `--remote-control`. The only place Remote Control
  applies.

## Reading order

- [DOCTRINE.md](DOCTRINE.md): why the harness has this shape and what was
  rejected, with reasons. Read it before changing the pipeline's shape, adding
  a config file, relaxing a gate or reopening a settled trade-off.
- [skills/spec/ISSUE-TRACKING.md](skills/spec/ISSUE-TRACKING.md): authoritative
  on how work is sliced and filed.
- Script and module headers. Every `bin/*.sh` and `workflows/**/*.mjs` header
  states its contract, its ordering choices and the incident behind them. The
  code and its comments are the operational manual; this file holds only what
  the code cannot show.
- [WORKFLOW.md](WORKFLOW.md): the end-to-end workflow map. Every change
  to workflow behavior must verify this document against the executable path
  and update it in the same change when the description is no longer exact.
- `etc/repos.conf.template` plus `etc/lib.sh`: the tracked configuration
  contract. `etc/repos.conf` is machine-local and gitignored; never commit it or
  overwrite the template with it.
- `etc/engines.json`: the tracked table of named engines, one
  `"<vendor>/<model>/<effort>"` row per pipeline step.

When prose and executable behavior disagree, investigate and fix the stale side
in the same change.

## Glossary

- **Epic**: one autonomous run of `epic-run.mjs` on one issue, ending at an open
  PR or a blocker comment.
- **Task**: one explicitly selected run of `task-run.mjs` on a `task`-labeled
  issue. One writable tasker implements and self-reviews; the orchestrator
  verifies and delivers without an independent model review.
- **Fixer**: a run of `fix-run.mjs` on a `needs-judgment` issue,
  `ci-run.mjs` on a `needs-ci-fix` issue, or `defect-run.mjs` on a
  `needs-defect-fix` issue. All reuse the epic's session name on purpose so
  every guard covers them.
- **Engine**: a top-level key of `etc/engines.json`, selected per issue by the
  `engine:<name>` label. An unlabeled issue uses `EPIC_ENGINE` from the
  INSTALLED `etc/dispatch.cron` (claude when that file is absent) only until its
  first successful claim, which snapshots that selection before model work.
  Dispatch ticks and manual launches read that one file rather than their own
  environments, because cron and an ssh command do not share one. Resumes and
  fixers require the exact persisted singleton; the label survives fixer
  retries. A manual launch may omit `--engine`, and then inherits — issue label,
  else host default, else claude — without writing any label.
- **Step**: one of the nine pipeline steps in `STEPS` in
  `workflows/lib/engine.mjs`, each a judgment call. Pipelines name steps; the
  engine file says who runs them; `STEPS` fixes each step's charter and tool
  boundary, so architect, review, final-review and ship stay read-only under any
  vendor. Claude's reviewer and shipper charters withhold Bash, Edit and Write;
  Codex runs the same charters in its read-only sandbox. The orchestrator
  supplies every step's captured evidence — diffs, issue bodies, conflict sides,
  CI logs, the review ledger — and also proves the worktree, index, Git
  configuration, hooks and ancestry metadata unchanged around review, final
  review and ship. Nothing deterministic is a step: git, gh and npm work runs
  in the orchestrator. `task` maps both the task workflow's primary model
  process and its optional one-time verification-diagnostics repair to the
  writable `tasker` charter.
- **Charter**: an `agents/*.md` file, read on every phase. Missing or malformed
  refuses the run.
- **Package**: a directory whose `package.json` declares `scripts.verify`. The
  only per-project contract; the pipeline discovers everything else from the
  repo.
- **Claim**: the unique commit prepare pushes to `epic/<N>-<slug>`. The ref is
  the lock; labels are reporting.
- **Slot**: one running tmux session, whoever started it. `MAX_PARALLEL_EPICS`
  in `etc/repos.conf` is the budget, enforced only in `bin/launch.sh`. Its one
  bypass is `--over-capacity` on a manual epic/task/fix/ci/defect launch; the
  session it admits still counts as a slot afterwards.

Lifecycle labels are owned by automation. Do not add or repurpose one.

| label | meaning |
| --- | --- |
| `ready` | queued, unclaimed: the build queue |
| `in-progress` | a run has claimed it |
| `ready-to-merge` | PR open, gates cleared; the merge worker lands it unattended |
| `ready-to-review` | PR open, held from unattended merge; a human decides unless an opted-in defect fixer owns its concrete blockers |
| `failed` | blocked; needs a human |
| `needs-judgment` | beside `failed`: the merge worker declined a judgment-class conflict; the conflict fixer's queue |
| `needs-ci-fix` | beside `failed`: checks were red on the rebased head; the CI fixer's queue |
| `needs-defect-fix` | beside `ready-to-review`: the defect fixer's queue. Epic-run no longer writes it — a concrete-defect hold now gets one scoped correction inside the run — but defect-run still services evidence older runs published, and a manual launch still works |
| `fix-attempted` / `fix-retried` | the conflict fixer's attempt ladder (one retry, then a human); never reset by automation |
| `ci-attempted` / `ci-retried` | the CI fixer's own ladder, same shape |
| `defect-attempted` / `defect-retried` | the defect fixer's own ladder, same shape — one PR can need all three repairs |
| issue closed | merged |

`task` is a persistent human-selected workflow selector, not a lifecycle
label. Plain `ready` dispatches epic; `ready` plus `task` dispatches task. Every
lifecycle transition and provider-quota requeue retains the selector.

`engine:<name>` is the separate routing namespace and is never cleared by a
lifecycle change. A claimed branch with no exact matching engine pin is blocked
rather than inferred from the current host default; a mismatched or conflicting
pin is never rewritten by a run. A follow-up issue ship files is queued as it is filed —
`ready`, and `blocked_by` the issue it came out of, so it cannot run until that
one closes — and links back with a `Follow-up to #N` line in the body. Ordering
is written before the label: an unordered follow-up is left unqueued rather
than made launchable against a main without the code it describes.

## Architecture boundaries

- `workflows/epic-run.mjs`, `workflows/task-run.mjs`, `workflows/fix-run.mjs`,
  `workflows/ci-run.mjs` and `workflows/defect-run.mjs`
  are plain Node orchestrators. They must not name a vendor.
- `workflows/lib/issue-delivery.mjs` owns the epic and task workflows' shared
  claim, engine-pin, candidate, preservation, quota and terminal handoff
  mechanics. Task-run adds no alternate transport path around those gates.
- `workflows/lib/fixer-lifecycle.mjs` owns the three fixers' shared argv/runtime
  setup, repair → verify → one diagnostics-driven repair retry when red → accept
  → correct → confirm → publish sequencing, the
  indexed-disposition gate, run state, quota/refund, blocker and human-hold
  paths, terminal budget, status and `RESULT`. The acceptance, correction and
  confirmation contract itself lives in `workflows/lib/repair-acceptance.mjs`,
  shared with epic-run. The entry points remain explicit cause adapters: conflict owns
  rebase/autoresolve and pre-push partial evidence, CI owns failing-check/log
  capture and local reproduction, and defect owns authenticated evidence,
  post-push head/evidence confirmation and landing-only recovery. Pushed
  partial state is monotonic in the runner and can never return through an
  ordinary requeueing blocker. Gated by `tests/epic-run.test.sh`.
- `workflows/lib/evidence.mjs` is where a prompt's known inputs are captured
  before the call: the issue bodies behind a change or a conflict side, and the
  one rendering every pipeline uses for a captured artifact. The pinned diffs,
  commit subjects and CI logs are captured by each pipeline through
  `lib/repo.mjs` and `lib/github.mjs` and rendered through the same block shape.
  No prompt in any pipeline names a `git` or `gh` command for a step to run for
  its own evidence. A diff that cannot be captured fails closed; an issue body
  that cannot be read says so where the model reads it, exactly as an
  unretrievable job log already does. Gated by `tests/epic-run.test.sh`.
- `workflows/lib/engine.mjs` is the only file that knows how a vendor CLI is
  invoked. Its loader validates `etc/engines.json` before any phase touches
  GitHub. A Codex phase is ephemeral, sandboxed from the charter's tools, and
  reads the target project's `AGENTS.md` through the CLI's own discovery rather
  than a copy the adapter pastes in. Developer instructions carry the charter
  and one compatibility block: the `.claude/rules` files Claude Code always has
  in context, which Codex has no equivalent for. A rule scoped by `paths:`
  frontmatter is left out, exactly as Claude Code leaves it out until a matching
  file is touched. Native discovery truncates past `project_doc_max_bytes`
  silently and defaults to 32 KiB — smaller than this repo's own `AGENTS.md` —
  so the adapter raises that cap explicitly and refuses the phase when
  `AGENTS.md` is missing, empty or larger than the raised cap. Gated by
  `tests/engine-codex.test.sh`.
- `workflows/lib/runtime.mjs` owns phase execution, the concurrency gate,
  timeouts and signal forwarding. Deterministic control flow lives here or in
  scripts, never inside model judgment. Task-run disables both transient and
  schema respawns on every invocation; only a normal red first project verify
  may cause one explicitly labelled fresh tasker invocation.
- `etc/lib.sh` validates and exports the host-wide `HOST_TIMEZONE`, and
  `workflows/lib/time.mjs` is the matching Node formatter. Human-facing pane,
  status, script-log and resource-report timestamps use that zone; parsed usage,
  resource and GitHub-comparison values remain UTC ISO.
- `workflows/lib/github.mjs` and `workflows/lib/repo.mjs` are the pipelines'
  transport: every claim, label swap, comment, checkpoint, squash, push, PR,
  follow-up issue, layout discovery, `npm ci` and the fixer's verify run is
  executed there by the orchestrator, never delegated to a model. The merge
  gate's inputs are counted from the final review's structured verdicts. The
  source issue is specification plus append-only run record; generated PR
  prose is only deterministic technical linkage. Gated by
  `tests/epic-run.test.sh`.
- `workflows/lib/usage.mjs` appends typed JSON lines to `EPIC_USAGE_LOG`,
  default `~/epic-usage.jsonl` on whichever machine ran the pipeline:
  `type:"spawn"` per agent spawn (step, vendor, model, effort, tokens, seconds,
  cost, `retry`, and the failure kind/reason when a spawn fails) plus
  `type:"run-start"` and `type:"run-finish"` bracketing every invocation of all
  five pipelines, including one that spawned nothing. A start carries the run's
  identity — `runId`, script, engine, session, issue and the registered
  repository key `--repo` supplies (null when absent, never split out of the
  session name); its finish adds wall-clock `ms` and the pipeline's own
  `outcome`: `merge-queued`, `repair-queued`, `quota-held`, `human-review`,
  `human-blocked`, `skipped`, `error` or `manual`, with `handoff` derived from
  it. Every `RESULT` carries that same `outcome`, set at the return site from the
  transition the run read back — the report classifies nothing itself. Rows
  without a `type` are legacy spawns and stay readable. Host-local, best effort
  (a failed append never changes a verdict or exit code), never written to
  GitHub. `node workflows/usage-report.mjs` prints two views: the per-step
  tuning table (record-level `--since`/`--engine`/`--script` filters, its summed
  spawn time labelled model-active) and the issue-lifetime view, where `--since`
  selects a `(repository, issue)` lifetime by its latest activity and then totals
  every retained record of it, and `--engine`/`--script` select by the latest
  completed run. `./remote-control.sh usage` runs that on the host.
- `workflows/quota-hold.mjs` owns the host-wide vendor-keyed provider-quota
  holds: reset-time parsing, schema validation, atomic per-vendor monotonic
  writes under dispatch's lock, independent expiry, and the read-only operator
  peek. A hard quota is recorded before a run restores its queue labels;
  ordinary dispatch snapshots the map before capacity or GitHub and skips each
  candidate whose selected workflow steps use a held vendor. A task candidate
  checks only its `task` step's vendor; an epic or fixer checks its full engine
  vendor set. Routing-only and explicit manual launches bypass it.
- `workflows/lib/prices.mjs` holds the published per-model prices for vendors
  whose CLI reports no cost. Claude bills itself and is not in the table; a
  Codex spawn is priced from it and stamped `costSource:"table"`, so a computed
  figure is never read back as a vendor's own. Short-context rates only: the
  long column bills per request, and a usage record has one turn's tokens
  summed across every request it made. A model with no row records an unknown
  cost, never a zero. Adding a Codex model to `etc/engines.json` means adding
  its row here too.
- `bin/launch.sh` is the only session-creation primitive; `bin/dispatch.sh` and
  `remote-control.sh` both go through it. It owns the pipeline worktree and
  the slot cap, refusing with exit 3. Gated by `tests/launch-epic.test.sh`.
- `bin/dispatch.sh`, `bin/reap.sh` and `bin/merge-tick.sh` are one operating
  loop on a one-minute cron. Check a change to one against the other two.
- `bin/merge-worker.sh` is serial per repo, because every merge invalidates
  every other queued PR's green, and merges in its own worktree, never in the
  clone. It gives checks a short registration grace after the rebased head is
  visible; every check that appears must conclude green, while an empty rollup
  after the grace is the supported no-CI case. Its one repair is
  `bin/merge-autoresolve.sh`; exit 4 is the judgment class. Two open PRs on one
  issue is ambiguous and merges nothing. Gated by
  `tests/merge-autoresolve.test.sh` for the resolver and
  `tests/merge-worker.test.sh` for the state machine around it.
- `setup.sh` (laptop) and `bin/provision.sh` (host) both source
  `etc/wire-claude-content.sh`, which exposes only `/spec` and `spec-explorer` as
  user-level Claude content. Laptop setup also links `/spec` into Codex's
  user-level skill directory and registers `agents/spec-explorer.toml` through
  `agents.spec-explorer.config_file` with the charter's real repo path:
  Codex 0.153.4 advertises the symlink but refuses to load it on spawn.
  The native Codex config API preserves other settings, checks the config
  version before writing and reads registration
  back; a foreign role is left alone and reported. Only after registration
  succeeds does setup remove its old agent symlink, avoiding duplicate role
  definitions. Pipeline entry points and charters stay internal; Codex's
  built-in `explorer` remains unshadowed.
- `remote-control.sh` is the one script that runs on the laptop; everything in
  `bin/` runs on the host and never sshes.
- `.agents/skills/toliki` is the cross-client project-level source of the
  operator-only pipeline triage skill; `.claude/skills/toliki` is a relative
  symlink to it for Claude discovery. It stays project-level so it does not
  surface in every project.

## Non-negotiable behavior

- Fail closed. A failed or unreadable dependency check, requested reviewer, schema,
  CI conclusion, ref listing, routing label or conflict classification is never
  a green gate. Gated by `tests/dispatch-engine.test.sh` and
  `tests/epic-run.test.sh`.
- The `task` workflow is a human opt-in economy with one primary writable
  tasker process. The orchestrator still owns the shared claim and engine pin,
  dependency install, project verify, clean moved-base rebase plus re-verify,
  candidate commit containing `Closes #N`, push, PR, delivery-summary readback
  and handoff. Invalid output, a tasker blocker, provider/process failure or
  timeout never respawns it; they preserve the branch and rest at `failed`. A
  normal nonzero first project verify is the sole bounded exception: one fresh
  tasker receives the original requirement plus sanitized bounded diagnostics,
  inspects the existing worktree without an injected full diff, and repairs
  without weakening tests or expanding scope. Its runtime and schema respawns
  remain disabled, the full verify runs once more, and no third tasker or
  rebase-time repair is allowed. A hard quota from either tasker records the
  task vendor's hold and restores `ready` without removing `task` or the engine
  pin. Its PR and later fixer prompts state that the original delivery was
  intentionally not independently reviewed.
- A provider `quota-exhausted` result is never transient-respawned. The run
  preserves its resumable state, records only the failed step's vendor hold,
  refunds a fixer's current attempt rung, and only then restores the appropriate
  queue labels; failure to persist the hold or verify those labels uses the
  ordinary blocker path. Dispatch validates one snapshot under its tick lock
  before capacity or any GitHub access, then checks each resolved engine before
  any candidate label write and continues past held candidates. Epic and fixer
  candidates wait on the union of their vendors; task candidates check only
  the selected engine's `task` vendor. Candidates are never rerouted. Expired entries
  are pruned independently; malformed state or an unreadable engine vendor set
  fails closed.
- A model step is asked for judgment, never for retrieval or bookkeeping.
  Everything its brief is known to need — the issue bodies, the pinned diffs,
  both conflict sides with the commit subjects behind them, the CI job logs, the
  final review ledger — is captured before the call and supplied as bytes, so a
  builder and the blind checker that later judges it read the SAME evidence and
  a capture that failed is visible to the orchestrator instead of to nobody.
  Source exploration stays open: writable steps read the tree and reviewers grep
  it. In the other direction, changed-file lists and verification results are
  derived in scripts and never copied from a step's account, and
  `.epics/<slug>/epic.md` is written only by the orchestrator from what each
  step returned — no prompt asks a model to maintain the run record. Gated by
  `tests/epic-run.test.sh`.
- Merge eligibility is computed from structured counts in `epic-run.mjs`.
  Never replace it with a model's sign-off.
- The merge is pinned to the sha whose check gate was evaluated
  (`--match-head-commit`). Anything pushed between green and merge makes
  GitHub refuse rather than land on a result it never earned. The worker also
  reads the complete subject/body from that exact SHA and passes both explicitly
  to the squash merge; an unreadable or empty message never falls back to PR
  text or repository defaults.
- Session admission is one critical section in `bin/launch.sh`: the capacity
  count and `tmux new-session` run under a lock, so a manual launch racing a
  cron tick cannot overrun the cap. `--over-capacity` is the only way past it —
  manual pipeline launches only, counted under the same lock, never passed by
  `bin/dispatch.sh` and never carried on a `--route-issue` segment or a probe.
  Every `has-session` target is `=`-pinned;
  a bare one matches name prefixes, so epic-26 reads a live epic-263 as itself.
- GitHub artifacts a retry cannot undo — the candidate-specific delivery
  summary, a filed follow-up, the deferred record — are created only after the
  PR exists. The summary is published and read back before the later artifacts;
  exactly one matching candidate marker is accepted, including when a write
  errors after GitHub accepted it. Missing or duplicate confirmation blocks
  with the real PR/branch/SHA and manual recovery guidance, because an ordinary
  rerun skips an open PR. A matching existing record and an existing deferred
  record are each left alone. Everything before the PR is idempotent under a
  re-run.
- Follow-up URLs in defect evidence are correlated by opaque, run-local blocker
  IDs assigned before ship, never by title, reason or occurrence. Ship copies
  every known ID into any non-empty deferred ledger; unknown, repeated or
  missing known IDs refuse before the PR is created. The IDs stay internal and
  never enter the versioned defect-evidence envelope.
- Epic-run adds `needs-defect-fix` only after it posts and reads back a
  structured repair envelope authored by the authenticated automation identity
  and bound to the issue, same-repository PR and captured head. Defect-run pins
  the original requirement from that envelope, rejects mutable issue prose,
  stale evidence and fork PRs before an attempt, and verifies the selected PR
  advanced to the pushed head before promotion — re-reading that head over a
  bounded window rather than once, because GitHub shows a force push seconds
  after it lands and a single immediate read reported two complete repairs as
  landings that never happened.
- Every readback that verifies a write the run itself just made — a PR head
  after a push, labels after a swap, a comment after posting — reads again over
  a bounded window and stops at the first read that matches (`readBack` in
  `workflows/lib/github.mjs`, up to six reads about five seconds apart). Retries
  change timing, never verdicts: a readback that never matches still fails, with
  the wording it always had, and a read that ERRORS is not retried at all,
  because a query that errored carries no verdict. The waits are charged to the
  caller's budget, so a readback after a terminal label write stays inside the
  one reporting window and never extends reap's settle window. Epic-run's
  promotion readback is the deliberate exception: there a non-match is not a
  verdict but the decision to take the promotion back off, so it reads once and
  the readback that PROVES the demotion is the bounded one.
- Architecture returns a proportional plan with a structured verification
  strategy (`test-first` or `direct`), its rationale and required evidence. It
  no longer selects a focused reviewer: there is exactly one broad review.
  Test-first establishes a clean verify baseline before writing tests and
  requires the expected assertion failure in the orchestrator's RED output;
  an unrelated failure or timeout is not RED evidence. Direct skips the RED
  agent, not verification. An interrupted partial implementation resumes with
  a direct continuation plan, preserving the existing tests and edits rather
  than demanding a new clean RED baseline. Both paths finish with orchestrator-run
  `npm run verify`, as do fixes-after-review, with one bounded coding retry
  before a blocker. An agent's report that verify passed is never the gate.
  Gated by `tests/epic-run.test.sh`.
- ONE broad reviewer judges the actual diff against the requirement, and it is
  the only broad review of the change: the architect-selected focused reviewer
  was removed because a second pre-repair opinion bought less than one
  exhaustive acceptance check after the repair. Reviewers stay blind to builder
  notes; the final review receives the original requirement too. Every finding
  needs a complete verdict: missing or ambiguous evidence cannot become a
  disproof or merge clearance. A resumed code checkpoint keeps its structured
  plan, or reconstructs it read-only when the local artifact is missing,
  without replaying code.
- Review repairs apply the smallest correct change and meaningful regression
  coverage. New abstractions or instruction rules are justified by the repair,
  not mandated for every finding. Follow-up issues are still filed and queued
  for concrete material work with a standalone definition of done; the cap is
  a ceiling, not a target, and filing never clears the current PR's blockers.
- The initial review's findings are actionable as they stand: there is no
  confirmation pass before repair. Findings spawn ONE fresh fixer, which must
  account for every finding with an indexed disposition — fixed, disputed with
  concrete code evidence, or deferred as unsafe to repair. Missing, duplicate,
  extra or ambiguous coverage blocks the run at `triage`. Titles are not
  identities. The orchestrator then runs `npm run verify` with the usual single
  retry; a tree still red after it blocks and never reaches the final review.
- A final read-only review runs when the fixer changed code or disputed or
  deferred anything. It receives the original requirement, every original
  finding with its reported action, the complete diff and the exact fixer
  delta — never the fixer's explanation, so it judges the code rather than
  agreeing with the account. It decides each finding resolved, disproved or
  unresolved, reports what the repair broke, and reports what the requirement
  still lacks; uncertainty is unresolved, never disproved.
- Merge readiness is computed from that result alone: every finding resolved or
  disproved at confidence 75+, no repair regression, no unmet requirement. A
  dead or malformed final review, a `resolved` verdict on an empty fixer delta,
  an all-fixed claim that produced no diff (which spawns no final review), or
  any unresolved item holds the PR at `ready-to-review`. When the hold is made
  ENTIRELY of remaining defects the final review positively showed at
  confidence 75+, the run takes one scoped correction before ship (see the
  bounded repair contract below) instead of queueing a separate fixer session;
  epic-run therefore never writes `needs-defect-fix`. Uncertainty, a mixed
  batch and a failed correction always need a human. There is no second repair
  round and no second correction batch. Manual slug mode runs the same fixer,
  final review and correction against an in-memory reviewed patch and immutable
  base, without committing or queueing a merge; open items remain explicit in
  its summary. Gated by `tests/epic-run.test.sh`.
- The bounded repair contract (`workflows/lib/repair-acceptance.mjs`) is shared
  by every place Toliki independently checks a model-written repair: epic-run's
  post-review repair and the conflict, CI and defect fixers. A checker examines
  every original disposition and the complete orchestrator-captured repair delta
  — new and untracked files included — keeps going after the first refutation,
  and returns an exact verdict per item plus the COMPLETE blocker batch, never
  one sufficient counterexample. Each blocker has a run-local id, a kind
  (`original-defect`, `repair-regression`, `out-of-scope`, `human-judgment`),
  the original item when it names one, a location, concrete code evidence and
  the observable outcome that clears it. The outcome is `clear`,
  `correction-required` (every blocker is a concrete implementation defect) or
  `human`. Malformed, incomplete, duplicate, extra, unknown, ambiguous or
  low-confidence evidence authorizes nothing. On `correction-required` the
  unpushed repair is preserved exactly as it is and ONE fresh writable
  correction runs in the same invocation over the whole batch — no cleanup, no
  restored queue, no consumed retry rung, no second whole fixer — then the full
  verify contract again and ONE narrow read-only confirmation that receives the
  complete cumulative delta and the exact correction delta but never the
  correction's narrative. A missing or declined blocker disposition, no relevant
  change, a red second verify, or a refused, dead or malformed confirmation ends
  human-held; there is no second correction batch. Distinct usage labels record
  the initial repair, the acceptance check, the correction and the confirmation,
  so a correction is never counted as a pipeline relaunch. Gated by
  `tests/epic-run.test.sh`.
- Semantic completion and operational relaunch are separate. A semantic human
  outcome in a fixer removes that fixer's queue label and verifies the
  human-held resting state, so dispatch cannot launch another complete fixer at
  work a correction already had its one chance at — and it never manufactures a
  spent retry label to get there. Provider quota, process interruption,
  transport failure and landing-only recovery keep their existing refund, retry
  and durable-recovery behavior.
- A phase that judges a change may not alter it. Reviewer and shipper charters
  have no shell or write tools; the orchestrator supplies their diff evidence
  and hashes the shippable worktree (all tracked content, including tracked
  paths an ignore rule also
  matches, plus untracked files, `.epics/` excluded) and HEAD around review,
  final review and ship, including the real index, Git configuration, hooks,
  replacement refs and grafts, and blocks the run when any moved. Orchestrator
  Git calls neutralize repository hooks while preserving caller configuration —
  an edit those phases make is neither reviewed nor verified, and the paths that
  ship without another gate (an empty review, a cleared final review) are
  exactly where nothing else would catch it. Gated by `tests/epic-run.test.sh`.
- Ship's deferrals never gate the merge: `kind` only ranks which items earn a
  follow-up issue and what the deferred record says. Every model process in the
  run — architect, code, review, fixer, final review, ship — is a short-lived
  process that ends when it returns; nothing resumes or continues an earlier
  one. Gated by `tests/epic-run.test.sh`.
- Ship rebases the run's checkpoint chain onto current origin/main before the
  squash, because a run takes an hour and its PR is often held for hours more,
  so the base has usually moved. A clean rebase re-runs the verify gate against
  what landed; a red one blocks with the chain intact, so a re-run resumes from
  its checkpoint. A failed fetch or a conflicted rebase ships on the run's own
  base instead — the merge worker rebases and re-checks before anything lands,
  and its fixers own that conflict. Gated by `tests/epic-run.test.sh`.
- GitHub is the durable work state store: issues, labels, `blocked_by`, claim
  refs, PRs. The provider hold is the narrow host-fact exception, alongside
  locks and usage telemetry: it expires, orders no work, and is never a second
  project database. No per-project facts live in harness configuration.
- Flat issue model: one issue is one autonomous, mergeable, independently
  verifiable change. No milestones, boards, parent issues or sub-issues.
- Verification owns only its worktree and runs concurrently with other
  worktrees and other repos on one box. Anything a project's verify reaches
  outside (ports, containers, `/tmp` paths, caches, remote fixtures) must be
  namespaced per worktree or serialized on a host-wide `flock`, in that
  project, and must stay correct where the harness is absent.
- Crons watch, deterministic scripts gate, models act only where judgment is
  required.
- Mechanical conflict resolution stays containment-gated. If both sides' intent
  cannot be proven to survive, escalate instead of guessing.
- The conflict fixer never merges. A complete repair restores unattended
  eligibility at `ready-to-merge`; a verified partial repair preserves every
  repaired hunk but rests only at `ready-to-review`, with `needs-judgment`
  removed and each declined hunk retaining the exact PR-side text. Before that
  push it publishes and reads back an authenticated record bound to the amended
  head, containing only the declined hunk identities and original diff3 sides.
  A matching record with either ladder label refuses without a model even if
  `needs-judgment` was retained; clearing both ladder labels explicitly grants
  one bounded round over only those declines, and a moved main holds for a
  human instead of reconstructing stale intent, refunding the newly recorded
  rung because no model attempt ran. Its push is
  the last step after verify and an adversarial check of every indexed repaired
  and declined claim. A complete landing is safe for the same reason the CI fixer's is
  — the merge worker rebases and RE-RUNS the real checks before anything
  merges, so a resolution that broke something cannot land on a red check. What
  that cannot catch is a resolution that is green and wrong, which is what the
  adversarial check refuting by default is for; it judges every edit made
  outside a marker block too, since the resolver may make one only where that
  is what carries a side's intent to lines the other side moved. Gated by
  `tests/epic-run.test.sh`.
- The CI fixer likewise lands a complete repair at `ready-to-merge`, while a
  verified partial repair is pushed only to `ready-to-review` with
  `needs-ci-fix` removed. Its checker receives every indexed repaired/declined
  claim and refutes a changed decline. Unattended promotion is only safe because the
  merge worker rebases and RE-RUNS the real checks before anything merges, so a
  fix that is still red cannot land. What that cannot catch is a fix that is
  green and wrong, which is why the fixer is forbidden to weaken a test and its
  diff goes to an adversarial check that refutes by default. Gated by
  `tests/epic-run.test.sh`.
- The defect fixer has the same verified-push safety argument as the CI fixer,
  but repairs only defects already named by the durable ship-gate evidence. It
  is a separate two-attempt session. Epic-run no longer queues it — that hold
  takes one scoped correction inside the run instead — so it exists for durable
  evidence older runs published and for an explicit manual launch. It cannot weaken a test or reclassify a
  defect. A complete repair rejoins `ready-to-merge` only after
  orchestrator-run verify plus a blind adversarial check of the complete delta,
  including intent-added new files. A verified partial repair is pushed to
  `ready-to-review`, removes `needs-defect-fix`, publishes and reads back a new
  authenticated envelope on the amended head containing only declined items,
  and emits no complete-repair landing record. Every blocker/refusal restores and verifies its terminal labels even
  when its reporting comment fails, and any guidance that names a label is
  composed from that readback per label — an operator is asked to set what is
  missing and remove what is stuck, never to repair state that is already
  right. Its audit comment carries a landing record bound to the amended head
  and to the head the evidence it repaired from was bound to, posted as soon as
  the push is a fact rather than after the checks that follow it — the record
  exists for a landing this run cannot finish, so it has to survive one. An
  attempt that pushed a verified and checked repair and could not confirm the
  landing leaves the envelope bound to the pre-push head, which is no longer the
  PR's; a relaunch that finds only that record — authored by the same identity,
  bound to this issue, PR, branch and current head, and naming a prior head
  whose envelope matches — redoes the LANDING alone. It takes its ladder rung,
  checks the branch shape, skips fix, verify and check, swaps the label and says
  on the issue that the earlier attempt verified and checked this head, because
  a second repair round would edit defects that are already repaired. Nothing
  else about the trust model relaxes. Autonomous dispatch is opt-in per repo
  through `DEFECT_FIX_REPOS`; manual `defect` remains an explicit override.
- Every cleanup needs a positive proof of staleness: a claim ref only while its
  tip is still the claim commit and no session is live; a worktree only when its
  issue has no `epic/<N>-*` ref on origin at all. Liveness is read from tmux
  before any GitHub query. Gated by `tests/reap-worktree.test.sh`.
- A run comes to rest at exactly one of `failed`, `ready-to-merge` and
  `ready-to-review`. Every terminal transition names that one label and derives
  its removals from it (`terminalTransition` in `workflows/lib/github.mjs`),
  never a hand-written remove list: a fallback that adds `failed` beside the
  landing label GitHub already applied leaves a blocked run in
  `bin/merge-worker.sh`'s queue, where the failure path becomes a merge. A
  fixer's blocker also restores the queue label its own complete landing swap
  stripped, so an unverified complete landing costs a retry, not the issue. A
  partial push is the exception: later evidence, audit or label trouble removes
  the fixer queue and leaves a human-only terminal state, because rerunning it
  could overwrite or promote repairs already on the branch. The verdict on a
  terminal write is the readback, never the write's exit code: GitHub can apply
  the label while the client still waits, so the readback runs whatever the
  write returned, and a run reports only the state it read back. `ready-to-merge`
  therefore rests on an issue only under a RESULT that claims it — an
  unconfirmed promotion is taken back off and the demotion proved, and one that
  can be neither confirmed nor proved undone blocks rather than resting on a
  label it cannot account for. Gated by `tests/epic-run.test.sh`.
- Terminal is the label, and a terminal label must settle for
  `TERMINAL_SETTLE_MINUTES` before a session is killed. Dispatch synchronously
  shields a fixer launch by swapping its resting terminal label to
  `in-progress`, including `ready-to-review` for defect repair. GitHub can apply
  a terminal label — starting that clock — while the client still waits on the
  response, so the write itself and everything after it share ONE budget
  (`TERMINAL_REPORT_BUDGET_MS`, a share per call capped by what is left of the
  window): a fixer's swap, the readback its guidance is composed from and the
  refusal comment; a fixer's landing swap (`ready-to-review` / `ready-to-merge`)
  and its readback; epic-run's merge gate, which runs after ship's
  `ready-to-review`, and its blocker write to `failed`; the status comment's
  final edit. One window per run, not per caller: `terminalBudget()` opens it at
  whichever terminal write comes first and hands the same one back afterwards,
  so a landing swap the run could not verify falls through to its blocker path
  on what is LEFT of that window rather than on a second one. Reap floors the
  window (`MIN_TERMINAL_SETTLE_MINUTES`) so the two cannot be configured into a
  race. A bounded readback's waits are charged to that same window too, so
  re-reading a label until it settles can never push the report past it. Never
  add a GitHub call — or a local git cleanup, which has a timeout of its own —
  on the default timeout from a terminal label write onward. No model step runs
  inside that window: `agent()` refuses a spawn once it is open, so ship's
  PR-description step runs before the `ready-to-review` write.
- A dead pipeline pane whose issue rests at `ready` is a completed quota hold,
  so reap applies the normal settle window and removes its session. A live
  `ready` pane is still working and a dead `in-progress` pane remains a crash
  that requires a human.
- Dispatch launches but never claims. Two ticks racing on one issue is safe
  because the ref push decides.
- The CLI binary moves only on an idle host, under dispatch's lock. Gated by
  `tests/update-claude.test.sh`.
- Provisioning never upgrades a version already present, and never sets a
  consent flag. Gated by `tests/provision-agent-clis.test.sh`.
- `HOST_TIMEZONE` comes only from `etc/repos.conf`; caller and tmux environments
  cannot override it. An empty value means UTC, an unknown zone refuses before
  host-facing work, and provisioning sets then verifies the host's effective
  zone. Human timestamps include the instant's abbreviation; machine records
  remain canonical UTC ISO. Gated by `tests/timezone.test.sh`.

## Traps the code cannot show you

- Adding a repo takes `REPOS` and `REPO_ORIGINS` lines in the host's
  `etc/repos.conf`, a `bin/provision.sh` run, and one interactive `claude` in
  the clone to accept workspace trust. An untrusted clone makes every
  interactive session die instantly while `start` reports success.
- Bypass-permissions consent is per host and deadlocks interactive sessions
  silently. Accept it once by hand; `provision.sh` reports it but never sets it.
- Every registered repo must auto-delete merged branches (Settings, General).
  With it off, reap never collects a worktree and the disk fills.
- Install `etc/dispatch.cron` by hand, all three pipeline lines or none. Its
  `PATH=` must reach `node`, `claude` and `codex`, plus `bun` for any
  registered repo whose `scripts.verify` shells out to it.
- `EPIC_ENGINE` must be a key of `etc/engines.json`, or every tick and every
  launch refuses. It is read from the installed cron file, not the process
  environment: the file must hold exactly one `EPIC_ENGINE=` line, and if the
  environment also names one it must agree — a malformed file or a disagreement
  refuses to launch (`config.sh` edits that file and reports this setting with
  `MAX_PARALLEL_EPICS`, so the minute after an edit can log one loud tick).
- Every name in `DEFECT_FIX_REPOS` must be registered in `REPOS`; empty or
  unset disables autonomous defect repair without disabling manual launches.
- Changing `HOST_TIMEZONE` in the host registry requires a `bin/provision.sh`
  run so the system timezone follows it. Existing panes keep their explicitly
  launched zone; new manual and pipeline panes receive the new registry value.
- Claude model names in `etc/engines.json` are CLI aliases resolved by the
  installed binary, so a stale binary silently turns them into pins.
- The Docker GC policy loads only on a full daemon restart, and unknown keys
  are dropped silently. Verify with `docker buildx inspect`.
- Only `spec` and `spec-explorer` are user-level Claude symlinks; laptop setup
  links the Codex skill and registers its agent's real repo path in user config.
  A project-local copy silently shadows shared content. Pipeline skills and
  charters are not published.
- Never invent a second session-name pattern: reap, dispatch and the cap all key
  on `<repo>-epic-<N>`.

## Change workflow

1. Inspect the working tree first and preserve unrelated changes.
2. Make the smallest coherent change that respects the doctrine and the
   boundaries above.
3. A behavior change gets a hermetic regression test. A new gate or refusal
  path gets both its pass and its stop scenario.
4. For every workflow change, verify `WORKFLOW.md` against the executable
   path and update it when needed. When the contract or rationale changes,
   update this file, DOCTRINE.md, the root README, the template or the script
   header too. Never leave an invariant only in a commit message.
5. Run every relevant suite; run all twelve before handing off a broad change.

Trunk-based: when asked to commit or push, commit straight to `main` and push.
No feature branches or PRs unless explicitly requested. Never commit or push
merely because the code is ready.

## Conventions

- Preserve exit-code contracts and bash 3.2 portability wherever the laptop
  runs a script. `flock` is Linux-only; hermetic tests stub it.
- No npm dependencies.
- Structured agent output has an explicit schema and a bounded retry or blocker
  path.
- Keep signal forwarding and process-group cleanup intact.
- Idempotent operations and `--force-with-lease` over unguarded writes.
- Machine-local values live in `etc/repos.conf`, never in tracked files.
- Never copy a shared skill or charter into a target project.

## Tests

All thirteen suites are hermetic and need no network or credentials. The test
runner runs up to four suites together, suppresses passing assertion chatter
and prints one line per green suite. Set `TEST_JOBS=1` for a serial run:

```bash
./test.sh
```

Stub host-facing binaries with fake executables placed first on `PATH` and use
throwaway repositories under `mktemp`; never point a test at the real registry
or host. The stub engine routes its fixtures on `EPIC_STEP_LABEL`, which the
adapter exports to every spawn, never on prompt wording. Never weaken or
delete a test to make a change pass. Do not stub with zsh shell functions: zsh
cannot export them, so a child Bash calls the real `ssh`.

## Live-host safety

The user's tmux sessions and GitHub queues are live production state. Without
an explicit request, never run:

- `remote-control.sh start`, `epic`, `fix`, `ci`, `defect`, `next`, `stop`, `restart`,
  `stop-all`, or a bare `<name>`;
- `bin/dispatch.sh` except `--dry-run` (`--route-next` and `--route-issue`
  mutate labels);
- `bin/reap.sh` except `-n`;
- `bin/update-claude.sh` except `-n`;
- `bin/merge-worker.sh` or `bin/merge-tick.sh` in any mode.

Safe on your own initiative: `remote-control.sh ls`, `remote-control.sh usage`, `bin/reap.sh -n`,
`bin/update-claude.sh -n`, `bin/resource-report.sh`, GitHub reads, and
read-only tmux inspection (`ssh toliki 'tmux capture-pane -p -t <session>'`).
If you think you may have touched the host, `ls` shows what is running and a
clone's `.git/FETCH_HEAD` mtime marks its last launch.

## Review focus

When reviewing changes, prioritize:

- a failure path that accidentally becomes success;
- a race between dispatch, reap, launch and merge;
- stale-green CI accepted after a rebase;
- cleanup without a positive safety proof;
- loss of one side's intent during conflict resolution;
- unbounded retries, parallelism or host resource use;
- divergence between laptop setup and host provisioning;
- vendor-specific behavior leaking outside the engine adapter;
- tests that could reach SSH, GitHub, a real clone or a live tmux server.
