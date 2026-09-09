#!/usr/bin/env bash
set -euo pipefail

# `./toliki route` — assigns work to an engine without starting it. Routing is
# a label write on the host; dispatch picks the issue up on a later tick.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<EOF
Usage: $CLI route next <engine> [-r <repo>]

Commands:
  next <engine>            Route the first unrouted, unblocked ready issue to
                           this engine, by writing its durable engine:<name>
                           label. Starts nothing: the next dispatch tick picks
                           it up. Engines: $(engine_names | tr '\n' ' ')

Options:
  -r, --repo <name>        Only consider that repo: $(repo_names | tr '\n' ' ')
                           Omitted, selection uses dispatch's host-wide
                           interleaving rather than defaulting to one repo.
EOF
}

REPO=""
HAVE_REPO=0

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
    --engine|--engine=*)
      # `route next` names its engine positionally; the flag belongs to a run.
      refuse_engine_flag
      ;;
    --over-capacity)
      refuse_over_capacity
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
  usage
  exit 0
fi

case "${POSITIONAL[0]}" in
  next) ;;
  *) die "unknown route command '${POSITIONAL[0]}' — the only one is: $CLI route next <engine>" ;;
esac

NEXT_ENGINE="${POSITIONAL[1]:-}"
if ! engine_known "$NEXT_ENGINE"; then
  die "'$CLI route next' requires an engine from etc/engines.json ($(engine_names | tr '\n' ' '))"
fi
if [[ -n "${POSITIONAL[2]:-}" ]]; then
  die "'$CLI route next' takes a single engine"
fi
if [[ $HAVE_REPO -eq 1 ]]; then
  require_known_repo "$REPO"
fi

require_ssh_host

REMOTE="$HOST_CONTROL_DIR/bin/dispatch.sh --route-next $(sq "$NEXT_ENGINE")"
if [[ $HAVE_REPO -eq 1 ]]; then
  REMOTE+=" --repo $(sq "$REPO")"
fi
ssh "$HOST" "$REMOTE"
