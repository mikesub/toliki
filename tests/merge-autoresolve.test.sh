#!/usr/bin/env bash
set -euo pipefail

# Tests for merge-worker's conflict auto-resolution: bin/merge-resolve.awk
# (classifier, resolver, containment checker) against text fixtures, then
# bin/merge-autoresolve.sh end-to-end against real rebase stops. Hermetic by
# construction — throwaway repos under mktemp, no gh, no ssh, no network —
# so it is safe to run anywhere, including on the live host.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AWK_LIB="$ROOT/bin/merge-resolve.awk"
AUTORESOLVE="$ROOT/bin/merge-autoresolve.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0 FAIL=0
ok()  { PASS=$((PASS+1)); printf 'ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$1"; }

assert_rc() {  # <name> <want> <got>
  if [[ "$2" -eq "$3" ]]; then ok "$1"; else nok "$1 (rc: want $2, got $3)"; fi
}
assert_eq() {  # <name> <want> <got>
  if [[ "$2" == "$3" ]]; then ok "$1"; else
    nok "$1"
    printf -- '--- want ---\n%s\n--- got ----\n%s\n------------\n' "$2" "$3"
  fi
}
assert_contains() {  # <name> <needle> <haystack>
  if [[ "$3" == *"$2"* ]]; then ok "$1"; else
    nok "$1"
    printf -- '--- missing ---\n%s\n--- in --------\n%s\n---------------\n' "$2" "$3"
  fi
}

RES="$TMP/resolved"
run_resolve() {  # <marked-file> -> RC, REPORT; resolution lands in $RES
  rm -f "$RES"; RC=0
  REPORT="$(awk -v mode=resolve -v out="$RES" -f "$AWK_LIB" "$1" 2>&1)" || RC=$?
}
run_check() {  # <marked-file> <candidate> -> RC, OUTPUT
  RC=0
  OUTPUT="$(awk -v mode=check -f "$AWK_LIB" "$1" "$2" 2>&1)" || RC=$?
}

# ---------------------------------------------------------------- fixtures --

# Every hunk has an empty base: both sides added different content at the
# same point. Resolution is ours-then-theirs, context untouched.
cat > "$TMP/base0" <<'EOF'
ctx1
<<<<<<< HEAD
ours-a
||||||| parent of 1234abc (feat)
=======
theirs-a
theirs-b
>>>>>>> 1234abc (feat)
mid
<<<<<<< HEAD
ours-b
|||||||
=======
theirs-c
>>>>>>> 1234abc (feat)
ctx2
EOF

run_resolve "$TMP/base0"
assert_rc  "base0: resolves" 0 "$RC"
assert_eq  "base0: ours-then-theirs, context kept" \
"ctx1
ours-a
theirs-a
theirs-b
mid
ours-b
theirs-c
ctx2" "$(cat "$RES")"
assert_contains "base0: reports both-added twice" "hunk 2: both sides added" "$REPORT"
run_check "$TMP/base0" "$RES"
assert_rc  "base0: containment passes on its own resolution" 0 "$RC"

# One-sided, ours additive: ours reproduces the base verbatim and adds around
# it; theirs rewrote the base. Keep theirs' edit, keep ours' additions where
# they were.
cat > "$TMP/ours-add" <<'EOF'
<<<<<<< HEAD
added-above
base-1
base-2
added-below
||||||| merged common ancestors
base-1
base-2
=======
rewritten-1
>>>>>>> 1234abc (feat)
tail
EOF

run_resolve "$TMP/ours-add"
assert_rc "ours-additive: resolves" 0 "$RC"
assert_eq "ours-additive: edit replaces base, additions stay put" \
"added-above
rewritten-1
added-below
tail" "$(cat "$RES")"
assert_contains "ours-additive: reports one-sided" "one-sided - theirs edited 2 base line(s), ours only added around them" "$REPORT"
run_check "$TMP/ours-add" "$RES"
assert_rc "ours-additive: containment passes" 0 "$RC"

# One-sided, theirs additive — the mirror (and the live shape from whatif PR
# #283: main rewrote a JSDoc the epic left untouched while adding above it).
cat > "$TMP/theirs-add" <<'EOF'
<<<<<<< HEAD
rewritten-1
rewritten-2
||||||| parent of 1234abc (feat)
base-1
base-2
=======
added-above
base-1
base-2
>>>>>>> 1234abc (feat)
tail
EOF

run_resolve "$TMP/theirs-add"
assert_rc "theirs-additive: resolves" 0 "$RC"
assert_eq "theirs-additive: edit replaces base, additions stay put" \
"added-above
rewritten-1
rewritten-2
tail" "$(cat "$RES")"
assert_contains "theirs-additive: reports one-sided" "one-sided - ours edited 2 base line(s), theirs only added around them" "$REPORT"
run_check "$TMP/theirs-add" "$RES"
assert_rc "theirs-additive: containment passes" 0 "$RC"

# One-sided where the edit is a deletion: theirs removed the base lines
# outright. The deletion is the edit; the additive side's lines survive.
cat > "$TMP/edit-is-delete" <<'EOF'
<<<<<<< HEAD
added-above
base-1
||||||| x
base-1
=======
>>>>>>> y
EOF

run_resolve "$TMP/edit-is-delete"
assert_rc "edit-is-delete: resolves" 0 "$RC"
assert_eq "edit-is-delete: base gone, addition kept" "added-above" "$(cat "$RES")"
run_check "$TMP/edit-is-delete" "$RES"
assert_rc "edit-is-delete: containment passes" 0 "$RC"

# Mixed: one mechanical hunk plus one both-rewrote hunk. A single judgment
# hunk declines the whole file — there is no partial resolution.
cat > "$TMP/mixed" <<'EOF'
<<<<<<< HEAD
ours-a
|||||||
=======
theirs-a
>>>>>>> x
mid
<<<<<<< HEAD
ours-rewrite
||||||| b
old-line
=======
theirs-rewrite
>>>>>>> x
EOF

run_resolve "$TMP/mixed"
assert_rc "mixed: declines" 1 "$RC"
assert_contains "mixed: names the judgment hunk" "hunk 2: needs judgment - both sides edited the same base lines" "$REPORT"

# Every hunk is a both-sides rewrite: today's behaviour, untouched.
cat > "$TMP/both-rewrote" <<'EOF'
<<<<<<< HEAD
ours-rewrite
||||||| b
old-line
=======
theirs-rewrite
>>>>>>> x
EOF

run_resolve "$TMP/both-rewrote"
assert_rc "both-rewrote: declines" 1 "$RC"
assert_contains "both-rewrote: says why" "needs judgment - both sides edited the same base lines" "$REPORT"

# BOTH sides kept the base and added around it. Each is additive, so the
# content merge would be mechanical — but the ORDER of the two additions
# around the shared base is a choice, and choices are judgment.
cat > "$TMP/both-additive" <<'EOF'
<<<<<<< HEAD
base-1
ours-below
||||||| b
base-1
=======
theirs-above
base-1
>>>>>>> x
EOF

run_resolve "$TMP/both-additive"
assert_rc "both-additive: declines" 1 "$RC"
assert_contains "both-additive: says why" "merge order is a choice" "$REPORT"

# The additive side contains the base run TWICE (its own added block ends in
# the same blank line the base consists of). Every placement of the edit
# preserves the multiset, so containment cannot arbitrate — substituting at
# the wrong occurrence would reorder content and still pass the gate. Must
# decline, not guess.
cat > "$TMP/ambiguous-run" <<'EOF'
<<<<<<< HEAD
new para


|||||||

=======
### heading
>>>>>>> x
EOF

run_resolve "$TMP/ambiguous-run"
assert_rc "ambiguous-run: declines" 1 "$RC"
assert_contains "ambiguous-run: says why" "appears more than once in the additive side" "$REPORT"

# ----------------------------------------------------------------- partial --

# Partial mode (the fixer session's rung): mechanical hunks resolve exactly as
# in full mode, judgment hunks are handed off instead of declining the file —
# re-emitted byte-intact, markers, base section and all, so the judge
# downstream sees exactly what git wrote.
run_partial() {  # <marked-file> -> RC, REPORT; resolution lands in $RES
  rm -f "$RES"; RC=0
  REPORT="$(awk -v mode=resolve -v partial=1 -v out="$RES" -f "$AWK_LIB" "$1" 2>&1)" || RC=$?
}
run_check_partial() {  # <marked-file> <candidate> -> RC, OUTPUT
  RC=0
  OUTPUT="$(awk -v mode=check -v partial=1 -f "$AWK_LIB" "$1" "$2" 2>&1)" || RC=$?
}

run_partial "$TMP/mixed"
assert_rc "partial: mixed file resolves" 0 "$RC"
assert_eq "partial: mechanical hunk resolved, judgment hunk byte-intact" \
"ours-a
theirs-a
mid
<<<<<<< HEAD
ours-rewrite
||||||| b
old-line
=======
theirs-rewrite
>>>>>>> x" "$(cat "$RES")"
assert_contains "partial: reports the mechanical hunk" "hunk 1: both sides added" "$REPORT"
assert_contains "partial: reports the judgment hand-off" \
  "hunk 2: needs judgment - both sides edited the same base lines - left marked in place" "$REPORT"
run_check_partial "$TMP/mixed" "$RES"
assert_rc "partial: containment passes on its own resolution" 0 "$RC"

# An all-judgment file must come back byte-identical to its input.
run_partial "$TMP/both-rewrote"
assert_rc "partial: all-judgment file resolves" 0 "$RC"
if cmp -s "$TMP/both-rewrote" "$RES"; then
  ok "partial: all-judgment file reproduced byte-exact"
else
  nok "partial: all-judgment file reproduced byte-exact"
fi

# The partial containment gate must catch tampering with either share: a line
# dropped from a MECHANICAL resolution, and a judgment block that was touched
# (half-resolved, base section edited) — the byte-intact contract.
run_partial "$TMP/mixed"
grep -v 'theirs-a' "$RES" > "$TMP/p-dropped"
run_check_partial "$TMP/mixed" "$TMP/p-dropped"
assert_rc "partial containment: dropped mechanical line detected" 3 "$RC"
run_partial "$TMP/mixed"
sed 's/^old-line$/edited-base/' "$RES" > "$TMP/p-touched"
run_check_partial "$TMP/mixed" "$TMP/p-touched"
assert_rc "partial containment: touched judgment block detected" 3 "$RC"
assert_contains "partial containment: names the dropped base line" "dropped 1 x: old-line" "$OUTPUT"

# ------------------------------------------------------------- containment --

# A resolution that silently dropped one side's line. This is the exact
# failure the gate exists for: picking a side deletes the other side's test
# block and the test suite passes anyway.
run_resolve "$TMP/base0"
grep -v 'theirs-b' "$RES" > "$TMP/dropped"
run_check "$TMP/base0" "$TMP/dropped"
assert_rc "containment: dropped line detected" 3 "$RC"
assert_contains "containment: names the dropped line" "dropped 1 x: theirs-b" "$OUTPUT"

# A resolution with a line neither side wrote.
run_resolve "$TMP/base0"
printf 'invented-line\n' >> "$RES"
run_check "$TMP/base0" "$RES"
assert_rc "containment: invented line detected" 3 "$RC"
assert_contains "containment: names the invented line" "invented 1 x: invented-line" "$OUTPUT"

# Multiplicity: both sides added the SAME line, so the resolution must carry
# it twice. A set-based check would pass a copy that dropped one; the
# multiset check must not.
cat > "$TMP/dup" <<'EOF'
<<<<<<< HEAD
dup-line
|||||||
=======
dup-line
>>>>>>> x
EOF

printf 'dup-line\n' > "$TMP/dup-once"
run_check "$TMP/dup" "$TMP/dup-once"
assert_rc "containment: collapsed duplicate detected" 3 "$RC"
printf 'dup-line\ndup-line\n' > "$TMP/dup-twice"
run_check "$TMP/dup" "$TMP/dup-twice"
assert_rc "containment: both copies accepted" 0 "$RC"

# --------------------------------------------------------------- malformed --

# merge-style markers (no ||||||| section): an absent base is NOT an empty
# one — resolving through it would concatenate two rewrites.
cat > "$TMP/merge-style" <<'EOF'
<<<<<<< HEAD
ours-a
=======
theirs-a
>>>>>>> x
EOF

run_resolve "$TMP/merge-style"
assert_rc "merge-style markers: declines" 2 "$RC"
assert_contains "merge-style markers: says why" "not diff3 style" "$REPORT"

# No conflict markers at all: nothing this tool understands (a binary
# conflict or a submodule leaves no markers) — never "nothing to do".
printf 'just\nsome\nlines\n' > "$TMP/no-markers"
run_resolve "$TMP/no-markers"
assert_rc "no markers: declines" 2 "$RC"
assert_contains "no markers: says why" "no conflict markers" "$REPORT"

# Truncated hunk at EOF.
cat > "$TMP/truncated" <<'EOF'
<<<<<<< HEAD
ours-a
|||||||
=======
theirs-a
EOF

run_resolve "$TMP/truncated"
assert_rc "truncated hunk: declines" 2 "$RC"

# ------------------------------------------------- end-to-end, real rebase --

# The fixtures above assert on marker text this suite wrote; these assert on
# marker text GIT writes, mid-rebase, driven through bin/merge-autoresolve.sh
# exactly as merge-worker.sh drives it.

mkrepo() {  # <name> -> REPO
  REPO="$TMP/$1"
  git init -q -b main "$REPO"
  git -C "$REPO" config user.email test@example.com
  git -C "$REPO" config user.name test
  git -C "$REPO" config commit.gpgsign false
}
stop_on_conflict() {  # rebase detached feature onto main; must stop
  git -C "$REPO" checkout -q --detach feature
  if git -C "$REPO" -c merge.conflictStyle=diff3 rebase main >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# All three mechanical shapes in one stop: an empty-base hunk, a both-added
# file (no stage 1), and a one-sided hunk in each direction.
mkrepo e2e
printf 'line1\nline2\nline3\n' > "$REPO/shared.txt"
printf '/** doc1 */\n/** doc2 */\nfunction f() {}\n' > "$REPO/one.ts"
printf '/** doc1 */\n/** doc2 */\nfunction g() {}\n' > "$REPO/two.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'line1\nline2\nFEAT-1\nFEAT-2\nline3\n' > "$REPO/shared.txt"          # adds at the same point as main
printf 'const NEW = 1;\n/** doc1 */\n/** doc2 */\nfunction f() {}\n' > "$REPO/one.ts"   # additive: PR adds above untouched doc
printf '/** pr doc A */\n/** pr doc B */\nfunction g() {}\n' > "$REPO/two.ts"           # editor: PR rewrites the doc
printf 'feature file\n' > "$REPO/bothadded.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm feat
git -C "$REPO" checkout -q main
printf 'line1\nline2\nMAIN-1\nline3\n' > "$REPO/shared.txt"
printf '/** main doc A */\n/** main doc B */\nfunction f() {}\n' > "$REPO/one.ts"       # editor: main rewrites the doc
printf 'const MAIN = 1;\n/** doc1 */\n/** doc2 */\nfunction g() {}\n' > "$REPO/two.ts"  # additive: main adds above untouched doc
printf 'main file\n' > "$REPO/bothadded.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm main-side

if stop_on_conflict; then ok "e2e: rebase stops on conflict"; else nok "e2e: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" "$REPO" 2>&1)" || RC=$?
assert_rc "e2e: autoresolve succeeds" 0 "$RC"
if [[ -d "$REPO/.git/rebase-merge" || -d "$REPO/.git/rebase-apply" ]]; then
  nok "e2e: rebase finished"
else
  ok "e2e: rebase finished"
fi
assert_eq "e2e: exactly one commit on top of main" "1" "$(git -C "$REPO" rev-list --count main..HEAD)"
assert_eq "e2e: empty-base kept both sides, main first" \
"line1
line2
MAIN-1
FEAT-1
FEAT-2
line3" "$(cat "$REPO/shared.txt")"
assert_eq "e2e: both-added file kept both sides" \
"main file
feature file" "$(cat "$REPO/bothadded.txt")"
assert_eq "e2e: one-sided, main edited / PR added" \
"const NEW = 1;
/** main doc A */
/** main doc B */
function f() {}" "$(cat "$REPO/one.ts")"
assert_eq "e2e: one-sided, PR edited / main added" \
"const MAIN = 1;
/** pr doc A */
/** pr doc B */
function g() {}" "$(cat "$REPO/two.ts")"
assert_contains "e2e: report names each file" "shared.txt: hunk 1" "$OUT"
assert_contains "e2e: report labels the sides" "origin/main" "$OUT"
assert_contains "e2e: report covers the one-sided class" "one-sided - origin/main edited 2 base line(s), the PR only added around them" "$OUT"

# A judgment conflict must decline, leaving the rebase in place for the
# caller's abort — merge-worker owns that, and a test that found it aborted
# would be testing a resolver that overstepped.
mkrepo judge
printf 'keep\nchange-me\nkeep2\n' > "$REPO/f.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'keep\nfeature-version\nkeep2\n' > "$REPO/f.txt"
git -C "$REPO" commit -qam feat
git -C "$REPO" checkout -q main
printf 'keep\nmain-version\nkeep2\n' > "$REPO/f.txt"
git -C "$REPO" commit -qam main-side

if stop_on_conflict; then ok "judge: rebase stops on conflict"; else nok "judge: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" "$REPO" 2>&1)" || RC=$?
assert_rc "judge: autoresolve declines with the judgment code" 4 "$RC"
assert_contains "judge: first line names file and cause" "f.txt hunk 1: needs judgment" "$(head -n 1 <<<"$OUT")"
if [[ -d "$REPO/.git/rebase-merge" ]]; then
  ok "judge: rebase left in place for the caller's abort"
