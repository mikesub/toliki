#!/usr/bin/env bash
set -uo pipefail

# Exercises the host-timezone contract against throwaway registries, a fake
# timedatectl state file, and fixed UTC instants. Nothing changes the machine's
# clock or timezone; the real zoneinfo database is used for DST abbreviations.

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
    nok "$1"; printf '       missing: %s\n' "$3"; printf '%s\n' "$2" | sed 's/^/         /' | head -20
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi; }
assert_matches() {
  if [[ "$2" =~ $3 ]]; then ok "$1"; else nok "$1 (got '$2')"; fi
}
assert_file() { if [[ -f "$2" ]]; then ok "$1"; else nok "$1 (missing: $2)"; fi; }

# ───────────────────────── registry + shell API ─────────────────────────
HARNESS="$TMP/harness"
mkdir -p "$HARNESS/etc"
cp "$ROOT/etc/lib.sh" "$HARNESS/etc/lib.sh"
cp "$ROOT/etc/engines.json" "$HARNESS/etc/engines.json"

write_registry() { # optional literal HOST_TIMEZONE assignment; omit for missing
  cat > "$HARNESS/etc/repos.conf" <<'CONF'
REPOS=( testrepo=/tmp/testrepo )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="/tmp/harness"
SSH_HOST="unused"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
CONF
  [[ $# -eq 0 ]] || printf 'HOST_TIMEZONE=%s\n' "$1" >> "$HARNESS/etc/repos.conf"
}

LIB_OUT=""
LIB_RC=0
run_lib() { # optional command after source
  local command="${1:-printf '%s|%s' \"\$HOST_TIMEZONE\" \"\$TZ\"}"
  LIB_RC=0
  LIB_OUT="$(
    HOST_TIMEZONE=Pacific/Honolulu TZ=Pacific/Honolulu \
      bash -c 'source "$1/etc/lib.sh" && eval "$2"' _ "$HARNESS" "$command" 2>&1
  )" || LIB_RC=$?
}

printf '\nregistry: caller environment cannot choose the host zone\n'
write_registry
run_lib
assert_rc "an absent HOST_TIMEZONE loads" 0 "$LIB_RC"
assert_eq "absent normalizes to UTC despite inherited values" "UTC|UTC" "$LIB_OUT"

write_registry '""'
run_lib
assert_rc "an empty HOST_TIMEZONE loads" 0 "$LIB_RC"
assert_eq "empty normalizes to UTC despite inherited values" "UTC|UTC" "$LIB_OUT"

write_registry '"Europe/Amsterdam"'
run_lib
assert_rc "a known IANA zone loads" 0 "$LIB_RC"
assert_eq "the registry zone is exported through both names" "Europe/Amsterdam|Europe/Amsterdam" "$LIB_OUT"
LIB_RC=0
LIB_OUT="$(
  env -u HOST_TIMEZONE -u TZ bash -c '
    source "$1/etc/lib.sh"
    bash -c '\''printf "%s|%s" "$HOST_TIMEZONE" "$TZ"'\''
  ' _ "$HARNESS" 2>&1
)" || LIB_RC=$?
assert_rc "a clean caller loads the valid registry" 0 "$LIB_RC"
assert_eq "HOST_TIMEZONE and TZ are exported to child tools" "Europe/Amsterdam|Europe/Amsterdam" "$LIB_OUT"

printf '\nregistry: unsafe and unknown zones fail closed\n'
write_registry '"Mars/Olympus"'
run_lib
assert_rc "an unknown zone is refused" 1 "$LIB_RC"
assert_contains "the error names HOST_TIMEZONE" "$LIB_OUT" "HOST_TIMEZONE"
assert_contains "the error names the rejected value" "$LIB_OUT" "Mars/Olympus"

write_registry '"posix/../UTC"'
run_lib
assert_rc "a traversing relative name is refused even if it resolves" 1 "$LIB_RC"
assert_contains "the unsafe value is named" "$LIB_OUT" "posix/../UTC"

for zone in zone.tab iso3166.tab tzdata.zi localtime posixrules posix/UTC right/UTC; do
  write_registry "\"$zone\""
  run_lib
  assert_rc "the shell rejects non-zone zoneinfo entry $zone" 1 "$LIB_RC"
  assert_contains "the shell refusal names $zone" "$LIB_OUT" "$zone"
