#!/usr/bin/env bash
set -uo pipefail

# Host-side manual cleanup against throwaway git worktrees and a fake tmux.
# No process or repository outside TMP is addressed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { [[ "$2" == "$3" ]] && ok "$1" || nok "$1 (want $2, got $3)"; }
assert_contains() { [[ "$2" == *"$3"* ]] && ok "$1" || nok "$1 (missing: $3)"; }
assert_not_contains() { [[ "$2" != *"$3"* ]] && ok "$1" || nok "$1 (unexpected: $3)"; }

UPSTREAM="$TMP/upstream.git"
PROJECT="$TMP/project"
git init -q --bare -b main "$UPSTREAM"
git -c init.defaultBranch=main clone -q "$UPSTREAM" "$PROJECT" 2>/dev/null
git -C "$PROJECT" config user.email test@example.com
git -C "$PROJECT" config user.name Test
printf 'base\n' > "$PROJECT/file"
git -C "$PROJECT" add file
git -C "$PROJECT" commit -qm base
git -C "$PROJECT" push -qu origin main

HARNESS="$TMP/harness"
mkdir -p "$HARNESS"
cp -R "$ROOT/bin" "$ROOT/etc" "$HARNESS/"
cat > "$HARNESS/etc/repos.conf" <<EOF
REPOS=( testrepo=$PROJECT )
REPO_ORIGINS=( testrepo=owner/repo )
SSH_HOST=unused
HOST_CONTROL_DIR=$HARNESS
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=1
HOST_TIMEZONE=UTC
EOF

mkdir -p "$TMP/bin" "$TMP/worktrees/testrepo"
cat > "$TMP/bin/tmux" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
case "$1" in
  list-sessions) printf '%s\n' ${LIVE_SESSIONS:-}; exit 0 ;;
  has-session)
    for s in ${LIVE_SESSIONS:-}; do [[ "${3#=}" == "$s" ]] && exit 0; done
    exit 1 ;;
  show-options)
    s="${3#=}"; s="${s%:}"; key="${5:-}"
    [[ "$s" == testrepo-alpha && "$key" == @toliki_kind ]] && { echo manual; exit 0; }
    [[ "$s" == testrepo-alpha && "$key" == @repo ]] && { echo testrepo; exit 0; }
    [[ "$s" == testrepo-alpha && "$key" == @engine ]] && { echo claude; exit 0; }
    [[ "$s" == testrepo-epic-9 && "$key" == @toliki_kind ]] && { echo pipeline; exit 0; }
    [[ "$s" == testrepo-epic-9 && "$key" == @repo ]] && { echo testrepo; exit 0; }
    exit 0 ;;
  list-panes) echo claude; exit 0 ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/tmux"

record_manual() {
  local session="$1" branch="manual/$1" wt="$TMP/worktrees/testrepo/$1"
  git -C "$PROJECT" worktree add -q -b "$branch" "$wt" origin/main
  git -C "$PROJECT" config "toliki-manual.$session.repo" testrepo
  git -C "$PROJECT" config "toliki-manual.$session.branch" "$branch"
  git -C "$PROJECT" config "toliki-manual.$session.worktree" "$wt"
  git -C "$PROJECT" config "toliki-manual.$session.engine" claude
  git -C "$PROJECT" config "toliki-manual.$session.token" "token-$session"
}

MANUAL="$HARNESS/bin/manual-session.sh"
OUT="" RC=0
run_manual() {
  : > "$TMP/tmux.log"
  OUT="$(PATH="$TMP/bin:$PATH" TMUX_LOG="$TMP/tmux.log" HOME="$TMP/home" bash "$MANUAL" "$@" 2>&1)"
  RC=$?
}

record_manual testrepo-alpha
printf 'dirty\n' >> "$TMP/worktrees/testrepo/testrepo-alpha/file"
run_manual remove-workspace --repo testrepo testrepo-alpha
assert_rc "dirty workspace removal refuses" 1 "$RC"
assert_contains "dirty refusal is actionable" "$OUT" "dirty or untracked"
[[ -d "$TMP/worktrees/testrepo/testrepo-alpha" ]] && ok "dirty workspace is retained" || nok "dirty workspace was lost"
git -C "$TMP/worktrees/testrepo/testrepo-alpha" checkout -q -- file

run_manual remove-workspace --repo testrepo testrepo-alpha
assert_rc "clean merged workspace removal succeeds" 0 "$RC"
[[ ! -e "$TMP/worktrees/testrepo/testrepo-alpha" ]] && ok "safe removal removes the worktree" || nok "safe removal left worktree"
git -C "$PROJECT" show-ref --verify --quiet refs/heads/manual/testrepo-alpha && nok "safe removal left branch" || ok "safe removal removes the branch"

record_manual testrepo-alpha
printf 'untracked\n' > "$TMP/worktrees/testrepo/testrepo-alpha/untracked"
run_manual remove-workspace --repo testrepo testrepo-alpha
assert_rc "untracked workspace removal refuses" 1 "$RC"
assert_contains "untracked refusal uses the dirty-work guard" "$OUT" "dirty or untracked"
rm "$TMP/worktrees/testrepo/testrepo-alpha/untracked"

export LIVE_SESSIONS="testrepo-alpha"
run_manual remove-workspace --repo testrepo testrepo-alpha
assert_rc "active workspace removal refuses" 1 "$RC"
assert_contains "active refusal says to stop first" "$OUT" "still active; stop it first"
unset LIVE_SESSIONS

printf 'local\n' >> "$TMP/worktrees/testrepo/testrepo-alpha/file"
git -C "$TMP/worktrees/testrepo/testrepo-alpha" add file
git -C "$TMP/worktrees/testrepo/testrepo-alpha" commit -qm local
run_manual remove-workspace --repo testrepo testrepo-alpha
assert_rc "unmerged local commit removal refuses" 1 "$RC"
assert_contains "unmerged refusal names the proof" "$OUT" "not merged into origin/main"

export LIVE_SESSIONS="testrepo-alpha testrepo-epic-9 unrelated"
run_manual stop-manual
assert_contains "batch cleanup stops the proven manual session exactly" "$(cat "$TMP/tmux.log")" "kill-session -t =testrepo-alpha"
assert_not_contains "batch cleanup leaves the pipeline" "$(cat "$TMP/tmux.log")" "kill-session -t =testrepo-epic-9"
assert_not_contains "batch cleanup leaves unrelated tmux" "$(cat "$TMP/tmux.log")" "kill-session -t =unrelated"
unset LIVE_SESSIONS

run_manual stop --repo testrepo testrepo-alpha
assert_rc "stopping an already-stopped manual session is safe" 0 "$RC"
assert_contains "repeat stop retains the workspace" "$OUT" "no tmux session running; workspace retained"

git -C "$PROJECT" config toliki-manual.testrepo-ambiguous.repo testrepo
run_manual remove-workspace --repo testrepo testrepo-ambiguous
assert_rc "incomplete ownership metadata refuses removal" 1 "$RC"
assert_contains "ambiguous removal reports that ownership is unproven" "$OUT" "cannot prove ownership"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
