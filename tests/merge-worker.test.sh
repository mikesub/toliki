#!/usr/bin/env bash
set -uo pipefail

# Exercises bin/merge-worker.sh's state machine: which PR it picks, what it
# refuses, when it merges, and which label every outcome leaves behind.
#
# git is REAL — a throwaway bare origin, a clone, and epic branches under
# mktemp — so the rebase, the head check and the worktree are the code's own.
# `gh` is a stub driven by response files (one per call shape, with an optional
# per-call sequence), so a scenario can say "checks pending, then green" or
# "the merge returns a 502". Nothing here touches the network, a real clone or
# a live tmux server. The conflict resolver has its own suite
# (tests/merge-autoresolve.test.sh); this one covers everything around it.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL_N=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL_N=$((FAIL_N + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"
    printf '%s\n' "$2" | tail -n 8 | sed 's/^/       | /'
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi; }

export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# A rebase stamps the committer date, so without a fixed clock the sha the
# worker produces and the one this suite computes differ by a second and every
# check assertion misses.
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z' GIT_COMMITTER_DATE='2026-01-01T00:00:00Z'

# ───────────────────────── the fake host ─────────────────────────
HARNESS="$TMP/harness"
mkdir -p "$HARNESS"
cp -R "$ROOT/bin" "$ROOT/etc" "$HARNESS/"
mkdir -p "$TMP/bin"

# flock: the per-repo lock. Linux-only in production; FLOCK_BUSY makes the take
# fail, which is how a still-draining predecessor looks.
cat > "$TMP/bin/flock" <<'STUB'
#!/usr/bin/env bash
[[ "${FLOCK_BUSY:-}" != "1" ]] || exit 1
exit 0
STUB