done

printf '\nshell clock: fixed instants use exact DST-aware abbreviations\n'
write_registry '"Europe/Amsterdam"'
run_lib 'declare -F human_ts >/dev/null'
assert_rc "the shell provides the human_ts API" 0 "$LIB_RC"
if [[ "$LIB_RC" -eq 0 ]]; then
  run_lib 'human_ts 2026-01-05T12:31:14Z'
  assert_rc "winter conversion succeeds" 0 "$LIB_RC"
  assert_eq "winter renders CET" "2026-01-05 13:31:14 CET" "$LIB_OUT"
  run_lib 'human_ts 2026-09-05T12:31:14Z'
  assert_rc "summer conversion succeeds" 0 "$LIB_RC"
  assert_eq "summer renders CEST" "2026-09-05 14:31:14 CEST" "$LIB_OUT"

  write_registry '"UTC"'
  run_lib 'human_ts 2026-09-05T12:31:14Z'
  assert_rc "UTC conversion succeeds" 0 "$LIB_RC"
  assert_eq "UTC uses the same human-readable shape" "2026-09-05 12:31:14 UTC" "$LIB_OUT"
  run_lib 'human_ts definitely-not-an-instant'
  if [[ "$LIB_RC" -ne 0 ]]; then ok "an invalid instant is rejected"; else nok "an invalid instant is rejected (got rc 0)"; fi

  write_registry '"Europe/Amsterdam"'
  run_lib 'humanize_timestamps "provider quota exhausted — holding launches until 2026-09-05T12:31:14.000Z (fallback)"'
  assert_rc "embedded machine instants can be rendered for shell output" 0 "$LIB_RC"
  assert_eq "the shell renderer localizes a quota deadline" \
    "provider quota exhausted — holding launches until 2026-09-05 14:31:14 CEST (fallback)" "$LIB_OUT"
fi

write_registry '"Europe/Amsterdam"'
run_lib 'ts'
assert_rc "the current human clock renders" 0 "$LIB_RC"
assert_matches "ts uses the human timestamp shape" "$LIB_OUT" '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2} (CET|CEST)$'

assert_contains "the registry template documents HOST_TIMEZONE" "$(cat "$ROOT/etc/repos.conf.template")" "HOST_TIMEZONE"

# ───────────────────────── operator skill host clock ─────────────────────────
OPERATOR_CLOCK="$ROOT/.agents/skills/toliki/scripts/host-clock.sh"
assert_file "the operator skill has a deterministic host-clock helper" "$OPERATOR_CLOCK"
OPERATOR_SKILL_TEXT="$(cat "$ROOT/.agents/skills/toliki/SKILL.md")"
assert_contains "operator setup invokes the host-clock helper" "$OPERATOR_SKILL_TEXT" \
  "bash .agents/skills/toliki/scripts/host-clock.sh"
assert_contains "operator UTC conversion invokes the host-clock helper" "$OPERATOR_SKILL_TEXT" \
  "host-clock.sh --human-ts '<UTC instant>'"
assert_contains "operator triage reads the active vendor map" "$OPERATOR_SKILL_TEXT" \
  "Exit 0 prints the active vendor map"
assert_contains "operator triage reports each held vendor separately" "$OPERATOR_SKILL_TEXT" \
  "one host-level item per active vendor"
assert_contains "operator triage stays silent when no vendor is held" "$OPERATOR_SKILL_TEXT" \
  "Say nothing when no vendor is active"
assert_not_contains "operator triage does not claim one vendor pauses every provider" \
  "$OPERATOR_SKILL_TEXT" "including work routed to another provider"
assert_not_contains "operator instructions never print local HOST_TIMEZONE as host state" \
  "$OPERATOR_SKILL_TEXT" '"HOST_TIMEZONE=$HOST_TIMEZONE"'

