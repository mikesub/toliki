#!/usr/bin/env bash
set -euo pipefail

# Checks that the git commands the contract and t-ship prescribe do what the
# prose claims: ship's untracked-file check sees every untracked file but not
# the ignored handovers, `commit -a` commits exactly what the fingerprint
# covers, where a plain commit can leave reviewed edits behind, and the
# contract's own fingerprint command ignores diff config that would hide an
# edit or make the same change hash differently, and the landing gate's checks
# and merge refuse each way of landing the wrong thing, ship's rebase never
# stashes, and cleanup's listing and archive checks see what worktree removal
# would silently delete.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$ROOT/skills/epic"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/toliki-contract.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1
mkdir -p "$HOME"
git config --global user.name test
git config --global user.email test@example.invalid
git config --global init.defaultBranch main
cd "$TMP"

PASS=0
FAIL=0
ok_test() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

UNTRACKED='git -C <worktree> status --porcelain --untracked-files=all'
if grep -qF "$UNTRACKED" "$BUNDLE/t-ship/SKILL.md" &&
  grep -qF 'git -C <worktree> commit -a' "$BUNDLE/t-ship/SKILL.md"; then
  ok_test "t-ship prescribes the untracked check and commit -a"
else
  nok "t-ship no longer names the untracked check or commit -a"
fi
if grep -q 'fingerprint immediately before and after' "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "the contract fingerprints verification before and after"
else
  nok "the contract no longer fingerprints verification before and after"
fi

EMPTY=e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
FINGERPRINT="$(grep -F 'diff --binary' "$BUNDLE/EPIC-CONTRACT.md" | sed 's/<worktree>/"$WT"/g')"
if [[ "$(printf '%s\n' "$FINGERPRINT" | wc -l)" -eq 1 && "$FINGERPRINT" == *'merge-base main HEAD'* ]] &&
  grep -qF "$EMPTY" "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "the contract gives one self-contained fingerprint command and the empty hash"
else
  nok "the contract fingerprint command is missing, ambiguous or carries its base over"
fi
fingerprint() { local WT="$1"; eval "$FINGERPRINT"; }
untracked() { git -C "$1" status --porcelain --untracked-files=all | grep '^??' || true; }

new_epic() {
  local repo="$TMP/$1"
  git init -q "$repo"
  printf 'one\n' >"$repo/app.txt"
  git -C "$repo" add app.txt
  git -C "$repo" commit -qm base
  git -C "$repo" checkout -qb epic/demo
  printf '/.epics/\n' >>"$repo/$(git -C "$repo" rev-parse --git-path info/exclude)"
  mkdir -p "$repo/.epics/demo"
  printf 'spec\n' >"$repo/.epics/demo/spec.md"
  printf '%s\n' "$repo"
}

# Stop case: an untracked file is listed even when status hides untracked files.
repo="$(new_epic hidden)"
git -C "$repo" config status.showUntrackedFiles no
printf 'helper\n' >"$repo/helper.txt"
if [[ -n "$(untracked "$repo")" ]]; then
  ok_test "the untracked check lists a file that showUntrackedFiles=no hides"
else
  nok "the untracked check missed an untracked file"
fi

# Pass case: ignored handovers alone leave the check empty.
repo="$(new_epic clean)"
printf 'two\n' >"$repo/app.txt"
if [[ -z "$(untracked "$repo")" ]]; then
  ok_test "ignored handovers leave the untracked check empty"
else
  nok "the untracked check lists ignored handovers"
fi

# A reviewed edit left unstaged: commit -a lands it, a plain commit does not.
for mode in plain all; do
  repo="$(new_epic "commit-$mode")"
  printf 'helper\n' >"$repo/helper.txt"
  git -C "$repo" add helper.txt
  printf 'two\n' >"$repo/app.txt"
  reviewed="$(fingerprint "$repo")"
  if [[ "$mode" == all ]]; then
    git -C "$repo" commit -qam epic
  else
    git -C "$repo" commit -qm epic
  fi
  committed="$(git -C "$repo" diff --binary main HEAD | git hash-object --stdin)"
  if [[ "$mode" == all && "$committed" == "$reviewed" && "$(fingerprint "$repo")" == "$reviewed" ]]; then
    ok_test "commit -a commits exactly the fingerprinted change"
  elif [[ "$mode" == plain && "$committed" != "$reviewed" && "$(fingerprint "$repo")" == "$reviewed" ]]; then
    ok_test "a plain commit can miss an edit the worktree fingerprint still shows"
  else
    nok "commit mode $mode: committed $committed, reviewed $reviewed"
  fi
