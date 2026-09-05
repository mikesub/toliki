#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, from cron. Frees what a finished or dead epic leaves behind:
# the tmux session still holding the issue's name, the stale claim ref still
# holding the head of the queue, and the worktree of a run whose work has
# already landed. Reads GitHub, kills tmux sessions, deletes claim refs on
# origin and removes delivered worktrees — it never launches anything and never
# touches a repo's own clone. Keep it free of any ssh/laptop assumptions (like
# launch.sh).
#
# It exists because none of the three frees itself:
#   * A finished run leaves its tmux session behind. The orchestrator process
#     does exit when the pipeline ends — so the SLOT frees itself, which was not
#     true of the interactive sessions this replaced — but the session keeps its
#     NAME, and that name is what dispatch's has-session checks read: until the
#     session is gone, the issue it names cannot be dispatched again. A run that
#     ended in a skip or a blocker is exactly the one that needs relaunching.
#   * epic-run's prepare CLAIMS the issue (pushes epic/<N>-<slug> to origin)
#     before it labels it in-progress, so a run that dies in between leaves the
#     issue `ready` at the head of the queue behind a ref every later run
#     refuses — and nothing reports it.
#   * launch.sh creates a worktree per run and reuses it on a relaunch, but
#     removes one only to replace it. Every issue the box has ever built would
#     otherwise keep a checkout and its node_modules on disk forever.
#
# The run itself no longer merges (bin/merge-worker.sh does, later), so a
# session is finished while its issue is still OPEN. The done signal is
# therefore the label — ready-to-merge, ready-to-review or failed — and not the
# issue closing, which happens long after the slot should have been freed. A
# dead pane at ready is also terminal: quota holds deliberately restore that
# queue state, while a live ready pane is still finishing its hold report.
#
# Reaping is deliberately conservative in every pass: it only ever kills
# sessions named <repo>-epic-<N> (pool-named and hand-made sessions are the
# user's own work and are never candidates), it only ever deletes a ref whose
# tip is a claim commit, and it only ever removes a worktree whose branch is
# already gone from origin — each of which is precisely the case where no work
# is being lost. Anything it could not check is left alone and reported.
#
# One thing it deliberately does NOT clean up: agent processes orphaned by a
# run that was SIGKILLed. Those are reported for a human instead — see the
# comment at that check for why killing them is a different class of act.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

# A claim ref stays claim-tipped for the WHOLE run, not for an instant: the
# code and triage phases checkpoint locally and only Ship pushes, so the first
# commit to land on top of the claim arrives at the very end of the epic. The
# live-session check below is the real guard; this grace is the backstop for a
# run whose session isn't named <repo>-epic-<N> (a hand-written -m message), so
# it has to be comfortably longer than an epic takes.
CLAIM_GRACE_HOURS="${CLAIM_GRACE_HOURS:-6}"

# How long a terminal label must sit still before its session is killed. Ship
# applies ready-to-review before the merge gate either promotes it or marks it
# for defect repair, so killing on the first terminal write could interrupt
# that handoff. Dispatch also synchronously shields every later fixer launch by
# swapping its resting terminal label to in-progress before creating the
# session (`failed` for conflict/CI, `ready-to-review` for defect repair). Thus
# "no edits for a few minutes" separates a run still finishing from one whose
# terminal state is truly resting without racing a newly launched fixer.
TERMINAL_SETTLE_MINUTES="${TERMINAL_SETTLE_MINUTES:-5}"

# The floor under that knob, and the other half of a contract this file shares
# with workflows/lib/github.mjs: a run writes its terminal label and THEN
# finishes — the label readback a fixer's guidance is composed from, the refusal
# comment itself, epic-run's merge gate after ship's ready-to-review, the status
# comment's final edit. GitHub starts the settle clock this pass reads the moment
# it applies that label, even if the client is still waiting on the response, so
# the write and everything after it share one budget (TERMINAL_REPORT_BUDGET_MS,
# plus status.mjs's own 20s) that stays well under a minute and a half. A window
# configured below this floor could kill a run in the middle of it — no guidance
# on the issue, no RESULT line in the pane — so a smaller value is raised rather
# than honoured: settling late only delays cleanup, settling early destroys the
# only report of why a run stopped.
MIN_TERMINAL_SETTLE_MINUTES=3

