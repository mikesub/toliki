#!/usr/bin/env bash
set -euo pipefail

# Laptop-side operator CLI — at the repo root deliberately: everything in bin/
# runs ON the host, and this is the one script that runs from the laptop.
# Session launching itself lives in bin/launch.sh, which runs ON the host (so
# the dispatcher can reuse it without ssh); this script parses the operator's
# intent, resolves names/repos locally where it can, and sshes the rest over.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/etc/lib.sh"

HOST="${SSH_HOST:-}"
if [[ -z "$HOST" ]]; then
  echo "[control] SSH_HOST is not set — add it to etc/repos.conf (see etc/repos.conf.template)" >&2
  exit 1
fi
LAUNCH="$HOST_CONTROL_DIR/bin/launch.sh"

usage() {
  cat <<EOF
Usage: $0 <command> [session-name] [-m <message>] [-r <repo>]

Commands:
  start [name] [-m msg]    Start an interactive claude session. Name resolution
                           when no name given: with -m, the session is named
                           after the message (slugified); otherwise auto-picks
                           the first pool name free for the repo: ${NAMES[*]}
                           With -m, sends <msg> to claude as its initial prompt.
  stop <name>...           Stop the named session(s). (alias: rm)
  restart <name> [-m msg]  Restart the named session (optionally re-prompting).
                           Refuses on a <repo>-epic-<N> session: use epic/fix.
  stop-all                 Stop every tmux session on the host.
  ls                       List all sessions with their repo and running/dead status.
  usage [days] [engine]    Per-step token and time report from the host's
                           ~/epic-usage.jsonl (read-only): which steps an average
                           run spends its tokens on. Optional window in days and
                           engine name, e.g. "usage 7 codex".
  epic <ref> --engine <e>  Run the epic pipeline on an issue, as session
                           <repo>-epic-<ref>. The manual override for dispatch's
                           ready queue. A ref starting with # isn't doubled.
  fix <ref> --engine <e>   Run the conflict fixer on a needs-judgment issue —
                           the manual override for dispatch's fixer walk. Same
                           session name as dispatch would use, which is what
                           keeps it visible to reap and to the next tick.
  ci <ref> --engine <e>    Run the CI fixer on a needs-ci-fix issue (checks red
                           on the rebased head) — the manual override for the
                           other fixer walk. Same session name again.
  next <engine>            Route the first unrouted, unblocked ready issue to
                           this engine. With -r, only considers that repo;
                           otherwise uses dispatch's host-wide interleaving.
  <name> [-m msg]          Shorthand for: start <name> [-m msg]

  Note: epic/fix/ci sessions run the pipeline directly (a node orchestrator that
  spawns one headless agent per phase), so they have no Remote Control channel
  to attach to. Watch one with: ssh <host> 'tmux attach -t <name>' — or read it
  after the fact with 'tmux capture-pane -p -t <name> -S -200'.

  -m, --message <msg>      Initial prompt to send to claude (start/restart only).
                           Passed as claude's positional prompt, not -p (which
                           is non-interactive and would exit immediately). Also
                           names the session when no explicit name is given.
  -r, --repo <name>        Repo to run in: $(repo_names | tr '\n' ' ')(default: $DEFAULT_REPO).
                           Applies to start/restart/stop/epic/fix/ci/next; ls and stop-all
                           are host-wide. Every session is named <repo>-<name>, so
                           "epic 63 -r otherapp" -> otherapp-epic-63. Names are given
                           short (epic-63) or full (otherapp-epic-63) interchangeably.
  --engine <engine>        Required for manual epic/fix/ci launches; a name from
                           etc/engines.json ($(engine_names | tr '\n' ' ')). Queue-driven
                           launches get the engine from the issue label instead.
EOF
}

ACTION="start"
SESSION=""
SESSIONS=()
MESSAGE=""
HAVE_MESSAGE=0
REPO=""
HAVE_REPO=0
PIPELINE=""   # "epic" or "fix" when the epic/fix shortcut was used
REF=""
ENGINE=""
HAVE_ENGINE=0

