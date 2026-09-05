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
# merges when the repo publishes checks — merging on the pre-rebase green would
# assert a check that never ran against what is landing. A repo that publishes
# no checks is allowed through after a short registration grace; the grace keeps
# an asynchronous workflow start from looking like a no-CI repo. Two workers on
# one repo would each invalidate the
# very run the other is waiting on, so there is no parallelism to recover here:
# flock keeps invocations from overlapping, the drain loop keeps it to one PR
# at a time inside a run. Across repos there is nothing to serialize — separate
# mains — so each repo gets its own invocation and its own lock.
#
# It never exercises judgment, and the one thing it fixes is proved rather
# than guessed: a rebase conflict whose EVERY hunk is mechanical — both sides
# only added at the same point (empty base), or exactly one side edited base
# lines the other merely added around — is resolved by construction in
# bin/merge-autoresolve.sh, verified by literal line containment before
# anything is pushed, and then gated by CI on the rebased head like any other
# rebase. No model, no session; a single hunk where both sides touched the
# same lines declines the whole PR. Everything else stays unfixed: a judgment
# conflict, a red check, or a failed merge flips the issue to `failed` with a
# comment naming which, and the drain moves on to the next PR. The one nuance
# is WHO resolves it. Two decline classes are automated rather than human:
# a judgment-class conflict (exit 4 from merge-autoresolve) also gets
# `needs-judgment`, whose fixer resolves the hunks under an adversarial gate
# and lands the issue back on ready-to-merge; a RED check on the rebased head
# also gets `needs-ci-fix`, whose fixer repairs the cause under an adversarial
# check and lands it back on ready-to-merge too — where this worker rebases and
# re-runs those same checks before anything merges, so neither repair can land
# on a check it broke. A registered check that times out is infrastructure, not
# a red check, and waits for a human like every other failure. No registered
# checks after the grace is the supported no-CI case and clears the check gate
# without inventing a green result.
#
# Infrastructure failures (fetch, gh API) abort the run instead of labelling
# anything: cron retries on the next tick, and a network hiccup must never
# write `failed` onto an issue whose PR is perfectly fine. Queries abort on any
# error, since a query that failed carries no verdict to record. The merge
# itself cannot — a merge gh genuinely refuses IS this PR's verdict — so it
# classifies the error text instead (transient_gh_error) and aborts only on an
# infrastructure signature; likewise the read-back that confirms the merge,
# where a failed read is not evidence the merge did not happen.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

REPO="$DEFAULT_REPO"
# Cap the wait rather than hanging: an unconcluded CI run is a failure a human
# needs to see, not a reason to hold the queue open indefinitely.
CI_TIMEOUT="${MERGE_CI_TIMEOUT:-1800}"   # ~30 min
CI_POLL="${MERGE_CI_POLL:-20}"
# GitHub briefly reports an empty check rollup after a force-push even in repos
# with CI. Only treat the empty rollup as a no-CI repo once the exact rebased
# head has stayed visible for this long.
CI_REGISTRATION_GRACE="${MERGE_CI_REGISTRATION_GRACE:-60}"
# Backstop only. The loop terminates on its own (merging closes the issue,
# failing strips the label, so either way it leaves the queue) — this bounds a
# bug, and a run that hits it says so rather than looking like a clean drain.
MAX_DRAIN=20

# Every line carries the run's configured host-zone timestamp (ts is in
# etc/lib.sh).
say()  { printf '%s [merge] %s\n' "$(ts)" "$*"; }
# Infrastructure died: stop the whole drain, label nothing, let cron retry.
die()  { printf '%s [merge] %s\n' "$(ts)" "$*" >&2; exit 1; }

# Every other gh call here fails closed by aborting, because a query that
# errors carries no verdict. The write calls cannot do that blindly — a merge
# gh genuinely refuses is a real decline the issue must record — so they
# classify instead, and this is the classifier. It reads the error TEXT because
# exit status cannot tell "GitHub is down" from "GitHub said no": both are 1.
# Deliberately generous, since the two mistakes are not symmetric — calling a
# real refusal transient costs one wasted tick that re-runs and reports it
# properly, while calling an outage a refusal writes `failed` onto a PR that
# was fine and takes a human to undo. Seen live during the 2026-08-17 incident:
# a 503 on `gh pr merge` failed an issue whose PR was perfectly mergeable, and
# only a second 503 on the relabel kept the verdict from sticking.
transient_gh_error() {
  printf '%s' "$1" | grep -qiE \
    'HTTP (408|429|5[0-9][0-9])|no server is currently available|bad gateway|service unavailable|gateway time-?out|server error|timed? ?out|timeout|connection (reset|refused|closed)|could not resolve host|network is unreachable|temporary failure|unexpected EOF|TLS handshake|deadline exceeded'
}

