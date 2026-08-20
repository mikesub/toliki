#!/usr/bin/env bash
set -euo pipefail

# Laptop-side setup: wires this checkout into ~/.claude so the shared skills
# and agents are discovered as user-level content, seeds the machine-local
# registry, and sets CLAUDE_HARNESS_DIR. The VM-side equivalent is inside
# bin/provision.sh (which also rebuilds the whole box); keep the two wiring
# steps' semantics in sync.
#
# Idempotent: re-run any time; a healthy machine reports zero changes and
# exits 0. Refuses rather than clobbers: anything at a target path that isn't
# ours is reported as a manual step and left alone.
#
# Skills and agents are linked PER ITEM into real directories — deliberately
# not one symlink per directory, so your own user-level skills/agents can live
# beside the harness-supplied ones (a whole-directory symlink would make this
# repo the only possible source). A legacy whole-directory symlink from the
# old scheme is converted in place.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
if command -v jq >/dev/null 2>&1; then
  ok "jq present"
else
  blocked "jq is required (settings.json surgery) — brew install jq"
fi
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -n1 || echo '?')"
else
  warn "claude CLI not found on PATH — install it before using the harness"
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
mkdir -p "$HOME/.claude"

for d in skills agents; do
  link_dir="$HOME/.claude/$d"
  src_dir="$HERE/$d"
  if [[ ! -d "$src_dir" ]]; then
    blocked "$src_dir doesn't exist — is this a complete checkout?"
    continue
  fi

  # Legacy scheme: the whole directory was one symlink into this repo. Convert
  # it — the symlink held nothing of the user's, so nothing is lost.
  if [[ -L "$link_dir" ]]; then
    if [[ "$(readlink "$link_dir")" == "$src_dir" || ! -e "$link_dir" ]]; then
      # Ours, or dangling (the checkout moved out from under it) — either way
      # it holds nothing of the user's; convert it.
      rm "$link_dir"
      mkdir -p "$link_dir"
      changed "converted ~/.claude/$d from a whole-directory symlink to a real directory (per-item links below)"
    else
      blocked "~/.claude/$d is a symlink to $(readlink "$link_dir"), which isn't this checkout — resolve by hand"
      continue
    fi
  elif [[ ! -e "$link_dir" ]]; then
    mkdir -p "$link_dir"
    changed "created ~/.claude/$d"
  elif [[ ! -d "$link_dir" ]]; then
    blocked "~/.claude/$d exists and isn't a directory — resolve by hand"
    continue
  fi

  # Link every item this repo supplies; anything else in the directory is the
  # user's own and is never touched.
  linked=()
  for item in "$src_dir"/*; do
    name="$(basename "$item")"
    dest="$link_dir/$name"
    if [[ -L "$dest" && "$(readlink "$dest")" == "$item" ]]; then
      linked+=("$name")
    elif [[ -L "$dest" && ! -e "$dest" ]]; then
      # A dangling link serves nothing and shadows nothing — typically left
      # behind when this checkout was moved or renamed. Replace it.
      old_target="$(readlink "$dest")"
      rm "$dest"
      ln -s "$item" "$dest"
      changed "replaced dangling link ~/.claude/$d/$name (was $old_target) -> $item"
      linked+=("$name")
    elif [[ -e "$dest" || -L "$dest" ]]; then
      blocked "~/.claude/$d/$name exists and isn't a link into this checkout — it would shadow the harness copy; resolve by hand"
    else
      ln -s "$item" "$dest"
      changed "linked ~/.claude/$d/$name -> $item"
      linked+=("$name")
    fi
  done
  [[ ${#linked[@]} -eq 0 ]] || ok "$d: ${linked[*]}"

  # Prune only what is ours: dangling symlinks into this repo, left behind
  # when a skill/agent is renamed or removed.
  for dest in "$link_dir"/*; do
    [[ -L "$dest" ]] || continue
    target="$(readlink "$dest")"
    if [[ "$target" == "$src_dir/"* && ! -e "$dest" ]]; then
      rm "$dest"
      changed "pruned stale link ~/.claude/$d/$(basename "$dest") (target gone from the repo)"
    fi
  done
done

# ------------------------------------------------------ CLAUDE_HARNESS_DIR --

# The /epic and /fix-conflict skills resolve workflows/*-run.mjs through this;
# it's the one settings value that differs per machine. Merged with jq into
# whatever settings.json already holds — never rewritten wholesale.
say "CLAUDE_HARNESS_DIR"
SETTINGS="$HOME/.claude/settings.json"
if [[ ! -f "$SETTINGS" ]]; then
  printf '{}\n' > "$SETTINGS"
  changed "created empty $SETTINGS"
fi
if ! jq -e . "$SETTINGS" >/dev/null 2>&1; then
  blocked "$SETTINGS is not valid JSON — fix it by hand, then re-run"
else
  CURRENT="$(jq -r '.env.CLAUDE_HARNESS_DIR // ""' "$SETTINGS")"
  if [[ "$CURRENT" == "$HERE" ]]; then
    ok "CLAUDE_HARNESS_DIR=$HERE"
  else
    TMP_SETTINGS="$(mktemp "$HOME/.claude/settings.json.XXXXXX")"
    jq --arg d "$HERE" '.env = ((.env // {}) + {CLAUDE_HARNESS_DIR: $d})' \
      "$SETTINGS" > "$TMP_SETTINGS"
    mv "$TMP_SETTINGS" "$SETTINGS"
    if [[ -n "$CURRENT" ]]; then
      changed "CLAUDE_HARNESS_DIR: $CURRENT -> $HERE (other keys untouched)"
    else
      changed "set CLAUDE_HARNESS_DIR=$HERE (other keys untouched)"
    fi
  fi
fi

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