# Pull optional -m/--message and -r/--repo (any position) out of the args.
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      if [[ $# -lt 2 ]]; then
        echo "[control] $1 requires a value" >&2
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
        echo "[control] $1 requires a value" >&2
        exit 1
      fi
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
      if [[ $# -lt 2 ]]; then
        echo "[control] $1 requires a value" >&2
        exit 1
      fi
      HAVE_ENGINE=1
      ENGINE="$2"
      shift 2
      ;;
    --engine=*)
      HAVE_ENGINE=1
      ENGINE="${1#*=}"
      shift
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
  else
    usage
    exit 0
  fi
else
  case "${POSITIONAL[0]}" in
    start|restart|ls|stop-all)
      ACTION="${POSITIONAL[0]}"
      SESSION="${POSITIONAL[1]:-}"
      ;;
    usage)
      ACTION="usage"
      USAGE_DAYS="${POSITIONAL[1]:-}"
      USAGE_ENGINE="${POSITIONAL[2]:-}"
      if [[ -n "$USAGE_DAYS" && ! "$USAGE_DAYS" =~ ^[0-9]+$ ]]; then
        echo "[control] usage takes an optional number of days, then an optional engine" >&2
        exit 1
      fi
      if [[ -n "$USAGE_ENGINE" ]] && ! engine_known "$USAGE_ENGINE"; then
        echo "[control] usage: unknown engine '$USAGE_ENGINE' ($(engine_names | tr '\n' ' '))" >&2
        exit 1
      fi
      ;;
    stop|rm)
      ACTION="stop"                        # `rm` is an alias for stop
      SESSIONS=("${POSITIONAL[@]:1}")       # stop takes one or more session names
      ;;
    epic|fix|ci)
      # `epic <ref>` == `start --epic <ref>`, and so for `fix` and `ci`.
      # All three produce exactly the session dispatch would have: launch.sh derives
      # the <repo>-epic-<N> name itself, which is what makes a manual launch
      # visible to dispatch's has-session checks and reclaimable by reap.
      CMD="${POSITIONAL[0]}"
      REF="${POSITIONAL[1]:-}"
      if [[ -z "$REF" ]]; then
        echo "[control] $CMD requires an issue reference, e.g. $0 $CMD 63" >&2
        exit 1
      fi
      if [[ -n "${POSITIONAL[2]:-}" ]]; then
        echo "[control] $CMD takes a single issue reference" >&2
        exit 1
      fi
      if [[ $HAVE_MESSAGE -eq 1 ]]; then
        echo "[control] -m/--message can't be combined with the $CMD shortcut" >&2
        exit 1
      fi
      ACTION="start"
      PIPELINE="$CMD"
      REF="${REF#\#}"              # strip a leading # so we don't double it
      if [[ ! "$REF" =~ ^[0-9]+$ ]]; then
        echo "[control] $CMD takes a numeric issue reference" >&2
        exit 1
      fi
      ;;
    next)
      ACTION="next"
      NEXT_ENGINE="${POSITIONAL[1]:-}"
      if ! engine_known "$NEXT_ENGINE"; then
        echo "[control] next requires an engine from etc/engines.json ($(engine_names | tr '\n' ' '))" >&2
        exit 1
      fi
      if [[ -n "${POSITIONAL[2]:-}" ]]; then
        echo "[control] next takes a single engine" >&2
        exit 1
      fi
      ;;
    *)
      SESSION="${POSITIONAL[0]}"   # bare <name> is shorthand for: start <name>
      ;;
  esac
fi

if [[ $HAVE_ENGINE -eq 1 ]] && ! engine_known "$ENGINE"; then
  echo "[control] --engine must name an engine in etc/engines.json ($(engine_names | tr '\n' ' ')), got '$ENGINE'" >&2
  exit 1
fi
if [[ -n "$PIPELINE" && $HAVE_ENGINE -eq 0 ]]; then
  echo "[control] manual $PIPELINE requires --engine <name from etc/engines.json>; queue launches inherit the issue's engine label" >&2
  exit 1
fi
if [[ -z "$PIPELINE" && $HAVE_ENGINE -eq 1 ]]; then
  echo "[control] --engine only applies to manual epic/fix launches" >&2
  exit 1
fi

# --message only makes sense when we're launching claude.
if [[ $HAVE_MESSAGE -eq 1 && "$ACTION" != "start" && "$ACTION" != "restart" ]]; then
  echo "[control] --message only applies to start/restart" >&2
  exit 1
fi

# ls and stop-all are host-wide, so a repo would be meaningless there.
if [[ $HAVE_REPO -eq 1 && "$ACTION" != "start" && "$ACTION" != "restart" && "$ACTION" != "stop" && "$ACTION" != "next" ]]; then
  echo "[control] --repo only applies to start/restart/stop/epic/fix/next" >&2
  exit 1
fi

if [[ $HAVE_REPO -eq 1 ]] && ! repo_path "$REPO" >/dev/null; then
  echo "[control] unknown repo '$REPO' (known: $(repo_names | tr '\n' ' '))" >&2
  exit 1
fi

# Resolve the repo. A full session name (as `ls` prints it) already carries its
# own repo, so honour that for restart when -r wasn't given.
if [[ $HAVE_REPO -eq 0 && "$ACTION" != "next" ]]; then
  REPO="$DEFAULT_REPO"
  if [[ "$ACTION" == "restart" && -n "$SESSION" ]]; then
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
      echo "[control] stop requires at least one session name" >&2
      exit 1
    fi
    # A full name from `ls` passes through untouched; a short one gets $REPO's prefix.
    for i in "${!SESSIONS[@]}"; do
      R="$(repo_of_session "${SESSIONS[$i]}" || printf '%s' "$REPO")"
      SESSIONS[$i]="$(full_name "$R" "${SESSIONS[$i]}")"
    done
    ;;
  restart)
    if [[ -z "$SESSION" ]]; then
      echo "[control] restart requires a session name" >&2
      exit 1
    fi
    SESSION="$(full_name "$REPO" "$SESSION")"
    ;;
