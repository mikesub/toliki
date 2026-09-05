#!/usr/bin/env node
// epic-run — autonomous issue-to-PR delivery: prepare → architect → code →
// review → fixes after review → ship, no sign-offs.
//
// Issue mode (`--issue N`): preflight (closed? blocked_by?) → branch
// epic/<N>-<slug> off origin/main and claim it by pushing the ref (atomic; a
// run that loses the race skips), resuming an existing branch when one is left
// over — and skipping completed code when that branch already carries a code
// checkpoint (recovering its structured review plan when needed) → checkpoint commits after code/fixes → squashed single-commit PR at
// ship + blocker-comment → merge gate labels the issue ready-to-merge when
// nothing was deferred, or ready-to-review when the PR is held; a hold made
// exclusively of concrete defects also enters the separate bounded fixer queue.
// Manual mode (`--slug S`): builds on the current tree, no git; needs
// .epics/<slug>/requirements.md to already exist.
//
// The run never merges: bin/merge-worker.sh drains ready-to-merge serially per
// repo. Each model step below is one engine process (see lib/engine.mjs); this
// file names no vendor. Everything deterministic — git, gh, npm, the layout
// discovery, the artifacts rendered from structured output — runs here in the
// orchestrator through lib/github.mjs and lib/repo.mjs, so a claim, a label, a
// checkpoint or an open PR is a fact the script established, never a claim a
// model reported. A model runs only where a judgment is needed: design, code,
// the independent reviewer(s) and their skeptic, the fixes, and what the PR says.
//
// `npm run verify` is likewise the orchestrator's to run. Test-first plans
// require a clean baseline, a meaningful red regression, then green; direct
// plans skip artificial RED but still require green after implementation.
// After fixes it must be green too. An agent's word that it ran a gate is
// never the gate; a wrong answer is handed back once, then blocks the run.
//
// The fixes themselves get one skeptic pass (fix-check) over exactly the
// delta they produced. A fix the skeptic cannot confirm, a regression, a dead
// check or a claimed fix with no diff holds the PR at ready-to-review; none
// starts a second round inside this epic. Concrete defect-only holds may be
// repaired later by defect-run under its independent label-bounded ladder.
//
// Ship's deferrals go through the same skeptic before the merge gate counts
// them: every item ship did not call a defect is re-judged, and the skeptic
// can only escalate. The builder side never has the last word on whether a
// deferred item is a defect.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { agent, parallel, phase, log, initRuntime, onPhase, onLog, withAgentFailure } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { failureReason, must } from './lib/proc.mjs'
import { validate } from './lib/schema.mjs'
import {
  ensureLabels, editLabels, issueLabels, issueView, openBlockers, comment, assignSelf,
  openPrs, searchOpenPrs, prCreate, issueCreate, withBodyFile, hasDeferredRecord, issueId, addBlockedBy,
  authenticatedLogin, terminalBudget, terminalSpend, terminalTransition,
} from './lib/github.mjs'
import { matchingDefectEvidence, renderDefectEvidence } from './lib/defect-evidence.mjs'
import {
  git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, ensureEpicsIgnored, checkpoint, intentToAdd,
  pushRejected, slugify, epicDir, writeRequirements, readRequirements, initEpicMd, updateEpicMd,
  renderArchitecture, renderReview,
} from './lib/repo.mjs'

const USAGE = `Usage: epic-run.mjs (--issue <N> | --slug <slug>) [--session <name>] [--engine <name>]

  --issue <N>    GitHub issue to build: branch, implement, review, open a PR
  --slug <slug>  manual mode: build on the current tree from an existing
                 .epics/<slug>/requirements.md, no git and no PR
  --session      name for log lines (the tmux session bin/launch.sh created)
  --engine       registered coding-agent engine for every phase

Exit: 0 shipped or held for review, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

// ───────────────────────── Prompts ─────────────────────────
// One template per MODEL step. Anything a script can do is not here — see the
// Transport section below.
const PROMPTS = {
  architectDesign: (dir) =>
`Read ${dir}/requirements.md and design the implementation approach for it. It goes straight to implementation.

Ground the design in the real codebase: find how similar features here are already built and reuse their module boundaries, abstractions, and helpers. Default to the pragmatic path that fits existing patterns; introduce a new abstraction only when the requirements make its longevity worth the cost, and say so explicitly when you do.
Keep obvious changes short; detail only the real implementation decisions and risks rather than filling every field with speculative machinery.

Your output is schema-enforced JSON — populate every field, do not cram everything into one:
- approach: a SHORT name for the design (3-6 words), used as its audit label.
- rationale: a concise justification; one sentence is enough for an obvious change, with more detail only for real decisions or risks.
- steps: only the ordered work needed (one string per step); one step is enough for an obvious edit.
- files: files to create or modify (one per string, with a few words on what changes).
- contract: the observable behavior or existing contract to preserve, explicit enough to verify without seeing the implementation. Say when no public API changes.
- tradeoffs: what this approach deliberately accepts; say none when there is no meaningful trade-off.
- verification: choose the lightest strategy that gives convincing evidence, respecting explicit project testing rules. Prefer direct for small, low-risk edits and changes adequately proved by existing checks or tests added alongside implementation. Choose test-first when a meaningful failing regression before implementation materially improves confidence in new behavior, a bug fix, or a risky contract, not merely because writing one is possible. Give a non-empty rationale and concrete evidence the completed implementation must provide. Direct still adds/updates tests when meaningful and always goes through the project's verify gate.
- review: one concrete, change-specific question for a focused second reviewer when substantial authorization, data-integrity, concurrency, or similar narrow high-impact risk exists. Otherwise use an empty question; the broad reviewer still runs. Explain the choice either way.`,

  architectRecover: (dir, diffCmd) =>
`A previous run completed implementation and left a code checkpoint, but its structured architecture artifact is missing or invalid. Reconstruct the plan for review and audit only; do NOT edit files or replay implementation.

Read ${dir}/requirements.md and inspect the existing implementation with \`${diffCmd}\`. Return schema-enforced JSON with approach, rationale, ordered steps, files, public contract, tradeoffs, verification, and review. Verification must contain mode (test-first or direct), a non-empty rationale, and a non-empty evidence array describing what proves this completed implementation. Review must contain a question and rationale: ask one concrete risk question for substantial authorization/data/concurrency risk, otherwise use an empty question and explain why broad review is sufficient. Describe what the checkpoint actually implemented; keep an obvious change short.`,

  architectPartial: (dir, diffCmd) =>
`This branch resumes work preserved from an interrupted coding phase. Read ${dir}/requirements.md and inspect both the source tree and \`${diffCmd}\`; design the smallest coherent continuation without deleting or restarting existing work. Return the same schema-enforced fields as a fresh design. Set verification.mode to direct because a fresh clean RED baseline no longer exists; the completed continuation still needs concrete non-empty evidence and the orchestrator's full verify gate. Record that resume constraint in the verification rationale. Plan the optional focused review normally.`,

  codeRed: (dir) =>
`Code phase, RED step. Write tests ONLY (no implementation). Read ${dir}/requirements.md and ${dir}/architecture.md, and derive tests from the requirements + the public contract/API surface. Cover what is genuinely testable in this stack (units, pure logic, backend handlers, frontend component behavior); for hard-to-test surfaces (canvas/visual, external I/O), SKIP and note in ${dir}/epic.md what is uncovered and why — do not fake a test.
Return structured testFiles, the exact distinctive assertion-failure excerpt you observed as expectedFailure, and why that failure demonstrates the missing required behavior. A typo, missing import, infrastructure error, timeout, or unrelated failure is not valid RED. The pipeline then runs \`npm run verify\` itself and requires that excerpt in its own failure output.`,

  codeGreen: (dir, red, pkgs) =>
`Code phase, GREEN step. Read ${dir}/architecture.md and ${dir}/requirements.md and the existing failing tests:
${JSON.stringify(red, null, 2)}

Implement the feature to make those tests pass, following architecture.md's build steps. Note any scope decision or wrong-test fix in ${dir}/epic.md's phase log. Run \`npm run verify\` in EACH touched package (this repo's packages: ${pkgs}) until green — that script is the project's whole gate, so whatever it runs (including any real-database tier it triggers for itself) has to be green, not just the unit tests.
Leave everything in the working tree: do NOT commit or push; the pipeline checkpoints your work itself, and re-runs \`npm run verify\` after you return — a red run comes back to you once, then blocks the run. Return a short status: packages verified green, and any in-flight decisions or remaining failures you could not resolve.`,

  codeDirect: (dir, pkgs) =>
`Code phase, direct implementation. Read ${dir}/requirements.md and ${dir}/architecture.md, then implement the feature in one coherent pass. Add or update tests where they meaningfully prove the architecture's verification evidence; do not manufacture a test for an untestable surface.

Follow the architecture while preserving its requirement and public contract. If a codebase fact makes a planned detail wrong or impractical, make the smallest justified adjustment and record it in ${dir}/epic.md's phase log. Run \`npm run verify\` in EACH touched package (this repo's packages: ${pkgs}) until green.
Leave everything in the working tree: do NOT commit or push; the pipeline checkpoints your work itself and re-runs verify after you return. Return a short status including evidence produced, tests added or updated, justified plan adjustments, and remaining failures.`,

  review: (requirement, reviewer, diffCmd) =>
`${reviewer.question
    ? `Answer this concrete review question: ${reviewer.question}\nStay narrow: investigate this risk deeply, and report other issues only when they are necessary evidence for your answer. Do not repeat a general review of the whole change.`
    : 'Independently review this change for requirements coverage, meaningful defects or regressions, and whether the verification adequately proves the changed behavior. Prioritize concrete consequences over stylistic preferences.'}

Requirement to judge against — this is the ONLY spec context you get; reconstruct expected behavior from it + the diff alone:
"""
${requirement}
"""

Read \`${diffCmd}\` / \`${diffCmd} --stat\` and the source tree to judge the change. Do NOT open ANY file under \`.epics/\` — architecture.md, epic.md, review.md and summary.md all encode the builder's intended behavior and would anchor you; you have the requirement above and do not need that directory.
If nothing meets your confidence bar, return an empty findings array.`,

  verify: (findings, requirement, diffCmd) =>
`Adversarially verify ${findings.length === 1 ? 'a code-review finding' : `${findings.length} code-review findings reported against this change`}. Default to refuting each unless the code clearly bears it out.

${findings.map((f, i) => `--- Finding ${i + 1} ---
Title: ${f.title}
Severity: ${f.severity}
Location: ${f.location}
Claim: ${f.problem}`).join('\n\n')}

Original requirement the change must satisfy:
"""
${requirement}
"""

Read the relevant code and \`${diffCmd}\`. Do NOT open anything under \`.epics/\` — it carries the builder's intent and would anchor you. For each finding, determine whether the claim genuinely holds (real) or is a false positive / already handled (not real). Set real=false if you cannot confirm it against the actual code.

Return exactly ${findings.length} verdict${findings.length === 1 ? '' : 's'} — one per finding — with \`index\` set to that finding's number above (${findings.length === 1 ? '1' : `1-${findings.length}`}).${findings.length > 1 ? `

