![piglets.png](piglets.png)

# toliki

A self-hosted coding-agent harness that turns GitHub issues into merged PRs unattended.
A VPS runs detached pipelines in tmux; cron drains the issue queue, runs one
autonomous "epic" per issue to an open green PR, and a serial merge worker
rebases, re-verifies and lands them. You write specs; the box does the rest.

The pipeline is a plain Node script that spawns one headless agent process per
phase behind a small engine adapter. Claude Code and Codex are both supported.

## The loop

1. **`/spec`** (interactive, the one human gate) — design a change,
   file it as one or more GitHub issues labeled `ready`, ordered by real
   `blocked_by` dependencies.
2. **`bin/dispatch.sh`** (cron, on the VPS) — walks each repo's `ready` queue
   and launches a tmux session per unblocked issue, up to the host's slot
   budget.
3. **`workflows/epic-run.mjs`** (the session's pane) — claims the issue,
   architects, implements with TDD, reviews under five blind lenses plus an
   adversarial verifier, and ends at an open PR with `ready-to-merge` (gates
   cleared, lands unattended) or `ready-to-review` (a human decides).
4. **`bin/merge-worker.sh`** (cron) — one PR at a time per repo: rebase onto
   current main, wait for checks to re-run on the rebased head, squash-merge.
   Mechanical rebase conflicts it resolves itself under a line-containment
   gate; a conflict that needs judgment is labeled for **`fix-run.mjs`**, a
   dispatched fixer run that resolves it under an adversarial check and
   returns the PR for human review. A red check on the rebased head is labeled
   for **`ci-run.mjs`**, which reads the failing job logs, repairs the cause
   under its own adversarial check, and puts the PR back in the merge queue —
   where its checks are re-run before anything lands.
5. **`bin/reap.sh`** (cron) — frees what finished runs leave behind (idle
   sessions, stale claim refs), so the slot budget keeps rotating.

The operator watches from a laptop with `./remote-control.sh ls`, and reads a
run with `tmux attach` / `capture-pane` — the pane carries its phase log and a
final `RESULT` line. (Interactive sessions, started by hand, still connect via
the Claude Code Desktop app's remote control; pipeline runs have no such
channel, by design — the only mid-run lever is kill.) Everything
else is scripts — no daemon, no database, no web UI; GitHub issues, labels and
refs are the entire state store.

## What it expects

- An Ubuntu VPS you can ssh into.
- `gh` authenticated on the VPS; a Claude Code and/or Codex subscriptions for pipeline runs.
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

`provision.sh` installs everything else and prints an exact checklist of the
few interactive steps it cannot do for you (logins, per-clone workspace
trust, the bypass-permissions consent). It installs and authenticates both
agent CLIs. Route the next unassigned epic with
`./remote-control.sh next codex` or `./remote-control.sh next claude`; add
`-r <repo>` to restrict selection. An engine is a named table in
`etc/engines.json` saying which vendor, model and effort runs each pipeline
step, so one engine can code on Claude and review on Codex. Unlabeled issues
run on the host's `EPIC_ENGINE` default, set in `etc/dispatch.cron` (claude
when unset).
Turning the box autonomous is a deliberate last step: install the cron file
per the comment at the top of `etc/dispatch.cron`.

On the laptop:

```
gh repo clone mikesub/toliki && cd toliki
./setup.sh              # wires ~/.claude, seeds etc/repos.conf — edit it, then re-run
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
- **`workflows/`** — the two pipelines and the small runtime they sit on
  (the engine adapter, the git/gh transport, the concurrency gate,
  structured-output validation).
- **`skills/`, `agents/`** — the shared content: `/spec` (the human gate), the
  agent charters each phase runs under, and the manual entry points.

## Caveats

This is a working personal setup shared as-is, not a product. Sessions run
with `--dangerously-skip-permissions` inside git worktrees on your own VPS —
read `DOCTRINE.md` and decide for yourself before pointing it at anything you
care about.

It might not work with your setup — if so, ask Claude/Codex to fix it; the docs
here are written to give it everything it needs. If the fix is something
others would benefit from (not just local customization), a PR here is a
welcome courtesy.
