#!/usr/bin/env node
// epic-run — autonomous issue-to-PR delivery: prepare → architect → code →
// review → fixes after review → ship, no sign-offs.
//
// Issue mode (`--issue N`): preflight (closed? blocked_by?) → branch
// epic/<N>-<slug> off origin/main and claim it by pushing the ref (atomic; a
// run that loses the race skips), resuming an existing branch when one is left
// over — and skipping architect and code when that branch already carries a
// code checkpoint → checkpoint commits after code/fixes → squashed single-commit PR at
// ship + blocker-comment → merge gate labels the issue ready-to-merge when
// nothing was deferred, ready-to-review when a human must decide.
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
// the review lenses and their skeptic, the fixes, and what the PR says.
//
// `npm run verify` is likewise the orchestrator's to run: after the red step
// it must be red (tests that pass against no implementation test nothing),
// after green and after fixes it must be green. An agent's word that it ran
// is never the gate; a wrong answer is handed back to that agent once, with
// the output, then blocks the run.
//
// The fixes themselves get one skeptic pass (fix-check) over exactly the
// delta they produced. A fix the skeptic cannot confirm, a regression, a dead
// check or a claimed fix with no diff holds the PR at ready-to-review; none
// of them starts a second fix round, which is what keeps it bounded.
//
// Ship's deferrals go through the same skeptic before the merge gate counts
// them: every item ship did not call a defect is re-judged, and the skeptic
// can only escalate. The builder side never has the last word on whether a
// deferred item is a defect.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { agent, parallel, phase, log, initRuntime, onPhase, onLog } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { failureReason, must } from './lib/proc.mjs'
import {
  ensureLabels, editLabels, issueLabels, issueView, openBlockers, comment, assignSelf,
  openPrs, searchOpenPrs, prCreate, issueCreate, withBodyFile, hasDeferredRecord,
} from './lib/github.mjs'
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

Your output is schema-enforced JSON — populate every field, do not cram everything into one:
- approach: a SHORT name for the design (3-6 words), used as its audit label.
- rationale: 2-4 sentences on the core idea and why it fits this codebase.
- steps: ordered build steps (one string per step); note which are independent vs. must serialize because they touch the same files.
- files: files to create or modify (one per string, with a few words on what changes).
- contract: the public contract / API surface, explicit enough that tests can be written against it WITHOUT seeing the implementation.
- tradeoffs: what this approach deliberately accepts.`,

  codeRed: (dir) =>
`Code phase, RED step. Write tests ONLY (no implementation). Read ${dir}/requirements.md and ${dir}/architecture.md, and derive tests from the requirements + the public contract/API surface. Cover what is genuinely testable in this stack (units, pure logic, backend handlers, frontend component behavior); for hard-to-test surfaces (canvas/visual, external I/O), SKIP and note in ${dir}/epic.md what is uncovered and why — do not fake a test.
Return the list of test files you created and a one-line confirmation they fail for the right reason. The pipeline then runs \`npm run verify\` itself and expects it to be red.`,

  codeGreen: (dir, red, pkgs) =>
`Code phase, GREEN step. Read ${dir}/architecture.md and ${dir}/requirements.md and the existing failing tests:
${red}

Implement the feature to make those tests pass, following architecture.md's build steps. Note any scope decision or wrong-test fix in ${dir}/epic.md's phase log. Run \`npm run verify\` in EACH touched package (this repo's packages: ${pkgs}) until green — that script is the project's whole gate, so whatever it runs (including any real-database tier it triggers for itself) has to be green, not just the unit tests.
Leave everything in the working tree: do NOT commit or push; the pipeline checkpoints your work itself, and re-runs \`npm run verify\` after you return — a red run comes back to you once, then blocks the run. Return a short status: packages verified green, and any in-flight decisions or remaining failures you could not resolve.`,

  review: (requirement, lens, diffCmd) =>
`Review this change for the lens: ${lens}.

Requirement to judge against — this is the ONLY spec context you get; reconstruct expected behavior from it + the diff alone:
"""
${requirement}
"""

Read \`${diffCmd}\` / \`${diffCmd} --stat\` and the source tree to judge the change. Do NOT open ANY file under \`.epics/\` — architecture.md, epic.md, review.md and summary.md all encode the builder's intended behavior and would anchor you; you have the requirement above and do not need that directory.
If nothing meets your confidence bar, return an empty findings array.`,

  verify: (findings, diffCmd) =>