else
  nok "judge: rebase left in place for the caller's abort"
fi
git -C "$REPO" rebase --abort >/dev/null 2>&1 || true

# --partial against a real rebase stop: one file mixes a mechanical hunk with
# a judgment hunk, a second file is purely mechanical. The mechanical share is
# resolved (and the fully-settled file staged), the judgment hunk stays marked
# exactly as git wrote it, and the rebase is left in progress for the caller —
# who then finishes it the way the fixer session would.
mkrepo pe2e
cat > "$REPO/mixed.txt" <<'EOF'
a1
a2
a3
POINT
b1
b2
b3
change-me
c1
c2
c3
EOF
printf 'one\ntwo\nthree\n' > "$REPO/mech.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'a1\na2\na3\nPOINT\nFEAT\nb1\nb2\nb3\nfeature-version\nc1\nc2\nc3\n' > "$REPO/mixed.txt"
printf 'one\ntwo\nFEAT-M\nthree\n' > "$REPO/mech.txt"
git -C "$REPO" commit -qam feat
git -C "$REPO" checkout -q main
printf 'a1\na2\na3\nPOINT\nMAIN\nb1\nb2\nb3\nmain-version\nc1\nc2\nc3\n' > "$REPO/mixed.txt"
printf 'one\ntwo\nMAIN-M\nthree\n' > "$REPO/mech.txt"
git -C "$REPO" commit -qam main-side

