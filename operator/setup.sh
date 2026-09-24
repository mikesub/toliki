#!/usr/bin/env bash
set -euo pipefail

# `./toliki setup` — laptop-side setup: exposes the local epic skills
# (t-spec … t-ship) to Claude Code and Codex. While there is no host, the
# GitHub-filing /spec, spec-explorer and the host registry are parked: setup
# neither wires nor seeds them. The VM-side Claude equivalent is inside
# bin/provision.sh (which also rebuilds the box).
#
# The one operator command that deliberately does NOT source operator/lib.sh:
# that file loads etc/repos.conf, and local setup needs no registry.
#
# Idempotent: re-run any time; a healthy machine reports zero changes and
# exits 0. Refuses rather than clobbers: anything at a target path that isn't
# ours is reported as a manual step and left alone.
#
# Each skill is an individual link so content from other sources can coexist.
# Pipeline entry points and charters stay private to the harness: host scripts
# launch pipelines, and the engine reads its charters directly from this
# checkout.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: ./toliki setup

Prepares this laptop to drive the harness. Idempotent — re-run it any time.

  - checks for the claude and codex CLIs and node
  - links the local epic skills (t-spec, t-architect, t-code, t-review,
    t-ship) into ~/.claude/skills and ~/.agents/skills
  - prunes links an older setup made for the parked /spec and spec-explorer

It does not touch etc/repos.conf or the host while there is no host.

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
if command -v node >/dev/null 2>&1; then
  ok "node $(node --version 2>/dev/null || echo '?')"
else
  warn "node not found on PATH — the local epic skills run their helper with node"
fi

# ---------------------------------------------------------- ~/.claude wiring --

say "~/.claude wiring"
wire_claude_content "$ROOT"

# ----------------------------------------------------------- ~/.agents wiring --

say "Codex wiring"
wire_codex_content "$ROOT"

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