`Adversarially verify ${findings.length === 1 ? 'a code-review finding' : `${findings.length} code-review findings reported against this change`}. Default to refuting each unless the code clearly bears it out.

${findings.map((f, i) => `--- Finding ${i + 1} ---
Title: ${f.title}
Severity: ${f.severity}
Location: ${f.location}
Claim: ${f.problem}`).join('\n\n')}

Read the relevant code and \`${diffCmd}\`. Do NOT open anything under \`.epics/\` — it carries the builder's intent and would anchor you. For each finding, determine whether the claim genuinely holds (real) or is a false positive / already handled (not real). Set real=false if you cannot confirm it against the actual code.

Return exactly ${findings.length} verdict${findings.length === 1 ? '' : 's'} — one per finding — with \`index\` set to that finding's number above (${findings.length === 1 ? '1' : `1-${findings.length}`}).${findings.length > 1 ? `

These were reported independently by different review lenses, so several may be one defect restated in different words, often pointing at DIFFERENT files (the component, the gate that guards it, its test, the doc describing it). Judge each on its own merits: if two are the same defect, set \`sameDefectAs\` on the LATER one to the earlier one's number and let them stand or fall together — do NOT mark one not-real merely because it overlaps another. Group only findings ONE fix would genuinely resolve together; two distinct bugs that happen to sit in the same function are NOT the same defect.` : ''}`,

  triage: (dir, pkgs, grouping) =>
`Fixes-after-review phase, autonomous (NO user sign-off). Read ${dir}/review.md and the diff. Apply fixes for the CONFIRMED findings only, highest severity first — NEVER act on anything under "## Unconfirmed — not fixed" (those were refuted; they are listed for human eyes only). For every finding you fix, also add the automated check that would catch its whole CLASS, not just the instance in front of you — a test, a type, a lint rule, or a shared helper that makes the footgun impossible. Every review finding is a missing gate. Where this project's AGENTS.md states its own harden-the-gate rule, follow that wording; this instruction stands on its own where it does not.
When the check that would catch a class is NOT expressible as a test/type/lint but is a convention (a rule about how to write something, a footgun only a human would know to avoid), write the rule into THIS project's own instructions instead: the relevant section of its AGENTS.md — the root one, or the per-directory AGENTS.md covering the code in question (or a \`.claude/rules/*.md\` file where this project still keeps those) — in the file's existing voice and length. Those are the only places you may write a rule. The skills, agents and this pipeline are shared harness files that live outside this repo and are used by other projects: a rule that belongs to one of them is out of scope for an epic, so do NOT edit or recreate one — record it as DEFERRED in ${dir}/epic.md's phase log, stating the rule you would have written and which harness file it belongs in, and leave the harness untouched. Note every amendment or deferral in ${dir}/epic.md's phase log so it surfaces in the PR body.
If a finding is genuinely too risky or expensive to fix safely without a human decision, DO NOT guess — leave it, and record it as deferred (with why) in ${dir}/epic.md's phase log so the summary surfaces it.
${grouping}After fixes, re-run \`npm run verify\` in each touched package (this repo's packages: ${pkgs}) until green.
Leave everything in the working tree: do NOT commit or push; the pipeline checkpoints your work itself, and re-runs \`npm run verify\` after you return — a red run comes back to you once, then blocks the run. Return:
- status: a short summary — which findings were fixed, which were deferred and why, and the final verify result.
- deferred: one entry per CONFIRMED finding you did NOT fix; empty array when you fixed them all. This list is a MERGE GATE: an empty list queues the PR to be merged to main unattended, so omitting something you left unfixed ships it. Report every one.`,

  // Appended to a step's own prompt when the orchestrator's verify run disagreed with it.
  redRetry: (gate) =>
`

The pipeline ran \`npm run verify\` after your previous RED step and it came back GREEN (${gate.detail}): the tests you wrote pass against a tree with NO implementation, so they test nothing. This is your one retry. Rewrite them so they fail for the right reason — an unmet assertion against the public contract in architecture.md — and confirm they fail before you return.`,

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
  // the one diff no lens has seen.
  fixCheck: (fixed, deltaCmd, diffCmd) =>
