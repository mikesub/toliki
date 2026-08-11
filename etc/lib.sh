# Shared helpers for the harness scripts, plus the single entry point for the
# machine-local registry: every script sources THIS file, and this file sources
# etc/repos.conf beside it. The split keeps the helpers tracked (they are code,
# and fixes must reach every checkout) while the registry stays local config —
# repos.conf is gitignored and seeded from etc/repos.conf.template.
# Keep everything here side-effect-free.

_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$_LIB_DIR/repos.conf" ]]; then
  echo "etc/repos.conf not found — create your local registry first:" >&2
  echo "  cp etc/repos.conf.template etc/repos.conf   # then edit it" >&2
  exit 1
fi
source "$_LIB_DIR/repos.conf"

# The first registry entry is the default when -r/--repo isn't given.
DEFAULT_REPO="${REPOS[0]%%=*}"

repo_names() {
  local e
  for e in "${REPOS[@]}"; do printf '%s\n' "${e%%=*}"; done
}

# Path for a repo name; non-zero exit if the name isn't registered.
repo_path() {
  local e
  for e in "${REPOS[@]}"; do
    if [[ "${e%%=*}" == "$1" ]]; then printf '%s' "${e#*=}"; return 0; fi
  done
  return 1
}

# Clone source ("<owner>/<repo>") for a repo name; non-zero exit if the name
# has no registered origin, which provision.sh reports as a manual clone.
repo_origin() {
  local e
  for e in "${REPO_ORIGINS[@]}"; do
    if [[ "${e%%=*}" == "$1" ]]; then printf '%s' "${e#*=}"; return 0; fi
  done
  return 1
}

# The repo a full session name belongs to ("myapp-epic-63" -> "myapp").
# Non-zero exit if the name carries no known repo prefix.
repo_of_session() {
  local r
  while IFS= read -r r; do
    if [[ "$1" == "$r-"* ]]; then printf '%s' "$r"; return 0; fi
  done < <(repo_names)
  return 1
}

# Sessions are always named "<repo>-<short>", so the same short name (an epic
# number, a pool name) can't collide across repos on the shared tmux host.
# Idempotent: a name already prefixed for this repo comes back unchanged, so
# the full names `ls` prints can be passed straight back into stop/restart.
full_name() {
  local repo="$1" name="$2"
  if [[ "$name" == "$repo-"* ]]; then
    printf '%s' "$name"
  else
    printf '%s-%s' "$repo" "$name"
  fi
}

# Turn arbitrary message text into a tmux/session-safe slug: lowercase, each
# run of non-[a-z0-9] collapses to a single '-', ends trimmed, capped at
# NAME_MAX_LEN (e.g. "/epic #42" -> "epic-42"). Prints "" if nothing usable
# remains, so the caller can fall back to the pool.
slugify() {
  local s
  s="$(printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
                        | LC_ALL=C tr -c 'a-z0-9' '-' \
                        | LC_ALL=C tr -s '-')"
  s="${s#-}"
  s="${s%-}"
  if (( ${#s} > NAME_MAX_LEN )); then
    s="${s:0:NAME_MAX_LEN}"
    s="${s%-}"
  fi
  printf '%s' "$s"
}

# Single-quote-escape a string for a shell command line.
sq() { local s="${1//\'/\'\\\'\'}"; printf "'%s'" "$s"; }
