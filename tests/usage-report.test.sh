#!/usr/bin/env bash
set -uo pipefail

# Exercises workflows/usage-report.mjs against hand-written JSONL fixtures under
# mktemp. Hermetic by construction: no pipeline runs, no clock and no network —
# the records ARE the input, so every total, outcome and disclosure the report
# prints is checked against values that are known exactly.
#
# Two views are asserted separately:
#   - the per-step tuning view, which keeps its record-level --since/--engine/
#     --script filtering and names its summed spawn time model-active;
#   - the issue-lifetime view, which aggregates every recorded pipeline
#     invocation of one (repository, issue) pair across runIds and engines.
#
# The lifetime view's layout, as asserted below:
#   issue lifetimes (log-known)     the section header
#   <repo>                          a group header line: the bare registry key
#   #<issue> …                      one row per issue; its first line starts with #N
#     …                             a continuation line with tokens and retries
#   runs without repository/issue identity (never joined to an issue lifetime)
#                                   the trailing group, one row per runId
#   all repositories: …             cross-repository totals
#   human handoff: N of D conclusive lifetime(s) (P%)
#   not counted: repair-queued n, quota-held n, skipped n, error n, manual n, incomplete n, unknown n
#   malformed records skipped: n    interior records that did not parse
#
# The field spellings a row uses (each asserted on its own, so column padding
# stays free):
#   launches N (epic-run a, fix-run b, ci-run c, defect-run d)
#   first <stamp>   latest <stamp>   wall <dur>   span <dur>
#   result <outcome>   handoff yes|no   incomplete N
#   spawns N   model-active <dur>   in N · cache-read N · cache-create N · out N
#   $B (+$E estimated, U unpriced)
#   respawns N   retries N   relaunches N   fixer attempts N
# Durations read 0m, <1m, 45m, 1h 10m, 1d 2h; an unknowable span is `-`.
# Timestamps are rendered through lib/time.mjs in HOST_TIMEZONE, pinned to UTC
# here so the fixtures' canonical UTC instants are what a row shows.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"
    printf '%s\n' "$2" | head -n 12 | sed 's/^/       | /'
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi; }
section() { printf '\n%s\n' "$1"; }

# ───────────────────────── fixture writers ─────────────────────────
# The laptop these suites also run on is macOS, whose date has no GNU -d: every
# conversion below tries the BSD form first and falls back to GNU, the way
# tests/reap-worktree.test.sh and bin/reap.sh do. `date -u +%s` is the one
# relative form both implementations share, so offsets are taken in seconds.
iso_epoch() { date -u -j -f '%Y-%m-%dT%H:%M:%S' "${1%.*}" +%s 2>/dev/null || date -u -d "$1" +%s; }
epoch_iso() { date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z; }

# issue, repo and session are written as JSON literals ("myapp" or null), so a
# fixture can state the absence of an identity as precisely as its presence.
TOKENS='{"input":1000,"output":200,"cacheRead":500,"cacheCreate":100,"total":1800}'
NO_TOKENS='{"input":null,"output":null,"cacheRead":null,"cacheCreate":null,"total":null}'

run_start() { # file ts runId script engine issue repo [session]
  printf '{"type":"run-start","ts":"%s","runId":"%s","script":"%s","engine":"%s","session":%s,"issue":%s,"repo":%s}\n' \
    "$2" "$3" "$4" "$5" "${8:-null}" "$6" "$7" >> "$1"
}

run_finish() { # file ts runId script engine issue repo ms outcome handoff exit attempt
  local file="$1" ts="$2" ms="$8" started
  started="$(epoch_iso $(( $(iso_epoch "$ts") - ms / 1000 )))"
  printf '{"type":"run-finish","ts":"%s","runId":"%s","script":"%s","engine":"%s","session":null,"issue":%s,"repo":%s,"startedAt":"%s","ms":%s,"outcome":%s,"handoff":%s,"exit":%s,"attempt":%s}\n' \
    "$ts" "$3" "$4" "$5" "$6" "$7" "$started" "$ms" "$9" "${10}" "${11}" "${12}" >> "$file"
}

# cost-kind picks the money and usage shape a real adapter would have produced:
#   cli      the vendor's own figure      table    priced from lib/prices.mjs
#   unpriced tokens with no price row     nousage  a CLI that reported nothing
spawn() { # file ts runId script engine issue repo label attempt retry ms cost cost-kind
  local file="$1" ts="$2" runId="$3" script="$4" engine="$5" issue="$6" repo="$7" label="$8"
  local attempt="$9" retry="${10}" ms="${11}" cost="${12}" kind="${13}"
  local step="${label%%:*}" vendor=claude model=opus tokens="$TOKENS" cost_json cost_source
  case "$kind" in
    cli)      cost_json="$cost"; cost_source='"cli"' ;;
    table)    cost_json="$cost"; cost_source='"table"'; vendor=codex; model=gpt-5.6-sol ;;
    unpriced) cost_json=null;    cost_source=null;     vendor=codex; model=gpt-5.6-nopricerow ;;
    nousage)  cost_json=null;    cost_source=null;     tokens="$NO_TOKENS" ;;
    *) printf 'unknown cost kind %s\n' "$kind" >&2; exit 9 ;;
  esac
  printf '{"type":"spawn","ts":"%s","runId":"%s","script":"%s","session":null,"issue":%s,"repo":%s,"engine":"%s","step":"%s","label":"%s","attempt":%s,"retry":%s,"vendor":"%s","model":"%s","effort":"high","ok":true,"timedOut":false,"ms":%s,"tokens":%s,"costUsd":%s,"costSource":%s,"turns":3,"failureKind":null,"failureReason":null}\n' \
    "$ts" "$runId" "$script" "$issue" "$repo" "$engine" "$step" "$label" "$attempt" "$retry" \
    "$vendor" "$model" "$ms" "$tokens" "$cost_json" "$cost_source" >> "$file"
}