# How long a delivered run's worktree is kept before pass 3 removes it. Not a
# correctness bound — the branch being gone from origin is what proves the work
# is delivered — but a deliberate margin: disk is cheap, an operator opening
# yesterday's worktree to read what a run did is not, and a relaunch within the
# window reuses the checkout instead of re-cloning and re-installing it.
WORKTREE_GRACE_HOURS="${WORKTREE_GRACE_HOURS:-24}"

DRY_RUN=0
NEEDS_HUMAN=0

# Every line carries the sweep's UTC timestamp (ts is in etc/lib.sh).
say()  { echo "$(ts) [reap] $*"; }
# Anything reported here ends the run non-zero, so cron surfaces it.
warn() { echo "$(ts) [reap] $*" >&2; NEEDS_HUMAN=1; }

usage() {
  cat <<EOF
Usage: $0 [-n|--dry-run]

Sweeps the host once and exits:
  1. kills the tmux session of every <repo>-epic-<N> whose issue has reached a
     terminal state (labelled ready-to-merge/ready-to-review/failed; a dead pane
     labelled ready; or closed)
     and has sat still for \$TERMINAL_SETTLE_MINUTES (${TERMINAL_SETTLE_MINUTES}m, never under
     ${MIN_TERMINAL_SETTLE_MINUTES}m; a closed issue skips the wait — merged is delivered), and flags —
     without killing — any whose process died before it got there, because the
     pane's scrollback is the only record of why.
  2. deletes every epic/<N>-* ref on origin whose tip is still the claim commit
     and that no live session is working, older than \$CLAIM_GRACE_HOURS (${CLAIM_GRACE_HOURS}h).
  3. removes every pipeline worktree whose issue no longer has ANY epic branch
     on origin (so its work is delivered), that has no tmux session of its own,
     older than \$WORKTREE_GRACE_HOURS (${WORKTREE_GRACE_HOURS}h).
It also flags — never kills — agent processes left running by a SIGKILLed run.

-n reports what it would do and changes nothing. Exits non-zero when something
needs a human: a flagged session, orphaned agents, or a check that could not be
made.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    *) warn "unknown argument '$1'"; usage >&2; exit 1 ;;
  esac
done

if (( TERMINAL_SETTLE_MINUTES < MIN_TERMINAL_SETTLE_MINUTES )); then
  say "TERMINAL_SETTLE_MINUTES=${TERMINAL_SETTLE_MINUTES} is below the ${MIN_TERMINAL_SETTLE_MINUTES}m floor a finishing run's reporting needs — using ${MIN_TERMINAL_SETTLE_MINUTES}m"
  TERMINAL_SETTLE_MINUTES="$MIN_TERMINAL_SETTLE_MINUTES"
fi

NOW="$(date +%s)"
KILLED=0
DELETED=0
PRUNED=0
# Filled by pass 2, read by pass 3: which repos' origin-ref listings succeeded,
# and every issue that still has an epic branch on origin.
REFS_OK=""
ORIGIN_EPICS=""

# Without gh every issue query fails closed and the sweep could only ever
# report — say so once, up front, rather than once per session.
if ! gh auth status >/dev/null 2>&1; then
  warn "gh is not authenticated — run: gh auth login"
  exit 1
fi

# "<repo>/<issue>" for every epic session with its process still alive. A DEAD
# session deliberately doesn't land here: its ref is exactly what pass 2 is for.
LIVE_EPICS=""

# ───────────────────────── Pass 1: sessions ─────────────────────────

SESSIONS="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"

if [[ -z "$SESSIONS" ]]; then
  say "no tmux sessions on the host"
