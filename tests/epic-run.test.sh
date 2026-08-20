#!/usr/bin/env bash
set -euo pipefail

# Exercises workflows/epic-run.mjs and workflows/fix-run.mjs end to end against
# a STUB ENGINE — a fake `claude` on PATH that answers each step from a fixture
# keyed by a marker in the prompt it was handed. Nothing here touches git, gh,
# the network, or any real repo, so it is safe to run anywhere, live host
# included.
#
# What it is actually holding: the gates. Every scenario below is a way the
# pipeline is supposed to REFUSE to ship — a dead review lens, a deferred
# finding, an off-schema payload — plus the one path where it does ship. The
# stub's argv log is what lets it assert the model tiering and agent charters
# too, which are otherwise invisible until a production run bills for them.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EPIC_RUN="$ROOT/workflows/epic-run.mjs"
FIX_RUN="$ROOT/workflows/fix-run.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }

assert_rc() { # name want got
  if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi
}
assert_not_contains() {
  if [[ "$2" != *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       unexpectedly present: %s\n' "$3"
  fi
}
assert_contains() { # name haystack needle
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"
    printf '       missing: %s\n' "$3"
    printf '       in:\n%s\n' "$2" | sed 's/^/         /' | head -25
  fi
}
assert_not_contains() { # name haystack needle
  if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi
}
assert_eq() { # name want got
  if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi
}

# ───────────────────────── the stub engine ─────────────────────────
# Keys a fixture off a marker in the prompt (read from stdin, exactly as the
# adapter feeds a real CLI), counts calls per key so a scenario can make the
# first attempt fail and the second succeed, and logs its own argv so the
# tiering assertions have something to read.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
# One line per call: the charter arrives via --append-system-prompt and is
# multi-line, so squeeze whitespace or a single call would span many lines and
# break every assertion that greps this log.
printf '%s\n' "$*" | tr '\n' ' ' | tr -s ' ' >> "$STUB_LOG"
printf '\n' >> "$STUB_LOG"
prompt="$(cat)"

key=unknown
case "$prompt" in
  *"hit a blocker and must report it on GitHub"*)      key=blocked ;;
  *"Prepare phase for GitHub issue #"*)                key=prepare ;;
  *"conflict-fixer run on GitHub issue"*)              key=fix-prepare ;;
  *"Resolve the JUDGMENT hunks"*)                      key=fix-resolve ;;
  *"Adversarially check a rebase-conflict resolution"*) key=fix-check ;;
  *"Ship the fixer run for issue"*)                    key=fix-ship ;;
  *"Verify phase, autonomous"*)                        key=fix-verify ;;
  *"design the implementation approach for it"*)       key=design ;;
  *"Transcribe the design below into"*)                key=arch-write ;;
  *"Code phase, RED step"*)                            key=red ;;
  *"Code phase, GREEN step"*)                          key=green ;;
  *'return its full contents VERBATIM in the "requirement" field'*) key=read-req ;;
  *"Review this change for the lens: correctness"*)    key=lens-correctness ;;
  *"Review this change for the lens: simplicity"*)     key=lens-simplicity ;;
  *"Review this change for the lens: test honesty"*)   key=lens-seam ;;
  *"Review this change for the lens: requirements"*)   key=lens-acceptance ;;
  *"Review this change for the lens: security"*)       key=lens-security ;;
  *"Adversarially verify"*)                            key=verify ;;
  *"from the review results below"*)                   key=review-write ;;
  *"Triage phase, autonomous"*)                        key=triage ;;
  *"Ship phase, autonomous"*)                          key=ship ;;
  *"Queue issue #"*)                                   key=handoff ;;
  *"This is the manual flow"*)                         key=summary ;;
esac

n="$(cat "$STUB_STATE/$key.n" 2>/dev/null || echo 0)"
printf '%s' "$((n + 1))" > "$STUB_STATE/$key.n"
printf '%s' "$prompt" > "$STUB_STATE/$key.$n.prompt"

