#!/usr/bin/env bash
set -uo pipefail

# Exercises workflows/prompts/**: the one module per model step that every
# pipeline's prompts now live in. Hermetic by construction — the modules are
# pure builders, so this suite imports them directly, renders each one from
# hand-written runtime arguments, and reads the exact bytes a spawn would put on
# stdin. No pipeline runs, no engine, no network, no clock.
#
# What is asserted here, and why each is worth a test:
#   - interpolation: every runtime argument a builder is given reaches the
#     rendered prompt, including the numbered lists an indexed disposition
#     record is matched against later;
#   - conditional content: the branches that differ per run — a mid-rebase
#     conflict versus a human-granted round over prior declines, a local verify
#     that is green versus red, a task delivery versus a reviewed epic one —
#     each render their own wording and never the other's;
#   - evidence boundaries: captured bytes arrive inside their tagged block, a
#     capture that failed says so where the model reads it, and a builder's own
#     explanation stays out of the prompt that blindly judges it;
#   - the split itself: a prompt module builds a string and nothing else, so it
#     may not reach transport, the filesystem or a child process, and no
#     orchestrator keeps an inline prompt table beside the modules.
# tests/epic-run.test.sh still asserts the prompts a real run puts on stdin;
# these are the focused rendering checks underneath it.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_eq() { if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"
    printf '%s\n' "$2" | head -n 12 | sed 's/^/       | /'
  fi
}
assert_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi; }
section() { printf '\n%s\n' "$1"; }

# ───────────────────────── the renderer ─────────────────────────
# One case per invocation, printed raw on stdout. The fixtures are the whole
# input: every value asserted below is a literal here, so a rendered prompt can
# be checked against bytes that are known exactly.
cat > "$TMP/render.mjs" <<'RENDER'
const root = process.env.ROOT
const load = async path => import(`${root}/workflows/prompts/${path}`)

const REQUIREMENT = 'Deliver the widget, and never a bare #number.'
const CHANGE_DIFF = 'diff --git a/src/widget.ts b/src/widget.ts\n+export const createWidget = () => {}'

// Two findings with ONE title: indexes, never titles, are the identity.
const ITEMS = [
  {
    finding: {
      title: 'Widget leaks', severity: 'Critical', location: 'src/widget.ts:12',
      problem: 'the handle is never released', fix: 'release it on every path',
      gate: 'a regression test that leaks without the fix',
    },
    assessment: { action: 'disputed', status: 'the caller normalizes missing lists' },
    baseline: 'base1234',
  },
  {
    finding: {
      title: 'Widget leaks', severity: 'Important', location: 'src/other.ts:3',
      problem: 'the second finding shares the first one title', fix: 'rename the symbol',
      gate: '',
    },
    assessment: { action: 'fixed', status: 'renamed it' },
    baseline: 'base1234',
  },
]

const BLOCKERS = [{
  id: 'leak-1', kind: 'original-defect', item: 1, location: 'src/widget.ts:12',
  evidence: 'the handle is still leaked on the error path', required: 'the handle is released on every path',
  confidence: 90,
}]
const VERDICTS = [{ index: 1, verdict: 'upheld', confidence: 88, reasoning: 'the repair removes the leak' }]

const CONFLICT_PREP = {
  branch: 'epic/42-widget', mergeBase: 'base1234', prHead: 'head5678',
  markedFiles: ['src/a.ts', 'src/b.ts'],
  report: 'hunk 1 in src/a.ts — needs judgment',
  judgmentHunks: [{
    file: 'src/a.ts', hunk: 1, report: 'needs judgment',
    reason: 'both sides restructured the call', evidence: { ours: 'main text', theirs: 'pr text' },
  }],
  taskDelivery: false,
  partialRecord: null,
  evidence: {
    prSide: 'PR SIDE DIFF', mainSide: 'MAIN SIDE DIFF', mainCommits: 'abc1234 land the timeout',
    prIssue: { issue: 42, title: 'Widget', body: 'Build a widget.', captured: true },
    mainIssueRecords: [{ issue: 7, title: 'Timeout', body: 'Bound the call.', captured: true }],
    omittedMainIssues: 0,
  },
}
const CONFLICT_DISPOSITIONS = [{ index: 1, file: 'src/a.ts', hunk: 1, action: 'repaired', reason: 'both intents survive' }]