else
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue

    # The @repo tag launch.sh sets is authoritative — a session's cwd is its
    # own worktree, not the clone, and a hand-made session has no tag at all.
    repo="$(tmux show-options -t "$session" -qv @repo 2>/dev/null || true)"
    if [[ -z "$repo" ]]; then
      repo="$(repo_of_session "$session" 2>/dev/null || true)"
    fi
    if [[ -z "$repo" ]] || ! path="$(repo_path "$repo")"; then
      say "$session: not in a registered repo, leaving alone"
      continue
    fi

    # Only sessions the pipeline named are candidates. Everything else —  pool
    # names, anything hand-made — is the user's own session and is never reaped.
    short="${session#"$repo"-}"
    if [[ ! "$short" =~ ^epic-([0-9]+)$ ]]; then
      continue
    fi
    issue="${BASH_REMATCH[1]}"

    pane="$(tmux list-panes -t "$session" -F '#{pane_current_command}' 2>/dev/null | head -n1 || true)"
    case "$pane" in
      bash|zsh|sh|dash) alive=0 ;;
      *)                alive=1 ;;
    esac

    # Recorded BEFORE the issue query, and from tmux alone: whether a run is
    # live is local knowledge, and pass 2 must not lose a live claim's guard
    # just because GitHub was unreachable for a tick.
    if (( alive )); then
      LIVE_EPICS+="$repo/$issue"$'\n'
    fi

    # Fail closed: a query we could not make must not be read as "still working"
    # OR as "done" — report it and change nothing this tick.
    if ! meta="$(cd "$path" && gh issue view "$issue" --json state,labels,updatedAt \
                   --jq '[.state, .updatedAt, ([.labels[].name] | join(","))] | join(" ")' 2>&1)"; then
      warn "$session: could not read issue #$issue in $repo, leaving alone: $meta"
      continue
    fi
    read -r state updated labels <<<"$meta"

    # Terminal for the SESSION, which is not the same as done with the issue:
    # the run ends at an open PR, so the issue stays open until merge-worker.sh
    # lands it — long after the session went idle. Every label the pipeline can
    # finish on counts, `ready-to-merge` above all: it is the gate-clear path,
    # so missing it would leak a slot on every clean epic. A closed issue is
    # the backstop for a PR that merged before this sweep noticed.
    terminal=0
    needs_settle=1
    reason=""
    if [[ "$state" == "CLOSED" ]]; then
      terminal=1
      needs_settle=0    # merged and delivered — see the settle comment below
      reason="issue #$issue closed"
    elif [[ ",$labels," == *,ready-to-merge,* ]]; then
      terminal=1
      reason="issue #$issue ready-to-merge"
    elif [[ ",$labels," == *,ready-to-review,* ]]; then
      terminal=1
      reason="issue #$issue ready-to-review"
    elif [[ ",$labels," == *,failed,* ]]; then
      terminal=1
      reason="issue #$issue failed"
    elif (( ! alive )) && [[ ",$labels," == *,ready,* ]]; then
      terminal=1
      reason="issue #$issue ready"
    fi

    # Let it settle: see TERMINAL_SETTLE_MINUTES. An unparseable timestamp is
    # treated as "not settled" — fail closed, and the next sweep tries again.
    # CLOSED skips the wait entirely: the settle clock keys on the issue's
    # last edit, and the merge worker's own writes (the label drop, the
    # Closes #N close) are exactly what reset it — so waiting here only
    # delays cleanup of work that is already merged and delivered. The window
    # exists for the LABEL states, where ship may apply ready-to-review before
    # it has finished writing. A fixer launch changes that terminal label to
    # in-progress synchronously, so it drops out before the sweep can reap it;
    # a closed issue's session has nothing left to finish.
    if (( terminal && needs_settle )); then
      updated_ts="$(date -u -d "$updated" +%s 2>/dev/null || date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$updated" +%s 2>/dev/null || echo 0)"
      settled_min=$(( (NOW - updated_ts) / 60 ))
      if (( updated_ts == 0 )) || (( settled_min < TERMINAL_SETTLE_MINUTES )); then
        say "$session: $reason but edited ${settled_min}m ago — may still be finishing, leaving alone"
        continue
      fi
    fi

    if (( terminal )); then
      if (( DRY_RUN )); then
        say "would kill $session ($reason)"
      else
        tmux kill-session -t "$session"
        say "killed $session ($reason)"
      fi
      KILLED=$((KILLED + 1))
    elif (( alive )); then
      say "$session: working issue #$issue, leaving alone"
    else
      # Ended without reaching a terminal label: never killed, because
      # capture-pane is the only place the reason still exists, and the issue
      # never reached a state that says why. Two shapes land here — a run that
      # genuinely died, and a run that exited by refusing (an issue claimed
      # elsewhere, an open PR already delivering it). Both want the same thing:
      # a human reading the scrollback, which the RESULT line ends with.
      warn "$session: its process exited at a $pane prompt but issue #$issue is not terminal (labels: ${labels:-none}) — diagnose: tmux capture-pane -p -t $session -S -60"
    fi
  done <<<"$SESSIONS"
fi

# ───────────────────────── Pass 2: stale claim refs ─────────────────────────

