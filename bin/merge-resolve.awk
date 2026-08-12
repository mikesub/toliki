#!/usr/bin/awk -f
# Classify and mechanically resolve diff3-style conflict hunks. The text half
# of merge-worker's conflict auto-resolution: bin/merge-autoresolve.sh owns the
# git side and calls this per conflicted file; tests drive it directly.
#
# Two classes of hunk are mechanical — resolvable with no judgment at all:
#
#   both-added   The base section is EMPTY: neither side touched existing
#                lines, each added different content at the same point. The
#                resolution is every line of both sides, ours then theirs.
#   one-sided    The base is non-empty but exactly ONE side reproduces it
#                verbatim as a contiguous run — that side is purely additive,
#                and only pulled the base into the hunk by adding adjacent
#                content. The resolution is the other side's edit of the base
#                lines with the additive side's additions kept in place.
#
# Anything else — both sides rewrote the same base lines, or both kept the
# base and added around it (merge order would be a choice) — needs judgment,
# and one such hunk declines the whole file. Deciding is the caller's job;
# this script only ever reports.
#
# Modes (portable awk: BSD awk and mawk, so no gawk-isms):
#
#   -v mode=resolve -v out=<path>  <marked-file>
#       Write the resolution of <marked-file> to <path>; print one report
#       line per hunk on stdout.
#   -v mode=check  <marked-file> <resolution>
#       Verify the candidate resolution by line containment: re-classify the
#       hunks, then require the resolution to hold, as a multiset, exactly the
#       context plus every line of both sides of every hunk, minus one copy of
#       the base lines an editing side legitimately replaced. Deliberately
#       positional-logic-free, so a resolver emission bug fails here rather
#       than being reproduced here.
#
#   -v partial=1   the third mode, as an axis on the two above: a judgment
#       hunk stops being a decline and becomes a hand-off. resolve re-emits
#       its ENTIRE marker block — markers, base section and all — byte-intact
#       into the output, so a downstream judge sees exactly the hunk git
#       wrote, with nothing pre-chewed; check expects those same raw block
#       lines verbatim, so a resolution that touched a judgment hunk (or
#       half-resolved one) fails containment. Mechanical hunks keep exactly
#       the full-mode behaviour and the full-mode guarantee.
#
#   -v ours_label=... -v theirs_label=...  name the sides in report text
#       (merge-worker passes "origin/main" and "the PR").
#
# Exit: 0 mechanical/verified; 1 some hunk needs judgment (never with
# partial=1, where judgment is expected content, not a decline); 2 malformed
# input (not diff3 markers, EOF inside a hunk, or no markers at all); 3
# containment failed; 4 usage. Every non-zero exit is a decline — the caller
# falls back to today's behaviour, never merges a partial answer.

BEGIN {
  if (mode != "resolve" && mode != "check") {
    print "merge-resolve.awk: pass -v mode=resolve or -v mode=check"
    fatal = 4; exit 4
  }
  if (mode == "resolve" && (out == "" || ARGC != 2)) {
    print "merge-resolve.awk: resolve mode needs -v out=<path> and exactly one input file"
    fatal = 4; exit 4
  }
  if (mode == "check" && ARGC != 3) {
    print "merge-resolve.awk: check mode takes the marked file then the resolution"
    fatal = 4; exit 4
  }
  if (ours_label == "")   ours_label = "ours"
  if (theirs_label == "") theirs_label = "theirs"
  S = "ctx"; hunks = 0; judgment = 0; in_resolution = 0
}

# Literal prefix tests rather than /^<{7}/: mawk has no interval expressions.
function is_ours(l)   { return l == "<<<<<<<" || substr(l, 1, 8) == "<<<<<<< " }
function is_base(l)   { return l == "|||||||" || substr(l, 1, 8) == "||||||| " }
function is_sep(l)    { return l == "=======" }
function is_end(l)    { return l == ">>>>>>>" || substr(l, 1, 8) == ">>>>>>> " }

function bad_marker() {
  print "line " FNR ": unexpected conflict marker inside a hunk"
  fatal = 2; exit 2
}

# A context or resolved-hunk line: resolve mode emits it, check mode counts it
# toward the expected multiset.
function keep(l) {
  if (mode == "resolve") print l > out
  else expected[l]++
}

# Index of the base section as a contiguous run in side[1..n] — but only when
# it occurs exactly ONCE; 0 otherwise, with the occurrence count left in
# `runs`. Multiplicity is harmless to classification and invisible to
# containment (every placement preserves the multiset) — which is exactly why
# it must decline: an edit substituted at the WRONG occurrence reorders
# content and still passes the gate. Ambiguous placement is judgment.
function run_at(side, n,   i, j, hit, pos) {
  runs = 0; pos = 0
  if (bn == 0 || bn > n) return 0
  for (i = 1; i <= n - bn + 1; i++) {
    hit = 1
    for (j = 1; j <= bn; j++)
      if (side[i + j - 1] != base[j]) { hit = 0; break }
    if (hit) { runs++; if (pos == 0) pos = i }
  }
  return (runs == 1) ? pos : 0
}

