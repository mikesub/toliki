#!/usr/bin/env bash
set -euo pipefail

# Laptop-side operator helper. Reports the VM's installed default engine and
# host-wide pipeline slot budget. Optional flags validate, update, and read back
# either setting at its source of truth: EPIC_ENGINE in the installed cron file
# and MAX_PARALLEL_EPICS in the host checkout's machine-local repos.conf.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/etc/lib.sh"

HOST="${SSH_HOST:-}"
if [[ -z "$HOST" ]]; then
  echo "SSH_HOST is not set — add it to etc/repos.conf" >&2
  exit 1
fi

usage() {
  local name
  name="$(basename "$0")"
  printf '%s\n' \
    "Usage:" \
    "  $name" \
    "  $name --engine <name>" \
    "  $name --max <count>" \
    "  $name --engine <name> --max <count>"
}

show_usage=0
if [[ $# -eq 0 ]]; then show_usage=1; fi
requested_engine=""
requested_max=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --engine)
      [[ $# -ge 2 ]] || { usage >&2; exit 1; }
      requested_engine="$2"
      shift 2
      ;;
    --max)
      [[ $# -ge 2 ]] || { usage >&2; exit 1; }
      requested_max="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 1
      ;;
  esac
done

# Overrides are only for hermetic tests. Real runs edit the installed cron and
# the machine-local registry in the VM checkout, never either tracked template.
cron_file="${DEFAULT_ENGINE_CRON:-/etc/cron.d/harness-dispatch}"
repos_file="${CONFIG_REPOS_FILE:-$HOST_CONTROL_DIR/etc/repos.conf}"
remote_engine="${requested_engine:-__UNCHANGED__}"
remote_max="${requested_max:-__UNCHANGED__}"

ssh "$HOST" bash -s -- \
  "$cron_file" "$repos_file" "$HOST_CONTROL_DIR/etc/engines.json" \
  "$remote_engine" "$remote_max" <<'REMOTE'
set -euo pipefail

cron_file="$1"
repos_file="$2"
engines_file="$3"
requested_engine="${4:-__UNCHANGED__}"
requested_max="${5:-__UNCHANGED__}"
if [[ "$requested_engine" == "__UNCHANGED__" ]]; then requested_engine=""; fi
if [[ "$requested_max" == "__UNCHANGED__" ]]; then requested_max=""; fi

if [[ ! -r "$engines_file" ]] || ! jq -e 'type == "object" and length > 0' "$engines_file" >/dev/null 2>&1; then
  echo "engines file is missing or invalid: $engines_file" >&2
  exit 1
fi
if [[ ! -r "$cron_file" ]]; then
  echo "installed cron file is missing or unreadable: $cron_file" >&2
  exit 1
fi
if [[ ! -r "$repos_file" ]]; then
  echo "host registry is missing or unreadable: $repos_file" >&2
  exit 1
fi

available="$(jq -r 'keys[]' "$engines_file" | paste -sd ' ' -)"

read_engine() {
  local count
  count="$(awk '/^EPIC_ENGINE=/{n++} END{print n+0}' "$cron_file")"
  if [[ "$count" != "1" ]]; then
    echo "installed cron file must contain exactly one EPIC_ENGINE line, found $count: $cron_file" >&2
    return 1
  fi
  awk '/^EPIC_ENGINE=/{sub(/^EPIC_ENGINE=/, ""); print}' "$cron_file"
}

read_max() {
  local count value
  count="$(awk '/^MAX_PARALLEL_EPICS=/{n++} END{print n+0}' "$repos_file")"
  if [[ "$count" != "1" ]]; then
    echo "host registry must contain exactly one MAX_PARALLEL_EPICS line, found $count: $repos_file" >&2
    return 1
  fi
  value="$(awk '/^MAX_PARALLEL_EPICS=/{sub(/^MAX_PARALLEL_EPICS=/, ""); print}' "$repos_file")"
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "configured max concurrent runs must be a positive integer, got '$value'" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

current_engine="$(read_engine)"
current_max="$(read_max)"
if ! jq -e --arg engine "$current_engine" 'has($engine)' "$engines_file" >/dev/null 2>&1; then
  printf 'default: %s\navailable: %s\nmax concurrent runs: %s\n' "$current_engine" "$available" "$current_max"
  echo "configured default is not an available engine: $current_engine" >&2
  exit 1
fi

if [[ -n "$requested_engine" ]] && { [[ ! "$requested_engine" =~ ^[a-z0-9][a-z0-9+-]*$ ]] || \
   ! jq -e --arg engine "$requested_engine" 'has($engine)' "$engines_file" >/dev/null 2>&1; }; then
  echo "unknown engine '$requested_engine' (available: $available)" >&2
  exit 1
fi
if [[ -n "$requested_max" && ! "$requested_max" =~ ^[1-9][0-9]*$ ]]; then
  echo "max concurrent runs must be a positive integer, got '$requested_max'" >&2
  exit 1
fi

tmp_engine=""
tmp_max=""
trap '[[ -z "$tmp_engine" ]] || rm -f "$tmp_engine"; [[ -z "$tmp_max" ]] || rm -f "$tmp_max"' EXIT

install_config() {
  local source="$1" target="$2"
  if [[ -w "$target" ]]; then
    install -m 0644 "$source" "$target"
  else
    sudo install -m 0644 "$source" "$target"
  fi
}

if [[ -n "$requested_engine" && "$requested_engine" != "$current_engine" ]]; then
  tmp_engine="$(mktemp "${TMPDIR:-/tmp}/toliki-config-engine.XXXXXX")"
  awk -v engine="$requested_engine" '
    /^EPIC_ENGINE=/ { print "EPIC_ENGINE=" engine; next }
    { print }
  ' "$cron_file" > "$tmp_engine"
  install_config "$tmp_engine" "$cron_file"
fi

if [[ -n "$requested_max" && "$requested_max" != "$current_max" ]]; then
  tmp_max="$(mktemp "${TMPDIR:-/tmp}/toliki-config-capacity.XXXXXX")"
  awk -v max="$requested_max" '
    /^MAX_PARALLEL_EPICS=/ { print "MAX_PARALLEL_EPICS=" max; next }
    { print }
  ' "$repos_file" > "$tmp_max"
  install_config "$tmp_max" "$repos_file"
fi

current_engine="$(read_engine)"
current_max="$(read_max)"
if [[ -n "$requested_engine" && "$current_engine" != "$requested_engine" ]]; then
  echo "default engine readback failed: wanted '$requested_engine', found '$current_engine'" >&2
  exit 1
fi
if [[ -n "$requested_max" && "$current_max" != "$requested_max" ]]; then
  echo "max concurrent runs readback failed: wanted '$requested_max', found '$current_max'" >&2
  exit 1
fi

printf 'default: %s\navailable: %s\nmax concurrent runs: %s\n' "$current_engine" "$available" "$current_max"
REMOTE

if (( show_usage )); then
  usage
fi