if [[ -f "$STUB_FIXTURES/$key.$n.rc" ]]; then exit "$(cat "$STUB_FIXTURES/$key.$n.rc")"; fi
for f in "$STUB_FIXTURES/$key.$n.json" "$STUB_FIXTURES/$key.json"; do
  if [[ -f "$f" ]]; then cat "$f"; exit 0; fi
done
printf 'stub: no fixture for key %s (call %s)\n' "$key" "$n" >&2
exit 9
STUB
chmod +x "$TMP/bin/claude"

# A success envelope carrying structured output, exactly the shape the CLI's
# own result schema describes (see lib/engine.mjs).
fixture() { # dir key structured-json
  printf '{"type":"result","subtype":"success","is_error":false,"result":"ok","structured_output":%s}\n' "$3" > "$1/$2.json"
}
# A success envelope with no structured output — what a schema-less step returns.
fixture_text() { # dir key text
  printf '{"type":"result","subtype":"success","is_error":false,"result":"%s"}\n' "$3" > "$1/$2.json"
}

# ───────────────────────── the happy-path fixture set ─────────────────────────
BASE="$TMP/fixtures-base"
mkdir -p "$BASE"
fixture "$BASE" prepare '{"alreadyExists":false,"resumed":false,"slug":"42-add-widget","branch":"epic/42-add-widget","requirement":"Build a widget.","packages":["frontend"]}'
fixture "$BASE" design '{"approach":"Thin widget module","rationale":"Fits the existing shape.","steps":["one","two"],"files":["src/widget.ts — new"],"contract":"createWidget(): Widget","tradeoffs":"No caching."}'
fixture_text "$BASE" arch-write "architecture.md written"
fixture_text "$BASE" red "wrote widget.test.ts; fails on missing export"
fixture_text "$BASE" green "frontend verified green"
for lens in lens-simplicity lens-seam lens-acceptance lens-security; do
  fixture "$BASE" "$lens" '{"findings":[]}'
done
fixture "$BASE" lens-correctness '{"findings":[{"title":"Null deref on empty list","severity":"Critical","confidence":90,"location":"src/widget.ts:12","problem":"Crashes when items is empty.","fix":"Guard the access.","gate":"unit test for the empty case"}]}'
fixture "$BASE" verify '{"verdicts":[{"index":1,"real":true,"confidence":90,"reasoning":"Confirmed against the code."}]}'
fixture_text "$BASE" review-write "review.md written"
fixture "$BASE" triage '{"status":"Fixed the null deref, verify green.","deferred":[]}'
fixture "$BASE" ship '{"prUrl":"https://github.com/o/r/pull/7","deferredDefects":0}'
fixture "$BASE" handoff '{"labelled":true}'
fixture_text "$BASE" blocked "blocker comment posted, label swapped to failed"

# ───────────────────────── the runner ─────────────────────────
RUN_OUT=""
RUN_RC=0
RUN_LOG=""
run_pipeline() { # script fixtures-dir args...
  local script="$1" fixtures="$2"; shift 2
  local state="$TMP/state.$RANDOM"
  RUN_LOG="$TMP/argv.$RANDOM"
  mkdir -p "$state"
  : > "$RUN_LOG"
  RUN_RC=0
  RUN_OUT="$(
    cd "$TMP" && \
    PATH="$TMP/bin:$PATH" \
    CLAUDE_BIN="$TMP/bin/claude" \
    STUB_FIXTURES="$fixtures" \
    STUB_STATE="$state" \
    STUB_LOG="$RUN_LOG" \
    node "$script" "$@" 2>&1
  )" || RUN_RC=$?
  STATE_DIR="$state"
}
calls() { cat "$STATE_DIR/$1.n" 2>/dev/null || echo 0; }

