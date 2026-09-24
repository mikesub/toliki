#!/usr/bin/env bash

# Publish only Toliki's local epic skills (t-spec … t-ship) into Claude Code.
# The GitHub-filing /spec and spec-explorer are parked while there is no host,
# and pipeline sessions load their charters directly from agents/, so links this
# checkout published for any of them earlier are pruned.
#
# Sourced by operator/setup.sh and bin/provision.sh. The caller provides the reporting
# functions used below: ok, changed, and blocked.

source "$(dirname "${BASH_SOURCE[0]}")/wire-local-skills.sh"

wire_claude_content() {
  local harness_dir="$1"
  local skills="$HOME/.claude/skills" agents="$HOME/.claude/agents" dest

  mkdir -p "$HOME/.claude"

  # Convert the legacy whole-directory link only when it belongs to this
  # checkout (or is dangling). It cannot contain user-owned entries.
  if [[ -L "$skills" ]]; then
    if [[ "$(readlink "$skills")" == "$harness_dir/skills" || ! -e "$skills" ]]; then
      rm "$skills"
      mkdir -p "$skills"
      changed "converted ~/.claude/skills from a whole-directory symlink to a real directory (selected links below)"
    else
      blocked "~/.claude/skills is a symlink to $(readlink "$skills"), which isn't this checkout — resolve by hand"
    fi
  elif [[ ! -e "$skills" ]]; then
    mkdir -p "$skills"
    changed "created ~/.claude/skills"
  elif [[ ! -d "$skills" ]]; then
    blocked "~/.claude/skills exists and isn't a directory — resolve by hand"
  fi
  if [[ -d "$skills" && ! -L "$skills" ]]; then
    wire_local_skills "$harness_dir" "$skills" "~/.claude/skills"
  fi

  # No agents are published. Retire only this checkout's old links.
  if [[ -L "$agents" ]]; then
    if [[ "$(readlink "$agents")" == "$harness_dir/agents" || ! -e "$agents" ]]; then
      rm "$agents"
      changed "removed the whole-directory link ~/.claude/agents into this checkout"
    fi
  elif [[ -d "$agents" ]]; then
    for dest in "$agents"/*; do
      [[ -L "$dest" && "$(readlink "$dest")" == "$harness_dir/agents/"* ]] || continue
      rm "$dest"
      changed "pruned unpublished link ~/.claude/agents/$(basename "$dest")"
    done
  fi
}
