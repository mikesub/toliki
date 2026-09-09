#!/usr/bin/env bash
set -euo pipefail

# `./toliki run` — the manual pipeline launches: the operator's override for
# what dispatch would otherwise pick up on its own tick. Each one produces
# exactly the session dispatch would have (launch.sh derives the
# <repo>-epic-<N> name itself), which is what makes a manual launch visible to
# dispatch's has-session checks and reclaimable by reap.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<EOF
Usage: $CLI run <$PIPELINE_KINDS> <issue> [--engine <name>] [-r <repo>] [--over-capacity]

Pipelines:
  epic <ref>               Run the epic pipeline on an issue, as session
                           <repo>-epic-<ref>. The manual override for dispatch's
                           ready queue. A ref starting with # isn't doubled.
  task <ref>               Run the lightweight single-agent task workflow on an
                           issue carrying the persistent task selector label.
                           Uses the same <repo>-epic-<ref> session/worktree.
  fix <ref>                Run the conflict fixer on a needs-judgment issue —
                           the manual override for dispatch's fixer walk. Same
                           session name as dispatch would use, which is what
                           keeps it visible to reap and to the next tick.
  ci <ref>                 Run the CI fixer on a needs-ci-fix issue (checks red
                           on the rebased head) — the manual override for the
                           other fixer walk. Same session name again.
  defect <ref>             Run the ship-gate defect fixer on a needs-defect-fix
                           issue, even when its repo is not autonomously opted in.

Options:
  -r, --repo <name>        Repo to run in: $(repo_names | tr '\n' ' ')(default: $DEFAULT_REPO).
                           Every session is named <repo>-epic-<ref>, so
                           "run epic 63 -r otherapp" -> otherapp-epic-63.
  --engine <engine>        Optional; a name from etc/engines.json
                           ($(engine_names | tr '\n' ' ')). Given, it is
                           persisted as the issue's durable engine:<name> label
                           before the launch. Omitted, the engine is resolved on
                           the host — the issue's own engine:<name> label, else
                           the host's EPIC_ENGINE default, else claude — and
                           nothing is written: an inherited default stays a
                           default. Queue-driven launches get the engine from
                           the issue label the same way.
  --over-capacity          Start the run even though the host is already at
                           MAX_PARALLEL_EPICS. Refused on anything else, and
                           never forwarded by dispatch — the queue stays
                           bounded, and the session counts normally once it is
                           up, so automatic ticks stay paused until usage drops
                           below the limit.

  These sessions run the pipeline directly (a node orchestrator that spawns one
  headless agent per phase), so they have no Remote Control channel to attach
  to. Watch one with: ssh <host> 'tmux attach -t <name>' — or read it after the
  fact with 'tmux capture-pane -p -t <name> -S -200'.
EOF
}

PIPELINE=""
REF=""
REPO=""
HAVE_REPO=0
ENGINE=""
HAVE_ENGINE=0
HAVE_OVER_CAPACITY=0

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
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
      HAVE_ENGINE=1
      ENGINE="$2"
      shift 2
      ;;
    --engine=*)
      HAVE_ENGINE=1
      ENGINE="${1#*=}"
      shift
      ;;
    --over-capacity)
      HAVE_OVER_CAPACITY=1
      shift
      ;;
    -m|--message|-m=*|--message=*)
      refuse_message_flag
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
  # Nothing here can be a launch, so the capacity override must be refused
  # before anything prints usage and exits 0: that success would report the
  # one cap bypass as accepted usage.
  [[ $HAVE_OVER_CAPACITY -eq 0 ]] || refuse_over_capacity
  [[ $HAVE_ENGINE -eq 0 ]] || die "'$CLI run' needs a pipeline and an issue, e.g. $CLI run epic 63"
  usage
  exit 0
fi