# gh: every call is logged, then answered from $GH_DIR by a key derived from the
# subcommand. `<key>.<n>` answers the n-th call of that key and `<key>` answers
# the rest, so a scenario can script a sequence (checks pending, then green).
# `<key>.rc` / `<key>.<n>.rc` make the call fail with that exit code, printing
# `<key>.err` if present — which is how a transient GitHub error is simulated.
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
key="unknown"
case "${1:-} ${2:-}" in
  "pr list")
    key=pr-list-open
    [[ "$*" != *"--state merged"* ]] || key=pr-list-merged ;;
  "pr view")
    key=pr-view
    [[ "$*" != *statusCheckRollup* ]] || key=pr-checks
    [[ "$*" != *"--json state"* ]] || key=pr-state ;;
  "pr merge")    key=pr-merge ;;
  "issue list")  key=issue-list ;;
  "issue edit")  key=issue-edit; printf '%s\n' "$*" >> "$GH_DIR/edits" ;;
  "issue comment") key=issue-comment
    body=""
    while [[ $# -gt 0 ]]; do case "$1" in --body-file) body="$(cat "$2")"; shift 2 ;; *) shift ;; esac; done
    [[ -n "$body" ]] || body="$(cat)"
    printf '%s\n---\n' "$body" >> "$GH_DIR/comments" ;;
  "label create") key=label-create ;;
esac
n="$(cat "$GH_DIR/$key.n" 2>/dev/null || echo 0)"
printf '%s' "$((n + 1))" > "$GH_DIR/$key.n"
for f in "$GH_DIR/$key.$n.rc" "$GH_DIR/$key.rc"; do
  if [[ -f "$f" ]]; then
    [[ ! -f "$GH_DIR/$key.err" ]] || cat "$GH_DIR/$key.err" >&2
    exit "$(cat "$f")"
  fi
done
for f in "$GH_DIR/$key.$n" "$GH_DIR/$key"; do
  if [[ -f "$f" ]]; then cat "$f"; exit 0; fi
done
exit 0
STUB
chmod +x "$TMP/bin/flock" "$TMP/bin/gh"

# ───────────────────────── a throwaway project ─────────────────────────
ORIGIN="$TMP/origin.git"
CLONE="$TMP/clone"
git init -q --bare "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
git init -q -b main "$TMP/seed"
printf 'one\ntwo\nthree\n' > "$TMP/seed/app.txt"
git -C "$TMP/seed" add -A && git -C "$TMP/seed" commit -qm initial
git -C "$TMP/seed" remote add origin "$ORIGIN"
git -C "$TMP/seed" push -q origin main
MAIN0="$(git -C "$TMP/seed" rev-parse HEAD)"
git clone -q "$ORIGIN" "$CLONE"

cat > "$HARNESS/etc/repos.conf" <<CONF
REPOS=( "myapp=$CLONE" )
REPO_ORIGINS=( "myapp=o/r" )
SSH_HOST="unused"
MAX_PARALLEL_EPICS=3
CONF

WORKER="$HARNESS/bin/merge-worker.sh"

# Rebuild origin to a known state: main at its first commit, no epic branches.
reset_origin() {
  git -C "$ORIGIN" update-ref refs/heads/main "$MAIN0"
  local ref
  for ref in $(git -C "$ORIGIN" for-each-ref --format='%(refname)' refs/heads/); do
    [[ "$ref" == refs/heads/main ]] || git -C "$ORIGIN" update-ref -d "$ref"
  done
  rm -rf "$TMP/wt"
}
# An epic branch with one commit, as ship leaves it.
seed_epic() { # branch file content
  local dir="$TMP/seeder"
  rm -rf "$dir"; git clone -q "$ORIGIN" "$dir"
  git -C "$dir" switch -q -c "$1" origin/main
  printf '%s\n' "$3" > "$dir/$2"
  git -C "$dir" add -A
  git -C "$dir" commit -qm "feat: the change" -m "Closes #42"
  git -C "$dir" push -q origin "HEAD:refs/heads/$1"
  git -C "$ORIGIN" rev-parse "refs/heads/$1"
}
# Move main so the epic branch must actually rebase.
advance_main() { # file content
  local dir="$TMP/mover"
  rm -rf "$dir"; git clone -q "$ORIGIN" "$dir"
  printf '%s\n' "$2" > "$dir/$1"
  git -C "$dir" add -A && git -C "$dir" commit -qm "main moved"
  git -C "$dir" push -q origin HEAD:main
}

RUN_OUT=""
RUN_RC=0
run_worker() {
  GH_DIR="$TMP/gh.$RANDOM$RANDOM"
  GH_LOG="$GH_DIR/log"
  mkdir -p "$GH_DIR"
  : > "$GH_LOG"
  # The queue is one issue unless a scenario says otherwise.
  [[ -f "$GH_DIR/issue-list" ]] || printf '[{"number":42}]\n' > "$GH_DIR/issue-list"
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" \
    GH_DIR="$GH_DIR" GH_LOG="$GH_LOG" \
    MERGE_WORKTREE_ROOT="$TMP/wt" \
    MERGE_CI_TIMEOUT="${MERGE_CI_TIMEOUT:-2}" MERGE_CI_POLL="${MERGE_CI_POLL:-1}" \
    MERGE_CI_REGISTRATION_GRACE="${MERGE_CI_REGISTRATION_GRACE:-1}" \
    FLOCK_BUSY="${FLOCK_BUSY:-}" \
    bash "$WORKER" --repo myapp 2>&1
  )" || RUN_RC=$?
  STATE="$GH_DIR"
}
gh_log() { cat "$STATE/log"; }
edits() { cat "$STATE/edits" 2>/dev/null || true; }
comments() { cat "$STATE/comments" 2>/dev/null || true; }
# The response files a scenario writes.
gh_set() { printf '%s' "$2" > "$GH_DIR_PENDING/$1"; }
prep() { GH_DIR_PENDING="$TMP/pending.$RANDOM$RANDOM"; mkdir -p "$GH_DIR_PENDING"; }
run_prepared() {
  GH_DIR="$GH_DIR_PENDING"; GH_LOG="$GH_DIR/log"
  [[ -f "$GH_DIR/issue-list" ]] || printf '[{"number":42}]\n' > "$GH_DIR/issue-list"
  : > "$GH_LOG"
  RUN_RC=0
  RUN_OUT="$(
    PATH="$TMP/bin:$PATH" \
    GH_DIR="$GH_DIR" GH_LOG="$GH_LOG" \
    MERGE_WORKTREE_ROOT="$TMP/wt" \
    MERGE_CI_TIMEOUT="${MERGE_CI_TIMEOUT:-2}" MERGE_CI_POLL="${MERGE_CI_POLL:-1}" \
    MERGE_CI_REGISTRATION_GRACE="${MERGE_CI_REGISTRATION_GRACE:-1}" \
    FLOCK_BUSY="${FLOCK_BUSY:-}" \
    bash "$WORKER" --repo myapp 2>&1
  )" || RUN_RC=$?
  STATE="$GH_DIR"
}
# The three responses every ordinary scenario needs.
standard_pr() { # sha
  gh_set pr-list-open  "[{\"number\":7,\"headRefName\":\"epic/42-change\"}]"
  gh_set pr-view       "{\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\",\"headRefName\":\"epic/42-change\",\"headRefOid\":\"$1\"}"
  gh_set pr-state      "MERGED"
}
green_checks() { # sha
  gh_set pr-checks "{\"headRefOid\":\"$1\",\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"build\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"}]}"
}
scenario() { printf '\n%s\n' "$1"; reset_origin; prep; }
# The sha the worker will rebase to, computed the way the worker does.
rebased_sha() { # branch
  local dir="$TMP/rebaser"
  rm -rf "$dir"; git clone -q "$ORIGIN" "$dir"
  git -C "$dir" checkout -q --detach "refs/remotes/origin/$1"
  git -C "$dir" rebase origin/main >/dev/null 2>&1 || { echo CONFLICT; return; }
  git -C "$dir" rev-parse HEAD
}

