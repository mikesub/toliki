# Codex project instructions

## Start here

Toliki is a self-hosted coding-agent harness. A VPS turns prepared GitHub
issues into reviewed, verified pull requests using cron, tmux, git worktrees,
plain Node orchestrators, and short-lived headless agent processes.

Before changing the repository:

1. Read `DOCTRINE.md` before proposing a change to the pipeline's shape,
   adding configuration, relaxing a gate, or revisiting a rejected design.
2. Read the relevant section of `CLAUDE.md`. It is the detailed operational
   manual and records production traps that are not obvious from the code.
3. Trace the actual scripts and tests involved. Comments near the code often
   explain a production incident or a load-bearing ordering choice.

Do not treat this repository as a conventional application. It has no daemon,
database, web UI, or npm dependency tree. GitHub holds durable state; tmux
holds live processes; git worktrees isolate runs.

## Sources of truth

- `DOCTRINE.md`: architectural principles and deliberately rejected options.
- `CLAUDE.md`: detailed architecture, operations, and host safety rules.
- `skills/spec/ISSUE-TRACKING.md`: issue slicing and dependency rules.
- `workflows/*.mjs`: executable pipeline behavior and merge-gate inputs.
- `etc/repos.conf.template` plus `etc/lib.sh`: tracked configuration contract.
- `etc/repos.conf`: private, machine-local data. It is gitignored; never commit
  it or replace the template with its contents.
- Tests are the regression contract for shell and pipeline behavior.

When prose and executable behavior disagree, investigate rather than silently
choosing one. Fix the stale side in the same change.

## Architecture boundaries

- `workflows/epic-run.mjs` and `workflows/fix-run.mjs` are plain Node
  orchestrators. They must not name a model vendor directly.
- `workflows/lib/engine.mjs` is the engine boundary and currently the only file
  that should know how a vendor CLI is invoked.
- `workflows/lib/runtime.mjs` owns phase execution, concurrency, timeouts, and
  signal forwarding. Keep deterministic control flow here or in ordinary
  scripts, not inside model judgment.
- `bin/launch.sh` is the only session-creation primitive. Both dispatch and the
  laptop operator interface must continue to go through it.
- `bin/dispatch.sh`, `bin/reap.sh`, and `bin/merge-tick.sh` are one operating
  loop. A change to one must be checked against the other two.
- `bin/merge-worker.sh` is serial per repository because every merge invalidates
  the other queued PRs' prior green state.
- `setup.sh` and `bin/provision.sh` install the same shared skills and agent
  charters in different environments. Keep their wiring semantics aligned.

Preserve the two session types:

- Pipeline sessions run a Node orchestrator in a harness-owned worktree. They
  are non-interactive and have no steering channel; the only live intervention
  is to kill the run.
- Interactive sessions run Claude Code with Remote Control. Do not accidentally
  wrap a pipeline in an interactive agent or add a steering path.

## Non-negotiable behavior

- Fail closed. A failed or unreadable dependency check, review lens, schema,
  CI result, or conflict classification must never become a green gate.
- Merge eligibility is computed from structured values in code. Do not replace
  it with a model's qualitative sign-off.
- GitHub issues, labels, `blocked_by` dependencies, refs, and PRs are the state
  store. Do not add a second state database or duplicate project facts in
  harness configuration.
- Keep the issue model flat: one issue is one autonomous, mergeable,
  independently verifiable change. Do not invent tracking labels, milestones,
  parent issues, or sub-issues.
- The lifecycle label namespace belongs to automation. Its current meanings are
  documented in `CLAUDE.md`; do not add or repurpose a label casually.
- A target package is discovered by a `package.json` containing
  `scripts.verify`. An empty discovery must fail, never silently skip checks.
- Verification owns only its worktree. Any external resource used by a target
  project's verification—ports, containers, `/tmp` paths, global caches, or
  remote fixtures—must be namespaced per worktree or protected by a host-wide
  lock in that target project.
- Crons observe and deterministic scripts gate; models act only where judgment
  is required.
- Mechanical conflict resolution must remain containment-gated. If both sides'
  intent cannot be proven to survive, escalate instead of guessing.