# A legacy row: what the log held before lifecycle records existed. No type, no
# repo, no retry — and the report must still count its tokens and dollars.
legacy_spawn() { # file ts runId script engine issue label ms cost
  printf '{"ts":"%s","runId":"%s","script":"%s","session":null,"issue":%s,"engine":"%s","step":"%s","label":"%s","attempt":1,"vendor":"claude","model":"opus","effort":"high","ok":true,"timedOut":false,"ms":%s,"tokens":%s,"costUsd":%s,"costSource":"cli","turns":3,"failureKind":null,"failureReason":null}\n' \
    "$2" "$3" "$4" "$6" "$5" "${7%%:*}" "$7" "$8" "$TOKENS" "$9" >> "$1"
}

REPORT_OUT=""
REPORT_RC=0
report() { # log-file [args...]
  local log="$1"; shift
  REPORT_RC=0
  REPORT_OUT="$(HOST_TIMEZONE=UTC TZ=UTC node "$ROOT/workflows/usage-report.mjs" --log "$log" "$@" 2>&1)" || REPORT_RC=$?
}

# A lifetime row is its first line plus the continuation under it, joined: which
# of the two lines carries a field is layout, not behavior.
row() { # issue -> the row's lines as one string
  printf '%s\n' "$REPORT_OUT" | grep -A1 -E "^[[:space:]]*#$1([^0-9]|$)" | tr '\n' ' '
}
has_row() { printf '%s\n' "$REPORT_OUT" | grep -qE "^[[:space:]]*#$1([^0-9]|$)"; }
line_with() { printf '%s\n' "$REPORT_OUT" | grep -F -- "$1" | head -n1; }
row_order() { printf '%s\n' "$REPORT_OUT" | grep -oE '^[[:space:]]*#[0-9]+' | tr -d ' #' | tr '\n' ' ' | sed 's/ $//'; }
group_line() { printf '%s\n' "$REPORT_OUT" | grep -cxF "$1"; }