if stop_on_conflict; then ok "partial-e2e: rebase stops on conflict"; else nok "partial-e2e: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" --partial "$REPO" 2>&1)" || RC=$?
assert_rc "partial-e2e: exits 0 with judgment hunks left" 0 "$RC"
if [[ -d "$REPO/.git/rebase-merge" || -d "$REPO/.git/rebase-apply" ]]; then
  ok "partial-e2e: rebase left in progress for the caller"
else
  nok "partial-e2e: rebase left in progress for the caller"
fi
assert_eq "partial-e2e: mechanical file fully resolved" \
"one
two
MAIN-M
FEAT-M
three" "$(cat "$REPO/mech.txt")"
assert_eq "partial-e2e: only the judgment file stays unmerged" "mixed.txt" \
  "$(git -C "$REPO" diff --name-only --diff-filter=U)"
assert_contains "partial-e2e: mechanical hunk resolved inside the mixed file" "MAIN
FEAT" "$(cat "$REPO/mixed.txt")"
assert_contains "partial-e2e: judgment hunk still marked" "<<<<<<< HEAD" "$(cat "$REPO/mixed.txt")"
assert_contains "partial-e2e: marker block carries the base section" "|||||||" "$(cat "$REPO/mixed.txt")"
assert_contains "partial-e2e: ours side inside the markers" "main-version" "$(cat "$REPO/mixed.txt")"
assert_contains "partial-e2e: theirs side inside the markers" "feature-version" "$(cat "$REPO/mixed.txt")"
assert_contains "partial-e2e: report hands the judgment hunk off" "needs judgment" "$OUT"
assert_contains "partial-e2e: report covers the mechanical share" "both sides added" "$OUT"

