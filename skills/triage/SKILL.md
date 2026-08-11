---
name: triage
description: Surface everything stuck in the epic pipeline since you last looked — failed and review-waiting issues, stuck queue states, dead sessions — across all registered repos. Use when the user asks what got stuck, what needs them, or for a pipeline status check when sitting down to work.
---

Produce the operator's sit-down brief: everything that needs a human, everything
stuck in the machine, and what landed unattended. **Read-only everywhere** — this
skill surfaces and suggests; it never relabels, merges, kills or launches
sessions, and never runs `dispatch.sh`, `reap.sh` or `merge-worker.sh`. The
allowed surface is exactly the harness CLAUDE.md's safe list: `gh` reads,
`./remote-control.sh ls`, read-only `ssh` queries (`tmux capture-pane`, log
tails). Laptop-side, like `remote-control.sh`.

Window override (optional, e.g. `3d`, `12h`, an ISO date): $ARGUMENTS

## 0. Setup and watermark

- The harness checkout is `$CLAUDE_HARNESS_DIR`. Source `etc/lib.sh` from it to
  get `REPOS`, `REPO_ORIGINS` and `SSH_HOST`.
- Read `~/.claude/triage-last-run` (one ISO-8601 UTC timestamp): that is the
  watermark. Missing ⇒ use 24h ago and say so in the brief. An explicit
  `$ARGUMENTS` window overrides the file.
- Note the current time as run-start now, but **write it to the file only after
  the brief has rendered** — a run that dies must not swallow its window.
- The watermark marks *newness* and bounds the away-digest and log scans. It
  never filters the state sections: a `failed` issue needs the user however old
  it is.

## 1. Needs a decision (state — no window)

Per repo, via `gh -R <owner/repo>` from `REPO_ORIGINS`, open issues only:

- **`failed`** — read the newest 🤖 comment for the cause and check the PR's
  state (`mergeable` says if a conflict is still live). Report: one-line cause,
  PR link, and what finishing takes — typically *fix the cause, push, swap
  `failed` → `ready-to-merge`; the merge worker lands it from there*.
- **`ready-to-review`** — read the deferred/summary comment and extract the
  actual decision the human is being asked to make, not the whole list.

## 2. Stuck in the machine (state + age heuristics)

These catch what labels alone don't flag. The thresholds are advisory
heuristics, not pipeline contracts — say "looks stuck", not "is broken".

- **`ready-to-merge` open for over ~1h** — the worker drains in minutes, so
  check `~/merge.log` since the watermark for the why (infrastructure aborts
  log "aborting the run" and write no label).
- **`ready` untouched for over ~18h** — list its open `blocked_by` issues;
  blockers explain it (report the chain), no blockers means dispatch is
  passing it over — flag for investigation.
- **`in-progress` with no live session on the host** — a stranded claim; reap
  recycles it after `CLAIM_GRACE_HOURS` (6h). Report the age so the user can
  wait or intervene.

## 3. Host half (one ssh, read-only)

- Sessions with status (`./remote-control.sh ls`). For each **dead** session,
  `tmux capture-pane -p -t <name> -S -60` — the scrollback is the only record
  of why claude exited; summarize it in a line.
- `~/reap.log` and `~/merge.log` lines since the watermark that flag problems:
  reap's "leaving alone" / "could not" entries, merge's aborts.

## 4. While you were away (window)

Issues closed since the watermark = deliveries merged unattended. One line
each, no detail — this section is a receipt, not a report.

## The brief

- Lead with a one-line verdict: "N need you, M look stuck, K landed" — or the
  all-clear.
- Then only the non-empty sections, grouped per repo. Each item: issue link,
  title, one-line cause, next action.
- Mark **NEW** on items whose triggering event is after the watermark; the rest
  are carried over from earlier briefs.
- Finish by writing run-start to `~/.claude/triage-last-run`.