# ───────────────────────── one issue's whole lifetime ─────────────────────────
# An epic that held for review, a relaunch that queued a defect repair, then a
# defect, conflict and CI fixer: five invocations, five runIds, one issue. The
# four retry categories are deliberately all present and all different.
section 'one issue: epic, relaunch and three fixer kinds are one lifetime'
LIFE="$TMP/lifetime.jsonl"
run_start  "$LIFE" 2026-03-01T10:00:00.000Z r1 epic-run claude 42 '"myapp"' '"myapp-epic-42"'
spawn      "$LIFE" 2026-03-01T10:01:00.000Z r1 epic-run claude 42 '"myapp"' architect:design 1 false 600000 0.50 cli
spawn      "$LIFE" 2026-03-01T10:10:00.000Z r1 epic-run claude 42 '"myapp"' code:red 2 false 300000 0.50 cli
spawn      "$LIFE" 2026-03-01T10:20:00.000Z r1 epic-run claude 42 '"myapp"' code:red:retry 1 true 300000 0.50 cli
run_finish "$LIFE" 2026-03-01T10:30:00.000Z r1 epic-run claude 42 '"myapp"' 1800000 '"human-review"' true 0 null
run_start  "$LIFE" 2026-03-01T12:00:00.000Z r2 epic-run claude 42 '"myapp"' '"myapp-epic-42"'
spawn      "$LIFE" 2026-03-01T12:05:00.000Z r2 epic-run claude 42 '"myapp"' fixes-after-review:retry 1 true 600000 0.50 cli
run_finish "$LIFE" 2026-03-01T12:20:00.000Z r2 epic-run claude 42 '"myapp"' 1200000 '"repair-queued"' false 0 null
run_start  "$LIFE" 2026-03-01T13:00:00.000Z r3 defect-run claude 42 '"myapp"' '"myapp-epic-42"'
spawn      "$LIFE" 2026-03-01T13:02:00.000Z r3 defect-run claude 42 '"myapp"' defect:repair 1 false 300000 0.10 table
run_finish "$LIFE" 2026-03-01T13:10:00.000Z r3 defect-run claude 42 '"myapp"' 600000 '"repair-queued"' false 0 1
run_start  "$LIFE" 2026-03-02T09:00:00.000Z r4 fix-run claude 42 '"myapp"' '"myapp-epic-42"'
spawn      "$LIFE" 2026-03-02T09:02:00.000Z r4 fix-run claude 42 '"myapp"' fix:resolve 1 false 300000 0.10 table
run_finish "$LIFE" 2026-03-02T09:05:00.000Z r4 fix-run claude 42 '"myapp"' 300000 '"repair-queued"' false 0 1
run_start  "$LIFE" 2026-03-02T12:00:00.000Z r5 ci-run claude 42 '"myapp"' '"myapp-epic-42"'
spawn      "$LIFE" 2026-03-02T12:02:00.000Z r5 ci-run claude 42 '"myapp"' ci:fix 1 false 300000 0.50 cli
run_finish "$LIFE" 2026-03-02T12:05:00.000Z r5 ci-run claude 42 '"myapp"' 300000 '"merge-queued"' false 0 2
report "$LIFE"
assert_rc "the report reads a typed log" 0 "$REPORT_RC"
assert_contains "it has an issue-lifetime section" "$REPORT_OUT" 'issue lifetimes (log-known)'
assert_eq "the lifetime is grouped under its repository" 1 "$(group_line 'myapp')"
LIFE_ROW="$(row 42)"
assert_contains "five invocations of one issue are one lifetime" "$LIFE_ROW" 'launches 5'
assert_contains "counted by the script that ran them" "$LIFE_ROW" '(epic-run 2, fix-run 1, ci-run 1, defect-run 1)'
assert_contains "the lifetime starts at the first recorded start" "$LIFE_ROW" 'first 2026-03-01 10:00:00 UTC'
assert_contains "and ends at the latest recorded activity" "$LIFE_ROW" 'latest 2026-03-02 12:05:00 UTC'
assert_contains "wall time is the completed runs' own durations" "$LIFE_ROW" 'wall 1h 10m'
assert_contains "the elapsed span includes the waiting between them" "$LIFE_ROW" 'span 1d 2h'
assert_contains "every spawn of every run is counted once" "$LIFE_ROW" 'spawns 7'
assert_contains "model-active time is summed spawn duration" "$LIFE_ROW" 'model-active 45m'
assert_contains "fresh input tokens are reported apart from cache" "$LIFE_ROW" 'in 7,000'
assert_contains "cache reads are their own figure" "$LIFE_ROW" 'cache-read 3,500'
assert_contains "so are cache writes" "$LIFE_ROW" 'cache-create 700'
assert_contains "and output tokens" "$LIFE_ROW" 'out 1,400'
assert_contains "the vendor's dollars keep their provenance" "$LIFE_ROW" '$2.50 (+$0.20 estimated, 0 unpriced)'
assert_contains "a transient or schema respawn is its own category" "$LIFE_ROW" 'respawns 1'
assert_contains "a bounded in-run retry is another" "$LIFE_ROW" 'retries 2'
assert_contains "a relaunch with a new runId is a third" "$LIFE_ROW" 'relaunches 1'
assert_contains "and a fixer attempt is a fourth" "$LIFE_ROW" 'fixer attempts 3'
assert_contains "the latest completed run decides the reported result" "$LIFE_ROW" 'result merge-queued'
assert_contains "which is not a human handoff" "$LIFE_ROW" 'handoff no'
assert_not_contains "a lifetime with a finish per start is not partial" "$LIFE_ROW" 'incomplete'
assert_contains "the tuning view still groups spawns by script" "$REPORT_OUT" 'epic-run — 2 run(s): claude 2'
assert_contains "the tuning view names its summed time model-active" "$REPORT_OUT" 'model-min/run'
assert_contains "the average run reports model-active minutes" "$REPORT_OUT" 'model-active min'
assert_contains "and says once what that time is not" "$REPORT_OUT" 'summed spawn duration, not wall-clock'
assert_not_contains "lifecycle records never enter the per-step table" "$REPORT_OUT" 'undefined'
LIFE_TOTALS="$(line_with 'all repositories:')"
assert_contains "cross-repository totals include respawns" "$LIFE_TOTALS" 'respawns 1'
assert_contains "cross-repository totals include in-run retries" "$LIFE_TOTALS" 'retries 2'
assert_contains "cross-repository totals include relaunches" "$LIFE_TOTALS" 'relaunches 1'
assert_contains "cross-repository totals include fixer ladder attempts" "$LIFE_TOTALS" 'fixer attempts 3'

