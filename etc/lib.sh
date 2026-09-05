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
# HOST_TIMEZONE is machine-local registry state, not a caller override. Clear it
# before loading repos.conf so an ssh caller, cron environment, or old tmux
# server cannot choose how this host renders human timestamps.
unset HOST_TIMEZONE
source "$_LIB_DIR/repos.conf"

# Empty and absent registries retain the historical UTC clock. A configured
# value must be a safe relative TZif entry known by this host. The zoneinfo
# directory also contains text metadata and administrative TZif copies; neither
# names a host clock, and accepting one would let every tick present false time.
HOST_TIMEZONE="${HOST_TIMEZONE:-UTC}"
host_timezone_known() { # zone name
  local zone="$1" magic
  [[ "$zone" =~ ^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$ ]] || return 1
  [[ "/$zone/" != *"/../"* && "/$zone/" != *"/./"* ]] || return 1
  case "$zone" in
    localtime|posixrules|posix/*|right/*) return 1 ;;
  esac
  [[ -f "/usr/share/zoneinfo/$zone" ]] || return 1
  magic="$(LC_ALL=C dd if="/usr/share/zoneinfo/$zone" bs=4 count=1 2>/dev/null)" || return 1
  [[ "$magic" == "TZif" ]]
}
if ! host_timezone_known "$HOST_TIMEZONE"; then
  echo "HOST_TIMEZONE must name a known, safe IANA zone, got '$HOST_TIMEZONE'" >&2
  return 1 2>/dev/null || exit 1
fi
export HOST_TIMEZONE
TZ="$HOST_TIMEZONE"
export TZ

# The first registry entry is the default when -r/--repo isn't given.
DEFAULT_REPO="${REPOS[0]%%=*}"

# The engine a run gets when nothing names one: no engine:* label on the issue,
# no --engine on launch.sh. EPIC_ENGINE is the one knob (the Node side reads the
# same name), and unset means claude, so a host without it behaves as before.
# Checked with engine_known by the scripts that launch (dispatch, launch,
# remote-control), not here: reap, merge and update never route anything and
# should not read the engines file to do their job.
DEFAULT_ENGINE="${EPIC_ENGINE:-claude}"

# The engines a run can be routed to are the top-level keys of etc/engines.json,
# tracked beside this file (a label must mean the same on every machine). The
# full table — vendor/model/effort per step — is the orchestrator's to read;
# the shell only ever needs the names. A missing or unparseable file makes
# engine_known false for every name, so nothing launches on it.
ENGINES_FILE="$_LIB_DIR/engines.json"
engine_names() { jq -r 'keys[]' "$ENGINES_FILE" 2>/dev/null || true; }
engine_known() { jq -e --arg e "$1" 'has($e)' "$ENGINES_FILE" >/dev/null 2>&1; }

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

# Host-zone timestamp for human-readable log lines. The cron-driven scripts
# prefix every line with it via their say/warn helpers: three jobs append to
# the same logs every five minutes, and an untimestamped line can't answer
# which tick wrote it — or against which version of the script. Machine records
# and GitHub comparisons keep their own explicit UTC clocks.
ts() { date '+%Y-%m-%d %H:%M:%S %Z'; }

# Render a canonical machine instant for a human in the validated host zone.
# uutils/GNU date use -d; the fallback keeps the helper usable with BSD date.
human_ts() {
  local epoch
  [[ $# -eq 1 && -n "$1" ]] || return 1
  date -d "$1" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null ||
    { epoch="$(TZ=UTC date -j -f '%Y-%m-%dT%H:%M:%SZ' "$1" '+%s' 2>/dev/null)" &&
      date -r "$epoch" '+%Y-%m-%d %H:%M:%S %Z' 2>/dev/null; }
}

# Localize canonical UTC instants only at a human-output boundary. The value
# feeding this helper remains unchanged, so JSON records and comparisons keep
# their unambiguous UTC representation while messages can share the host clock.
humanize_timestamps() {
  local text="$*" out="" instant prefix rendered
  while [[ "$text" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z ]]; do
    instant="${BASH_REMATCH[0]}"
    prefix="${text%%"$instant"*}"
    text="${text#*"$instant"}"
    if rendered="$(human_ts "$instant")"; then
      out="$out$prefix$rendered"
    else
      out="$out$prefix$instant"
    fi
  done
  printf '%s' "$out$text"
}
