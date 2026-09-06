![piglets.png](piglets.png)

# toliki

A self-hosted coding-agent harness that turns GitHub issues into merged PRs unattended.
A VPS runs detached pipelines in tmux; cron drains the issue queue, runs one
autonomous "epic" per issue to an open green PR, and a serial merge worker
rebases, re-verifies and lands them. You write specs; the box does the rest.

The pipeline is a plain Node script. It does everything deterministic itself —
the claim, the labels, the commits, the push, the PR, `npm run verify` — and
spawns a short-lived headless agent process, behind a small engine adapter,
only where a judgment is needed. Claude Code and Codex are both supported.

## The loop

1. **`/spec`** (interactive, the one human gate) — design a change,
   file it as one or more GitHub issues labeled `ready`, ordered by real
   `blocked_by` dependencies.
2. **`bin/dispatch.sh`** (cron, on the VPS) — walks each repo's `ready` queue
   and launches a tmux session per unblocked issue, up to the host's slot
   budget. Repair queues run first; ship-gate defect repair is walked only for
   repositories listed in the machine-local `DEFECT_FIX_REPOS` allowlist. A
   provider quota hold skips ordinary or dry-run candidates whose engine uses
   that vendor until its UTC reset time, while candidates on other vendors keep
   launching; routing-only operations bypass the hold.
