#!/usr/bin/env bash
set -euo pipefail

# `./toliki session` — the interactive tmux sessions on the host: list, start,
# stop, restart, manual cleanup and stop-all. Session launching itself lives in bin/launch.sh,
# which runs ON the host (so the dispatcher can reuse it without ssh); this
# script parses the operator's intent, resolves names/repos locally where it
# can, and sshes the rest over.
#
# Pipeline sessions are NOT started here — '$CLI run' owns those, because a
# <repo>-epic-<N> session is a node orchestrator, not a claude to attach to.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<EOF
Usage: $CLI session <command> [name] [-m <message>] [-r <repo>] [--engine claude|codex]

Commands:
  list                     List every session with repo, actual client,
                           manual/pipeline identity and state. (alias: ls)
  start [name] [-m msg]    Start an interactive Claude or Codex session. Name resolution
                           when no name given: with -m, the session is named
                           after the message (slugified); otherwise auto-picks
                           the first pool name free for the repo: ${NAMES[*]}
                           With -m, sends <msg> as the client's initial prompt.
  stop <name>...           Stop exact named session(s); manual code is retained. (alias: rm)
  restart <name> [-m msg]  Restart the named session (optionally re-prompting).
                           Refuses on a <repo>-epic-<N> session: use an explicit
                           '$CLI run' command instead.
  stop-manual              Stop all proven Toliki manual sessions and owned
                           processes. Pipelines and unrelated tmux are untouched.
  remove-workspace <name>  Safely remove one stopped manual worktree and branch;
                           refuses dirty, untracked, unmerged or ambiguous work.
  stop-all                 Stop every tmux session on the host. Host-wide.
  <name> [-m msg]          Shorthand for: start <name> [-m msg]

Options:
  -m, --message <msg>      Initial interactive prompt (start/restart only).
                           Passed positionally, never as a headless invocation. Also
                           names the session when no explicit name is given.
  --engine claude|codex    Interactive client. New sessions default to Claude;
                           restart inherits unless explicitly overridden.
  -r, --repo <name>        Repo to run in: $(repo_names | tr '\n' ' ')(default: $DEFAULT_REPO).
                           Applies to start/restart/stop; list and stop-all are
                           host-wide. Every session is named <repo>-<name>, so
                           "start review -r otherapp" -> otherapp-review. Names
                           are given short (review) or full (otherapp-review)
                           interchangeably.
EOF
}

ACTION="start"
SESSION=""
SESSIONS=()
MESSAGE=""
HAVE_MESSAGE=0
REPO=""
HAVE_REPO=0
ENGINE=""
HAVE_ENGINE=0

# Pull session options out in any position; ssh receives individually quoted
# values so multiline prompts and metacharacters remain data.
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      [[ $# -ge 2 ]] || die "$1 requires a value"
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
      [[ $# -ge 2 ]] || die "$1 requires a value"
      HAVE_REPO=1
      REPO="$2"
      shift 2
      ;;
    -r=*|--repo=*)
      HAVE_REPO=1
      REPO="${1#*=}"
      shift
      ;;
    --engine)
      [[ $# -ge 2 ]] || die "$1 requires a value"
      HAVE_ENGINE=1; ENGINE="$2"; shift 2 ;;
    --engine=*) HAVE_ENGINE=1; ENGINE="${1#*=}"; shift ;;
    --over-capacity)
      refuse_over_capacity
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -eq 0 ]]; then
  if [[ $HAVE_MESSAGE -eq 1 ]]; then
    ACTION="start"          # bare `-m <msg>` starts an auto-named session
  elif [[ $HAVE_REPO -eq 1 ]]; then
    ACTION="start"          # bare `-r <repo>` starts an auto-named session there
  elif [[ $HAVE_ENGINE -eq 1 ]]; then
    ACTION="start"          # bare `--engine <client>` starts a pool session
  else
    usage
    exit 0
  fi