if [[ -f "$OPERATOR_CLOCK" ]]; then
  OPERATOR_LOCAL="$TMP/operator-local"
  OPERATOR_HOST="$TMP/operator-host"
  OPERATOR_BIN="$TMP/operator-bin"
  mkdir -p "$OPERATOR_LOCAL/.agents/skills/toliki/scripts" "$OPERATOR_LOCAL/etc" \
    "$OPERATOR_HOST/etc" "$OPERATOR_BIN"
  cp "$OPERATOR_CLOCK" "$OPERATOR_LOCAL/.agents/skills/toliki/scripts/host-clock.sh"
  cp "$ROOT/etc/lib.sh" "$ROOT/etc/engines.json" "$OPERATOR_LOCAL/etc/"
  cp "$ROOT/etc/lib.sh" "$ROOT/etc/engines.json" "$OPERATOR_HOST/etc/"
  cat > "$OPERATOR_LOCAL/etc/repos.conf" <<CONF
REPOS=( testrepo=/tmp/testrepo )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="$OPERATOR_HOST"
SSH_HOST="stub-host"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
HOST_TIMEZONE="UTC"
CONF
  cat > "$OPERATOR_HOST/etc/repos.conf" <<'CONF'
REPOS=( testrepo=/tmp/testrepo )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="/remote/toliki"
SSH_HOST="irrelevant-on-host"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
HOST_TIMEZONE="Europe/Amsterdam"
CONF
  cat > "$OPERATOR_BIN/ssh" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == "stub-host" ]] || exit 91
shift
bash -c "$1"
STUB
  chmod +x "$OPERATOR_BIN/ssh" "$OPERATOR_LOCAL/.agents/skills/toliki/scripts/host-clock.sh"

  OPERATOR_OUT="$(PATH="$OPERATOR_BIN:$PATH" bash "$OPERATOR_LOCAL/.agents/skills/toliki/scripts/host-clock.sh" 2>&1)"
  assert_contains "operator setup keeps the laptop SSH destination" "$OPERATOR_OUT" "SSH_HOST=stub-host"
  assert_contains "operator setup keeps laptop repository origins" "$OPERATOR_OUT" "testrepo=owner/testrepo"
  assert_contains "operator setup reads HOST_TIMEZONE from the host registry" "$OPERATOR_OUT" "HOST_TIMEZONE=Europe/Amsterdam"
  assert_not_contains "operator setup never reports the laptop timezone as host state" "$OPERATOR_OUT" "HOST_TIMEZONE=UTC"

  OPERATOR_OUT="$(
    PATH="$OPERATOR_BIN:$PATH" \
      bash "$OPERATOR_LOCAL/.agents/skills/toliki/scripts/host-clock.sh" --human-ts 2026-09-05T12:31:14Z 2>&1
  )"
  assert_eq "operator UTC conversion runs in the host registry zone" "2026-09-05 14:31:14 CEST" "$OPERATOR_OUT"
fi

# ───────────────────────── Node formatter API ─────────────────────────
TIME_MODULE="$ROOT/workflows/lib/time.mjs"
assert_file "the shared Node formatter exists" "$TIME_MODULE"

NODE_OUT=""
NODE_RC=0
run_node_time() { # zone (__UNSET__ for default), instant
  local zone="$1" instant="$2"
  NODE_RC=0
  if [[ ! -f "$TIME_MODULE" ]]; then
    NODE_OUT="missing workflows/lib/time.mjs"
    NODE_RC=125
    return
  fi
  if [[ "$zone" == "__UNSET__" ]]; then
    NODE_OUT="$(
      env -u HOST_TIMEZONE TZ=Pacific/Honolulu node --input-type=module - "$TIME_MODULE" "$instant" <<'NODE'
import { pathToFileURL } from 'node:url'
const { humanTimestamp } = await import(pathToFileURL(process.argv[2]).href)
process.stdout.write(humanTimestamp(process.argv[3]))
NODE
    )" 2>&1 || NODE_RC=$?
  else
    NODE_OUT="$(
      HOST_TIMEZONE="$zone" TZ=Pacific/Honolulu node --input-type=module - "$TIME_MODULE" "$instant" <<'NODE'
import { pathToFileURL } from 'node:url'
const { humanTimestamp } = await import(pathToFileURL(process.argv[2]).href)
process.stdout.write(humanTimestamp(process.argv[3]))
NODE
    )" 2>&1 || NODE_RC=$?
  fi
}

