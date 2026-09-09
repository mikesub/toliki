#!/usr/bin/env bash
set -euo pipefail

# `./toliki usage` — the token, time and outcome report, read-only: the report
# script only reads the host's ~/epic-usage.jsonl. The host loads its OWN
# registry first, the way .agents/skills/toliki/scripts/host-clock.sh does: the
# lifetime view renders timestamps for a human, and etc/lib.sh clears any
# inherited HOST_TIMEZONE before reading repos.conf, so this laptop's zone can
# never decide how the host's runs are dated.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<EOF
Usage: $CLI usage [days] [engine]

Token, time and outcome report from the host's ~/epic-usage.jsonl (read-only).
Two views: which steps an average run spends its tokens on, and what each
issue's whole lifetime cost. Read the numbers as they are named: wall time is
time inside pipeline runs, the elapsed span also counts the waiting between
them, and model-active time is summed spawn duration, which parallel steps make
larger than either. A row's result is what the pipeline itself recorded when it
finished — not whether GitHub later merged the PR.

  days                     Optional window in days, e.g. "$CLI usage 7".
  engine                   Optional engine filter, given after the window:
                           $(engine_names | tr '\n' ' ')
EOF
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine|--engine=*)
      # The report's engine filter is positional, after the window.
      die "'$CLI usage' takes the engine as a positional filter, e.g. $CLI usage 7 codex"
      ;;
    --over-capacity)
      refuse_over_capacity
      ;;
    -m|--message|-m=*|--message=*)
      refuse_message_flag
      ;;
    -r|--repo|-r=*|--repo=*)
      refuse_repo_flag "$CLI usage"
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

USAGE_DAYS="${POSITIONAL[0]:-}"
USAGE_ENGINE="${POSITIONAL[1]:-}"
if [[ -n "$USAGE_DAYS" && ! "$USAGE_DAYS" =~ ^[0-9]+$ ]]; then
  die "'$CLI usage' takes an optional number of days, then an optional engine"
fi
if [[ -n "$USAGE_ENGINE" ]] && ! engine_known "$USAGE_ENGINE"; then
  die "'$CLI usage': unknown engine '$USAGE_ENGINE' ($(engine_names | tr '\n' ' '))"
fi
if [[ -n "${POSITIONAL[2]:-}" ]]; then
  die "'$CLI usage' takes an optional number of days, then an optional engine"
fi

require_ssh_host

REMOTE="source $(sq "$HOST_CONTROL_DIR/etc/lib.sh") && node $HOST_CONTROL_DIR/workflows/usage-report.mjs"
[[ -z "$USAGE_DAYS" ]] || REMOTE+=" --since $(sq "${USAGE_DAYS}d")"
[[ -z "$USAGE_ENGINE" ]] || REMOTE+=" --engine $(sq "$USAGE_ENGINE")"
ssh "$HOST" "$REMOTE"