# ───────────────────────── repository identity ─────────────────────────
section 'the same issue number in two repositories stays two lifetimes'
TWO="$TMP/two-repos.jsonl"
run_start  "$TWO" 2026-03-03T10:00:00.000Z a1 epic-run claude 42 '"alpha"'
spawn      "$TWO" 2026-03-03T10:01:00.000Z a1 epic-run claude 42 '"alpha"' architect:design 1 false 300000 0.50 cli
run_finish "$TWO" 2026-03-03T10:10:00.000Z a1 epic-run claude 42 '"alpha"' 600000 '"merge-queued"' false 0 null
run_start  "$TWO" 2026-03-03T11:00:00.000Z b1 epic-run claude 42 '"beta"'
spawn      "$TWO" 2026-03-03T11:01:00.000Z b1 epic-run claude 42 '"beta"' architect:design 1 false 300000 0.50 cli
spawn      "$TWO" 2026-03-03T11:05:00.000Z b1 epic-run claude 42 '"beta"' code:green 1 false 300000 0.50 cli
run_finish "$TWO" 2026-03-03T11:20:00.000Z b1 epic-run claude 42 '"beta"' 1200000 '"human-blocked"' true 3 null
report "$TWO"
assert_rc "the report reads two repositories" 0 "$REPORT_RC"
assert_eq "each repository gets its own group" "1 1" "$(group_line 'alpha') $(group_line 'beta')"
ALPHA_ROW="$(printf '%s\n' "$REPORT_OUT" | sed -n '/^alpha$/,/^beta$/p' | grep -A1 -E '^[[:space:]]*#42' | tr '\n' ' ')"
BETA_ROW="$(printf '%s\n' "$REPORT_OUT" | sed -n '/^beta$/,$p' | grep -A1 -E '^[[:space:]]*#42' | tr '\n' ' ')"
assert_contains "alpha's issue keeps its own wall time" "$ALPHA_ROW" 'wall 10m'
assert_contains "and its own result" "$ALPHA_ROW" 'result merge-queued'
assert_contains "beta's identically numbered issue is separate" "$BETA_ROW" 'wall 20m'
assert_contains "with its own result" "$BETA_ROW" 'result human-blocked'
assert_contains "and its own spawn count" "$BETA_ROW" 'spawns 2'
TOTALS="$(line_with 'all repositories:')"
assert_contains "the totals count both lifetimes" "$TOTALS" '2 issue lifetime(s)'
assert_contains "and add their wall time across repositories" "$TOTALS" 'wall 30m'
assert_contains "one of two conclusive lifetimes handed off" "$REPORT_OUT" 'human handoff: 1 of 2 conclusive lifetime(s) (50.0%)'

# ───────────────────────── wall time is not summed spawn time ─────────────────────────
section 'parallel spawns: wall time comes from the lifecycle, not the spawns'
PAR="$TMP/parallel.jsonl"
run_start  "$PAR" 2026-04-01T00:00:00.000Z p1 epic-run claude 7 '"myapp"'
spawn      "$PAR" 2026-04-01T00:00:30.000Z p1 epic-run claude 7 '"myapp"' review:general 1 false 600000 0.50 cli
spawn      "$PAR" 2026-04-01T00:00:30.000Z p1 epic-run claude 7 '"myapp"' review:focus 1 false 600000 0.50 cli
run_finish "$PAR" 2026-04-01T00:12:00.000Z p1 epic-run claude 7 '"myapp"' 720000 '"merge-queued"' false 0 null
report "$PAR"
PAR_ROW="$(row 7)"
assert_contains "two ten-minute spawns inside a twelve-minute run cost twelve minutes" "$PAR_ROW" 'wall 12m'
assert_contains "while the model was active for twenty" "$PAR_ROW" 'model-active 20m'

# ───────────────────────── the outcome vocabulary ─────────────────────────
# One lifetime per recorded result. Only merge-queued, human-review and
# human-blocked are conclusive; everything else is named and set aside rather
# than folded into a rate that would then mean nothing.
section 'every recorded result, and the handoff rate over the conclusive ones'
OUT="$TMP/outcomes.jsonl"
add_outcome() { # issue hh:mm outcome handoff exit
  run_start  "$OUT" "2026-04-02T$2:00.000Z" "o$1" epic-run claude "$1" '"myapp"'
  run_finish "$OUT" "2026-04-02T$2:30.000Z" "o$1" epic-run claude "$1" '"myapp"' 1800000 "$3" "$4" "$5" null
}
add_outcome 1  01:00 '"merge-queued"'  false 0
add_outcome 2  02:00 '"repair-queued"' false 0
add_outcome 3  03:00 '"quota-held"'    false 0
add_outcome 4  04:00 '"human-review"'  true  0
add_outcome 5  05:00 '"human-blocked"' true  3
add_outcome 6  06:00 '"skipped"'       false 2
add_outcome 7  07:00 '"error"'         false 1
add_outcome 8  08:00 '"manual"'        false 0
run_start "$OUT" 2026-04-02T09:00:00.000Z o9 epic-run claude 9 '"myapp"'
add_outcome 10 10:00 'null'            false 0
add_outcome 11 11:00 '"merge-queued"'  false 0
report "$OUT"
assert_rc "a log of lifecycle records alone still reports" 0 "$REPORT_RC"
assert_contains "a queued-for-merge run is not a handoff" "$(row 1)" 'result merge-queued'
assert_contains "and says so" "$(row 1)" 'handoff no'
assert_contains "an unspent repair queue is automation-owned" "$(row 2)" 'result repair-queued'
assert_contains "not a human handoff" "$(row 2)" 'handoff no'
assert_contains "a provider quota hold is automatic waiting" "$(row 3)" 'result quota-held'
assert_contains "not a human handoff either" "$(row 3)" 'handoff no'
assert_contains "an explicit human-review landing is a handoff" "$(row 4)" 'result human-review'
assert_contains "and is reported as one" "$(row 4)" 'handoff yes'
assert_contains "a plain terminal failure is a handoff" "$(row 5)" 'result human-blocked'
assert_contains "and is reported as one" "$(row 5)" 'handoff yes'
assert_contains "a refusal is neither" "$(row 6)" 'result skipped'
assert_contains "nor is a crash" "$(row 7)" 'result error'
assert_contains "nor a manual slug-mode summary" "$(row 8)" 'result manual'
assert_contains "a start with no finish stays visibly incomplete" "$(row 9)" 'result incomplete'
assert_contains "its unfinished launch is counted" "$(row 9)" 'incomplete 1'
assert_contains "and its elapsed span is not invented" "$(row 9)" 'span -'
assert_contains "a finish with no recorded result is unknown, never guessed" "$(row 10)" 'result unknown'
assert_contains "the handoff rate counts conclusive lifetimes only" "$REPORT_OUT" 'human handoff: 2 of 4 conclusive lifetime(s) (50.0%)'
assert_contains "and lists what it left out of the denominator" "$REPORT_OUT" 'not counted: repair-queued 1, quota-held 1, skipped 1, error 1, manual 1, incomplete 1, unknown 1'
assert_eq "rows are ordered by latest activity, most recent first" "11 10 9 8 7 6 5 4 3 2 1" "$(row_order)"