function end_hunk(   i, opos, tpos, oruns, truns, cls, why) {
  opos = 0; tpos = 0; oruns = 0; truns = 0
  if (bn == 0) cls = "both-added"
  else {
    opos = run_at(ours, on);   oruns = runs
    tpos = run_at(theirs, tn); truns = runs
    if (opos && truns == 0)      cls = "ours-additive"
    else if (tpos && oruns == 0) cls = "theirs-additive"
    else                         cls = ""
  }

  if (cls == "") {
    judgment++
    if (oruns > 0 && truns > 0)
      why = "both sides kept the base and added around it, so merge order is a choice"
    else if (oruns > 1 || truns > 1)
      why = "the base run appears more than once in the additive side, so the edit's placement is ambiguous"
    else
      why = "both sides edited the same base lines"
    if (!partial) {
      print "hunk " hunks ": needs judgment - " why
      return
    }
    # Partial: hand the hunk off rather than declining the file. raw[] holds
    # the block exactly as read — marker lines included — so what the judge
    # downstream sees is what git wrote, byte for byte.
    print "hunk " hunks ": needs judgment - " why " - left marked in place"
    for (i = 1; i <= rn; i++) {
      if (mode == "resolve") print raw[i] > out
      else expected[raw[i]]++
    }
    return
  }

  if (mode == "check") {
    # Every line of both sides, minus one copy of the base an editing side
    # replaced (for both-added bn is 0 and nothing is subtracted). The
    # additive side contains the base run, so no count can end up negative.
    for (i = 1; i <= on; i++) expected[ours[i]]++
    for (i = 1; i <= tn; i++) expected[theirs[i]]++
    for (i = 1; i <= bn; i++) expected[base[i]]--
    return
  }

  if (cls == "both-added") {
    for (i = 1; i <= on; i++) keep(ours[i])
    for (i = 1; i <= tn; i++) keep(theirs[i])
    print "hunk " hunks ": both sides added here (empty base) - kept both, " \
          ours_label " (" on " lines) then " theirs_label " (" tn " lines)"
  } else if (cls == "ours-additive") {
    for (i = 1; i < opos; i++)       keep(ours[i])
    for (i = 1; i <= tn; i++)        keep(theirs[i])
    for (i = opos + bn; i <= on; i++) keep(ours[i])
    print "hunk " hunks ": one-sided - " theirs_label " edited " bn \
          " base line(s), " ours_label " only added around them - kept the edit plus the additions"
  } else {
    for (i = 1; i < tpos; i++)       keep(theirs[i])
    for (i = 1; i <= on; i++)        keep(ours[i])
    for (i = tpos + bn; i <= tn; i++) keep(theirs[i])
    print "hunk " hunks ": one-sided - " ours_label " edited " bn \
          " base line(s), " theirs_label " only added around them - kept the edit plus the additions"
  }
}

# Boundary between the two check-mode inputs. Must be the first per-line rule.
FNR == 1 && NR > 1 {
  if (S != "ctx") {
    print "marked file ends inside a conflict hunk"
    fatal = 2; exit 2
  }
  in_resolution = 1
}

in_resolution { actual[$0]++; next }

# raw[] mirrors the current hunk verbatim — every line from '<<<<<<<' through
# '>>>>>>>' inclusive — for partial mode's byte-intact hand-off of judgment
# hunks. Collected unconditionally: hunks are small and one branch fewer.
S == "ctx" {
  if (is_ours($0)) { S = "ours"; on = 0; bn = 0; tn = 0; hunks++; rn = 0; raw[++rn] = $0 }
  else keep($0)
  next
}
S == "ours" {
  raw[++rn] = $0
  if (is_base($0)) S = "base"
  else if (is_sep($0)) {
    # merge-style markers hide the base section, and an absent base is not an
    # empty one — treating it as such would concatenate two rewrites.
    print "line " FNR ": '=======' before any '|||||||' - markers are not diff3 style"
    fatal = 2; exit 2
  }
  else if (is_ours($0) || is_end($0)) bad_marker()
  else ours[++on] = $0
  next
}
S == "base" {
  raw[++rn] = $0
  if (is_sep($0)) S = "theirs"
  else if (is_ours($0) || is_base($0) || is_end($0)) bad_marker()
  else base[++bn] = $0
  next
}
S == "theirs" {
  raw[++rn] = $0
  if (is_end($0)) { end_hunk(); S = "ctx" }
  else if (is_ours($0) || is_base($0) || is_sep($0)) bad_marker()
  else theirs[++tn] = $0
  next
}

END {
  if (fatal) exit fatal
  if (S != "ctx") { print "input ends inside a conflict hunk"; exit 2 }
  if (hunks == 0) { print "no conflict markers found"; exit 2 }
  if (judgment && !partial) exit 1
  if (mode == "resolve") exit 0

  bad = 0
  for (l in expected) {
    if (actual[l] < expected[l]) {
      print "dropped " (expected[l] - actual[l]) " x: " l
      bad = 1
    }
  }
  for (l in actual) {
    if (actual[l] > expected[l]) {
      print "invented " (actual[l] - expected[l]) " x: " l
      bad = 1
    }
  }
  if (bad) exit 3
  exit 0
}
