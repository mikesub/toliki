#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, from cron (hourly — see etc/dispatch.cron). Moves the
# claude binary to the latest release, and only on an idle box. It exists
# because nothing else does it: a headless `claude -p` never self-updates (the
# auto-updater is an interactive-session feature), and provision.sh
# deliberately never upgrades a version that is already present. Measured: the
# host sat on 2.1.233 from 2026-08-14 to 2026-09-02 across daily pipeline runs
# while 25 releases shipped — one of them the release that moved the `fable`
# alias to a new model. The pipelines name their tiers by alias precisely so a
# CLI update moves them forward without anyone editing a table; a CLI that
# never updates quietly turns those aliases into pins.
#
# Idle is the whole contract. A running process keeps its binary through the
# swap, but every phase of a pipeline run is a FRESH `claude` process, so an
# update under a live run hands its later phases a different CLI than its
# earlier ones got. provision.sh refuses to move the CLI under live sessions
# for that reason; this script is the one place it does move, and only when
# launch.sh's own count says nothing is running — the same function that
# enforces MAX_PARALLEL_EPICS, so "busy" cannot mean two different things.
#
# It holds dispatch's lock across the check and the install so a tick cannot
# launch into the window between "idle" and "installed". A manual
# `remote-control.sh start` does not take that lock; the window is one
# download long and the cost is one run on mixed CLI versions, so that is
# accepted rather than guarded. While the lock is held a dispatch tick logs
# "previous tick still running — skipping": that is this script, not a stuck
# tick.
#
# `latest`, not `stable`, on purpose: the pipeline's gates fail a broken phase
# loudly, whereas a stale model degrades output silently. Exit 0 whenever the
# host was left consistent (updated, already current, busy, lock held), 1 when
# the update itself failed — the cron log is the record either way.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

say()  { echo "$(ts) [update-claude] $*"; }
warn() { echo "$(ts) [update-claude] $*" >&2; }

# The native installer lives in ~/.local/bin, which cron's PATH line carries
# but a non-interactive ssh does not — prepend it so a hand run over ssh
# resolves the same binary the pipeline spawns.
export PATH="$HOME/.local/bin:$PATH"

DRY_RUN=0
case "${1:-}" in
  "") ;;
  -n|--dry-run) DRY_RUN=1 ;;
  -h|--help) echo "Usage: $0 [-n|--dry-run]"; exit 0 ;;
  *) echo "Usage: $0 [-n|--dry-run]" >&2; exit 1 ;;
esac

if ! command -v claude >/dev/null 2>&1; then
  warn "claude is not on PATH — nothing to update (provision.sh installs it)"
  exit 1
fi

# Same lock file as dispatch.sh, but blocking: a tick takes a second or two,
# so a short wait always gets it, and a tick arriving while we hold it skips
# itself. Not getting it in 30s means something unusual holds it — leave it.
exec 9>"${TMPDIR:-/tmp}/harness-dispatch.lock"
if ! flock -w 30 9; then
  say "could not take the dispatch lock within 30s — skipping"
  exit 0
fi

# Idle, by launch.sh's count. 3 = something is running; any other non-zero
# means the probe itself failed, which is no reason to touch the host.
probe_rc=0
probe_out="$("$HERE/launch.sh" --check-idle 2>&1)" || probe_rc=$?
case "$probe_rc" in
  0) ;;
  3) say "host busy (${probe_out#\[launch\] }) — not updating"; exit 0 ;;
  *) warn "idle probe failed (rc $probe_rc): $probe_out"; exit 1 ;;
esac

before="$(claude --version 2>/dev/null | awk '{print $1}')"
if (( DRY_RUN )); then
  say "dry-run: host idle, would run 'claude update' (current $before)"
  exit 0
fi

# `claude update` checks and installs in one step and is a fast no-op when
# current (~1s), so it runs every idle hour and the version diff is the log.
if ! out="$(claude update 2>&1)"; then
  warn "claude update failed (still $before):"
  printf '%s\n' "$out" | sed 's/^/    /' >&2
  exit 1
fi
after="$(claude --version 2>/dev/null | awk '{print $1}')"
if [[ "$after" == "$before" ]]; then
  say "up to date ($before)"
else
  say "updated $before -> $after"
fi