done

# A verify step that rewrites a tracked file changes the fingerprint.
repo="$(new_epic rewrite)"
printf 'two\n' >"$repo/app.txt"
before="$(fingerprint "$repo")"
printf 'formatted\n' >"$repo/app.txt"
if [[ "$(fingerprint "$repo")" != "$before" ]]; then
  ok_test "a verification run that rewrites a tracked file is not green"
else
  nok "a rewritten tracked file kept the fingerprint"
fi

# Lost base: everything staged, so a diff whose base went missing is empty.
repo="$(new_epic lost-base)"
printf 'two\n' >"$repo/app.txt"
git -C "$repo" add app.txt
BASE=""
lost="$(git -C "$repo" diff --binary $BASE | git hash-object --stdin)"
if [[ "$lost" == "$EMPTY" && "$(fingerprint "$repo")" != "$EMPTY" ]]; then
  ok_test "a lost base hashes as empty input while the contract command does not"
else
  nok "lost base $lost, contract command $(fingerprint "$repo")"
fi

# Hostile diff config: an external differ and a textconv that both hide content,
# colour, and mnemonic prefixes, which differ between worktree and commit diffs.
repo="$(new_epic hostile)"
printf '\000\002' >"$repo/blob.bin"
git -C "$repo" add blob.bin
git -C "$repo" commit -qm 'add blob'
git -C "$repo" branch -qf main HEAD
printf '\000\003' >"$repo/blob.bin"
printf 'two\n' >"$repo/app.txt"
clean="$(fingerprint "$repo")"
cat >"$TMP/hide-diff" <<'SH'
#!/bin/sh
echo "$1 changed"
SH
chmod +x "$TMP/hide-diff"
printf '* diff=hide\n' >"$repo/$(git -C "$repo" rev-parse --git-path info/attributes)"
git -C "$repo" config diff.external "$TMP/hide-diff"
git -C "$repo" config diff.hide.textconv 'sh -c "echo same" --'
git -C "$repo" config diff.mnemonicPrefix true
git -C "$repo" config color.diff always
configured="$(fingerprint "$repo")"
if [[ "$configured" == "$clean" ]]; then
  ok_test "diff config does not change the fingerprint"
else
  nok "diff config changed the fingerprint"
fi
printf '\000\004' >"$repo/blob.bin"
if [[ "$(fingerprint "$repo")" != "$configured" ]]; then
  ok_test "a binary edit changes the fingerprint despite a hiding differ"
else
  nok "a hiding differ kept the fingerprint after a binary edit"
fi
printf '\000\003' >"$repo/blob.bin"
git -C "$repo" commit -qam epic
if [[ "$(fingerprint "$repo")" == "$configured" ]]; then
  ok_test "committing keeps the fingerprint under diff config"
else
  nok "committing changed the fingerprint under diff config"
fi

# Landing gate: the contract names the checks and the exact merge command.
MERGE='git -C <main> merge --ff-only --no-autostash --no-overwrite-ignore'
if grep -qF 'rev-list --count' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -qF 'git -C <main> branch --show-current' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -qF "$MERGE" "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "the contract names the landing checks and merge command"
else
  nok "the contract lost a landing check or the merge command"
fi

# A main checkout with one epic commit in a worktree beside it.
new_landing() {
  local main="$TMP/$1/main"
  git init -q "$main"
  printf 'one\n' >"$main/app.txt"
  git -C "$main" add app.txt
  git -C "$main" commit -qm base
  git -C "$main" worktree add -q -b epic/demo "$TMP/$1/wt" main
  printf 'epic\n' >"$TMP/$1/wt/app.txt"
  git -C "$TMP/$1/wt" commit -qam epic
}
land() { git -C "$1" merge -q --ff-only --no-autostash --no-overwrite-ignore "$2" >/dev/null 2>&1; }