printf '\nepic-run: happy path to ready-to-merge\n'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT says readyToMerge" "$RUN_OUT" '"readyToMerge":true'
assert_contains "RESULT carries the PR url" "$RUN_OUT" '"prUrl":"https://github.com/o/r/pull/7"'
assert_contains "review tally reported" "$RUN_OUT" '1 confirmed by adversarial verification, 0 refuted'
assert_eq "handoff ran once" 1 "$(calls handoff)"
assert_eq "no blocker was posted" 0 "$(calls blocked)"
assert_eq "all five lenses ran" 5 "$(( $(calls lens-correctness) + $(calls lens-simplicity) + $(calls lens-seam) + $(calls lens-acceptance) + $(calls lens-security) ))"
# Tiering and charters are invisible in production until they bill; assert them here.
ARGV="$(cat "$RUN_LOG")"
# Charters ride in as --append-system-prompt + an explicit --tools list, never
# as --agent: `--agent` silently disables --json-schema (measured 2026-08-20),
# which is what broke vms#66's prepare. Asserting the ABSENCE of --agent is the
# regression guard; asserting the tool lists is the safety property that flag
# used to provide.
assert_not_contains "no stage uses --agent (it would void --json-schema)" "$ARGV" "--agent "
assert_contains "prepare runs the mechanical tier" "$ARGV" "--model sonnet"
assert_contains "prepare is chartered as coder (Write/Edit allowed)" "$ARGV" "Bash,Glob,Grep,Read,Edit,Write,"
assert_contains "design runs the strong tier" "$ARGV" "--model fable"
assert_contains "architect and reviewer cannot write" "$ARGV" "--tools Glob,Grep,Read,"
assert_contains "the reviewer charter reaches the model" "$ARGV" "Review code against project guidelines"
assert_contains "schemas are enforced by the engine" "$ARGV" "--json-schema"
assert_contains "permissions are pre-granted for autonomy" "$ARGV" "--dangerously-skip-permissions"

printf '\nepic-run: prepare refuses (claimed by another run)\n'
REFUSED="$TMP/fixtures-refused"; cp -R "$BASE" "$REFUSED"
fixture "$REFUSED" prepare '{"alreadyExists":false,"resumed":false,"refused":"claimed by another run"}'
run_pipeline "$EPIC_RUN" "$REFUSED" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "RESULT says skipped" "$RUN_OUT" '"skipped":true'
assert_contains "the reason survives verbatim" "$RUN_OUT" 'claimed by another run'
assert_eq "nothing was designed" 0 "$(calls design)"
assert_eq "no blocker was posted" 0 "$(calls blocked)"

printf '\nepic-run: a dead review lens fails the run closed\n'
DEADLENS="$TMP/fixtures-deadlens"; cp -R "$BASE" "$DEADLENS"
printf '1' > "$DEADLENS/lens-security.0.rc"   # first attempt dies
printf '1' > "$DEADLENS/lens-security.1.rc"   # and so does the retry
run_pipeline "$EPIC_RUN" "$DEADLENS" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the blocker names the review phase" "$RUN_OUT" '"phase":"review"'
assert_contains "the reason names the unreviewed lens" "$RUN_OUT" 'security + authorization'
assert_eq "the lens was retried exactly once" 2 "$(calls lens-security)"
assert_eq "a blocker comment was posted" 1 "$(calls blocked)"
assert_eq "nothing shipped" 0 "$(calls ship)"
assert_eq "nothing was queued for merge" 0 "$(calls handoff)"

printf '\nepic-run: a deferred finding holds the merge gate\n'
HELD="$TMP/fixtures-held"; cp -R "$BASE" "$HELD"
fixture "$HELD" triage '{"status":"Left one for a human.","deferred":[{"title":"Null deref on empty list","severity":"Critical","why":"The fix needs a product decision."}]}'
run_pipeline "$EPIC_RUN" "$HELD" --issue 42
assert_rc "exits 0 (the PR is real, just held)" 0 "$RUN_RC"
assert_contains "RESULT records why the gate held" "$RUN_OUT" '"mergeSkipped"'
assert_contains "the held reason names the finding" "$RUN_OUT" 'Critical: Null deref on empty list'
assert_not_contains "it is not queued for merge" "$RUN_OUT" '"readyToMerge":true'
assert_eq "handoff never ran" 0 "$(calls handoff)"