# ───────────────────────── the fixer ladder ─────────────────────────
section 'a first fixer failure is automation-owned; an exhausted ladder is not'
LADDER="$TMP/ladder.jsonl"
run_start  "$LADDER" 2026-04-03T10:00:00.000Z l1 fix-run claude 50 '"myapp"'
run_finish "$LADDER" 2026-04-03T10:05:00.000Z l1 fix-run claude 50 '"myapp"' 300000 '"repair-queued"' false 3 1
run_start  "$LADDER" 2026-04-03T11:00:00.000Z l2 ci-run claude 51 '"myapp"'
run_finish "$LADDER" 2026-04-03T11:05:00.000Z l2 ci-run claude 51 '"myapp"' 300000 '"repair-queued"' false 3 1
run_start  "$LADDER" 2026-04-03T12:00:00.000Z l3 ci-run claude 51 '"myapp"'
run_finish "$LADDER" 2026-04-03T12:05:00.000Z l3 ci-run claude 51 '"myapp"' 300000 '"human-blocked"' true 3 2
report "$LADDER"
assert_contains "an attempt-one fixer blocker still belongs to the pipeline" "$(row 50)" 'result repair-queued'
assert_contains "so it is not a handoff" "$(row 50)" 'handoff no'
assert_contains "the spent ladder's latest result decides the lifetime" "$(row 51)" 'result human-blocked'
assert_contains "an exhausted ladder is a human handoff" "$(row 51)" 'handoff yes'
assert_contains "both fixer attempts are counted" "$(row 51)" 'fixer attempts 2'
assert_contains "only the conclusive lifetime is rated" "$REPORT_OUT" 'human handoff: 1 of 1 conclusive lifetime(s) (100.0%)'
assert_contains "the automation-owned one is named, not silently dropped" "$REPORT_OUT" 'not counted: repair-queued 1,'

# ───────────────────────── runs with nothing to spend ─────────────────────────
section 'a completed run that spawned nothing, and a run that never finished'
ZERO="$TMP/zero.jsonl"
run_start  "$ZERO" 2026-04-04T10:00:00.000Z z1 epic-run claude 60 '"myapp"'
run_finish "$ZERO" 2026-04-04T10:00:20.000Z z1 epic-run claude 60 '"myapp"' 20000 '"skipped"' false 2 null
run_start  "$ZERO" 2026-04-04T11:00:00.000Z z2 epic-run claude 61 '"myapp"'
report "$ZERO"
assert_rc "a log with no spawn at all still reports" 0 "$REPORT_RC"
ZERO_ROW="$(row 60)"
assert_contains "a refusal that woke no model is still a recorded launch" "$ZERO_ROW" 'launches 1'
assert_contains "with no spawns" "$ZERO_ROW" 'spawns 0'
assert_contains "no model-active time" "$ZERO_ROW" 'model-active 0m'
assert_contains "no cost" "$ZERO_ROW" '$0.00 (+$0.00 estimated, 0 unpriced)'
assert_contains "a sub-minute run is not rounded away to nothing" "$ZERO_ROW" 'wall <1m'
assert_contains "and it carries its result" "$ZERO_ROW" 'result skipped'
KILLED_ROW="$(row 61)"
assert_contains "a killed run leaves exactly one visible incomplete launch" "$KILLED_ROW" 'incomplete 1'
assert_contains "whose result is not invented" "$KILLED_ROW" 'result incomplete'
assert_contains "the cross-repository summary exposes partial retained history" "$REPORT_OUT" 'partial history 1 lifetime(s)'