# ───────────────────────── scenarios ─────────────────────────

scenario 'merge-worker: a green PR is rebased, re-checked and squash-merged'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
green_checks "$REBASED"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it rebased the PR onto current main" "$RUN_OUT" "rebased $HEAD_SHA -> $REBASED"
assert_contains "it waited on the checks for the REBASED head" "$RUN_OUT" "waiting on checks for $REBASED"
assert_contains "it squash-merged" "$RUN_OUT" "squash-merged"
assert_contains "the merge is pinned to the sha whose checks went green" "$(gh_log)" "--squash --match-head-commit $REBASED"
assert_contains "and the label is dropped" "$(edits)" "--remove-label ready-to-merge"
assert_eq "the rebased branch is what origin holds" "$REBASED" "$(git -C "$ORIGIN" rev-parse refs/heads/epic/42-change)"
assert_eq "nothing was marked failed" "" "$(comments)"

scenario 'merge-worker: checks that have not registered yet are waited for, not failed'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
# First poll: the force-push has not registered. Second: no checks yet. Third: green.
gh_set pr-checks.0 "{\"headRefOid\":\"$HEAD_SHA\",\"statusCheckRollup\":[]}"
gh_set pr-checks.1 "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[]}"
gh_set pr-checks   "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"build\",\"status\":\"COMPLETED\",\"conclusion\":\"SUCCESS\"}]}"
MERGE_CI_TIMEOUT=10 MERGE_CI_REGISTRATION_GRACE=3 run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it merged once the checks appeared" "$RUN_OUT" "squash-merged"

scenario 'merge-worker: no checks after the registration grace means no CI and merges'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
gh_set pr-checks "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[]}"
run_prepared
assert_rc "exits 0 (the drain completes)" 0 "$RUN_RC"
assert_contains "the log identifies the no-CI outcome" "$RUN_OUT" "treating it as a no-CI repo"
assert_contains "the no-CI PR is squash-merged" "$RUN_OUT" "squash-merged"
assert_contains "the merge stays pinned to the evaluated head" "$(gh_log)" "--squash --match-head-commit $REBASED"
assert_eq "nothing was marked failed" "" "$(comments)"

