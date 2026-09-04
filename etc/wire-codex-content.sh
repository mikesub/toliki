#!/usr/bin/env bash

# Publish Toliki's interactive human gate into the user-level Codex skill
# directory and its read-only spec-explorer charter into Codex's custom-agent
# directory. Both are symlinked so this checkout remains the source of truth.
#
# Sourced by setup.sh. The caller provides ok, changed, and blocked.

wire_codex_content() {
  local harness_dir="$1"
  local link_dir="$HOME/.agents/skills"
  local item="$harness_dir/skills/spec"
  local dest="$link_dir/spec"
  local agent_dir="$HOME/.codex/agents"
  local agent_item="$harness_dir/agents/spec-explorer.toml"
  local agent_dest="$agent_dir/spec-explorer.toml"
  local legacy_agent_dest="$agent_dir/explorer.toml"
  local old_target agent_linked=0

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

  if [[ ! -e "$item" ]]; then
    blocked "$item doesn't exist — is this a complete checkout?"
  elif [[ -L "$dest" && "$(readlink "$dest")" == "$item" ]]; then
    ok "skills: spec"
  elif [[ -L "$dest" && ! -e "$dest" ]]; then
    old_target="$(readlink "$dest")"
    rm "$dest"
    ln -s "$item" "$dest"
    changed "replaced dangling link ~/.agents/skills/spec (was $old_target) -> $item"
    ok "skills: spec"
  elif [[ -e "$dest" || -L "$dest" ]]; then
    blocked "~/.agents/skills/spec exists and isn't a link into this checkout — it would shadow the harness copy; resolve by hand"
  else
    ln -s "$item" "$dest"
    changed "linked ~/.agents/skills/spec -> $item"
    ok "skills: spec"
  fi

  mkdir -p "$HOME/.codex"
  if [[ -L "$agent_dir" ]]; then
    blocked "~/.codex/agents is a symlink to $(readlink "$agent_dir") — resolve by hand"
    return
  elif [[ ! -e "$agent_dir" ]]; then
    mkdir -p "$agent_dir"
    changed "created ~/.codex/agents"
  elif [[ ! -d "$agent_dir" ]]; then
    blocked "~/.codex/agents exists and isn't a directory — resolve by hand"
    return
  fi

  if [[ ! -e "$agent_item" ]]; then
    blocked "$agent_item doesn't exist — is this a complete checkout?"
  elif [[ -L "$agent_dest" && "$(readlink "$agent_dest")" == "$agent_item" ]]; then
    ok "agents: spec-explorer"
    agent_linked=1
  elif [[ -L "$agent_dest" && ! -e "$agent_dest" ]]; then
    old_target="$(readlink "$agent_dest")"
    rm "$agent_dest"
    ln -s "$agent_item" "$agent_dest"
    changed "replaced dangling link ~/.codex/agents/spec-explorer.toml (was $old_target) -> $agent_item"
    ok "agents: spec-explorer"
    agent_linked=1
  elif [[ -e "$agent_dest" || -L "$agent_dest" ]]; then
    blocked "~/.codex/agents/spec-explorer.toml exists and isn't a link into this checkout — it would shadow the harness copy; resolve by hand"
  else
    ln -s "$agent_item" "$agent_dest"
    changed "linked ~/.codex/agents/spec-explorer.toml -> $agent_item"
    ok "agents: spec-explorer"
    agent_linked=1
  fi

  # explorer is a Codex built-in. Remove only the old link published by this
  # checkout, and only after its replacement is healthy, so the built-in is no
  # longer shadowed without touching user-owned agent definitions.
  if [[ $agent_linked -eq 1 && -L "$legacy_agent_dest" && "$(readlink "$legacy_agent_dest")" == "$harness_dir/agents/explorer.toml" ]]; then
    rm "$legacy_agent_dest"
    changed "pruned legacy link ~/.codex/agents/explorer.toml"
  fi
}