printf '\nepic-run: an off-schema payload is respawned once, then accepted\n'
RETRY="$TMP/fixtures-retry"; cp -R "$BASE" "$RETRY"
# Missing `contract` — the field red writes its tests from.
fixture "$RETRY" design.0 '{"approach":"Thin widget module","rationale":"Fits.","steps":["one"],"files":["src/widget.ts"],"tradeoffs":"None."}'
cp "$BASE/design.json" "$RETRY/design.1.json"
run_pipeline "$EPIC_RUN" "$RETRY" --issue 42
assert_rc "the run still completes" 0 "$RUN_RC"
assert_eq "design was spawned twice" 2 "$(calls design)"
assert_contains "the retry was announced" "$RUN_OUT" 'did not match the schema'

printf '\nepic-run: an off-schema payload twice fails the phase closed\n'
BADSCHEMA="$TMP/fixtures-badschema"; cp -R "$BASE" "$BADSCHEMA"
fixture "$BADSCHEMA" design '{"approach":"Thin widget module","rationale":"Fits.","steps":["one"],"files":["src/widget.ts"],"tradeoffs":"None."}'
run_pipeline "$EPIC_RUN" "$BADSCHEMA" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "it blocks in the architect phase" "$RUN_OUT" '"phase":"architect"'
assert_eq "nothing was implemented" 0 "$(calls red)"

printf '\nepic-run: manual slug mode touches no git phase\n'
MANUAL="$TMP/fixtures-manual"; cp -R "$BASE" "$MANUAL"
fixture "$MANUAL" read-req '{"requirement":"Build a widget.","packages":["frontend"]}'
fixture_text "$MANUAL" summary "summary.md written"
run_pipeline "$EPIC_RUN" "$MANUAL" --slug 42-add-widget
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "prepare never ran" 0 "$(calls prepare)"
assert_eq "nothing shipped a PR" 0 "$(calls ship)"
assert_eq "nothing was queued for merge" 0 "$(calls handoff)"
assert_contains "the summary came back" "$RUN_OUT" 'summary.md written'

# ───────────────────────── fix-run ─────────────────────────
FIXBASE="$TMP/fixtures-fix"
mkdir -p "$FIXBASE"
fixture "$FIXBASE" fix-prepare '{"attempt":1,"branch":"epic/42-add-widget","prUrl":"https://github.com/o/r/pull/7","prNumber":7,"prHead":"abc123","mergeBase":"def456","cleanRebase":false,"report":"hunk 1: needs judgment","markedFiles":["src/widget.ts"],"mainIssues":[41],"packages":["frontend"]}'
fixture "$FIXBASE" fix-resolve '{"completed":true,"resolutions":[{"file":"src/widget.ts","hunk":1,"mainIntent":"main renamed the helper","prIntent":"the PR added a guard","resolution":"Keeps the rename and the guard."}]}'
fixture "$FIXBASE" fix-verify '{"green":true,"detail":"frontend — pass"}'
fixture "$FIXBASE" fix-check '{"survives":true,"confidence":88,"reasoning":"Both changes are present at HEAD."}'
fixture "$FIXBASE" fix-ship '{"pushed":true,"labelled":true}'
fixture_text "$FIXBASE" blocked "blocker comment posted"