printf '\nNode clock: defaults, fixed DST instants, and refusals\n'
if [[ -f "$TIME_MODULE" ]]; then
  run_node_time __UNSET__ 2026-09-05T12:31:14Z
  assert_rc "an absent Node HOST_TIMEZONE defaults successfully" 0 "$NODE_RC"
  assert_eq "Node ignores a hostile TZ when HOST_TIMEZONE is absent" "2026-09-05 12:31:14 UTC" "$NODE_OUT"
  run_node_time Europe/Amsterdam 2026-01-05T12:31:14Z
  assert_rc "Node winter conversion succeeds" 0 "$NODE_RC"
  assert_eq "Node winter output matches shell" "2026-01-05 13:31:14 CET" "$NODE_OUT"
  run_node_time Europe/Amsterdam 2026-09-05T12:31:14Z
  assert_rc "Node summer conversion succeeds" 0 "$NODE_RC"
  assert_eq "Node summer output matches shell" "2026-09-05 14:31:14 CEST" "$NODE_OUT"
  run_node_time Mars/Olympus 2026-09-05T12:31:14Z
  if [[ "$NODE_RC" -ne 0 ]]; then ok "Node rejects an unknown zone"; else nok "Node rejects an unknown zone (got rc 0)"; fi
  for zone in zone.tab iso3166.tab tzdata.zi localtime posixrules posix/UTC right/UTC; do
    run_node_time "$zone" 2026-09-05T12:31:14Z
    if [[ "$NODE_RC" -ne 0 ]]; then
      ok "Node rejects non-zone zoneinfo entry $zone"
    else
      nok "Node rejects non-zone zoneinfo entry $zone (got rc 0)"
    fi
  done
  run_node_time UTC definitely-not-an-instant
  if [[ "$NODE_RC" -ne 0 ]]; then ok "Node rejects an invalid instant"; else nok "Node rejects an invalid instant (got rc 0)"; fi
fi

# Quota holds deliberately keep holdUntil canonical in their JSON/RESULT
# records. The human surfaces receive that same string, so exercise the shared
# text renderer and status-comment boundary without coupling presentation to
# the hold's storage implementation.
NODE_TEXT_OUT="$(
  HOST_TIMEZONE=Europe/Amsterdam TZ=Pacific/Honolulu node --input-type=module - "$TIME_MODULE" <<'NODE'
import { pathToFileURL } from 'node:url'
const { humanizeTimestamps } = await import(pathToFileURL(process.argv[2]).href)
const record = { holdUntil: '2026-09-05T12:31:14.000Z' }
process.stdout.write(`${humanizeTimestamps(`held until ${record.holdUntil}`)}\n${record.holdUntil}`)
NODE
)" 2>&1 || true
assert_eq "the Node renderer localizes output without changing the stored deadline" \
  $'held until 2026-09-05 14:31:14 CEST\n2026-09-05T12:31:14.000Z' "$NODE_TEXT_OUT"

STATUS_BIN="$TMP/status-bin"
STATUS_CAPTURE="$TMP/status-comment"
mkdir -p "$STATUS_BIN"
cat > "$STATUS_BIN/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$STATUS_CAPTURE"
printf '%s\n' 'https://github.example/issues/42#issuecomment-123'
STUB
chmod +x "$STATUS_BIN/gh"
STATUS_CAPTURE="$STATUS_CAPTURE" PATH="$STATUS_BIN:$PATH" \
  HOST_TIMEZONE=Europe/Amsterdam TZ=Pacific/Honolulu \
  node --input-type=module - "$ROOT/workflows/lib/status.mjs" <<'NODE'
import { pathToFileURL } from 'node:url'
const { initStatus, statusFinish } = await import(pathToFileURL(process.argv[2]).href)
initStatus({ issue: 42, script: 'epic-run', phases: ['Prepare'] })
await statusFinish('**held**: provider quota exhausted, resumes after 2026-09-05T12:31:14.000Z')
NODE
STATUS_BODY="$(tr '\0' '\n' < "$STATUS_CAPTURE")"
assert_contains "quota-held status notes render the deadline in the host zone" \
  "$STATUS_BODY" "resumes after 2026-09-05 14:31:14 CEST"
assert_not_contains "quota-held status notes do not expose the canonical deadline" \
  "$STATUS_BODY" "resumes after 2026-09-05T12:31:14.000Z"

