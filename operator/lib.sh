# Shared helpers for the laptop-side `./toliki` commands. Every script in this
# directory is reached through the root `./toliki` dispatcher and runs on the
# LAPTOP: it parses the operator's intent, resolves names and repos locally
# where it can, and sshes the rest over. Nothing here ever runs on the host —
# that is what `bin/` is, and the split is the reason this directory exists
# rather than more entry points at the root.
#
# operator/setup.sh is the one exception that does NOT source this file: it
# seeds etc/repos.conf, so it has to work before a registry exists.

# Same refusal as etc/lib.sh, one level earlier: without BASH_SOURCE this file
# cannot locate the repo root, and a guess would resolve the registry — and so
# the ssh destination — from the caller's CWD.
if [[ -z "${BASH_SOURCE[0]:-}" ]]; then
  echo "operator/lib.sh: \${BASH_SOURCE[0]} is empty — this is not bash (zsh/sh)," >&2
  echo "so this file cannot locate itself. Run the CLI as: ./toliki <command>" >&2
  exit 1
fi
OPERATOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOLIKI_ROOT="$(cd "$OPERATOR_DIR/.." && pwd)"
source "$TOLIKI_ROOT/etc/lib.sh"

# How the operator invoked us, for messages that name a command to run next.
# Every message says the whole `./toliki <group> <command>` path, so anything
# copied out of an error is a command that works.
CLI="${TOLIKI_CLI:-./toliki}"

say()  { printf '[toliki] %s\n' "$*"; }
warn() { printf '[toliki] %s\n' "$*" >&2; }
die()  { warn "$*"; exit 1; }

# The ssh destination lives in the machine-local registry; without it there is
# no host to talk to and every command below is meaningless.
HOST=""
require_ssh_host() {
  HOST="${SSH_HOST:-}"
  [[ -n "$HOST" ]] ||
    die "SSH_HOST is not set — add it to etc/repos.conf (see etc/repos.conf.template)"
}

# The five manual pipeline launches are the only commands that may carry
# --engine or the capacity override. Both are refused HERE, on the laptop, by
# every other command, so a session, a route, a report or a bare flag can never
# put either on the wire.
PIPELINE_KINDS="epic|task|fix|ci|defect"
refuse_engine_flag() {
  die "--engine only applies to manual '$CLI run $PIPELINE_KINDS <issue>' launches"
}
refuse_over_capacity() {
  die "--over-capacity only applies to manual '$CLI run $PIPELINE_KINDS <issue>' launches"
}
refuse_message_flag() {
  die "-m/--message only applies to '$CLI session start' and '$CLI session restart'"
}
refuse_repo_flag() { # what the flag was given to
  die "-r/--repo does not apply to '$1' — it is host-wide"
}

require_known_repo() { # repo name
  repo_path "$1" >/dev/null ||
    die "unknown repo '$1' (known: $(repo_names | tr '\n' ' '))"
}

require_known_engine() { # engine name, what named it
  engine_known "$1" ||
    die "$2 must name an engine in etc/engines.json ($(engine_names | tr '\n' ' ')), got '$1'"
}