# Starts and finishes pair by runId, not by lifetime-wide counts. A finish-only
# retained run must not cancel an unrelated invocation that never finished.
PAIRS="$TMP/pairs.jsonl"
run_start "$PAIRS" 2026-04-04T12:00:00.000Z pair-a epic-run claude 62 '"myapp"'
run_finish "$PAIRS" 2026-04-04T12:10:00.000Z pair-b epic-run claude 62 '"myapp"' 300000 '"merge-queued"' false 0 null
report "$PAIRS"
PAIRS_ROW="$(row 62)"
assert_contains "an unmatched start remains incomplete despite another finish" "$PAIRS_ROW" 'incomplete 1'
assert_contains "the unmatched finish is disclosed as partial history too" "$PAIRS_ROW" 'finish-without-start 1'
assert_contains "the row makes the retained-history gap explicit" "$PAIRS_ROW" 'partial history'

# A syntactically valid but incomplete finish must not quietly contribute a
# zero wall duration, and its redundant handoff flag must agree with the
# normalized outcome. The outcome remains authoritative; the damage is named.
DAMAGED_FINISH="$TMP/damaged-finish.jsonl"
run_start "$DAMAGED_FINISH" 2026-04-04T13:00:00.000Z damaged-finish epic-run claude 63 '"myapp"'
printf '{"type":"run-finish","ts":"2026-04-04T13:10:00.000Z","runId":"damaged-finish","script":"epic-run","engine":"claude","issue":63,"repo":"myapp","outcome":"human-review","handoff":false}\n' >> "$DAMAGED_FINISH"
report "$DAMAGED_FINISH"
DAMAGED_ROW="$(row 63)"
assert_contains "a finish without wall duration is partial" "$DAMAGED_ROW" 'wall-missing 1'
assert_contains "a contradictory handoff field is disclosed" "$DAMAGED_ROW" 'handoff-field-mismatch'
assert_contains "the normalized outcome remains the handoff authority" "$DAMAGED_ROW" 'handoff yes'

# ───────────────────────── legacy, unattributed and damaged records ─────────────────────────
section 'legacy rows, missing identity, missing usage and a torn final line'
MIXED="$TMP/mixed.jsonl"
legacy_spawn "$MIXED" 2026-05-01T08:00:00.000Z legacy-r1 epic-run claude 7 architect:design 300000 0.25
# Missing runIds carry no pairing evidence. Even identical-looking legacy rows
# stay separate rather than being combined under one accidental `undefined` key.
printf '{"ts":"2026-05-01T08:10:00.000Z","script":"epic-run","issue":10,"engine":"claude","step":"code","label":"code:green","attempt":1,"vendor":"claude","model":"opus","effort":"high","ok":true,"timedOut":false,"ms":1000,"tokens":%s,"costUsd":0.01,"costSource":"cli"}\n' "$TOKENS" >> "$MIXED"
printf '{"ts":"2026-05-01T08:11:00.000Z","script":"epic-run","issue":10,"engine":"claude","step":"code","label":"code:green","attempt":1,"vendor":"claude","model":"opus","effort":"high","ok":true,"timedOut":false,"ms":1000,"tokens":%s,"costUsd":0.01,"costSource":"cli"}\n' "$TOKENS" >> "$MIXED"
spawn        "$MIXED" 2026-05-01T08:30:00.000Z norepo-r2 epic-run claude 8 null code:green 1 false 300000 0.50 cli
run_start    "$MIXED" 2026-05-01T08:40:00.000Z manual-r3 epic-run claude null '"myapp"'
run_finish   "$MIXED" 2026-05-01T08:45:00.000Z manual-r3 epic-run claude null '"myapp"' 300000 '"manual"' false 0 null
printf '{"type":"spawn","ts":"2026-05-01T08:50:00.000Z"\n' >> "$MIXED"
printf '{"type":"telemetry-v2","ts":"2026-05-01T08:55:00.000Z"}\n' >> "$MIXED"
run_start    "$MIXED" 2026-05-01T09:00:00.000Z mixed-r4 epic-run claude 9 '"myapp"'
spawn        "$MIXED" 2026-05-01T09:01:00.000Z mixed-r4 epic-run claude 9 '"myapp"' review:general 1 false 300000 0 nousage
spawn        "$MIXED" 2026-05-01T09:05:00.000Z mixed-r4 epic-run claude 9 '"myapp"' code:green 1 false 300000 0 unpriced
run_finish   "$MIXED" 2026-05-01T09:10:00.000Z mixed-r4 epic-run claude 9 '"myapp"' 600000 '"merge-queued"' false 0 null
printf '{"type":"run-finish","ts":"2026-05-01T09:11:00.000Z"' >> "$MIXED"
report "$MIXED"
assert_rc "a damaged log is still a readable report" 0 "$REPORT_RC"
MIXED_ROW="$(row 9)"
assert_contains "a typed run with both identities is a lifetime" "$MIXED_ROW" 'result merge-queued'
assert_contains "spawns with no usage still count as spawns" "$MIXED_ROW" 'spawns 2'
assert_contains "an unpriced model is named as missing money, not as free" "$MIXED_ROW" '$0.00 (+$0.00 estimated, 1 unpriced)'
assert_eq "a legacy row's issue number never joins a repository lifetime" "absent" "$(has_row 7 && echo present || echo absent)"
assert_eq "nor does a typed run with no repository" "absent" "$(has_row 8 && echo present || echo absent)"
assert_contains "unattributable runs get their own trailing group" "$REPORT_OUT" 'runs without repository/issue identity (never joined to an issue lifetime)'
assert_contains "the legacy run is listed by its runId" "$REPORT_OUT" 'legacy-r1'
assert_eq "legacy rows without runIds are never coalesced accidentally" 2 \
  "$(printf '%s\n' "$REPORT_OUT" | grep -c 'issue 10 · repo unknown')"
