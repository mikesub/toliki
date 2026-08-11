# Shared helpers for the harness scripts, plus the single entry point for the
# machine-local registry: every script sources THIS file, and this file sources
# etc/repos.conf beside it. The split keeps the helpers tracked (they are code,
# and fixes must reach every checkout) while the registry stays local config —
# repos.conf is gitignored and seeded from etc/repos.conf.template.
# Keep everything here side-effect-free.

# BASH_SOURCE is a bash-ism, and this file locates itself with nothing else.
# zsh leaves it empty, so `dirname ""` yields "." and _LIB_DIR silently becomes
# the CALLER'S CWD instead of this file's directory — the registry check below
# then fires from the wrong path and reports a file that is sitting right
# there. That misreads as "your registry is missing", whose fix is to copy the
# template OVER a gitignored, machine-local file with no way back. Every script
# here is bash, but the laptop's interactive shell (and so any ad-hoc
# `source etc/lib.sh` from a tool or a prompt) is zsh. Refuse rather than guess.
if [[ -z "${BASH_SOURCE[0]:-}" ]]; then
  echo "etc/lib.sh: \${BASH_SOURCE[0]} is empty — this is not bash (zsh/sh)," >&2
  echo "so this file cannot locate itself. Re-run under bash:" >&2
  echo "  bash -c 'source etc/lib.sh && ...'" >&2
  exit 1
fi
_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$_LIB_DIR/repos.conf" ]]; then
  # Name the path that was checked. Unqualified, this message's other reading
  # is "the registry is missing" — and acting on that means clobbering a
  # registry that a bad lookup simply failed to find.
  echo "registry not found at $_LIB_DIR/repos.conf" >&2
  echo "If that path looks wrong, the lookup is at fault, not the file." >&2
  echo "Otherwise create your local registry first:" >&2
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

# UTC timestamp for log lines ("2026-08-11T09:45:02Z"). The cron-driven scripts
# prefix every line with it via their say/warn helpers: three jobs append to
# the same logs every five minutes, and an untimestamped line can't answer
# which tick wrote it — or against which version of the script. Keep the flags
# portable: the host's coreutils is uutils, not GNU.
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