# Finish the stop the way the fixer would: settle the judgment hunk by hand,
# stage, continue — proving partial left a continuable rebase behind.
awk '/^<<<<<<< /{skip=1; print "merged-version"; next} /^>>>>>>> /{skip=0; next} skip{next} {print}' \
  "$REPO/mixed.txt" > "$TMP/pe2e-settled"
cat "$TMP/pe2e-settled" > "$REPO/mixed.txt"
git -C "$REPO" add mixed.txt
GIT_EDITOR=true git -C "$REPO" rebase --continue >/dev/null 2>&1 || true
if [[ -d "$REPO/.git/rebase-merge" || -d "$REPO/.git/rebase-apply" ]]; then
  nok "partial-e2e: hand-settled rebase continues to completion"
else
  ok "partial-e2e: hand-settled rebase continues to completion"
fi
assert_eq "partial-e2e: exactly one commit on top of main" "1" "$(git -C "$REPO" rev-list --count main..HEAD)"

# A rebase in progress with NO unmerged paths (a predecessor's leftover state,
# or everything already staged) must decline with a distinct first line — the
# fixer's prepare keys on it rather than improvising. Reuse the pe2e stop:
# stage the still-marked file, then ask for a partial resolve of nothing.
mkrepo leftover
printf 'keep\nchange-me\n' > "$REPO/f.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'keep\nfeature-version\n' > "$REPO/f.txt"
git -C "$REPO" commit -qam feat
git -C "$REPO" checkout -q main
printf 'keep\nmain-version\n' > "$REPO/f.txt"
git -C "$REPO" commit -qam main-side
if stop_on_conflict; then ok "leftover: rebase stops on conflict"; else nok "leftover: rebase did not conflict"; fi
git -C "$REPO" add f.txt   # clears the unmerged entries; the rebase state remains
RC=0; OUT="$("$AUTORESOLVE" --partial "$REPO" 2>&1)" || RC=$?
assert_rc "leftover: partial declines" 1 "$RC"
assert_contains "leftover: names the state distinctly" "rebase stopped without unmerged paths" "$OUT"
git -C "$REPO" rebase --abort >/dev/null 2>&1 || true