printf '\nfix-run: judgment hunk resolved, checked, shipped ready-to-review\n'
run_pipeline "$FIX_RUN" "$FIXBASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT lands ready-to-review" "$RUN_OUT" '"readyToReview":true'
assert_contains "it never claims ready-to-merge" "$RUN_OUT" '"resolvedHunks":1'
assert_not_contains "no merge queue promotion" "$RUN_OUT" 'readyToMerge'
SHIP_PROMPT="$(cat "$STATE_DIR/fix-ship.0.prompt")"
assert_contains "the audit comment states main's intent" "$SHIP_PROMPT" "origin/main intended: main renamed the helper"
assert_contains "the audit comment states the PR's intent" "$SHIP_PROMPT" "the PR intended: the PR added a guard"
assert_contains "the audit comment records the adversarial check" "$SHIP_PROMPT" "confidence 88/100"

printf '\nfix-run: the resolver escalates instead of guessing\n'
ESCALATE="$TMP/fixtures-escalate"; cp -R "$FIXBASE" "$ESCALATE"
fixture "$ESCALATE" fix-resolve '{"completed":false,"escalate":"src/widget.ts hunk 1: the two sides set the same flag to opposite values."}'
run_pipeline "$FIX_RUN" "$ESCALATE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the escalation reaches the blocker" "$RUN_OUT" 'escalated rather than guessed'
assert_eq "nothing was pushed" 0 "$(calls fix-ship)"

printf '\nfix-run: a red verify blocks — the fixer never fixes code\n'
REDVERIFY="$TMP/fixtures-redverify"; cp -R "$FIXBASE" "$REDVERIFY"
fixture "$REDVERIFY" fix-verify '{"green":false,"detail":"frontend — fail: widget.test.ts expected 2 got 1"}'
run_pipeline "$FIX_RUN" "$REDVERIFY" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the failing detail reaches the blocker" "$RUN_OUT" 'widget.test.ts expected 2 got 1'
assert_eq "the adversarial check never ran" 0 "$(calls fix-check)"
assert_eq "nothing was pushed" 0 "$(calls fix-ship)"

printf '\nfix-run: a refuted resolution blocks\n'
REFUTED="$TMP/fixtures-refuted"; cp -R "$FIXBASE" "$REFUTED"
fixture "$REFUTED" fix-check '{"survives":false,"confidence":20,"reasoning":"The rename was dropped from the guarded branch."}'
run_pipeline "$FIX_RUN" "$REFUTED" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the refutation reaches the blocker" "$RUN_OUT" 'the adversarial check refuted the resolution'
assert_eq "nothing was pushed" 0 "$(calls fix-ship)"

printf '\nfix-run: an exhausted attempt ladder refuses without running\n'
LADDER="$TMP/fixtures-ladder"; cp -R "$FIXBASE" "$LADDER"
fixture "$LADDER" fix-prepare '{"attempt":0,"cleanRebase":false,"markedFiles":[],"refused":"attempt ladder exhausted (fix-retried present)","refusalFinal":true}'
run_pipeline "$FIX_RUN" "$LADDER" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the refusal is final" "$RUN_OUT" '"refusalFinal":true'
assert_eq "no resolver was woken" 0 "$(calls fix-resolve)"

printf '\nfix-run: a rebase that came back clean skips judgment entirely\n'
CLEAN="$TMP/fixtures-clean"; cp -R "$FIXBASE" "$CLEAN"
fixture "$CLEAN" fix-prepare '{"attempt":1,"branch":"epic/42-add-widget","prUrl":"https://github.com/o/r/pull/7","prNumber":7,"prHead":"abc123","mergeBase":"def456","cleanRebase":true,"report":"","markedFiles":[],"mainIssues":[],"packages":["frontend"]}'
run_pipeline "$FIX_RUN" "$CLEAN" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "no resolver ran" 0 "$(calls fix-resolve)"
assert_eq "no adversarial check ran" 0 "$(calls fix-check)"
assert_contains "it still verified before shipping" "$RUN_OUT" 'Verify: green'
assert_contains "RESULT records that no judgment was exercised" "$RUN_OUT" '"resolvedHunks":0'

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