const CI_PREP = {
  branch: 'epic/42-widget', failedChecks: ['build', 'lint'],
  localVerify: { green: true, detail: '2 packages, 0 failures' },
  logs: 'JOB LOG TAIL', changeDiff: CHANGE_DIFF, changeStat: ' src/widget.ts | 1 +',
  issueRecord: { issue: 42, title: 'Widget', body: 'Build a widget.', captured: true },
  taskDelivery: false,
}
const CI_DISPOSITIONS = [
  { index: 1, name: 'build', action: 'repaired', reason: 'restored the missing export' },
  { index: 2, name: 'lint', action: 'declined', reason: 'the runner had no credentials' },
]

const DEFECT_EVIDENCE = {
  version: 1, issue: 42,
  pr: { number: 9, url: 'https://github.com/owner/repo/pull/9', branch: 'epic/42-widget', head: 'head5678' },
  requirement: { title: 'Widget', body: 'Build a widget.' },
  blockers: [{ source: 'final-review', reason: 'concrete defect at confidence 90', items: [{ title: 'Leak', why: 'the handle is leaked' }] }],
}
const DEFECT_PREP = {
  branch: 'epic/42-widget', evidence: DEFECT_EVIDENCE,
  evidenceItems: [{ index: 1, title: 'Leak', reason: 'concrete defect at confidence 90' }],
  changeDiff: CHANGE_DIFF, changeStat: ' src/widget.ts | 1 +',
}
const DEFECT_DISPOSITIONS = [{ index: 1, title: 'Leak', action: 'repaired', reason: 'released on every path' }]

