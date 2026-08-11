#!/usr/bin/env bash
#
# Read back what bin/resource-log.sh sampled: bin/resource-report.sh [hours]
# (default 24). Read-only — it opens the log and nothing else, so it is always
# safe to run against a live host.
#
# Every rate here is computed from the DELTA between consecutive samples, never
# from a field in one sample. That is the whole point of the sampler recording
# cumulative counters: "CPU stall over the last 24h" is an exact figure derived
# from two readings 24h apart, not an average of 1440 guesses. See the header of
# resource-log.sh for why that makes one sample a minute sufficient.
#
# Two things invalidate a pair, and both are dropped rather than smoothed over:
# a gap longer than GAP_MAX_S (cron missed, box down — the counters are still
# correct but the window can no longer be attributed to a minute), and a
# negative delta (the box rebooted and the counters restarted at zero). Dropped
# time is reported rather than silently excluded, because a report that quietly
# summarizes 3 of 24 hours reads exactly like a quiet 24 hours.
set -euo pipefail

HOURS="${1:-24}"
LOG="${RESOURCE_LOG:-$HOME/resource.log}"
GAP_MAX_S="${GAP_MAX_S:-300}"

[[ "$HOURS" =~ ^[0-9]+$ ]] || { echo "usage: $(basename "$0") [hours]   (default 24)" >&2; exit 1; }
if [[ ! -s "$LOG" ]]; then
  echo "no samples yet at $LOG" >&2
  echo "  the sampler line in etc/dispatch.cron may not be installed — see that file's header." >&2
  exit 1
fi