case "${POSITIONAL[0]}" in
  epic|task|fix|ci|defect)
    PIPELINE="${POSITIONAL[0]}"
    ;;
  *)
    die "unknown pipeline '${POSITIONAL[0]}' — one of: $PIPELINE_KINDS"
    ;;
esac

REF="${POSITIONAL[1]:-}"
if [[ -z "$REF" ]]; then
  die "'$CLI run $PIPELINE' requires an issue reference, e.g. $CLI run $PIPELINE 63"
fi
if [[ -n "${POSITIONAL[2]:-}" ]]; then
  die "'$CLI run $PIPELINE' takes a single issue reference"
fi
REF="${REF#\#}"              # strip a leading # so we don't double it
if [[ ! "$REF" =~ ^[0-9]+$ ]]; then
  die "'$CLI run $PIPELINE' takes a numeric issue reference"
fi

if [[ $HAVE_ENGINE -eq 1 ]]; then
  require_known_engine "$ENGINE" "--engine"
fi
if [[ $HAVE_REPO -eq 1 ]]; then
  require_known_repo "$REPO"
else
  REPO="$DEFAULT_REPO"
fi

require_ssh_host

if [[ $HAVE_ENGINE -eq 0 ]]; then
  # No engine named: the host decides, in two steps that write nothing.
  # dispatch.sh --resolve-issue reads the issue once and prints
  # "<engine> <source>"; launch.sh is then given that engine explicitly, so
  # every phase of the run takes the resolved route. Deliberately NOT a
  # --route-issue: persisting an inherited label would turn a host-wide
  # fallback into a per-issue decision nobody made.
  #
  # A heredoc rather than a command string because the answer has to be
  # read between the two calls. `read` takes a here-string, never stdin —
  # stdin here IS this script, and reading from it would eat the rest of it.
  ssh "$HOST" bash -s -- "$HOST_CONTROL_DIR" "$PIPELINE" "$REF" "$REPO" "$HAVE_OVER_CAPACITY" <<'REMOTE_INHERIT'
set -euo pipefail
control="$1"
kind="$2"
ref="$3"
repo="$4"
over_capacity="$5"

if ! answer="$("$control/bin/dispatch.sh" --resolve-issue "$ref" --repo "$repo")"; then
  exit 1
fi
read -r engine source <<<"$answer"
case "$source" in
  label)        why="the issue's engine:$engine label" ;;
  host-default) why="the host's EPIC_ENGINE default" ;;
  builtin)      why="the built-in claude default" ;;
  *)
    echo "[remote] #$ref ($repo): unrecognised engine source '$source' — not launching" >&2
    exit 1 ;;
esac
echo "[remote] #$ref ($repo): engine $engine selected by $why — no label written"
# Only the launch half again: --resolve-issue above is dispatch.sh's own
# read-only call, which knows nothing about the flag and starts no session.
launch=("$control/bin/launch.sh" "--$kind" "$ref" --repo "$repo" --engine "$engine")
[[ "$over_capacity" -eq 0 ]] || launch+=(--over-capacity)
exec "${launch[@]}"
REMOTE_INHERIT
  exit 0
fi

# Each arg is shell-quoted with sq() since ssh mashes the remote command into
# one string and hands it to the remote shell. The named engine is persisted
# first and the launch only runs if that write succeeded.
ROUTE="$HOST_CONTROL_DIR/bin/dispatch.sh --route-issue $(sq "$REF") $(sq "$ENGINE") --repo $(sq "$REPO")"
REMOTE="$HOST_CONTROL_DIR/bin/launch.sh --repo $(sq "$REPO") --$PIPELINE $(sq "$REF") --engine $(sq "$ENGINE")"
# Only the launch half: --route-issue is dispatch.sh's own routing call, which
# knows nothing about the flag and starts no session anyway.
[[ $HAVE_OVER_CAPACITY -eq 0 ]] || REMOTE+=" --over-capacity"
ssh "$HOST" "$ROUTE && $REMOTE"
