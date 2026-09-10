#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host. The single launch primitive: resolves the session name,
# enforces the host's slot budget, pulls the repo, creates the detached tmux
# session, tags it with its repo and starts the run inside it.
# The laptop's ./toliki calls this over ssh; bin/dispatch.sh (host-side, cron)
# calls it directly — keep it free of any ssh/laptop assumptions.
# It writes the registry's HOST_TIMEZONE and TZ into every pane command rather
# than trusting the ssh caller or a long-lived tmux server's cached environment.
#
# Two kinds of session, and they run different things:
#   --epic N / --task N / --fix N / --ci N / --defect N
#                        a pipeline run: this script creates the git worktree
#                        and the pane runs workflows/{epic,task,fix,ci,defect}-run.mjs, which
#                        spawns one headless agent process per phase. No
#                        interactive session wraps it, so there is no
#                        --remote-control channel to attach to — watch it with
#                        `tmux attach` / `capture-pane`, same as diagnosing one.
#   everything else      an interactive Claude or Codex client in a retained
#                        Toliki-owned branch/worktree; Claude keeps Remote Control.
#
# Exit codes: 0 launched (or the session already existed), 1 usage/config
# error, 3 refused because the host is at MAX_PARALLEL_EPICS. 3 is separate
# because dispatch.sh reads it as "stop this tick" rather than as a failure.
#
# --over-capacity is the one deliberate bypass of that refusal, and it is
# narrow on purpose: only a named --epic/--task/--fix/--ci/--defect launch may carry
# it (a probe, an interactive session or a bare name exits 1), no environment
# variable grants it, and dispatch.sh never passes it — so queue-driven work
# stays bounded no matter how often an operator overrides by hand.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"
source "$HERE/manual-session.lib.sh"

# Laptop commands arrive through non-login SSH, which does not read Ubuntu's
# ~/.profile. Provisioning installs agent CLIs in ~/.local/bin and Bun in
# ~/.bun/bin, so make those owning locations available both to preflight checks
# here and to the pane command below. The explicit pane PATH avoids depending
# on whichever environment happened to start the long-lived tmux server.
PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
export PATH