# Pass case: one commit above main, main checked out, and the merge lands it.
new_landing pass
main="$TMP/pass/main" wt="$TMP/pass/wt"
commit="$(git -C "$wt" rev-parse HEAD)"
if [[ "$(git -C "$wt" rev-list --count main..HEAD)" == 1 &&
  "$(git -C "$main" branch --show-current)" == main ]] &&
  land "$main" "$commit" && [[ "$(git -C "$main" rev-parse main)" == "$commit" ]]; then
  ok_test "the landing gate passes and fast-forwards one epic commit"
else
  nok "the landing gate did not land a single epic commit"
fi

# Stop case: skipping the conflicting epic commit leaves nothing above main.
new_landing skip
main="$TMP/skip/main" wt="$TMP/skip/wt"
printf 'main\n' >"$main/app.txt"
git -C "$main" commit -qam 'main moves'
git -C "$wt" rebase --no-autostash main >/dev/null 2>&1 || git -C "$wt" rebase --skip >/dev/null 2>&1
if [[ "$(git -C "$wt" rev-list --count main..HEAD)" == 0 ]]; then
  ok_test "the commit count catches a rebase --skip that dropped the epic"
else
  nok "rebase --skip left $(git -C "$wt" rev-list --count main..HEAD) commits above main"
fi

# Stop case: the main checkout is on another branch.
new_landing branch
git -C "$TMP/branch/main" checkout -qb elsewhere
if [[ "$(git -C "$TMP/branch/main" branch --show-current)" != main ]]; then
  ok_test "the branch check catches a main checkout on another branch"
else
  nok "the branch check missed a main checkout on another branch"
fi

# Stop case: the merge never overwrites ignored user data in the main checkout.
new_landing ignored
main="$TMP/ignored/main" wt="$TMP/ignored/wt"
printf 'generated\n' >"$wt/local.txt"
git -C "$wt" add local.txt
git -C "$wt" commit -q --amend --no-edit
printf 'local.txt\n' >>"$main/$(git -C "$main" rev-parse --git-path info/exclude)"
printf 'user data\n' >"$main/local.txt"
if ! land "$main" "$(git -C "$wt" rev-parse HEAD)" && [[ "$(cat "$main/local.txt")" == 'user data' ]]; then
  ok_test "the merge refuses to overwrite an ignored file in main"
else
  nok "the merge overwrote an ignored file in main"
fi

# Stop case: the merge never autostashes edits in the main checkout.
new_landing stash
main="$TMP/stash/main" wt="$TMP/stash/wt"
git -C "$main" config merge.autoStash true
printf 'dirty\n' >"$main/app.txt"
if ! land "$main" "$(git -C "$wt" rev-parse HEAD)" && [[ -z "$(git -C "$main" stash list)" ]] &&
  [[ "$(cat "$main/app.txt")" == dirty ]]; then
  ok_test "the merge refuses instead of autostashing edits in main"
else
  nok "the merge autostashed or lost edits in main"
fi

# Rebase: the contract names the one rebase command, ship's ownership of an
# interrupted rebase, and the ban on --skip.
if grep -qF 'git -C <worktree> rebase' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -qF -- '--no-autostash main' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -qF 'never `git rebase --skip`' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -q 'only ship' "$BUNDLE/EPIC-CONTRACT.md" &&
  ! grep -q 'Finish an interrupted rebase' "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "the contract gives ship the rebase, its command and the --skip ban"
else
  nok "the contract lost the rebase command, its owner or the --skip ban"
fi

# A conflicting rebase is in progress: status reports it to every phase.
new_landing paused
main="$TMP/paused/main" wt="$TMP/paused/wt"
printf 'main\n' >"$main/app.txt"
git -C "$main" commit -qam 'main moves'
if ! git -C "$wt" rebase --no-autostash main >/dev/null 2>&1 &&
  git -C "$wt" status | grep -q 'rebase in progress'; then
  ok_test "status reports an interrupted rebase in the worktree"