- A fixer never merges and never restores unattended merge eligibility. A
  judgment-resolved PR returns as `ready-to-review`.

## Change workflow

1. Inspect the working tree first and preserve unrelated user changes.
2. Make the smallest coherent change that respects the doctrine and existing
   boundaries.
3. Add or update a hermetic regression test for behavior changes. If a gate or
   refusal path is added, add a scenario proving both its pass and stop paths.
4. Update `CLAUDE.md`, `DOCTRINE.md`, README, templates, or script comments when
   the operational contract or rationale changes. Do not leave a new invariant
   only in a commit message.
5. Run every relevant suite; run all five before handing off a broad change.

This repository uses trunk-based development. If the user asks for a commit or
push, commit directly on `main` and push normally; do not create a feature
branch or PR unless explicitly requested. Never commit or push merely because
the code is ready.

## Implementation conventions

- Shell scripts are Bash and generally use `set -euo pipefail`. Quote paths and
  variables, preserve explicit exit-code contracts, and keep macOS Bash 3.2
  portability where the existing code supports laptop-side execution.
- `flock` is host-side/Linux behavior. Hermetic macOS tests must stub it.
- Node workflow code is ESM and intentionally has no npm dependencies. Prefer
  the standard library and the small modules in `workflows/lib/`.
- Structured agent output must have an explicit schema and be validated. A
  missing or malformed response must have a bounded retry or blocker path.
- Preserve signal forwarding and process-group cleanup when changing process
  execution or timeouts.
- Prefer idempotent operations and force-with-lease over unguarded destructive
  writes. Every cleanup action needs a positive proof that the target is stale
  or delivered.
- Keep machine-local values in `etc/repos.conf`; keep helpers and defaults in
  tracked files.
- Do not copy shared skills or agent charters into a target project. A
  project-local copy can silently shadow the canonical user-level version.

## Tests

All suites are hermetic and require no credentials or network:

```bash
for test_file in tests/*.test.sh; do
  bash "$test_file" || exit
done
```

The suites cover:

- `tests/epic-run.test.sh`: both pipelines through a stub engine, including
  model/charter/schema arguments and fail-closed paths.
- `tests/launch-epic.test.sh`: worktree/session launch shapes and capacity
  probes.
- `tests/merge-autoresolve.test.sh`: conflict classification, containment, and
  real throwaway rebase stops.
- `tests/reap-worktree.test.sh`: worktree collection and every deletion guard.
- `tests/update-claude.test.sh`: idle-gated updater behavior.

Never weaken or delete a test to make a change pass. Test the host-facing shell
scripts using fake executables placed first on `PATH` and throwaway repositories
under `mktemp`; never point a test at the real registry or host.

## Live-host safety

The user's tmux sessions and GitHub queues are live production state. Without
an explicit request, never run or invoke:

- `remote-control.sh start`, `epic`, `fix`, `stop`, `restart`, or `stop-all`;
- `bin/dispatch.sh` except with `--dry-run`;
- `bin/reap.sh` except with `-n`;
- `bin/update-claude.sh` except with `-n`;
- `bin/merge-worker.sh` or `bin/merge-tick.sh` in any mode.

Safe read-only operations include `remote-control.sh ls`, `bin/reap.sh -n`,
`bin/update-claude.sh -n`, `bin/resource-report.sh`, GitHub queue reads, and
plain tmux inspection over SSH.

Do not use shell-function stubs from zsh for host-facing tests: zsh cannot
export them to a child Bash process, which can silently call the real `ssh`.
Use fake executables on `PATH` instead.

## Review focus

When reviewing changes, prioritize:

- a failure path that accidentally becomes success;
- a race between dispatch, reap, launch, and merge;
- stale-green CI being accepted after a rebase;
- cleanup without a positive safety proof;
- loss of one side's intent during conflict resolution;
- unbounded retries, parallelism, or host resource use;
- divergence between laptop setup and host provisioning;
- vendor-specific behavior leaking outside the engine adapter;
- tests that could reach SSH, GitHub, a real clone, or a live tmux server.