DISPATCH_HARNESS="$TMP/dispatch-harness"
mkdir -p "$DISPATCH_HARNESS/bin" "$DISPATCH_HARNESS/etc"
cp "$ROOT/bin/dispatch.sh" "$DISPATCH_HARNESS/bin/dispatch.sh"
cp "$ROOT/etc/lib.sh" "$ROOT/etc/engines.json" "$DISPATCH_HARNESS/etc/"
cat > "$DISPATCH_HARNESS/etc/repos.conf" <<'CONF'
REPOS=( testrepo=/tmp/testrepo )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="/tmp/harness"
SSH_HOST="unused"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
HOST_TIMEZONE="Europe/Amsterdam"
CONF
DISPATCH_OUT="$(HOST_TIMEZONE=Pacific/Honolulu TZ=Pacific/Honolulu \
  bash "$DISPATCH_HARNESS/bin/dispatch.sh" --repo 2026-09-05T12:31:14.000Z 2>&1 || true)"
assert_contains "dispatch messages localize an embedded machine deadline" \
  "$DISPATCH_OUT" "2026-09-05 14:31:14 CEST"
assert_not_contains "dispatch messages do not expose the canonical deadline" \
  "$DISPATCH_OUT" "2026-09-05T12:31:14.000Z"

# ───────────────────────── provisioning helper ─────────────────────────
PROVISION_LIB="$ROOT/bin/provision-timezone.lib.sh"
assert_file "the timezone provisioning helper exists" "$PROVISION_LIB"

mkdir -p "$TMP/bin"
cat > "$TMP/bin/timedatectl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TIMEZONE_CALLS"
if [[ " $* " == *" set-timezone "* ]]; then
  [[ -z "${TIMEZONE_SET_FAIL:-}" ]] || exit 1
  [[ -n "${TIMEZONE_IGNORE_SET:-}" ]] || printf '%s' "${!#}" > "$TIMEZONE_STATE"
  exit 0
fi
reads="$(cat "$TIMEZONE_READS" 2>/dev/null || echo 0)"
reads=$((reads + 1))
printf '%s' "$reads" > "$TIMEZONE_READS"
[[ "${TIMEZONE_READ_FAIL:-}" != "always" ]] || exit 1
[[ "${TIMEZONE_READ_FAIL:-}" != "after-first" || "$reads" -le 1 ]] || exit 1
cat "$TIMEZONE_STATE"
STUB
chmod +x "$TMP/bin/timedatectl"

PROVISION_OUT=""
run_provision_case() { # initial-zone, desired-zone, set-fail, ignore-set, read-fail mode
  printf '%s' "$1" > "$TMP/timezone.state"
  : > "$TMP/timezone.calls"
  printf '0' > "$TMP/timezone.reads"
  if [[ ! -f "$PROVISION_LIB" ]]; then
    PROVISION_OUT="BLOCKED|missing provision-timezone.lib.sh"
    return
  fi
  PROVISION_OUT="$(
    PATH="$TMP/bin:$PATH" SUDO="" HOST_TIMEZONE="$2" \
    TIMEZONE_STATE="$TMP/timezone.state" TIMEZONE_CALLS="$TMP/timezone.calls" TIMEZONE_READS="$TMP/timezone.reads" \
    TIMEZONE_SET_FAIL="$3" TIMEZONE_IGNORE_SET="$4" TIMEZONE_READ_FAIL="$5" \
    LIB="$PROVISION_LIB" bash -c '
      set -uo pipefail
      ok() { printf "OK|%s\n" "$*"; }
      changed() { printf "CHANGED|%s\n" "$*"; }
      blocked() { printf "BLOCKED|%s\n" "$*"; }
      source "$LIB"
      provision_host_timezone
    ' 2>&1
  )"
}