else
  nok "status did not report the interrupted rebase"
fi

# Stop and pass cases under rebase.autoStash=true: an uncommitted edit makes
# the rebase refuse without stashing; once it is committed the rebase runs.
new_landing autostash
main="$TMP/autostash/main" wt="$TMP/autostash/wt"
printf 'other\n' >"$main/other.txt"
git -C "$main" add other.txt
git -C "$main" commit -qm 'main moves'
git -C "$wt" config rebase.autoStash true
printf 'wip\n' >>"$wt/app.txt"
if ! git -C "$wt" rebase --no-autostash main >/dev/null 2>&1 &&
  [[ -z "$(git -C "$wt" stash list)" && "$(tail -n 1 "$wt/app.txt")" == wip ]]; then
  ok_test "rebase --no-autostash refuses an uncommitted edit without stashing it"
else
  nok "rebase stashed or lost an uncommitted edit"
fi
git -C "$wt" commit -qa --amend --no-edit
if git -C "$wt" rebase --no-autostash main >/dev/null 2>&1 &&
  [[ "$(git -C "$wt" rev-list --count main..HEAD)" == 1 ]]; then
  ok_test "rebase --no-autostash runs on a clean worktree"
else
  nok "rebase --no-autostash failed on a clean worktree"
fi

# Findings: only the human's recorded acceptance clears a finding, and the
# landing gate checks findings, unmet requirements and open decisions alike.
if grep -qF '`code.md` dispositions' "$BUNDLE/t-ship/SKILL.md" &&
  grep -qF 'never clear a finding' "$BUNDLE/t-ship/SKILL.md" &&
  ! grep -qi -e 'silently clear' -e 'Resolve outstanding human' "$BUNDLE/t-ship/SKILL.md" &&
  grep -qF 'open finding, unmet requirement and open decision has a recorded acceptance' "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "only recorded human acceptance clears findings at the landing gate"
else
  nok "ship can clear findings without the human's recorded acceptance"
fi

# Review independence: a builder session never writes the review, the reviewer
# skips commit messages, and the recorded key is the one computed before reading.
R="$BUNDLE/t-review/SKILL.md"
if grep -qF 'stop without writing `review.md`' "$R" &&
  grep -qF 'was not launched by' "$R" && grep -qF 'was not launched by one' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -qF 'epic commit messages' "$R" &&
  grep -qF 'change key you computed before' "$R" && grep -qF 'never replace the recorded key' "$R" &&
  ! grep -qi 'self-review as independent' "$R"; then
  ok_test "t-review refuses builder sessions and records the key from before reading"
else
  nok "t-review lets a builder session review or records a moving key"
fi

# Verification command: one command, settled in the spec when the project
# names none, and no phase discovers its own.
if grep -qF 'Every full verification run uses' "$BUNDLE/EPIC-CONTRACT.md" &&
  grep -qF 'not name exactly one full verification' "$BUNDLE/t-spec/SKILL.md" &&
  ! grep -qi 'discover the' "$BUNDLE/EPIC-CONTRACT.md" "$BUNDLE/t-code/SKILL.md"; then
  ok_test "every phase runs the one verification command the spec can settle"
else
  nok "a phase still discovers its own verification command"
fi

# Resume after landing: ship.md is written just before the fast-forward, and a
# recorded commit already on main means only archive and clean up.
S="$BUNDLE/t-ship/SKILL.md"
if grep -qF 'the epic has' "$S" && grep -qF 'nothing to ship' "$S" &&
  ! grep -qi -e 'cleanup-only' -e 'the archive location' "$S" &&
  ! grep -qF 'cleanup outcome' "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "t-ship detects a landed epic and ship.md claims nothing before it happens"
else
  nok "t-ship still writes ship.md early or misreads a landed epic"
fi

# A landed epic has an empty change, so only the recorded commit identifies it.
new_landing landed
main="$TMP/landed/main" wt="$TMP/landed/wt"
commit="$(git -C "$wt" rev-parse HEAD)"
land "$main" "$commit"
if [[ "$(fingerprint "$wt")" == "$EMPTY" ]] && git -C "$main" merge-base --is-ancestor "$commit" main; then
  ok_test "after landing the change is empty and main contains the recorded commit"