Several may be one defect restated in different words, often pointing at DIFFERENT files (the component, the gate that guards it, its test, the doc describing it). Judge each on its own merits: if two are the same defect, set \`sameDefectAs\` on the LATER one to the earlier one's number and let them stand or fall together — do NOT mark one not-real merely because it overlaps another. Group only findings ONE fix would genuinely resolve together; two distinct bugs that happen to sit in the same function are NOT the same defect.` : ''}`,

  triage: (dir, pkgs, grouping) =>
`Fixes-after-review phase, autonomous (NO user sign-off). Read ${dir}/requirements.md, ${dir}/review.md and the diff. Apply the smallest correct repair for the CONFIRMED findings only, highest severity first — NEVER act on anything under "## Unconfirmed — not fixed" (those were refuted; they are listed for human eyes only). Add or update a regression check when it meaningfully protects the affected behavior. Follow the project's own explicit verification rules.
Keep the repair proportional to the defect. A finding does not require a new abstraction, shared helper, lint rule or project instruction: introduce one only when necessary for this repair. Do not turn a local fix into prevention of an entire class of hypothetical problems. If a necessary repair changes a documented contract, update the relevant project instructions or documentation in their existing voice. Shared harness skills, agents and pipeline files outside this project remain out of scope; never edit or recreate them. Record material decisions and any concrete work left undone in ${dir}/epic.md's phase log, without inventing hardening work to justify a follow-up.
If a finding is genuinely too risky or expensive to fix safely without a human decision, DO NOT guess — leave it, and record it as deferred (with why) in ${dir}/epic.md's phase log so the summary surfaces it.
${grouping}After fixes, re-run \`npm run verify\` in each touched package (this repo's packages: ${pkgs}) until green.
Leave everything in the working tree: do NOT commit or push; the pipeline checkpoints your work itself, and re-runs \`npm run verify\` after you return — a red run comes back to you once, then blocks the run. Return:
- status: a short summary — which findings were fixed, which were deferred and why, and the final verify result.
- deferred: one entry per CONFIRMED finding you did NOT fix; empty array when you fixed them all. This list is a MERGE GATE: an empty list queues the PR to be merged to main unattended, so omitting something you left unfixed ships it. Report every one.`,

  // Appended to a step's own prompt when the orchestrator's verify run disagreed with it.
  redRetry: (gate) =>
`

The pipeline rejected your previous RED step: ${gate}. This is your one retry. Rewrite the tests so the project's verify command fails on a distinctive unmet assertion against the public contract in architecture.md, then return that exact observed assertion excerpt. Do not use an import error, timeout, infrastructure failure, or unrelated failure.`,

  verifyRetry: (gate) =>
`

The pipeline ran \`npm run verify\` after your previous attempt and it is RED. This is your one retry; a second red blocks the run for a human.
${gate.tail}
Fix the cause — never by weakening, skipping or deleting a test — and leave every package's verify green.`,

  // The merge gate's other input, re-judged: ship classified its deferrals, and only items it called
  // defects hold the PR. The skeptic re-judges the rest and can only escalate.
  deferralCheck: (items, requirement, diffCmd) =>
`Check the deferrals an automated ship step classified — you did not write them. The PR for the requirement below is complete and verified; ship listed the work it left undone and classed each item. Only items classed as a DEFECT hold the PR for a human; everything else lets it merge unattended. Ship did NOT class these ${items.length} item(s) as defects:

${items.map((d, i) => `--- Item ${i + 1} ---
Title: ${d.title}
Why deferred: ${d.why}
Ship's class: ${d.kind}`).join('\n\n')}

Requirement the PR was built against:
"""
${requirement}
"""

Refute each classification. Read \`${diffCmd}\` and the source tree; do NOT open anything under \`.epics/\` — it carries the builder's framing and would anchor you. An item is a defect when a correctness, security, data-loss or user-visible breakage bug will exist on main AFTER this PR merges — whether this diff introduced it, exposed it, or left it in place while claiming the requirement is met. A missing automated check, a scope cut the requirement allows, a nice-to-have or a refactor idea is not a defect. Say defect=true only when the code and the requirement bear it out at confidence 75 or above; otherwise defect=false.

Return exactly ${items.length} verdict${items.length === 1 ? '' : 's'} with \`index\` set to the item's number above.`,

  // Refute-by-default over the fix delta: the same adversarial shape as the review verify, aimed at
  // the one diff no reviewer has seen.
  fixCheck: (fixed, requirement, deltaCmd, diffCmd) =>
`Check the fixes applied after review — you did not write them. An automated fixes-after-review step edited the change after independent review; its edits are exactly \`${deltaCmd}\` (also readable with --stat), applied on top of the reviewed change \`${diffCmd}\`. ${fixed.length ? `It reports these ${fixed.length} confirmed review finding(s) as FIXED:` : 'It reports no finding as fixed; check its edits for regressions only.'}

${fixed.map((f, i) => `--- Finding ${i + 1} ---
Title: ${f.title}
Severity: ${f.severity}
Location: ${f.location}
Claim: ${f.problem}
Recommended fix: ${f.fix}`).join('\n\n')}

Original requirement the change and its fixes must satisfy:
"""
${requirement}
"""

Two questions, refute-by-default:
1. For each finding above: does the delta genuinely remove the defect? resolved=true only if the code now behaves correctly for the case the finding names. A test weakened, skipped or deleted so the finding no longer shows is NOT a fix, and neither is a comment or a suppression. resolved=false whenever you cannot confirm it against the code.
2. Regressions: any defect the delta introduces that the reviewed change did not have — a behavior change outside the finding's scope, a dropped side effect, a broken neighbour, a new null path. Same bar as a review finding: report only what you are at least 75 confident of, with file:line, the problem, a concrete fix and useful targeted regression evidence (or why no meaningful automated check exists).

Do NOT open anything under \`.epics/\` — it carries the builder's and the fixer's framing and would anchor you.
Return exactly ${fixed.length} verdict${fixed.length === 1 ? '' : 's'}${fixed.length ? `, with \`index\` set to the finding's number above (${fixed.length === 1 ? '1' : `1-${fixed.length}`})` : ''}, and a regressions array (empty when none).`,

  // Judgment only: what the PR says, what was left undone and how each item is
  // classed. The pipeline squashes, pushes, opens the PR, files the follow-ups
  // and labels the issue from the JSON — and counts the merge gate from `kind`.
  ship: (dir, issue, design, triageStatus, tally) =>
`Ship phase, autonomous. The work is complete and verified. You decide what the PR says and what was left undone; the pipeline then squashes, pushes, opens the PR, records deferrals on the issue and labels it from what you return. Run NO git or gh commands.

Your output is schema-enforced JSON:

1. title: the PR title, also the squashed commit's subject line (one line, imperative, ≤ 72 chars).
2. body: the PR body, in markdown — keep it about THIS diff, not future work. Do NOT include a files-modified/diff-stat listing or a verification/test-results section; the PR's Files tab and checks already show both. Capture, against ${dir}/requirements.md: what was built; the architecture approach — "${design?.approach}": ${design?.rationale}; review outcome — OPEN that section with this tally verbatim: "${tally}", then the findings that survived verification and which were fixed (review.md's "Unconfirmed — not fixed" findings were refuted, not deferred: leave them out, but keep the refuted COUNT in the tally). Do NOT enumerate deferred/out-of-scope work in the body, and do NOT write a "Closes #${issue}" line: the pipeline appends both a pointer to the issue's deferred record and the Closes line.
   **Never write a bare \`#<number>\` for anything except issue #${issue} itself.** GitHub turns every \`#N\` into a live cross-reference and renders it as that issue or PR's TITLE, so numbering findings \`#1\`, \`#2\`, \`#3\` splices the titles of three unrelated PRs into your sentences and notifies them. Refer to a finding as \`Finding 3\`, or just lead with what it was; the same goes for hunks, steps, requirements and packages, in every field you return. Fixes-after-review status: ${triageStatus}
3. commitBody: a short commit body (the why and notable details), or an empty string.
4. legalMarker: apply THIS project's own legal/compliance review trigger, if it has one: look in its AGENTS.md for a section defining when a change needs legal or policy review. If one exists, judge this diff against the criteria written there — not against any you remember from elsewhere — and when they are met, return the exact marker string that section specifies; the pipeline adds it to the commit body and the PR body. If the project defines no such trigger, or the criteria are not met, omit the field: do NOT invent criteria and do NOT import another project's.
5. deferred: everything deferred or out of scope, one entry each; empty array when nothing was. Read ${dir}/epic.md's phase log and ${dir}/review.md (confirmed sections only — refuted "Unconfirmed" findings are NOT deferred work; a "Post-fix check" section, when present, lists fixes the check could not confirm and regressions it found, and every one of those IS deferred work — a regression is a defect) and collect: deferred review findings (with why), scope cut, edge cases intentionally skipped, clarifying answers that narrowed scope, uncovered test surfaces. For each entry:
   - title and why: one line each.
   - kind, judged honestly, because it drives a MERGE GATE:
     defect — a correctness, security, data-loss, or user-visible breakage bug that still exists on main AFTER this merges, whether this diff introduced it or merely exposed it. One defect holds the PR open for a human; none lets it merge unattended. A missing gate, a scope cut, a nice-to-have or a refactor idea is NOT a defect and must not inflate the count, and a real defect must not be relabelled to keep the merge: an independent check re-judges every item you do not call a defect, and its verdict wins.
     missing-gate — an automated check whose absence let a class of bug through, that could not be added inside this diff.
     scope-cut — a requirement stated in ${dir}/requirements.md that was deliberately not delivered.
     other — everything else: refactor and consolidation ideas, nice-to-haves, cosmetic nits, rare edge-case tests, uncovered surfaces with no known defect behind them, follow-up verification or eval runs (if a run is needed to trust THIS diff it is a blocker on this epic, not a deferral), and anything whose value depends on a diff that main will move past within days.
   - file: whether it earns a follow-up issue. File concrete, materially useful work that needs its own durable issue after this one closes. true ONLY if the kind is defect, missing-gate or scope-cut AND it passes the slicing test: could ONE coherent PR close it and still mean something on its own? Its body must define the observable result, why it matters and what completes it. "Decide whether to X", "consider Y", "investigate Z" all FAIL — a question is not a mergeable change. Do not file speculative hardening, optional abstractions, already repaired findings, or accepted design choices merely because more work is possible. Filing no follow-ups is a normal successful outcome. The cap of 3 is a ceiling, never a target; defects take priority. Filing a follow-up does not resolve a blocker in this PR or make an unmet requirement complete.
   - issueTitle and issueBody, for file=true: a clear title and a self-contained definition of done, including what it is and why it was deferred. The pipeline appends the \`Follow-up to #${issue}\` line, records the dependency on this issue, and then queues the follow-up with \`ready\` when ordering succeeds.`,

  summaryManual: (dir, design, triageStatus) =>
`Write the run's summary and return it in the "summary" field, as markdown. This is the manual flow — do NOT commit, push, or open a PR; leave all changes in the working tree.
Capture, against ${dir}/requirements.md: what was built; the architecture approach — "${design?.approach}": ${design?.rationale}; files modified (\`git diff --stat\`); verify status per package; review outcome (findings that survived verification, which were fixed, which were DEFERRED and why — read ${dir}/review.md and ${dir}/epic.md); anything deferred or out of scope; a suggested next step. Fixes-after-review status: ${triageStatus}`,
}

// ───────────────────────── Config ─────────────────────────
// Every agent() call below names one STEP (lib/engine.mjs STEPS); which vendor, model and effort runs it is
// that step's row in the run's engine in etc/engines.json (--engine, or the issue's engine:<name> label).
// What a row is written against:
// architect — designs the epic in one pass. It is the one step that fixes the shape of everything downstream
// (coding and verification follow that contract), so a weak call here is the most expensive kind.
// code — red, green or direct, and ship's judgment half (what the PR says, what was deferred and of what kind, the
// project's own legal trigger). Ship's `kind` per deferral feeds the merge gate, which is why it is not a
// cheaper row.
// confirm-review — the adversarial verifier is the last judgment before fixes-after-review AUTO-APPLIES a fix
// with no human sign-off, so a wrong "real" here becomes a committed change and a wrong "not real" buries a
// live bug. It runs once per batch (a handful of spawns), not once per reviewer, which is what makes
// upgrading it cheap.
// review — one independent general review is mandatory. The architect may request one additional focused
// review for a concrete risk that merits a second pair of eyes; the orchestrator hard-bounds this at two.

