#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, once per cron tick (etc/dispatch.cron). This is the primary
# launch path: it walks each repo's `ready` issue queue oldest-first and starts
# an epic session per unblocked issue until the host is at capacity, then exits.
# `./remote-control.sh epic N` (laptop-side) remains the manual override for
# jumping the queue.
#
# It walks three repair queues first: two filled by the merge worker and one
# filled by epic-run's deterministic ship gate:
# `needs-judgment` (a judgment-class rebase conflict, fixed by `--fix`) and
# `needs-ci-fix` (checks red on the rebased head, fixed by `--ci`), followed by
# opted-in `needs-defect-fix` work (concrete ship-gate defects, fixed by
# `--defect`). Each
# candidate gets a session named `<repo>-epic-<N>` like any epic, at most one
# fixer of any kind per repo per tick and never while another fixer session in
# that repo is still around. First on purpose: both are epics that already ran,
# one repair away from a landable PR, so finishing them outranks starting new
# work — and being bounded per repo they cannot starve the ready queue.
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
# at its capacity check). Before asking, an automatic tick snapshots the
# vendor-keyed provider holds under this script's lock; each candidate is then
# admitted from the vendors used by its resolved engine. Routing-only modes
# bypass admission.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

LAUNCH="$HERE/launch.sh"
QUEUE_LIMIT=20                       # candidates fetched per repo per tick
EXIT_AT_CAPACITY=3                   # launch.sh's "host is full" code

# Everything this script prints goes through these two, so each line carries
# the configured host-zone timestamp of the tick that wrote it (ts is in
# etc/lib.sh).
say()  { echo "$(ts) [dispatch] $(humanize_timestamps "$*")"; }
warn() { echo "$(ts) [dispatch] $(humanize_timestamps "$*")" >&2; }