# Delete/modify: no stage 2, nothing two-sided to merge — declined before the
# resolver ever runs.
mkrepo delmod
printf 'a\nb\n' > "$REPO/f.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'a\nb\nc\n' > "$REPO/f.txt"
git -C "$REPO" commit -qam feat
git -C "$REPO" checkout -q main
git -C "$REPO" rm -q f.txt && git -C "$REPO" commit -qm main-deletes

if stop_on_conflict; then ok "delmod: rebase stops on conflict"; else nok "delmod: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" "$REPO" 2>&1)" || RC=$?
assert_rc "delmod: autoresolve declines" 1 "$RC"
assert_contains "delmod: says why" "not a two-sided regular-file content conflict" "$OUT"
git -C "$REPO" rebase --abort >/dev/null 2>&1 || true

# A symlink conflict must decline at the stage gate — the resolver would
# otherwise read through the link and write through it.
mkrepo slink
printf 'x\n' > "$REPO/t1"; printf 'y\n' > "$REPO/t2"; printf 'z\n' > "$REPO/t3"
ln -s t1 "$REPO/link"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
rm "$REPO/link" && ln -s t2 "$REPO/link"
git -C "$REPO" add -A && git -C "$REPO" commit -qm feat
git -C "$REPO" checkout -q main
rm "$REPO/link" && ln -s t3 "$REPO/link"
git -C "$REPO" add -A && git -C "$REPO" commit -qm main-side