usage() {
  cat <<EOF
Usage: $0 [session-name] [-m <message>] [-r <repo>] [--engine claude|codex] [--restart]
       $0 [--check-capacity|--check-idle]
       $0 --epic <N> [-r <repo>] [--engine <engine>] [--over-capacity]
       $0 --task <N> [-r <repo>] [--engine <engine>] [--over-capacity]
       $0 --fix <N>  [-r <repo>] [--engine <engine>] [--over-capacity]
       $0 --ci <N>   [-r <repo>] [--engine <engine>] [--over-capacity]
       $0 --defect <N> [-r <repo>] [--engine <engine>] [--over-capacity]

Creates a detached tmux session in the named repo (default: $DEFAULT_REPO).

--epic/--task/--fix/--ci/--defect run the autonomous pipeline: the session is named <repo>-epic-<N>,
this script creates its git worktree under \${EPIC_WORKTREE_ROOT:-\$HOME/.epic-worktrees},
and the pane runs the corresponding workflows/*-run.mjs there. They take no
session name and no -m — both are derived from the issue number.
For a manual session, --engine selects the interactive client (claude by
default). A stopped workspace remembers its client; --restart without an
override inherits it. For a pipeline, --engine names an etc/engines.json table.
Omitted, a pipeline run takes the host default —
the EPIC_ENGINE line of the installed cron file (/etc/cron.d/harness-dispatch),
claude when that file is absent — and refuses if that file and this process's
environment disagree. Currently: $(engine_names | tr '\n' ' ')

Without them the session is an interactive Claude or Codex client in a durable
manual branch/worktree. Name resolution when no name
is given: with -m, the session is named after the message (slugified); otherwise
the first pool name free for the repo: ${NAMES[*]}
If the session already exists, reports whether its process is still running and
changes nothing (it never relaunches into a live session, and doesn't pull).
Manual sessions are outside pipeline capacity. Pipelines refuse with exit 3
when $MAX_PARALLEL_EPICS pipeline sessions are already running.
--check-capacity answers ONLY that last question (exit 0 below the cap, 3 at
it) and starts nothing — dispatch.sh probes it before work it would otherwise
have to undo, so the counting stays in this one script.
--check-idle counts every active pane, including capacity-exempt manual work
(exit 0 with nothing running, 3 otherwise) — bin/update-claude.sh asks it
before moving the claude binary.
--over-capacity admits ONE pipeline launch over that cap on purpose, and
bypasses nothing else: the count still runs under the launch lock, the session
counts like any other afterwards (so dispatch stays paused until usage drops
below $MAX_PARALLEL_EPICS), and it is refused with exit 1 on the probes above
and on anything that isn't --epic/--task/--fix/--ci/--defect.
EOF
}

SESSION=""
MESSAGE=""
HAVE_MESSAGE=0
CHECK_CAPACITY=0
CHECK_IDLE=0
REPO="$DEFAULT_REPO"
MODE=""       # "" = interactive manual client; otherwise selected pipeline run
ISSUE=""
ENGINE=""     # a pipeline run with no --engine resolves the host default below
HAVE_ENGINE=0
RESTART=0
OVER_CAPACITY=0            # hard-initialised: only the flag below may set it, never the environment

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
    --over-capacity)
      OVER_CAPACITY=1
      shift
      ;;
    --restart)
      RESTART=1
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
    --epic|--task|--fix|--ci|--defect|--epic=*|--task=*|--fix=*|--ci=*|--defect=*)
      # One leading '#' is stripped so `--epic #42` and `--epic 42` agree.
      case "$1" in
        --epic*) want="epic" ;;
        --task*) want="task" ;;
        --ci*)   want="ci" ;;
        --fix*)  want="fix" ;;
        *)       want="defect" ;;
      esac
      if [[ -n "$MODE" ]]; then
        echo "[launch] --epic, --task, --fix, --ci and --defect are mutually exclusive" >&2
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

# An explicit engine is validated here, before anything is named or counted.
# The host default is NOT read here: --check-capacity and --check-idle answer a
# counting question and exit below, and a probe that refused on a malformed
# cron file would stop dispatch's capacity check and update-claude's idle check
# along with the launches they gate.
if [[ $HAVE_ENGINE -eq 1 ]]; then
  if [[ -n "$MODE" ]]; then
    if ! engine_known "$ENGINE"; then
      echo "[launch] --engine must name an engine in etc/engines.json ($(engine_names | tr '\n' ' ')), got '$ENGINE'" >&2
      exit 1
    fi
  elif [[ "$ENGINE" != claude && "$ENGINE" != codex ]]; then
    echo "[launch] manual --engine must be claude or codex, got '$ENGINE'" >&2
    exit 1
  fi
fi
if [[ $RESTART -eq 1 && -n "$MODE" ]]; then
  echo "[launch] --restart applies only to interactive manual sessions" >&2
  exit 1
fi
if [[ $RESTART -eq 1 && -z "$SESSION" ]]; then
  echo "[launch] --restart requires an explicit manual session name" >&2
  exit 1
fi
if [[ $HAVE_ENGINE -eq 1 && ( $CHECK_CAPACITY -eq 1 || $CHECK_IDLE -eq 1 ) ]]; then
  echo "[launch] --engine cannot be combined with a capacity or idle probe" >&2
  exit 1
fi
# The override may only ride a launch that actually starts a pipeline. A probe
# answers a question other callers act on — dispatch.sh skips a whole tick on
# --check-capacity's exit 3, update-claude.sh moves a binary on --check-idle's
# exit 0 — so an override there would make them believe something false about
# the host rather than overload it honestly.
if [[ $OVER_CAPACITY -eq 1 && ( $CHECK_CAPACITY -eq 1 || $CHECK_IDLE -eq 1 ) ]]; then
  echo "[launch] --over-capacity can't be combined with --check-capacity/--check-idle — probes stay strict" >&2
  exit 1
fi
if [[ $OVER_CAPACITY -eq 1 && -z "$MODE" ]]; then
  echo "[launch] --over-capacity only applies to --epic/--task/--fix/--ci/--defect pipeline runs" >&2
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

# Count live panes. Capacity excludes only sessions whose manual identity is
# proved by both the tmux tag and durable workspace metadata; missing or stale
# identity stays conservative and counts. Idle deliberately includes manual
# sessions because replacing a CLI under interactive work is unsafe too.
running_count() { # all|pipeline
  local scope="$1" s current n=0 kind repo
  while IFS= read -r s; do
    [[ -n "$s" ]] || continue
    current="$(tmux list-panes -t "$s" -F '#{pane_current_command}' 2>/dev/null | head -n1)"
    case "$current" in
      bash|zsh|sh|dash|'') ;;
      *)
        if [[ "$scope" == pipeline ]]; then
          kind="$(tmux show-options -t "=$s" -qv @toliki_kind 2>/dev/null || true)"
          repo="$(tmux show-options -t "=$s" -qv @repo 2>/dev/null || true)"
          if [[ "$kind" == manual && -n "$repo" ]] && manual_load "$repo" "$s" 2>/dev/null; then
            continue
          fi
          if [[ -z "$kind" && -n "$repo" && "$s" != "$repo-epic-"* ]] &&
             project="$(repo_path "$repo" 2>/dev/null)" && manual_find_legacy_worktree "$project" "$s"; then
            continue
          fi
        fi
        n=$((n + 1))
        ;;
    esac
  done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
  # A client can leave an owned child after its pane returns to a shell. The
  # capacity view still ignores it (manual load is explicitly operator-owned),
  # but idle must remain false until manual cleanup verifies every child gone.
  if [[ "$scope" == all && $n -eq 0 ]]; then
    while IFS= read -r repo; do
      while IFS= read -r s; do
        [[ -n "$s" ]] || continue
        if manual_load "$repo" "$s" 2>/dev/null && [[ -n "$(manual_owned_pids "$MANUAL_TOKEN")" ]]; then
          n=1
          break 2
        fi
      done < <(manual_sessions_for_repo "$repo")
    done < <(repo_names)
  fi
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
  RUNNING="$(running_count pipeline)"
  if (( RUNNING >= MAX_PARALLEL_EPICS )); then
    # The bypass is here, inside the gate and under the caller's lock, so an
    # override is admitted against the same count every other launch is judged
    # by — and is loud, because the operator is the only thing standing between
    # this line and an overloaded box.
    if (( OVER_CAPACITY == 1 )); then
      echo "[launch] OVER CAPACITY: $RUNNING/$MAX_PARALLEL_EPICS already running — admitting '$SESSION' anyway (--over-capacity); dispatch stays paused until usage drops below $MAX_PARALLEL_EPICS" >&2
      return 0
    fi
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

# --check-idle: all active panes against zero. update-claude.sh asks this
# before swapping the claude binary — every phase of a run is a fresh claude
# process, so a swap under a live run hands its later phases a different CLI
# than its earlier ones — and asking here means the one function that counts
# running sessions for the cap is also the one that decides "idle".
if [[ $CHECK_IDLE -eq 1 ]]; then
  RUNNING="$(running_count all)"
  if (( RUNNING > 0 )); then
    echo "[launch] $RUNNING session(s) running — not idle" >&2
    exit 3
  fi
  echo "[launch] idle"
  exit 0
fi

# The host default, for a pipeline run that named no engine: the installed cron
# file's EPIC_ENGINE (etc/lib.sh), which is what the dispatch tick reads too —
# a manual launch arriving over ssh has an environment cron never touched, so
# the file is the only value the two can share. Resolved after the probes above
# and before the session is created, so a refusal costs no worktree and no
# session. Manual client selection is resolved separately below.
if [[ -n "$MODE" && $HAVE_ENGINE -eq 0 ]]; then
  if ! resolve_host_default_engine; then
    echo "[launch] $HOST_DEFAULT_ENGINE_ERROR" >&2
    exit 1
  fi
  ENGINE="$HOST_DEFAULT_ENGINE"
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

if [[ ! "$SESSION" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "[launch] invalid session name '$SESSION' (use letters, digits, '-' or '_')" >&2
  exit 1
fi
if [[ -z "$MODE" && "$SESSION" =~ ^${REPO}-epic-[0-9]+$ ]]; then
  echo "[launch] '$SESSION' is reserved for pipeline sessions; choose a non-epic manual name" >&2
  exit 1
fi

print_manual_cheatsheet() { # actual engine/worktree/branch are globals
  local attach
  attach="tmux attach-session -t =$SESSION"
  cat <<EOF
[launch] manual session details
  session:  $SESSION
  client:   $ENGINE
  branch:   $MANUAL_BRANCH
  worktree: $MANUAL_WORKTREE

Connect/reconnect from the laptop:
  ssh -t $(sq "$SSH_HOST") $(sq "$attach")
Detach without stopping work: press Ctrl-b, then d
List sessions:
  ./toliki session list
Restart this client in the same workspace:
  ./toliki session restart $(sq "$SESSION")
Stop this session and its owned processes (code is retained):
  ./toliki session stop $(sq "$SESSION")
Stop all proven Toliki manual sessions/processes (pipelines are untouched):
  ./toliki session stop-manual
After work is clean and merged, remove this workspace and local branch safely:
  ./toliki session remove-workspace $(sq "$SESSION")

Manual sessions are outside pipeline capacity and automation. Stopping never
removes code; the worktree and branch remain until remove-workspace succeeds.
EOF
}

prepare_manual_workspace() {
  local load_rc branch worktree token legacy_engine
  if manual_load "$REPO" "$SESSION"; then
    if [[ $HAVE_ENGINE -eq 0 ]]; then ENGINE="$MANUAL_ENGINE"; fi
    return 0
  else
    load_rc=$?
  fi
  if [[ $load_rc -eq 2 ]]; then
    echo "[launch] $MANUAL_ERROR" >&2
    return 1
  fi

  branch="$(manual_default_branch "$REPO" "$SESSION")"
  worktree="$(manual_default_worktree "$REPO" "$SESSION")"
  # Claude's former --worktree path predates durable Toliki metadata. Adopt a
  # single registered worktree whose basename exactly matches the session;
  # multiple or malformed candidates are ambiguity, never permission to reset.
  if manual_find_legacy_worktree "$PROJECT" "$SESSION"; then
    legacy_engine=claude
    [[ $HAVE_ENGINE -eq 1 ]] || ENGINE="$legacy_engine"
    token="legacy-$SESSION-$(date +%s)-$$-$RANDOM"
    if ! manual_record "$PROJECT" "$SESSION" "$REPO" "$LEGACY_BRANCH" "$LEGACY_WORKTREE" "$legacy_engine" "$token"; then
      git -C "$PROJECT" config --remove-section "toliki-manual.$SESSION" 2>/dev/null || true
      echo "[launch] could not record ownership for existing Claude workspace '$LEGACY_WORKTREE'; leaving it untouched" >&2
      return 1
    fi
    echo "[launch] adopted existing Claude workspace $LEGACY_WORKTREE on $LEGACY_BRANCH"
    manual_load "$REPO" "$SESSION"
    return
  fi
  if (( LEGACY_AMBIGUOUS == 1 )); then
    echo "[launch] found worktree path(s) named '$SESSION' but could not prove they are the former Claude workspace; leaving them intact" >&2
    return 1
  fi
  if [[ -e "$worktree" ]]; then
    echo "[launch] '$worktree' already exists without recognizable manual ownership; leaving it untouched" >&2
    return 1
  fi
  if git -C "$PROJECT" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "[launch] branch '$branch' already exists without recognizable manual ownership; leaving it untouched" >&2
    return 1
  fi
  echo "[launch] fetching current origin/main for new manual workspace"
  git -C "$PROJECT" fetch origin main
  git -C "$PROJECT" show-ref --verify --quiet refs/remotes/origin/main || {
    echo "[launch] origin/main is unavailable; no manual workspace created" >&2; return 1;
  }
  mkdir -p "$(dirname "$worktree")"
  echo "[launch] creating manual worktree $worktree on $branch"
  git -C "$PROJECT" worktree add -b "$branch" "$worktree" refs/remotes/origin/main
  token="manual-$SESSION-$(date +%s)-$$-$RANDOM"
  if ! manual_record "$PROJECT" "$SESSION" "$REPO" "$branch" "$worktree" "$ENGINE" "$token"; then
    git -C "$PROJECT" worktree remove "$worktree" 2>/dev/null || true
    git -C "$PROJECT" branch -D "$branch" 2>/dev/null || true
    git -C "$PROJECT" config --remove-section "toliki-manual.$SESSION" 2>/dev/null || true
    echo "[launch] could not record manual workspace ownership; rolled back the new workspace" >&2
    return 1
  fi
  manual_load "$REPO" "$SESSION"
}

# An existing session is reported, never relaunched into (a derived or pool
# name colliding with a live session must not clobber it).
#
# "=" pins the match to the exact name: a bare -t matches session-name
# PREFIXES, so launching epic-26 while epic-263 is live would report "already
# running" and start nothing at all.
if tmux has-session -t "=$SESSION" 2>/dev/null && [[ -n "$MODE" ]]; then
  current="$(tmux list-panes -t "$SESSION" -F '#{pane_current_command}' | head -n1)"
  case "$current" in
    bash|zsh|sh|dash)
      echo "[launch] session '$SESSION' exists but its process isn't running (pane at a $current prompt) — restart it (from the laptop): ./toliki session restart $SESSION" ;;
    *)
      echo "[launch] session '$SESSION' already running (pane: $current)" ;;
  esac
  exit 0
fi

if [[ -z "$MODE" ]]; then
  [[ $HAVE_ENGINE -eq 1 ]] || ENGINE=claude
  command -v tmux >/dev/null 2>&1 || { echo "[launch] tmux is not installed or not on PATH" >&2; exit 1; }
  command -v git >/dev/null 2>&1 || { echo "[launch] git is not installed or not on PATH" >&2; exit 1; }
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    pre_kind="$(tmux show-options -t "=$SESSION" -qv @toliki_kind 2>/dev/null || true)"
    pre_pane="$(tmux list-panes -t "=$SESSION" -F '#{pane_current_command}' 2>/dev/null | head -n1 || true)"
    case "$pre_kind" in
      manual)
        if ! manual_load "$REPO" "$SESSION"; then
          echo "[launch] '$SESSION' is tagged manual but its durable workspace ownership is missing or ambiguous; leaving it untouched" >&2
          exit 1
        fi
        ;;
      '')
        if ! manual_find_legacy_worktree "$PROJECT" "$SESSION"; then
          echo "[launch] tmux session '$SESSION' already exists without provable manual ownership (pane: ${pre_pane:-unknown}); leaving it untouched" >&2
          exit 1
        fi
        ;;
      *)
        echo "[launch] tmux session '$SESSION' is '$pre_kind', not manual; leaving it untouched" >&2
        exit 1
        ;;
    esac
  fi
  # A retained workspace chooses its previous client before any mutation; a
  # requested override is checked directly. This keeps missing-client failures
  # ahead of workspace creation and, especially, ahead of restart's stop.
  if [[ $HAVE_ENGINE -eq 0 ]] && manual_load "$REPO" "$SESSION"; then
    ENGINE="$MANUAL_ENGINE"
  fi
  command -v "$ENGINE" >/dev/null 2>&1 || {
    echo "[launch] interactive client '$ENGINE' is not installed or not on PATH; nothing was stopped or started" >&2
    exit 1
  }
  # Preparing validates existing ownership and determines the inherited engine
  # before restart is allowed to stop anything.
  prepare_manual_workspace || exit 1
  if tmux has-session -t "=$SESSION" 2>/dev/null; then
    kind="$(tmux show-options -t "=$SESSION" -qv @toliki_kind 2>/dev/null || true)"
    actual_engine="$(tmux show-options -t "=$SESSION" -qv @engine 2>/dev/null || true)"
    # A recognized legacy Claude pane may be tagged now that its workspace was
    # safely adopted. Anything else with this name remains untouchable.
    pane="$(tmux list-panes -t "=$SESSION" -F '#{pane_current_command}' 2>/dev/null | head -n1 || true)"
    if [[ -z "$kind" && "$MANUAL_ENGINE" == claude && \
          ( "$pane" == claude || "$pane" == bash || "$pane" == zsh || "$pane" == sh || "$pane" == dash ) ]]; then
      tmux set-option -t "=$SESSION" @toliki_kind manual &&
        tmux set-option -t "=$SESSION" @engine claude &&
        tmux set-option -t "=$SESSION" @worktree "$MANUAL_WORKTREE" &&
        tmux set-option -t "=$SESSION" @branch "$MANUAL_BRANCH" || {
          echo "[launch] could not tag recognized legacy session '$SESSION'; leaving it running" >&2; exit 1;
        }
      kind=manual actual_engine=claude
    fi
    if [[ "$kind" != manual || -z "$actual_engine" || "$actual_engine" != "$MANUAL_ENGINE" ]]; then
      echo "[launch] tmux session '$SESSION' exists but is not a proven manual session; leaving it untouched" >&2
      exit 1
    fi
    if [[ $RESTART -eq 0 ]]; then
      if [[ $HAVE_ENGINE -eq 1 && "$ENGINE" != "$actual_engine" ]]; then
        echo "[launch] '$SESSION' is already a $actual_engine manual session; requested $ENGINE was not applied. Use session restart to switch clients." >&2
        ENGINE="$actual_engine"
        print_manual_cheatsheet
        exit 1
      fi
      ENGINE="$actual_engine"
      case "$pane" in
        bash|zsh|sh|dash|'') echo "[launch] session '$SESSION' exists but $actual_engine is stopped; no client or workspace was changed" ;;
        *) echo "[launch] session '$SESSION' already running ($actual_engine); no client or workspace was changed" ;;
      esac
      print_manual_cheatsheet
      exit 0
    fi
    "$HERE/manual-session.sh" stop --repo "$REPO" "$SESSION" || {
      echo "[launch] could not stop '$SESSION'; restart aborted with workspace retained" >&2; exit 1;
    }
  elif [[ $RESTART -eq 1 ]]; then
    # Idempotent restart of a stopped client is just a start in its workspace.
    echo "[launch] '$SESSION' is stopped; starting it in its retained workspace"
  fi
fi

# The slot budget is enforced HERE rather than in dispatch.sh because this is
# the primitive both callers share: ./toliki run reaches it over ssh,
# dispatch.sh calls it directly. A cap counted by the dispatcher would bound
# only the dispatcher, and every manual `./toliki run epic N` would walk past
# it — so the two callers together could overrun the box while each believed it
# was under the cap. Counting at the one place that actually creates sessions
# is the only version that can't be bypassed. It sits after the has-session
# check on purpose: reporting on a session that already exists starts nothing,
# so it must not be refused for capacity.
#
# Counting and creating are ONE critical section, or the cap is advisory: two
# launches that both read cap-1 both start, and the box runs cap+1. dispatch
# serialises its own launches under the tick lock, but a manual
# `./toliki run epic N` reaches this script by another path, and that is
# exactly the pair that can race. Blocking (no -n): a launch that waits a few
# seconds for the one ahead of it is the correct outcome, not a refusal.
# Released as soon as the session exists, since from then on running_count sees
# it — which is what the next admission needs.
# flock is Linux-only and everything in bin/ runs on the host, so this is the
# normal path; a box without it degrades to the advisory counting this had
# before rather than refusing to launch anything.
LAUNCH_LOCKED=0
if [[ -n "$MODE" ]]; then
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
fi

# Where the pane starts, and what it runs there. Both lifecycles get worktrees;
# pipeline reuse is scrubbed below, while manual reuse was validated above and
# is never reset or cleaned.
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
else
  CWD="$MANUAL_WORKTREE"
fi

echo "[launch] creating session '$SESSION' in $CWD"
# 8>&- so a tmux server started by this call cannot inherit the launch lock and
# hold it for the life of the host (the hazard dispatch guards with 9>&-).
if ! tmux new-session -d -s "$SESSION" -c "$CWD" 8>&-; then
  echo "[launch] tmux could not create session '$SESSION'; workspace retained at $CWD" >&2
  exit 1
fi
(( LAUNCH_LOCKED == 0 )) || flock -u 8 2>/dev/null || true
# Tag the session with its repo so `ls` can report it regardless of where the
# pane's cwd later moves. If either tag fails, remove the new idle session:
# leaving an untagged pipeline alive makes operator output lie about routing.
KIND="pipeline"
[[ -n "$MODE" ]] || KIND="manual"
set_session_tags() {
  tmux set-option -t "=$SESSION" @repo "$REPO" || return 1
  tmux set-option -t "=$SESSION" @engine "$ENGINE" || return 1
  tmux set-option -t "=$SESSION" @toliki_kind "$KIND" || return 1
  if [[ -z "$MODE" ]]; then
    tmux set-option -t "=$SESSION" @worktree "$MANUAL_WORKTREE" || return 1
    tmux set-option -t "=$SESSION" @branch "$MANUAL_BRANCH" || return 1
  fi
}
if ! set_session_tags; then
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
  echo "[launch] could not tag session '$SESSION' — removed it before starting" >&2
  exit 1
fi

if [[ -n "$MODE" ]]; then
  # The pipeline. --session is both the log prefix and the marker
  # bin/resource-log.sh counts epics by, so it is not decoration. --repo is the
  # registry key validated above: usage telemetry records which repository an
  # issue number belongs to, and the session name is not a structure to mine
  # that out of — the same number in two repos is two different issues.
  case "$MODE" in
    epic) SCRIPT="$HERE/../workflows/epic-run.mjs" ;;
    task) SCRIPT="$HERE/../workflows/task-run.mjs" ;;
    fix)  SCRIPT="$HERE/../workflows/fix-run.mjs" ;;
    ci)   SCRIPT="$HERE/../workflows/ci-run.mjs" ;;
    defect) SCRIPT="$HERE/../workflows/defect-run.mjs" ;;
  esac
  LINE="PATH=$(sq "$PATH") TZ=$(sq "$HOST_TIMEZONE") HOST_TIMEZONE=$(sq "$HOST_TIMEZONE") node $(sq "$SCRIPT") --issue $ISSUE --session $(sq "$SESSION") --engine $(sq "$ENGINE") --repo $(sq "$REPO")"
else
  # The wrapper gives every descendant an unforgeable-per-workspace ownership
  # token. It remains an interactive invocation: prompts are positional, never
  # Claude -p or Codex exec. Authentication and consent UI stay visible.
  LINE="PATH=$(sq "$PATH") TZ=$(sq "$HOST_TIMEZONE") HOST_TIMEZONE=$(sq "$HOST_TIMEZONE") TOLIKI_MANUAL_SESSION=$(sq "$SESSION") TOLIKI_MANUAL_OWNER=$(sq "$MANUAL_TOKEN")"
  if [[ "$ENGINE" == claude ]]; then
    LINE+=" claude --remote-control $(sq "$SESSION") --dangerously-skip-permissions"
  else
    LINE+=" codex"
  fi
  if [[ $HAVE_MESSAGE -eq 1 && -n "$MESSAGE" ]]; then
    LINE+=" $(sq "$MESSAGE")"
  fi
fi
# Typed into a shell via send-keys (rather than run as tmux new-session's
# command) so the pane survives the process exiting: `ls` reports it as dead,
# and capture-pane can still show the scrollback — which for a pipeline run is
# the whole phase log and its final RESULT line.
if ! tmux send-keys -t "=$SESSION" -- "$LINE" Enter; then
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
  echo "[launch] could not start $ENGINE in '$SESSION'; removed the tmux session and retained $CWD" >&2
  exit 1
fi
if [[ -z "$MODE" ]]; then
  started=0
  for _ in {1..20}; do
    current="$(tmux list-panes -t "=$SESSION" -F '#{pane_current_command}' 2>/dev/null | head -n1 || true)"
    if [[ "$current" == "$ENGINE" || -n "$(manual_owned_pids "$MANUAL_TOKEN")" ]]; then started=1; break; fi
    case "$current" in bash|zsh|sh|dash|'') sleep 0.1 ;; *) break ;; esac
  done
  if (( started == 0 )); then
    failure_output="$(tmux capture-pane -p -t "=$SESSION" -S -40 2>/dev/null || true)"
    tmux kill-session -t "=$SESSION" 2>/dev/null || true
    echo "[launch] $ENGINE did not remain running in '$SESSION' (pane: ${current:-unknown}); no startup success is claimed" >&2
    [[ -z "$failure_output" ]] || printf '%s\n' "$failure_output" | sed 's/^/[client] /' >&2
    echo "[launch] the failed tmux pane was removed; workspace retained at $MANUAL_WORKTREE" >&2
    exit 1
  fi
  # Persist an explicit client switch only once the new pane was created,
  # tagged and started successfully.
  if ! git -C "$PROJECT" config "toliki-manual.$SESSION.engine" "$ENGINE" || ! manual_load "$REPO" "$SESSION"; then
    "$HERE/manual-session.sh" stop --repo "$REPO" "$SESSION" >/dev/null 2>&1 || true
    echo "[launch] $ENGINE started but its durable client metadata could not be saved; stopped it and retained the workspace" >&2
    exit 1
  fi
  echo "[launch] manual session ready"
  print_manual_cheatsheet
fi
