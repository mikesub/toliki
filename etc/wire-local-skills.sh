#!/usr/bin/env bash

# Link the local epic skills (skills/epic/t-*) into one harness's user skill
# directory, one link per skill, and prune every other link this checkout
# published there (the parked /spec among them). Anything that is not a link
# into this checkout is user or foreign content: it is reported, never
# replaced or removed.
#
# Sourced by the wire-*-content.sh helpers. The caller has made link_dir a real
# directory and provides ok, changed, and blocked.

wire_local_skills() {
  local harness_dir="$1" link_dir="$2" label="$3"
  local src_dir="$harness_dir/skills" item name dest target published=" " linked=""

  for item in "$src_dir"/epic/t-*; do
    [[ -f "$item/SKILL.md" ]] || continue
    name="$(basename "$item")"
    published="$published$name "
    dest="$link_dir/$name"
    if [[ -L "$dest" && "$(readlink "$dest")" == "$item" ]]; then
      linked="${linked:+$linked }$name"
      continue
    elif [[ -L "$dest" ]]; then
      target="$(readlink "$dest")"
      # A dangling link, or one of ours from an older layout, is replaced.
      if [[ -e "$dest" && "$target" != "$src_dir/"* ]]; then
        blocked "$label/$name links to $target — it would shadow the harness copy; resolve by hand"
        continue
      fi
      rm "$dest"
      ln -s "$item" "$dest"
      changed "relinked $label/$name (was $target) -> $item"
    elif [[ -e "$dest" ]]; then
      blocked "$label/$name exists and isn't a link into this checkout — it would shadow the harness copy; resolve by hand"
      continue
    else
      ln -s "$item" "$dest"
      changed "linked $label/$name -> $item"
    fi
    linked="${linked:+$linked }$name"
  done
  [[ "$published" != " " ]] || blocked "$src_dir/epic has no t-* skills — is this a complete checkout?"
  [[ -z "$linked" ]] || ok "$label: $linked"

  for dest in "$link_dir"/*; do
    [[ -L "$dest" ]] || continue
    target="$(readlink "$dest")"
    name="$(basename "$dest")"
    [[ "$target" == "$src_dir/"* && "$published" != *" $name "* ]] || continue
    rm "$dest"
    changed "pruned unpublished link $label/$name"
  done
}
