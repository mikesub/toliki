#!/usr/bin/env bash

# Link Toliki's local epic skills into Codex's user-level skill directory. The
# GitHub-filing /spec and its spec-explorer role are parked while there is no
# host: links this checkout published for them are pruned. A spec-explorer role
# an older setup registered in ~/.codex/config.toml is left for the user; its
# charter still exists, so it stays harmless.
#
# Sourced by operator/setup.sh. The caller provides ok, changed, and blocked.

source "$(dirname "${BASH_SOURCE[0]}")/wire-local-skills.sh"

wire_codex_content() {
  local harness_dir="$1"
  local link_dir="$HOME/.agents/skills" name dest

  mkdir -p "$HOME/.agents"

  # Toliki has never owned the whole user skill directory. Refuse a directory
  # symlink rather than following it and changing another source's tree.
  if [[ -L "$link_dir" ]]; then
    blocked "~/.agents/skills is a symlink to $(readlink "$link_dir") — resolve by hand"
    return
  elif [[ ! -e "$link_dir" ]]; then
    mkdir -p "$link_dir"
    changed "created ~/.agents/skills"
  elif [[ ! -d "$link_dir" ]]; then
    blocked "~/.agents/skills exists and isn't a directory — resolve by hand"
    return
  fi
  wire_local_skills "$harness_dir" "$link_dir" "~/.agents/skills"

  # Older setups linked Codex roles from this checkout; retire only those.
  for name in explorer.toml spec-explorer.toml; do
    dest="$HOME/.codex/agents/$name"
    [[ -L "$dest" && "$(readlink "$dest")" == "$harness_dir/agents/"* ]] || continue
    rm "$dest"
    changed "pruned unpublished link ~/.codex/agents/$name"
  done
}
