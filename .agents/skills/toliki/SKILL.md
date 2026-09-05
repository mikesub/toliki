---
name: toliki
description: Surface everything stuck in the epic pipeline — failed and review-waiting issues, stuck queue states, dead sessions, orphaned agent processes and leaked worktrees — across all registered repos. Use when the user asks what got stuck, what needs them, or for a pipeline status check when sitting down to work.
---

Produce the operator's sit-down brief: everything that needs a human and
everything stuck in the machine. Read-only and stateless: the brief is computed
from current state, and nothing is written anywhere. This skill surfaces and
suggests; it never relabels, merges, kills or launches sessions, and never runs
`dispatch.sh`, `merge-worker.sh`, or `reap.sh` without `-n`. The allowed
surface is exactly the harness AGENTS.md's safe list: `gh` reads,
`./remote-control.sh ls`, `bin/reap.sh -n`, and read-only `ssh` queries
(`tmux capture-pane`, log greps). Laptop-side, like `remote-control.sh`.

## 0. Setup

Run laptop-side commands from the Toliki repository root (the checkout that
contains this skill at `.agents/skills/toliki/SKILL.md`). The laptop's
machine-local `etc/repos.conf` is the connection and repository map; the host's
independent registry is authoritative for its clock. Read both through the
skill's helper:

```
bash .agents/skills/toliki/scripts/host-clock.sh
```

Every `REPO_ORIGINS` entry gets checked, always. `SSH_HOST` is the ssh
destination and `HOST_CONTROL_DIR` is where `bin/` lives on the host; carry
both into every ssh command below. `HOST_TIMEZONE` in the helper's output came
from the host checkout over ssh, never from the laptop registry. If the command
fails, report the message it prints. Never `cp etc/repos.conf.template
etc/repos.conf`: that file is gitignored and machine-local, and the copy
destroys the real registry.

Harness-authored pane, status-comment, cron-log, and resource-report timestamps
are already rendered in `HOST_TIMEZONE` as `YYYY-MM-DD HH:mm:ss ABBR`; read and
report them as that host clock. Canonical UTC deadlines from machine interfaces
must be converted with the host checkout's `human_ts` before presenting them:

```
bash .agents/skills/toliki/scripts/host-clock.sh --human-ts '<UTC instant>'
```

GitHub's own `updatedAt` values and comment dates are not harness timestamps:
leave those values as GitHub returned or rendered them.

## 1. Host probes (read-only)

Run all three first; §3 and §4 read their output.

- `./remote-control.sh ls`, run locally and never wrapped in `ssh` (it sshes
  to `SSH_HOST` itself). One line per session: name, repo, engine,
  `running`/`dead`.
- `ssh $SSH_HOST "$HOST_CONTROL_DIR/bin/reap.sh -n"`: the reaper's own sweep,
  changing nothing. It exits non-zero when something needs a human, and each
  such line is an item: a `<repo>-epic-<N>` session whose process died before
  its issue went terminal, an issue or ref listing it could not read, a claim
  it could not check, and agent processes running with no live pipeline
  session. Lines starting `would kill`, `would delete` or `would remove` are
  the design working: say nothing about them.
- `ssh $SSH_HOST "node '$HOST_CONTROL_DIR/workflows/quota-hold.mjs' peek"`:
  read-only provider admission state. Exit 0 prints one active JSON record;
  record its `holdUntil` and `fallback`. Exit 1 means absent or expired and is
  silent. Do not run `status` here: unlike `peek`, it may clear expired state.

## 2. Per-issue evidence

One query per repo gives every issue in a lifecycle state, with its age:

```
gh issue list -R <owner/repo> --state open --limit 200 --json number,title,labels,updatedAt \
  --jq '.[] | select([.labels[].name] | any(IN("ready","in-progress","ready-to-merge","ready-to-review","failed"))) | [.number, .updatedAt, ([.labels[].name] | join(",")), .title] | @tsv'
```

Every run edits one status comment on its issue, starting `🤖 **epic-run**`
(`fix-run` or `ci-run` for the fixers): the current phase and an `updated`
timestamp while it runs, and on exit a note: `**blocked** at <phase>:
<reason>`, `**skipped**: <reason>`, `**done** …`, `**done, held for
review** … (<reason>)`, or `**held**: provider quota exhausted …`. Every other
pipeline record is a 🤖 comment too. Read
them all in one call, oldest first:

```
gh issue view <N> -R <owner/repo> --json comments --jq '.comments[] | select(.body | startswith("🤖")) | .body'
```

## 3. Needs a decision (all open issues, however old)