usage() {
  cat <<EOF
Usage: $0 [-r <repo>]

Merges every open PR whose issue carries \`ready-to-merge\`, oldest issue first,
one at a time, into $DEFAULT_REPO's main (or -r <repo>: $(repo_names | tr '\n' ' ')).
Each PR is rebased onto the current origin/main. Repos that publish checks wait
for them to re-run; repos with no checks clear that gate after a short
registration grace. A rebase conflict whose hunks are all mechanical (both
sides added at the same point, or one side edited base lines the other only
added around) is auto-resolved, containment-verified and CI-gated; a conflict that needs
judgment flips its issue to \`failed\` plus \`needs-judgment\`, and a red check to
\`failed\` plus \`needs-ci-fix\` (both automated fixer queues
dispatch drains); anything else that fails leaves the PR open and flips its
issue to plain \`failed\`.
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
NEEDS_JUDGMENT=0   # the decline was judgment-class (merge-autoresolve exit 4)
NEEDS_CI_FIX=0     # the decline was a RED check on the rebased head

mark_failed() {
  local issue="$1" pr_url="$2" reason="$3" next
  say "$REPO: #$issue -> failed ($reason)"
  if (( NEEDS_JUDGMENT )); then
    # This class does not wait for a human: `needs-judgment` is the fixer
    # queue, and dispatch launches a session against it on its next tick.
    next="The PR is open and NOT merged; the change itself is complete. The conflict
needs judgment, so this issue is queued for an automated fixer session:
dispatch launches one that resolves the judgment hunks under an adversarial
gate, re-verifies, and puts the issue back on ready-to-merge — where this
worker rebases it and re-runs the checks before anything lands. Nothing to do
unless it comes back failed again with the fixer's own blocker comment."
  elif (( NEEDS_CI_FIX )); then
    # Also automated: `needs-ci-fix` is the CI fixer's queue. It lands the
    # issue back on ready-to-merge, and this worker then rebases and re-runs
    # these same checks before anything merges — so a fix that is still red
    # cannot land.
    next="The PR is open and NOT merged; the checks are red on the rebased head, so
this issue is queued for an automated CI fixer session: dispatch launches one
that reads the failing job logs, fixes the cause, re-verifies, and puts the
issue back on ready-to-merge under an adversarial check. Nothing to do unless
it comes back failed again with the fixer's own blocker comment."
  else
    next="The PR is open and NOT merged; the change itself is complete. Fix the cause
above, push, and swap \`failed\` → \`ready-to-merge\`: the worker does not retry on
its own, and that swap is the retry — it rebases, re-runs the checks and lands
the PR itself. Do not merge by hand. Re-running /epic on this issue will skip it
while the PR is open."
  fi
  gh issue comment "$issue" -R "$ORIGIN" --body-file - <<EOF || say "$REPO: could not comment on #$issue"
🤖 merge-worker blocked
- repo: $REPO
- pr: $pr_url
- reason: $reason

$next
EOF
  gh label create failed -R "$ORIGIN" --color B60205 \
    --description "epic-run stopped at a blocker; needs human attention" >/dev/null 2>&1 || true
  if (( NEEDS_JUDGMENT )); then
    gh label create needs-judgment -R "$ORIGIN" --color D93F0B \
      --description "rebase conflict needs judgment — queued for an automated fixer session" >/dev/null 2>&1 || true
    gh issue edit "$issue" -R "$ORIGIN" \
      --remove-label ready-to-merge --add-label failed --add-label needs-judgment >/dev/null 2>&1 \
      || say "$REPO: could not relabel #$issue"
  elif (( NEEDS_CI_FIX )); then
    gh label create needs-ci-fix -R "$ORIGIN" --color D93F0B \
      --description "checks were red on the rebased head — queued for an automated CI fixer session" >/dev/null 2>&1 || true
    gh issue edit "$issue" -R "$ORIGIN" \
      --remove-label ready-to-merge --add-label failed --add-label needs-ci-fix >/dev/null 2>&1 \
      || say "$REPO: could not relabel #$issue"
  else
    gh issue edit "$issue" -R "$ORIGIN" \
      --remove-label ready-to-merge --add-label failed >/dev/null 2>&1 \
      || say "$REPO: could not relabel #$issue"
  fi
}

# An auto-resolved conflict is recorded on the issue, not only in this log:
# the resolution rewrote lines nobody reviewed, so the audit trail — which
# files, which hunks, which class — has to live where a human will look.
# Best-effort like mark_failed's comment; the merge itself is not held on it.
record_autoresolve() {
  local issue="$1" details="$2"
  gh issue comment "$issue" -R "$ORIGIN" --body-file - <<EOF || say "$REPO: could not comment on #$issue"
🤖 merge-worker auto-resolved a rebase conflict
- repo: $REPO
- pr: $PR_URL

Rebasing onto origin/main conflicted, and every hunk was mechanical — no
judgment involved, so none was exercised:

$(sed 's/^/- /' <<<"$details")

The resolution was verified by literal line containment (every line of both
sides survived) before anything was pushed. CI re-runs on the rebased head
before the merge when this repo publishes checks; a no-CI repo is recognized
only after the check-registration grace.
EOF
}

# ------------------------------------------------------------------- checks --

# Evaluate checks on exactly $2 (the rebased head). Keyed on the sha rather than
# "the PR's checks" on purpose: right after a force-push the PR still reports
# the pre-rebase run, and treating that as this commit's result is the
# stale-green merge the rebase exists to prevent. Once that exact head remains
# visible with an empty rollup for CI_REGISTRATION_GRACE, the repo is treated as
# having no CI and the gate clears without fabricating a check result.
wait_for_ci() {
  local pr="$1" want="$2"
  local deadline=$(( SECONDS + CI_TIMEOUT )) saw_any=0 head_visible_at=-1
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
    if (( head_visible_at < 0 )); then head_visible_at=$SECONDS; fi

    total="$(jq '(.statusCheckRollup // []) | length' <<<"$json")"
    if (( total == 0 )); then
      # Once a check has appeared, an empty rollup is not evidence that this is
      # a no-CI repo. Keep waiting so a disappearing or incomplete API view
      # cannot erase a real gate.
      if (( saw_any )); then
        sleep "$CI_POLL"; continue
      fi
      if (( SECONDS - head_visible_at < CI_REGISTRATION_GRACE )); then
        sleep "$CI_POLL"; continue        # give asynchronous workflows time to register
      fi
      say "$REPO: PR #$pr has no checks after ${CI_REGISTRATION_GRACE}s on $want — treating it as a no-CI repo"
      return 0
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
      # The one decline class where the code is genuinely wrong and a fixer has
      # something to act on. A registered check timeout is infrastructure and
      # falls through to a plain `failed` below.
      NEEDS_CI_FIX=1
      FAIL="PR checks failed on the rebased head $want: $bad"
      return 1
    fi
    return 0
  done

  if (( head_visible_at < 0 )); then
    FAIL="PR head did not become the rebased head $want within $((CI_TIMEOUT / 60)) minutes"
  elif (( saw_any )); then
    FAIL="PR checks did not conclude within $((CI_TIMEOUT / 60)) minutes of the rebase"
  else
    # A configured grace longer than the overall timeout must not turn no CI
    # back into a failure. The timeout itself is enough registration grace.
    say "$REPO: PR #$pr has no checks within the ${CI_TIMEOUT}s check window on $want — treating it as a no-CI repo"
    return 0
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
  NEEDS_JUDGMENT=0
  NEEDS_CI_FIX=0

  # Every open PR on the issue's branch prefix, not just the first: one issue is
  # one branch is one PR, so two of them means something outside this worker's
  # model happened, and picking one to merge would be a guess about which change
  # the issue actually asked for.
  local pr_nums pr_count
  pr_nums="$(gh pr list -R "$ORIGIN" --state open --json number,headRefName --limit 100 2>/dev/null \
        | jq -r --arg pfx "epic/$issue-" '[.[] | select(.headRefName | startswith($pfx))][].number')" \
    || die "$REPO: could not list open PRs — aborting the run"
  pr_count="$(grep -c . <<<"$pr_nums" || true)"
  if (( pr_count > 1 )); then
    FAIL="$pr_count open PRs on epic/$issue-* branches (#$(tr '\n' ' ' <<<"$pr_nums" | sed 's/ $//' | sed 's/ / #/g')) — ambiguous, so nothing was merged; close the ones that do not deliver this issue"
    return 1
  fi
  pr="$(head -n 1 <<<"$pr_nums")"

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

  # diff3 markers on purpose: they carry the base section, which is what lets
  # merge-autoresolve.sh tell "both sides added here" from "both sides edited
  # the same lines" when the rebase stops.
  if ! git -C "$WT" -c merge.conflictStyle=diff3 rebase origin/main >/dev/null 2>&1; then
    local resolution arc=0
    resolution="$("$HERE/merge-autoresolve.sh" "$WT" 2>&1)" || arc=$?
    if (( arc == 0 )); then
      say "$REPO: PR #$pr rebase conflicted; every hunk was mechanical - auto-resolved"
      record_autoresolve "$issue" "$resolution"
    else
      git -C "$WT" rebase --abort >/dev/null 2>&1 || true
      # Exit 4 is the judgment class — mark_failed adds `needs-judgment` on
      # top of `failed`, which is what dispatch's fixer walk queries.
      if (( arc == 4 )); then
        NEEDS_JUDGMENT=1
        FAIL="rebase of $branch onto origin/main conflicted; needs judgment: $(head -n 1 <<<"$resolution")"
      else
        FAIL="rebase of $branch onto origin/main conflicted; not auto-resolvable: $(head -n 1 <<<"$resolution")"
      fi
      return 1
    fi
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
  #
  # --match-head-commit pins the merge to the EXACT sha whose check gate this
  # run evaluated. Without it, the window between wait_for_ci returning and
  # this call is a stale-green hole: anything that pushed to the branch in
  # between — a fixer session, a human, a racing worker — would merge on the
  # previous head's result, which is the one failure this script exists to
  # prevent. GitHub refuses instead, and the next tick re-rebases and re-runs
  # the checks on whatever the branch has become.
  #
  # Those are the only two flags, ever: --admin would merge past the gates this
  # script exists to honour, and GitHub deletes the remote branch on merge.
  local merge_err merge_rc=0
  merge_err="$(gh pr merge "$pr" -R "$ORIGIN" --squash --match-head-commit "$rebased" 2>&1)" || merge_rc=$?
  if (( merge_rc != 0 )); then
    # A refusal is this PR's verdict; an outage is nobody's. Aborting leaves
    # the label on, so the next tick re-runs the whole merge — and if this call
    # actually landed before the error reached us, that tick finds the merged
    # PR through the already-delivered branch above and settles the label there.
    if transient_gh_error "$merge_err"; then
      die "$REPO: squash-merge of PR #$pr hit a transient GitHub error — aborting the run, the next tick retries ($(head -n 1 <<<"$merge_err"))"
    fi
    FAIL="squash-merge of PR #$pr failed after its check gate cleared: $(head -n 1 <<<"$merge_err")"
    return 1
  fi

  # Confirm the merge rather than trust the exit status — but a read-back that
  # FAILS is not evidence the merge did not happen, and mid-incident it is the
  # likeliest outcome. Guessing here is how a landed PR gets its issue marked
  # `failed`, so don't: abort and let the next tick reconcile it as above.
  local state_out state_rc=0
  state_out="$(gh pr view "$pr" -R "$ORIGIN" --json state --jq .state 2>&1)" || state_rc=$?
  if (( state_rc != 0 )); then
    die "$REPO: PR #$pr reported merged but reading its state back failed — aborting the run, the next tick reconciles it ($(head -n 1 <<<"$state_out"))"
  fi
  state="$state_out"
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
# that a `tail` of this log cannot reach them, which is exactly how /toliki is
# told to explain a stuck ready-to-merge. A log that is unreadable at the
# moment it matters is worse than a short one. Cron liveness is unaffected:
# dispatch.sh and reap.sh still log every tick to their own files.
if (( merged || failed || landed )); then
  say "$REPO: drain done — $merged merged, $failed failed$( (( landed )) && printf ', %s already landed' "$landed" || true)"
fi