printf '\nprovisioning: effective-zone read, idempotent set, and readback\n'
if [[ -f "$PROVISION_LIB" ]]; then
  run_provision_case Europe/Amsterdam Europe/Amsterdam "" "" ""
  assert_eq "a matching host is still checked on every run" "1" "$(cat "$TMP/timezone.reads")"
  assert_not_contains "a matching host is not changed" "$(cat "$TMP/timezone.calls")" "set-timezone"
  assert_not_contains "a matching host is not blocked" "$PROVISION_OUT" "BLOCKED|"

  run_provision_case UTC Europe/Amsterdam "" "" ""
  assert_contains "a mismatch is changed with timedatectl" "$(cat "$TMP/timezone.calls")" "set-timezone Europe/Amsterdam"
  assert_eq "a changed timezone is read back for verification" "2" "$(cat "$TMP/timezone.reads")"
  assert_eq "the effective state is updated" "Europe/Amsterdam" "$(cat "$TMP/timezone.state")"
  assert_contains "the change is reported" "$PROVISION_OUT" "CHANGED|"
  assert_not_contains "a verified change is not blocked" "$PROVISION_OUT" "BLOCKED|"

  run_provision_case UTC Europe/Amsterdam 1 "" ""
  assert_contains "a set failure is a blocker" "$PROVISION_OUT" "BLOCKED|"
  assert_matches "the blocker identifies timezone provisioning" "$PROVISION_OUT" '(timezone|time zone|HOST_TIMEZONE)'

  run_provision_case UTC Europe/Amsterdam "" 1 ""
  assert_contains "a mismatched readback is a blocker" "$PROVISION_OUT" "BLOCKED|"
  assert_eq "an ignored set did not silently change state" "UTC" "$(cat "$TMP/timezone.state")"

  run_provision_case UTC Europe/Amsterdam "" "" after-first
  assert_contains "the readback failure happens after the set" "$(cat "$TMP/timezone.calls")" "set-timezone Europe/Amsterdam"
  assert_contains "a failed readback command is a blocker" "$PROVISION_OUT" "BLOCKED|"

  run_provision_case UTC Europe/Amsterdam "" "" always
  assert_contains "an effective-zone read failure is a blocker" "$PROVISION_OUT" "BLOCKED|"
  assert_not_contains "a failed initial read does not attempt mutation" "$(cat "$TMP/timezone.calls")" "set-timezone"
fi

PROVISION_TEXT="$(cat "$ROOT/bin/provision.sh")"
assert_contains "provision.sh sources the timezone helper" "$PROVISION_TEXT" "provision-timezone.lib.sh"
if grep -Eq '^[[:space:]]*provision_host_timezone[[:space:]]*$' "$ROOT/bin/provision.sh"; then
  ok "provision.sh invokes the helper as a step"
else
  nok "provision.sh invokes the helper as a step"
fi
SUDO_LINE="$(grep -n 'SUDO="sudo"' "$ROOT/bin/provision.sh" | head -1 | cut -d: -f1)"
TIMEZONE_LINE="$(grep -n '^[[:space:]]*provision_host_timezone[[:space:]]*$' "$ROOT/bin/provision.sh" | head -1 | cut -d: -f1)"
BASE_LINE="$(grep -n 'say "base packages"' "$ROOT/bin/provision.sh" | head -1 | cut -d: -f1)"
if [[ -n "$SUDO_LINE" && -n "$TIMEZONE_LINE" && -n "$BASE_LINE" && "$SUDO_LINE" -lt "$TIMEZONE_LINE" && "$TIMEZONE_LINE" -lt "$BASE_LINE" ]]; then
  ok "timezone provisioning runs after sudo resolution and before package mutation"
else
  nok "timezone provisioning runs after sudo resolution and before package mutation"
fi

# ───────────────────────── resource machine/presentation clocks ─────────────────────────
RESOURCE_HARNESS="$TMP/resource-harness"
mkdir -p "$RESOURCE_HARNESS"
cp -R "$ROOT/bin" "$ROOT/etc" "$RESOURCE_HARNESS/"
cat > "$RESOURCE_HARNESS/etc/repos.conf" <<'CONF'
REPOS=( testrepo=/tmp/testrepo )
REPO_ORIGINS=( testrepo=owner/testrepo )
HOST_CONTROL_DIR="/tmp/harness"
SSH_HOST="unused"
NAMES=(alpha)
NAME_MAX_LEN=40
MAX_PARALLEL_EPICS=2
HOST_TIMEZONE="Europe/Amsterdam"
CONF