assert_contains "so is the run with no repository" "$REPORT_OUT" 'norepo-r2'
assert_contains "and the issueless manual run" "$REPORT_OUT" 'manual-r3'
assert_contains "legacy history discloses exactly what it cannot say" "$REPORT_OUT" 'wall time, repository and result unknown'
assert_contains "an interior record that did not parse is reported, not hidden" "$REPORT_OUT" 'malformed records skipped: 2'
assert_contains "legacy tokens and dollars still reach the tuning view" "$REPORT_OUT" 'epic-run —'
assert_contains "a spawn the CLI reported no usage for is disclosed" "$REPORT_OUT" 'spawns with no token usage reported (counted as 0)'
assert_contains "and a model with no price row is named" "$REPORT_OUT" '1 spawn(s) on gpt-5.6-nopricerow have tokens but no price row'
assert_contains "the lifetime summary exposes missing usage too" "$(line_with 'all repositories:')" 'missing usage 1 spawn(s)'

# ───────────────────────── --since selects lifetimes, not records ─────────────────────────
section '--since selects a lifetime by its latest activity, then totals all of it'
SINCE="$TMP/since.jsonl"
NOW="$(date -u +%s)"
old_ts() { epoch_iso $(( NOW - 40 * 86400 + ${1:-0} )); }   # 40 days ago, plus N seconds
new_ts() { epoch_iso $(( NOW - 3600 + ${1:-0} )); }         # 1 hour ago, plus N seconds
run_start  "$SINCE" "$(old_ts)"             s1 epic-run claude 70 '"myapp"'
spawn      "$SINCE" "$(old_ts 60)"           s1 epic-run claude 70 '"myapp"' architect:design 1 false 300000 0.50 cli
run_finish "$SINCE" "$(old_ts 1800)"         s1 epic-run claude 70 '"myapp"' 1800000 '"human-review"' true 0 null
run_start  "$SINCE" "$(new_ts)"             s2 fix-run claude 70 '"myapp"'
spawn      "$SINCE" "$(new_ts 60)"           s2 fix-run claude 70 '"myapp"' fix:resolve 1 false 300000 0.50 cli
run_finish "$SINCE" "$(new_ts 600)"          s2 fix-run claude 70 '"myapp"' 600000 '"merge-queued"' false 0 1
run_start  "$SINCE" "$(old_ts 7200)"         s3 epic-run claude 71 '"myapp"'
run_finish "$SINCE" "$(old_ts 10800)"        s3 epic-run claude 71 '"myapp"' 1800000 '"merge-queued"' false 0 null
report "$SINCE" --since 7d
assert_rc "a windowed report succeeds" 0 "$REPORT_RC"
SINCE_ROW="$(row 70)"
assert_contains "a recent fixer selects the whole retained lifetime" "$SINCE_ROW" 'launches 2'
assert_contains "including the epic that started outside the window" "$SINCE_ROW" 'wall 40m'
assert_contains "and its spawns" "$SINCE_ROW" 'spawns 2'
assert_eq "a lifetime with no recent activity is not selected" "absent" "$(has_row 71 && echo present || echo absent)"
assert_contains "the tuning view keeps filtering record by record" "$REPORT_OUT" 'fix-run — 1 run(s): claude 1'
assert_not_contains "so the out-of-window epic spawn is not tuned on" "$REPORT_OUT" 'epic-run — '

# The lifetime window is specifically based on lifecycle activity, not on the
# timestamp of a spawn row. The per-step view still sees that recent spawn.
LIFECYCLE_WINDOW="$TMP/lifecycle-window.jsonl"
run_start "$LIFECYCLE_WINDOW" "$(old_ts)" lw1 epic-run claude 72 '"myapp"'
spawn "$LIFECYCLE_WINDOW" "$(new_ts)" lw1 epic-run claude 72 '"myapp"' architect:design 1 false 300000 0.50 cli
report "$LIFECYCLE_WINDOW" --since 7d
assert_eq "recent spawn activity alone does not select an old issue lifetime" "absent" \
  "$(has_row 72 && echo present || echo absent)"
assert_contains "the same spawn remains in the record-filtered tuning view" "$REPORT_OUT" 'epic-run — 1 run(s): claude 1'

