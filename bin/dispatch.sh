#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, once per cron tick (etc/dispatch.cron). This is the primary
# launch path: it walks each repo's `ready` issue queue oldest-first and starts
# an epic session per unblocked issue until the host is at capacity, then exits.
# `./remote-control.sh epic N` (laptop-side) remains the manual override for
# jumping the queue.
#
# It dispatches; it does NOT claim. The claim is a unique commit pushed to
# `epic/<N>-<slug>` by the pipeline's own prepare phase, and a
# dispatcher that pre-created that ref would make every run it launched refuse
# its own claim as another run's. So two ticks racing on one issue is safe by
# construction: prepare hands the ref to exactly one of them and the loser
# skips in seconds, which is far cheaper than the coordination it would take to
# never over-dispatch.
#
# Capacity is not decided here either — bin/launch.sh owns it (see the comment
# at its capacity check). This script just stops when launch.sh says 3.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

LAUNCH="$HERE/launch.sh"
QUEUE_LIMIT=20                       # candidates fetched per repo per tick
EXIT_AT_CAPACITY=3                   # launch.sh's "host is full" code

usage() {
  cat <<EOF
Usage: $0 [-r <repo>] [-n|--dry-run]

One dispatch tick. Walks the \`ready\` queue of every registered repo
($(repo_names | tr '\n' ' ')) oldest-first, skipping issues that have open
blocked_by dependencies or already have a session, and launches each remaining
one as \`<repo>-epic-<N>\` until the host hits MAX_PARALLEL_EPICS
($MAX_PARALLEL_EPICS).

  -r, --repo <name>   Only dispatch for this repo.
  -n, --dry-run       Report what it would launch; start nothing. Capacity is
                      not simulated (launch.sh owns it, and asking costs a
                      launch), so this can list more than a tick would start.
EOF
}

ONLY_REPO=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    -r|--repo)
      if [[ $# -lt 2 ]]; then
        echo "[dispatch] $1 requires a value" >&2
        exit 1
      fi
      ONLY_REPO="$2"; shift 2 ;;
    -r=*|--repo=*) ONLY_REPO="${1#*=}"; shift ;;
    *)
      echo "[dispatch] unknown argument '$1'" >&2
      usage >&2
      exit 1 ;;
  esac
done

if [[ -n "$ONLY_REPO" ]] && ! repo_path "$ONLY_REPO" >/dev/null; then
  echo "[dispatch] unknown repo '$ONLY_REPO' (known: $(repo_names | tr '\n' ' '))" >&2
  exit 1
fi

# Ticks must not overlap. Two dispatchers reading capacity at the same moment
# would each see the same free slots and both fill them; launch.sh's own count
# can't prevent that, because both would pass it before either created a
# session. A tick that finds the lock held exits quietly — the next one is
# five minutes away and the queue is still there.
exec 9>"${TMPDIR:-/tmp}/harness-dispatch.lock"
if ! flock -n 9; then
  echo "[dispatch] previous tick still running — skipping"
  exit 0
fi

# The `ready` queue for one repo, oldest first. gh runs inside the clone so it
# resolves the GitHub repo from that checkout's own origin — which is why this
# script never reads REPO_ORIGINS. Same query as the /epic skill's queue walk:
# in-progress and failed are excluded because a run already owns those.
queue() {
  local path="$1"
  (cd "$path" && gh issue list \
      --search 'label:ready -label:in-progress -label:failed sort:created-asc' \
      --state open --limit "$QUEUE_LIMIT" --json number --jq '.[].number')
}

# 0 when issue $2 has no open blockers. A failed query is treated as blocked,
# not as clear: "we couldn't check" must never dispatch a run that the queue
# was deliberately holding back.
unblocked() {
  local path="$1" n="$2" open
  if ! open="$(cd "$path" && gh api "repos/{owner}/{repo}/issues/$n/dependencies/blocked_by" \
                 --jq '[.[] | select(.state == "open") | .number] | join(",")' 2>&1)"; then
    echo "[dispatch]   #$n: blocked_by query failed, skipping — $open" >&2
    return 1
  fi
  if [[ -n "$open" ]]; then
    echo "[dispatch]   #$n: blocked by $open"
    return 1
  fi
  return 0
}

# Collect each repo's candidates up front so they can be interleaved below.
QUEUE_REPO=()
QUEUE_NUMS=()
for repo in $(repo_names); do
  [[ -z "$ONLY_REPO" || "$repo" == "$ONLY_REPO" ]] || continue
  path="$(repo_path "$repo")"
  if [[ ! -d "$path/.git" ]]; then
    echo "[dispatch] $repo: no checkout at $path — run bin/provision.sh" >&2
    continue
  fi
  # A repo whose queue can't be read is reported and passed over; the other
  # repos still get their tick.
  if ! nums="$(queue "$path" | tr '\n' ' ')"; then
    echo "[dispatch] $repo: queue query failed, skipping this repo" >&2
    continue
  fi
  nums="${nums% }"
  echo "[dispatch] $repo: ${nums:-none} ready"
  [[ -n "$nums" ]] || continue
  QUEUE_REPO+=("$repo")
  QUEUE_NUMS+=("$nums")
done

if [[ ${#QUEUE_REPO[@]} -eq 0 ]]; then
  echo "[dispatch] nothing ready"
  exit 0
fi

# Interleave one issue per repo per pass. Draining REPOS in order instead would
# let a repo with a deep queue hold the whole host until it empties, and since
# REPOS[0] is also the default repo that is the likely case, not the unlucky
# one. Within a pass, REPOS order still breaks the tie.
ORDER=()
pass=0
while :; do
  added=0
  for i in "${!QUEUE_REPO[@]}"; do
    read -r -a nums <<<"${QUEUE_NUMS[$i]}"
    if (( pass < ${#nums[@]} )); then
      ORDER+=("${QUEUE_REPO[$i]} ${nums[$pass]}")
      added=1
    fi
  done
  (( added )) || break
  pass=$((pass + 1))
done

LAUNCHED=0
FAILED=0
for entry in "${ORDER[@]}"; do
  repo="${entry%% *}"
  num="${entry##* }"
  path="$(repo_path "$repo")"
  session="$repo-epic-$num"

  # An issue stays `ready` until the run's prepare phase swaps the label, so
  # for the first minutes of a run it is still a queue candidate. Without this
  # check the next tick would re-dispatch it, and launch.sh would answer
  # "already running" — harmless, but it burns the tick on an issue that is
  # already being built instead of moving down the queue.
  if tmux has-session -t "$session" 2>/dev/null; then
    echo "[dispatch]   #$num ($repo): session '$session' exists, skipping"
    continue
  fi

  unblocked "$path" "$num" || continue

  if (( DRY_RUN )); then
    echo "[dispatch]   #$num ($repo): would launch '$session'"
    LAUNCHED=$((LAUNCHED + 1))
    continue
  fi

  echo "[dispatch]   #$num ($repo): launching '$session'"
  set +e
  "$LAUNCH" --repo "$repo" --message "/epic #$num"
  rc=$?
  set -e
  case "$rc" in
    0) LAUNCHED=$((LAUNCHED + 1)) ;;
    "$EXIT_AT_CAPACITY")
      echo "[dispatch] host at capacity — ending tick with $LAUNCHED launched"
      exit 0 ;;
    1)
      # launch.sh's usage/config code. Nothing about it is specific to this
      # issue, so every remaining candidate would fail identically — walking
      # the rest of the queue would just log the same error twenty times and
      # still end in the "tick done" line, which on cron reads as a healthy
      # dispatcher. Stop loudly instead.
      echo "[dispatch] launch.sh rejected its configuration — aborting tick" >&2
      exit 1 ;;
    *)
      # Issue-specific failure (a dirty checkout, a pull conflict): report it
      # and keep going, but the tick is not clean, so don't exit 0 on it.
      echo "[dispatch]   #$num ($repo): launch failed (exit $rc), continuing" >&2
      FAILED=$((FAILED + 1)) ;;
  esac
done

if (( DRY_RUN )); then
  echo "[dispatch] dry run: $LAUNCHED would launch (capacity not simulated)"
  exit 0
fi
echo "[dispatch] tick done, $LAUNCHED launched, $FAILED failed"
(( FAILED == 0 ))