const CASES = {
  'epic-architect-design': async () =>
    (await load('epic/architect-design.mjs')).architectDesignPrompt(REQUIREMENT),
  'epic-architect-recover': async () =>
    (await load('epic/architect-recover.mjs')).architectRecoverPrompt(REQUIREMENT, CHANGE_DIFF),
  'epic-architect-partial-uncaptured': async () =>
    (await load('epic/architect-partial.mjs')).architectPartialPrompt(REQUIREMENT, ''),
  'epic-code-red': async () =>
    (await load('epic/code-red.mjs')).codeRedPrompt('.epics/42-widget', REQUIREMENT),
  'epic-code-green': async () =>
    (await load('epic/code-green.mjs')).codeGreenPrompt('.epics/42-widget', REQUIREMENT,
      { testFiles: ['src/widget.test.ts'], expectedFailure: 'missing export createWidget', reason: 'no implementation yet' }),
  'epic-code-direct': async () =>
    (await load('epic/code-direct.mjs')).codeDirectPrompt('.epics/42-widget', REQUIREMENT),
  'epic-review': async () =>
    (await load('epic/review.mjs')).reviewPrompt(REQUIREMENT, CHANGE_DIFF),
  'epic-fix': async () =>
    (await load('epic/fix.mjs')).fixPrompt(ITEMS, REQUIREMENT, CHANGE_DIFF),
  'epic-red-retry': async () =>
    (await load('epic/red-retry.mjs')).redRetryPrompt('verify stayed green (2 packages)'),
  'epic-verify-retry': async () =>
    (await load('epic/verify-retry.mjs')).verifyRetryPrompt({ tail: 'widget.test.ts expected 2 got 1' }),
  'epic-final-review': async () =>
    (await load('epic/final-review.mjs')).finalReviewPrompt(ITEMS, REQUIREMENT, 'REPAIR DELTA', CHANGE_DIFF),
  'epic-final-review-single': async () =>
    (await load('epic/final-review.mjs')).finalReviewPrompt(ITEMS.slice(0, 1), REQUIREMENT, 'REPAIR DELTA', CHANGE_DIFF),
  'epic-correction': async () =>
    (await load('epic/correction.mjs')).correctionPrompt(REQUIREMENT, BLOCKERS, 'REPAIR DELTA', '2 packages, 0 failures'),
  'epic-narrow-confirm': async () =>
    (await load('epic/narrow-confirm.mjs')).narrowConfirmPrompt(REQUIREMENT, BLOCKERS, VERDICTS, 'REPAIR DELTA', 'CORRECTION DELTA'),

  'conflict-resolve': async () =>
    (await load('conflict/resolve.mjs')).resolvePrompt(42, CONFLICT_PREP),
  'conflict-resolve-task': async () =>
    (await load('conflict/resolve.mjs')).resolvePrompt(42, { ...CONFLICT_PREP, taskDelivery: true }),
  'conflict-resolve-partial': async () =>
    (await load('conflict/resolve.mjs')).resolvePrompt(42, { ...CONFLICT_PREP, partialRecord: { head: 'head5678' } }),
  'conflict-resolve-retry': async () =>
    (await load('conflict/resolve-retry.mjs')).resolveRetryPrompt(42, CONFLICT_PREP),
  'conflict-acceptance': async () =>
    (await load('conflict/acceptance.mjs')).acceptancePrompt(42, CONFLICT_PREP, CONFLICT_DISPOSITIONS, 'CUMULATIVE DELTA'),
  'conflict-acceptance-partial': async () =>
    (await load('conflict/acceptance.mjs')).acceptancePrompt(42, { ...CONFLICT_PREP, partialRecord: { head: 'head5678' } }, CONFLICT_DISPOSITIONS, 'CUMULATIVE DELTA'),
  'conflict-correction': async () =>
    (await load('conflict/correction.mjs')).correctionPrompt(42, CONFLICT_PREP, CONFLICT_DISPOSITIONS,
      { blockers: BLOCKERS, cumulative: 'CUMULATIVE DELTA', verified: { detail: '2 packages, 0 failures' } }),
  'conflict-confirm': async () =>
    (await load('conflict/confirm.mjs')).confirmPrompt(42, CONFLICT_PREP,
      { blockers: BLOCKERS, verdicts: VERDICTS, cumulative: 'CUMULATIVE DELTA', correction: 'CORRECTION DELTA' }),
  'conflict-evidence-uncaptured': async () =>
    (await load('conflict/resolve.mjs')).resolvePrompt(42, {
      ...CONFLICT_PREP,
      evidence: { ...CONFLICT_PREP.evidence, prSide: null, mainSide: null, mainCommits: null, mainIssueRecords: [], omittedMainIssues: 2 },
    }),

  'ci-fix-green-local': async () =>
    (await load('ci/fix.mjs')).fixPrompt(42, CI_PREP),
  'ci-fix-red-local': async () =>
    (await load('ci/fix.mjs')).fixPrompt(42, { ...CI_PREP, localVerify: { green: false, detail: '1 package failed' }, logs: '' }),
  'ci-fix-task-delivery': async () =>
    (await load('ci/fix.mjs')).fixPrompt(42, { ...CI_PREP, taskDelivery: true }),
  'ci-fix-unreadable-issue': async () =>
    (await load('ci/fix.mjs')).fixPrompt(42, { ...CI_PREP, issueRecord: { issue: 42, captured: false, error: 'gh timed out' } }),
  'ci-acceptance': async () =>
    (await load('ci/acceptance.mjs')).acceptancePrompt(42, CI_PREP, CI_DISPOSITIONS, 'CUMULATIVE DELTA'),
  'ci-correction': async () =>
    (await load('ci/correction.mjs')).correctionPrompt(42, CI_PREP, CI_DISPOSITIONS,
      { blockers: BLOCKERS, cumulative: 'CUMULATIVE DELTA', verified: { detail: '2 packages, 0 failures' } }),
  'ci-confirm': async () =>
    (await load('ci/confirm.mjs')).confirmPrompt(42, CI_PREP,
      { blockers: BLOCKERS, verdicts: VERDICTS, cumulative: 'CUMULATIVE DELTA', correction: 'CORRECTION DELTA' }),

  'defect-fix': async () =>
    (await load('defect/fix.mjs')).fixPrompt(42, DEFECT_PREP),
  'defect-acceptance': async () =>
    (await load('defect/acceptance.mjs')).acceptancePrompt(42, DEFECT_PREP, DEFECT_DISPOSITIONS, 'CUMULATIVE DELTA'),
  'defect-correction': async () =>
    (await load('defect/correction.mjs')).correctionPrompt(42, DEFECT_PREP, DEFECT_DISPOSITIONS,
      { blockers: BLOCKERS, cumulative: 'CUMULATIVE DELTA', verified: { detail: '2 packages, 0 failures' } }),
  'defect-confirm': async () =>
    (await load('defect/confirm.mjs')).confirmPrompt(42, DEFECT_PREP,
      { blockers: BLOCKERS, verdicts: VERDICTS, cumulative: 'CUMULATIVE DELTA', correction: 'CORRECTION DELTA' }),

  'shared-verification-retry': async () =>
    (await load('shared/verification-retry.mjs')).verificationRetryPrompt({ tail: 'widget.test.ts expected 2 got 1' }),
}

const name = process.argv[2]
const build = CASES[name]
if (!build) {
  process.stderr.write(`unknown case: ${name}\n`)
  process.exit(2)
}
process.stdout.write(await build())
RENDER

