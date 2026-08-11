#!/usr/bin/env bash
#
# Resource sampler — one JSONL line per tick to ~/resource.log. Read it back with
# bin/resource-report.sh.
#
# Runs ON the host from cron, beside the dispatcher/reaper/merge tick. It reads
# /proc, ps and docker; it starts nothing, kills nothing, and touches no pipeline
# state, which is what makes it safe to leave running on a live box.
#
# WHY THIS EXISTS: MAX_PARALLEL_EPICS is the one number that decides how hard the
# host gets pushed, and it can only be raised honestly by watching a full drain.
# A snapshot taken by hand answers "is it busy right now", which is the wrong
# question — the interesting failures are conditional. They surface when the
# real-DB tier boots a Supabase stack under an already-loaded box, or when
# several epics hit their review fan-out at the same moment. Both are minutes
# long and neither announces itself, so they have to be caught by something that
# is always sampling.
#
# COUNTERS, NOT AVERAGES — the reason one sample a minute is enough. PSI exposes
# a cumulative `total=` in microseconds of stall, and /proc/stat exposes
# cumulative jiffies; the delta between two consecutive samples is therefore the
# EXACT stall and the EXACT utilization for that window, no matter how coarsely
# it is sampled. A 20-second burst between two ticks is fully accounted for, it
# just cannot be told apart from a 20-second burst somewhere else in the same
# minute. That is why this file records raw counters and leaves every rate to the
# report: sampling `avg10` instead would alias, and would miss precisely the
# short spikes worth catching. Only genuinely instantaneous values (load, RSS,
# container count) are point samples, and they are labelled as such.
#
# Phase detection is deliberately zero-touch — inferred here from process names
# rather than emitted by the projects themselves. The alternative (each repo's
# test-db.sh logging its own begin/end) is more precise and could time lock
# waits, but it puts harness-shaped logging inside project repos to buy
# resolution this does not need. The cost is accepted and named: a tier shorter
# than the sample gap can slip through unseen, and lock-wait time is invisible.
set -uo pipefail

LOG="${RESOURCE_LOG:-$HOME/resource.log}"
PAGE_KB=$(( $(getconf PAGESIZE 2>/dev/null || echo 4096) / 1024 ))

# --- /proc readers -----------------------------------------------------------
# Each defaults rather than fails: a sampler that aborts on one unreadable field
# turns a missing metric into a missing MINUTE, and the gap is indistinguishable
# from a box that was down.

psi_total() { # $1=cpu|memory|io  $2=some|full
  awk -v k="$2" '$1==k { for (i=2;i<=NF;i++) if ($i ~ /^total=/) { sub(/^total=/,"",$i); print $i; exit } }' \
    "/proc/pressure/$1" 2>/dev/null || true
}

meminfo() { awk -v k="$1:" '$1==k {print $2; exit}' /proc/meminfo 2>/dev/null || true; }

# utime+stime for a pid, in jiffies. The comm field can contain spaces AND
# parentheses, so everything up to the LAST ')' is discarded before counting
# fields — the standard way to parse /proc/pid/stat without tripping on a
# process named "(evil) (".
pid_cpu_jiffies() {
  awk '{ s=$0; sub(/^.*\) /,"",s); n=split(s,f," "); print f[12]+f[13] }' \
    "/proc/$1/stat" 2>/dev/null || true
}
pid_rss_kb() {
  awk -v p="$PAGE_KB" '{print $2*p}' "/proc/$1/statm" 2>/dev/null || true
}

n() { [[ "${1:-}" =~ ^[0-9]+$ ]] && echo "$1" || echo 0; }  # numeric or 0

# --- sample ------------------------------------------------------------------
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

read -r LOAD1 LOAD5 LOAD15 PROCS _ < /proc/loadavg
RUNNABLE="${PROCS%%/*}"

read -r _ CU CN CS CI CIO CIRQ CSIRQ CSTEAL _ < /proc/stat