else
  nok "a landed epic did not show an empty change and a contained commit"
fi

# Several epic commits: the consented squash keeps the change and its
# fingerprint, uncommitted edits included, and leaves one commit above main.
S="$BUNDLE/t-ship/SKILL.md"
if grep -qF 'reset --soft "$(git -C <worktree>' "$S" &&
  grep -qF "The only reset is ship's \`reset --soft\` squash" "$BUNDLE/EPIC-CONTRACT.md"; then
  ok_test "t-ship squashes with reset --soft to a freshly computed base"
else
  nok "t-ship has no squash method, or the contract still bans every reset"
fi
new_landing squash
wt="$TMP/squash/wt"
printf 'more\n' >>"$wt/app.txt"
git -C "$wt" commit -qam second
printf 'wip\n' >>"$wt/app.txt"
before="$(fingerprint "$wt")"
git -C "$wt" reset -q --soft "$(git -C "$wt" merge-base main HEAD)"
git -C "$wt" commit -qam squashed
if [[ "$(git -C "$wt" rev-list --count main..HEAD)" == 1 && "$(fingerprint "$wt")" == "$before" &&
  -z "$(git -C "$wt" status --porcelain --untracked-files=all)" ]]; then
  ok_test "the squash leaves one commit with the fingerprint unchanged"
else
  nok "the squash changed the fingerprint or left more than one commit"
fi

# Wording that phases rely on: one definition of the change, design-time spec
# changes, baseline failures that block, and no restated or undefined rules.
C="$BUNDLE/EPIC-CONTRACT.md"
missing=""
for phrase in 'each new file when you create it' 'If design or implementation exposes' \
  'A failure that already exists on main still blocks shipping' \
  'Whichever phase is invoked first with a spec but' '`<repo>` is the main checkout'; do
  grep -qF -- "$phrase" "$C" || missing="$missing [$phrase]"
done
grep -qF '`spec.md` changes the human explicitly approves' "$BUNDLE/t-architect/SKILL.md" || missing="$missing [architect spec]"
grep -qF 'unstaged edits plus staged new files' "$BUNDLE/t-review/SKILL.md" || missing="$missing [review change]"
grep -qF 't-spec creates the worktree' "$BUNDLE/README.md" || missing="$missing [README creates]"
for stale in 'relying on that baseline' 'prewritten spec' 'release' 'Installing' 'existing local spec' 'Ignored files never block'; do
  if grep -qF -- "$stale" "$BUNDLE"/t-*/SKILL.md; then missing="$missing [stale: $stale]"; fi
done
if [[ -z "$missing" ]]; then
  ok_test "the change, baselines and phase rules are each stated once and defined"
else
  nok "wording drifted:$missing"
fi

# t-ship's steps: resume a rebase in step 3, abort on unclear intent, find a
# landed epic's ship.md in the archive, and report preserved files; the
# reviewer's focused tests never count as the full verification.
missing=""
S="$BUNDLE/t-ship/SKILL.md"
for phrase in 'If a rebase is in progress, continue with step 3' 'rebase --abort` and ask' \
  'in the worktree or its archive' 'archive and preserved paths'; do
  grep -qF -- "$phrase" "$S" || missing="$missing [t-ship: $phrase]"
done
grep -qF -- '--abort` when a conflict' "$BUNDLE/EPIC-CONTRACT.md" || missing="$missing [contract abort]"
grep -qF 'never make the change green' "$BUNDLE/t-review/SKILL.md" || missing="$missing [review tests]"
grep -qF 'full verification command yourself' "$BUNDLE/t-review/SKILL.md" && missing="$missing [review full run]"
grep -qF 'owned files' "$BUNDLE/t-architect/SKILL.md" && missing="$missing [architect units]"
if [[ -z "$missing" ]]; then
  ok_test "t-ship's steps, review's focused tests and the trimmed design hold"
else
  nok "restructure drifted:$missing"