jq -rs --argjson hours "$HOURS" --argjson gapmax "$GAP_MAX_S" '
  def hms: if . == null then "-" else (round) as $s
    | if $s >= 3600 then "\($s/3600|floor)h\(($s%3600)/60|floor)m"
      elif $s >= 60 then "\($s/60|floor)m\($s%60)s" else "\($s)s" end end;
  def gb: if . == null then "-" else "\(. / 1048576 * 10 | round / 10) GB" end;
  def pct: if . == null then "-" else "\(. * 1000 | round / 10)%" end;
  def pad($n): (tostring | . + (" " * ($n - length)))[:$n];

  map(select(.ts) | . + {t: (.ts | fromdateiso8601)}) | sort_by(.t)      as $all
  | (($all[-1].t // 0) - ($hours * 3600))                                 as $cut
  | ($all | map(select(.t >= $cut)))                                      as $s
  | if ($s | length) < 2 then "not enough samples in the last \($hours)h (\($s|length) found)" else

  # Consecutive pairs, each carrying the deltas for its own window.
  ([range(1; $s|length)] | map(
      { p: $s[.-1], c: $s[.] }
      | .dt = (.c.t - .p.t)
      | .cpu_busy = ((.c.cpu.user + .c.cpu.nice + .c.cpu.system + .c.cpu.irq + .c.cpu.softirq + .c.cpu.steal)
                   - (.p.cpu.user + .p.cpu.nice + .p.cpu.system + .p.cpu.irq + .p.cpu.softirq + .p.cpu.steal))
      | .cpu_all  = (.cpu_busy + (.c.cpu.idle - .p.cpu.idle) + (.c.cpu.iowait - .p.cpu.iowait))
      | .st_cpu   = ((.c.psi.cpu_some - .p.psi.cpu_some) / 1000000)
      | .st_cpuf  = ((.c.psi.cpu_full - .p.psi.cpu_full) / 1000000)
      | .st_mem   = ((.c.psi.mem_some - .p.psi.mem_some) / 1000000)
      | .st_io    = ((.c.psi.io_some  - .p.psi.io_some)  / 1000000)
      | .ok = (.dt > 0 and .dt <= $gapmax and .cpu_all > 0
               and .st_cpu >= 0 and .st_mem >= 0 and .st_io >= 0)
      | .util = (if .cpu_all > 0 then .cpu_busy / .cpu_all else 0 end)
      | .dbtier = ((.c.phase.db_reset + .c.phase.integration + .c.phase.supabase_cli) > 0)
    ))                                                                     as $w
  | ($w | map(select(.ok)))                                                as $v
  | ($v | map(.dt) | add // 0)                                             as $span
  | ($w | map(select(.ok | not) | .dt) | add // 0)                         as $lost
  | ($v | map(select(.dbtier)))                                            as $db
  | ($v | map(select(.dbtier and .c.epic_count >= 2)))                     as $dbrace
  |
  [ "window     last \($hours)h — \($s|length) samples, \($span|hms) accounted"
    + (if $lost > 0 then ", \($lost|hms) dropped (gap/reboot)" else "" end),
    "           \($s[0].ts) → \($s[-1].ts)",
    "",
    "CPU        utilization   avg \(($v|map(.util*.dt)|add) / (if $span>0 then $span else 1 end)|pct)   busiest minute \($v|map(.util)|max|pct)",
    "           stall some    \($v|map(.st_cpu)|add|hms) total   worst minute \($v|map(.st_cpu)|max|round)s",
    "           stall full    \($v|map(.st_cpuf)|add|hms) total"
    + (if ($v|map(.st_cpuf)|add) > 0 then "   ← tasks fully blocked; the box was oversubscribed" else "   (never fully blocked)" end),
    "",
    "MEMORY     available     min \($s|map(.mem.available_kb)|min|gb)   avg \(($s|map(.mem.available_kb)|add)/($s|length)|gb)",
    "           stall some    \($v|map(.st_mem)|add|hms)",
    "           swap used     \($s|map(.mem.swap_total_kb - .mem.swap_free_kb)|max|gb)",
    "",
    "IO         stall some    \($v|map(.st_io)|add|hms)",
    "DISK       peak used     \($s|map(.disk_pct)|max)%",
    "",
    "CONCURRENCY  time spent with N epics running:"
  ]
  # STABLE windows only. The deltas in a pair cover [prev, cur], so a window in
  # which an epic started or finished describes neither concurrency level —
  # charging it to the count at either end understates one and overstates the
  # other. With epics running tens of minutes those windows are a couple per run,
  # but this is the table MAX_PARALLEL_EPICS gets raised on, so it reports only
  # windows where the count held still, and accounts for the rest separately.
  # (No apostrophes in this jq program: it is single-quoted in the shell.)
  + ( $v | map(select(.p.epic_count == .c.epic_count))
        | group_by(.c.epic_count) | sort_by(.[0].c.epic_count)
        | map("             \(.[0].c.epic_count) epic(s)   \(map(.dt)|add|hms|pad(8))"
              + "   avg util \((map(.util*.dt)|add)/(map(.dt)|add)|pct|pad(6))"
              + "   busiest \(map(.util)|max|pct|pad(6))"
              + "   stall \(map(.st_cpu)|add|hms)") )
  + ( $v | map(select(.p.epic_count != .c.epic_count)) | if length > 0 then
        ["             (\(map(.dt)|add|hms) in windows where the count changed — not attributed)"]
      else [] end )
  + [ "",
      "DB TIER    active        \($db|map(.dt)|add // 0|hms) over \(
         [range(0; $v|length)] | map(select($v[.].dbtier and (. == 0 or ($v[.-1].dbtier | not)))) | length
      ) run(s)",
      "           avg util      \(if ($db|length) > 0 then (($db|map(.util*.dt)|add)/($db|map(.dt)|add)|pct) else "-" end)"
      + "   stall \($db|map(.st_cpu)|add // 0|hms)",
      "           overlapped    \($dbrace|map(.dt)|add // 0|hms) with 2+ epics running"
      + (if ($dbrace|length) > 0 then "   ← the window the DB lock covers" else "" end)
    ]
  + ( [ ($v | map(select(.st_cpuf > 1)) | if length > 0 then
          "!  \(length) minute(s) with FULL cpu stall — every task blocked, box oversubscribed" else empty end),
        ($s | map(select(.mem.available_kb < 1048576)) | if length > 0 then
          "!  \(length) sample(s) under 1 GB available — and there is no swap" else empty end),
        ($s | map(select((.mem.swap_total_kb - .mem.swap_free_kb) > 0)) | if length > 0 then
          "!  swapping observed" else empty end),
        ($v | map(select(.st_cpu / .dt > 0.5)) | if length > 0 then
          "!  \(length) minute(s) with >50% cpu-some stall — something waited on CPU half the minute" else empty end),
        ($w | map(select(.ok | not)) | if length > 0 then
          "!  \(length) gap(s) in sampling — cron missed a tick, or the box restarted" else empty end)
      ] | if length > 0 then ["", "FLAGS"] + . else ["", "FLAGS      none — nothing crossed a threshold in this window"] end )
  | .[]
  end
' "$LOG"