# Epic sessions, and the CPU each has burned. Derived from the claude command
# line rather than from tmux because --remote-control <name> carries the session
# name AND gives us the pid in the same pass; it also matches what the cap
# actually counts (a pane sitting at a dead shell holds a tmux name but no
# process, and costs nothing). Cumulative jiffies again, so the report can
# attribute a spike to the epic that caused it.
EPICS_JSON="$(
  ps -eo pid=,args= 2>/dev/null |
  awk '{ for (i=1;i<=NF;i++) if ($i=="--remote-control") { print $1, $(i+1); break } }' |
  while read -r pid sess; do
    printf '{"session":"%s","pid":%s,"cpu_jiffies":%s,"rss_kb":%s}\n' \
      "$sess" "$pid" "$(n "$(pid_cpu_jiffies "$pid")")" "$(n "$(pid_rss_kb "$pid")")"
  done | jq -sc '.' 2>/dev/null || echo '[]'
)"
EPIC_COUNT="$(echo "$EPICS_JSON" | jq 'length' 2>/dev/null || echo 0)"

# Phase markers. `pgrep` never matches its own process, so these patterns are
# safe to write inline. Counting matched processes rather than just testing
# presence: two concurrent verifies are a different load story from one.
# pgrep -c prints its count AND exits non-zero when that count is zero, so the
# usual `|| echo 0` fallback would append a second line and corrupt the JSON.
count_matching() { local c; c="$(pgrep -fc "$1" 2>/dev/null || true)"; n "${c%%$'\n'*}"; }
SUPABASE_CLI=$(count_matching '(^|/)supabase (start|stop|status|db )')
DB_RESET=$(count_matching 'supabase db reset')
INTEGRATION=$(count_matching 'vitest.*integration')
BUILDS=$(count_matching '(vite build|tsc( |$)|vitest run|biome ci|esbuild)')

# Docker is a point sample and the one call here that can hang (daemon busy), so
# it is bounded — a sampler that blocks would leave exactly the gap described
# above, and during a heavy tier is when it would happen.
DOCKER_N=$(timeout 5 docker ps -q 2>/dev/null | wc -l | tr -d ' ' || echo 0)
STACKS=$(timeout 5 docker ps --format '{{.Names}}' 2>/dev/null |
         sed -n 's/^supabase_db_//p' | sort -u | jq -Rsc 'split("\n")-[""]' 2>/dev/null || echo '[]')

DISK_PCT=$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)

jq -nc \
  --arg   ts "$TS" \
  --argjson load "[$LOAD1,$LOAD5,$LOAD15]" \
  --argjson runnable "$(n "$RUNNABLE")" \
  --argjson cpu "{\"user\":$(n "$CU"),\"nice\":$(n "$CN"),\"system\":$(n "$CS"),\"idle\":$(n "$CI"),\"iowait\":$(n "$CIO"),\"irq\":$(n "$CIRQ"),\"softirq\":$(n "$CSIRQ"),\"steal\":$(n "$CSTEAL")}" \
  --argjson psi "{\"cpu_some\":$(n "$(psi_total cpu some)"),\"cpu_full\":$(n "$(psi_total cpu full)"),\"mem_some\":$(n "$(psi_total memory some)"),\"mem_full\":$(n "$(psi_total memory full)"),\"io_some\":$(n "$(psi_total io some)"),\"io_full\":$(n "$(psi_total io full)")}" \
  --argjson mem "{\"total_kb\":$(n "$(meminfo MemTotal)"),\"available_kb\":$(n "$(meminfo MemAvailable)"),\"cached_kb\":$(n "$(meminfo Cached)"),\"swap_total_kb\":$(n "$(meminfo SwapTotal)"),\"swap_free_kb\":$(n "$(meminfo SwapFree)")}" \
  --argjson epics "${EPICS_JSON:-[]}" \
  --argjson epic_count "$(n "$EPIC_COUNT")" \
  --argjson phase "{\"supabase_cli\":$(n "$SUPABASE_CLI"),\"db_reset\":$(n "$DB_RESET"),\"integration\":$(n "$INTEGRATION"),\"builds\":$(n "$BUILDS")}" \
  --argjson docker "{\"containers\":$(n "$DOCKER_N"),\"stacks\":$STACKS}" \
  --argjson disk_pct "$(n "$DISK_PCT")" \
  '{ts:$ts,load:$load,runnable:$runnable,cpu:$cpu,psi:$psi,mem:$mem,
    epics:$epics,epic_count:$epic_count,phase:$phase,docker:$docker,disk_pct:$disk_pct}' \
  >> "$LOG"
