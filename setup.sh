#!/usr/bin/env bash
set -euo pipefail

# `./setup.sh` — releases the local epic skills (skills/epic/t-*) into Claude
# Code's and Codex's user skill directories as self-contained copies of this
# checkout's committed HEAD. Uncommitted work is never installed, so the repo
# can be developed freely and released by committing and re-running setup.
#
# Each installed skill directory carries a marker naming its source commit.
# Setup overwrites only directories carrying that marker, and removes marked
# copies of skills HEAD no longer has; anything else at a target path is
# reported as a manual step and left alone. Idempotent: a current machine
# reports no changes and exits 0.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER=".toliki-install"

usage() {
  cat <<'EOF'
Usage: ./setup.sh

Installs the local epic skills (t-spec, t-architect, t-code, t-review, t-ship)
from this checkout's committed HEAD into ~/.claude/skills (Claude Code) and
~/.agents/skills (Codex), as copies. Uncommitted changes are not installed:
commit, then re-run to release. Removes copies of skills that no longer exist.

It reports what it changed and the steps only you can do; it exits non-zero
while any of those steps is left.
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

CHANGES=()
BLOCKERS=()

say()     { printf '\n[setup] %s\n' "$*"; }
ok()      { printf '  ok       %s\n' "$*"; }
warn()    { printf '  warn     %s\n' "$*"; }
changed() { printf '  CHANGED  %s\n' "$*"; CHANGES+=("$*"); }
blocked() { printf '  BLOCKED  %s\n' "$*"; BLOCKERS+=("$*"); }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/toliki-setup.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

ours() { # dir
  [[ -d "$1" && ! -L "$1" && -f "$1/$MARKER" ]]
}

say "prerequisites"
for cli in claude codex; do
  if command -v "$cli" >/dev/null 2>&1; then
    ok "$cli found"
  else
    warn "$cli CLI not found on PATH — its skills are installed anyway"
  fi
done

say "release"
if ! COMMIT="$(git -C "$ROOT" rev-parse --verify -q HEAD)"; then
  blocked "$ROOT has no committed HEAD to install from"
  exit 1
fi
ok "installing from $(git -C "$ROOT" log -1 --format='%h %s' HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all -- skills/epic)" ]]; then
  warn "uncommitted changes under skills/epic are not installed — commit them to release"
fi

# Export HEAD's skills, then resolve each skill's link to the shared contract
# into a self-contained copy carrying the marker.
mkdir -p "$STAGE/head" "$STAGE/skills"
git -C "$ROOT" archive --format=tar HEAD -- skills/epic | tar -x -C "$STAGE/head"
PUBLISHED=" "
for item in "$STAGE/head/skills/epic"/t-*; do
  [[ -f "$item/SKILL.md" ]] || continue
  name="$(basename "$item")"
  PUBLISHED="$PUBLISHED$name "
  cp -RL "$item" "$STAGE/skills/$name"
  printf 'source=%s\ncommit=%s\n' "$ROOT" "$COMMIT" > "$STAGE/skills/$name/$MARKER"
done
if [[ "$PUBLISHED" == " " ]]; then
  blocked "HEAD has no skills/epic/t-* skills — is this a complete checkout?"
  exit 1
fi

install_skills() { # skill dir, label
  local skill_dir="$1" label="$2" staged name dest fresh=""

  if [[ ! -e "$skill_dir" ]]; then
    mkdir -p "$skill_dir"
    changed "created $label"
  elif [[ ! -d "$skill_dir" ]]; then
    blocked "$label exists and isn't a directory — resolve by hand"
    return
  fi

  for staged in "$STAGE/skills"/*; do
    name="$(basename "$staged")"
    dest="$skill_dir/$name"
    if [[ ! -e "$dest" && ! -L "$dest" ]]; then
      cp -R "$staged" "$dest"
      changed "installed $label/$name"
    elif ! ours "$dest"; then
      blocked "$label/$name exists and wasn't installed by this setup — remove it by hand, then re-run"
    elif diff -r -x "$MARKER" "$staged" "$dest" >/dev/null 2>&1; then
      cp "$staged/$MARKER" "$dest/$MARKER"
      fresh="${fresh:+$fresh }$name"
    else
      rm -rf "$dest"
      cp -R "$staged" "$dest"
      changed "updated $label/$name to $(git -C "$ROOT" rev-parse --short "$COMMIT")"
    fi
  done
  [[ -z "$fresh" ]] || ok "$label up to date: $fresh"

  for dest in "$skill_dir"/*; do
    name="$(basename "$dest")"
    [[ "$PUBLISHED" != *" $name "* ]] && ours "$dest" || continue
    rm -rf "$dest"
    changed "removed $label/$name, which this checkout no longer has"
  done
}

say "Claude Code"
install_skills "$HOME/.claude/skills" "~/.claude/skills"

say "Codex"
install_skills "$HOME/.agents/skills" "~/.agents/skills"

say "summary"
if [[ ${#CHANGES[@]} -eq 0 ]]; then
  ok "nothing changed — already up to date"
else
  printf '  %d change(s); start a fresh agent session to pick them up.\n' "${#CHANGES[@]}"
fi

if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
  printf '\n  %d step(s) left, none of which this script can do for you:\n' "${#BLOCKERS[@]}"
  for b in "${BLOCKERS[@]}"; do printf '    - %s\n' "$b"; done
  printf '\n  Do those, then re-run ./setup.sh.\n'
  exit 1
fi
