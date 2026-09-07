#!/usr/bin/env bash

# Link /spec into Codex's user-level skill directory and register spec-explorer
# against its real charter path, so this checkout stays the source of truth.
# Codex 0.153.4 advertises a symlinked charter but refuses to open that symlink
# on spawn. Retire our old discovery link only after registration succeeds:
# keeping both definitions makes Codex report a duplicate role.
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
  local old_target registration

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
    return
  elif [[ -e "$agent_dest" || -L "$agent_dest" ]]; then
    if [[ ! -L "$agent_dest" || "$(readlink "$agent_dest")" != "$agent_item" ]]; then
      blocked "~/.codex/agents/spec-explorer.toml exists and isn't a link into this checkout — it would shadow the harness copy; resolve by hand"
      return
    fi
  fi

  if ! command -v node >/dev/null 2>&1 || ! command -v codex >/dev/null 2>&1; then
    blocked "node and codex are required to register spec-explorer — install them and re-run setup.sh"
    return
  fi
  if registration="$(node "$harness_dir/etc/register-codex-agent.mjs" "$HOME/.codex/config.toml" "$agent_item" 2>&1)"; then
    if [[ "$registration" == "registered" ]]; then
      changed "registered spec-explorer with its real repo path in ~/.codex/config.toml"
    elif [[ "$registration" == "unchanged" ]]; then
      ok "Codex spec-explorer registration"
    else
      blocked "Codex spec-explorer registration returned an unknown result"
      return
    fi
  else
    blocked "$registration"
    return
  fi
  if [[ -L "$agent_dest" && "$(readlink "$agent_dest")" == "$agent_item" ]]; then
    rm "$agent_dest"
    changed "removed obsolete discovery link ~/.codex/agents/spec-explorer.toml"
  elif [[ -e "$agent_dest" || -L "$agent_dest" ]]; then
    blocked "~/.codex/agents/spec-explorer.toml changed during registration — left it alone; resolve by hand"
    return
  fi

  # explorer is a Codex built-in. Remove only the old link published by this
  # checkout, and only after its replacement is healthy, so the built-in is no
  # longer shadowed without touching user-owned agent definitions.
  if [[ -L "$legacy_agent_dest" && "$(readlink "$legacy_agent_dest")" == "$harness_dir/agents/explorer.toml" ]]; then
    rm "$legacy_agent_dest"
    changed "pruned legacy link ~/.codex/agents/explorer.toml"
  fi
}