- **`failed`**: a fixer queue label beside it changes who owns the issue.
  Two exist, each with its own attempt ladder: `needs-judgment` (a rebase
  conflict; ladder `fix-attempted`/`fix-retried`) and `needs-ci-fix` (checks
  red on the rebased head; ladder `ci-attempted`/`ci-retried`).
  - a queue label **without** its spent-ladder label: the automated fixer owns
    it and dispatch relaunches it on its own, so this is not a decision item.
    Mention it under §4 only if unchanged for over ~1h; then
    `grep "#<N>" ~/dispatch.log | tail` says why the fixer walk passes it.
  - a queue label **with** its spent-ladder label (`fix-retried`,
    `ci-retried`): that ladder is exhausted, a real decision item. The newest
    🤖 fix-conflict or fix-ci comment names the cause; the human either
    finishes it by hand or strips that ladder's two labels to grant another
    round.
  - plain `failed`: the newest `🤖 merge-worker blocked` or `🤖 epic-run
    blocked` comment names the cause, and `gh pr view <P> --json mergeable`
    says whether a conflict is still live. Report a one-line cause, the PR
    link, and what finishing takes: typically *fix the cause, push, swap
    `failed` → `ready-to-merge`; the merge worker lands it from there*.
- **`ready-to-review`**: a `🤖 deferred / not done` comment (an epic's ship).
  Extract the actual decision the human is being asked to make from its items,
  not the whole list. The status note's `held for review` reason is the gate
  that held it.
- **`in-progress` with no `running` session of its name in `ls`**: stranded,
  and nothing automated recovers it (reap never relabels; dispatch skips an
  issue whose session still exists, dead or not). Report the phase and
  `updated` time from the status comment, the scrollback line from §4, and
  what finishing takes: `./remote-control.sh stop <session>`, then swap
  `in-progress` → `ready` (a fixer run: → `failed`, its queue label is still
  on). A branch with checkpoints resumes on the next tick; one holding only
  the claim commit is refused as claimed elsewhere until reap clears it
  (`CLAIM_GRACE_HOURS`, 6h) or the human deletes it from origin.

## 4. Stuck in the machine

Heuristics about *current* state, not reporting windows: say "looks stuck",
not "is broken".

- **Active provider quota hold**: report one host-level item with its
  `holdUntil`; append “fallback reset” only when `fallback` is true. It explains
  why every automatic queue is paused, including work routed to another
  provider. Manual `remote-control.sh epic|fix|ci|defect` launches are still an
  explicit override. Say nothing when `peek` reports absent or expired state.
- **`ready-to-merge` open for over ~1h**: the worker drains in minutes.
  `grep "#<N>" ~/merge.log | tail` for the why; infrastructure aborts log
  "aborting the run" and write no label. An issue a fixer just returned here —
  the CI fixer or the conflict fixer — is normal: it goes back through the
  worker's rebase and check re-run.
- **`ready` untouched for over ~18h**: list its open blockers:

  ```
  gh api repos/<owner/repo>/issues/<N>/dependencies/blocked_by --jq '.[] | select(.state == "open") | .number'
  ```

  Blockers explain it (report the chain). None means dispatch is passing it
  over: `grep "#<N>" ~/dispatch.log | tail` shows what the last tick did with
  it (`blocked by`, `session exists`, `engine routing`, or nothing at all).
  Report that line.
- **Dead pipeline sessions**: the orchestrator exits when its run ends, so
  every finished `<repo>-epic-<N>` sits at a shell prompt until reap kills
  it; dead alone is not news. The issue's status note separates finished
  from crashed:
  - `**skipped**` or `**blocked**`: that is the item, and the note's reason
    is the one-line cause. `done` and `held for review` are already covered
    by §3's labels; provider `held` is covered by the host item above and its
    dead `ready` session is normal reap work: say nothing.
  - the comment never reached `finished` (it still shows a phase): the run
    crashed, and the scrollback is the only record:
    `ssh $SSH_HOST 'tmux capture-pane -p -t <name> -S -60'`. Summarize the
    failure in a line and flag it; reap never kills such a session, and the
    finish is §3's stranded recipe.

  A dead **interactive** session (a pool name) has no status comment; the
  scrollback is the whole story.
- **Orphaned agent processes** (`claude -p`, `codex exec` under no live
  session; the slot cap does not count them). Reap's sweep flags them only
  while no pipeline session is live; with runs in flight, list them yourself
  and match each to a session by its cwd (the worktree path ends in the
  session name):

  ```
  ssh $SSH_HOST 'for p in $(pgrep -f "(^|/)(claude -p|codex exec)( |$)"); do echo "$p $(ps -o lstart= -p $p) $(readlink /proc/$p/cwd)"; done'
  ```

  Keep the pattern anchored: a loose one also matches interactive sessions.
  Processes whose session is `running` are that run's current phase: nothing
  to report. The rest are the finding: report the count, the oldest start
  time, and that clearing them is `kill -TERM -<pgid>`, as a suggestion the
  user runs, never something this skill does.
- **Leaked worktrees**: each run gets one under `~/.epic-worktrees/<repo>/`,
  removed by reap only once the issue's branch is gone from origin and
  `WORKTREE_GRACE_HOURS` (24h) have passed.

  ```
  ssh $SSH_HOST 'du -sh ~/.epic-worktrees/*/* 2>/dev/null | sort -h | tail -20; df -h / | tail -1'
  ```

  Worth a line only when the total matters against free disk, or when a
  worktree's issue is closed and well past the grace (which points at reap,
  not at the worktree). Otherwise silent.

`~/dispatch.log`, `~/reap.log` and `~/merge.log` are diagnostics, not a
sweep: grep them for an issue only to explain an item already flagged above,
never as a section of their own.

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