`Check the fixes applied after review — you did not write them. An automated fixes-after-review step edited the change after five review lenses had judged it; its edits are exactly \`${deltaCmd}\` (also readable with --stat), applied on top of the reviewed change \`${diffCmd}\`. ${fixed.length ? `It reports these ${fixed.length} confirmed review finding(s) as FIXED:` : 'It reports no finding as fixed; check its edits for regressions only.'}

${fixed.map((f, i) => `--- Finding ${i + 1} ---
Title: ${f.title}
Severity: ${f.severity}
Location: ${f.location}
Claim: ${f.problem}
Recommended fix: ${f.fix}`).join('\n\n')}

Two questions, refute-by-default:
1. For each finding above: does the delta genuinely remove the defect? resolved=true only if the code now behaves correctly for the case the finding names. A test weakened, skipped or deleted so the finding no longer shows is NOT a fix, and neither is a comment or a suppression. resolved=false whenever you cannot confirm it against the code.
2. Regressions: any defect the delta introduces that the reviewed change did not have — a behavior change outside the finding's scope, a dropped side effect, a broken neighbour, a new null path. Same bar as a review finding: report only what you are at least 75 confident of, with file:line, the problem, a concrete fix and the gate that would catch its class.

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
   - file: whether it earns a follow-up issue. Filing is the EXCEPTION, not the default — the record the pipeline posts on the issue costs nothing, and an over-filed item rots in the backlog forever. true ONLY if the kind is defect, missing-gate or scope-cut AND it passes the slicing test: could ONE coherent PR close it and still mean something on its own? "Decide whether to X", "consider Y", "investigate Z" all FAIL — a question is not a mergeable change. The pipeline files at most 3, defects first, and notes in the record when more qualified: needing more than 3 means the issue was under-scoped, and that count is the signal.
   - issueTitle and issueBody, for file=true: a clear title, and a body saying what it is and why it was deferred. The pipeline appends the \`Follow-up to #${issue}\` line and applies no label.`,

  summaryManual: (dir, design, triageStatus) =>
`Write the run's summary and return it in the "summary" field, as markdown. This is the manual flow — do NOT commit, push, or open a PR; leave all changes in the working tree.
Capture, against ${dir}/requirements.md: what was built; the architecture approach — "${design?.approach}": ${design?.rationale}; files modified (\`git diff --stat\`); verify status per package; review outcome (findings that survived verification, which were fixed, which were DEFERRED and why — read ${dir}/review.md and ${dir}/epic.md); anything deferred or out of scope; a suggested next step. Fixes-after-review status: ${triageStatus}`,
}

// ───────────────────────── Config ─────────────────────────
// Every agent() call below names one STEP (lib/engine.mjs STEPS); which vendor, model and effort runs it is
// that step's row in the run's engine in etc/engines.json (--engine, or the issue's engine:<name> label).
// What a row is written against:
// architect — designs the epic in one pass. It is the one step that fixes the shape of everything downstream
// (red writes its tests from that contract), so a weak call here is the most expensive kind.
// code — red, green, and ship's judgment half (what the PR says, what was deferred and of what kind, the
// project's own legal trigger). Ship's `kind` per deferral feeds the merge gate, which is why it is not a
// cheaper row.
// confirm-review — the adversarial verifier is the last judgment before fixes-after-review AUTO-APPLIES a fix
// with no human sign-off, so a wrong "real" here becomes a committed change and a wrong "not real" buries a
// live bug. It runs once per batch (a handful of spawns), not once per lens, which is what makes
// upgrading it cheap.
// review — the five finders drive recall, and more cheap finders beat fewer expensive ones. If recall proves
// weak, add a sixth lens rather than upgrading the existing five.

// This pipeline used to run its own real-database gate: an agent listed the changed paths, the script
// path-matched them, and a second agent ran the project's `test:db` suite. That whole tier is gone — the
// real-DB check now lives inside each project's `npm run verify`, triggered by a bash gate in the repo
// that diffs the paths itself. It is strictly better there: no agent in the loop to misjudge or misreport
// it, and CI runs `verify` too, so it also covers manual commits to main — which an in-pipeline gate could
// never reach. "verify green" now IMPLIES the real tier ran wherever it was needed, which is why nothing
// downstream attests to it separately.

// Lens 3 watches the boundary between the repo's halves — whichever two the repo actually has
// (frontend↔backend, frontend↔worker). Derived from the discovered package list, since a seam named for
// a package this repo does not have points the reviewer at nothing.
const reviewLenses = (pkgs) => [
  'correctness + concurrency (logic errors, null/undefined, races, dropped side-effects)',
  'simplicity + DRY + project conventions',
  pkgs.length > 1
    ? `test honesty + the ${pkgs.join('↔')} seam (a bug that spans the package boundary, each side correct-looking alone)`
    : 'test honesty + module seams (a bug that spans two modules, each correct-looking alone)',
  'requirements coverage / acceptance (walk EVERY requirement in the spec above one by one: verify the diff actually delivers it, and flag anything unmet, partially met, or silently narrowed)',
  'security + authorization (tenant/owner scoping on EVERY read and write, secret and token handling, injection, unsafe trust of client input)',
]

