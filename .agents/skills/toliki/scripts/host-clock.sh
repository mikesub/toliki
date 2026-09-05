#!/usr/bin/env bash
set -euo pipefail

# Laptop-side route discovery plus host-side clock lookup/conversion. The two
# registries are deliberately loaded by processes on the machines they govern.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
source "$ROOT/etc/lib.sh"

REMOTE_LIB="$(sq "$HOST_CONTROL_DIR/etc/lib.sh")"
case "$#" in
  0)
    printf '%s\n' "SSH_HOST=$SSH_HOST" "HOST_CONTROL_DIR=$HOST_CONTROL_DIR" "${REPO_ORIGINS[@]}"
    REMOTE="source $REMOTE_LIB && printf '%s\\n' \"HOST_TIMEZONE=\$HOST_TIMEZONE\""
    ;;
  2)
    if [[ "$1" != "--human-ts" || -z "$2" ]]; then
      echo "usage: $0 [--human-ts <UTC-instant>]" >&2
      exit 2
    fi
    REMOTE="source $REMOTE_LIB && human_ts $(sq "$2")"
    ;;
  *)
    echo "usage: $0 [--human-ts <UTC-instant>]" >&2
    exit 2
    ;;
esac

ssh "$SSH_HOST" "$REMOTE"
