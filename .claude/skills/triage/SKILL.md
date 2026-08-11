---
name: triage
description: Surface everything stuck in the epic pipeline — failed and review-waiting issues, stuck queue states, dead sessions — across all registered repos. Use when the user asks what got stuck, what needs them, or for a pipeline status check when sitting down to work.
model: sonnet
---

Produce the operator's sit-down brief: everything that needs a human and
everything stuck in the machine. **Stateless and read-only** — the brief is
computed from current state only, with no look-back window and nothing written
anywhere, so it reports the same truth whether it ran an hour ago or a week
ago. This skill surfaces and suggests; it never relabels, merges, kills or
launches sessions, and never runs `dispatch.sh`, `reap.sh` or
`merge-worker.sh`. The allowed surface is exactly the harness CLAUDE.md's safe
list: `gh` reads, `./remote-control.sh ls`, read-only `ssh` queries
(`tmux capture-pane`, log tails). Laptop-side, like `remote-control.sh`.

## 0. Setup

The harness checkout is `$CLAUDE_HARNESS_DIR`. Source `etc/lib.sh` from it:
the machine-local `etc/repos.conf` it loads is the registry — `REPO_ORIGINS`
decides which repos get checked (every entry, always), and `SSH_HOST` is how
the host is reached. No other repo list exists.

**Source it under bash explicitly** — `lib.sh` locates itself via
`BASH_SOURCE`, and this shell is zsh, where that is empty:

```
bash -c 'source etc/lib.sh && printf "%s\n" "${REPO_ORIGINS[@]}"'
```

A bare `source etc/lib.sh` now fails with a message naming the cause; whatever
it says, **never `cp etc/repos.conf.template etc/repos.conf`** — that file is
gitignored and machine-local, and the copy destroys the real registry.

## 1. Needs a decision (all open issues, however old)

Per repo, via `gh -R <owner/repo>`:

- **`failed`** — read the newest 🤖 comment for the cause and check the PR's
  state (`mergeable` says if a conflict is still live). Report: one-line cause,
  PR link, and what finishing takes — typically *fix the cause, push, swap
  `failed` → `ready-to-merge`; the merge worker lands it from there*.
- **`ready-to-review`** — read the deferred/summary comment and extract the
  actual decision the human is being asked to make, not the whole list.

## 2. Stuck in the machine

These catch what labels alone don't flag. The age thresholds are advisory
heuristics about *current* state, not reporting windows — say "looks stuck",
not "is broken".

- **`ready-to-merge` open for over ~1h** — the worker drains in minutes, so
  check the tail of `~/merge.log` for the why (infrastructure aborts log
  "aborting the run" and write no label).
- **`ready` untouched for over ~18h** — list its open `blocked_by` issues;
  blockers explain it (report the chain), no blockers means dispatch is
  passing it over — flag for investigation.
- **`in-progress` with no live session on the host** — a stranded claim; reap
  recycles it after `CLAIM_GRACE_HOURS` (6h). Report the age so the user can
  wait or intervene.

## 3. Host half (one ssh, read-only)

- Sessions with status (`./remote-control.sh ls`). Run it **locally, from the
  harness checkout — never wrapped in `ssh`**: the script sshes to `SSH_HOST`
  itself, so sending it to the host makes the host try to resolve that alias
  and fail with `Temporary failure in name resolution`. That wording invites a
  flaky-DNS reading; it is not one, and no number of retries will change it.
  (`ssh $SSH_HOST 'tmux ls'` is the direct equivalent, and does go over ssh.)
  For each **dead** session, `tmux capture-pane -p -t <name> -S -60` — the
  scrollback is the only record of why claude exited; summarize it in a line.
- `~/reap.log` and `~/merge.log` are diagnostics, not a sweep. Read a tail
  **only to explain an item already flagged above** (a stuck `ready-to-merge`,
  a session reap is leaving alone). Nothing flagged ⇒ skip them entirely:
  there is no finding for them to serve, and they are never a section of their
  own. When you do tail one, search it (`grep`) for the repo or issue at hand
  rather than reading the last N lines — the recent tail is mostly ticks.

## The brief

- Lead with a one-line verdict: "N need you, M look stuck" — or the all-clear.
- Then only the non-empty sections, grouped per repo. Each item: issue link,
  title, one-line cause, next action.

## Fixer prompts

For each **`failed`** item, follow the next-action line with a fenced code
block holding a copy-ready prompt. The user pastes it into a fresh session
opened on a **new worktree of that repo's own clone**, so the prompt carries
no repo identity, no clone check and no orientation — the session is already
in the right place. What it must carry is what that session cannot see: the
issue, the cause, the PR and the branch, and the boundary that the merge
worker owns the landing. Keep it terse; the fixer is an agent, not a runbook
reader. Compose it on this shape, adapting step 1 to the actual cause (a red
check or CI timeout needs a code fix, not a rebase):

```
Issue #<N> "<title>" failed at the merge gate: <one-line cause>. The change is
complete on PR #<P> (branch <epic/N-...>).

1. Rebase <branch> on fresh origin/main, resolving conflicts so both the epic's
   intent and what has since landed survive.
2. `npm run verify` in the affected packages until green.
3. Push with --force-with-lease.
4. Swap labels on #<N>: remove `failed`, add `ready-to-merge`.

Do NOT merge the PR yourself — the merge worker owns merge order and lands it
after re-checking on the true base.
<Anything the issue's own comments flag as still owed — a deferred eval run,
a manual step — goes here as an extra numbered step or note.>
```

Two boundaries:

- When several `failed` items share a repo, say so above the blocks and advise
  running one fixer at a time: each landed PR moves `main`, which can
  re-conflict the others' fresh rebases.
- **`ready-to-review` items get no prompt** — the label means a human decides;
  a fixer session has nothing to fix until that decision is made.
