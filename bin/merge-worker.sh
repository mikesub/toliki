#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host (cron, fanned out per repo by bin/merge-tick.sh), one
# invocation per repo. Drains the epic pipeline's
# finished PRs into main: an issue labelled `ready-to-merge` is one whose run
# cleared every gate and left no human decision behind, and this script is the
# only thing that merges it.
#
# STRICTLY SERIAL, and that is the point rather than a simplification. Every
# merge moves origin/main, so each PR still queued behind it is left holding CI
# that was computed against a base that no longer exists. Each PR is therefore
# rebased onto the current main, re-pushed, and its checks RE-RUN before it
# merges — merging on the pre-rebase green would assert a check that never ran
# against what is landing. Two workers on one repo would each invalidate the
# very run the other is waiting on, so there is no parallelism to recover here:
# flock keeps invocations from overlapping, the drain loop keeps it to one PR
# at a time inside a run. Across repos there is nothing to serialize — separate
# mains — so each repo gets its own invocation and its own lock.
#
# It never fixes anything. A rebase conflict, a red check, or a failed merge
# flips the issue to `failed` with a comment naming which, and the drain moves
# on to the next PR. A human resolves it.
#
# Infrastructure failures (fetch, gh API) abort the run instead of labelling
# anything: cron retries on the next tick, and a network hiccup must never
# write `failed` onto an issue whose PR is perfectly fine.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

REPO="$DEFAULT_REPO"
# Cap the wait rather than hanging: an unconcluded CI run is a failure a human
# needs to see, not a reason to hold the queue open indefinitely.
CI_TIMEOUT="${MERGE_CI_TIMEOUT:-1800}"   # ~30 min
CI_POLL="${MERGE_CI_POLL:-20}"
# Backstop only. The loop terminates on its own (merging closes the issue,
# failing strips the label, so either way it leaves the queue) — this bounds a
# bug, and a run that hits it says so rather than looking like a clean drain.
MAX_DRAIN=20