3. **`workflows/epic-run.mjs`** (the session's pane) — claims the issue,
   makes a proportional architecture plan, then implements through either
   test-first red/green or a direct coding step. Both paths pass the project's
   verify gate run by the orchestrator. One general reviewer always runs; the
   plan may request one additional review for a concrete risk question.
   The fixer assesses findings and repairs, rejects or defers each one. An
   independent checker judges every disposition, including no-edit rejections,
   and the complete repair delta. Open items get at most one final repair round;
   missing evidence holds the PR for a human. Ship then
   rebases the run's checkpoint chain onto current `main` and re-runs verify
   before squashing, so a base that moved during the run is met here rather
   than by the merge worker; a conflict or a failed fetch ships on the run's
   own base and leaves it to the worker. The run ends at an open PR with
   `ready-to-merge` (gates cleared, lands unattended)
   or `ready-to-review` (a human decides). A hard provider quota is a successful
   held outcome instead: the resumable branch is preserved, the issue returns
   to its queue without spending a fixer attempt, and automatic dispatch waits
   only for the failed step's vendor hold. Ordinary transient 429s still retry
   once.
4. **`bin/merge-worker.sh`** (cron) — one PR at a time per repo: rebase onto
   current main, give checks time to register, then wait for every published
   check on the rebased head and squash-merge. An empty rollup after the grace
   is accepted for repos with no CI.
   Mechanical rebase conflicts it resolves itself under a line-containment
   gate; a conflict that needs judgment is labeled for **`fix-run.mjs`**, a
   dispatched fixer run that resolves it under an adversarial check and puts
   the PR back in the merge queue. A red check on the rebased head is labeled
   for **`ci-run.mjs`**, which reads the failing job logs, repairs the cause
   under its own adversarial check, and puts the PR back in the merge queue —
   where its checks are re-run before anything lands.
   A PR held only on concrete ship-gate defects is marked for
   **`defect-run.mjs`**, a separate two-attempt fixer. Epic-run first persists
   and reads back one automation-authored repair envelope bound to the PR head;
   the fixer accepts only that envelope, verifies and adversarially checks its
   exact delta, then returns the PR to that same merge queue. Mixed, missing or
   stale evidence stays with a human. Every readback that confirms one of the
   run's own writes — the PR head after a force push, the labels after a swap —
   is retried over a bounded window rather than read once, and an attempt that
   pushed a complete repair it could not label leaves a record that lets the
   next attempt redo only the landing.
5. **`bin/reap.sh`** (cron) — frees what finished runs leave behind (idle
   sessions, including settled dead quota-held sessions at `ready`, and stale
   claim refs), so the slot budget keeps rotating.

The operator watches from a laptop with `./remote-control.sh ls` (and
`./remote-control.sh usage` for what the steps cost), and reads a
run with `tmux attach` / `capture-pane` — the pane carries its phase log and a
final `RESULT` line. (Interactive sessions, started by hand, still connect via
the Claude Code Desktop app's remote control; pipeline runs have no such
channel, by design — the only mid-run lever is kill.) Everything
else is scripts — no daemon, no database, no web UI; GitHub issues, labels and
refs are the durable work store. Host facts stay local: lock files, usage
telemetry, and the expiring provider hold at `~/epic-provider-hold.json`.

## What it expects

- An Ubuntu VPS you can ssh into.
- `gh` authenticated on the VPS; a Claude Code and/or Codex subscription for pipeline runs.
- Projects that define verification as a contract: a *package* is any
  directory whose `package.json` declares `scripts.verify`, and that script is
  the gate an epic must turn green.

## Setup

On the VPS:

```
sudo apt-get update && sudo apt-get install -y git gh
gh auth login
gh repo clone mikesub/toliki /home/ubuntu/toliki
cd /home/ubuntu/toliki
cp etc/repos.conf.template etc/repos.conf   # then edit: your repos + origins
bin/provision.sh                            # idempotent; repeats until green
```

Set `HOST_TIMEZONE` in the host's `etc/repos.conf` to an IANA zone such as
`Europe/Amsterdam`; empty or unset means UTC. Provisioning applies that zone to
the host and verifies the readback. Pane logs, live status comments, cron-script
logs, and resource-report bounds then use `YYYY-MM-DD HH:mm:ss ABBR` with the
abbreviation valid at that instant. The launcher passes the registry value into
manual and dispatched tmux panes, so an SSH caller's timezone cannot override
it. Parsed records—usage and resource JSON, hold deadlines, and GitHub time
comparisons—remain canonical UTC ISO 8601.

`provision.sh` installs everything else and prints an exact checklist of the
few interactive steps it cannot do for you (logins, per-clone workspace
trust, the bypass-permissions consent). It installs and authenticates both
agent CLIs. Route the next unassigned epic with
`./remote-control.sh next codex` or `./remote-control.sh next claude`; add
`-r <repo>` to restrict selection. An engine is a named table in
`etc/engines.json` saying which vendor, model and effort runs each pipeline
step, so one engine can code on Claude and review on Codex. Unlabeled issues
run on the host's `EPIC_ENGINE` default, read from the installed copy of
`etc/dispatch.cron` (claude when that file is absent, and a file whose value
disagrees with the environment refuses to launch anything rather than guess).
From the laptop, `./default-engine.sh` prints the VM's installed
default and available engines; pass an engine name to change the VM default
for future unpinned claims. An unlabeled issue consults that default only for
its first claim. Once the claim succeeds, the run snapshots its selection as
the issue's sole `engine:<name>` label and reads it back before any model starts.
That GitHub write/readback is a hard gate: resumes and every fixer require the
same exact pin rather than falling back to a later host default, and missing,
mismatched, or conflicting pins stop for an operator without being rewritten.
Turning the box autonomous is a deliberate last step: install the cron file
per the comment at the top of `etc/dispatch.cron`.
`--engine` is optional on every manual `./remote-control.sh epic|fix|ci|defect`
launch. Given, it is persisted as the issue's durable `engine:<name>` label and
verified before the run starts, so the choice survives resumes and fixer
retries. Omitted, the host resolves it and writes nothing: the issue's own
`engine:<name>` label, else the host default above, else claude — and the
launch reports which of the three chose it. Inheriting never creates, replaces
or removes a label, which is what keeps a host-wide fallback distinguishable
from a per-issue decision; a closed or unreadable issue, an unknown or
conflicting routing label, or an unreadable host default refuses without
launching.
Defect repair is empty-by-default: add selected registered repo names to
`DEFECT_FIX_REPOS=(...)` in the host's `etc/repos.conf`, or launch a marked
issue explicitly with `./remote-control.sh defect N -r <repo>`.
All explicit `remote-control.sh epic|fix|ci|defect` launches bypass an active
provider hold as a deliberate operator override. A mixed engine waits if any
vendor it uses is held; admission never reroutes an issue to a different engine.

On the laptop:

```
gh repo clone mikesub/toliki && cd toliki
./setup.sh              # exposes /spec + spec-explorer to both clients; seeds local config
./remote-control.sh ls
```

## Reading order

- **`AGENTS.md`** — the project instructions for any agent (`CLAUDE.md` is a
  pointer to it): reading order, glossary, boundaries, invariants, the
  operational traps the code cannot show, and live-host safety.
- **`DOCTRINE.md`** — why this exists, the principles, and the alternatives
  that were considered and rejected, with reasons.
- **`bin/`, `etc/`** — the host-side scripts and config; each header states
  its contract and the incident behind it.
- **`workflows/`** — the epic pipeline and three fixers (`epic-run`, `fix-run`,
  `ci-run`, and `defect-run`) plus the small runtime they sit on: the engine
  adapter, the git/gh/npm transport, the concurrency gate, structured-output
  validation, and the per-spawn usage log `usage-report.mjs` summarizes.
- **`skills/`, `agents/`** — `/spec` and its `spec-explorer` are exposed to local
  Claude and Codex sessions; pipeline entry contracts and phase charters stay
  internal. Each client gets the same read-only charter in its native format,
  without shadowing Codex's built-in `explorer`.
- **`.agents/skills/toliki`** — the project-local, cross-client operator skill
  for checking stuck pipeline work; Claude discovers the same source through
  `.claude/skills/toliki`.

## Caveats

This is a working personal setup shared as-is, not a product. Sessions run
with `--dangerously-skip-permissions` inside git worktrees on your own VPS —
read `DOCTRINE.md` and decide for yourself before pointing it at anything you
care about.

It might not work with your setup — if so, ask Claude/Codex to fix it; the docs
here are written to give it everything it needs. If the fix is something
others would benefit from (not just local customization), a PR here is a
welcome courtesy.
