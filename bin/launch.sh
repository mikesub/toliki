#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host. The single launch primitive: resolves the session name,
# enforces the host's slot budget, pulls the repo, creates the detached tmux
# session, tags it with its repo and starts claude inside it. remote-control.sh
# calls this over ssh; bin/dispatch.sh (host-side, cron) calls it directly —
# keep it free of any ssh/laptop assumptions.
#
# Exit codes: 0 launched (or the session already existed), 1 usage/config
# error, 3 refused because the host is at MAX_PARALLEL_EPICS. 3 is separate
# because dispatch.sh reads it as "stop this tick" rather than as a failure.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

usage() {
  cat <<EOF
Usage: $0 [session-name] [-m <message>] [-r <repo>]

Creates a detached tmux session running claude in the named repo (default:
$DEFAULT_REPO). Name resolution when no name is given: with -m, the session is
named after the message (slugified, e.g. "/epic #42" -> "$DEFAULT_REPO-epic-42");
otherwise the first pool name free for the repo: ${NAMES[*]}
If the session already exists, reports whether claude is still running in it
and changes nothing (it never relaunches into a live session, and doesn't pull).
Refuses with exit 3 when $MAX_PARALLEL_EPICS sessions are already running.
EOF
}

SESSION=""
MESSAGE=""
HAVE_MESSAGE=0
REPO="$DEFAULT_REPO"

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    -m|--message)
      if [[ $# -lt 2 ]]; then
        echo "[launch] $1 requires a value" >&2
        exit 1
      fi
      HAVE_MESSAGE=1
      MESSAGE="$2"
      shift 2
      ;;
    -m=*|--message=*)
      HAVE_MESSAGE=1
      MESSAGE="${1#*=}"
      shift
      ;;
    -r|--repo)
      if [[ $# -lt 2 ]]; then
        echo "[launch] $1 requires a value" >&2
        exit 1
      fi
      REPO="$2"
      shift 2
      ;;
    -r=*|--repo=*)
      REPO="${1#*=}"
      shift
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -gt 1 ]]; then
  echo "[launch] takes at most one session name" >&2
  exit 1
fi
SESSION="${POSITIONAL[0]:-}"

if ! PROJECT="$(repo_path "$REPO")"; then
  echo "[launch] unknown repo '$REPO' (known: $(repo_names | tr '\n' ' '))" >&2
  exit 1
fi

# Sessions with claude actually up. A pane sitting at a shell prompt is a
# session whose claude exited: it still owns its name (so pick_free_name skips
# it) but it consumes no CPU, so it does not hold a slot.
running_count() {
  local s current n=0
  while IFS= read -r s; do
    [[ -n "$s" ]] || continue
    current="$(tmux list-panes -t "$s" -F '#{pane_current_command}' 2>/dev/null | head -n1)"
    case "$current" in
      bash|zsh|sh|dash|'') ;;
      *) n=$((n + 1)) ;;
    esac
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  printf '%s' "$n"
}

# First pool name with no existing tmux session for this repo (running or dead).
pick_free_name() {
  local repo="$1" existing n
  existing="$(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)"
  for n in "${NAMES[@]}"; do
    if ! grep -qxF "$repo-$n" <<<"$existing"; then
      printf '%s\n' "$n"
      return 0
    fi
  done
  return 1
}

# Resolve the session name: explicit name wins; a message names the session
# (slugified); otherwise pick a free pool name.
if [[ -z "$SESSION" ]]; then
  if [[ $HAVE_MESSAGE -eq 1 ]]; then
    SESSION="$(slugify "$MESSAGE")"
  fi
  if [[ -n "$SESSION" ]]; then
    SESSION="$(full_name "$REPO" "$SESSION")"
    echo "[launch] derived session name from message: $SESSION"
  elif SHORT="$(pick_free_name "$REPO")"; then
    SESSION="$REPO-$SHORT"
    echo "[launch] auto-selected session name: $SESSION"
  else
    echo "[launch] all pool names are taken for $REPO: ${NAMES[*]}" >&2
    exit 1
  fi
else
  SESSION="$(full_name "$REPO" "$SESSION")"
fi

# An existing session is reported, never relaunched into (a derived or pool
# name colliding with a live session must not clobber it).
if tmux has-session -t "$SESSION" 2>/dev/null; then
  current="$(tmux list-panes -t "$SESSION" -F '#{pane_current_command}' | head -n1)"
  case "$current" in
    bash|zsh|sh|dash)
      echo "[launch] session '$SESSION' exists but claude isn't running (pane at a $current prompt) — restart it (from the laptop): ./remote-control.sh restart $SESSION" ;;
    *)
      echo "[launch] session '$SESSION' already running (pane: $current)" ;;
  esac
  exit 0
fi

# The slot budget is enforced HERE rather than in dispatch.sh because this is
# the primitive both callers share: remote-control.sh reaches it over ssh,
# dispatch.sh calls it directly. A cap counted by the dispatcher would bound
# only the dispatcher, and every manual `./remote-control.sh epic N` would walk past
# it — so the two callers together could overrun the box while each believed it
# was under the cap. Counting at the one place that actually creates sessions
# is the only version that can't be bypassed. It sits after the has-session
# check on purpose: reporting on a session that already exists starts nothing,
# so it must not be refused for capacity.
#
# Unset or non-numeric is a hard error, never an implied "no limit" — a cap
# that quietly evaporates when its config is missing is worse than no cap,
# because the box is then unprotected by something you believe is protecting it.
if [[ ! "${MAX_PARALLEL_EPICS:-}" =~ ^[1-9][0-9]*$ ]]; then
  echo "[launch] MAX_PARALLEL_EPICS must be a positive integer, got '${MAX_PARALLEL_EPICS:-<unset>}' — fix etc/repos.conf" >&2
  exit 1
fi
RUNNING="$(running_count)"
if (( RUNNING >= MAX_PARALLEL_EPICS )); then
  echo "[launch] at capacity ($RUNNING/$MAX_PARALLEL_EPICS running) — not starting '$SESSION'" >&2
  exit 3
fi
echo "[launch] capacity $RUNNING/$MAX_PARALLEL_EPICS"

echo "[launch] pulling latest main in $PROJECT"
git -C "$PROJECT" pull --rebase
echo "[launch] creating session '$SESSION' in $PROJECT"
tmux new-session -d -s "$SESSION" -c "$PROJECT"
# Tag the session with its repo so `ls` can report it regardless of where
# claude's worktree later moves the pane's cwd.
tmux set-option -t "$SESSION" @repo "$REPO"

# The session name is threaded through --remote-control and --worktree so it's
# identifiable in the Desktop app and reusable across restarts; session name ==
# worktree name is a deliberate invariant. The initial prompt (if any) is
# appended as a positional arg, quoted for the pane's shell. NOTE: positional,
# not `-p` — `-p` is print/non-interactive mode, which would run the prompt
# then exit and tear the detached session down.
LINE="claude --remote-control $SESSION --dangerously-skip-permissions --worktree $SESSION"
if [[ $HAVE_MESSAGE -eq 1 && -n "$MESSAGE" ]]; then
  LINE+=" $(sq "$MESSAGE")"
fi
# Typed into a shell via send-keys (rather than run as tmux new-session's
# command) so the pane survives claude exiting: `ls` reports it as dead and
# capture-pane can still show the error scrollback.
tmux send-keys -t "$SESSION" -- "$LINE" Enter