while IFS= read -r repo; do
  path="$(repo_path "$repo")"
  if [[ ! -d "$path/.git" ]]; then
    warn "$repo: no checkout at $path — run bin/provision.sh"
    continue
  fi

  if ! refs="$(git -C "$path" ls-remote origin 'refs/heads/epic/*' 2>&1)"; then
    warn "$repo: could not list epic refs on origin: $refs"
    continue
  fi
  # Record that this listing SUCCEEDED before anything else can skip the repo —
  # pass 3 reads it as "origin's epic refs are known for this repo", and an
  # empty listing is a legitimate answer (every branch merged). A repo whose
  # query failed above never reaches here, so pass 3 leaves its worktrees alone
  # instead of reading a missing ref as permission to delete.
  REFS_OK+="$repo"$'\n'
  while IFS=$'\t' read -r _sha ref; do
    [[ -n "${ref:-}" ]] || continue
    b="${ref#refs/heads/}"; r="${b#epic/}"
    ORIGIN_EPICS+="$repo/${r%%-*}"$'\n'
  done <<<"$refs"

  [[ -n "$refs" ]] || continue

  while IFS=$'\t' read -r sha ref; do
    [[ -n "${ref:-}" ]] || continue
    branch="${ref#refs/heads/}"
    rest="${branch#epic/}"
    issue="${rest%%-*}"
    if [[ ! "$issue" =~ ^[0-9]+$ ]]; then
      say "$repo: $branch has no issue number in its slug, leaving alone"
      continue
    fi

    if [[ "$LIVE_EPICS" == *"$repo/$issue"$'\n'* ]]; then
      continue
    fi

    # --no-write-fetch-head keeps this out of the shared FETCH_HEAD, which a
    # live run in one of this clone's worktrees may be using at the same time.
    if ! git -C "$path" fetch --no-write-fetch-head --quiet origin "refs/heads/$branch" 2>/dev/null; then
      warn "$repo: could not fetch $branch to check whether it holds work, leaving alone"
      continue
    fi
    if ! subject="$(git -C "$path" log -1 --format=%s "$sha" 2>/dev/null)"; then
      warn "$repo: fetched $branch but could not read its tip $sha, leaving alone"
      continue
    fi

    # The tip alone settles it: the claim commit is pushed first and any real
    # work lands on top of it, so a claim commit AT THE TIP means the run never
    # got as far as Ship and the ref holds nothing.
    if [[ "$subject" != "chore(epic $issue): claim "* ]]; then
      continue
    fi

    committed="$(git -C "$path" log -1 --format=%ct "$sha" 2>/dev/null || echo 0)"
    age_h=$(( (NOW - committed) / 3600 ))
    if (( age_h < CLAIM_GRACE_HOURS )); then
      say "$repo: $branch is an unfinished claim but only ${age_h}h old, leaving alone"
      continue
    fi

    if (( DRY_RUN )); then
      say "would delete $repo $branch (claim ${age_h}h old, no live session, no work on it)"
    else
      if ! err="$(git -C "$path" push origin --delete "$branch" 2>&1)"; then
        warn "$repo: could not delete stale claim $branch: $err"
        continue
      fi
      say "deleted $repo $branch (stale claim ${age_h}h old) — issue #$issue is buildable again"
    fi
    DELETED=$((DELETED + 1))
  done <<<"$refs"
done < <(repo_names)

# ───────────────────────── Pass 3: finished worktrees ─────────────────────────
#
# launch.sh creates a worktree per pipeline run and reuses it on a relaunch;
# nothing else ever removes one, so without this pass every issue the box has
# ever built leaves a checkout plus its node_modules on disk forever. (`git
# worktree prune` does NOT do this — it clears administrative entries for
# directories that are already gone, which is the opposite direction.)
#
# The safety argument is the same shape as pass 2's, and it leans on the same
# fact: prepare pushes its claim ref to origin BEFORE doing any work, and Ship
# force-pushes to that same ref. So a run that got anywhere at all has a branch
# on origin, and **no `epic/<N>-*` ref on origin means no work exists that
# anyone could still want** — either the PR merged and GitHub deleted the
# branch, or the run died before its claim, which is before it wrote anything.
# Three further guards, because deleting a directory is not undoable:
#   * only paths matching <root>/<repo>/<repo>-epic-<N> for a REGISTERED repo,
#   * only when no tmux session by that name exists at all (running or dead —
#     a dead one's scrollback is still the record of why it died),
#   * only when the repo's ref listing above actually succeeded, and
#   * only after WORKTREE_GRACE_HOURS, so nothing recent is ever touched.
# Removal goes through `git worktree remove`, not `rm -rf`, so the clone's
# administrative data stays consistent with the disk.