usage() {
  cat <<EOF
Usage: $0 [-r <repo>] [-n|--dry-run]
       $0 --route-next <engine> [-r <repo>]
       $0 --route-issue <N> <engine> -r <repo>

<engine> is a name from etc/engines.json (a vendor/model/effort table per
pipeline step): currently $(engine_names | tr '\n' ' ').

One dispatch tick. First walks the repair queues — \`needs-judgment\`
(judgment-class rebase conflicts) and \`needs-ci-fix\` (checks red on the
rebased head), both applied by the merge worker, then \`needs-defect-fix\`
for repos in DEFECT_FIX_REPOS — and launches at most one
fixer session per repo (\`launch.sh --fix N\`, \`--ci N\`, or \`--defect N\`, session
\`<repo>-epic-<N>\`). Then walks
the \`ready\` queue of every registered repo ($(repo_names | tr '\n' ' '))
oldest-first, skipping issues that have open blocked_by dependencies or
already have a session, and launches each remaining one as \`<repo>-epic-<N>\`
until the host hits MAX_PARALLEL_EPICS ($MAX_PARALLEL_EPICS).

  -r, --repo <name>   Only dispatch for this repo.
  -n, --dry-run       Report what it would launch; start nothing. Capacity is
                      not simulated (launch.sh owns it, and asking costs a
                      launch), so this can list more than a tick would start.
  --route-next <name> Assign the first unrouted, unblocked ready issue to this
                      engine. Uses the same lock, queue order, and strong reads
                      as dispatch, but does not probe capacity or launch work.
  --route-issue <N> <name>
                      Persist an explicit manual epic/fix engine choice on one
                      issue. Requires -r; labels only and launches nothing.

An active host provider-quota hold skips ordinary and dry-run candidates whose
engine uses that vendor; other engines keep walking. Routing-only modes and
explicit remote-control launches remain available as operator overrides.
EOF
}

ONLY_REPO=""
DRY_RUN=0
ROUTE_NEXT=""
HAVE_ROUTE_NEXT=0
ROUTE_ISSUE=""
ROUTE_ISSUE_ENGINE=""
HAVE_ROUTE_ISSUE=0
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
    --route-next)
      if [[ $# -lt 2 ]]; then
        warn "$1 requires a value"
        exit 1
      fi
      HAVE_ROUTE_NEXT=1
      ROUTE_NEXT="$2"; shift 2 ;;
    --route-next=*) HAVE_ROUTE_NEXT=1; ROUTE_NEXT="${1#*=}"; shift ;;
    --route-issue)
      if [[ $# -lt 3 ]]; then
        warn "$1 requires an issue number and engine"
        exit 1
      fi
      HAVE_ROUTE_ISSUE=1
      ROUTE_ISSUE="${2#\#}"
      ROUTE_ISSUE_ENGINE="$3"
      shift 3 ;;
    *)
      warn "unknown argument '$1'"
      usage >&2
      exit 1 ;;
  esac
done

# Fail on a bad engine name before the lock, the queue, or any label write.
if ! engine_known "$DEFAULT_ENGINE"; then
  warn "EPIC_ENGINE must name an engine in etc/engines.json ($(engine_names | tr '\n' ' ')), got '$DEFAULT_ENGINE'"
  exit 1
fi
if (( HAVE_ROUTE_NEXT )); then
  if ! engine_known "$ROUTE_NEXT"; then
    warn "--route-next must name an engine in etc/engines.json ($(engine_names | tr '\n' ' ')), got '$ROUTE_NEXT'"
    exit 1
  fi
  if (( DRY_RUN )); then
    warn "--route-next cannot be combined with --dry-run"
    exit 1
  fi
fi
if (( HAVE_ROUTE_ISSUE )); then
  if (( HAVE_ROUTE_NEXT || DRY_RUN )); then
    warn "--route-issue cannot be combined with --route-next/--dry-run"
    exit 1
  fi
  if [[ ! "$ROUTE_ISSUE" =~ ^[0-9]+$ ]] || ! engine_known "$ROUTE_ISSUE_ENGINE"; then
    warn "--route-issue requires a numeric issue and an engine from etc/engines.json ($(engine_names | tr '\n' ' '))"
    exit 1
  fi
  if [[ -z "$ONLY_REPO" ]]; then
    warn "--route-issue requires --repo because issue numbers are per repository"
    exit 1
  fi
fi

if [[ -n "$ONLY_REPO" ]] && ! repo_path "$ONLY_REPO" >/dev/null; then
  warn "unknown repo '$ONLY_REPO' (known: $(repo_names | tr '\n' ' '))"
  exit 1
fi

# Defect repair is deliberately opt-in. Validate the entire allowlist before
# taking the lock, probing capacity, reading GitHub, or changing a label: a
# misspelled machine-local name must stop the tick without partial work.
defect_fix_enabled() {
  local wanted="$1" configured
  for configured in "${DEFECT_FIX_REPOS[@]-}"; do
    [[ "$configured" == "$wanted" ]] && return 0
  done
  return 1
}
for configured in "${DEFECT_FIX_REPOS[@]-}"; do
  [[ -z "$configured" ]] && continue
  if ! repo_path "$configured" >/dev/null; then
    warn "DEFECT_FIX_REPOS contains unknown repo '$configured' (known: $(repo_names | tr '\n' ' '))"
    exit 1
  fi
done

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
  if (( HAVE_ROUTE_NEXT || HAVE_ROUTE_ISSUE )); then
    warn "dispatch lock is busy — routing was not changed"
    exit 1
  fi
  say "previous tick still running — skipping"
  exit 0
fi

LAUNCHED=0
FAILED=0

# Strong-read an issue and resolve its routing label. No engine label means
# the host default (EPIC_ENGINE via etc/lib.sh, claude when unset). Any unknown or conflicting engine label
# is an error: silently guessing here would send work to the wrong vendor.
ISSUE_STATE=""
ISSUE_LABELS=""
ISSUE_LABEL_LIST=""
ISSUE_ENGINE=""
ISSUE_ENGINE_EXPLICIT=0
read_issue_engine() {
  local path="$1" n="$2" meta label count=0
  if ! meta="$(cd "$path" && gh issue view "$n" --json state,labels \
      --jq '.state, .labels[].name' 2>/dev/null)"; then
    return 1
  fi
  ISSUE_STATE="${meta%%$'\n'*}"
  if [[ "$meta" == *$'\n'* ]]; then
    ISSUE_LABEL_LIST="${meta#*$'\n'}"
  else
    ISSUE_LABEL_LIST=""
  fi
  ISSUE_LABELS="${ISSUE_LABEL_LIST//$'\n'/,}"
  ISSUE_ENGINE="$DEFAULT_ENGINE"
  ISSUE_ENGINE_EXPLICIT=0
  while IFS= read -r label; do
    case "$label" in
      engine:*)
        # Only a name the engines file knows; anything else is a conflict, not a hint.
        engine_known "${label#engine:}" || return 2
        ISSUE_ENGINE="${label#engine:}"
        ISSUE_ENGINE_EXPLICIT=1
        count=$((count + 1)) ;;
    esac
  done <<<"$ISSUE_LABEL_LIST"
  (( count <= 1 )) || return 2
  return 0
}

has_issue_label() {
  local wanted="$1" label
  while IFS= read -r label; do
    [[ "$label" == "$wanted" ]] && return 0
  done <<<"$ISSUE_LABEL_LIST"
  return 1
}

issue_is_ready() {
  [[ "$ISSUE_STATE" == "OPEN" ]] && has_issue_label ready \
    && ! has_issue_label in-progress \
    && ! has_issue_label failed \
    && ! has_issue_label ready-to-merge \
    && ! has_issue_label ready-to-review
}

write_issue_engine() {
  local path="$1" n="$2" engine="$3" other="" args
  if (( ISSUE_ENGINE_EXPLICIT )) && [[ "$ISSUE_ENGINE" != "$engine" ]]; then
    other="$ISSUE_ENGINE"
  fi
  (cd "$path" && gh label create "engine:$engine" --color 5319E7 \
    --description "Route autonomous pipeline runs to $engine" >/dev/null 2>&1) || true
  args=(issue edit "$n" --add-label "engine:$engine")
  [[ -z "$other" ]] || args+=(--remove-label "engine:$other")
  if ! (cd "$path" && gh "${args[@]}" >/dev/null 2>&1); then return 1; fi
  read_issue_engine "$path" "$n" \
    && [[ "$ISSUE_STATE" == "OPEN" && "$ISSUE_ENGINE" == "$engine" && $ISSUE_ENGINE_EXPLICIT -eq 1 ]]
}

if (( HAVE_ROUTE_ISSUE )); then
  route_path="$(repo_path "$ONLY_REPO")"
  if tmux has-session -t "=$ONLY_REPO-epic-$ROUTE_ISSUE" 2>/dev/null; then
    warn "#$ROUTE_ISSUE ($ONLY_REPO): pipeline session already exists — refusing to change its durable engine"
    exit 1
  fi
  if ! read_issue_engine "$route_path" "$ROUTE_ISSUE" || [[ "$ISSUE_STATE" != "OPEN" ]]; then
    warn "#$ROUTE_ISSUE ($ONLY_REPO): issue or engine routing is unreadable/invalid — not changing it"
    exit 1
  fi
  if ! write_issue_engine "$route_path" "$ROUTE_ISSUE" "$ROUTE_ISSUE_ENGINE"; then
    warn "#$ROUTE_ISSUE ($ONLY_REPO): could not persist and verify engine:$ROUTE_ISSUE_ENGINE"
    exit 1
  fi
  say "#$ROUTE_ISSUE ($ONLY_REPO): routed manual run to $ROUTE_ISSUE_ENGINE"
  exit 0
fi

# Admission state is loaded once after routing-only exits and before even the
# capacity probe. `status` may prune expired entries because fd 9 already owns
# the same lock every writer uses. Malformed or unreadable host state fails
# closed: absence is launchable, uncertainty is not. An active map does not end
# the tick; candidate_is_held applies it after each issue's engine is resolved.
HOLD_STATE='{}'
ACTIVE_HOLDS=0
if (( ! HAVE_ROUTE_NEXT )); then
  set +e
  HOLD_STATE="$(node "$HERE/../workflows/quota-hold.mjs" status 2>&1)"
  hold_rc=$?
  set -e
  case "$hold_rc" in
    0) ACTIVE_HOLDS=1 ;;
    1) HOLD_STATE='{}' ;;
    *)
      warn "provider quota hold state is unreadable — refusing to launch: ${HOLD_STATE:-unknown error}"
      exit 1 ;;
  esac
fi

HELD_DETAILS=""
candidate_is_held() { # resolved engine; 0 held, 1 clear, 2 invalid engine rows
  local engine="$1" vendors vendor hold_until
  HELD_DETAILS=""
  if ! vendors="$(engine_vendors "$engine")"; then
    return 2
  fi
  while IFS= read -r vendor; do
    [[ -n "$vendor" ]] || continue
    if hold_until="$(jq -er --arg vendor "$vendor" '.[$vendor].holdUntil' <<<"$HOLD_STATE" 2>/dev/null)"; then
      HELD_DETAILS="${HELD_DETAILS:+$HELD_DETAILS, }$vendor quota until $hold_until"
    fi
  done <<<"$vendors"
  [[ -n "$HELD_DETAILS" ]]
}

# ───────────────────────── Fixer walks ─────────────────────────
# Three queues, each selected by a durable label rather than comment prose:
# `needs-judgment` and `needs-ci-fix` are merge-worker decline classes resting
# at `failed`; `needs-defect-fix` is an epic-run ship-gate hold resting at
# `ready-to-review` and is walked only for repos in DEFECT_FIX_REPOS. Each
# carries its OWN attempt ladder — one PR can need all three, and
# a shared budget would let the first failure spend the second's retries. An
# exhausted ladder (the fixer gets one retry, then a human) stays out of its
# walk until a human strips those labels to grant another round.
#
# Walked in order, at most one launch of any kind per repo per tick: all rebase
# or amend the same branch against the same moving main.
FIXER_QUEUES=(
  "needs-judgment:fix-retried:--fix:conflict:failed"
  "needs-ci-fix:ci-retried:--ci:CI:failed"
  "needs-defect-fix:defect-retried:--defect:defect:ready-to-review"
)
fixer_queue() {
  local path="$1" label="$2" ladder="$3"
  (cd "$path" && gh issue list \
      --search "label:$label -label:$ladder sort:created-asc" \
      --state open --limit "$QUEUE_LIMIT" --json number --jq '.[].number')
}

# A full host must be known BEFORE a fixer's label swap: probing afterwards
# would churn failed/ready-to-review → in-progress → back on every tick. With no
# active holds, keep the eager check that avoids even reading the queues. With
# a hold map, delay it until an unheld candidate is otherwise eligible, so an
# all-held tick still reports every held issue and never probes capacity. Once
# a delayed probe finds the host full, the walk continues read-only to report
# later held candidates. launch.sh remains the one owner of the capacity count.
CAPACITY_CHECKED=0
HOST_AT_CAPACITY=0
CAPACITY_REPORTED=0
capacity_available() {
  local capacity_rc
  if (( CAPACITY_CHECKED )); then
    if (( HOST_AT_CAPACITY )); then
      return "$EXIT_AT_CAPACITY"
    fi
    return 0
  fi
  set +e
  "$LAUNCH" --check-capacity </dev/null 9>&-
  capacity_rc=$?
  set -e
  case "$capacity_rc" in
    0)
      CAPACITY_CHECKED=1
      return 0 ;;
    "$EXIT_AT_CAPACITY")
      CAPACITY_CHECKED=1
      HOST_AT_CAPACITY=1
      return "$EXIT_AT_CAPACITY" ;;
    *)
      return 1 ;;
  esac
}
report_capacity_once() {
  if (( ! CAPACITY_REPORTED )); then
    say "host at capacity — nothing can launch, continuing held-candidate reporting"
    CAPACITY_REPORTED=1
  fi
}

if (( ! DRY_RUN && ! HAVE_ROUTE_NEXT && ! ACTIVE_HOLDS )); then
  if capacity_available; then
    :
  else
    rc=$?
    case "$rc" in
      "$EXIT_AT_CAPACITY")
        say "host at capacity — nothing can launch, ending tick"
        exit 0 ;;
      *)
        warn "launch.sh rejected its configuration — aborting tick"
        exit 1 ;;
    esac
  fi
fi

if (( ! HAVE_ROUTE_NEXT )); then
for repo in $(repo_names); do
  [[ -z "$ONLY_REPO" || "$repo" == "$ONLY_REPO" ]] || continue
  path="$(repo_path "$repo")"
  [[ -d "$path/.git" ]] || continue    # the ready walk below reports this
  launched_fixer=0
  for spec in "${FIXER_QUEUES[@]}"; do
  IFS=: read -r QLABEL QLADDER QFLAG QKIND QREST <<<"$spec"
  if [[ "$QLABEL" == "needs-defect-fix" ]] && ! defect_fix_enabled "$repo"; then
    continue
  fi
  # Fail closed like the blocker check: a queue we could not read must not
  # launch — and must not stop the other queue or the other repos.
  if ! fixers="$(fixer_queue "$path" "$QLABEL" "$QLADDER" | tr '\n' ' ')"; then
    warn "$repo: $QLABEL queue query failed, skipping its fixer walk"
    continue
  fi
  fixers="${fixers% }"
  [[ -n "$fixers" ]] || continue
  say "$repo: $QLABEL: $fixers"

  # Serial per repo: every fixer rebases or amends against the same moving
  # main, so one runs at a time. Any candidate that still has a session — live,
  # just finished and not yet reaped, or dead and flagged for a human — parks
  # BOTH of the repo's fixer walks for this tick. (An issue the fixer is
  # working RIGHT NOW is still in its queue: the queue label only comes off on
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
    say "  #$busy ($repo): fixer session exists — repo's fixer walks wait"
    break
  fi

  for num in $fixers; do
    session="$repo-epic-$num"
    if ! read_issue_engine "$path" "$num"; then
      warn "  #$num ($repo): engine routing is unreadable, unknown, or conflicting — not launching"
      FAILED=$((FAILED + 1))
      continue
    fi
    admitted_engine="$ISSUE_ENGINE"
    if candidate_is_held "$ISSUE_ENGINE"; then
      say "  #$num: held ($HELD_DETAILS)"
      continue
    else
      admission_rc=$?
      if (( admission_rc == 2 )); then
        warn "  #$num ($repo): vendor set for engine '$ISSUE_ENGINE' is unreadable or invalid — not launching"
        FAILED=$((FAILED + 1))
        continue
      fi
    fi
    if (( ! DRY_RUN )); then
      if capacity_available; then
        :
      else
        rc=$?
        case "$rc" in
          "$EXIT_AT_CAPACITY")
            report_capacity_once
            continue ;;
          *)
            warn "launch.sh rejected its configuration — aborting tick"
            exit 1 ;;
        esac
      fi
    fi
    if (( DRY_RUN )); then
      say "  #$num ($repo): would launch $QKIND fixer '$session' with $ISSUE_ENGINE"
      LAUNCHED=$((LAUNCHED + 1))
      launched_fixer=1
      break
    fi

    # Swap the queue's resting terminal label → in-progress BEFORE launching,
    # here in the dispatcher. This
    # is NOT a claim (the tmux session name is the claim: launch.sh refuses a
    # duplicate, and this tick holds the flock) — it is a shield against the
    # reaper. Both `failed` and `ready-to-review` are terminal for reap's sweep,
    # and a fixer necessarily
    # launches more than TERMINAL_SETTLE_MINUTES after that label's last write
    # (its predecessor session had to settle and be reaped first, and nothing
    # touches the issue in between), so a session launched onto a still-failed
    # issue would be killed by the next sweep — a minute out — long before its
    # own prepare phase could swap the label. Swapping synchronously before
    # the launch is the only ordering that closes that window; a launch that
    # then fails reverts the swap so the issue goes back to the queue.
    (cd "$path" && gh label create in-progress --color FBCA04 \
        --description "Actively being worked by epic-run" >/dev/null 2>&1) || true
    if ! (cd "$path" && gh issue edit "$num" --remove-label "$QREST" --add-label in-progress >/dev/null 2>&1); then
      warn "  #$num ($repo): could not swap $QREST → in-progress — not launching (a terminal issue would be reaped out from under the fixer)"
      continue
    fi

    # The queue above rode gh's SEARCH index, which lags label edits by up to
    # about a minute — long enough for the documented human takeover
    # (stripping the queue label) to race this tick and win invisibly. Re-read
    # the issue directly (issue view is a strong read) AFTER the swap: if the
    # takeover happened, the swap just stripped the human's `failed` and a
    # launch would strand an unreapable in-progress session on an issue that
    # is no longer the fixer's. Revert and move on — fail closed on a read
    # that errors, for the same reason.
    if ! read_issue_engine "$path" "$num" \
        || [[ "$ISSUE_STATE" != "OPEN" ]] || ! has_issue_label "$QLABEL" || has_issue_label "$QLADDER" \
        || [[ "$ISSUE_ENGINE" != "$admitted_engine" ]]; then
      say "  #$num ($repo): issue changed under the queue or its engine routing no longer matches admission (state ${ISSUE_STATE:-unreadable}, labels ${ISSUE_LABELS:-none}) — reverting the swap, skipping"
      (cd "$path" && gh issue edit "$num" --add-label "$QREST" --remove-label in-progress >/dev/null 2>&1) \
        || warn "  #$num ($repo): the label revert failed too — issue may be stuck in-progress, fix by hand"
      continue
    fi

    say "  #$num ($repo): launching $QKIND fixer '$session' with $admitted_engine"
    launched_fixer=1
    set +e
    # </dev/null: nothing in launch.sh should ever read the tick's stdin;
    # 9>&- as in the ready walk below.
    "$LAUNCH" "$QFLAG" "$num" --repo "$repo" --engine "$admitted_engine" </dev/null 9>&-
    rc=$?
    set -e
    if (( rc != 0 )); then
      (cd "$path" && gh issue edit "$num" --add-label "$QREST" --remove-label in-progress >/dev/null 2>&1) \
        || warn "  #$num ($repo): launch failed AND the label revert failed — issue is stuck in-progress, fix by hand"
    fi
    case "$rc" in
      0) LAUNCHED=$((LAUNCHED + 1)) ;;
      "$EXIT_AT_CAPACITY")
        # Deferred, not failed: the revert above put the issue back in the
        # queue, and the next tick retries once reap frees a slot.
        if (( ACTIVE_HOLDS )); then
          CAPACITY_CHECKED=1
          HOST_AT_CAPACITY=1
          launched_fixer=0
          report_capacity_once
          continue
        fi
        say "host at capacity — ending tick with $LAUNCHED launched"
        exit 0 ;;
      1)
        warn "launch.sh rejected its configuration — aborting tick"
        exit 1 ;;
      *)
        warn "  #$num ($repo): $QKIND fixer launch failed (exit $rc), continuing"
        FAILED=$((FAILED + 1)) ;;
    esac
    break   # at most one fixer per repo per tick
  done
  # An `if`, never `(( x )) && break`: that list returns 1 when the flag is 0,
  # and under `set -e` a failing list at statement position ends the whole tick
  # — silently skipping the ready walk on every tick that launched no fixer.
  if (( launched_fixer )); then break; fi   # ...of any fixer kind
  done
done
fi

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
    return 2
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
    (( ! HAVE_ROUTE_NEXT )) || exit 1
    continue
  fi
  # A repo whose queue can't be read is reported and passed over; the other
  # repos still get their tick.
  if ! nums="$(queue "$path" | tr '\n' ' ')"; then
    warn "$repo: queue query failed, skipping this repo"
    (( ! HAVE_ROUTE_NEXT )) || exit 1
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
  if (( HAVE_ROUTE_NEXT )); then
    say "no unrouted, unblocked ready issue found"
  else
    say "nothing ready"
  fi
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
  # "=" pins the match, as in the fixer walk above: a bare -t matches prefixes,
  # so a live epic #263 would make this skip #26 as already running.
  if tmux has-session -t "=$session" 2>/dev/null; then
    say "  #$num ($repo): session '$session' exists, skipping"
    continue
  fi

  if unblocked "$path" "$num"; then
    :
  else
    blocker_rc=$?
    if (( HAVE_ROUTE_NEXT && blocker_rc == 2 )); then exit 1; fi
    continue
  fi

  if ! read_issue_engine "$path" "$num"; then
    warn "  #$num ($repo): engine routing is unreadable, unknown, or conflicting — not launching"
    if (( HAVE_ROUTE_NEXT )); then exit 1; fi
    FAILED=$((FAILED + 1))
    continue
  fi
  if ! issue_is_ready; then
    say "  #$num ($repo): issue changed under the queue (state ${ISSUE_STATE:-unreadable}, labels ${ISSUE_LABELS:-none}) — skipping"
    continue
  fi

  if (( HAVE_ROUTE_NEXT )); then
    if (( ISSUE_ENGINE_EXPLICIT )); then
      say "  #$num ($repo): already routed to $ISSUE_ENGINE, skipping"
      continue
    fi
    if ! write_issue_engine "$path" "$num" "$ROUTE_NEXT"; then
      warn "  #$num ($repo): could not assign engine:$ROUTE_NEXT"
      exit 1
    fi
    if ! issue_is_ready; then
      warn "  #$num ($repo): routing write could not be verified or issue changed — refusing success"
      exit 1
    fi
    say "  #$num ($repo): routed next epic to $ROUTE_NEXT"
    exit 0
  fi

  if candidate_is_held "$ISSUE_ENGINE"; then
    say "  #$num: held ($HELD_DETAILS)"
    continue
  else
    admission_rc=$?
    if (( admission_rc == 2 )); then
      warn "  #$num ($repo): vendor set for engine '$ISSUE_ENGINE' is unreadable or invalid — not launching"
      FAILED=$((FAILED + 1))
      continue
    fi
  fi

  if (( ! DRY_RUN )); then
    if capacity_available; then
      :
    else
      rc=$?
      case "$rc" in
        "$EXIT_AT_CAPACITY")
          report_capacity_once
          continue ;;
        *)
          warn "launch.sh rejected its configuration — aborting tick"
          exit 1 ;;
      esac
    fi
  fi

  if (( DRY_RUN )); then
    say "  #$num ($repo): would launch '$session' with $ISSUE_ENGINE"
    LAUNCHED=$((LAUNCHED + 1))
    continue
  fi

  say "  #$num ($repo): launching '$session' with $ISSUE_ENGINE"
  set +e
  # 9>&- so the tmux server this may start cannot inherit the tick lock; see
  # the flock comment above for what that costs when it leaks.
  "$LAUNCH" --epic "$num" --repo "$repo" --engine "$ISSUE_ENGINE" 9>&-
  rc=$?
  set -e
  case "$rc" in
    0) LAUNCHED=$((LAUNCHED + 1)) ;;
    "$EXIT_AT_CAPACITY")
      if (( ACTIVE_HOLDS )); then
        CAPACITY_CHECKED=1
        HOST_AT_CAPACITY=1
        report_capacity_once
        continue
      fi
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

if (( HAVE_ROUTE_NEXT )); then
  say "no unrouted, unblocked ready issue found"
  exit 0
fi

if (( DRY_RUN )); then
  say "dry run: $LAUNCHED would launch (capacity not simulated)"
  if (( FAILED != 0 )); then exit 1; fi
  exit 0
fi
say "tick done, $LAUNCHED launched, $FAILED failed"
(( FAILED == 0 ))
