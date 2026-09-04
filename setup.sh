#!/usr/bin/env bash
set -euo pipefail

# Laptop-side setup: exposes /spec and its spec-explorer agent to Claude and Codex,
# then seeds the machine-local registry. The VM-side Claude equivalent is
# inside bin/provision.sh (which also rebuilds the whole box).
#
# Idempotent: re-run any time; a healthy machine reports zero changes and
# exits 0. Refuses rather than clobbers: anything at a target path that isn't
# ours is reported as a manual step and left alone.
#
# The two selected items are linked into real directories so user-level
# content from other sources can coexist. Pipeline skills and charters stay
# private to the harness: host scripts launch pipelines, and the engine reads
# its charters directly from this checkout.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/etc/wire-claude-content.sh"
source "$HERE/etc/wire-codex-content.sh"

CHANGES=()
WARNINGS=()
BLOCKERS=()

say()     { printf '\n[setup] %s\n' "$*"; }
ok()      { printf '  ok       %s\n' "$*"; }
changed() { printf '  CHANGED  %s\n' "$*"; CHANGES+=("$*"); }
warn()    { printf '  warn     %s\n' "$*"; WARNINGS+=("$*"); }
blocked() { printf '  BLOCKED  %s\n' "$*"; BLOCKERS+=("$*"); }
note()    { printf '           %s\n' "$*"; }

# ---------------------------------------------------------- prerequisites --

say "prerequisites"
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -n1 || echo '?')"
else
  warn "claude CLI not found on PATH — install it before using the harness"
fi
if command -v codex >/dev/null 2>&1; then
  ok "codex $(codex --version 2>/dev/null | head -n1 || echo '?')"
else
  warn "codex CLI not found on PATH — install it before using the harness"
fi
if gh auth status >/dev/null 2>&1; then
  ok "gh authenticated"
else
  warn "gh is not authenticated — /spec files issues via gh; run: gh auth login"
fi

# ------------------------------------------- machine-local registry (conf) --

say "machine-local registry (etc/repos.conf)"
CONF="$HERE/etc/repos.conf"
if [[ ! -f "$CONF" ]]; then
  cp "$HERE/etc/repos.conf.template" "$CONF"
  changed "seeded etc/repos.conf from etc/repos.conf.template"
fi
# The template's placeholder registry parses fine but launches nothing real;
# treat it as "not configured yet" rather than as done.
if grep -q "myapp=" "$CONF"; then
  blocked "etc/repos.conf still carries the template placeholders — edit it (your repos, origins, SSH_HOST)"
else
  ok "etc/repos.conf configured"
fi

# ---------------------------------------------------------- ~/.claude wiring --

say "~/.claude wiring"
wire_claude_content "$HERE"

# ----------------------------------------------------------- ~/.agents wiring --

say "Codex wiring"
wire_codex_content "$HERE"

# -------------------------------------------------------------------- ssh --

say "ssh"
# Informational only: remote-control.sh dials SSH_HOST from etc/repos.conf,
# and whether it resolves is a fact about ~/.ssh/config this script shouldn't
# try to manage.
if [[ -f "$CONF" ]] && SSH_HOST="$(bash -c 'source "$1"; printf "%s" "${SSH_HOST:-}"' _ "$CONF" 2>/dev/null)" && [[ -n "$SSH_HOST" ]]; then
  note "remote-control.sh will ssh to '$SSH_HOST' — make sure it resolves (e.g. a Host block in ~/.ssh/config)"
else
  note "SSH_HOST not set yet; remote-control.sh needs it (see etc/repos.conf.template)"
fi

# ---------------------------------------------------------------- summary --

say "summary"
if [[ ${#CHANGES[@]} -eq 0 ]]; then
  ok "nothing changed — laptop was already set up"
else
  printf '  %d change(s):\n' "${#CHANGES[@]}"
  for c in "${CHANGES[@]}"; do printf '    - %s\n' "$c"; done
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  printf '  %d warning(s):\n' "${#WARNINGS[@]}"
  for w in "${WARNINGS[@]}"; do printf '    - %s\n' "$w"; done
fi

if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
  printf '\n  %d step(s) left, none of which this script can do for you:\n' "${#BLOCKERS[@]}"
  for b in "${BLOCKERS[@]}"; do printf '    - %s\n' "$b"; done
  printf '\n  Do those, then re-run this script — it will pick up where it left off.\n'
  exit 1
fi