# Every line carries the run's UTC timestamp (ts is in etc/lib.sh).
say()  { printf '%s [merge] %s\n' "$(ts)" "$*"; }
# Infrastructure died: stop the whole drain, label nothing, let cron retry.
die()  { printf '%s [merge] %s\n' "$(ts)" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $0 [-r <repo>]

Merges every open PR whose issue carries \`ready-to-merge\`, oldest issue first,
one at a time, into $DEFAULT_REPO's main (or -r <repo>: $(repo_names | tr '\n' ' ')).
Each PR is rebased onto the current origin/main and its CI re-run before it
merges. Anything that fails leaves the PR open and flips its issue to \`failed\`.
Exits 0 doing nothing if another invocation for the same repo is still running.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -r|--repo)
      if [[ $# -lt 2 ]]; then die "$1 requires a value"; fi
      REPO="$2"; shift 2 ;;
    -r=*|--repo=*) REPO="${1#*=}"; shift ;;
    *) usage >&2; die "unexpected argument '$1'" ;;
  esac
done

if ! PROJECT="$(repo_path "$REPO")"; then
  die "unknown repo '$REPO' (known: $(repo_names | tr '\n' ' '))"
fi
# The gh slug rather than the clone's cwd: every gh call is explicit about which
# repo it targets, so the worker is not one `cd` away from acting on the wrong one.
if ! ORIGIN="$(repo_origin "$REPO")"; then
  die "repo '$REPO' has no entry in REPO_ORIGINS — add one to etc/repos.conf"
fi

for tool in git gh jq flock; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed — run bin/provision.sh"
done

# One lock per repo. Non-blocking and exit 0: a still-draining predecessor is
# the normal case under cron, not an error worth mailing the operator about.
exec 9>"/tmp/merge-worker-$REPO.lock"
if ! flock -n 9; then
  say "$REPO: another merge-worker is still draining — nothing to do"
  exit 0
fi

# Merging happens in a dedicated worktree, never in $PROJECT: launch.sh assumes
# that clone sits on main, and a rebase parks it on a detached epic head — which
# would only surface later, as a session that built from the wrong base.
WT="${MERGE_WORKTREE_ROOT:-$HOME/.merge-worker}/$REPO"

ensure_worktree() {
  if [[ -d "$WT" ]] && git -C "$WT" rev-parse --git-dir >/dev/null 2>&1; then
    # Scrub whatever a killed run left behind, in the order that actually clears
    # it: an interrupted rebase holds state that reset alone will not drop.
    git -C "$WT" rebase --abort >/dev/null 2>&1 || true
    git -C "$WT" reset --hard  >/dev/null 2>&1 || true
    git -C "$WT" clean -fdx    >/dev/null 2>&1 || true
    return 0
  fi
  rm -rf "$WT"
  mkdir -p "$(dirname "$WT")"
  git -C "$PROJECT" worktree prune
  git -C "$PROJECT" worktree add --detach "$WT" HEAD >/dev/null \
    || die "$REPO: could not create the merge worktree at $WT"
  say "$REPO: created merge worktree $WT"
}

# ---------------------------------------------------------------- reporting --

FAIL=""     # why this PR could not be merged; consumed by mark_failed
PR_URL=""   # the PR merge_one last looked at, so a failure report can name it

mark_failed() {
  local issue="$1" pr_url="$2" reason="$3"
  say "$REPO: #$issue -> failed ($reason)"
  gh issue comment "$issue" -R "$ORIGIN" --body-file - <<EOF || say "$REPO: could not comment on #$issue"
🤖 merge-worker blocked
- repo: $REPO
- pr: $pr_url
- reason: $reason

The PR is open and NOT merged; the change itself is complete. Fix the cause
above and merge it by hand — the worker does not retry, and re-running /epic on
this issue will skip it while the PR is open.
EOF
  gh label create failed -R "$ORIGIN" --color B60205 \
    --description "epic-run stopped at a blocker; needs human attention" >/dev/null 2>&1 || true
  gh issue edit "$issue" -R "$ORIGIN" \
    --remove-label ready-to-merge --add-label failed >/dev/null 2>&1 \
    || say "$REPO: could not relabel #$issue"
}

# ------------------------------------------------------------------- checks --

# Wait for the checks on exactly $2 (the rebased head). Keyed on the sha rather
# than "the PR's checks" on purpose: right after a force-push the PR still
# reports the pre-rebase run, and treating that as this commit's result is the
# stale-green merge the rebase exists to prevent.
wait_for_ci() {
  local pr="$1" want="$2"
  local deadline=$(( SECONDS + CI_TIMEOUT )) saw_any=0
  # `bad` rather than `failed` on purpose — the drain loop below counts into a
  # global of that name, and a local would quietly shadow it.
  local json head total pending bad

  while (( SECONDS < deadline )); do
    json="$(gh pr view "$pr" -R "$ORIGIN" --json headRefOid,statusCheckRollup 2>/dev/null)" \
      || die "$REPO: gh pr view #$pr failed while watching checks — aborting the run"

    head="$(jq -r '.headRefOid' <<<"$json")"
    if [[ "$head" != "$want" ]]; then
      sleep "$CI_POLL"; continue          # the force-push has not registered yet
    fi

    total="$(jq '(.statusCheckRollup // []) | length' <<<"$json")"
    if (( total == 0 )); then
      sleep "$CI_POLL"; continue          # workflows have not started yet
    fi
    saw_any=1

    pending="$(jq '[(.statusCheckRollup // [])[] | select(
        (.__typename == "CheckRun"      and .status != "COMPLETED") or
        (.__typename == "StatusContext" and (.state == "PENDING" or .state == "EXPECTED"))
      )] | length' <<<"$json")"
    if (( pending > 0 )); then
      sleep "$CI_POLL"; continue
    fi

    # Skipped and neutral count as success — this repo's deploy jobs are skipped
    # on PRs by design. A missing conclusion counts as failure, not as green.
    bad="$(jq -r '[(.statusCheckRollup // [])[] | select(
        (.__typename == "CheckRun" and .status == "COMPLETED"
           and (.conclusion as $c | (["SUCCESS","SKIPPED","NEUTRAL"] | index($c)) | not)) or
        (.__typename == "StatusContext" and .state != "SUCCESS"
           and .state != "PENDING" and .state != "EXPECTED")
      ) | (.name // .context // "check")] | join(", ")' <<<"$json")"

    if [[ -n "$bad" ]]; then
      FAIL="PR checks failed on the rebased head $want: $bad"
      return 1
    fi
    return 0
  done

  if (( saw_any )); then
    FAIL="PR checks did not conclude within $((CI_TIMEOUT / 60)) minutes of the rebase"
  else
    FAIL="no PR checks ever registered on the rebased head $want within $((CI_TIMEOUT / 60)) minutes"
  fi
  return 1
}

# ------------------------------------------------------------------ one PR --

# 0 = merged by this run, 2 = already landed (nothing to do), 1 = failed with
# $FAIL set. 2 is distinct from 0 so the run's summary can't claim a merge it
# did not perform.
merge_one() {
  local issue="$1" pr branch head rebased state
  PR_URL=""

  pr="$(gh pr list -R "$ORIGIN" --state open --json number,headRefName --limit 100 2>/dev/null \
        | jq -r --arg pfx "epic/$issue-" '[.[] | select(.headRefName | startswith($pfx))][0].number // empty')" \
    || die "$REPO: could not list open PRs — aborting the run"

  if [[ -z "$pr" ]]; then
    # No open PR. Either it already merged and the issue simply did not close,
    # or the label is pointing at nothing — very different problems.
    local merged
    merged="$(gh pr list -R "$ORIGIN" --state merged --json number,headRefName --limit 50 2>/dev/null \
              | jq -r --arg pfx "epic/$issue-" '[.[] | select(.headRefName | startswith($pfx))][0].number // empty')" \
      || die "$REPO: could not list merged PRs — aborting the run"
    if [[ -n "$merged" ]]; then
      say "$REPO: #$issue was already delivered by merged PR #$merged — dropping the label"
      gh issue edit "$issue" -R "$ORIGIN" --remove-label ready-to-merge >/dev/null 2>&1 || true
      return 2
    fi
    FAIL="issue is labelled ready-to-merge but has no PR on an epic/$issue-* branch"
    return 1
  fi

  local meta
  meta="$(gh pr view "$pr" -R "$ORIGIN" --json url,state,headRefName,headRefOid 2>/dev/null)" \
    || die "$REPO: gh pr view #$pr failed — aborting the run"
  PR_URL="$(jq -r .url        <<<"$meta")"
  state="$(jq -r .state       <<<"$meta")"
  branch="$(jq -r .headRefName <<<"$meta")"
  head="$(jq -r .headRefOid   <<<"$meta")"

  case "$state" in
    MERGED)
      say "$REPO: PR #$pr already merged — dropping the label on #$issue"
      gh issue edit "$issue" -R "$ORIGIN" --remove-label ready-to-merge >/dev/null 2>&1 || true
      return 2 ;;
    CLOSED)
      FAIL="PR #$pr was closed without merging"
      return 1 ;;
  esac

  say "$REPO: #$issue -> PR #$pr ($branch)"
  ensure_worktree
  git -C "$WT" fetch origin --prune --quiet \
    || die "$REPO: git fetch failed — aborting the run"

  # Merge exactly the head the PR reported. Anything else moved the branch out
  # from under us (a live run re-shipping, or a human), which a worker that
  # never fixes anything must not merge through.
  local remote_head
  remote_head="$(git -C "$WT" rev-parse --verify --quiet "refs/remotes/origin/$branch" || true)"
  if [[ -z "$remote_head" ]]; then
    FAIL="branch $branch is not on origin"
    return 1
  fi
  if [[ "$remote_head" != "$head" ]]; then
    FAIL="branch $branch moved under the worker (PR head $head, origin now $remote_head)"
    return 1
  fi

  git -C "$WT" checkout -f --detach --quiet "$head" \
    || die "$REPO: could not check out $head — aborting the run"

  if ! git -C "$WT" rebase origin/main >/dev/null 2>&1; then
    git -C "$WT" rebase --abort >/dev/null 2>&1 || true
    FAIL="rebase of $branch onto origin/main conflicted"
    return 1
  fi
  rebased="$(git -C "$WT" rev-parse HEAD)"

  if [[ "$rebased" == "$head" ]]; then
    # Already on top of the current main, so the checks it already has were
    # computed against this exact base. Re-pushing an identical sha would be a
    # no-op that triggers no new run, and waiting on one would just time out.
    say "$REPO: PR #$pr is already on current main — reusing its existing checks"
  else
    say "$REPO: PR #$pr rebased $head -> $rebased, re-pushing"
    # Lease against the head we inspected: the push fails rather than clobbers
    # if anything moved the branch since.
    git -C "$WT" push --quiet --force-with-lease="refs/heads/$branch:$head" \
        origin "HEAD:refs/heads/$branch" 2>/dev/null \
      || { FAIL="force-with-lease push of the rebased $branch was rejected"; return 1; }
  fi

  say "$REPO: PR #$pr waiting on checks for $rebased"
  wait_for_ci "$pr" "$rebased" || return 1

  # The branch holds exactly one commit (ship squashed it; rebasing one commit
  # yields one), so --squash preserves its message and its `Closes #N`.
  # No other flags, ever: --admin would merge past the gates this whole script
  # exists to honour, and GitHub deletes the remote branch itself on merge.
  if ! gh pr merge "$pr" -R "$ORIGIN" --squash >/dev/null 2>&1; then
    FAIL="squash-merge of PR #$pr failed after its checks passed"
    return 1
  fi

  state="$(gh pr view "$pr" -R "$ORIGIN" --json state --jq .state 2>/dev/null)" || state="?"
  if [[ "$state" != "MERGED" ]]; then
    FAIL="gh pr merge reported success but PR #$pr is $state, not MERGED"
    return 1
  fi

  # Belt and braces. The `Closes #N` in the commit closes the issue and the
  # repo's cleanup Action strips the lifecycle labels, but neither is this
  # script's to verify — and a label left on a closed issue is invisible here
  # (the drain queries open issues only) while still being wrong.
  gh issue edit "$issue" -R "$ORIGIN" --remove-label ready-to-merge >/dev/null 2>&1 || true
  say "$REPO: PR #$pr squash-merged — CI + Deploy is now running on main"
  return 0
}