# ───────────────────────── engine and script filters ─────────────────────────
section '--engine and --script keep a lifetime by its latest completed run'
FILTER="$TMP/filters.jsonl"
run_start  "$FILTER" 2026-06-01T10:00:00.000Z f1 epic-run claude 80 '"myapp"'
spawn      "$FILTER" 2026-06-01T10:01:00.000Z f1 epic-run claude 80 '"myapp"' architect:design 1 false 300000 0.50 cli
run_finish "$FILTER" 2026-06-01T10:10:00.000Z f1 epic-run claude 80 '"myapp"' 600000 '"repair-queued"' false 0 null
run_start  "$FILTER" 2026-06-01T11:00:00.000Z f2 fix-run codex 80 '"myapp"'
spawn      "$FILTER" 2026-06-01T11:01:00.000Z f2 fix-run codex 80 '"myapp"' fix:resolve 1 false 300000 0.10 table
run_finish "$FILTER" 2026-06-01T11:10:00.000Z f2 fix-run codex 80 '"myapp"' 600000 '"merge-queued"' false 0 1
run_start  "$FILTER" 2026-06-01T12:00:00.000Z f3 epic-run claude 81 '"myapp"'
spawn      "$FILTER" 2026-06-01T12:01:00.000Z f3 epic-run claude 81 '"myapp"' architect:design 1 false 300000 0.50 cli
run_finish "$FILTER" 2026-06-01T12:10:00.000Z f3 epic-run claude 81 '"myapp"' 600000 '"merge-queued"' false 0 null
report "$FILTER" --engine codex
assert_rc "an engine filter succeeds" 0 "$REPORT_RC"
assert_contains "a lifetime whose latest run was on Codex is kept whole" "$(row 80)" 'launches 2'
assert_contains "with the totals of every engine it ever used" "$(row 80)" 'spawns 2'
assert_eq "a lifetime that never finished on Codex is dropped" "absent" "$(has_row 81 && echo present || echo absent)"
assert_contains "while the tuning view still filters records" "$REPORT_OUT" 'fix-run — 1 run(s): codex 1'
assert_not_contains "and shows no Claude step rows" "$REPORT_OUT" 'epic-run — '
report "$FILTER" --script fix-run
assert_rc "a script filter succeeds" 0 "$REPORT_RC"
assert_contains "a lifetime whose latest run was the conflict fixer is kept whole" "$(row 80)" 'launches 2'
assert_eq "a lifetime whose latest run was the epic is dropped" "absent" "$(has_row 81 && echo present || echo absent)"

# ───────────────────────── the command line ─────────────────────────
section 'the command line an operator already types keeps working'
report "$TMP/no-such-log.jsonl"
assert_rc "an unreadable log exits 1" 1 "$REPORT_RC"
assert_contains "and says which file" "$REPORT_OUT" 'usage-report: cannot read'
: > "$TMP/empty.jsonl"
report "$TMP/empty.jsonl"
assert_rc "an empty log is not an error" 0 "$REPORT_RC"
assert_contains "it just says there is nothing" "$REPORT_OUT" 'no usage records in'
NEWLINE_BAD="$TMP/newline-bad.jsonl"
printf '{"type":"run-start"\n' > "$NEWLINE_BAD"
report "$NEWLINE_BAD"
assert_rc "a newline-terminated malformed final record is still reportable" 0 "$REPORT_RC"
assert_contains "only an unterminated final fragment is silently ignored" "$REPORT_OUT" 'malformed records skipped: 1'

# A populated log filtered down to nothing is still an answer. Printing nothing
# at the end of `./toliki usage 7` on a quiet week is indistinguishable
# from a broken ssh or a crashed node, so every filter that selects nothing says
# so and names itself.
QUIET="$TMP/quiet.jsonl"
run_start  "$QUIET" "$(old_ts)"          q1 epic-run claude 90 '"myapp"'
spawn      "$QUIET" "$(old_ts 60)"       q1 epic-run claude 90 '"myapp"' architect:design 1 false 300000 0.50 cli
run_finish "$QUIET" "$(old_ts 1800)"     q1 epic-run claude 90 '"myapp"' 1800000 '"merge-queued"' false 0 null
report "$QUIET" --since 1d
assert_rc "a window that selects nothing is not an error" 0 "$REPORT_RC"
assert_contains "a quiet week says so rather than printing nothing" "$REPORT_OUT" 'no usage records in'
assert_contains "and names the window it was given" "$REPORT_OUT" 'since 1d'
report "$LIFE" --engine no-such-engine
assert_rc "an engine matching nothing is not an error" 0 "$REPORT_RC"
assert_contains "an engine that never ran is named, not left blank" "$REPORT_OUT" 'for engine no-such-engine'
report "$LIFE" --script no-such-script
assert_rc "a script matching nothing is not an error" 0 "$REPORT_RC"
assert_contains "so is a script that never ran" "$REPORT_OUT" 'for script no-such-script'

# The fixture clock is the suite's own dependency: it must hold on the laptop's
# BSD date as well as the host's GNU one.
assert_eq "an epoch renders as a canonical UTC instant" "2026-05-01T09:10:00.000Z" "$(epoch_iso 1777626600)"
assert_eq "and that instant reads back as its epoch" "1777626600" "$(iso_epoch 2026-05-01T09:10:00.000Z)"
assert_eq "no fixture depends on GNU date alone" "" \
  "$(grep -n 'date -u -d' "${BASH_SOURCE[0]}" | grep -v '|| date -u -d' || true)"
HELP="$(HOST_TIMEZONE=UTC TZ=UTC node "$ROOT/workflows/usage-report.mjs" --help 2>&1)"
assert_contains "the help names every pipeline the log now holds" "$HELP" '--script epic-run|task-run|fix-run|ci-run|defect-run'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
