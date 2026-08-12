#!/usr/bin/env bash
set -euo pipefail

# The git half of merge-worker's conflict auto-resolution; the text half is
# bin/merge-resolve.awk beside it. Called on a worktree whose rebase onto
# origin/main just stopped on conflicts, and resolves the stop IFF every hunk
# in every conflicted file is mechanical — both sides only added at the same
# point (empty base), or exactly one side edited base lines the other merely
# added around. One hunk needing judgment declines the whole run; deciding
# stays a human's job.
#
# Every resolution is verified before it is staged: a literal line-containment
# check that every line of both sides survived into the resolved file (minus
# the base lines an editing side legitimately replaced). That gate exists
# because the cheap alternative — pick a side and let the tests vote — is
# blind here: dropping the other side's added test block fails nothing.
#
# Usage: merge-autoresolve.sh <worktree>
#
#   exit 0  every conflict was mechanical: resolved, verified, staged, and the
#           rebase continued to completion. Stdout carries one report line per
#           hunk ("<file>: hunk N: ...") for the caller's audit comment.
#   exit 1  declined. The FIRST stdout line says why; the rebase is left in
#           place so the caller can inspect, and the caller owns the abort.
#
# Standalone on purpose: no lib.sh, no repos.conf, no gh, no ssh — it touches
# only the worktree it is given, so tests can drive it against a throwaway
# repo end-to-end.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AWK_LIB="$HERE/merge-resolve.awk"

WT="${1:-}"
if [[ -z "$WT" || ! -d "$WT" ]]; then
  echo "usage: $0 <worktree>"; exit 1
fi
git -C "$WT" rev-parse --git-dir >/dev/null 2>&1 || { echo "$WT is not a git worktree"; exit 1; }

# The one-line reason is the first thing printed, so the caller can lift it
# straight into a failure comment.
fail() { printf '%s\n' "$1"; exit 1; }

# --git-path answers relative to the worktree unless already absolute.
git_path() {
  local p; p="$(git -C "$WT" rev-parse --git-path "$1")"
  [[ "$p" == /* ]] && printf '%s' "$p" || printf '%s/%s' "$WT" "$p"
}
rebase_in_progress() {
  [[ -d "$(git_path rebase-merge)" || -d "$(git_path rebase-apply)" ]]
}

rebase_in_progress || fail "no rebase in progress in $WT"

# -z: conflicted paths come from project repos, so take no chances on quoting.
paths=()
while IFS= read -r -d '' p; do paths+=("$p"); done \
  < <(git -C "$WT" diff --name-only -z --diff-filter=U)
(( ${#paths[@]} > 0 )) || fail "rebase stopped without unmerged paths - nothing mechanical to resolve"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
resolved="$tmp/resolved"
report="$tmp/report"
all_reports=""

# Diff3 marker lines, as an ERE. Used against the pre-merge blobs below.
MARKER_RE='^([<]{7}( |$)|[>]{7}( |$)|[|]{7}( |$)|[=]{7}$)'

# Only two-sided regular-file content conflicts have text to merge. A missing
# stage 2 or 3 is delete/modify or a rename; a symlink (120000) or submodule
# (160000) entry leaves no both-sides lines in the worktree file — worse, awk
# would read through a link and `cat >` would write through it.
for p in "${paths[@]}"; do
  entries="$(git -C "$WT" ls-files -u -- "$p")"
  if ! awk '$3 == 2 || $3 == 3 { seen[$3] = 1; if ($1 != "100644" && $1 != "100755") bad = 1 }
            END { exit (seen[2] && seen[3] && !bad) ? 0 : 1 }' <<<"$entries"; then
    fail "$p: not a two-sided regular-file content conflict (a side deleted or renamed it, or it is a symlink or submodule)"
  fi
  # The parser's one blind spot is tracked content that LOOKS like conflict
  # markers (a merge-tool fixture, docs about resolving conflicts): in the
  # marked file it is indistinguishable from the real thing, and the
  # containment checker shares the same parse, so a misread would sail
  # through both. The pre-merge blobs are unambiguous — consult them, and
  # decline the file if any side's own content carries marker-shaped lines.
  for s in 1 2 3; do
    git -C "$WT" cat-file blob ":$s:$p" > "$tmp/stage" 2>/dev/null || continue
    if grep -qE "$MARKER_RE" "$tmp/stage"; then
      fail "$p: its own content contains conflict-marker-shaped lines, so the marked file cannot be parsed unambiguously"
    fi
  done
done

for p in "${paths[@]}"; do
  # Scrub the previous file's output so a resolver that dies before its first
  # write can never be checked against stale content.
  rm -f "$resolved"
  rc=0
  awk -v mode=resolve -v out="$resolved" \
      -v ours_label="origin/main" -v theirs_label="the PR" \
      -f "$AWK_LIB" "$WT/$p" >"$report" 2>&1 || rc=$?
  if (( rc != 0 )); then
    # The first judgment line is the most useful reason; malformed input puts
    # its diagnostic on the last line instead.
    why="$(awk '/needs judgment/ { print; exit }' "$report")"
    [[ -n "$why" ]] || why="$(tail -n 1 "$report")"
    fail "$p ${why:-conflict is not mechanical}"
  fi

  # The decisive gate, and deliberately a separate pass with none of the
  # resolver's positional logic: multiset line containment of the candidate
  # against a re-classification of the still-marked file.
  if ! awk -v mode=check -f "$AWK_LIB" "$WT/$p" "$resolved" >"$tmp/check" 2>&1; then
    fail "$p: auto-resolution dropped content it had no license to drop ($(head -n 1 "$tmp/check"))"
  fi

  # awk's print newline-terminates every line; give back the missing final
  # newline of a file that never had one. (BSD head rejects a byte count of
  # 0, so a one-byte resolution — a single empty line — truncates instead.)
  if [[ -s "$resolved" && -n "$(tail -c 1 "$WT/$p")" ]]; then
    size="$(wc -c < "$resolved")"
    if (( size > 1 )); then
      head -c "$(( size - 1 ))" "$resolved" > "$resolved.trim"
      mv "$resolved.trim" "$resolved"
    else
      : > "$resolved"
    fi
  fi

  cat "$resolved" > "$WT/$p"   # cat > keeps the file's mode, mv would not
  git -C "$WT" add -- "$p"
  while IFS= read -r line; do
    all_reports="$all_reports$p: $line"$'\n'
  done < "$report"
done

# The original commit message stands — there is nothing to edit.
GIT_EDITOR=true git -C "$WT" rebase --continue >/dev/null 2>&1 \
  || fail "every conflict resolved mechanically, but rebase --continue still failed"

# An epic branch holds exactly one commit, so one stop is the whole rebase —
# but verify rather than assume, because the caller is about to push HEAD.
rebase_in_progress && fail "rebase still in progress after --continue - more than one commit conflicted"

printf '%s' "$all_reports"
exit 0