fi

# Aborting a conflicting rebase restores the epic commit with nothing paused.
new_landing abort
main="$TMP/abort/main" wt="$TMP/abort/wt"
commit="$(git -C "$wt" rev-parse HEAD)"
printf 'main\n' >"$main/app.txt"
git -C "$main" commit -qam 'main moves'
git -C "$wt" rebase --no-autostash main >/dev/null 2>&1 || git -C "$wt" rebase --abort
if [[ "$(git -C "$wt" rev-parse HEAD)" == "$commit" ]] && ! git -C "$wt" status | grep -q 'rebase in progress'; then
  ok_test "rebase --abort restores the epic commit and leaves no rebase paused"
else
  nok "rebase --abort did not restore the epic commit"
fi

# Cleanup: the contract lists ignored files uncollapsed, and t-ship no longer
# claims that ignored files block worktree removal.
IGNORED='ls-files --others --ignored'
if grep -qF "git -C <worktree> $IGNORED" "$BUNDLE/EPIC-CONTRACT.md" &&
  ! grep -qF 'status --ignored --short' "$BUNDLE/EPIC-CONTRACT.md" &&
  ! grep -q 'block cleanup' "$BUNDLE/t-ship/SKILL.md"; then
  ok_test "the contract lists every ignored file and t-ship drops the blocking claim"
else
  nok "cleanup prose still collapses ignored directories or expects them to block"
fi

new_landing cleanup
main="$TMP/cleanup/main" wt="$TMP/cleanup/wt"
printf '/.epics/\n.vscode/\n' >>"$main/$(git -C "$main" rev-parse --git-path info/exclude)"
mkdir -p "$wt/.vscode" "$wt/.epics/demo/notes"
printf 'private\n' >"$wt/.vscode/notes.md"
printf 'spec\n' >"$wt/.epics/demo/spec.md"
printf 'hidden\n' >"$wt/.epics/demo/.draft"
printf 'nested\n' >"$wt/.epics/demo/notes/a.md"
listed="$(git -C "$wt" ls-files --others --ignored --exclude-standard)"
if [[ "$(git -C "$wt" status --ignored --short)" != *notes.md* && "$listed" == *.vscode/notes.md* ]]; then
  ok_test "the ignored listing names a file that status --ignored hides"
else
  nok "the ignored listing missed .vscode/notes.md"
fi

archive="$main/.epics/demo/releases/c1"
mkdir -p "$archive"
cp -R "$wt/.epics/demo/." "$archive"
if diff -r "$wt/.epics/demo" "$archive" >/dev/null; then
  ok_test "the handover archive copies hidden and nested files"
else
  nok "the handover archive is incomplete"
fi
rm "$archive/notes/a.md"
if ! diff -r "$wt/.epics/demo" "$archive" >/dev/null; then
  ok_test "the archive check catches a missing handover file"
else
  nok "the archive check missed a missing handover file"
fi

printf 'stray\n' >"$wt/stray.txt"
if ! git -C "$main" worktree remove "$wt" >/dev/null 2>&1; then
  ok_test "worktree remove refuses an untracked file"
else
  nok "worktree remove deleted an untracked file"
fi
rm "$wt/stray.txt"
preserved="$main/.epics/demo/preserved/c1"
mkdir -p "$preserved/.vscode"
cp "$wt/.vscode/notes.md" "$preserved/.vscode/notes.md"
cmp -s "$wt/.vscode/notes.md" "$preserved/.vscode/notes.md" && copied=1 || copied=0
if git -C "$main" worktree remove "$wt" && [[ ! -e "$wt" && "$copied" == 1 ]] &&
  [[ "$(cat "$preserved/.vscode/notes.md")" == private ]]; then
  ok_test "worktree remove deletes ignored files, and only the preserved copy survives"
else
  nok "worktree removal or preservation did not behave as the contract assumes"
fi

if [[ $FAIL -eq 0 ]]; then
  printf '%d assertions passed\n' "$PASS"
  exit 0
fi
printf '%d of %d assertions failed\n' "$FAIL" "$((PASS + FAIL))"
exit 1
