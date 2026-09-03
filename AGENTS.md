# toliki project instructions

Instructions for any agent working in this repository. Claude Code reaches this
file through the pointer in `CLAUDE.md`; Codex reads it natively. Links are
relative markdown links, never `@file` includes.

## What this is

Toliki is a self-hosted coding-agent harness. A VPS turns `ready` GitHub issues
into reviewed, verified pull requests using cron, tmux, git worktrees, plain
Node orchestrators and short-lived headless agent processes. There is no
daemon, database, web UI or npm dependency tree. GitHub holds durable state;
tmux holds live processes; git worktrees isolate runs.

Two session kinds exist, and they must never be conflated:

- **Pipeline sessions** (`<repo>-epic-<N>`), launched by dispatch. The pane runs
  `workflows/epic-run.mjs` or `workflows/fix-run.mjs`, which spawns one headless
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
- **Fixer**: a run of `fix-run.mjs` on a `needs-judgment` issue. It reuses the
  epic's session name on purpose so every guard covers both.
- **Engine**: a top-level key of `etc/engines.json`, selected per issue by the
  `engine:<name>` label. An unlabeled issue uses `EPIC_ENGINE` from
  `etc/dispatch.cron` (claude when unset). The label survives fixer retries.
- **Step**: one of the six pipeline steps in `STEPS` in
  `workflows/lib/engine.mjs`, each a judgment call. Pipelines name steps; the
  engine file says who runs them; `STEPS` fixes each step's charter and tool
  boundary, so architect, review and confirm-review stay read-only under any
  vendor. Nothing deterministic is a step: git, gh and npm work runs in the
  orchestrator.
- **Charter**: an `agents/*.md` file, read on every phase. Missing or malformed
  refuses the run.
- **Package**: a directory whose `package.json` declares `scripts.verify`. The
  only per-project contract; the pipeline discovers everything else from the
  repo.
- **Claim**: the unique commit prepare pushes to `epic/<N>-<slug>`. The ref is
  the lock; labels are reporting.
- **Slot**: one running tmux session, whoever started it. `MAX_PARALLEL_EPICS`
  in `etc/repos.conf` is the budget, enforced only in `bin/launch.sh`.

Lifecycle labels are owned by automation. Do not add or repurpose one.

| label | meaning |
| --- | --- |
| `ready` | queued, unclaimed: the build queue |
| `in-progress` | a run has claimed it |
| `ready-to-merge` | PR open, gates cleared; the merge worker lands it unattended |
| `ready-to-review` | PR open, something deferred or judgment-resolved; a human decides |
| `failed` | blocked; needs a human |
| `needs-judgment` | beside `failed`: the merge worker declined a judgment-class conflict; the fixer queue |
| `fix-attempted` / `fix-retried` | the fixer's attempt ladder (one retry, then a human); never reset by automation |
| issue closed | merged |

`engine:<name>` is the separate routing namespace and is never cleared by a
lifecycle change. Follow-up issues ship with no labels and link back with a
`Follow-up to #N` line in the body.

## Architecture boundaries

- `workflows/epic-run.mjs` and `workflows/fix-run.mjs` are plain Node
  orchestrators. They must not name a vendor.
- `workflows/lib/engine.mjs` is the only file that knows how a vendor CLI is
  invoked. Its loader validates `etc/engines.json` before any phase touches
  GitHub. A Codex phase is ephemeral, sandboxed from the charter's tools, and
  receives the target project's `AGENTS.md` and `.claude/rules` as developer
  instructions; a missing `AGENTS.md` refuses the phase. Gated by
  `tests/engine-codex.test.sh`.
- `workflows/lib/runtime.mjs` owns phase execution, the concurrency gate,
  timeouts and signal forwarding. Deterministic control flow lives here or in
  scripts, never inside model judgment.
- `workflows/lib/github.mjs` and `workflows/lib/repo.mjs` are the pipelines'
  transport: every claim, label swap, comment, checkpoint, squash, push, PR,
  follow-up issue, layout discovery, `npm ci` and the fixer's verify run is
  executed there by the orchestrator, never delegated to a model. The merge
  gate's inputs are counted from ship's structured deferral kinds. Gated by
  `tests/epic-run.test.sh`.
- `bin/launch.sh` is the only session-creation primitive; `bin/dispatch.sh` and
  `remote-control.sh` both go through it. It owns the pipeline worktree and
  the slot cap, refusing with exit 3. Gated by `tests/launch-epic.test.sh`.
