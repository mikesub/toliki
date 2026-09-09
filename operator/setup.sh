#!/usr/bin/env bash
set -euo pipefail

# `./toliki setup` — laptop-side setup: seeds the machine-local registry and
# exposes /spec and spec-explorer to Claude and Codex. Codex's role uses the
# real charter path because its loader rejects a final symlink. The VM-side
# Claude equivalent is inside bin/provision.sh (which also rebuilds the box).
#
# The one operator command that deliberately does NOT source operator/lib.sh:
# that file loads etc/repos.conf, and seeding etc/repos.conf is this script's
# job. It must run on a laptop that has no registry yet.
#
# Idempotent: re-run any time; a healthy machine reports zero changes and
# exits 0. Refuses rather than clobbers: anything at a target path that isn't
# ours is reported as a manual step and left alone.
#
# Selected Claude content and the Codex skill use individual links so content
# from other sources can coexist; Codex's role points at the shared charter
# through its user configuration. Pipeline entry points and charters stay
# private to the harness: host scripts launch pipelines, and the engine reads
# its charters directly from this checkout.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: ./toliki setup

Prepares this laptop to drive the harness. Idempotent — re-run it any time.

  - checks for the claude and codex CLIs and gh authentication
  - seeds etc/repos.conf from etc/repos.conf.template (machine-local, never
    tracked) and reports whether it still holds the template placeholders
  - exposes /spec and spec-explorer to Claude and to Codex
  - reports the SSH_HOST every other ./toliki command dials

It reports what it changed, what it warns about, and the steps only you can do;
it exits non-zero while any of those steps is left.
EOF
}

case "${1:-}" in
  "") ;;
  -h|--help) usage; exit 0 ;;
  *)
    echo "[setup] setup takes no arguments, got '$1'" >&2
    usage >&2
    exit 1
    ;;
esac

source "$ROOT/etc/wire-claude-content.sh"
source "$ROOT/etc/wire-codex-content.sh"

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
CONF="$ROOT/etc/repos.conf"
if [[ ! -f "$CONF" ]]; then
  cp "$ROOT/etc/repos.conf.template" "$CONF"
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
wire_claude_content "$ROOT"

# ----------------------------------------------------------- ~/.agents wiring --

say "Codex wiring"
wire_codex_content "$ROOT"

# -------------------------------------------------------------------- ssh --

say "ssh"
# Informational only: the ./toliki commands dial SSH_HOST from etc/repos.conf,
# and whether it resolves is a fact about ~/.ssh/config this script shouldn't
# try to manage.
if [[ -f "$CONF" ]] && SSH_HOST="$(bash -c 'source "$1"; printf "%s" "${SSH_HOST:-}"' _ "$CONF" 2>/dev/null)" && [[ -n "$SSH_HOST" ]]; then
  note "./toliki will ssh to '$SSH_HOST' — make sure it resolves (e.g. a Host block in ~/.ssh/config)"
else
  note "SSH_HOST not set yet; every ./toliki command but setup needs it (see etc/repos.conf.template)"
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
  printf '\n  Do those, then re-run ./toliki setup — it will pick up where it left off.\n'
  exit 1
fi
