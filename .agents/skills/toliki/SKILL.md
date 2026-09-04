---
name: toliki
description: Surface everything stuck in the epic pipeline — failed and review-waiting issues, stuck queue states, dead sessions, orphaned agent processes and leaked worktrees — across all registered repos. Use when the user asks what got stuck, what needs them, or for a pipeline status check when sitting down to work.
---

Produce the operator's sit-down brief: everything that needs a human and
everything stuck in the machine. Stateless and read-only: the brief is computed
from current state only, with nothing written anywhere, so it reports the same
truth whether it ran an hour ago or a week ago. This skill surfaces and
suggests; it never relabels, merges, kills or launches sessions, and never runs
`dispatch.sh`, `reap.sh` or `merge-worker.sh`. The allowed surface is exactly
the harness AGENTS.md's safe list: `gh` reads, `./remote-control.sh ls`,
read-only `ssh` queries (`tmux capture-pane`, log tails). Laptop-side, like
`remote-control.sh`.

## 0. Setup

Run laptop-side commands from the Toliki repository root (the checkout that
contains this skill at `.agents/skills/toliki/SKILL.md`). Its machine-local
`etc/repos.conf` is the registry: `REPO_ORIGINS` decides which repos get
checked (every entry, always), and `SSH_HOST` is how the host is reached. No
other repo list exists. Source `etc/lib.sh` under bash explicitly, since it
locates itself via `BASH_SOURCE` and the interactive shell may be zsh:

```
bash -c 'source etc/lib.sh && printf "%s\n" "${REPO_ORIGINS[@]}"'
```

If it fails, report the message it prints. Never
`cp etc/repos.conf.template etc/repos.conf`: that file is gitignored and
machine-local, and the copy destroys the real registry.

## 1. Needs a decision (all open issues, however old)

Per repo, via `gh -R <owner/repo>`:

- **`failed`**: first check for a fixer queue label beside it, which changes
  who owns the issue. Two of them exist, each with its own attempt ladder:
  `needs-judgment` (a rebase conflict; ladder `fix-attempted`/`fix-retried`)
  and `needs-ci-fix` (checks red on the rebased head; ladder
  `ci-attempted`/`ci-retried`).
  - a queue label **without** its spent-ladder label: the automated fixer owns
    it and dispatch relaunches it on its own, so this is not a decision item.
    Mention it under "stuck in the machine" only if it has sat unchanged for
    over ~1h; then check sessions and `~/dispatch.log` for why the fixer walk
    is not picking it up.
  - a queue label **with** its spent-ladder label (`fix-retried`,
    `ci-retried`): that fixer's attempt ladder is exhausted, a real decision
    item. Read the newest 🤖 fix-conflict or 🤖 fix-ci comment; the human
    either finishes it by hand or strips that ladder's two labels to grant
    another round.
  - plain `failed`: read the newest 🤖 comment for the cause and check the
    PR's state (`mergeable` says if a conflict is still live). Report a
    one-line cause, the PR link, and what finishing takes: typically *fix the
    cause, push, swap `failed` → `ready-to-merge`; the merge worker lands it
    from there*.
- **`ready-to-review`**: read the deferred or summary comment and extract the
  actual decision the human is being asked to make, not the whole list.

## 2. Stuck in the machine

These catch what labels alone do not flag. The age thresholds are heuristics
about *current* state, not reporting windows: say "looks stuck", not "is
broken".

- **`ready-to-merge` open for over ~1h**: the worker drains in minutes, so
  check the tail of `~/merge.log` for the why (infrastructure aborts log
  "aborting the run" and write no label). An issue the CI fixer just returned
  here is normal: it goes back through the worker's rebase and check re-run.
- **`ready` untouched for over ~18h**: list its open `blocked_by` issues.
  Blockers explain it (report the chain); no blockers means dispatch is
  passing it over, so flag it for investigation.
- **`in-progress` with no live session on the host**: a stranded claim; reap
  recycles it after `CLAIM_GRACE_HOURS` (6h). Report the age so the user can
  wait or intervene.

## 3. Host half (one ssh, read-only)