render() { ROOT="$ROOT" node "$TMP/render.mjs" "$1"; }

# ───────────────────────── epic prompts ─────────────────────────
section 'epic: the requirement and the captured evidence reach every step'
DESIGN="$(render epic-architect-design)"
assert_contains "the architect gets the captured requirement verbatim" "$DESIGN" "Deliver the widget, and never a bare #number."
assert_not_contains "and no diff it was not given" "$DESIGN" 'diff --git'

RECOVER="$(render epic-architect-recover)"
assert_contains "a recovery reconstructs from the captured implementation" "$RECOVER" '<change-diff>'
assert_contains "which carries the captured bytes" "$RECOVER" 'export const createWidget'
assert_contains "and it still has to return the delivery record" "$RECOVER" 'There is no later prose step'

PARTIAL="$(render epic-architect-partial-uncaptured)"
assert_contains "a capture that failed says so where the model reads it" "$PARTIAL" '(no preserved work was captured)'
assert_contains "and the resume constraint is still stated" "$PARTIAL" 'verification.mode set to direct'

RED="$(render epic-code-red)"
assert_contains "the RED step is pointed at this run's architecture" "$RED" '.epics/42-widget/architecture.md'
assert_contains "and told the orchestrator owns the gate" "$RED" 'Do not run tests or any verification command.'

GREEN="$(render epic-code-green)"
assert_contains "GREEN receives the RED step's own structured result" "$GREEN" '"missing export createWidget"'
assert_contains "and the orchestrator-gate consequence" "$GREEN" 'The orchestrator checkpoints your edits'
assert_contains "and the delivery-record rules" "$GREEN" 'Write `Finding 3`'

DIRECT="$(render epic-code-direct)"
assert_contains "direct mode carries the same gate sentence" "$DIRECT" 'The orchestrator checkpoints your edits'
assert_not_contains "and never mentions a RED step it skipped" "$DIRECT" 'The existing failing tests'

REVIEW="$(render epic-review)"
assert_contains "the reviewer judges the captured diff" "$REVIEW" 'export const createWidget'
assert_contains "against the captured requirement" "$REVIEW" 'Deliver the widget'

FIX="$(render epic-fix)"
assert_contains "the repair numbers finding 1" "$FIX" '--- Finding 1 ---'
assert_contains "and finding 2, whose title is identical" "$FIX" '--- Finding 2 ---'
assert_contains "each with its own location" "$FIX" 'Location: src/other.ts:3'
assert_contains "and one assessment per finding is demanded by count" "$FIX" 'exactly 2 assessments'

RED_RETRY="$(render epic-red-retry)"
assert_contains "the RED retry names the exact rejection" "$RED_RETRY" 'verify stayed green (2 packages)'
assert_eq "and appends to the step's own prompt" "" "$(printf '%s' "$RED_RETRY" | head -c 1)"

VERIFY_RETRY="$(render epic-verify-retry)"
assert_contains "the verify retry carries the captured failure" "$VERIFY_RETRY" 'widget.test.ts expected 2 got 1'
assert_contains "and promises no second one" "$VERIFY_RETRY" 'a second red blocks the run for a human'

FINAL="$(render epic-final-review)"
assert_contains "the final review gets the exact repair delta" "$FINAL" '<repair-delta>'
assert_contains "and the complete change" "$FINAL" '<change-diff>'
assert_contains "and each finding's reported action" "$FINAL" 'Reported action: disputed'
assert_contains "and its baseline" "$FINAL" 'Baseline containing the reported problem: base1234'
assert_not_contains "but never the fixer's explanation" "$FINAL" 'The caller normalizes missing lists'
assert_contains "two findings ask for two verdicts" "$FINAL" 'Return exactly 2 verdicts'
assert_contains "one finding asks for one" "$(render epic-final-review-single)" 'Return exactly 1 verdict,'

CORRECTION="$(render epic-correction)"
assert_contains "the correction is told the tree was green" "$CORRECTION" 'GREEN on it (2 packages, 0 failures)'
assert_contains "and gets the blocker by its run-local id" "$CORRECTION" 'id: leak-1'
assert_contains "with the outcome that clears it" "$CORRECTION" 'required to clear: the handle is released on every path'
assert_contains "bounded to that one blocker" "$CORRECTION" 'Address ONLY the 1 numbered blocker(s) above'

CONFIRM="$(render epic-narrow-confirm)"
assert_contains "the narrow confirmation sees the correction delta" "$CONFIRM" '<correction-delta>'
assert_contains "and what the final review already upheld" "$CONFIRM" 'item 1: upheld (confidence 88)'