// ───────────────────────── Schemas ─────────────────────────
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approach', 'rationale', 'steps', 'files', 'contract', 'tradeoffs'],
  properties: {
    approach: { type: 'string', description: 'SHORT name for the design (3-6 words), used as its audit label' },
    rationale: { type: 'string', description: '2-4 sentences: the core idea and why it fits this codebase' },
    steps: { type: 'array', items: { type: 'string' }, description: 'ordered build steps; note which are independent vs. must serialize' },
    files: { type: 'array', items: { type: 'string' }, description: 'files to create/modify, each with a few words on what changes' },
    contract: { type: 'string', description: 'public contract / API surface, explicit enough to write tests against without the implementation' },
    tradeoffs: { type: 'string', description: 'what this approach deliberately accepts' },
  },
}
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
          gate: { type: 'string', description: 'the automated check that would catch this whole class next time' },
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

const LIFECYCLE = ['in-progress', 'ready-to-merge', 'ready-to-review', 'failed']

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
    // A code checkpoint on the branch means an earlier run finished design and implementation; the
    // expensive phases are not repeated, the verify gate re-proves the tree and review takes it from there.
    const subjects = (await gitOut(['log', '--format=%s', 'origin/main..HEAD'], 'git log')).split('\n')
    codeDone = subjects.some(s => new RegExp(`^wip\\(epic ${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\): (code|triage) checkpoint$`).test(s.trim()))
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
  const swap = await editLabels(issue, { add: ['in-progress'], remove: ['ready', 'ready-to-merge', 'ready-to-review', 'failed'] })
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
  return { slug, branch, resumed, codeDone, requirement: readRequirements(dir), packages, depLines }
}

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

  // Deferred work is recorded on the ISSUE, not the PR — and only now that the PR exists.
  // Everything above is idempotent under a re-run (the branch is rebuilt, the push is a lease, and
  // prepare's open-PR guard stops the second run outright); a filed issue and a posted comment are
  // not. Creating them first meant a ship that died before the PR left duplicates behind for the
  // retry to add to, so they go last, and a record already on the issue is left alone rather than
  // doubled. A follow-up issue is filed only for the kinds that can earn one, only when ship judged
  // it a coherent slice, and at most 3 — defects first. That "Follow-up to #N" line IS the relation
  // (GitHub records it as a cross-reference); no label, no blocked_by, no sub-issue.
  let filed = 0
  if (deferred.length) {
    if (await hasDeferredRecord(issue)) {
      log('Ship: a deferred record from an earlier attempt is already on the issue — left as it is')
    } else {
      const rank = { defect: 0, 'missing-gate': 1, 'scope-cut': 2 }
      const eligible = deferred.filter(d => d.file === true && d.kind in rank).sort((a, b) => rank[a.kind] - rank[b.kind])
      const links = new Map()
      for (const d of eligible.slice(0, 3)) {
        const url = await issueCreate({ title: d.issueTitle || d.title, body: `${String(d.issueBody || d.why).trim()}\n\nFollow-up to #${issue}` })
        links.set(d, url)
        filed++
      }
      const lines = ['🤖 deferred / not done', '']
      for (const d of deferred) lines.push(`- ${d.title} (${d.kind}): ${d.why}${d.checkNote ? ` — ${d.checkNote}` : ''}${links.has(d) ? ` — filed as ${links.get(d)}` : ''}`)
      if (eligible.length > filed) lines.push('', `${eligible.length} items qualified for a follow-up issue and ${filed} were filed (the cap is 3): needing more means this issue was under-scoped.`)
      await comment(issue, lines.join('\n'))
    }
  }

  // ready-to-review and nothing else: whether the PR may instead be queued for unattended merge is
  // the gate's decision, downstream of here. The assignee stays (it records ownership).
  await ensureLabels(['ready-to-review'])
  const flip = await editLabels(issue, { add: ['ready-to-review'], remove: ['in-progress'] })
  if (!flip.ok) log(`Ship: label flip to ready-to-review failed (${failureReason(flip)}) — the PR is open; a human finishes the labels`)
  updateEpicMd(dir, { phase: 'ship → done', log: `ship: PR opened ${prUrl}; ${deferred.length} deferred item(s), ${filed} filed, ${deferredDefects} defect(s)` })
  return { prUrl, deferredDefects, deferredCount: deferred.length, filed }
}

