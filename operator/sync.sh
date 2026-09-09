#!/usr/bin/env bash
set -euo pipefail

# `./toliki sync` — brings this checkout and the host's to the same published
# commit, and nothing else. It pulls; it does not provision, restart cron,
# or touch any running session. Both destinations come from the machine-local
# registry (SSH_HOST, HOST_CONTROL_DIR), so a second laptop or a rebuilt host
# needs no edit here.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  cat <<EOF
Usage: $CLI sync

Pull and rebase this laptop's checkout, then the host's checkout at
$HOST_CONTROL_DIR on \$SSH_HOST. Changes nothing else: a host that needs new
packages or a reinstalled cron still wants bin/provision.sh, run there.
EOF
}

case "${1:-}" in
  "") ;;
  -h|--help) usage; exit 0 ;;
  *)
    warn "'$CLI sync' takes no arguments, got '$1'"
    usage >&2
    exit 1
    ;;
esac

require_ssh_host

say "pulling $TOLIKI_ROOT"
git -C "$TOLIKI_ROOT" pull --rebase

say "pulling $HOST_CONTROL_DIR on $HOST"
ssh "$HOST" "git -C $(sq "$HOST_CONTROL_DIR") pull --rebase"
