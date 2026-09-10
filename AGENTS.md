# Toliki project instructions

These rules apply to work on **Toliki itself**, not to every project it builds.
Codex discovers this file natively; `CLAUDE.md` links here. Use relative
Markdown links, never `@file` includes.

Toliki is a self-hosted coding-agent harness: cron and plain Node orchestrators
turn GitHub issues into verified PRs in isolated git worktrees. GitHub holds
durable work state; tmux holds live processes. No daemon, database, web UI or
npm dependencies.

## Read what the change touches

- [WORKFLOW.md](WORKFLOW.md): short flow map and the
  [contract-owner index](WORKFLOW.md#contract-owners). Read the relevant owner's
  code, schema and comments before changing that behavior.
- [DOCTRINE.md](DOCTRINE.md): rationale and rejected alternatives. Read before
  changing pipeline shape, adding configuration, relaxing a gate or reopening
  a settled trade-off.
- [README.md](README.md#setup): setup, operating commands and host traps. Read
  before host/configuration work.
- [Issue tracking](skills/spec/ISSUE-TRACKING.md): the authority for slicing,
  filing and ordering work.
- [Registry template](etc/repos.conf.template) and [helpers](etc/lib.sh):
  configuration contract. `etc/repos.conf` is machine-local and gitignored;
  never commit it or copy its values over the template.

Detailed runtime contracts belong beside their owning implementation, not in
this file. WORKFLOW links to them; DOCTRINE explains why; README explains setup.
When prose, tests and executable behavior disagree, investigate the intended
contract and fix the stale side in the same change. Do not turn stale prose
into an extra gate or change behavior merely to match it. Update the owner and
any affected map/rationale, not a duplicate narrative in every document.

## Change rules

1. Inspect the worktree and preserve unrelated edits. Make the smallest
   coherent change; keep existing exit-code contracts.
2. Keep the architecture split: `./toliki` and `operator/` run on the laptop;
   `bin/` runs on the host and never SSHes. Node orchestrators stay
   vendor-neutral; CLI invocation belongs in `workflows/lib/engine.mjs`.
   Check dispatch, reap and merge together when changing their interaction.
3. Preserve fail-closed gates, independent read-only judgment, bounded retries,
   process-group cleanup and positive proof before deleting work. Models make
   judgments; deterministic code owns evidence capture, verification and
   delivery. An agent's claim is never a passed gate.
4. Keep instructions in one layer: standing role rules in `agents/*.md`,
   answer shape in the phase schema, task/evidence in its prompt builder.
   Never copy shared skills or charters into target projects or inject another
   copy of their root instructions. Project-specific policy stays in that
   project; verification must isolate or serialize its own shared resources.
5. Add hermetic regression coverage for behavior changes; a new gate/refusal
   needs both pass and stop cases. Never weaken or delete tests to get green.
   Use Bash 3.2-compatible laptop scripts, no npm dependencies, explicit schemas
   and guarded/idempotent writes (`--force-with-lease`, not an unguarded push).
6. Run relevant suites; run all suites for a broad change: `./test.sh`.
   Tests must use fake executables first on `PATH` and `mktemp` repositories,
   never the real registry, host, GitHub or tmux. Route engine fixtures by
   `EPIC_STEP_LABEL`, not prompt wording. Do not stub with zsh functions:
   child Bash cannot inherit them and may call the real `ssh`.
   `TEST_JOBS=1 ./test.sh` runs serially.

When explicitly asked to commit or push, use `main` directly. No feature
branches or PRs unless requested; readiness alone never authorizes publication.
Lifecycle labels are automation-owned; do not add or repurpose one.

## Live-host safety

The user's sessions and queues are production state. Without an explicit
request, never run:

- `./toliki session start|stop|restart|stop-all` or bare `session <name>`,
  `./toliki run epic|task|fix|ci|defect`, `./toliki route next`,
  `./toliki config set`, or `./toliki sync`;
- `bin/dispatch.sh` except `--dry-run` (`--route-next` and `--route-issue`
  mutate labels);
- `bin/reap.sh` except `-n`, or `bin/update-claude.sh` except `-n`;
- `bin/merge-worker.sh` or `bin/merge-tick.sh` in any mode.

Safe on your own initiative: `./toliki session list`, `./toliki usage`,
`./toliki config show`, `bin/reap.sh -n`, `bin/update-claude.sh -n`,
`bin/resource-report.sh`, GitHub reads and read-only tmux inspection.

Pipeline sessions (`<repo>-epic-<N>`) run Node orchestrators, not interactive
agents: inspect their pane/log and final `RESULT`; there is no steering
channel. Remote Control applies only to interactive sessions. Never invent a
second pipeline session-name pattern.

## Review focus

Prioritize false success on failure paths, dispatch/reap/merge races,
stale-green CI, unsafe cleanup, lost conflict-side intent, unbounded resource
use, laptop/host setup divergence, vendor leakage and tests that reach live
systems.