scenario 'merge-worker: a registered check that never concludes still fails closed'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
gh_set pr-checks "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"build\",\"status\":\"IN_PROGRESS\",\"conclusion\":null}]}"
run_prepared
assert_rc "exits 0 (the drain completes)" 0 "$RUN_RC"
assert_contains "the reason says the registered check timed out" "$(comments)" "PR checks did not conclude"
assert_contains "the issue is marked failed" "$(edits)" "--add-label failed"
assert_eq "nothing was merged" 0 "$(grep -c 'pr merge' "$STATE/log")"

scenario 'merge-worker: a registered check cannot disappear into the no-CI path'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
gh_set pr-checks.0 "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"build\",\"status\":\"IN_PROGRESS\",\"conclusion\":null}]}"
gh_set pr-checks "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[]}"
run_prepared
assert_rc "exits 0 (the drain completes)" 0 "$RUN_RC"
assert_contains "the vanished registered check still times out" "$(comments)" "PR checks did not conclude"
assert_contains "the issue is marked failed" "$(edits)" "--add-label failed"
assert_not_contains "the log never calls it no-CI" "$RUN_OUT" "treating it as a no-CI repo"
assert_eq "nothing was merged" 0 "$(grep -c 'pr merge' "$STATE/log")"

scenario 'merge-worker: a red check queues the issue for the CI fixer'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
gh_set pr-checks "{\"headRefOid\":\"$REBASED\",\"statusCheckRollup\":[{\"__typename\":\"CheckRun\",\"name\":\"build\",\"status\":\"COMPLETED\",\"conclusion\":\"FAILURE\"}]}"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the failing check is named" "$(comments)" "PR checks failed on the rebased head"
assert_contains "and the check's name survives" "$(comments)" "build"
assert_contains "the issue goes to the CI fixer queue" "$(edits)" "--add-label needs-ci-fix"
assert_contains "beside failed" "$(edits)" "--add-label failed"
assert_contains "the comment says a fixer owns it" "$(comments)" "automated CI fixer session"

scenario 'merge-worker: a branch that moved under the worker is refused'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
# The PR reports a head that is not what origin holds.
gh_set pr-list-open "[{\"number\":7,\"headRefName\":\"epic/42-change\"}]"
gh_set pr-view "{\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\",\"headRefName\":\"epic/42-change\",\"headRefOid\":\"0000000000000000000000000000000000000000\"}"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the reason names the drift" "$(comments)" "moved under the worker"
assert_contains "and it is a plain failure" "$(edits)" "--add-label failed"
assert_eq "nothing was merged" 0 "$(grep -c 'pr merge' "$STATE/log")"

scenario 'merge-worker: two open PRs on one issue are ambiguous, never guessed'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
gh_set pr-list-open "[{\"number\":7,\"headRefName\":\"epic/42-change\"},{\"number\":8,\"headRefName\":\"epic/42-other\"}]"
gh_set pr-view "{\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"OPEN\",\"headRefName\":\"epic/42-change\",\"headRefOid\":\"$HEAD_SHA\"}"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the reason says how many" "$(comments)" "2 open PRs"
assert_contains "and names both" "$(comments)" "#7 #8"
assert_contains "the issue is marked failed" "$(edits)" "--add-label failed"
assert_eq "nothing was merged" 0 "$(grep -c 'pr merge' "$STATE/log")"

scenario 'merge-worker: an already-merged PR just drops the label'
seed_epic epic/42-change app.txt 'one
two
three
epic' > /dev/null
gh_set pr-list-open "[{\"number\":7,\"headRefName\":\"epic/42-change\"}]"
gh_set pr-view "{\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"MERGED\",\"headRefName\":\"epic/42-change\",\"headRefOid\":\"deadbeef\"}"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it says so" "$RUN_OUT" "already merged"
assert_contains "the label comes off" "$(edits)" "--remove-label ready-to-merge"
assert_eq "nothing was merged again" 0 "$(grep -c 'pr merge' "$STATE/log")"
assert_eq "and nothing was marked failed" "" "$(comments)"

