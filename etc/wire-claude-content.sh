#!/usr/bin/env bash

# Publish only Toliki's interactive human gate into Claude Code. Pipeline
# sessions load their architect/coder/reviewer charters directly from agents/
# and are launched by the host scripts, so exposing those as user-level Claude
# content creates a second, misleading entry path.
#
# Sourced by setup.sh and bin/provision.sh. The caller provides the reporting
# functions used below: ok, changed, and blocked.

wire_claude_content() {
  local harness_dir="$1"
  local d names link_dir src_dir name item dest old_target target keep linked

  mkdir -p "$HOME/.claude"

  for d in skills agents; do
    case "$d" in
      skills) names="spec" ;;
      agents) names="spec-explorer.md" ;;
    esac

    link_dir="$HOME/.claude/$d"
    src_dir="$harness_dir/$d"
    if [[ ! -d "$src_dir" ]]; then
      blocked "$src_dir doesn't exist — is this a complete checkout?"
      continue
    fi

    # Convert the legacy whole-directory link only when it belongs to this
    # checkout (or is dangling). It cannot contain user-owned entries.
    if [[ -L "$link_dir" ]]; then
      if [[ "$(readlink "$link_dir")" == "$src_dir" || ! -e "$link_dir" ]]; then
        rm "$link_dir"
        mkdir -p "$link_dir"
        changed "converted ~/.claude/$d from a whole-directory symlink to a real directory (selected links below)"
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

    linked=""
    for name in $names; do
      item="$src_dir/$name"
      dest="$link_dir/$name"
      if [[ ! -e "$item" ]]; then
        blocked "$item doesn't exist — is this a complete checkout?"
      elif [[ -L "$dest" && "$(readlink "$dest")" == "$item" ]]; then
        linked="${linked:+$linked }$name"
      elif [[ -L "$dest" && ! -e "$dest" ]]; then
        old_target="$(readlink "$dest")"
        rm "$dest"
        ln -s "$item" "$dest"
        changed "replaced dangling link ~/.claude/$d/$name (was $old_target) -> $item"
        linked="${linked:+$linked }$name"
      elif [[ -e "$dest" || -L "$dest" ]]; then
        blocked "~/.claude/$d/$name exists and isn't a link into this checkout — it would shadow the harness copy; resolve by hand"
      else
        ln -s "$item" "$dest"
        changed "linked ~/.claude/$d/$name -> $item"
        linked="${linked:+$linked }$name"
      fi
    done
    [[ -z "$linked" ]] || ok "$d: $linked"

    # Remove only links this checkout previously published. User content and
    # links owned by any other source remain untouched.
    for dest in "$link_dir"/*; do
      [[ -L "$dest" ]] || continue
      target="$(readlink "$dest")"
      [[ "$target" == "$src_dir/"* ]] || continue
      keep=0
      for name in $names; do
        if [[ "$(basename "$dest")" == "$name" ]]; then
          keep=1
          break
        fi
      done
      if [[ $keep -eq 0 || ! -e "$dest" ]]; then
        rm "$dest"
        changed "pruned unpublished link ~/.claude/$d/$(basename "$dest")"
      fi
    done
  done
}