- Sessions with status: `./remote-control.sh ls`, run locally from the harness
  checkout and never wrapped in `ssh`. The script sshes to `SSH_HOST` itself;
  sent to the host it fails with `Temporary failure in name resolution`, which
  is not a DNS problem and no retry fixes. (`ssh $SSH_HOST 'tmux ls'` is the
  direct equivalent, and does go over ssh.)

  A dead pipeline session is not news by itself: the orchestrator exits when
  its run ends, so every finished `<repo>-epic-<N>` sits at a shell prompt
  until reap kills it. What separates finished from crashed is the run's last
  line, so check that before reading anything else:

  ```
  ssh $SSH_HOST 'tmux capture-pane -p -t <name> -S -200 | grep "^RESULT "'
  ```

  - **A `RESULT` line exists**: the run finished and reported itself.
    `readyToMerge`/`mergeSkipped` are already covered by the label sections
    above, so say nothing; `skipped` or `blocked` is the item, and the JSON's
    own `reason` is the one-line cause. Reap clears the session on its next
    sweep either way.
  - **No `RESULT` line**: the run died mid-phase, and the scrollback is the
    only record of why. `capture-pane -p -t <name> -S -60`, summarize the
    failure in a line, and flag it: nothing will relaunch that issue until the
    session is gone, and reap deliberately leaves a non-terminal dead session
    alive so the scrollback survives.

  For a dead **interactive** session (a pool name), the scrollback is the
  whole story; there is no RESULT line to look for.
- `~/reap.log` and `~/merge.log` are diagnostics, not a sweep. Tail one
  **only to explain an item already flagged above**, and `grep` it for the
  repo or issue at hand rather than reading the last N lines. Nothing flagged
  ⇒ skip them entirely; they are never a section of their own.

## 4. Host hygiene (same ssh, still read-only)

Two things that hold real resources while being invisible to every label.
Report only what is actually there, and skip the section entirely when both
are clean.

- **Orphaned agent processes.** Each phase of a run is its own `claude -p`
  process; a SIGKILL or the OOM killer leaves them running under no session,
  invisible to the slot cap (it counts tmux panes).

  ```
  ssh $SSH_HOST "pgrep -af '(^|/)claude -p( |\$)'"
  ```

  Keep that pattern anchored: a loose `claude .*-p` also matches an
  interactive session (whose command line carries
  `--dangerously-skip-permissions`), and reporting a healthy session as an
  orphan is worse than not looking.

  Cross-check against the live `<repo>-epic-<N>` sessions from §3: with a run
  in flight, these are simply its current phase and there is nothing to
  report. Agents with **no** live pipeline session are the finding. Report the
  count, the oldest start time (`ps -o lstart= -p <pid>`), and that clearing
  them is `kill -TERM -<pgid>`, as a suggestion the user runs, never something
  this skill does. Reap refuses to kill them for the same reason: a long
  verify and a hung one look identical from outside.

- **Leaked worktrees.** Each run gets one under `~/.epic-worktrees/<repo>/`,
  and reap removes one only once its issue's branch is gone from origin and
  `$WORKTREE_GRACE_HOURS` (24h) have passed. A pile-up therefore means either
  reap is not running or those issues still have open branches:

  ```
  ssh $SSH_HOST 'du -sh ~/.epic-worktrees/*/* 2>/dev/null | sort -h | tail -20; df -h / | tail -1'
  ```

  Worth a line only when the total matters against free disk, or when a
  worktree's issue is closed and well past the grace (which points at reap,
  not at the worktree). Otherwise silent: a worktree per in-flight and
  recently-finished issue is the design working.

## The brief

- Lead with a one-line verdict: "N need you, M look stuck", or the all-clear.
- Then only the non-empty sections, grouped per repo. Each item: issue link,
  title, one-line cause, next action.

## Fixer prompts

For each **`failed`** item, follow the next-action line with a fenced code
block holding a copy-ready prompt. The user pastes it into a fresh session
opened on a **new worktree of that repo's own clone**, so the prompt carries
no repo identity, no clone check and no orientation, only what that session
cannot see: the issue, the cause, the PR and the branch, and the boundary that
the merge worker owns the landing. Keep it terse. Compose it on this shape,
adapting step 1 to the actual cause (a red check or CI timeout needs a code
fix, not a rebase):

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
- **`ready-to-review` items get no prompt**: the label means a human decides,
  and a fixer session has nothing to fix until that decision is made.