scenario 'merge-worker: an issue whose PR already landed is reconciled, not failed'
gh_set pr-list-open "[]"
gh_set pr-list-merged "[{\"number\":7,\"headRefName\":\"epic/42-change\"}]"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it names the merged PR" "$RUN_OUT" "already delivered by merged PR #7"
assert_contains "the label comes off" "$(edits)" "--remove-label ready-to-merge"
assert_eq "nothing was marked failed" "" "$(comments)"

scenario 'merge-worker: a label with no PR at all is a plain failure'
gh_set pr-list-open "[]"
gh_set pr-list-merged "[]"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the reason says the label points at nothing" "$(comments)" "no PR on an epic/42-* branch"
assert_contains "the issue is marked failed" "$(edits)" "--add-label failed"

scenario 'merge-worker: a transient error on the merge aborts the run and writes no label'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
green_checks "$REBASED"
gh_set pr-merge.rc "1"
gh_set pr-merge.err "HTTP 502: Bad gateway"
run_prepared
assert_rc "exits 1 (the run aborts)" 1 "$RUN_RC"
assert_contains "it says the next tick retries" "$RUN_OUT" "transient GitHub error"
assert_eq "no failure comment was posted" "" "$(comments)"
assert_not_contains "and the ready-to-merge label is left alone" "$(edits)" "--add-label failed"

scenario 'merge-worker: a genuine merge refusal is this PR verdict'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
green_checks "$REBASED"
gh_set pr-merge.rc "1"
gh_set pr-merge.err "Pull request Head branch was modified. Review and try the merge again."
run_prepared
assert_rc "exits 0 (the drain completes)" 0 "$RUN_RC"
assert_contains "the refusal is recorded on the issue" "$(comments)" "squash-merge of PR #7 failed"
assert_contains "the head-moved reason survives" "$(comments)" "Head branch was modified"
assert_contains "the issue is marked failed" "$(edits)" "--add-label failed"

scenario 'merge-worker: a read-back that fails after the merge aborts rather than guessing'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
green_checks "$REBASED"
gh_set pr-state.rc "1"
run_prepared
assert_rc "exits 1 (the run aborts)" 1 "$RUN_RC"
assert_contains "it says the next tick reconciles it" "$RUN_OUT" "reading its state back failed"
assert_eq "a landed PR is never marked failed on a failed read" "" "$(comments)"

scenario 'merge-worker: a merge that reports success but did not land is a failure'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
advance_main other.txt 'main moved'
REBASED="$(rebased_sha epic/42-change)"
standard_pr "$HEAD_SHA"
green_checks "$REBASED"
gh_set pr-state "OPEN"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the mismatch is recorded" "$(comments)" "is OPEN, not MERGED"
assert_contains "the issue is marked failed" "$(edits)" "--add-label failed"

scenario 'merge-worker: a label write that fails does not stop the report'
HEAD_SHA="$(seed_epic epic/42-change app.txt 'one
two
three
epic')"
gh_set pr-list-open "[{\"number\":7,\"headRefName\":\"epic/42-change\"}]"
gh_set pr-view "{\"url\":\"https://github.com/o/r/pull/7\",\"state\":\"CLOSED\",\"headRefName\":\"epic/42-change\",\"headRefOid\":\"$HEAD_SHA\"}"
gh_set issue-edit.rc "1"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the cause still reaches the issue" "$(comments)" "closed without merging"
assert_contains "and the failed relabel is reported, not swallowed" "$RUN_OUT" "could not relabel"

scenario 'merge-worker: the queue index lagging does not double-fail one issue'
printf '[{"number":42},{"number":42}]\n' > "$GH_DIR_PENDING/issue-list"
gh_set pr-list-open "[]"
gh_set pr-list-merged "[]"
run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "the issue is handled exactly once" 1 "$(grep -c 'merge-worker blocked' "$STATE/comments")"

scenario 'merge-worker: a still-draining predecessor is not an error'
FLOCK_BUSY=1 run_prepared
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "it says why it did nothing" "$RUN_OUT" "still draining"
assert_eq "and queries nothing" 0 "$(wc -l < "$STATE/log" | tr -d ' ')"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL_N"
[[ "$FAIL_N" -eq 0 ]]