esac

case "$ACTION" in
  usage)
    # Read-only: the report script only reads the usage log.
    REMOTE="node $HOST_CONTROL_DIR/workflows/usage-report.mjs"
    [[ -z "$USAGE_DAYS" ]] || REMOTE+=" --since $(sq "${USAGE_DAYS}d")"
    [[ -z "$USAGE_ENGINE" ]] || REMOTE+=" --engine $(sq "$USAGE_ENGINE")"
    ssh "$HOST" "$REMOTE"
    ;;
  next)
    REMOTE="$HOST_CONTROL_DIR/bin/dispatch.sh --route-next $(sq "$NEXT_ENGINE")"
    if [[ $HAVE_REPO -eq 1 ]]; then
      REMOTE+=" --repo $(sq "$REPO")"
    fi
    ssh "$HOST" "$REMOTE"
    ;;
  start)
    # Each arg is shell-quoted with sq() since ssh mashes the remote command
    # into one string and hands it to the remote shell.
    REMOTE="$LAUNCH --repo $(sq "$REPO")"
    if [[ -n "$PIPELINE" ]]; then
      ROUTE="$HOST_CONTROL_DIR/bin/dispatch.sh --route-issue $(sq "$REF") $(sq "$ENGINE") --repo $(sq "$REPO")"
      REMOTE+=" --$PIPELINE $(sq "$REF") --engine $(sq "$ENGINE")"
      REMOTE="$ROUTE && $REMOTE"
    else
      if [[ -n "$SESSION" ]]; then
        REMOTE+=" $(sq "$SESSION")"
      fi
      if [[ $HAVE_MESSAGE -eq 1 ]]; then
        REMOTE+=" --message $(sq "$MESSAGE")"
      fi
    fi
    ssh "$HOST" "$REMOTE"
    ;;
  stop)
    # Shell-quote each name into one list the remote loop iterates over.
    QUOTED=""
    for s in "${SESSIONS[@]}"; do
      QUOTED+=" $(sq "$s")"
    done
    ssh "$HOST" bash -s <<EOF
set -euo pipefail
for s in$QUOTED; do
  if tmux has-session -t "\$s" 2>/dev/null; then
    tmux kill-session -t "\$s"
    echo "[remote] killed session '\$s'"
  else
    echo "[remote] no session '\$s' to kill"
  fi
done
EOF
    ;;
  restart)
    # A pipeline session's name says which issue it is but not whether it was
    # an epic or a fixer, and restarting it as an interactive claude would
    # silently produce something else entirely — a live session in the epic's
    # worktree that nothing is driving. Name the two real intentions instead.
    if [[ $HAVE_MESSAGE -eq 0 && "$SESSION" =~ -epic-([0-9]+)$ ]]; then
      N="${BASH_REMATCH[1]}"
      echo "[control] '$SESSION' is a pipeline session — 'restart' can't tell an epic from a fixer." >&2
      echo "[control] Relaunch it explicitly:  $0 stop $SESSION && $0 epic $N --engine <engine>" >&2
      echo "[control] Or use: $0 fix $N --engine <engine>" >&2
      echo "[control] Or just stop it: dispatch relaunches an unfinished issue on its next tick." >&2
      exit 1
    fi
    "$0" stop "$SESSION"
    if [[ $HAVE_MESSAGE -eq 1 ]]; then
      "$0" start "$SESSION" --repo "$REPO" --message "$MESSAGE"
    else
      "$0" start "$SESSION" --repo "$REPO"
    fi
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
  ls)
    ssh "$HOST" bash -s <<'EOF'
set -euo pipefail
if ! sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null); then
  echo "[remote] no tmux sessions"
  exit 0
fi
while IFS= read -r s; do
  current=$(tmux list-panes -t "$s" -F '#{pane_current_command}' | head -n1)
  case "$current" in
    bash|zsh|sh|dash) status="dead (at $current prompt)" ;;
    *) status="running ($current)" ;;
  esac
  # Sessions started before repo tagging (or by hand) have no @repo option.
  repo=$(tmux show-options -t "$s" -v @repo 2>/dev/null || true)
  engine=$(tmux show-options -t "$s" -v @engine 2>/dev/null || true)
  printf '%-28s %-10s %-7s %s\n' "$s" "${repo:--}" "${engine:--}" "$status"
done <<<"$sessions"
EOF
    ;;
esac