else
  case "${POSITIONAL[0]}" in
    list|ls)
      ACTION="list"
      ;;
    start|restart|stop-all|stop-manual|remove-workspace)
      ACTION="${POSITIONAL[0]}"
      SESSION="${POSITIONAL[1]:-}"
      ;;
    stop|rm)
      ACTION="stop"                         # `rm` is an alias for stop
      SESSIONS=("${POSITIONAL[@]:1}")       # stop takes one or more session names
      ;;
    epic|task|fix|ci|defect)
      # These were session commands before the CLI grew groups. They start a
      # pipeline, not a claude, so name the command that does.
      die "'${POSITIONAL[0]}' is a pipeline launch: $CLI run ${POSITIONAL[0]} ${POSITIONAL[1]:-<issue>}"
      ;;
    *)
      SESSION="${POSITIONAL[0]}"   # bare <name> is shorthand for: start <name>
      ;;
  esac
fi

case "$ACTION" in
  start|restart|remove-workspace|stop-all|stop-manual)
    [[ ${#POSITIONAL[@]} -le 2 ]] || die "'$CLI session $ACTION' takes at most one session name"
    ;;
  list)
    [[ ${#POSITIONAL[@]} -eq 1 ]] || die "'$CLI session list' takes no session name"
    ;;
esac
if [[ ( "$ACTION" == list || "$ACTION" == stop-all || "$ACTION" == stop-manual ) && -n "$SESSION" ]]; then
  die "'$CLI session $ACTION' takes no session name"
fi

# --message only makes sense when launching an interactive client.
if [[ $HAVE_MESSAGE -eq 1 && "$ACTION" != "start" && "$ACTION" != "restart" ]]; then
  refuse_message_flag
fi

# list and stop-all are host-wide, so a repo would be meaningless there.
if [[ $HAVE_REPO -eq 1 && "$ACTION" != "start" && "$ACTION" != "restart" && "$ACTION" != "stop" && "$ACTION" != "remove-workspace" ]]; then
  refuse_repo_flag "$CLI session $ACTION"
fi
if [[ $HAVE_ENGINE -eq 1 ]]; then
  [[ "$ACTION" == start || "$ACTION" == restart ]] || die "--engine only applies to '$CLI session start' and '$CLI session restart'"
  [[ "$ENGINE" == claude || "$ENGINE" == codex ]] || die "--engine must be claude or codex, got '$ENGINE'"
fi

if [[ $HAVE_REPO -eq 1 ]]; then
  require_known_repo "$REPO"
fi

require_ssh_host
LAUNCH="$HOST_CONTROL_DIR/bin/launch.sh"
MANUAL_SESSION="$HOST_CONTROL_DIR/bin/manual-session.sh"

# Resolve the repo. A full session name (as `list` prints it) already carries
# its own repo, so honour that for restart when -r wasn't given.
if [[ $HAVE_REPO -eq 0 ]]; then
  REPO="$DEFAULT_REPO"
  if [[ ( "$ACTION" == "start" || "$ACTION" == "restart" || "$ACTION" == "remove-workspace" ) && -n "$SESSION" ]]; then
    if derived="$(repo_of_session "$SESSION")"; then
      REPO="$derived"
    fi
  fi
fi

# Resolve session name(s) locally where an action needs them here. `start`
# passes whatever it was given straight through — launch.sh owns naming
# (explicit name > message slug > free pool name) since only the host can
# check which names are taken.
case "$ACTION" in
  stop)
    if [[ ${#SESSIONS[@]} -eq 0 ]]; then
      die "'$CLI session stop' requires at least one session name"
    fi
    # A full name from `list` passes through untouched; a short one gets $REPO's prefix.
    for i in "${!SESSIONS[@]}"; do
      R="$(repo_of_session "${SESSIONS[$i]}" || printf '%s' "$REPO")"
      SESSIONS[$i]="$(full_name "$R" "${SESSIONS[$i]}")"
    done
    ;;
  restart)
    if [[ -z "$SESSION" ]]; then
      die "'$CLI session restart' requires a session name"
    fi
    SESSION="$(full_name "$REPO" "$SESSION")"
    ;;
  remove-workspace)
    [[ -n "$SESSION" ]] || die "'$CLI session remove-workspace' requires a session name"
    SESSION="$(full_name "$REPO" "$SESSION")"
    ;;
esac

validate_session_name() {
  local candidate="$1"
  [[ "$candidate" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]] || die "invalid session name '$candidate' (use letters, digits, '-' or '_')"
}
case "$ACTION" in
  start) [[ -z "$SESSION" ]] || validate_session_name "$SESSION" ;;
  restart|remove-workspace) validate_session_name "$SESSION" ;;
  stop)
    for candidate in "${SESSIONS[@]}"; do validate_session_name "$candidate"; done
    ;;
esac

# A pipeline-shaped manual name is forbidden before any host mutation, even
# when a prompt or engine was supplied.
if [[ ( "$ACTION" == start || "$ACTION" == restart ) && -n "$SESSION" && "$SESSION" =~ ^${REPO}-epic-([0-9]+)$ ]]; then
  N="${BASH_REMATCH[1]}"
  warn "'$SESSION' is reserved for pipeline sessions and cannot be started or restarted interactively."
  warn "Use: $CLI run epic $N [--engine <engine>]"
  warn "Or choose a fixer explicitly: $CLI run fix $N, $CLI run ci $N, or $CLI run defect $N [--engine <engine>]"
  exit 1
fi

case "$ACTION" in
  start)
    # Each arg is shell-quoted with sq() since ssh mashes the remote command
    # into one string and hands it to the remote shell.
    REMOTE="$(sq "$LAUNCH") --repo $(sq "$REPO")"
    if [[ -n "$SESSION" ]]; then
      REMOTE+=" $(sq "$SESSION")"
    fi
    if [[ $HAVE_MESSAGE -eq 1 ]]; then
      REMOTE+=" --message $(sq "$MESSAGE")"
    fi
    if [[ $HAVE_ENGINE -eq 1 ]]; then
      REMOTE+=" --engine $(sq "$ENGINE")"
    fi
    # Use a remote script rather than one argv containing the whole command.
    # OpenSSH still hands the script to Bash, while hermetic/operator transports
    # that preserve argv can execute `bash -s` directly. Values remain encoded
    # by sq() in REMOTE, including newlines and shell metacharacters.
    ssh "$HOST" bash -s <<EOF
set -euo pipefail
exec $REMOTE
EOF
    ;;
  stop)
    stop_rc=0
    for s in "${SESSIONS[@]}"; do
      R="$(repo_of_session "$s" || printf '%s' "$REPO")"
      ssh "$HOST" "$(sq "$MANUAL_SESSION") stop --repo $(sq "$R") $(sq "$s")" || stop_rc=1
    done
    exit "$stop_rc"
    ;;
  restart)
    # A pipeline session's name says which issue it is but not whether it was
    # an epic or a fixer, and restarting it as an interactive claude would
    # silently produce something else entirely — a live session in the epic's
    # worktree that nothing is driving. Name the real intention instead.
    REMOTE="$(sq "$LAUNCH") --repo $(sq "$REPO") $(sq "$SESSION") --restart"
    if [[ $HAVE_MESSAGE -eq 1 ]]; then
      REMOTE+=" --message $(sq "$MESSAGE")"
    fi
    if [[ $HAVE_ENGINE -eq 1 ]]; then REMOTE+=" --engine $(sq "$ENGINE")"; fi
    ssh "$HOST" bash -s <<EOF
set -euo pipefail
exec $REMOTE
EOF
    ;;
  stop-manual)
    ssh "$HOST" "$(sq "$MANUAL_SESSION") stop-manual"
    ;;
  remove-workspace)
    ssh "$HOST" "$(sq "$MANUAL_SESSION") remove-workspace --repo $(sq "$REPO") $(sq "$SESSION")"
    ;;
  stop-all)
    ssh "$HOST" bash -s <<'EOF'
set -euo pipefail
if ! sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null); then
  echo "[remote] no tmux sessions to kill"
  exit 0
fi
while IFS= read -r s; do
  tmux kill-session -t "$s"
  echo "[remote] killed session '$s'"
done <<<"$sessions"
EOF
    ;;
  list)
    ssh "$HOST" "$(sq "$MANUAL_SESSION") list"
    ;;
esac