# ───────────────────────── conflict prompts ─────────────────────────
section "conflict: one module, both of the step shapes"
RESOLVE="$(render conflict-resolve)"
assert_contains "the ordinary stop is mid-rebase" "$RESOLVE" 'You are mid-rebase'
assert_contains "and names the marked files" "$RESOLVE" 'src/a.ts, src/b.ts'
assert_contains "both sides' captured intent is rendered once" "$RESOLVE" '<pr-side-diff>'
assert_contains "with main's side beside it" "$RESOLVE" 'MAIN SIDE DIFF'
assert_contains "and the issues behind main's commits" "$RESOLVE" 'Issue #7: Timeout'
assert_contains "an epic delivery is described as reviewed" "$RESOLVE" 'independently reviewed and verified by the epic workflow'

RESOLVE_TASK="$(render conflict-resolve-task)"
assert_contains "a task delivery states the intentional omission" "$RESOLVE_TASK" 'intentionally without independent semantic review'
assert_not_contains "and never claims a review it never had" "$RESOLVE_TASK" 'independently reviewed and verified by the epic workflow'

PARTIAL_ROUND="$(render conflict-resolve-partial)"
assert_contains "a granted round works the durable worklist" "$PARTIAL_ROUND" 'Resolve only the judgment hunks a prior verified partial conflict repair declined'
assert_contains "with each prior decline's reason" "$PARTIAL_ROUND" 'prior decline: both sides restructured the call'
assert_contains "and its original diff3 evidence" "$PARTIAL_ROUND" '{"ours":"main text","theirs":"pr text"}'
assert_not_contains "and never claims a rebase is in progress" "$PARTIAL_ROUND" 'You are mid-rebase'

RESOLVE_RETRY="$(render conflict-resolve-retry)"
assert_contains "the resolver retry says the rebase is finished" "$RESOLVE_RETRY" 'there is no rebase in progress'
assert_contains "and re-reads the same captured evidence" "$RESOLVE_RETRY" 'PR SIDE DIFF'

UNCAPTURED="$(render conflict-evidence-uncaptured)"
assert_contains "an uncaptured PR side says so" "$UNCAPTURED" '(the PR-side diff could not be captured)'
assert_contains "an uncaptured main side says so too" "$UNCAPTURED" '(the main-side diff could not be captured)'
assert_contains "and omitted issues are counted, never dropped silently" "$UNCAPTURED" '2 further issue(s) main delivered are not included'

CONFLICT_CHECK="$(render conflict-acceptance)"
assert_contains "the blind check gets the complete delta" "$CONFLICT_CHECK" 'CUMULATIVE DELTA'
assert_contains "and the resolver's indexed claims" "$CONFLICT_CHECK" '1. src/a.ts hunk 1: repaired'
assert_contains "bounded to the marked files" "$CONFLICT_CHECK" 'The permitted boundary is the judgment hunks in src/a.ts, src/b.ts'
assert_contains "and one verdict per claim" "$CONFLICT_CHECK" 'Return one verdict for each of the 1 numbered judgment hunk(s)'
assert_contains "a granted round is checked against prior declines" "$(render conflict-acceptance-partial)" 'The permitted boundary is the numbered prior declines in src/a.ts, src/b.ts'

CONFLICT_CORRECTION="$(render conflict-correction)"
assert_contains "the conflict correction protects both intents" "$CONFLICT_CORRECTION" 'every correction must leave what origin/main meant'
assert_contains "and reads the same captured evidence" "$CONFLICT_CORRECTION" 'MAIN SIDE DIFF'
assert_contains "the conflict confirmation keeps declined hunks exact" "$(render conflict-confirm)" 'must still carry its exact PR-side text'

# ───────────────────────── CI prompts ─────────────────────────
section 'CI: what the local gate said decides the wording'
CI_GREEN="$(render ci-fix-green-local)"
assert_contains "a green local gate is stated with its detail" "$CI_GREEN" 'GREEN locally on this exact tree (2 packages, 0 failures)'
assert_contains "the failed checks are numbered for the record" "$CI_GREEN" '1. build'
assert_contains "and the job logs are pasted in" "$CI_GREEN" 'JOB LOG TAIL'
assert_contains "with the requirement the PR was built against" "$CI_GREEN" 'Build a widget.'