resource_sample() { # timestamp, monotonic counter base
  printf '{"ts":"%s","cpu":{"user":%s,"nice":0,"system":%s,"idle":%s,"iowait":0,"irq":0,"softirq":0,"steal":0},"psi":{"cpu_some":%s,"cpu_full":0,"mem_some":%s,"mem_full":0,"io_some":%s,"io_full":0},"mem":{"total_kb":2097152,"available_kb":1572864,"cached_kb":524288,"swap_total_kb":0,"swap_free_kb":0},"epics":[],"epic_count":0,"phase":{"supabase_cli":0,"db_reset":0,"integration":0,"builds":0},"docker":{"containers":0,"stacks":[]},"disk_pct":25}\n' \
    "$1" "$2" "$2" "$((2 * $2))" "$((1000000 * $2))" "$((100000 * $2))" "$((100000 * $2))"
}

printf '\nresource report: stored UTC is localized only at presentation\n'
RESOURCE_LOG_FILE="$TMP/resource-winter.jsonl"
resource_sample 2026-01-05T12:31:14Z 100 > "$RESOURCE_LOG_FILE"
resource_sample 2026-01-05T12:32:14Z 110 >> "$RESOURCE_LOG_FILE"
RESOURCE_OUT="$(
  HOST_TIMEZONE=Pacific/Honolulu TZ=Pacific/Honolulu RESOURCE_LOG="$RESOURCE_LOG_FILE" \
    bash "$RESOURCE_HARNESS/bin/resource-report.sh" 24 2>&1
)"
assert_contains "winter sample bounds render in registry CET" "$RESOURCE_OUT" "2026-01-05 13:31:14 CET → 2026-01-05 13:32:14 CET"
assert_not_contains "the report does not expose raw UTC bounds" "$RESOURCE_OUT" "2026-01-05T12:31:14Z →"

RESOURCE_LOG_FILE="$TMP/resource-summer.jsonl"
resource_sample 2026-09-05T12:31:14Z 100 > "$RESOURCE_LOG_FILE"
resource_sample 2026-09-05T12:32:14Z 110 >> "$RESOURCE_LOG_FILE"
RESOURCE_OUT="$(
  HOST_TIMEZONE=Pacific/Honolulu TZ=Pacific/Honolulu RESOURCE_LOG="$RESOURCE_LOG_FILE" \
    bash "$RESOURCE_HARNESS/bin/resource-report.sh" 24 2>&1
)"
assert_contains "summer sample bounds render in registry CEST" "$RESOURCE_OUT" "2026-09-05 14:31:14 CEST → 2026-09-05 14:32:14 CEST"

# resource-log's sampler inputs are live host state. Verify its machine clock
# through the side-effect-free helper, under a PATH that contains only fake
# date, so this suite cannot accidentally probe the verification host.
RESOURCE_CLOCK_LIB="$ROOT/bin/resource-log.lib.sh"
assert_file "resource-log has a side-effect-free clock helper" "$RESOURCE_CLOCK_LIB"
mkdir -p "$TMP/resource-clock-bin"
cat > "$TMP/resource-clock-bin/date" <<'STUB'
#!/bin/bash
if [[ "$*" == "-u +%Y-%m-%dT%H:%M:%SZ" ]]; then
  printf '2026-09-05T12:31:14Z\n'
else
  exit 90
fi
STUB
chmod +x "$TMP/resource-clock-bin/date"
if [[ -f "$RESOURCE_CLOCK_LIB" ]]; then
  MACHINE_TS="$(PATH="$TMP/resource-clock-bin" /bin/bash -c 'source "$1"; resource_record_ts' _ "$RESOURCE_CLOCK_LIB")"
  assert_eq "resource-log retains canonical UTC ISO" "2026-09-05T12:31:14Z" "$MACHINE_TS"
  if jq -n --arg ts "$MACHINE_TS" '$ts | fromdateiso8601 | type == "number"' >/dev/null; then
    ok "resource-log's machine timestamp remains parseable"
  else
    nok "resource-log's machine timestamp remains parseable"
  fi
fi
RESOURCE_LOG_TEXT="$(cat "$ROOT/bin/resource-log.sh")"
assert_contains "resource-log sources the pure clock helper" "$RESOURCE_LOG_TEXT" "resource-log.lib.sh"
assert_contains "resource-log obtains TS through the pure helper" "$RESOURCE_LOG_TEXT" 'TS="$(resource_record_ts)"'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