# ------------------------------------------------------------------- drain --

merged=0 failed=0 landed=0 n=0
# Issues this drain has already handled, on any path. The queue query rides
# GitHub's search index, which is eventually consistent and lags this run's
# own label writes — an issue relabelled seconds ago can still come back, and
# acting on it again fails it twice with a second identical comment. The
# first unseen issue is the queue's real head; nothing but repeats is a
# drained queue.
seen=" "
while (( n < MAX_DRAIN )); do
  # Re-queried every pass: our own last merge moved main, and a run that
  # finished while we waited belongs at the back of this same drain.
  queue="$(gh issue list -R "$ORIGIN" --search "label:ready-to-merge sort:created-asc" \
             --state open --json number --limit 50 2>/dev/null \
           | jq -r '.[].number')" \
    || die "$REPO: could not list ready-to-merge issues — aborting the run"
  issue=""
  for q in $queue; do
    [[ "$seen" == *" $q "* ]] || { issue="$q"; break; }
  done
  [[ -n "$issue" ]] || break
  seen="$seen$issue "

  n=$(( n + 1 ))
  FAIL=""
  merge_one "$issue" && rc=0 || rc=$?
  case "$rc" in
    0) merged=$(( merged + 1 )) ;;
    2) landed=$(( landed + 1 )) ;;
    *) failed=$(( failed + 1 )); mark_failed "$issue" "${PR_URL:-none found}" "$FAIL" ;;
  esac
done

if (( n >= MAX_DRAIN )); then
  say "$REPO: stopped at the $MAX_DRAIN-PR cap with work still queued — investigate before the next tick"
fi
# Only when something actually happened. An empty drain is the overwhelmingly
# common case — one tick per repo per minute, ~4k lines a day of "0 merged, 0
# failed" — and that is not merely noise: it buries the real entries so deep
# that a `tail` of this log cannot reach them, which is exactly how /triage is
# told to explain a stuck ready-to-merge. A log that is unreadable at the
# moment it matters is worse than a short one. Cron liveness is unaffected:
# dispatch.sh and reap.sh still log every tick to their own files.
if (( merged || failed || landed )); then
  say "$REPO: drain done — $merged merged, $failed failed$( (( landed )) && printf ', %s already landed' "$landed" || true)"
fi
