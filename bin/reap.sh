#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, from cron. Frees what a finished or dead epic leaves behind:
# the idle tmux session still holding a slot, and the stale claim ref still
# holding the head of the queue. Reads GitHub, kills tmux sessions and deletes
# claim refs on origin — it never launches anything and never touches a repo's
# working tree. Keep it free of any ssh/laptop assumptions (like launch.sh).
#
# It exists because neither thing frees itself:
#   * launch.sh starts claude with a positional prompt, not `-p` (which would
#     run the prompt and exit, tearing the detached session down), so a session
#     whose epic has finished sits alive and idle at the claude prompt forever
#     — and MAX_PARALLEL_EPICS counts it, so a couple of them stop dispatch.
#   * epic-run's prepare CLAIMS the issue (pushes epic/<N>-<slug> to origin)
#     before it labels it in-progress, so a run that dies in between leaves the
#     issue `ready` at the head of the queue behind a ref every later run
#     refuses — and nothing reports it.
#
# The run itself no longer merges (bin/merge-worker.sh does, later), so a
# session is finished while its issue is still OPEN. The done signal is
# therefore the label — ready-to-merge, ready-to-review or failed — and not the
# issue closing, which happens long after the slot should have been freed.
#
# Reaping is deliberately conservative in both passes: it only ever kills
# sessions named <repo>-epic-<N> (pool-named and hand-made sessions are the
# user's own work and are never candidates), and it only ever deletes a ref
# whose tip is a claim commit, which is precisely the case where no work is
# being lost. Anything it could not check is left alone and reported.

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
# applies ready-to-review and a SEPARATE step promotes it to ready-to-merge —
# and that promotion runs inside the session being reaped, so killing the
# instant a terminal label appears would sometimes strand a clean run at
# ready-to-review, in front of a human with nothing to decide. Nothing edits
# the issue between the run ending and merge-worker.sh picking it up, so "no
# edits for a few minutes" cleanly separates finished from still-finishing.
TERMINAL_SETTLE_MINUTES="${TERMINAL_SETTLE_MINUTES:-5}"

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
     terminal state (labelled ready-to-merge/ready-to-review/failed, or closed)
     and has sat still for \$TERMINAL_SETTLE_MINUTES (${TERMINAL_SETTLE_MINUTES}m; a closed issue
     skips the wait — merged is delivered), and flags —
     without killing — any whose claude died before it got there, because the
     pane's scrollback is the only record of why.
  2. deletes every epic/<N>-* ref on origin whose tip is still the claim commit
     and that no live session is working, older than \$CLAIM_GRACE_HOURS (${CLAIM_GRACE_HOURS}h).

-n reports what it would do and changes nothing. Exits non-zero when something
needs a human: a flagged session, or a check that could not be made.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    *) warn "unknown argument '$1'"; usage >&2; exit 1 ;;
  esac
done

NOW="$(date +%s)"
KILLED=0
DELETED=0

# Without gh every issue query fails closed and the sweep could only ever
# report — say so once, up front, rather than once per session.
if ! gh auth status >/dev/null 2>&1; then
  warn "gh is not authenticated — run: gh auth login"
  exit 1
fi

# "<repo>/<issue>" for every epic session with claude still alive in it. A DEAD
# session deliberately doesn't land here: its ref is exactly what pass 2 is for.
LIVE_EPICS=""

# ───────────────────────── Pass 1: sessions ─────────────────────────

SESSIONS="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"

if [[ -z "$SESSIONS" ]]; then
  say "no tmux sessions on the host"
else
  while IFS= read -r session; do
    [[ -n "$session" ]] || continue

    # The @repo tag launch.sh sets is authoritative — claude's worktree moves
    # the pane's cwd, and a hand-made session has no tag at all.
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
    fi

    # Let it settle: see TERMINAL_SETTLE_MINUTES. An unparseable timestamp is
    # treated as "not settled" — fail closed, and the next sweep tries again.
    # CLOSED skips the wait entirely: the settle clock keys on the issue's
    # last edit, and the merge worker's own writes (the label drop, the
    # Closes #N close) are exactly what reset it — so waiting here only
    # delays cleanup of work that is already merged and delivered. The window
    # exists for the LABEL states, where ship applies ready-to-review before
    # it has finished writing; a closed issue's session has nothing left to
    # finish.
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
      # Died mid-run: never killed, because capture-pane is the only place the
      # error still exists, and the issue never reached a state that says why.
      warn "$session: claude exited at a $pane prompt but issue #$issue is not terminal (labels: ${labels:-none}) — diagnose: tmux capture-pane -p -t $session -S -60"
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

# ───────────────────────── Report ─────────────────────────

if (( DRY_RUN )); then
  say "dry run: would kill $KILLED session(s), delete $DELETED stale claim(s)"
else
  say "killed $KILLED session(s), deleted $DELETED stale claim(s)"
fi

exit "$NEEDS_HUMAN"
