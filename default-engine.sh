#!/usr/bin/env bash
set -euo pipefail

# Laptop-side operator helper. The autonomous pipeline's persistent
# EPIC_ENGINE environment value lives in the VM's installed cron file. With no
# argument, read that value and list the engines in the VM checkout. With one
# argument, validate it there, replace only that line, and verify the readback.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/etc/lib.sh"

HOST="${SSH_HOST:-}"
if [[ -z "$HOST" ]]; then
  echo "SSH_HOST is not set — add it to etc/repos.conf" >&2
  exit 1
fi

usage() {
  echo "Usage: $(basename "$0") [engine]"
}

case "$#" in
  0) mode="show"; requested="" ;;
  1)
    case "$1" in
      -h|--help) usage; exit 0 ;;
    esac
    mode="set"
    requested="$1"
    ;;
  *) usage >&2; exit 1 ;;
esac

# Override only for hermetic tests. Real runs always edit the installed cron
# file, not the tracked deployment source in this checkout.
cron_file="${DEFAULT_ENGINE_CRON:-/etc/cron.d/harness-dispatch}"

ssh "$HOST" bash -s -- "$cron_file" "$HOST_CONTROL_DIR/etc/engines.json" "$mode" "$requested" <<'REMOTE'
set -euo pipefail

cron_file="$1"
engines_file="$2"
mode="$3"
requested="${4:-}"

if [[ ! -r "$engines_file" ]] || ! jq -e 'type == "object" and length > 0' "$engines_file" >/dev/null 2>&1; then
  echo "engines file is missing or invalid: $engines_file" >&2
  exit 1
fi
if [[ ! -r "$cron_file" ]]; then
  echo "installed cron file is missing or unreadable: $cron_file" >&2
  exit 1
fi

available="$(jq -r 'keys[]' "$engines_file" | paste -sd ' ' -)"

read_default() {
  local count
  count="$(awk '/^EPIC_ENGINE=/{n++} END{print n+0}' "$cron_file")"
  if [[ "$count" != "1" ]]; then
    echo "installed cron file must contain exactly one EPIC_ENGINE line, found $count: $cron_file" >&2
    return 1
  fi
  awk '/^EPIC_ENGINE=/{sub(/^EPIC_ENGINE=/, ""); print}' "$cron_file"
}

current="$(read_default)"
if ! jq -e --arg engine "$current" 'has($engine)' "$engines_file" >/dev/null 2>&1; then
  printf 'default: %s\navailable: %s\n' "$current" "$available"
  echo "configured default is not an available engine: $current" >&2
  exit 1
fi

if [[ "$mode" == "show" ]]; then
  printf 'default: %s\navailable: %s\n' "$current" "$available"
  exit 0
fi
if [[ ! "$requested" =~ ^[a-z0-9][a-z0-9+-]*$ ]] || \
   ! jq -e --arg engine "$requested" 'has($engine)' "$engines_file" >/dev/null 2>&1; then
  echo "unknown engine '$requested' (available: $available)" >&2
  exit 1
fi
if [[ "$requested" == "$current" ]]; then
  echo "default: $requested (unchanged)"
  exit 0
fi

tmp="$(mktemp "${TMPDIR:-/tmp}/toliki-default-engine.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
awk -v engine="$requested" '
  /^EPIC_ENGINE=/ { print "EPIC_ENGINE=" engine; next }
  { print }
' "$cron_file" > "$tmp"

if [[ -w "$cron_file" ]]; then
  install -m 0644 "$tmp" "$cron_file"
else
  sudo install -m 0644 "$tmp" "$cron_file"
fi

current="$(read_default)"
if [[ "$current" != "$requested" ]]; then
  echo "default engine readback failed: wanted '$requested', found '$current'" >&2
  exit 1
fi
echo "default: $current"
REMOTE
