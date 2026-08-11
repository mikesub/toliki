# toliki

A self-hosted Claude Code harness that turns GitHub issues into merged PRs unattended.
A VPS runs detached `claude` sessions in tmux; cron drains the issue queue, runs one
autonomous "epic" per issue to an open green PR, and a serial merge worker
rebases, re-verifies and lands them. You write specs; the box does the rest.

## The loop

1. **`/spec`** (interactive, the one human gate) — design a change with Claude,
   file it as one or more GitHub issues labeled `ready`, ordered by real
   `blocked_by` dependencies.
2. **`bin/dispatch.sh`** (cron, on the VPS) — walks each repo's `ready` queue
   and launches a tmux session per unblocked issue, up to the host's slot
   budget.
3. **`/epic`** (inside the session) — claims the issue, architects, implements
   with TDD, reviews, and ends at an open PR with `ready-to-merge` (gates
   cleared, lands unattended) or `ready-to-review` (a human decides).
4. **`bin/merge-worker.sh`** (cron) — one PR at a time per repo: rebase onto
   current main, wait for checks to re-run on the rebased head, squash-merge.
5. **`bin/reap.sh`** (cron) — frees what finished runs leave behind (idle
   sessions, stale claim refs), so the slot budget keeps rotating.

The operator watches from a laptop with `./remote-control.sh ls` and connects
to any session via the Claude Code Desktop app's remote control. Everything
else is scripts — no daemon, no database, no web UI; GitHub issues, labels and
refs are the entire state store.

## What it expects

- An Ubuntu VPS you can ssh into.
- `gh` authenticated on the VPS; a Claude Code subscription.
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
trust, the bypass-permissions consent). Turning the box autonomous is a
deliberate last step: install the cron file per the comment at the top of
`etc/dispatch.cron`.

On the laptop:

```
gh repo clone mikesub/toliki && cd toliki
./setup.sh              # wires ~/.claude, seeds etc/repos.conf — edit it, then re-run
./remote-control.sh ls
```

## Reading order

- **`DOCTRINE.md`** — why this exists, the principles, and the alternatives
  that were considered and rejected, with reasons.
- **`CLAUDE.md`** — how every piece actually works, including the operational
  traps that only show up when you run it.
- **`skills/`, `agents/`, `workflows/`** — the shared Claude Code content the
  pipeline runs on (`/spec`, `/epic`, the epic-run workflow, the subagents).

## Caveats

This is a working personal setup shared as-is, not a product. Sessions run
with `--dangerously-skip-permissions` inside git worktrees on your own VPS —
read `DOCTRINE.md` and decide for yourself before pointing it at anything you
care about.

It might not work with your setup — if so, ask Claude to fix it; the docs
here are written to give it everything it needs. If the fix is something
others would benefit from (not just local customization), a PR here is a
welcome courtesy.