// Transport, not judgment: the merge gate has already been computed from structured counts, and this
// only writes its verdict where bin/merge-worker.sh will read it. Verified by reading the labels
// back: labelled=true only when ready-to-merge is on and ready-to-review is off.
async function handoff(issue, dir) {
  await ensureLabels(['ready-to-merge'])
  const r = await editLabels(issue, { add: ['ready-to-merge'], remove: ['ready-to-review'] })
  if (!r.ok) return { labelled: false, summary: failureReason(r) }
  const labels = await issueLabels(issue)
  const labelled = labels.includes('ready-to-merge') && !labels.includes('ready-to-review')
  if (labelled) updateEpicMd(dir, { log: 'handoff: queued for merge-worker' })
  return { labelled, summary: labelled ? 'ready-to-merge observed' : `observed labels: ${labels.join(', ')}` }
}

// The blocker report: preserve the work, say where it is, flip the label to failed.
async function postBlocker({ issue, slug, phase, reason, prUrl }) {
  const branch = slug ? `epic/${slug}` : null
  let branchLine
  if (prUrl) {
    // A block AFTER ship: the PR is open, pushed and complete — the work needs a human, not
    // preservation, and a re-run would skip it (prepare's open-PR guard) rather than resume.
    branchLine = `- PR: ${prUrl} — open on ${branch}, NOT merged and NOT queued for the merge worker; the change itself is complete. Fix the cause above, then merge it by hand. A re-run of /epic #${issue} will skip (an open PR already delivers this issue).`
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
  await comment(issue, body)
  // Every terminal label comes off — ready-to-merge above all, since leaving it would hand a failed
  // run's PR to the merge worker. The assignee stays.
  await ensureLabels(['failed'])
  const flip = await editLabels(issue, { add: ['failed'], remove: ['in-progress', 'ready-to-merge', 'ready-to-review'] })
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
// are the deferred list (nothing else records it) and the blocker report.

let requirement
// True when the resumed branch already carries a code checkpoint: architect, red and green are skipped.
let codeDone = false
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
    codeDone = !!prep.codeDone
    log(`Prepare: requirements written, branch epic/${slug} ${prep.resumed ? 'resumed and rebased onto origin/main' : 'created off origin/main'}${codeDone ? ' (a code checkpoint is on it)' : ''}, deps checked (${prep.depLines.join('; ')}). Packages: ${pkgList(packages)}.`)
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
    // The design was made by the run that left the checkpoint. Its architecture.md survives when the
    // worktree was reused (the host reuses one per issue); otherwise the PR body says where the
    // approach came from.
    const archFile = path.join(dir, 'architecture.md')
    const m = existsSync(archFile) ? readFileSync(archFile, 'utf8').match(/^Approach: (.+?) — (.+)$/m) : null
    design = m ? { approach: m[1], rationale: m[2] } : { approach: 'resumed from a code checkpoint', rationale: 'design and implementation were completed by an earlier run of this branch.' }
    updateEpicMd(dir, { phase: 'architect → skipped', approach: design.approach, log: 'architect: skipped, the branch carries a code checkpoint' })
    log(`Architect: skipped — the branch carries a code checkpoint (${design.approach}).`)
  } else {
    design = await agent(PROMPTS.architectDesign(dir),
      { label: 'architect:design', phase: 'Architect', step: 'architect', schema: DESIGN_SCHEMA },
    )
    if (!design) return await fail('architect', 'Architect design failed — aborting before code.')

    // Rendered here from the decided design: red and green both read architecture.md, so it exists
    // before either runs, verbatim to what the architect returned.
    renderArchitecture(dir, design)
    updateEpicMd(dir, { phase: 'architect → done', approach: design.approach, log: `architect: ${design.approach}` })
    if (!existsSync(path.join(dir, 'architecture.md'))) return await fail('architect', 'architecture.md was not written — aborting before code, which reads it.')
    log(`Architecture: ${design.approach} — ${design.rationale}`)
  }

  // ───────────────────────── Phase 2: Code (red → green → checkpoint) ─────────────────────────
  currentPhase = 'code'
  phase('Code')

  // The verify gate, run here. A step's own verify run is its feedback loop; this one is the verdict.
  const verifyGate = async (label) => {
    const v = await runVerify(packages)
    log(`${label}: verify ${v.green ? 'green' : 'RED'} — ${v.detail}`)
    return v
  }

  // Red: tests only, written blind to any implementation (none exists yet), from requirements + the public
  // contract. Then the gate: verify must be RED. Green here means the tests pass against no implementation
  // — they test nothing, and every later gate would be verifying against them. Necessary, not sufficient:
  // an exit code cannot tell an unmet assertion from a missing import, which is why the prompt still asks
  // the agent to confirm the reason.
  let red = null
  let green = null
  let gate
  if (codeDone) {
    // The checkpoint is the implementation. Re-prove it rather than trust it: the branch was rebased
    // onto a main that may have moved, so the gate runs exactly as it would after green.
    log('Code: resumed from a code checkpoint — architect, red and green skipped; re-running the verify gate.')
    red = 'the tests already on this branch'
    green = 'resumed from a code checkpoint'
    gate = await verifyGate('Code: verify gate (resumed)')
  } else {
    red = await agent(PROMPTS.codeRed(dir),
      { label: 'code:red', phase: 'Code', step: 'code' },
    )
    if (!red) return await fail('code', 'Red step failed — no tests written, aborting before implementation.')
    gate = await verifyGate('Code: red gate')
    if (gate.green) {
      log('Code: the red tests pass against a tree with no implementation — respawning the red step once.')
      red = await agent(PROMPTS.codeRed(dir) + PROMPTS.redRetry(gate),
        { label: 'code:red:retry', phase: 'Code', step: 'code' },
      )
      if (!red) return await fail('code', 'Red step failed on its retry — no tests written, aborting before implementation.')
      gate = await verifyGate('Code: red gate (retry)')
      if (gate.green) return await fail('code', `the red tests pass before any implementation exists, twice (${gate.detail}) — they do not test the change, so nothing downstream would be verified against it.`)
    }
    log('Code: red tests written; verify is red as it should be.')

    // Green: implement against architecture + the red tests, then pass the gate. Single agent to keep the
    // working tree coherent. Then the gate: verify must be GREEN, by this script's own run.
    green = await agent(PROMPTS.codeGreen(dir, red, pkgList(packages)),
      { label: 'code:green', phase: 'Code', step: 'code' },
    )
    if (!green) return await fail('code', 'Green step failed — implementation did not complete, aborting before review.')
    gate = await verifyGate('Code: verify gate')
  }
  if (!gate.green) {
    log('Code: verify is red after the green step — respawning green once with the failure.')
    green = await agent(PROMPTS.codeGreen(dir, red, pkgList(packages)) + PROMPTS.verifyRetry(gate),
      { label: 'code:green:retry', phase: 'Code', step: 'code' },
    )
    if (!green) return await fail('code', 'Green step failed on its retry — implementation did not complete, aborting before review.')
    gate = await verifyGate('Code: verify gate (retry)')
    if (!gate.green) return await fail('code', `npm run verify is red after the green step and its retry (${gate.detail}) — refusing to review an unverified change.`)
  }
  const codeCheckpoint = await checkpointWork('code')
  const codeSha = gitMode ? await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD') : null
  updateEpicMd(dir, { phase: 'code → done', log: `code: done (${codeCheckpoint})` })
  log(`Code: implementation complete, verify gate run, work checkpointed (${codeCheckpoint}).`)

  // ───────────────────────── Phase 3: Review (blind, adversarially verified) ─────────────────────────
  currentPhase = 'review'
  phase('Review')

  // Built here, not at module scope: lens 3's seam names the packages discovery actually found.
  const LENSES = reviewLenses(packages)

  // A finder that DIED must never look like a finder that found nothing. Coercing a null agent straight to []
  // hands the rest of the phase a clean bill of health for a lens that never ran, and the tally then ASSERTS a
  // full N-lens review in the PR body — the diff ships looking reviewed through a lens it never saw. The
  // runtime respawns a transient death once; after that, fail closed: review is the only gate between code
  // and an auto-opened PR, so a hole in it stops the run.
  const shortLens = i => LENSES[i].split(' (')[0]
  const runLens = async (lens, i) => {
    const r = await agent(PROMPTS.review(requirement, lens, DIFF),
      { label: `review:${i}`, phase: 'Review', step: 'review', schema: FINDINGS_SCHEMA },
    ).catch(() => null)
    if (r && Array.isArray(r.findings)) return r.findings
    return null // sentinel: the lens died. Distinct from [], which means "ran, found nothing".
  }

  const lensResults = await parallel(LENSES.map((lens, i) => () => runLens(lens, i)))
  const deadLenses = lensResults.map((r, i) => (r === null ? i : -1)).filter(i => i >= 0)
  if (deadLenses.length) {
    return await fail('review', `${deadLenses.length} of ${LENSES.length} review lenses produced no result after a respawn (${deadLenses.map(shortLens).map(n => `"${n}"`).join(', ')}) — the diff was never reviewed through them. Refusing to ship a PR whose body would claim a full ${LENSES.length}-lens review.`)
  }
  const reviews = lensResults.flat()

  // Soft dedup before the verify fan-out (free — reviews is already fully materialized). Overlapping lenses
  // (correctness vs. the seam lens) can restate the same defect, which otherwise gets verified twice, listed
  // twice in review.md, and fixed twice. Collapse ONLY a confident duplicate — same location AND same
  // normalized title. Biased toward keeping: when in doubt we keep both, so distinct bugs at one file:line
  // survive (different titles) and nothing is ever dropped on location alone.
  const seen = new Set()
  const uniqueReviews = reviews.filter(f => {
    const k = `${(f.location || '').trim()}::${(f.title || '').trim().toLowerCase().replace(/\s+/g, ' ')}`
    return seen.has(k) ? false : seen.add(k)
  })
  // Cluster by FILE (line numbers stripped) before the adversarial fan-out. The title dedup above only catches
  // verbatim restatements; overlapping lenses (correctness vs. the seam lens) word one defect differently and
  // slip through. On #194 that put five paraphrases of a single history.ts bug in front of five separate
  // skeptics, each re-reading the same diff to re-confirm it. One skeptic per batch pays that cost once and can
  // see the claims are one defect — a call the per-finding verifiers each had to make blind. Verdicts stay PER
  // FINDING: clustering changes who judges, never what survives.
  // Batches are sized, NOT keyed by file. Keying by file was the first version of this and it only caught
  // restatements that happen to land in the same file; on #69 one defect ("a parseable-but-unusable schedule
  // renders no rate fields and does not block submit") arrived from four lenses pointing at a component, a
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
  log(`Review: ${reviews.length} raw finding(s) across ${LENSES.length} lenses; adversarially verifying ${uniqueReviews.length} in ${batches.length} batch(es) of up to ${MAX_BATCH}.`)

  // Adversarial verify: an independent skeptic tries to REFUTE each finding before it counts. Refuted /
  // low-confidence findings are NOT silently dropped — they land in review.md's "Unconfirmed" section for
  // human eyes (fixes-after-review and ship are told to ignore them). Fail closed on a missing verdict: batching means
  // a dead agent or a short array would otherwise take a whole batch's findings with it, and a lost finding
  // must surface as unconfirmed (a human re-checks it), never vanish and never pass as confirmed.
  const noVerdict = f => ({
    finding: f,
    verdict: { real: false, confidence: 0, reasoning: 'Batched verifier returned no verdict for this finding — recorded as unconfirmed rather than dropped. Re-check by hand.' },
  })
  const verdicts = (await parallel(batches.map((group, bi) => () =>
    agent(PROMPTS.verify(group, DIFF),
      { label: `verify:${bi + 1}/${batches.length}`, phase: 'Review', step: 'confirm-review', schema: VERDICT_SCHEMA },
    ).then(v => group.map((f, i) => {
      const got = v && Array.isArray(v.verdicts) ? v.verdicts.find(x => Number(x.index) === i + 1) : null
      if (!got || typeof got.real !== 'boolean') return noVerdict(f)
      // sameDefectAs is 1-based WITHIN this batch; resolve it to the actual finding while the
      // batch is still in scope. Ignore a self-reference or an out-of-range index rather than
      // trusting it — a bad link would silently merge unrelated defects.
      const k = Number(got.sameDefectAs)
      const twin = Number.isInteger(k) && k >= 1 && k <= group.length ? group[k - 1] : null
      return { finding: f, verdict: got, twin: twin && twin !== f ? twin : null }
    })).catch(() => group.map(noVerdict)),
  ))).flat().filter(Boolean)

  const confirmedRecs = verdicts.filter(r => r.verdict.real && r.verdict.confidence >= 75)
  const verified = confirmedRecs.map(r => r.finding)
  const unconfirmed = verdicts.filter(r => !(r.verdict.real && r.verdict.confidence >= 75))
    .map(r => ({ ...r.finding, verdict: r.verdict }))

  // Collapse the confirmed findings into DEFECTS — the things a fix addresses — using the links the
  // skeptics returned. Five lenses reporting one fault is the design working (it is how #66's migration
  // bug was caught five times over), but handing fixes-after-review five items makes it fix and gate the
  // same thing five times, and that is the longest phase in the run.
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
  // review than actually happened — the raw count is the only durable record that N independent lenses
  // converged on the same fault, and review.md dies with the worktree.
  const grouped = defects.length < verified.length ? `, which are ${defects.length} distinct defect(s)` : ''
  let reviewTally = `${reviews.length} raw finding(s) across ${LENSES.length} blind lenses → ${verified.length} confirmed by adversarial verification${grouped}, ${unconfirmed.length} refuted`
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
    // Advisory grouping: the same defect, found by several lenses, arrives as several findings. Naming the
    // groups lets the fixer fix and gate once instead of once per restatement — while every finding is still
    // listed, and it is told to split a group it disagrees with rather than silently honour it.
    const multi = defects.filter(g => g.length > 1)
    const grouping = multi.length
      ? `\nSeveral findings are the SAME underlying defect, reported by different review lenses looking at different files. An independent verifier grouped them; one fix and one gate should resolve each group, so do NOT fix or gate the same fault once per finding:\n${multi.map((g, i) => `- Defect ${i + 1}:\n${g.map(f => `  - "${f.title}" (${f.location})`).join('\n')}`).join('\n')}\nThis grouping is a hint, not an instruction: if the findings in a group are genuinely distinct faults needing separate fixes, treat them separately and say so in your status. Every finding above must still end up either fixed or reported as deferred.\n`
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
  // The fixes changed code no lens has seen. One skeptic pass over exactly that delta: does each fix
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
      fixBlockers.push(`${fixed.length} finding(s) reported fixed but the fixes step changed nothing`)
      postFix = { confirmed: [], unresolved: fixed.map(f => ({ finding: f, verdict: { resolved: false, confidence: 0, reasoning: 'the fixes step produced no diff' } })), regressions: [], note: 'The fixes step reported fixes but produced no diff' }
    } else if (changed) {
      const c = await agent(PROMPTS.fixCheck(fixed, `git diff ${codeSha} ${fixSha}`, DIFF),
        { label: 'fix-check', phase: 'Fixes after review', step: 'confirm-review', schema: FIXCHECK_SCHEMA },
      )
      if (!c) {
        // A dead check leaves the fixes unreviewed; the PR is complete and verified, so it waits for a
        // human rather than failing the run.
        fixBlockers.push('the post-fix check produced no result — the fixes are unreviewed')
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
        if (unresolved.length) fixBlockers.push(`${unresolved.length} fix(es) not confirmed by the post-fix check (${unresolved.map(u => u.finding.title).join('; ')})`)
        if (regressions.length) fixBlockers.push(`${regressions.length} regression(s) introduced by the fixes (${regressions.map(r => `${r.severity}: ${r.title}`).join('; ')})`)
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
  const deferralBlockers = []
  const deferred = Array.isArray(decision.deferred) ? decision.deferred : []
  const toCheck = deferred.filter(d => d.kind !== 'defect')
  if (toCheck.length) {
    const c = await agent(PROMPTS.deferralCheck(toCheck, requirement, DIFF),
      { label: 'deferral-check', phase: 'Ship', step: 'confirm-review', schema: DEFERRAL_CHECK_SCHEMA },
    )
    if (!c) {
      deferralBlockers.push(`the deferral check produced no result — ${toCheck.length} deferred item(s) are unclassified`)
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
  // including any real-database tier the project triggers for itself), five blind lenses adversarially
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
    mergeBlockers.push(`${triageDeferred.length} confirmed review finding(s) left unfixed by fixes-after-review (${triageDeferred.map(d => `${d.severity}: ${d.title}`).join('; ')})`)
  }
  if (shipped.deferredDefects > 0) {
    mergeBlockers.push(`${shipped.deferredDefects} deferred defect(s) that still exist on main after this merge`)
  }
  mergeBlockers.push(...fixBlockers, ...deferralBlockers)

  if (mergeBlockers.length) {
    const why = mergeBlockers.join(' + ')
    log(`Merge gate: held — ${why}. PR stays ready-to-review for a human.`)
    return { ...result, mergeSkipped: why }
  }

  // Promotion, never demotion: ship already applied the conservative `ready-to-review`, so every way this
  // step can go wrong leaves the issue in front of a human rather than in an unattended merge queue. That
  // asymmetry is the reason it is a separate step instead of something ship decided for itself.
  let handed
  try {
    handed = await handoff(issue, dir)
  } catch (e) {
    handed = { labelled: false, summary: e && e.message || String(e) }
  }
  if (!handed.labelled) {
    const why = `merge gate was clear but ready-to-merge could not be applied${handed.summary ? ` (${handed.summary})` : ''} — the PR is complete and stays ready-to-review`
    log(`Merge gate: clear, handoff FAILED — ${why}.`)
    return { ...result, mergeSkipped: why }
  }
  log(`Merge gate: clear — #${issue} is ready-to-merge; bin/merge-worker.sh owns it from here.`)

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