CI_RED="$(render ci-fix-red-local)"
assert_contains "a red local gate says the failure reproduces" "$CI_RED" 'RED locally on this exact tree too (1 package failed)'
assert_contains "and missing logs say so rather than looking empty" "$CI_RED" 'No job logs could be retrieved'

assert_contains "a task-delivered PR states the intentional omission" "$(render ci-fix-task-delivery)" 'intentionally without independent semantic review'
assert_contains "an unreadable issue is unknown, not empty" "$(render ci-fix-unreadable-issue)" 'could not be read (gh timed out) — its intent is unknown, not empty.'

CI_CHECK="$(render ci-acceptance)"
assert_contains "the CI check reads the same requirement bytes" "$CI_CHECK" 'Build a widget.'
assert_contains "and every indexed claim, declines included" "$CI_CHECK" '2. lint: declined — the runner had no credentials'
assert_contains "bounded to the captured failing checks" "$CI_CHECK" 'The permitted boundary is the captured failing checks and nothing else.'

assert_contains "the CI correction is still a bounded CI repair" "$(render ci-correction)" 'this is still a bounded CI repair'
assert_contains "the CI confirmation proves the batch and nothing else" "$(render ci-confirm)" 'Prove exactly four things about the correction delta'

# ───────────────────────── defect prompts ─────────────────────────
section 'defect: the authenticated evidence is the whole brief'
DEFECT_FIX="$(render defect-fix)"
assert_contains "the pinned requirement comes from the envelope" "$DEFECT_FIX" 'never re-read the mutable issue body'
assert_contains "the named defects are numbered" "$DEFECT_FIX" '1. Leak — concrete defect at confidence 90'
assert_contains "and the reviewed change is captured, not fetched" "$DEFECT_FIX" 'do not run Git for it'

DEFECT_CHECK="$(render defect-acceptance)"
assert_contains "the defect check is blind to the fixer's account" "$DEFECT_CHECK" "The fixer's explanation is deliberately withheld"
assert_contains "and bound to the authenticated evidence" "$DEFECT_CHECK" 'The permitted boundary is the defects named by the authenticated evidence above'
assert_contains "the defect correction may not reclassify a defect" "$(render defect-correction)" 'never reclassify or dismiss a named defect'
assert_contains "the defect confirmation refutes a weakened gate" "$(render defect-confirm)" 'by reclassifying a named defect rather than repairing it, is a refutation'

section 'shared: one wording for every fixer verification retry'
SHARED_RETRY="$(render shared-verification-retry)"
assert_contains "it carries the captured diagnostics" "$SHARED_RETRY" 'widget.test.ts expected 2 got 1'
assert_contains "and bounds itself at one" "$SHARED_RETRY" 'This is the one verification-driven repair retry in this run'

# ───────────────────────── the split itself ─────────────────────────
section 'prompt modules build strings and nothing else'
MODULES="$(find "$ROOT/workflows/prompts" -name '*.mjs' | sort)"
assert_eq "every pipeline has its prompt directory" \
  "ci conflict defect epic shared" \
  "$(find "$ROOT/workflows/prompts" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort | tr '\n' ' ' | sed 's/ $//')"

BAD_IMPORTS=""
MULTI_PROMPT=""
for module in $MODULES; do
  if grep -Eq "^import .*(node:child_process|node:fs|node:process|lib/(runtime|repo|github|proc|engine|cli|status|usage)\.mjs)" "$module"; then
    BAD_IMPORTS="$BAD_IMPORTS $module"
  fi
  case "$module" in
    */shared.mjs|*/evidence.mjs) ;;
    *) [[ "$(grep -c '^export const .*Prompt = ' "$module")" == "1" ]] || MULTI_PROMPT="$MULTI_PROMPT $module" ;;
  esac
done
assert_eq "no prompt module imports transport, the filesystem or a process" "" "$BAD_IMPORTS"
assert_eq "each prompt module exports exactly one builder" "" "$MULTI_PROMPT"

for pipeline in epic:epic-run conflict:fix-run ci:ci-run defect:defect-run; do
  dir="${pipeline%%:*}"
  script="$ROOT/workflows/${pipeline##*:}.mjs"
  assert_eq "${pipeline##*:} keeps no inline prompt table" "0" "$(grep -c '^const PROMPTS = {' "$script")"
  assert_contains "${pipeline##*:} imports its builders" "$(cat "$script")" "from './prompts/$dir/"
done
assert_contains "the shared fixer retry is imported, not inlined" "$(cat "$ROOT/workflows/lib/fixer-lifecycle.mjs")" \
  "from '../prompts/shared/verification-retry.mjs'"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
