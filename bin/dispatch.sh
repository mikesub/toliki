#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, once per cron tick (etc/dispatch.cron). This is the primary
# launch path: it walks each repo's `ready` issue queue oldest-first and starts
# an epic session per unblocked issue until the host is at capacity, then exits.
# `./remote-control.sh epic N` (laptop-side) remains the manual override for
# jumping the queue.
#
# It walks a SECOND queue first: `needs-judgment` — issues whose PR the merge
# worker declined on a judgment-class rebase conflict. Each gets a fixer
# session (`/fix-conflict #N`, named `<repo>-epic-<N>` like any epic), at most
# one per repo per tick and never while another fixer session in that repo is
# still around. First on purpose: a needs-judgment issue is an epic that
# already ran, one resolved conflict away from a reviewable PR, so finishing
# it outranks starting new work — and being bounded per repo it cannot starve
# the ready queue.
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

# Everything this script prints goes through these two, so each line carries
# the UTC timestamp of the tick that wrote it (ts is in etc/lib.sh).
say()  { echo "$(ts) [dispatch] $*"; }
warn() { echo "$(ts) [dispatch] $*" >&2; }

usage() {
  cat <<EOF
Usage: $0 [-r <repo>] [-n|--dry-run]

One dispatch tick. First walks the \`needs-judgment\` queue (judgment-class
rebase conflicts the merge worker declined) and launches at most one fixer
session per repo (\`/fix-conflict #N\`, session \`<repo>-epic-<N>\`). Then walks
the \`ready\` queue of every registered repo ($(repo_names | tr '\n' ' '))
oldest-first, skipping issues that have open blocked_by dependencies or
already have a session, and launches each remaining one as \`<repo>-epic-<N>\`
until the host hits MAX_PARALLEL_EPICS ($MAX_PARALLEL_EPICS).

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
        warn "$1 requires a value"
        exit 1
      fi
      ONLY_REPO="$2"; shift 2 ;;
    -r=*|--repo=*) ONLY_REPO="${1#*=}"; shift ;;
    *)
      warn "unknown argument '$1'"
      usage >&2
      exit 1 ;;
  esac
done

if [[ -n "$ONLY_REPO" ]] && ! repo_path "$ONLY_REPO" >/dev/null; then
  warn "unknown repo '$ONLY_REPO' (known: $(repo_names | tr '\n' ' '))"
  exit 1
fi

# Ticks must not overlap. Two dispatchers reading capacity at the same moment
# would each see the same free slots and both fill them; launch.sh's own count
# can't prevent that, because both would pass it before either created a
# session. A tick that finds the lock held exits quietly — the next one is a
# minute away and the queue is still there.
#
# Whoever holds this fd holds the lock, and fd 9 survives fork/exec — so every
# launch below closes it (`9>&-`). Without that, `tmux new-session` on a host
# with no tmux server yet STARTS one, and the daemon it leaves behind inherits
# fd 9 and holds this lock for as long as any session lives. The dispatcher then
# locks itself out of its own queue for the length of an epic, logging a
# perfectly calm "previous tick still running" every minute while no tick has
# been running at all — and because it only bites when the tick is the one that
# starts the server, it hides completely on any host that already had a session
# open.
exec 9>"${TMPDIR:-/tmp}/harness-dispatch.lock"
if ! flock -n 9; then
  say "previous tick still running — skipping"
  exit 0
fi

LAUNCHED=0
FAILED=0

# ───────────────────────── Fixer walk ─────────────────────────
# The `needs-judgment` queue: merge-worker.sh applies that label beside
# `failed` on exactly the judgment-class rebase declines, so the queue is a
# label query, never a grep of comment prose. `fix-retried` marks an exhausted
# attempt ladder (the fixer gets one retry, then a human) — those stay out of
# the walk until a human strips the ladder labels to grant another round.
fixer_queue() {
  local path="$1"
  (cd "$path" && gh issue list \
      --search 'label:needs-judgment -label:fix-retried sort:created-asc' \
      --state open --limit "$QUEUE_LIMIT" --json number --jq '.[].number')
}

# A full host ends the whole tick BEFORE the fixer walk's label swap, not
# after: without this probe, every tick at capacity would swap an issue
# failed → in-progress only to revert it when launch says 3 — two label
# writes and two timeline events per minute for as long as the box stays
# full, churn that also resets updatedAt and so hides the issue from
# /triage's "sat unchanged" heuristic. The probe is launch.sh's own counting
# (--check-capacity runs the same capacity_gate as a real launch), so the cap
# still lives in exactly one place. Not run for --dry-run, which is
# documented as not simulating capacity.
if (( ! DRY_RUN )); then
  set +e
  "$LAUNCH" --check-capacity </dev/null 9>&-
  rc=$?
  set -e
  case "$rc" in
    0) ;;
    "$EXIT_AT_CAPACITY")
      say "host at capacity — nothing can launch, ending tick"
      exit 0 ;;
    *)
      warn "launch.sh rejected its configuration — aborting tick"
      exit 1 ;;
  esac
fi

for repo in $(repo_names); do
  [[ -z "$ONLY_REPO" || "$repo" == "$ONLY_REPO" ]] || continue
  path="$(repo_path "$repo")"
  [[ -d "$path/.git" ]] || continue    # the ready walk below reports this
  # Fail closed like the blocker check: a queue we could not read must not
  # launch — and must not stop the other repos from getting their walk.
  if ! fixers="$(fixer_queue "$path" | tr '\n' ' ')"; then
    warn "$repo: needs-judgment queue query failed, skipping its fixer walk"
    continue
  fi
  fixers="${fixers% }"
  [[ -n "$fixers" ]] || continue
  say "$repo: needs-judgment: $fixers"

  # Serial per repo: every fixer rebases onto the same moving main, so one
  # runs at a time. Any candidate that still has a session — live, just
  # finished and not yet reaped, or dead and flagged for a human — parks the
  # whole repo's fixer walk for this tick. (An issue the fixer is working
  # RIGHT NOW is still in this queue: `needs-judgment` only comes off on
  # success, so the running fixer's own issue is what trips this check.)
  # "=" pins the match: a bare -t matches session-name PREFIXES, so fixer #26
  # would read a live epic #263 as its own session and park the repo.
  busy=""
  for num in $fixers; do
    if tmux has-session -t "=$repo-epic-$num" 2>/dev/null; then
      busy="$num"; break
    fi
  done
  if [[ -n "$busy" ]]; then
    say "  #$busy ($repo): fixer session exists — repo's fixer walk waits"
    continue
  fi

  for num in $fixers; do
    session="$repo-epic-$num"
    if (( DRY_RUN )); then
      say "  #$num ($repo): would launch fixer '$session'"
      LAUNCHED=$((LAUNCHED + 1))
      break
    fi

    # Swap failed → in-progress BEFORE launching, here in the dispatcher. This
    # is NOT a claim (the tmux session name is the claim: launch.sh refuses a
    # duplicate, and this tick holds the flock) — it is a shield against the
    # reaper. `failed` is terminal for reap's sweep, and a fixer necessarily
    # launches more than TERMINAL_SETTLE_MINUTES after that label's last write
    # (its predecessor session had to settle and be reaped first, and nothing
    # touches the issue in between), so a session launched onto a still-failed
    # issue would be killed by the next sweep — a minute out — long before its
    # own prepare phase could swap the label. Swapping synchronously before
    # the launch is the only ordering that closes that window; a launch that
    # then fails reverts the swap so the issue goes back to the queue.
    (cd "$path" && gh label create in-progress --color FBCA04 \
        --description "Actively being worked by epic-run" >/dev/null 2>&1) || true
    if ! (cd "$path" && gh issue edit "$num" --remove-label failed --add-label in-progress >/dev/null 2>&1); then
      warn "  #$num ($repo): could not swap failed → in-progress — not launching (a still-failed issue would be reaped out from under the fixer)"
      continue
    fi

    # The queue above rode gh's SEARCH index, which lags label edits by up to
    # about a minute — long enough for the documented human takeover
    # (stripping needs-judgment) to race this tick and win invisibly. Re-read
    # the issue directly (issue view is a strong read) AFTER the swap: if the
    # takeover happened, the swap just stripped the human's `failed` and a
    # launch would strand an unreapable in-progress session on an issue that
    # is no longer the fixer's. Revert and move on — fail closed on a read
    # that errors, for the same reason.
    meta="$( (cd "$path" && gh issue view "$num" --json state,labels \
               --jq '[.state, ([.labels[].name] | join(","))] | join(" ")') 2>/dev/null )" || meta=""
    read -r istate ilabels <<<"$meta"
    if [[ "$istate" != "OPEN" || ",$ilabels," != *,needs-judgment,* || ",$ilabels," == *,fix-retried,* ]]; then
      say "  #$num ($repo): issue changed under the queue (state ${istate:-unreadable}, labels ${ilabels:-none}) — reverting the swap, skipping"
      (cd "$path" && gh issue edit "$num" --add-label failed --remove-label in-progress >/dev/null 2>&1) \
        || warn "  #$num ($repo): the label revert failed too — issue may be stuck in-progress, fix by hand"
      continue
    fi

    say "  #$num ($repo): launching fixer '$session'"
    set +e
    # </dev/null: nothing in launch.sh should ever read the tick's stdin;
    # 9>&- as in the ready walk below.
    "$LAUNCH" --fix "$num" --repo "$repo" </dev/null 9>&-
    rc=$?
    set -e
    if (( rc != 0 )); then
      (cd "$path" && gh issue edit "$num" --add-label failed --remove-label in-progress >/dev/null 2>&1) \
        || warn "  #$num ($repo): launch failed AND the label revert failed — issue is stuck in-progress, fix by hand"
    fi
    case "$rc" in
      0) LAUNCHED=$((LAUNCHED + 1)) ;;
      "$EXIT_AT_CAPACITY")
        # Deferred, not failed: the revert above put the issue back in the
        # queue, and the next tick retries once reap frees a slot.
        say "host at capacity — ending tick with $LAUNCHED launched"
        exit 0 ;;
      1)
        warn "launch.sh rejected its configuration — aborting tick"
        exit 1 ;;
      *)
        warn "  #$num ($repo): fixer launch failed (exit $rc), continuing"
        FAILED=$((FAILED + 1)) ;;
    esac
    break   # at most one fixer per repo per tick
  done
done

# ───────────────────────── Ready walk ─────────────────────────
# The `ready` queue for one repo, oldest first. gh runs inside the clone so it
# resolves the GitHub repo from that checkout's own origin — which is why this
# script never reads REPO_ORIGINS. Same query as the /epic skill's queue walk:
# in-progress and failed are excluded because a run already owns those, and the
# two terminal success labels are excluded because prepare's label swap is
# best-effort — a stale `ready` can survive beside ready-to-merge/-review, and
# searched by `ready` alone that finished issue would be re-picked every tick,
# each launch burning a spawn that exits via the pipeline's already-claimed
# guard, with nothing in the logs looking wrong.
queue() {
  local path="$1"
  (cd "$path" && gh issue list \
      --search 'label:ready -label:in-progress -label:failed -label:ready-to-merge -label:ready-to-review sort:created-asc' \
      --state open --limit "$QUEUE_LIMIT" --json number --jq '.[].number')
}

# 0 when issue $2 has no open blockers. A failed query is treated as blocked,
# not as clear: "we couldn't check" must never dispatch a run that the queue
# was deliberately holding back.
unblocked() {
  local path="$1" n="$2" open
  if ! open="$(cd "$path" && gh api "repos/{owner}/{repo}/issues/$n/dependencies/blocked_by" \
                 --jq '[.[] | select(.state == "open") | .number] | join(",")' 2>&1)"; then
    warn "  #$n: blocked_by query failed, skipping — $open"
    return 1
  fi
  if [[ -n "$open" ]]; then
    say "  #$n: blocked by $open"
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
    warn "$repo: no checkout at $path — run bin/provision.sh"
    continue
  fi
  # A repo whose queue can't be read is reported and passed over; the other
  # repos still get their tick.
  if ! nums="$(queue "$path" | tr '\n' ' ')"; then
    warn "$repo: queue query failed, skipping this repo"
    continue
  fi
  nums="${nums% }"
  say "$repo: ${nums:-none} ready"
  [[ -n "$nums" ]] || continue
  QUEUE_REPO+=("$repo")
  QUEUE_NUMS+=("$nums")
done

# Only when the fixer walk did nothing either — otherwise fall through so the
# tail summary (which is dry-run aware) accounts for it.
if [[ ${#QUEUE_REPO[@]} -eq 0 ]] && (( LAUNCHED == 0 && FAILED == 0 )); then
  say "nothing ready"
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
    say "  #$num ($repo): session '$session' exists, skipping"
    continue
  fi

  unblocked "$path" "$num" || continue

  if (( DRY_RUN )); then
    say "  #$num ($repo): would launch '$session'"
    LAUNCHED=$((LAUNCHED + 1))
    continue
  fi

  say "  #$num ($repo): launching '$session'"
  set +e
  # 9>&- so the tmux server this may start cannot inherit the tick lock; see
  # the flock comment above for what that costs when it leaks.
  "$LAUNCH" --epic "$num" --repo "$repo" 9>&-
  rc=$?
  set -e
  case "$rc" in
    0) LAUNCHED=$((LAUNCHED + 1)) ;;
    "$EXIT_AT_CAPACITY")
      say "host at capacity — ending tick with $LAUNCHED launched"
      exit 0 ;;
    1)
      # launch.sh's usage/config code. Nothing about it is specific to this
      # issue, so every remaining candidate would fail identically — walking
      # the rest of the queue would just log the same error twenty times and
      # still end in the "tick done" line, which on cron reads as a healthy
      # dispatcher. Stop loudly instead.
      warn "launch.sh rejected its configuration — aborting tick"
      exit 1 ;;
    *)
      # Issue-specific failure (a dirty checkout, a pull conflict): report it
      # and keep going, but the tick is not clean, so don't exit 0 on it.
      warn "  #$num ($repo): launch failed (exit $rc), continuing"
      FAILED=$((FAILED + 1)) ;;
  esac
done

if (( DRY_RUN )); then
  say "dry run: $LAUNCHED would launch (capacity not simulated)"
  exit 0
fi
say "tick done, $LAUNCHED launched, $FAILED failed"
(( FAILED == 0 ))