if stop_on_conflict; then ok "slink: rebase stops on conflict"; else nok "slink: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" "$REPO" 2>&1)" || RC=$?
assert_rc "slink: autoresolve declines" 1 "$RC"
assert_contains "slink: says why" "symlink or submodule" "$OUT"
if [[ -L "$REPO/link" ]]; then ok "slink: the link itself untouched"; else nok "slink: the link itself untouched"; fi
git -C "$REPO" rebase --abort >/dev/null 2>&1 || true

# A file whose own tracked content contains marker-shaped lines (a fixture,
# docs about resolving conflicts) makes the marked file unparseable: the
# fake markers are indistinguishable from real ones, and the containment
# checker shares the parse. The pre-merge blobs are unambiguous, so the
# decline comes from them — even though the actual conflict is mechanical.
mkrepo markerish
cat > "$REPO/docs.md" <<'EOF'
how to read a conflict:
<<<<<<< HEAD
your side
=======
their side
>>>>>>> branch
that is all
tail-line
EOF
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'feat-appended\n' >> "$REPO/docs.md"
git -C "$REPO" commit -qam feat
git -C "$REPO" checkout -q main
printf 'main-appended\n' >> "$REPO/docs.md"
git -C "$REPO" commit -qam main-side

if stop_on_conflict; then ok "markerish: rebase stops on conflict"; else nok "markerish: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" "$REPO" 2>&1)" || RC=$?
assert_rc "markerish: autoresolve declines" 1 "$RC"
assert_contains "markerish: says why" "conflict-marker-shaped lines" "$OUT"
git -C "$REPO" rebase --abort >/dev/null 2>&1 || true