- `bin/dispatch.sh`, `bin/reap.sh` and `bin/merge-tick.sh` are one operating
  loop on a one-minute cron. Check a change to one against the other two.
- `bin/merge-worker.sh` is serial per repo, because every merge invalidates
  every other queued PR's green, and merges in its own worktree, never in the
  clone. Its one repair is `bin/merge-autoresolve.sh`; exit 4 is the judgment
  class. Gated by `tests/merge-autoresolve.test.sh`.
- `setup.sh` (laptop) and `bin/provision.sh` (host) wire the same per-item
  symlinks for `skills/` and `agents/`. Keep them aligned.
- `remote-control.sh` is the one script that runs on the laptop; everything in
  `bin/` runs on the host and never sshes.
- `.claude/skills/triage` is deliberately project-level rather than in
  `skills/`: an operator-only skill must not surface in every project.

## Non-negotiable behavior

- Fail closed. A failed or unreadable dependency check, review lens, schema,
  CI conclusion, ref listing, routing label or conflict classification is never
  a green gate. Gated by `tests/dispatch-engine.test.sh` and
  `tests/epic-run.test.sh`.
- Merge eligibility is computed from structured counts in `epic-run.mjs`.
  Never replace it with a model's sign-off.
- GitHub is the state store: issues, labels, `blocked_by`, claim refs, PRs. No
  second database, and no per-project facts in harness configuration.
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
- A fixer never merges and never restores unattended eligibility: it lands
  `ready-to-review`, and its push is the last step after verify and the
  adversarial check.
- Every cleanup needs a positive proof of staleness: a claim ref only while its
  tip is still the claim commit and no session is live; a worktree only when its
  issue has no `epic/<N>-*` ref on origin at all. Liveness is read from tmux
  before any GitHub query. Gated by `tests/reap-worktree.test.sh`.
- Terminal is the label, and a terminal label must settle for
  `TERMINAL_SETTLE_MINUTES` before a session is killed.
- Dispatch launches but never claims. Two ticks racing on one issue is safe
  because the ref push decides.
- The CLI binary moves only on an idle host, under dispatch's lock. Gated by
  `tests/update-claude.test.sh`.
- Provisioning never upgrades a version already present, and never sets a
  consent flag. Gated by `tests/provision-agent-clis.test.sh`.

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
- `EPIC_ENGINE` must be a key of `etc/engines.json`, or `etc/lib.sh` refuses to
  load on every tick.
- Claude model names in `etc/engines.json` are CLI aliases resolved by the
  installed binary, so a stale binary silently turns them into pins.
- The Docker GC policy loads only on a full daemon restart, and unknown keys
  are dropped silently. Verify with `docker buildx inspect`.
- Shared skills and agents are user-level symlinks per item; a project-local
  copy silently shadows the shared one. Only `spec` is model-invocable.
- Never invent a second session-name pattern: reap, dispatch and the cap all key
  on `<repo>-epic-<N>`.

## Change workflow

1. Inspect the working tree first and preserve unrelated changes.
2. Make the smallest coherent change that respects the doctrine and the
   boundaries above.
3. A behavior change gets a hermetic regression test. A new gate or refusal
   path gets both its pass and its stop scenario.
4. When the contract or its rationale changes, update this file, DOCTRINE.md,
   README, the template or the script header. Never leave an invariant only in
   a commit message.
5. Run every relevant suite; run all eight before handing off a broad change.

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

All eight suites are hermetic and need no network or credentials:

```bash
for t in tests/*.test.sh; do bash "$t" || exit; done
```

Stub host-facing binaries with fake executables placed first on `PATH` and use
throwaway repositories under `mktemp`; never point a test at the real registry
or host. Never weaken or delete a test to make a change pass. Do not stub with
zsh shell functions: zsh cannot export them, so a child Bash calls the real
`ssh`.

## Live-host safety

The user's tmux sessions and GitHub queues are live production state. Without
an explicit request, never run:

- `remote-control.sh start`, `epic`, `fix`, `next`, `stop`, `restart`,
  `stop-all`, or a bare `<name>`;
- `bin/dispatch.sh` except `--dry-run` (`--route-next` and `--route-issue`
  mutate labels);
- `bin/reap.sh` except `-n`;
- `bin/update-claude.sh` except `-n`;
- `bin/merge-worker.sh` or `bin/merge-tick.sh` in any mode.

Safe on your own initiative: `remote-control.sh ls`, `bin/reap.sh -n`,
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