WORKTREE_ROOT="${EPIC_WORKTREE_ROOT:-$HOME/.epic-worktrees}"
if [[ -d "$WORKTREE_ROOT" ]]; then
  ALL_SESSIONS="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
  while IFS= read -r repo; do
    [[ "$REFS_OK" == *"$repo"$'\n'* ]] || continue
    repo_wt_dir="$WORKTREE_ROOT/$repo"
    [[ -d "$repo_wt_dir" ]] || continue
    path="$(repo_path "$repo")"

    for wt in "$repo_wt_dir"/*; do
      [[ -d "$wt" ]] || continue
      session="$(basename "$wt")"
      short="${session#"$repo"-}"
      [[ "$short" =~ ^epic-([0-9]+)$ ]] || continue
      issue="${BASH_REMATCH[1]}"

      if grep -qxF "$session" <<<"$ALL_SESSIONS"; then
        continue
      fi
      if [[ "$ORIGIN_EPICS" == *"$repo/$issue"$'\n'* ]]; then
        continue
      fi

      mtime="$(stat -c %Y "$wt" 2>/dev/null || stat -f %m "$wt" 2>/dev/null || echo 0)"
      if [[ ! "$mtime" =~ ^[0-9]+$ ]] || (( mtime == 0 )); then
        warn "$repo: could not read the age of $wt, leaving alone"
        continue
      fi
      age_h=$(( (NOW - mtime) / 3600 ))
      if (( age_h < WORKTREE_GRACE_HOURS )); then
        continue
      fi

      if (( DRY_RUN )); then
        say "would remove worktree $wt (issue #$issue delivered, no session, ${age_h}h old)"
      else
        if ! err="$(git -C "$path" worktree remove --force "$wt" 2>&1)"; then
          warn "$repo: could not remove worktree $wt: $err"
          continue
        fi
        say "removed worktree $wt (issue #$issue delivered, ${age_h}h old)"
      fi
      PRUNED=$((PRUNED + 1))
    done
  done < <(repo_names)
fi

# ───────────────────────── Orphaned agent processes ─────────────────────────
#
# Reported, never killed. A pipeline run spawns each phase as its own process
# GROUP so a timeout can take an `npm run verify` tree with it; the orchestrator
# forwards signals so a normal `stop` sweeps them too. What it cannot cover is
# its own SIGKILL or the OOM killer — those leave agents running under no
# session at all. They are invisible to MAX_PARALLEL_EPICS (which counts tmux
# panes, not processes), so the box can sit loaded past its budget while the
# harness reads it as idle.
#
# Not killed here for two reasons: a long verify tier looks exactly like a
# hung one from the outside, and every other thing this script kills is proved
# finished by a label or a commit — an orphan is proved by neither. So it is
# surfaced for a human, which is what a non-zero exit is for.
# The patterns are anchored on purpose. A loose `claude .*-p` also matches an
# INTERACTIVE session, whose command line carries --dangerously-skip-permissions
# — so it would warn about a healthy session every sweep. Claude pipeline agents
# have `-p` first; Codex pipeline agents have `exec` first.
if ORPHANS="$(pgrep -af '(^|/)(claude -p|codex exec)( |$)' 2>/dev/null)"; then
  ORPHAN_N=0
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    ORPHAN_N=$((ORPHAN_N + 1))
  done <<<"$ORPHANS"
  # Only meaningful when no pipeline session is live to own them: with a run in
  # flight, every one of these is simply its current phase.
  if (( ORPHAN_N > 0 )) && [[ -z "$LIVE_EPICS" ]]; then
    warn "$ORPHAN_N agent process(es) are running with no live pipeline session — likely orphaned by a killed run. Inspect with: pgrep -af '(^|/)(claude -p|codex exec)( |$)'"
  fi
fi

# ───────────────────────── Report ─────────────────────────

if (( DRY_RUN )); then
  say "dry run: would kill $KILLED session(s), delete $DELETED stale claim(s), remove $PRUNED worktree(s)"
else
  say "killed $KILLED session(s), deleted $DELETED stale claim(s), removed $PRUNED worktree(s)"
fi

exit "$NEEDS_HUMAN"