// This pipeline used to run its own real-database gate: an agent listed the changed paths, the script
// path-matched them, and a second agent ran the project's `test:db` suite. That whole tier is gone — the
// real-DB check now lives inside each project's `npm run verify`, triggered by a bash gate in the repo
// that diffs the paths itself. It is strictly better there: no agent in the loop to misjudge or misreport
// it, and CI runs `verify` too, so it also covers manual commits to main — which an in-pipeline gate could
// never reach. "verify green" now IMPLIES the real tier ran wherever it was needed, which is why nothing
// downstream attests to it separately.

const reviewPlan = design => {
  const focused = String(design?.review?.question || '').trim()
  return [
    { label: 'review:general', question: '', rationale: '' },
    ...(focused ? [{ label: 'review:focus', question: focused, rationale: String(design.review.rationale || '').trim() }] : []),
  ]
}

// ───────────────────────── Schemas ─────────────────────────
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approach', 'rationale', 'steps', 'files', 'contract', 'tradeoffs', 'verification', 'review'],
  properties: {
    approach: { type: 'string', description: 'SHORT name for the design (3-6 words), used as its audit label' },
    rationale: { type: 'string', description: 'concise justification, one sentence for an obvious change; more detail only for real decisions or risks' },
    steps: { type: 'array', items: { type: 'string' }, description: 'only the ordered work needed; one step is enough for an obvious edit' },
    files: { type: 'array', items: { type: 'string' }, description: 'files to create/modify, each with a few words on what changes' },
    contract: { type: 'string', description: 'observable behavior or existing contract to preserve, explicit enough to verify without the implementation' },
    tradeoffs: { type: 'string', description: 'what this approach deliberately accepts' },
    verification: {
      type: 'object', additionalProperties: false, required: ['mode', 'rationale', 'evidence'],
      properties: {
        mode: { enum: ['test-first', 'direct'] },
        rationale: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' } },
      },
    },
    review: {
      type: 'object', additionalProperties: false, required: ['question', 'rationale'],
      properties: { question: { type: 'string' }, rationale: { type: 'string' } },
    },
  },
}
const RED_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['testFiles', 'expectedFailure', 'reason'],
  properties: {
    testFiles: { type: 'array', items: { type: 'string' } },
    expectedFailure: { type: 'string', description: 'exact distinctive assertion-failure excerpt observed by the agent' },
    reason: { type: 'string', description: 'why the assertion demonstrates missing required behavior' },
  },
}

const nonblank = value => typeof value === 'string' && value.trim().length > 0
const matchesSchema = (schema, value) => {
  try { return validate(schema, value).length === 0 } catch { return false }
}
const validDesign = d => matchesSchema(DESIGN_SCHEMA, d) &&
  nonblank(d.approach) && nonblank(d.rationale) && Array.isArray(d.steps) && Array.isArray(d.files) &&
  nonblank(d.contract) && nonblank(d.tradeoffs) &&
  ['test-first', 'direct'].includes(d.verification?.mode) && nonblank(d.verification?.rationale) &&
  Array.isArray(d.verification?.evidence) && d.verification.evidence.length > 0 && d.verification.evidence.every(nonblank) &&
  typeof d.review?.question === 'string' && nonblank(d.review?.rationale)

const validRed = red => !!red && Array.isArray(red.testFiles) && red.testFiles.length > 0 &&
  red.testFiles.every(nonblank) && nonblank(red.expectedFailure) && red.expectedFailure.trim().length >= 8 && nonblank(red.reason)

const provesExpectedRed = (gate, red) => !gate.green && gate.failures?.length > 0 &&
  gate.failures.every(f => !f.timedOut && !f.spawnError && Number.isInteger(f.code) && f.code !== 0) &&
  gate.failures.some(f => f.output.includes(red.expectedFailure.trim()))
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'confidence', 'location', 'problem', 'fix', 'gate'],
        properties: {
          title: { type: 'string' },
          severity: { enum: ['Critical', 'Important'] },
          confidence: { type: 'number', description: '0-100' },
          location: { type: 'string', description: 'file:line (for an unmet requirement: the file where it should live, or the requirement itself)' },
          problem: { type: 'string', description: 'the behavior or guideline it breaks' },
          fix: { type: 'string', description: 'concrete fix' },
          gate: { type: 'string', description: 'useful targeted regression evidence for this defect, or empty when no automated check is meaningful' },
        },
      },
    },
  },
}
// One verify agent covers every finding in a batch, so verdicts come back as an array keyed by the
// finding's 1-based number in the prompt. A missing/extra entry is handled at the call site (fail-closed
// to unconfirmed) rather than trusted, since one batch carries several findings.
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'Exactly one entry per finding listed in the prompt, in that order',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'real', 'confidence', 'reasoning'],
        properties: {
          index: { type: 'number', description: '1-based number of the finding this verdict judges' },
          real: { type: 'boolean', description: 'true only if the finding genuinely holds against the code' },
          confidence: { type: 'number', description: '0-100' },
          reasoning: { type: 'string' },
          sameDefectAs: {
            type: 'number',
            description: 'OPTIONAL. When this finding is the SAME underlying defect as an earlier finding in this batch — one fix resolves both — the 1-based index of that earlier finding. Omit when the finding stands on its own. Never point forward or at itself.',
          },
        },
      },
    },
  },
}
const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'deferred'],
  properties: {
    status: { type: 'string', description: 'short summary: what was fixed, what was deferred and why, final verify result. Ship copies this into the PR body, so never write a bare #<number> in it — GitHub renders every #N as another issue/PR\'s title. Say "Finding 3", not "#3".' },
    deferred: {
      type: 'array',
      description: 'one entry per CONFIRMED finding left unfixed; empty when all were fixed (an empty list is what lets the PR be queued for unattended merge)',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'severity', 'why'],
        properties: {
          title: { type: 'string' },
          severity: { enum: ['Critical', 'Important'] },
          why: { type: 'string', description: 'why it was left for a human' },
        },
      },
    },
  },
}
// One verdict per finding the fixer reported fixed, plus any defect the fix delta introduced. A
// regression carries the same fields as a review finding so review.md and the gate can treat it as one.
const FIXCHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts', 'regressions'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'exactly one entry per finding listed in the prompt, in that order',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'resolved', 'confidence', 'reasoning'],
        properties: {
          index: { type: 'number', description: '1-based number of the finding this verdict judges' },
          resolved: { type: 'boolean', description: 'true only if the delta genuinely removes the defect' },
          confidence: { type: 'number', description: '0-100' },
          reasoning: { type: 'string' },
        },
      },
    },
    regressions: {
      type: 'array',
      description: 'defects the fix delta introduced; empty when none',
      items: FINDINGS_SCHEMA.properties.findings.items,
    },
  },
}
const DEFERRAL_CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'exactly one entry per item listed in the prompt, in that order',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'defect', 'confidence', 'reasoning'],
        properties: {
          index: { type: 'number', description: '1-based number of the item this verdict judges' },
          defect: { type: 'boolean', description: 'true only if a bug will exist on main after this merge' },
          confidence: { type: 'number', description: '0-100' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
}
// Ship returns judgment only. `kind` is what the merge gate counts; `file` is
// honoured only for the kinds that can earn an issue, and capped in code.
const SHIP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'body', 'commitBody', 'deferred'],
  properties: {
    title: { type: 'string', description: 'PR title and squashed-commit subject, one line' },
    body: { type: 'string', description: 'PR body markdown; no bare #N except this issue; no Closes line' },
    commitBody: { type: 'string', description: 'short commit body; empty string when none' },
    legalMarker: { type: 'string', description: "the project's own legal-review marker, only when its AGENTS.md defines one and the criteria are met" },
    deferred: {
      type: 'array',
      description: 'everything deferred or out of scope; empty when nothing was',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'why', 'kind', 'file'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' },
          kind: { enum: ['defect', 'missing-gate', 'scope-cut', 'other'], description: 'defect = a bug still on main after this merges (holds the merge); see the prompt' },
          file: { type: 'boolean', description: 'true only when the kind qualifies and one coherent PR could close it' },
          issueTitle: { type: 'string', description: 'for file=true' },
          issueBody: { type: 'string', description: 'for file=true: what and why deferred' },
        },
      },
    },
  },
}
const SUMMARY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary'],
  properties: { summary: { type: 'string', description: 'the run summary, markdown' } },
}

// ───────────────────────── Args & mode ─────────────────────────
// Issue mode (--issue N): self-contained — branch, build, ship a PR, or post a blocker comment.
// Slug mode (--slug S): manual — build on the current tree from an existing requirements.md, no git.
let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { allowSlug: true, usage: USAGE })
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write((e.message ? `epic-run: ${e.message}\n\n` : '') + e.usage + '\n')
    process.exit(e.message ? EXIT.ERROR : EXIT.OK)
  }
  throw e
}
initRuntime({ scriptName: 'epic-run', sessionName: ARGS.session, defaultEngine: ARGS.engine, issue: ARGS.issue })
// The issue's live status comment mirrors the pane's narration: the label says
// WHICH state the issue is in, this says whether the run is alive and where it
// got to. Issue mode only — slug mode has no issue to report on.
initStatus({ issue: ARGS.issue, script: 'epic-run', session: ARGS.session, phases: ['Prepare', 'Architect', 'Code', 'Review', 'Fixes after review', 'Ship'] })
onPhase(statusPhase)
onLog(statusNote)

const issue = ARGS.issue
let slug = ARGS.slug
const gitMode = issue != null

// ───────────────────────── Transport ─────────────────────────
// The deterministic half of the run. Every function here either returns a
// structured outcome the pipeline branches on, or throws with a message that
// names the command that failed — main()'s catch turns that into a blocker.

const LIFECYCLE = ['in-progress', 'ready-to-merge', 'ready-to-review', 'failed', 'needs-defect-fix']