# A file with no final newline must not gain one: the conflict sits above,
# the unterminated tail is context, and the resolution must end exactly as
# the file did.
mkrepo noeol
printf 'line1\nline2\nTAIL' > "$REPO/f.txt"
git -C "$REPO" add -A && git -C "$REPO" commit -qm base
git -C "$REPO" checkout -qb feature
printf 'line1\nFEAT\nline2\nTAIL' > "$REPO/f.txt"
git -C "$REPO" commit -qam feat
git -C "$REPO" checkout -q main
printf 'line1\nMAIN\nline2\nTAIL' > "$REPO/f.txt"
git -C "$REPO" commit -qam main-side

if stop_on_conflict; then ok "noeol: rebase stops on conflict"; else nok "noeol: rebase did not conflict"; fi
RC=0; OUT="$("$AUTORESOLVE" "$REPO" 2>&1)" || RC=$?
assert_rc "noeol: autoresolve succeeds" 0 "$RC"
printf 'line1\nMAIN\nFEAT\nline2\nTAIL' > "$TMP/noeol-want"
if cmp -s "$TMP/noeol-want" "$REPO/f.txt"; then
  ok "noeol: byte-exact, no newline invented at EOF"
else
  nok "noeol: byte-exact, no newline invented at EOF"
  od -c "$REPO/f.txt" | tail -3
fi

# ----------------------------------------------------------------- summary --

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
