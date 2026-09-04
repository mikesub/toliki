#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host. The single launch primitive: resolves the session name,
# enforces the host's slot budget, pulls the repo, creates the detached tmux
# session, tags it with its repo and starts the run inside it.
# remote-control.sh calls this over ssh; bin/dispatch.sh (host-side, cron)
# calls it directly — keep it free of any ssh/laptop assumptions.
#
# Two kinds of session, and they run different things:
#   --epic N / --fix N / --ci N / --defect N
#                        a pipeline run: this script creates the git worktree
#                        and the pane runs workflows/{epic,fix,ci,defect}-run.mjs, which
#                        spawns one headless agent process per phase. No
#                        interactive session wraps it, so there is no
#                        --remote-control channel to attach to — watch it with
#                        `tmux attach` / `capture-pane`, same as diagnosing one.
#   everything else      an interactive claude session (pool names, -m), with
#                        Remote Control and its own --worktree, unchanged.
#
# Exit codes: 0 launched (or the session already existed), 1 usage/config
# error, 3 refused because the host is at MAX_PARALLEL_EPICS. 3 is separate
# because dispatch.sh reads it as "stop this tick" rather than as a failure.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

usage() {
  cat <<EOF
Usage: $0 [session-name] [-m <message>] [-r <repo>] [--check-capacity|--check-idle]
       $0 --epic <N> [-r <repo>] [--engine <engine>]
       $0 --fix <N>  [-r <repo>] [--engine <engine>]
       $0 --ci <N>   [-r <repo>] [--engine <engine>]
       $0 --defect <N> [-r <repo>] [--engine <engine>]

Creates a detached tmux session in the named repo (default: $DEFAULT_REPO).

--epic/--fix/--ci/--defect run the autonomous pipeline: the session is named <repo>-epic-<N>,
this script creates its git worktree under \${EPIC_WORKTREE_ROOT:-\$HOME/.epic-worktrees},
and the pane runs the corresponding workflows/*-run.mjs there. They take no
session name and no -m — both are derived from the issue number.
--engine is pipeline-only: a name from etc/engines.json, the vendor/model/effort
table the run uses per step (default: \$EPIC_ENGINE from the environment,
claude when unset). Currently: $(engine_names | tr '\n' ' ')

Without them the session is an interactive claude. Name resolution when no name
is given: with -m, the session is named after the message (slugified); otherwise
the first pool name free for the repo: ${NAMES[*]}
If the session already exists, reports whether its process is still running and
changes nothing (it never relaunches into a live session, and doesn't pull).
Refuses with exit 3 when $MAX_PARALLEL_EPICS sessions are already running.
--check-capacity answers ONLY that last question (exit 0 below the cap, 3 at
it) and starts nothing — dispatch.sh probes it before work it would otherwise
have to undo, so the counting stays in this one script.
--check-idle is the same count against zero (exit 0 with nothing running, 3
otherwise) — bin/update-claude.sh asks it before moving the claude binary.
EOF
}

SESSION=""
MESSAGE=""
HAVE_MESSAGE=0
CHECK_CAPACITY=0
CHECK_IDLE=0
REPO="$DEFAULT_REPO"
MODE=""       # "" = interactive claude; otherwise the selected pipeline run
ISSUE=""
ENGINE="$DEFAULT_ENGINE"   # from etc/lib.sh: EPIC_ENGINE, claude when unset
HAVE_ENGINE=0

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
    --check-capacity)
      CHECK_CAPACITY=1
      shift
      ;;
    --check-idle)
      CHECK_IDLE=1
      shift
      ;;
    --engine)
      if [[ $# -lt 2 ]]; then
        echo "[launch] $1 requires a value" >&2
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
    --epic|--fix|--ci|--defect|--epic=*|--fix=*|--ci=*|--defect=*)
      # One leading '#' is stripped so `--epic #42` and `--epic 42` agree.
      case "$1" in
        --epic*) want="epic" ;;
        --ci*)   want="ci" ;;
        --fix*)  want="fix" ;;
        *)       want="defect" ;;
      esac
      if [[ -n "$MODE" ]]; then
        echo "[launch] --epic, --fix, --ci and --defect are mutually exclusive" >&2
        exit 1
      fi
      MODE="$want"
      if [[ "$1" == *=* ]]; then
        ISSUE="${1#*=}"
        shift
      else
        if [[ $# -lt 2 ]]; then
          echo "[launch] $1 requires an issue number" >&2
          exit 1
        fi
        ISSUE="$2"
        shift 2
      fi
      ISSUE="${ISSUE#\#}"
      if [[ ! "$ISSUE" =~ ^[0-9]+$ ]]; then
        echo "[launch] --$MODE takes an issue number, got '$ISSUE'" >&2
        exit 1
      fi
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

if ! engine_known "$ENGINE"; then
  src="--engine"; [[ $HAVE_ENGINE -eq 1 ]] || src="EPIC_ENGINE"
  echo "[launch] $src must name an engine in etc/engines.json ($(engine_names | tr '\n' ' ')), got '$ENGINE'" >&2
  exit 1
fi
if [[ $HAVE_ENGINE -eq 1 && -z "$MODE" ]]; then
  echo "[launch] --engine only applies to --epic/--fix/--ci/--defect pipeline runs" >&2
  exit 1
fi

# A pipeline run owns its own naming: the session name IS the issue, because
# every other part of the harness (dispatch's has-session checks, reap's sweep,
# the resource sampler) keys on the <repo>-epic-<N> shape. Letting a caller
# name one differently is how a run ends up unreapable, so it is refused rather
# than accommodated.
if [[ -n "$MODE" ]]; then
  if [[ -n "$SESSION" ]]; then
    echo "[launch] --$MODE derives its own session name; drop the '$SESSION' argument" >&2
    exit 1
  fi
  if [[ $HAVE_MESSAGE -eq 1 ]]; then
    echo "[launch] --$MODE takes no -m (the pipeline gets its issue from the flag)" >&2
    exit 1
  fi
  SESSION="epic-$ISSUE"
fi

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

# The cap check itself, shared by the probe below and the real launch: validate
# the config, count, refuse with exit 3 at the cap. One function so a probe can
# never disagree with the launch that follows it.
#
# Unset or non-numeric is a hard error, never an implied "no limit" — a cap
# that quietly evaporates when its config is missing is worse than no cap,
# because the box is then unprotected by something you believe is protecting it.
capacity_gate() {
  if [[ ! "${MAX_PARALLEL_EPICS:-}" =~ ^[1-9][0-9]*$ ]]; then
    echo "[launch] MAX_PARALLEL_EPICS must be a positive integer, got '${MAX_PARALLEL_EPICS:-<unset>}' — fix etc/repos.conf" >&2
    exit 1
  fi
  RUNNING="$(running_count)"
  if (( RUNNING >= MAX_PARALLEL_EPICS )); then
    echo "[launch] at capacity ($RUNNING/$MAX_PARALLEL_EPICS running)${SESSION:+ — not starting '$SESSION'}" >&2
    exit 3
  fi
  echo "[launch] capacity $RUNNING/$MAX_PARALLEL_EPICS"
}

# --check-capacity: answer the cap question and stop — no naming, no pull, no
# session. dispatch.sh probes this before its fixer-walk label swap, so a full
# host costs zero label writes instead of a swap it must immediately revert.
if [[ $CHECK_CAPACITY -eq 1 ]]; then
  capacity_gate
  exit 0
fi

# --check-idle: the same count, against zero. update-claude.sh asks this
# before swapping the claude binary — every phase of a run is a fresh claude
# process, so a swap under a live run hands its later phases a different CLI
# than its earlier ones — and asking here means the one function that counts
# running sessions for the cap is also the one that decides "idle".
if [[ $CHECK_IDLE -eq 1 ]]; then
  RUNNING="$(running_count)"
  if (( RUNNING > 0 )); then
    echo "[launch] $RUNNING session(s) running — not idle" >&2
    exit 3
  fi
  echo "[launch] idle"
  exit 0
fi

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
#
# "=" pins the match to the exact name: a bare -t matches session-name
# PREFIXES, so launching epic-26 while epic-263 is live would report "already
# running" and start nothing at all.
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  current="$(tmux list-panes -t "$SESSION" -F '#{pane_current_command}' | head -n1)"
  case "$current" in
    bash|zsh|sh|dash)
      echo "[launch] session '$SESSION' exists but its process isn't running (pane at a $current prompt) — restart it (from the laptop): ./remote-control.sh restart $SESSION" ;;
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
# Counting and creating are ONE critical section, or the cap is advisory: two
# launches that both read cap-1 both start, and the box runs cap+1. dispatch
# serialises its own launches under the tick lock, but a manual
# `./remote-control.sh epic N` reaches this script by another path, and that is
# exactly the pair that can race. Blocking (no -n): a launch that waits a few
# seconds for the one ahead of it is the correct outcome, not a refusal.
# Released as soon as the session exists, since from then on running_count sees
# it — which is what the next admission needs.
# flock is Linux-only and everything in bin/ runs on the host, so this is the
# normal path; a box without it degrades to the advisory counting this had
# before rather than refusing to launch anything.
LAUNCH_LOCKED=0
if command -v flock >/dev/null 2>&1; then
  exec 8>"${TMPDIR:-/tmp}/harness-launch.lock"
  if flock 8; then
    LAUNCH_LOCKED=1
  else
    echo "[launch] could not take the launch lock — counting without it" >&2
  fi
fi
capacity_gate

echo "[launch] pulling latest main in $PROJECT"
git -C "$PROJECT" pull --rebase

# Where the pane starts, and what it runs there. Interactive sessions start in
# the clone and let claude make its own worktree; a pipeline run gets one made
# here, because the thing it launches is a plain node process with no opinion
# about git.
CWD="$PROJECT"
if [[ -n "$MODE" ]]; then
  WT="${EPIC_WORKTREE_ROOT:-$HOME/.epic-worktrees}/$REPO/$SESSION"
  if [[ -d "$WT" ]] && git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
    # Reuse: session name == worktree name, so a relaunch (a retried fixer, a
    # resumed epic) lands back in its predecessor's tree. Scrub the transient
    # state a killed run leaves — a half-finished rebase makes every later step
    # fail on cleanup instead of retrying, and a dirty tree trips the resume
    # guard's rebase. NOT `clean -x`: the ignored files are node_modules (an
    # `npm ci` per relaunch) and .epics/<slug>/, whose epic.md the resume path
    # appends to. Committed work is untouched — that is what checkpoints are.
    echo "[launch] reusing worktree $WT"
    git -C "$WT" rebase --abort >/dev/null 2>&1 || true
    git -C "$WT" merge --abort >/dev/null 2>&1 || true
    git -C "$WT" reset --hard >/dev/null 2>&1 || true
    git -C "$WT" clean -fd >/dev/null 2>&1 || true
  else
    rm -rf "$WT"
    mkdir -p "$(dirname "$WT")"
    # Prune first: a worktree removed by hand leaves an administrative entry
    # that makes `worktree add` refuse the same path.
    git -C "$PROJECT" worktree prune
    echo "[launch] creating worktree $WT"
    # Detached: the pipeline's own prepare phase decides which branch to be on
    # (fresh claim or resume), and a worktree holding that branch already would
    # be the one thing its resume guard reads as a live competitor.
    git -C "$PROJECT" worktree add --detach "$WT" HEAD
  fi
  CWD="$WT"
fi

echo "[launch] creating session '$SESSION' in $CWD"
# 8>&- so a tmux server started by this call cannot inherit the launch lock and
# hold it for the life of the host (the hazard dispatch guards with 9>&-).
tmux new-session -d -s "$SESSION" -c "$CWD" 8>&-
(( LAUNCH_LOCKED == 0 )) || flock -u 8 2>/dev/null || true
# Tag the session with its repo so `ls` can report it regardless of where the
# pane's cwd later moves. If either tag fails, remove the new idle session:
# leaving an untagged pipeline alive makes operator output lie about routing.
if ! tmux set-option -t "$SESSION" @repo "$REPO" || \
   ! tmux set-option -t "$SESSION" @engine "$ENGINE"; then
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "[launch] could not tag session '$SESSION' — removed it before starting" >&2
  exit 1
fi

if [[ -n "$MODE" ]]; then
  # The pipeline. --session is both the log prefix and the marker
  # bin/resource-log.sh counts epics by, so it is not decoration.
  case "$MODE" in
    epic) SCRIPT="$HERE/../workflows/epic-run.mjs" ;;
    fix)  SCRIPT="$HERE/../workflows/fix-run.mjs" ;;
    ci)   SCRIPT="$HERE/../workflows/ci-run.mjs" ;;
    defect) SCRIPT="$HERE/../workflows/defect-run.mjs" ;;
  esac
  LINE="node $(sq "$SCRIPT") --issue $ISSUE --session $(sq "$SESSION") --engine $(sq "$ENGINE")"
else
  # An interactive session. The name is threaded through --remote-control and
  # --worktree so it's identifiable in the Desktop app and reusable across
  # restarts; session name == worktree name is a deliberate invariant. The
  # initial prompt (if any) is appended as a positional arg, quoted for the
  # pane's shell. NOTE: positional, not `-p` — `-p` is print/non-interactive
  # mode, which would run the prompt then exit and tear the session down.
  LINE="claude --remote-control $SESSION --dangerously-skip-permissions --worktree $SESSION"
  if [[ $HAVE_MESSAGE -eq 1 && -n "$MESSAGE" ]]; then
    LINE+=" $(sq "$MESSAGE")"
  fi
fi
# Typed into a shell via send-keys (rather than run as tmux new-session's
# command) so the pane survives the process exiting: `ls` reports it as dead,
# and capture-pane can still show the scrollback — which for a pipeline run is
# the whole phase log and its final RESULT line.
tmux send-keys -t "$SESSION" -- "$LINE" Enter