// Claiming is what makes it safe to run epics in parallel. The label swap `ready` → `in-progress`
// can't be the lock — it's a read-modify-write with a wide window — but creating a ref on origin is a
// compare-and-swap, so pushing the branch BEFORE any work is a real cross-machine lock with no new
// infrastructure. Labels stay as the human-readable signal; the ref is the lock.
//
// Three layers, in the order prepare hits them, because no single one covers every collision:
//   1. Local branch already checked out in another worktree — same host, same clone: sessions share
//      one .git, so a live run's branch is visible and `git switch` refuses. Predates claiming.
//   2. A claim-only branch on origin — catches a competitor on ANY host, and catches it even when the
//      two runs derived DIFFERENT slugs for the same issue, because the `epic/<N>-*` glob matches
//      regardless of slug.
//   3. The push CAS itself — closes the window where both runs pass 2 before either has pushed. The
//      claim commit is empty (it changes no files, so it never appears in a diff) and unique (so the
//      loser's push is a genuine non-fast-forward, not a no-op the server accepts from both). Ship
//      squashes it away.
// Layer 2 is not optional: a claim ref IS a branch on origin, so without it the loser lands in the
// resume path and adopts its competitor's branch, never reaching 3 at all.
async function prepare(issue) {
  const notes = []
  const view = await issueView(issue, 'number,title,body,state')
  if (String(view.state || '').toUpperCase() === 'CLOSED') return { refused: `issue #${issue} is closed` }

  // Building on an unlanded dependency is exactly what blocked_by exists to prevent — and a
  // dependency check that could not be READ is never a green gate either, so an errored query
  // skips the issue instead of building it as if unblocked. Skipped rather than blocked: nothing
  // has been claimed or labelled yet, so the next tick simply re-reads it.
  const deps = await openBlockers(issue)
  if (deps.error) return { refused: `the blocked_by dependency check could not be read (${deps.error}) — refusing to build as if unblocked` }
  if (deps.blockers.length) return { refused: `blocked by open issue(s) ${deps.blockers.map(n => `#${n}`).join(', ')}` }

  // Same rule for the base: every branch below is cut from origin/main and the claim is a push to
  // origin, so a failed fetch means building against a base this run could not confirm and then
  // claiming over a link that just failed.
  const fetched = await git(['fetch', 'origin'])
  if (!fetched.ok) return { refused: `git fetch origin failed (${failureReason(fetched)}) — refusing to build against an unconfirmed base` }
  // Captured BEFORE any branch switch: the deps check compares this worktree's original checkout
  // against the new base.
  const base = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')

  // An open PR already delivering this issue — by branch name, and (for legacy title-derived branch
  // names) by the Closes line in its body.
  const prefix = `epic/${issue}-`
  const delivering = (await openPrs('number,headRefName')).find(p => String(p.headRefName || '').startsWith(prefix))
  if (delivering) return { alreadyExists: true, note: `an open PR already delivers this issue (PR #${delivering.number})` }
  const legacy = await searchOpenPrs(`Closes #${issue} in:body`)
  if (legacy.length) return { alreadyExists: true, note: `an open PR already delivers this issue (PR #${legacy[0].number})` }

  // A leftover branch (an interrupted or blocked prior run) is RESUMED, never started over.
  const local = (await gitOut(['branch', '--list', `${prefix}*`, '--format=%(refname:short)'], 'git branch --list'))
    .split('\n').map(s => s.trim()).filter(Boolean)
  const remote = (await gitOut(['ls-remote', '--heads', 'origin', `${prefix}*`], 'git ls-remote'))
    .split('\n').map(l => l.trim().split(/\s+/)[1]).filter(Boolean).map(r => r.replace(/^refs\/heads\//, ''))
  let branch = local[0] || remote[0] || null
  let resumed = false
  let codeDone = false
  let partialWork = false
  if (branch) {
    slug = branch.slice('epic/'.length)
    let sw
    if (local.includes(branch)) {
      sw = await git(['switch', branch])
    } else {
      // Only on origin: a leftover, or another run's live claim? A branch whose every commit above
      // origin/main is a claim commit holds no work — its owner is building this issue right now.
      await gitOut(['fetch', 'origin', branch], `git fetch origin ${branch}`)
      const subjects = (await gitOut(['log', '--format=%s', 'origin/main..FETCH_HEAD'], 'git log')).split('\n').filter(Boolean)
      if (subjects.length && subjects.every(s => s.startsWith(`chore(epic ${issue}): claim`))) return { refused: 'claimed by another run' }
      sw = await git(['switch', '-c', branch, '--track', `origin/${branch}`])
    }
    if (!sw.ok) {
      if (/already (checked out|used by worktree)/i.test(`${sw.err}\n${sw.out}`)) {
        return { refused: `${branch} is checked out in another worktree — a run may be live there` }
      }
      must(sw, `git switch ${branch}`)
    }
    // A relaunch reuses the worktree, so a killed run's uncommitted work may still be sitting here.
    // Checkpoint it: nothing is lost, and the rebase below refuses a dirty tree.
    if (await gitOut(['status', '--porcelain'], 'git status')) {
      await gitOut(['add', '-A'], 'git add -A')
      if ((await git(['diff', '--cached', '--quiet'])).code !== 0) await gitOut(['commit', '-q', '-m', `wip(epic ${slug}): resume checkpoint`], 'git commit (resume checkpoint)')
    }
    const rb = await git(['rebase', 'origin/main'])
    if (!rb.ok) {
      await git(['rebase', '--abort'])
      return { refused: `resume rebase onto origin/main conflicted — resolve manually on ${branch} or delete it for a fresh build` }
    }
    resumed = true
    // A code checkpoint means an earlier run finished implementation. Do not repeat it: recover the
    // architecture plan if needed, re-prove the tree through verify, then review.
    const subjects = (await gitOut(['log', '--format=%s', 'origin/main..HEAD'], 'git log')).split('\n')
    codeDone = subjects.some(s => new RegExp(`^wip\\(epic ${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): (code|triage) checkpoint$`).test(s.trim()))
    partialWork = !codeDone && subjects.some(s => s.trim() && !s.startsWith(`chore(epic ${issue}): claim`))
  } else {
    slug = slugify(issue, view.title)
    branch = `epic/${slug}`
    // ALWAYS from origin/main, never the local checkout (it can be stale).
    await gitOut(['switch', '-c', branch, 'origin/main'], `git switch -c ${branch} origin/main`)
    // CLAIM, right now — before requirements.md, before npm ci, before anything else expensive.
    await gitOut(['commit', '--allow-empty', '-q', '-m', `chore(epic ${issue}): claim ${Math.floor(Date.now() / 1000)}-${process.pid}`], 'git commit (claim)')
    const push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`])
    if (!push.ok) {
      // Losing this race is the mechanism working: never retry, force, or pick another slug.
      if (pushRejected(push)) return { refused: 'claimed by another run' }
      must(push, 'git push (claim)')
    }
  }

  // Signal on GitHub that autonomous work has started — now, before the slow deps step. Best-effort:
  // a failure is noted in the phase log (so it surfaces in the PR body) and never aborts the run.
  await ensureLabels(LIFECYCLE)
  const swap = await editLabels(issue, { add: ['in-progress'], remove: ['ready', 'ready-to-merge', 'ready-to-review', 'failed', 'needs-defect-fix'] })
  if (!swap.ok) notes.push(`prepare: label swap failed: ${failureReason(swap)}`)
  const assigned = await assignSelf(issue)
  if (!assigned.ok) notes.push(`prepare: self-assign failed: ${failureReason(assigned)}`)

  const dir = epicDir(slug)
  await ensureEpicsIgnored()
  writeRequirements(dir, issue, view.body)
  initEpicMd(dir, { title: view.title, slug, issue })
  for (const n of notes) updateEpicMd(dir, { log: n })

  const packages = discoverPackages('.')
  const depLines = packages.length ? await ensureDeps(packages, { pairs: [[base, 'HEAD']] }) : []
  return {
    slug, branch, resumed, codeDone, partialWork, requirement: readRequirements(dir),
    requirementTitle: String(view.title || ''), requirementBody: String(view.body || ''),
    packages, depLines,
  }
}

// One budget for everything from the run's first terminal label to its last GitHub call. That label is
// whichever terminal write comes first: ship's `ready-to-review`, or a pre-ship blocker's `failed`.
// Everything after it — the evidence comment and its readback, the queue label edit, the promotion to
// `ready-to-merge`, a post-ship blocker report — runs while bin/reap.sh has already started the settle
// clock at that label. On the default gh timeout any one of those calls is longer than the shortest
// window reap will honour, so the sweep can kill a live session between the label and the record of
// what the gate decided. terminalBudget() opens the window at the first such write and hands the same
// one back to every caller after it; before the write there is no clock running, so `spend()` is empty
// and the default timeout stands. The same window is why no model step may run after that first write:
// runtime's agent() refuses a spawn once it is open, since a ninety-minute ceiling is the one thing this
// budget cannot cap.
const spend = terminalSpend

// Squash, push, open the PR, record deferrals, label — from ship's JSON.
async function shipTransport({ issue, slug, dir, decision }) {
  const branch = `epic/${slug}`
  const deferred = Array.isArray(decision.deferred) ? decision.deferred : []
  // The merge gate's input, counted here from the classification, never taken as a number a model
  // typed.
  const deferredDefects = deferred.filter(d => d.kind === 'defect').length
  const title = String(decision.title || '').trim().split('\n')[0]
  if (!title) throw new Error('ship returned no PR title')

  // summary.md is the PR body source. The Closes line is what auto-closes the issue on merge — a
  // bare (#N) only links — so it is appended here, unconditionally.
  let body = String(decision.body || '').trim()
  if (decision.legalMarker) body += `\n\n${decision.legalMarker}`
  if (deferred.length) body += `\n\nDeferred items recorded on #${issue}.`
  body += `\n\nCloses #${issue}\n`
  writeFileSync(path.join(dir, 'summary.md'), body)

  // Squash to ONE clean commit: fold leftovers into the checkpoint chain, soft-reset to the merge
  // base (NOT origin/main, which may have advanced during the run), commit once.
  await gitOut(['add', '-A'], 'git add -A')
  if ((await git(['diff', '--cached', '--quiet'])).code !== 0) await gitOut(['commit', '-q', '-m', `wip(epic ${slug}): pre-ship`], 'git commit (pre-ship)')
  const mergeBase = await gitOut(['merge-base', 'HEAD', 'origin/main'], 'git merge-base')
  await gitOut(['reset', '--soft', mergeBase], 'git reset --soft')
  if ((await git(['diff', '--cached', '--quiet'])).code === 0) throw new Error('nothing to ship — the branch holds no change against origin/main')
  const message = [title, '', String(decision.commitBody || '').trim(), decision.legalMarker ? `\n${decision.legalMarker}` : '', '', `Closes #${issue}`]
    .join('\n').replace(/\n{3,}/g, '\n\n')
  await withBodyFile(message, (file) => gitOut(['commit', '-q', '-F', file], 'git commit (squash)'))

  // The branch has been on origin since prepare claimed it, and the squash rewrote every commit above
  // the merge base; the lease overwrites only the ref THIS run has held since the claim and fails if
  // anything else moved it.
  const push = await git(['push', '--force-with-lease', '-u', 'origin', branch])
  if (!push.ok) throw new Error(pushRejected(push) ? `the force-with-lease push was rejected — ${branch} moved on origin under this run` : `git push failed (${failureReason(push)})`)

  const prUrl = await prCreate({ head: branch, title, bodyFile: path.join(dir, 'summary.md') })
  const prNumber = Number(String(prUrl).trim().split('/').pop())
  const prHead = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')

  // Deferred work is recorded on the ISSUE, not the PR — and only now that the PR exists.
  // Everything above is idempotent under a re-run (the branch is rebuilt, the push is a lease, and
  // prepare's open-PR guard stops the second run outright); a filed issue and a posted comment are
  // not. Creating them first meant a ship that died before the PR left duplicates behind for the
  // retry to add to, so they go last, and a record already on the issue is left alone rather than
  // doubled. A follow-up issue is filed only for the kinds that can earn one, only when ship judged
  // it a coherent slice, and at most 3 — defects first. That "Follow-up to #N" line IS the relation
  // (GitHub records it as a cross-reference); no sub-issue.
  //
  // A filed follow-up is also QUEUED: `ready`, and `blocked_by` this issue. Ship has already judged
  // it a coherent mergeable slice — the same test the queue applies — so leaving it unlabelled meant
  // work the pipeline had fully specified sat waiting on a human to type one label. The dependency is
  // what makes that safe: the follow-up describes a defect in code that is still only on this epic's
  // branch, so it must not run until this issue closes, and dispatch skips a blocked issue rather
  // than burning a run on it. Both are best effort — the PR is already open by here, and a link or a
  // label that failed to land is a queueing loss, not a reason to fail a finished run.
  let filed = 0
  if (deferred.length) {
    if (await hasDeferredRecord(issue)) {
      log('Ship: a deferred record from an earlier attempt is already on the issue — left as it is')
    } else {
      const rank = { defect: 0, 'missing-gate': 1, 'scope-cut': 2 }
      const eligible = deferred.filter(d => d.file === true && d.kind in rank).sort((a, b) => rank[a.kind] - rank[b.kind])
      const links = new Map()
      const blockerId = eligible.length ? await issueId(issue) : null
      if (eligible.length && !blockerId) log(`Ship: #${issue}'s id could not be read — follow-ups are filed unqueued, for a human to order and label`)
      if (blockerId) await ensureLabels(['ready'])
      for (const d of eligible.slice(0, 3)) {
        const url = await issueCreate({ title: d.issueTitle || d.title, body: `${String(d.issueBody || d.why).trim()}\n\nFollow-up to #${issue}` })
        links.set(d, url)
        filed++
        // Order first, queue second: a follow-up that got `ready` without its dependency would be
        // launchable immediately, against a main that does not yet carry the code it describes.
        const number = Number(String(url).trim().split('/').pop())
        if (!Number.isInteger(number) || !blockerId) continue
        const dep = await addBlockedBy(number, blockerId)
        if (!dep.ok) { log(`Ship: could not mark ${url} blocked_by #${issue} (${failureReason(dep)}) — left unqueued`); continue }
        const queued = await editLabels(number, { add: ['ready'] })
        if (!queued.ok) log(`Ship: could not queue ${url} (${failureReason(queued)}) — it is ordered but a human labels it`)
      }
      const lines = ['🤖 deferred / not done', '']
      for (const d of deferred) lines.push(`- ${d.title} (${d.kind}): ${d.why}${d.checkNote ? ` — ${d.checkNote}` : ''}${links.has(d) ? ` — filed as ${links.get(d)}` : ''}`)
      if (eligible.length > filed) lines.push('', `${eligible.length} items qualified for a follow-up issue and ${filed} were filed (the cap is 3): needing more means this issue was under-scoped.`)
      await comment(issue, lines.join('\n'))
    }
  }

  // ready-to-review and nothing else: whether the PR may instead be queued for unattended merge is
  // the gate's decision, downstream of here. The assignee stays (it records ownership).
  terminalBudget()
  await ensureLabels(['ready-to-review'], spend())
  const flip = await editLabels(issue, { add: ['ready-to-review'], remove: ['in-progress'] }, spend())
  if (!flip.ok) log(`Ship: label flip to ready-to-review failed (${failureReason(flip)}) — the PR is open; a human finishes the labels`)
  updateEpicMd(dir, { phase: 'ship → done', log: `ship: PR opened ${prUrl}; ${deferred.length} deferred item(s), ${filed} filed, ${deferredDefects} defect(s)` })
  return { prUrl, prNumber, prHead, deferredDefects, deferredCount: deferred.length, filed }
}

// Transport, not judgment: the merge gate has already been computed from structured counts, and this
// only writes its verdict where bin/merge-worker.sh will read it. The LABEL is that verdict, never this
// write's exit code: the merge worker selects on `ready-to-merge` alone, and GitHub can apply the swap
// while the client is still waiting — so a write that timed out is not a write that did not happen, and
// the readback runs whatever the write returned. Two outcomes, and each of them has to agree with what
// RESULT will claim, or the run reports a held PR that the merge worker lands anyway:
//   - ready-to-merge on and ready-to-review off: the promotion is real and is claimed, confirmed write or not;
//   - anything else — half-landed beside ready-to-review, unreadable, or a clean ready-to-review: the
//     promotion is taken back OFF and the demotion is proved, inside the window ship's write opened.
//     A read is a snapshot and not a promise, so a clean ready-to-review is not proof that the promotion
//     will not land: an unconfirmed write GitHub has not applied YET can apply straight after that read,
//     recreating the label the merge worker selects on under a RESULT that says the PR is held. So the
//     compensating transition is issued for every promotion this write did not confirm, and the readback
//     after it — not the one before — is what lets the PR be reported as held. `unresolved` is the state
//     that is neither, and the caller blocks on it rather than resting on a label it cannot account for.
async function handoff(issue, dir) {
  const readLabels = async () => {
    try {
      return await issueLabels(issue, spend())
    } catch (e) {
      log(`handoff: the issue's labels could not be read back (${e && e.message || e})`)
      return null
    }
  }
  const observedIn = (labels) => labels ? `observed labels: ${labels.join(', ') || 'none'}` : 'the labels could not be read back'
  await ensureLabels(['ready-to-merge'], spend())
  const r = await editLabels(issue, { add: ['ready-to-merge'], remove: ['ready-to-review'] }, spend())
  const labels = await readLabels()
  const why = r.ok ? observedIn(labels) : `${failureReason(r)}; ${observedIn(labels)}`
  if (labels && labels.includes('ready-to-merge') && !labels.includes('ready-to-review')) {
    // Local bookkeeping, and it cannot unseat an observed verdict: .epics/ dies with the worktree,
    // while the label is already on the issue and RESULT has to say so.
    try { updateEpicMd(dir, { log: 'handoff: queued for merge-worker' }) } catch { /* the pane log is the record */ }
    return { labelled: true, summary: r.ok ? 'ready-to-merge observed' : `the write itself was not confirmed (${failureReason(r)}) but ready-to-merge is observed on the issue` }
  }
  const rest = terminalTransition({ rest: 'ready-to-review' })
  await ensureLabels(rest.add, spend())
  const undo = await editLabels(issue, rest, spend())
  const after = await readLabels()
  if (after && after.includes('ready-to-review') && !after.includes('ready-to-merge')) {
    return { labelled: false, summary: `${why} — the promotion was taken back off and ready-to-review confirmed` }
  }
  const undoneWhy = undo.ok ? observedIn(after) : `${failureReason(undo)}; ${observedIn(after)}`
  return { labelled: false, summary: why, unresolved: `${why} — and the demotion back to ready-to-review could not be verified (${undoneWhy})` }
}

// The blocker report: preserve the work, say where it is, flip the label to failed.
async function postBlocker({ issue, slug, phase, reason, prUrl }) {
  const branch = slug ? `epic/${slug}` : null
  let branchLine
  if (prUrl) {
    // A block AFTER ship: the PR is open, pushed and complete — the work needs a human, not
    // preservation, and a re-run would skip it (prepare's open-PR guard) rather than resume.
    branchLine = `- PR: ${prUrl} — open on ${branch}, NOT merged and NOT queued for the merge worker; the change itself is complete. Fix the cause above, push, and swap \`failed\` → \`ready-to-merge\` if the deferred record on this issue lists no defect (else \`ready-to-review\`); the merge worker rebases, re-checks and lands it. Do not merge by hand. A re-run of /epic #${issue} will skip (an open PR already delivers this issue).`
  } else if (branch) {
    // Checkpoint commits on the branch are durable; only uncommitted changes are at risk. The WIP
    // commit never carries "Closes #N" (unfinished work must not auto-close the issue on an accidental
    // merge) and `git add -A` respects .gitignore, so .epics/ stays out.
    try {
      if (await gitOut(['status', '--porcelain'], 'git status')) {
        await gitOut(['add', '-A'], 'git add -A')
        if ((await git(['diff', '--cached', '--quiet'])).code !== 0) await gitOut(['commit', '-q', '-m', `wip: epic blocked at ${phase}`], 'git commit (wip)')
      }
      const tracked = (await git(['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`])).ok ? `origin/${branch}` : 'origin/main'
      const ahead = Number((await git(['rev-list', '--count', `${tracked}..HEAD`])).out) || 0
      if (ahead > 0) await git(['push', '--force-with-lease', '-u', 'origin', branch])
    } catch (e) {
      log(`blocked: could not preserve the work (${e && e.message || e})`)
    }
    branchLine = `- branch: ${branch} — re-running /epic #${issue} resumes from it; delete the branch (locally AND on origin) to force a fresh build`
  } else {
    branchLine = `- branch: none (blocked before branch creation; a re-run of /epic #${issue} starts fresh)`
  }
  let body = `🤖 epic-run blocked\n- phase: ${phase}\n- reason: ${reason}\n${branchLine}\n`
  // .epics/ is gitignored and dies with the worktree; the phase log survives in this comment.
  if (branch && existsSync(path.join(epicDir(slug), 'epic.md'))) {
    const m = readFileSync(path.join(epicDir(slug), 'epic.md'), 'utf8').match(/## Phase log[\s\S]*$/)
    if (m) body += `\n${m[0].trim()}\n`
  }
  await comment(issue, body, spend())
  // Every terminal label comes off — ready-to-merge above all, since leaving it would hand a failed
  // run's PR to the merge worker — so the removals are derived from the one label the run rests at.
  // The assignee stays. `failed` is a terminal write like ship's, so a run blocked before ship opens
  // the window here: the clock starts as GitHub applies it either way. A run blocked AFTER ship keeps
  // the window ship opened; terminalBudget() never hands out a second one.
  terminalBudget()
  const rest = terminalTransition({ rest: 'failed' })
  await ensureLabels(rest.add, spend())
  const flip = await editLabels(issue, rest, spend())
  if (!flip.ok) log(`blocked: label flip to failed failed (${failureReason(flip)})`)
}

// In git mode the blocker path reports on the issue; in slug mode it just returns the error.
// blockerPosted guards the double-post: fail() can be re-entered when the outer catch fires after a
// phase that already failed. openPr is set once ship succeeds: a block after that point must not tell
// the reader to resume a branch whose work is already delivered by an open PR.
let currentPhase = 'prepare'
let blockerPosted = false
let openPr = null
async function fail(phase, reason) {
  reason = withAgentFailure(reason)
  if (gitMode) {
    if (!blockerPosted) {
      blockerPosted = true
      try {
        await postBlocker({ issue, slug, phase, reason, prUrl: openPr })
      } catch (e) {
        log(`blocked: could not report on GitHub (${e && e.message || e})`)
      }
    }
    return { blocked: true, issue, slug, phase, reason, prUrl: openPr || undefined }
  }
  return { error: `${phase}: ${reason}` }
}

// The issue carries no per-phase commentary: the ready → in-progress → ready-to-merge/ready-to-review/failed
// label lifecycle is the live signal, the PR body is the record of HOW it was built, and the only comments
// are the deferred list (nothing else records it) and the blocker report. A concrete defect-only review
// hold also carries needs-defect-fix for the separate bounded repair queue.

let requirement
let requirementTitle = ''
let requirementBody = ''
// True when the resumed branch already carries a code checkpoint: implementation is skipped;
// architecture is reconstructed read-only only when its structured artifact did not survive.
let codeDone = false
// A resumed branch with preserved edits but no completed code checkpoint cannot recreate a clean
// pre-RED baseline. Continue it directly; never discard work merely to replay the gate.
let partialWork = false
// Discovered layout: which packages the verify gate runs in. Fail closed, like every other gate in this
// file: an empty package list would make the verify gate a silent no-op — the run finishes "green"
// having verified nothing.
let packages = []
const applyDiscovery = (pkgs) => {
  if (!Array.isArray(pkgs) || !pkgs.length) {
    return 'layout discovery found no package declaring an `npm run verify` script, so the verify gate downstream would be a silent no-op — refusing to build a change that nothing would verify.'
  }
  packages = pkgs
  return null
}

async function main() {
try {
  // ───────────────────────── Phase 0: Prepare (issue mode only) ─────────────────────────
  if (gitMode) {
    phase('Prepare')
    const prep = await prepare(issue)
    if (prep.refused) {
      log(`Prepare refused to start: ${prep.refused}`)
      return { skipped: true, issue, reason: prep.refused }
    }
    if (prep.alreadyExists) {
      log(`Prepare: ${prep.note} — skipping to avoid duplicate work.`)
      return { skipped: true, issue, reason: prep.note }
    }
    const badLayout = applyDiscovery(prep.packages)
    if (badLayout) return await fail('prepare', badLayout)
    slug = prep.slug
    requirement = prep.requirement
    requirementTitle = prep.requirementTitle
    requirementBody = prep.requirementBody
    codeDone = !!prep.codeDone
    partialWork = !!prep.partialWork
    log(`Prepare: requirements written, branch epic/${slug} ${prep.resumed ? 'resumed and rebased onto origin/main' : 'created off origin/main'}${codeDone ? ' (a code checkpoint is on it)' : partialWork ? ' (partial coding work was preserved)' : ''}, deps checked (${prep.depLines.join('; ')}). Packages: ${pkgList(packages)}.`)
  }

  const dir = epicDir(slug)
  // Git mode reviews the checkpoint-committed branch against the fresh base; manual mode reviews the working tree.
  const DIFF = gitMode ? 'git diff origin/main...HEAD' : 'git diff'
  // How code/fixes make their work visible downstream: git mode checkpoint-commits (durability + clean
  // origin/main...HEAD diffs); manual mode intent-to-adds (no commits allowed on the user's tree).
  const checkpointWork = async (label) => {
    if (gitMode) return checkpoint(slug, label)
    await intentToAdd()
    return 'intent-to-add'
  }

  // ───────────────────────── Phase 1: Architect ─────────────────────────
  currentPhase = 'architect'
  phase('Architect')

  // The spec is fed inline to the blind reviewers so they never need to enter .epics/<slug>/ (where
  // epic.md/architecture.md/etc. would anchor them). Issue mode gets it from prepare; manual mode
  // reads the file the user wrote.
  if (!gitMode) {
    if (!existsSync(path.join(dir, 'requirements.md'))) return await fail('architect', `${dir}/requirements.md does not exist — aborting before code.`)
    requirement = readRequirements(dir)
    const badLayout = applyDiscovery(discoverPackages('.'))
    if (badLayout) return await fail('architect', badLayout)
    log(`Packages: ${pkgList(packages)}.`)
  }

  let design
  if (codeDone) {
    // Review needs the structured verification/review decisions even after a worktree is recreated.
    // Prefer the scratch artifact; if it did not survive, reconstruct it read-only from the completed
    // implementation. Code is never replayed merely to recover planning context.
    const artifact = path.join(dir, 'architecture.json')
    try { design = JSON.parse(readFileSync(artifact, 'utf8')) } catch { design = null }
    if (!validDesign(design)) {
      log('Architect: structured artifact missing or invalid on a code checkpoint — reconstructing it read-only.')
      design = await agent(PROMPTS.architectRecover(dir, DIFF),
        { label: 'architect:recover', phase: 'Architect', step: 'architect', schema: DESIGN_SCHEMA },
      )
      if (!validDesign(design)) return await fail('architect', 'Could not recover a valid structured architecture from the completed code checkpoint — refusing to review without its verification and review plan.')
      renderArchitecture(dir, design)
      updateEpicMd(dir, { phase: 'architect → recovered', approach: design.approach, log: `architect: recovered ${design.approach} from code checkpoint` })
      log(`Architect: recovered plan for completed checkpoint (${design.approach}); code remains untouched.`)
    } else {
      // architecture.md is disposable scratch too; recreate it from the validated source before any
      // retry or downstream phase tries to read it.
      renderArchitecture(dir, design)
      updateEpicMd(dir, { phase: 'architect → skipped', approach: design.approach, log: 'architect: skipped, valid structured plan recovered from the code checkpoint' })
      log(`Architect: skipped — the branch carries a code checkpoint and structured plan (${design.approach}).`)
    }
  } else {
    design = await agent(partialWork ? PROMPTS.architectPartial(dir, DIFF) : PROMPTS.architectDesign(dir),
      { label: 'architect:design', phase: 'Architect', step: 'architect', schema: DESIGN_SCHEMA },
    )
    if (!validDesign(design)) return await fail('architect', 'Architect design was missing required verification evidence or review rationale — aborting before code.')
    if (partialWork && design.verification.mode !== 'direct') return await fail('architect', 'Resumed partial work did not produce a direct continuation plan — refusing to replay RED against a dirty baseline.')

    // Rendered here from the decided design: every coding path reads architecture.md, so it exists
    // before implementation runs, verbatim to what the architect returned.
    renderArchitecture(dir, design)
    updateEpicMd(dir, { phase: 'architect → done', approach: design.approach, log: `architect: ${design.approach}` })
    if (!existsSync(path.join(dir, 'architecture.md'))) return await fail('architect', 'architecture.md was not written — aborting before code, which reads it.')
    log(`Architecture: ${design.approach} — ${design.rationale}`)
  }

  // ───────────────────────── Phase 2: Code (adaptive verification → checkpoint) ─────────────────────────
  currentPhase = 'code'
  phase('Code')

  // The verify gate, run here. A step's own verify run is its feedback loop; this one is the verdict.
  const verifyGate = async (label) => {
    const v = await runVerify(packages)
    log(`${label}: verify ${v.green ? 'green' : 'RED'} — ${v.detail}`)
    return v
  }

  // Test-first starts only from a clean baseline, then requires the orchestrator's failure output to
  // contain the exact assertion excerpt the RED agent reported. This rejects pre-existing, timeout,
  // spawn and obvious unrelated failures. It does not pretend substring matching proves test semantics;
  // the structured reason and later blind review remain the judgment layers.
  let red = null
  let green = null
  let gate
  if (codeDone) {
    // The checkpoint is the implementation. Re-prove it rather than trust it: the branch was rebased
    // onto a main that may have moved, so the gate runs exactly as it would after green.
    log('Code: resumed from a code checkpoint — implementation skipped; re-running the verify gate.')
    red = 'the tests already on this branch'
    green = 'resumed from a code checkpoint'
    gate = await verifyGate('Code: verify gate (resumed)')
  } else {
    if (design.verification.mode === 'test-first') {
      const baseline = await verifyGate('Code: test-first baseline')
      if (!baseline.green) return await fail('code', `npm run verify was not green before RED (${baseline.detail}) — refusing to mistake an existing failure for a regression.`)

      red = await agent(PROMPTS.codeRed(dir),
        { label: 'code:red', phase: 'Code', step: 'code', schema: RED_SCHEMA },
      )
      if (!validRed(red)) return await fail('code', 'Red step returned no meaningful test files, assertion excerpt, or reason — aborting before implementation.')
      gate = await verifyGate('Code: red gate')
      if (!provesExpectedRed(gate, red)) {
        const rejection = gate.green
          ? `verify stayed green (${gate.detail})`
          : `verify failed, but not with the reported assertion excerpt or a runnable test failure (${gate.detail})`
        log(`Code: RED was not established — respawning the red step once (${rejection}).`)
        red = await agent(PROMPTS.codeRed(dir) + PROMPTS.redRetry(rejection),
          { label: 'code:red:retry', phase: 'Code', step: 'code', schema: RED_SCHEMA },
        )
        if (!validRed(red)) return await fail('code', 'Red step returned no meaningful evidence on its retry — aborting before implementation.')
        gate = await verifyGate('Code: red gate (retry)')
        if (!provesExpectedRed(gate, red)) return await fail('code', `RED could not be established twice (${gate.detail}) — refusing to implement against an unproven regression.`)
      }
      log('Code: the expected RED assertion failure was observed by the orchestrator; semantic relevance remains for blind review to judge.')

      green = await agent(PROMPTS.codeGreen(dir, red, pkgList(packages)),
        { label: 'code:green', phase: 'Code', step: 'code' },
      )
    } else {
      green = await agent(PROMPTS.codeDirect(dir, pkgList(packages)),
        { label: 'code:direct', phase: 'Code', step: 'code' },
      )
    }
    if (!green) return await fail('code', 'Implementation step failed — implementation did not complete, aborting before review.')
    gate = await verifyGate('Code: verify gate')
  }
  if (!gate.green) {
    const implementationPrompt = design.verification.mode === 'direct'
      ? PROMPTS.codeDirect(dir, pkgList(packages))
      : PROMPTS.codeGreen(dir, red, pkgList(packages))
    log('Code: verify is red after implementation — respawning implementation once with the failure.')
    green = await agent(implementationPrompt + PROMPTS.verifyRetry(gate),
      { label: design.verification.mode === 'direct' ? 'code:direct:retry' : 'code:green:retry', phase: 'Code', step: 'code' },
    )
    if (!green) return await fail('code', 'Implementation step failed on its retry — implementation did not complete, aborting before review.')
    gate = await verifyGate('Code: verify gate (retry)')
    if (!gate.green) return await fail('code', `npm run verify is red after implementation and its retry (${gate.detail}) — refusing to review an unverified change.`)
  }
  const codeCheckpoint = await checkpointWork('code')
  const codeSha = gitMode ? await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD') : null
  updateEpicMd(dir, { phase: 'code → done', log: `code: done (${codeCheckpoint})` })
  log(`Code: implementation complete, verify gate run, work checkpointed (${codeCheckpoint}).`)

  // ───────────────────────── Phase 3: Review (blind, adversarially verified) ─────────────────────────
  currentPhase = 'review'
  phase('Review')

  const reviewers = reviewPlan(design)

  // A finder that DIED must never look like a finder that found nothing. Coercing a null agent straight to []
  // hands the rest of the phase a clean bill of health for a reviewer that never ran, and the tally then ASSERTS a
  // complete review in the PR body — the diff ships looking reviewed by an agent that never ran. The
  // runtime respawns a transient death once; after that, fail closed: review is the only gate between code
  // and an auto-opened PR, so a hole in it stops the run.
  const runReviewer = async reviewer => {
    const r = await agent(PROMPTS.review(requirement, reviewer, DIFF),
      { label: reviewer.label, phase: 'Review', step: 'review', schema: FINDINGS_SCHEMA },
    ).catch(() => null)
    if (r && Array.isArray(r.findings)) return r.findings
    return null // sentinel: the reviewer died. Distinct from [], which means "ran, found nothing".
  }

  const reviewerResults = await parallel(reviewers.map(reviewer => () => runReviewer(reviewer)))
  const deadReviewers = reviewerResults.map((r, i) => (r === null ? reviewers[i].label : null)).filter(Boolean)
  if (deadReviewers.length) {
    return await fail('review', `${deadReviewers.length} of ${reviewers.length} requested reviewer(s) produced no result after a respawn (${deadReviewers.join(', ')}) — refusing to ship a change missing independent review.`)
  }
  const reviews = reviewerResults.flat()

  // Soft dedup before the verify fan-out (free — reviews is already fully materialized). Two reviewers
  // can restate the same defect, which otherwise gets verified twice, listed
  // twice in review.md, and fixed twice. Collapse ONLY a confident duplicate — same location AND same
  // normalized title. Biased toward keeping: when in doubt we keep both, so distinct bugs at one file:line
  // survive (different titles) and nothing is ever dropped on location alone.
  const seen = new Set()
  const uniqueReviews = reviews.filter(f => {
    const k = `${(f.location || '').trim()}::${(f.title || '').trim().toLowerCase().replace(/\s+/g, ' ')}`
    return seen.has(k) ? false : seen.add(k)
  })
  // Cluster by FILE (line numbers stripped) before the adversarial fan-out. The title dedup above only catches
  // verbatim restatements; independent reviewers can word one defect differently and
  // slip through. On #194 that put paraphrases of a single history.ts bug in front of separate
  // skeptics, each re-reading the same diff to re-confirm it. One skeptic per batch pays that cost once and can
  // see the claims are one defect — a call the per-finding verifiers each had to make blind. Verdicts stay PER
  // FINDING: clustering changes who judges, never what survives.
  // Batches are sized, NOT keyed by file. Keying by file was the first version of this and it only caught
  // restatements that happen to land in the same file; on #69 one defect ("a parseable-but-unusable schedule
  // renders no rate fields and does not block submit") arrived from reviewers pointing at a component, a
  // gate, a test and a doc — four files, so four skeptics, none of whom could see it was one defect. Three
  // more of that run's findings were a second defect split the same way: 18 findings, ~9 real defects.
  //
  // Grouping aggressively is safe BECAUSE it is routing rather than gating — a verdict is still returned per
  // finding, so the worst a bad batch can do is give one skeptic some unrelated context. The cap keeps that
  // honest: past ~8 findings a single reviewer's attention is the thing being diluted, so split rather than
  // pile on. Sorting by file first keeps genuinely related findings adjacent when a split does happen.
  const fileOf = f => (f.location || '').trim().replace(/:\s*\d+(?:\s*-\s*\d+)?\s*$/, '') || '(unspecified)'
  const MAX_BATCH = 8
  const ordered = [...uniqueReviews].sort((a, b) => fileOf(a).localeCompare(fileOf(b)))
  const batches = []
  for (let i = 0; i < ordered.length; i += MAX_BATCH) batches.push(ordered.slice(i, i + MAX_BATCH))
  log(`Review: ${reviews.length} raw finding(s) across ${reviewers.length} blind reviewer(s); adversarially verifying ${uniqueReviews.length} in ${batches.length} batch(es) of up to ${MAX_BATCH}.`)

  // Adversarial verify: an independent skeptic tries to REFUTE each finding before it counts. Refuted /
  // low-confidence findings are NOT silently dropped — they land in review.md's "Unconfirmed" section for
  // human eyes (fixes-after-review and ship are told to ignore them). Fail closed on a missing verdict: batching means
  // a dead agent or a short array would otherwise take a whole batch's findings with it, and a lost finding
  // must surface as unconfirmed (a human re-checks it), never vanish and never pass as confirmed.
  const noVerdict = f => ({
    finding: f,
    verdict: { real: false, confidence: 0, reasoning: 'Batched verifier returned no verdict for this finding — recorded as unconfirmed rather than dropped. Re-check by hand.' },
    unknownEvidence: true,
  })
  const verdicts = (await parallel(batches.map((group, bi) => () =>
    agent(PROMPTS.verify(group, requirement, DIFF),
      { label: `verify:${bi + 1}/${batches.length}`, phase: 'Review', step: 'confirm-review', schema: VERDICT_SCHEMA },
    ).then(v => {
      const returned = v && Array.isArray(v.verdicts) ? v.verdicts : []
      const indices = returned.map(x => Number(x.index))
      const complete = returned.length === group.length && new Set(indices).size === group.length &&
        indices.every(i => Number.isInteger(i) && i >= 1 && i <= group.length)
      if (!complete) return group.map(noVerdict)
      return group.map((f, i) => {
        const got = returned.find(x => Number(x.index) === i + 1)
        if (!got || typeof got.real !== 'boolean') return noVerdict(f)
        // sameDefectAs is 1-based WITHIN this batch; resolve it to the actual finding while the
        // batch is still in scope. Ignore a self-reference or an out-of-range index rather than
        // trusting it — a bad link would silently merge unrelated defects.
        const k = Number(got.sameDefectAs)
        const twin = Number.isInteger(k) && k >= 1 && k <= group.length ? group[k - 1] : null
        return { finding: f, verdict: got, twin: twin && twin !== f ? twin : null }
      })
    }).catch(() => group.map(noVerdict)),
  ))).flat().filter(Boolean)

  // A skeptic is a gate, not a source of optional annotation. Unknown coverage must not be converted to
  // real=false: that would make a dead, short or duplicate verifier response indistinguishable from a
  // genuine refutation and could make the change mergeable.
  const unknownVerdicts = verdicts.filter(r => r.unknownEvidence)
  if (unknownVerdicts.length) {
    return await fail('review', `adversarial verification produced no unique verdict for ${unknownVerdicts.length} finding(s) — refusing to treat unknown evidence as refuted.`)
  }

  const confirmedRecs = verdicts.filter(r => r.verdict.real && r.verdict.confidence >= 75)
  const verified = confirmedRecs.map(r => r.finding)
  const unconfirmed = verdicts.filter(r => !(r.verdict.real && r.verdict.confidence >= 75))
    .map(r => ({ ...r.finding, verdict: r.verdict }))

  // Collapse the confirmed findings into DEFECTS — the things a fix addresses — using the links the
  // skeptics returned. Multiple reviewers reporting one fault is the design working, but handing
  // fixes-after-review duplicate items makes it fix and gate the
  // same thing repeatedly, and that is the longest phase in the run.
  //
  // This is presentation, never a filter: every finding still reaches fixes-after-review, grouped, and the
  // grouping is advisory — it is told to split a group back apart if the findings are actually distinct. So a
  // wrong link costs a sentence of explanation, never an unfixed bug. Union-find over the links, since a
  // chain (3→2, 2→1) has to land in one group.
  const parent = new Map(verified.map(f => [f, f]))
  const root = f => { while (parent.get(f) !== f) { parent.set(f, parent.get(parent.get(f))); f = parent.get(f) } return f }
  for (const r of confirmedRecs) {
    if (!r.twin || !parent.has(r.twin)) continue      // twin was refuted, or never confirmed
    const a = root(r.finding), b = root(r.twin)
    if (a !== b) parent.set(a, b)
  }
  const defectMap = new Map()
  for (const f of verified) {
    const k = root(f)
    if (!defectMap.has(k)) defectMap.set(k, [])
    defectMap.get(k).push(f)
  }
  const defects = [...defectMap.values()]

  // The one line of the review that has to outlive the worktree. review.md is gitignored and the PR body is
  // told to skip the refuted findings, so without this tally in the PR nothing records they were ever raised.
  // Both numbers stay in the tally on purpose. Reporting only the defect count would read as a WEAKER
  // review than actually happened — the raw count is the only durable record that independent reviewers
  // converged on the same fault, and review.md dies with the worktree.
  const grouped = defects.length < verified.length ? `, which are ${defects.length} distinct defect(s)` : ''
  let reviewTally = `${reviews.length} raw finding(s) across ${reviewers.length} blind reviewer(s) → ${verified.length} confirmed by adversarial verification${grouped}, ${unconfirmed.length} refuted`
  log(`Review: ${reviewTally}.`)

  // review.md, rendered from the surviving findings (+ the unconfirmed record).
  renderReview(dir, verified, unconfirmed)
  updateEpicMd(dir, { phase: 'review → done', log: `review: ${reviewTally}` })

  // ───────────────────────── Phase 4: Fixes after review (auto-apply, no sign-off) ─────────────────────────
  currentPhase = 'triage'
  phase('Fixes after review')

  let triageStatus = 'No confirmed findings — nothing to fix.'
  let triageDeferred = []
  if (verified.length) {
    // Advisory grouping: the same defect, found by several reviewers, arrives as several findings. Naming the
    // groups lets the fixer fix and gate once instead of once per restatement — while every finding is still
    // listed, and it is told to split a group it disagrees with rather than silently honour it.
    const multi = defects.filter(g => g.length > 1)
    const grouping = multi.length
      ? `\nSeveral findings are the SAME underlying defect, reported by different reviewers looking at different files. An independent verifier grouped them; one fix and one gate should resolve each group, so do NOT fix or gate the same fault once per finding:\n${multi.map((g, i) => `- Defect ${i + 1}:\n${g.map(f => `  - "${f.title}" (${f.location})`).join('\n')}`).join('\n')}\nThis grouping is a hint, not an instruction: if the findings in a group are genuinely distinct faults needing separate fixes, treat them separately and say so in your status. Every finding above must still end up either fixed or reported as deferred.\n`
      : ''
    let triaged = await agent(PROMPTS.triage(dir, pkgList(packages), grouping),
      { label: 'fixes-after-review', phase: 'Fixes after review', step: 'fixes-after-review', schema: TRIAGE_SCHEMA },
    )
    // Fail closed: a dead agent leaves confirmed findings in an unknown state — some fixed, some not,
    // verify possibly never re-run — and the merge gate below reads exactly that list to decide whether main
    // gets this change unattended. "We don't know what it left unfixed" must never merge.
    if (!triaged) return await fail('triage', `fixes-after-review produced no result for ${verified.length} confirmed finding(s) — their state is unknown (partially applied fixes may sit in the tree) and the merge gate has nothing to read.`)
    // The gate again: the fixes must leave verify GREEN, by this script's own run.
    let fixGate = await verifyGate('Fixes after review: verify gate')
    if (!fixGate.green) {
      log('Fixes after review: verify is red after the fixes — respawning once with the failure.')
      triaged = await agent(PROMPTS.triage(dir, pkgList(packages), grouping) + PROMPTS.verifyRetry(fixGate),
        { label: 'fixes-after-review:retry', phase: 'Fixes after review', step: 'fixes-after-review', schema: TRIAGE_SCHEMA },
      )
      if (!triaged) return await fail('triage', `fixes-after-review produced no result on its retry for ${verified.length} confirmed finding(s) — their state is unknown and the merge gate has nothing to read.`)
      fixGate = await verifyGate('Fixes after review: verify gate (retry)')
      if (!fixGate.green) return await fail('triage', `npm run verify is red after the fixes and their retry (${fixGate.detail}) — refusing to ship an unverified change.`)
    }
    triageStatus = triaged.status
    triageDeferred = Array.isArray(triaged.deferred) ? triaged.deferred : []
    const fixCheckpoint = await checkpointWork('triage')
    updateEpicMd(dir, { phase: 'review→triaged', log: `fixes-after-review: ${triageStatus} (${fixCheckpoint})` })
  }
  log(`Fixes after review: ${triageStatus}`)

  // ───────────────────────── Post-fix check ─────────────────────────
  // The fixes changed code no reviewer has seen. One skeptic pass over exactly that delta: does each fix
  // resolve its finding, and does the delta introduce a defect of its own? Every bad answer changes the
  // label — the merge gate below holds the PR — never the tree. There is no second fix round, which is
  // what keeps it bounded. Git mode only: manual mode has no checkpoints and no gate.
  const fixBlockers = []
  if (gitMode && verified.length) {
    const fixSha = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')
    const deferredTitles = new Set(triageDeferred.map(d => d.title))
    const fixed = verified.filter(f => !deferredTitles.has(f.title))
    const changed = (await git(['diff', '--quiet', codeSha, fixSha])).code !== 0
    let postFix = null
    if (!changed && fixed.length) {
      // A claimed fix with no diff is not a fix. No model needed to say so.
      fixBlockers.push({
        source: 'claimed-fix-without-delta',
        reason: `${fixed.length} finding(s) reported fixed but the fixes step changed nothing`,
        defectClass: true,
        items: fixed,
      })
      postFix = { confirmed: [], unresolved: fixed.map(f => ({ finding: f, verdict: { resolved: false, confidence: 0, reasoning: 'the fixes step produced no diff' } })), regressions: [], note: 'The fixes step reported fixes but produced no diff' }
    } else if (changed) {
      const c = await agent(PROMPTS.fixCheck(fixed, requirement, `git diff ${codeSha} ${fixSha}`, DIFF),
        { label: 'fix-check', phase: 'Fixes after review', step: 'confirm-review', schema: FIXCHECK_SCHEMA },
      )
      if (!c) {
        // A dead check leaves the fixes unreviewed; the PR is complete and verified, so it waits for a
        // human rather than failing the run.
        fixBlockers.push({ source: 'missing-post-fix-verdict', reason: 'the post-fix check produced no result — the fixes are unreviewed', defectClass: false, items: fixed })
        postFix = { confirmed: [], unresolved: fixed.map(f => ({ finding: f, verdict: { resolved: false, confidence: 0, reasoning: 'the post-fix check produced no result' } })), regressions: [], note: 'The post-fix check produced no result' }
      } else {
        const verdicts = Array.isArray(c.verdicts) ? c.verdicts : []
        const confirmed = []
        const unresolved = []
        fixed.forEach((f, i) => {
          const v = verdicts.find(x => Number(x.index) === i + 1)
          if (v && v.resolved === true && Number(v.confidence) >= 75) confirmed.push({ finding: f, verdict: v })
          else unresolved.push({ finding: f, verdict: v || { resolved: false, confidence: 0, reasoning: 'no verdict returned — recorded as unresolved rather than assumed fixed' } })
        })
        const regressions = (Array.isArray(c.regressions) ? c.regressions : []).filter(r => Number(r.confidence) >= 75)
        if (unresolved.length) fixBlockers.push({
          source: 'unconfirmed-post-review-fix',
          reason: `${unresolved.length} fix(es) not confirmed by the post-fix check (${unresolved.map(u => u.finding.title).join('; ')})`,
          defectClass: true,
          items: unresolved,
        })
        if (regressions.length) fixBlockers.push({
          source: 'post-review-fix-regression',
          reason: `${regressions.length} regression(s) introduced by the fixes (${regressions.map(r => `${r.severity}: ${r.title}`).join('; ')})`,
          defectClass: true,
          items: regressions,
        })
        postFix = { confirmed, unresolved, regressions, note: null }
      }
    }
    if (postFix) {
      renderReview(dir, verified, unconfirmed, postFix)
      const summary = `fix check: ${postFix.confirmed.length}/${fixed.length} fixes confirmed, ${postFix.regressions.length} regression(s)${postFix.note ? ` (${postFix.note.toLowerCase()})` : ''}`
      reviewTally += `; ${summary}`
      updateEpicMd(dir, { log: summary })
      log(`Fix check: ${summary}.`)
    }
  } else if (verified.length) {
    log('Fix check: skipped in manual mode (no checkpoints, no merge gate).')
  }

  // ───────────────────────── Phase 5: Ship ─────────────────────────
  // Issue mode: ship decides what the PR says; the script squashes to one commit (Closes #N), pushes,
  // opens the PR. Slug mode: summary.md only, no git.
  currentPhase = 'ship'
  phase('Ship')

  if (!gitMode) {
    const s = await agent(PROMPTS.summaryManual(dir, design, triageStatus),
      { label: 'summary:write', phase: 'Ship', step: 'code', schema: SUMMARY_SCHEMA },
    )
    if (!s) return await fail('ship', 'the summary was not written.')
    writeFileSync(path.join(dir, 'summary.md'), `${String(s.summary).trim()}\n`)
    updateEpicMd(dir, { phase: 'ship → done', log: 'ship: summary.md written (manual mode, no PR)' })
    return { slug, approach: design?.approach, greenStatus: green, findingsConfirmed: verified.length, findingsUnconfirmed: unconfirmed.length, triageStatus, summary: s.summary }
  }

  const decision = await agent(PROMPTS.ship(dir, issue, design, triageStatus, reviewTally),
    { label: 'ship:pr', phase: 'Ship', step: 'code', schema: SHIP_SCHEMA },
  )
  if (!decision) return await fail('ship', 'Ship produced no PR description — nothing was pushed; the change is on epic/' + slug + ' (checkpoint commits + working tree).')

  // ───────────────────────── Deferral check ─────────────────────────
  // Ship's `kind` per deferral feeds the merge gate, and ship is the builder side. Every item it did
  // not call a defect goes to the skeptic, whose verdict can only escalate: a builder's "defect" stands,
  // a builder's "other" that the skeptic calls a defect becomes one. A dead check holds the PR.
  // This MUST stay ahead of shipTransport: that call writes `ready-to-review`, the run's first terminal
  // label, which opens the reporting window — and runtime's agent() refuses any spawn once it is open,
  // so a check moved below the write would be refused and would hold a PR that had nothing wrong with it.
  const deferralBlockers = []
  const deferred = Array.isArray(decision.deferred) ? decision.deferred : []
  const toCheck = deferred.filter(d => d.kind !== 'defect')
  if (toCheck.length) {
    const c = await agent(PROMPTS.deferralCheck(toCheck, requirement, DIFF),
      { label: 'deferral-check', phase: 'Ship', step: 'confirm-review', schema: DEFERRAL_CHECK_SCHEMA },
    )
    if (!c) {
      deferralBlockers.push({ source: 'missing-deferral-verdict', reason: `the deferral check produced no result — ${toCheck.length} deferred item(s) are unclassified`, defectClass: false, items: toCheck })
      log('Deferral check: produced no result — the PR will be held.')
    } else {
      const verdicts = Array.isArray(c.verdicts) ? c.verdicts : []
      let escalated = 0
      toCheck.forEach((d, i) => {
        const v = verdicts.find(x => Number(x.index) === i + 1)
        if (v && v.defect === true && Number(v.confidence) >= 75) {
          d.checkNote = `reclassified from ${d.kind} to defect by the deferral check (confidence ${v.confidence}): ${v.reasoning}`
          d.kind = 'defect'
          escalated++
        }
      })
      log(`Deferral check: ${toCheck.length} non-defect item(s) re-judged, ${escalated} reclassified as defect(s).`)
      updateEpicMd(dir, { log: `deferral-check: ${toCheck.length} re-judged, ${escalated} reclassified as defects` })
    }
  }

  const shipped = await shipTransport({ issue, slug, dir, decision })
  openPr = shipped.prUrl
  log(`Ship: PR opened — ${shipped.prUrl} (${shipped.deferredCount} deferred item(s), ${shipped.filed} filed as follow-ups)`)

  const result = {
    issue,
    slug,
    branch: `epic/${slug}`,
    prUrl: shipped.prUrl,
    approach: design?.approach,
    findingsConfirmed: verified.length,
    findingsUnconfirmed: unconfirmed.length,
    triageStatus,
    readyToMerge: false,
  }

  // ───────────────────────── The merge gate ─────────────────────────
  // Everything the pipeline could verify is green by here: verify per package (whatever that script gates,
  // including any real-database tier the project triggers for itself), independent review adversarially
  // verified, and the fixes re-verified. What is left is the judgment calls the pipeline explicitly
  // refused to make. Those refusals ARE the gate — a deferred confirmed finding or a defect that outlives
  // this merge is the pipeline saying "a human decides this", and a human cannot decide it after it has
  // already deployed. Counted HERE in the script from structured values, never inside an agent that could
  // talk itself past them.
  //
  // The gate merges nothing; it chooses which terminal label the issue wears, and `bin/merge-worker.sh`
  // acts on that — rebasing onto current main, re-running CI, merging serially per repo. Merging inside
  // the run would park a build slot on a lock while the whole queue waited behind it.
  const mergeBlockers = []
  if (triageDeferred.length) {
    mergeBlockers.push({
      source: 'fixes-after-review-deferral',
      reason: `${triageDeferred.length} confirmed review finding(s) left unfixed by fixes-after-review (${triageDeferred.map(d => `${d.severity}: ${d.title}`).join('; ')})`,
      defectClass: true,
      items: triageDeferred,
    })
  }
  if (shipped.deferredDefects > 0) {
    mergeBlockers.push({
      source: 'ship-deferral',
      reason: `${shipped.deferredDefects} deferred defect(s) that still exist on main after this merge`,
      defectClass: true,
      items: deferred.filter(d => d.kind === 'defect'),
    })
  }
  mergeBlockers.push(...fixBlockers, ...deferralBlockers)

  if (mergeBlockers.length) {
    const why = mergeBlockers.map(b => b.reason).join(' + ')
    let needsDefectFix = false
    if (mergeBlockers.every(b => b.defectClass)) {
      try {
        if (!Number.isInteger(shipped.prNumber)) throw new Error(`could not derive a PR number from ${shipped.prUrl}`)
        const actor = await authenticatedLogin(spend())
        const evidence = {
          version: 1,
          issue,
          pr: { number: shipped.prNumber, url: shipped.prUrl, branch: `epic/${slug}`, head: shipped.prHead },
          requirement: { title: requirementTitle, body: requirementBody },
          blockers: mergeBlockers.map(({ source, reason, items }) => ({ source, reason, items })),
        }
        await comment(issue, renderDefectEvidence(evidence), spend())
        const comments = await issueView(issue, 'comments', spend())
        if (!matchingDefectEvidence(comments.comments, {
          actor, issue, prNumber: shipped.prNumber, branch: `epic/${slug}`, head: shipped.prHead,
        })) throw new Error('canonical defect-fix evidence was not observed after posting')
        await ensureLabels(['ready-to-review', 'needs-defect-fix'], spend())
        const queued = await editLabels(issue, { add: ['ready-to-review', 'needs-defect-fix'] }, spend())
        if (queued.ok) {
          const labels = await issueLabels(issue, spend())
          needsDefectFix = labels.includes('ready-to-review') && labels.includes('needs-defect-fix')
        }
      } catch (e) {
        log(`Merge gate: defect-fixer queue handoff could not be verified (${e && e.message || e}) — the PR remains ready-to-review.`)
      }
    }
    log(`Merge gate: held — ${why}. PR stays ready-to-review for a human.`)
    return { ...result, mergeSkipped: why, ...(needsDefectFix ? { needsDefectFix: true } : {}) }
  }

  // Promotion, never demotion: ship already applied the conservative `ready-to-review`, so every way this
  // step can go wrong leaves the issue in front of a human rather than in an unattended merge queue. That
  // asymmetry is the reason it is a separate step instead of something ship decided for itself.
  let handed
  try {
    handed = await handoff(issue, dir)
  } catch (e) {
    // A throw leaves the labels unaccounted for, and an unaccounted-for state is never a resting one:
    // it takes the same blocker path below as a demotion that could not be proved.
    const summary = e && e.message || String(e)
    handed = { labelled: false, summary, unresolved: summary }
  }
  // Neither confirmed nor undone: the issue may be wearing the label the merge worker selects on while
  // this run is about to report the PR as held. That is not a resting state, so it blocks — and the
  // blocker's own transition derives its removals from `failed`, taking `ready-to-merge` off once more.
  if (handed.unresolved) {
    return await fail('merge gate', `the merge gate was clear, but the promotion to ready-to-merge could not be verified and the fallback to ready-to-review could not be verified either: ${handed.unresolved}. Read this issue's labels by hand before anything else: bin/merge-worker.sh selects on ready-to-merge alone.`)
  }
  if (!handed.labelled) {
    const why = `merge gate was clear but ready-to-merge could not be applied${handed.summary ? ` (${handed.summary})` : ''} — the PR is complete and stays ready-to-review`
    log(`Merge gate: clear, handoff FAILED — ${why}.`)
    return { ...result, mergeSkipped: why }
  }
  log(`Merge gate: clear — #${issue} is ready-to-merge (${handed.summary}); bin/merge-worker.sh owns it from here.`)

  return { ...result, readyToMerge: true }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

const RESULT = await main()
// Best effort, and awaited so the edit lands before the process goes: this is the
// last thing the issue page will show until a human or the merge worker acts.
await statusFinish(RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToMerge ? `**done** — ${RESULT.prUrl} queued for the merge worker` : RESULT?.prUrl ? `**done, held for review** — ${RESULT.prUrl} (${RESULT.mergeSkipped})` : '**finished**')
process.exit(finish(RESULT))
