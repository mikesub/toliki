#!/usr/bin/env node
// fix-run — judgment-conflict fixer for a finished epic PR (dispatch launches
// it for `needs-judgment` issues; `--issue N` is the only argument).
//
// Rebases the PR onto current origin/main, lets the deterministic rung settle
// every mechanical hunk (merge-autoresolve.sh --partial, containment-gated),
// has a model resolve the hunks left marked — stating what each side intended
// and how both survive, editing outside a marker block only where that is what
// carries a side's intent to lines the other side moved, escalating instead of
// guessing — re-runs npm run verify, has a blind adversarial agent try to
// refute the resolution, and force-pushes. A complete repair lands the issue
// ready-to-merge; a verified partial repair preserves the repaired hunks but
// rests at ready-to-review with the fixer queue removed. Its authenticated,
// head-bound record names only the declined hunks and their original diff3
// sides. An automatic redispatch of that head is refused; after a human clears
// both ladder labels and restores the queue, one bounded round consumes only
// those declines, and only while the captured main head is unchanged. A stale
// captured main returns to human review without spending that granted rung.
// The merge worker rebases a complete repair again and
// RE-RUNS THE REAL CHECKS before anything lands. That re-run is what makes the
// landing safe: a resolution that breaks a check cannot merge. What it cannot
// catch is a resolution that is green and wrong, which is what the adversarial
// check is for.
// Attempt ladder in labels: fix-attempted, then fix-retried (one retry);
// exhausted → refuses and stays failed. Trusted-evidence reads that fail before
// a rung can be consumed remove the queue label and also stay failed for a
// human, rather than becoming an unbounded uncounted retry.
//
// Two model steps: the resolver and its skeptic. Everything else — the gates,
// the ladder write, the rebase, the partial autoresolve, verify, the push, the
// audit comment, the labels — is the orchestrator's own work through
// lib/github.mjs and lib/repo.mjs, so what got pushed and what got labelled is
// a fact this script established, not a claim a model reported.
// A hard provider-quota death aborts any in-progress rebase and records the
// host-wide hold before labels move. A verified hold refunds this invocation's
// rung; an unverified transition restores it and blocks inside the same
// terminal-report window. Neither path pushes.

import { readFileSync } from 'node:fs'
import { agent, phase, log, initRuntime, onPhase, onLog, takeAgentFailure, withAgentFailure } from './lib/runtime.mjs'
import { HARNESS_DIR } from './lib/engine.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { sh, must, failureReason } from './lib/proc.mjs'
import { authenticatedLogin, ensureLabels, editLabels, issueLabels, issueView, comment, openPrs, readBack, terminalBudget, terminalTimeout, terminalTransition, verifyIssueEngine } from './lib/github.mjs'
import { git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, rebaseInProgress, pushRejected, intentToAdd } from './lib/repo.mjs'
import { finalizeFixerIssue, finalizeFixerQuotaHold } from './lib/fixer-finalize.mjs'
import { recordQuotaHold } from './quota-hold.mjs'

const USAGE = `Usage: fix-run.mjs --issue <N> [--session <name>] [--engine <name>]

  --issue <N>  the needs-judgment issue whose PR hit the conflict
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase

Exit: 0 fixed or provider-held, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

// ───────────────────────── Why this exists ─────────────────────────
// bin/merge-worker.sh resolves rebase conflicts only when EVERY hunk is
// mechanical; one hunk needing judgment declines the whole PR to `failed` +
// `needs-judgment`. Measured on live declines, that class is concurrent work
// in one file where both intents compose — not contradictions — which is the
// case for waking a model: cheap detection (the awk classifier) has already
// decided there is something worth judging. This run is that model, fenced on
// every side: the mechanical share is re-settled by the same containment-gated
// code (never re-litigated by the model), the judgment share must come with
// stated intents — including every edit made outside a marker block to carry a
// side's intent to lines the other side moved — and must survive an adversarial
// check, and verify must be green. A complete landing is ready-to-merge because
// the merge worker still rebases and RE-RUNS the real checks before anything
// merges; a partial landing is held for a human with its repaired work intact.

// The deterministic rung, by absolute path. Resolved from this file's own
// location: the orchestrator knows where the harness is.
const AUTORESOLVE = `${HARNESS_DIR}/bin/merge-autoresolve.sh`

// ───────────────────────── Prompts ─────────────────────────
const PROMPTS = {
  // The judgment core — the one stage that exists because a model is needed.
  // It gets the same evidence a human would open: both sides' diffs and both
  // sides' issue bodies. Its scope is narrow: the marked hunks, both intents
  // stated and preserved, an edit outside a block only where that is what
  // carries a side's intent, escalate instead of guessing.
  resolve: (issue, prep) => prep.partialRecord
    ? `Resolve only the judgment hunks a prior verified partial conflict repair declined. A human cleared both fix-* ladder labels and restored needs-judgment to grant this bounded round. Branch ${prep.branch} (issue #${issue}) is already rebased onto the SAME origin/main head captured by the authenticated partial record; there is no rebase in progress and no marker block to finish.

The durable, head-bound worklist is exactly:
${prep.judgmentHunks.map((h, i) => `${i + 1}. ${h.file} hunk ${h.hunk} — prior decline: ${h.reason}\n   original classification: ${h.report}\n   original diff3 evidence: ${JSON.stringify(h.evidence)}`).join('\n')}

For EACH numbered prior decline:
1. Establish what origin/main intended and what the PR intended from its durable diff3 evidence and issue #${issue} (\`gh issue view ${issue} --json title,body\`).
2. If both intents now compose safely, edit the current file so both survive and mark it repaired. If they still do not, leave its current PR-side text exactly unchanged and mark it declined with a non-empty reason.
3. Treat every item independently. Continue after a decline; a partial result is held for a human and never enters unattended merge.

Boundaries: touch only ${prep.markedFiles.join(', ')}, and only for the numbered prior declines. An edit elsewhere in one of those files is allowed solely where it carries one side's intent to code the other side moved; list it under outsideEdits with where and intent. Never revisit a hunk absent from the worklist, never touch another file, never create a file, and never commit, amend, push, label, or comment. Leave the repairs as uncommitted working-tree edits for the pipeline to verify, check, and amend.

Return dispositions with exactly one entry for every numbered prior decline: index, action ("repaired" or "declined"), and a non-empty reason. A repaired entry also states mainIntent, prIntent, resolution, and outsideEdits when needed. A declined entry leaves the current text unchanged. Also return a short summary. No missing, duplicate, or extra indexes.`
    : `Resolve the JUDGMENT hunks of a rebase conflict. You are mid-rebase: the PR branch ${prep.branch} (issue #${issue}) is being rebased onto origin/main, and the stop is partially settled — every mechanical hunk was already resolved by a containment-gated script and is NOT yours to touch. Yours are exactly the diff3 marker blocks still sitting in: ${prep.markedFiles.join(', ')}.

The machine classification of every hunk in this stop (mechanical ones already settled in place):
${prep.report}

Evidence — read BOTH sides' intent before touching anything:
- The PR side: \`git diff ${prep.mergeBase} ${prep.prHead} -- <the marked files>\` is what the epic changed there, and \`gh issue view ${issue} --json title,body\` is what it set out to do.
- The main side: \`git diff ${prep.mergeBase} origin/main -- <the marked files>\` is what landed on main since the PR branched, \`git log ${prep.mergeBase}..origin/main --format='%h %s'\` names the commits, and ${prep.mainIssues.length ? `these are the issues they delivered — read each: ${prep.mainIssues.map(n => '#' + n).join(', ')} (\`gh issue view <n> --json title,body\`)` : 'their commit messages are the intent record (no Closes #N references found)'}.
- Do NOT open anything under \`.epics/\` — leftovers there carry a previous run's framing and would anchor you; the diffs and issue bodies above are your whole evidence.

For EACH marker block (<<<<<<< ours is origin/main's side, >>>>>>> theirs is the PR's side, ||||||| holds the common base):
1. State what origin/main intended with these lines, and what the PR intended — from the evidence, not from guesswork.
2. Write the resolution in which BOTH intents survive, replacing the whole marker block. When both sides re-derived the same thing (say, two retypings of one mock), the better derivation stands for both — but nothing either side MEANT may be lost.
3. Watch for merge artifacts a lazy concatenation produces: duplicate object keys, doubled imports, re-declared symbols, a call updated on one side of the block and stale on the other. Do not lean on the verify gate to catch these.

The judgment hunks are numbered for the disposition record:
${prep.judgmentHunks.map((h, i) => `${i + 1}. ${h.file} hunk ${h.hunk} — ${h.report}`).join('\n')}

**Decline instead of guessing.** Treat each numbered judgment hunk independently. If you cannot honestly state both intents and show both surviving — the two sides genuinely contradict, or the evidence does not say what a side meant — leave that hunk as the exact PR-side text and mark its disposition declined with the reason. Continue repairing the other hunks. A partial result is held for a human; a silently dropped intent is not.

Boundaries: the marker blocks are the target — that text is what you are here to rewrite. An edit OUTSIDE a marker block is allowed only in the files listed above, and only where it is what carries one side's intent to lines the other side moved or restructured: say main changed a call inside the block to use a bounded timeout while the PR moved that call outside the block, so keeping main's intent takes a one-line edit outside the markers. List every such edit in that hunk's resolution entry, under outsideEdits: where it is (file, and the symbol or line range) and which side's intent required it. Never revisit the mechanical resolutions; never touch a file that is not listed above; never commit anything new; never push. Where keeping both intents would take more than this, escalate instead of guessing.

When every block has either been repaired or replaced with its exact PR-side text: confirm no markers remain (\`git diff --check\` and \`grep -n '^<<<<<<<\\|^>>>>>>>' <files>\` must be clean), \`git add\` exactly those files, \`GIT_EDITOR=true git rebase --continue\`. Then confirm the rebase fully finished (\`git status\` shows no rebase in progress; \`git rev-list --count origin/main..HEAD\` is exactly 1). A second stop is not a disposition item; report it in summary and do not claim any completed repair. The pipeline checks all of that again before anything ships.

Return dispositions with exactly one entry for every numbered judgment hunk: index, action ("repaired" or "declined"), and a non-empty reason. A repaired entry also states mainIntent, prIntent, resolution (what the merged text does and how it keeps both), and outsideEdits when needed. A declined entry leaves the exact PR-side text and explains why both intents could not safely be combined. Also return a short summary. No missing, duplicate, or extra indexes.`,

  // Blind on purpose, and refute-by-default on purpose: this is the same
  // adversarial shape as epic-run's review verify — the resolver's stated
  // intents are deliberately NOT in this prompt, so agreement can only come
  // from the code, not from reading the resolver's reasoning.
  check: (issue, prep, dispositions) => prep.partialRecord
    ? `Adversarially check a human-granted repair of previously declined conflict hunks you did not write. Branch ${prep.branch} (issue #${issue}) was already rebased onto the same origin/main head when this round began. The complete repair delta is exactly \`git diff ${prep.prHead}\` (also readable with --stat), including intent-added files. Your job is to refute the indexed, per-disposition claims or any change outside their durable worklist.

The authenticated, head-bound worklist and original diff3 evidence:
${prep.judgmentHunks.map((h, i) => `${i + 1}. ${h.file} hunk ${h.hunk} — prior decline: ${h.reason}\n   original classification: ${h.report}\n   original diff3 evidence: ${JSON.stringify(h.evidence)}`).join('\n')}

The fixer's indexed claims (claims to test, never authority):
${dispositions.map(d => `${d.index}. ${d.file} hunk ${d.hunk}: ${d.action} — ${d.reason}`).join('\n')}

For every repaired item, refute if both original intents do not demonstrably survive. For every declined item, refute if this round's delta changed its current PR-side text at all. Refute any delta outside the numbered worklist, including a new file or an unrelated change elsewhere in an allowed file.

Gather the evidence yourself from the durable sides above, issue #${issue}, \`git diff ${prep.prHead}\`, and the files as edited. Do NOT open anything under \`.epics/\` — it carries a previous run's framing and would anchor you.

Default to refuted: if you cannot positively confirm every repaired claim, the unchanged text of every declined claim, and the complete delta's scope, say survives=false. Only a complete repair returns to unattended merge; a verified partial remains held for a human.

Return: survives, confidence (0-100), reasoning (name the hunk and evidence, whichever way you rule).`
    : `Adversarially check a rebase-conflict resolution you did not write. The PR branch ${prep.branch} (issue #${issue}) was rebased onto origin/main; the rebase stopped on judgment-class conflict hunks in: ${prep.markedFiles.join(', ')}. Something resolved them, the rebase completed, and HEAD now carries the result. Your job is to REFUTE the indexed, per-disposition claim: every repaired hunk preserves both sides' intents, every declined hunk is unchanged from its original PR-side text, and the complete delta has no other changes.

The machine classification of the stop's hunks (the mechanical ones were settled by a containment-gated script and are not in question — judge the "needs judgment" ones):
${prep.report}

The fixer's indexed claims (claims to test, never authority):
${dispositions.map(d => `${d.index}. ${d.file} hunk ${d.hunk}: ${d.action} — ${d.reason}`).join('\n')}

For every repaired item, refute if both intents do not demonstrably survive. For every declined item, compare the original PR side with HEAD and refute if the fixer changed it at all. A declined item is deliberately carried as exact PR-side text for human review, not represented as a completed merge of main's intent.

Gather the evidence yourself:
- What the PR meant to change: \`git diff ${prep.mergeBase} ${prep.prHead} -- <the files>\`, and issue #${issue} (\`gh issue view ${issue} --json title,body\`).
- What main meant to change: \`git diff ${prep.mergeBase} origin/main -- <the files>\`${prep.mainIssues.length ? `, and the issues those commits delivered: ${prep.mainIssues.map(n => '#' + n).join(', ')}` : ''}.
- What actually shipped: \`git diff origin/main HEAD -- <the files>\` and the files at HEAD.
Do NOT open anything under \`.epics/\` — it carries a builder's framing and would anchor you.

Edits outside the marker blocks are permitted in those files, but only where they carry a side's intent to lines the other side moved or restructured. So read the WHOLE delta, not only the blocks: find every change in \`git diff origin/main HEAD -- <the files>\` that sits outside a resolved block, and trace each one back to what one side's own diff intended. An out-of-block change you cannot trace to either side's intent refutes the resolution — say survives=false.

Hunt specifically for: a side's change silently dropped (picking a side is the classic failure, and often no test covers the loss); duplicate object keys, doubled imports or re-declared symbols from a lazy keep-both; an edit placed at the wrong spot so the code runs in a changed order; one side's rename or retype applied in the hunk but not to the lines the other side contributed.

Default to refuted: if you cannot positively confirm every repaired claim and the unchanged text of every declined claim, say survives=false. Only a complete repair goes back into the unattended merge queue; a verified partial is held for a human.

Return: survives, confidence (0-100), reasoning (name the hunk and the evidence, whichever way you rule).`,
}

// ───────────────────────── Config ─────────────────────────
// Which vendor, model and effort each step runs on is a row of the run's
// engine in etc/engines.json; every agent() call names only its step.
// fix-conflicts is the judgment core — the entire reason a model is in the
// loop — and confirm-review is the last gate before a rewritten merge ships to
// a force-push, so a row for either wants the strong model.

// ───────────────────────── Schemas ─────────────────────────
const RESOLVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [],
  properties: {
    completed: { type: 'boolean', description: 'true only when every marker block was resolved, the files staged, and rebase --continue finished with exactly one commit on top of origin/main' },
    escalate: { type: 'string', description: 'set INSTEAD of completing when any hunk is a genuine contradiction or its intents cannot be established — which file/hunk and why both intents cannot both survive' },
    resolutions: {
      type: 'array',
      description: 'one entry per resolved marker block',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'hunk', 'mainIntent', 'prIntent', 'resolution'],
        properties: {
          file: { type: 'string' },
          hunk: { type: 'number', description: 'the hunk number as the machine classification numbers it' },
          mainIntent: { type: 'string', description: 'what origin/main intended with these lines' },
          prIntent: { type: 'string', description: 'what the PR intended with these lines' },
          resolution: { type: 'string', description: 'one sentence: what the merged text does and how it keeps both' },
          outsideEdits: {
            type: 'array',
            description: 'every edit this hunk needed outside its marker block, when there were any',
            items: {
              type: 'object', additionalProperties: false,
              required: ['where', 'intent'],
              properties: {
                where: { type: 'string', description: 'file, and the symbol or line range the edit landed on' },
                intent: { type: 'string', description: 'which side\'s intent required the edit' },
              },
            },
          },
        },
      },
    },
    dispositions: {
      type: 'array',
      description: 'exactly one repaired or declined disposition per numbered judgment hunk',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'action', 'reason'],
        properties: {
          index: { type: 'number' },
          action: { enum: ['repaired', 'declined'] },
          reason: { type: 'string' },
          mainIntent: { type: 'string' },
          prIntent: { type: 'string' },
          resolution: { type: 'string' },
          outsideEdits: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['where', 'intent'],
              properties: { where: { type: 'string' }, intent: { type: 'string' } },
            },
          },
        },
      },
    },
    summary: { type: 'string' },
  },
}
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['survives', 'confidence', 'reasoning'],
  properties: {
    survives: { type: 'boolean', description: 'true only if every repaired hunk preserves both sides\' intents, every declined hunk is unchanged from its original PR-side text, and the complete delta has no other changes' },
    confidence: { type: 'number', description: '0-100' },
    reasoning: { type: 'string', description: 'names the hunk(s) and the evidence, whichever way it rules' },
  },
}

// ───────────────────────── Args ─────────────────────────
let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { allowSlug: false, usage: USAGE })
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write((e.message ? `fix-run: ${e.message}\n\n` : '') + e.usage + '\n')
    process.exit(e.message ? EXIT.ERROR : EXIT.OK)
  }
  throw e
}
initRuntime({ scriptName: 'fix-run', sessionName: ARGS.session, defaultEngine: ARGS.engine, issue: ARGS.issue })
// The issue's live status comment mirrors the pane's narration: the label says
// WHICH state the issue is in, this says whether the run is alive and where it
// got to.
initStatus({ issue: ARGS.issue, script: 'fix-run', session: ARGS.session, phases: ['Prepare', 'Resolve', 'Verify', 'Check', 'Ship'] })
onPhase(statusPhase)
onLog(statusNote)
const issue = ARGS.issue

// ───────────────────────── Transport ─────────────────────────
// The ladder labels are the attempt store — queues here are label queries,
// never comment greps — and the write is VERIFIED because it is the bound
// that keeps this loop finite: a silently failed write would let dispatch
// relaunch forever. The in-progress swap is usually already done by dispatch
// (synchronously at launch, to shield the new session from reap's
// terminal-label sweep); repeating it here is an idempotent belt for manual
// launches.
function judgmentHunks(report) {
  return String(report || '').split('\n').flatMap(line => {
    const match = line.match(/^(.+): hunk ([1-9]\d*): (needs judgment\b.*)$/)
    return match ? [{ file: match[1], hunk: Number(match[2]), report: match[3] }] : []
  })
}

// A pushed partial conflict is already rebased, so the next invocation cannot
// rediscover its declined hunks from conflict markers. Persist only those
// hunks, bound to the pushed PR head and authenticated automation author, with
// the three diff3 sides that let a human-granted round reconstruct the exact
// remaining judgment work without reopening completed repairs.
const CONFLICT_PARTIAL_MARKER = '🤖 conflict-fix partial evidence'
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validConflictPartial(value) {
  if (!isObject(value) || value.version !== 1 || !Number.isInteger(value.issue)) return false
  if (!isObject(value.pr) || !Number.isInteger(value.pr.number) ||
      !['url', 'branch', 'head'].every(field => typeof value.pr[field] === 'string' && value.pr[field])) return false
  if (!isObject(value.base) ||
      !['mainHead', 'mergeBase'].every(field => typeof value.base[field] === 'string' && value.base[field])) return false
  if (!Array.isArray(value.declines) || !value.declines.length || typeof value.verify !== 'string' || !Number.isFinite(value.checkConfidence)) return false
  const identities = new Set()
  for (const decline of value.declines) {
    if (!isObject(decline) || typeof decline.file !== 'string' || !decline.file || !Number.isInteger(decline.hunk) || decline.hunk < 1) return false
    if (typeof decline.report !== 'string' || !decline.report || typeof decline.reason !== 'string' || !decline.reason) return false
    if (!isObject(decline.evidence) || !['main', 'base', 'pr'].every(side => typeof decline.evidence[side] === 'string')) return false
    const identity = `${decline.file}\0${decline.hunk}`
    if (identities.has(identity)) return false
    identities.add(identity)
  }
  return true
}

const renderConflictPartial = record => {
  if (!validConflictPartial(record)) throw new Error('refusing to render malformed partial-conflict evidence')
  return `${CONFLICT_PARTIAL_MARKER}\n${JSON.stringify(record)}`
}

function parseConflictPartial(body) {
  const text = String(body || '')
  if (!text.startsWith(`${CONFLICT_PARTIAL_MARKER}\n`)) return null
  const json = text.slice(CONFLICT_PARTIAL_MARKER.length + 1)
  try {
    const record = JSON.parse(json)
    if (!validConflictPartial(record) || json !== JSON.stringify(record)) return null
    return record
  } catch {
    return null
  }
}

function matchingConflictPartial(comments, { actor, issue, prNumber, branch, head }) {
  const login = String(actor || '').toLowerCase()
  if (!login || !Array.isArray(comments)) return null
  for (let i = comments.length - 1; i >= 0; i--) {
    const entry = comments[i]
    if (String(entry?.author?.login || '').toLowerCase() !== login) continue
    const record = parseConflictPartial(entry?.body)
    if (!record || record.issue !== Number(issue) || record.pr.number !== Number(prNumber)) continue
    if (record.pr.branch === branch && record.pr.head === head) return record
  }
  return null
}

async function publishConflictPartial({ issue, actor, record }) {
  await comment(issue, renderConflictPartial(record))
  const criteria = {
    actor, issue, prNumber: record.pr.number, branch: record.pr.branch, head: record.pr.head,
  }
  const seen = await readBack(
    () => issueView(issue, 'comments'),
    view => !!matchingConflictPartial(view.comments, criteria))
  if (!seen.matched) throw new Error('partial-conflict evidence was not observed after posting')
}

// merge-autoresolve has already rejected marker-shaped tracked content, so the
// remaining diff3 blocks can be parsed without mistaking project text for a
// marker. Mechanical blocks are gone; the surviving blocks align in order with
// this file's judgment reports.
function diff3Blocks(text) {
  const blocks = []
  let block = null
  let side = ''
  for (const line of String(text).split('\n')) {
    if (!block && /^<<<<<<<( |$)/.test(line)) {
      block = { main: [], base: [], pr: [] }
      side = 'main'
    } else if (block && side === 'main' && /^\|{7}( |$)/.test(line)) {
      side = 'base'
    } else if (block && side === 'base' && line === '=======') {
      side = 'pr'
    } else if (block && side === 'pr' && /^>>>>>>>( |$)/.test(line)) {
      blocks.push({ main: block.main.join('\n'), base: block.base.join('\n'), pr: block.pr.join('\n') })
      block = null
      side = ''
    } else if (block) {
      block[side].push(line)
    }
  }
  if (block) throw new Error('unterminated diff3 judgment block')
  return blocks
}

function captureJudgmentEvidence(markedFiles, judgments) {
  const captured = []
  for (const file of markedFiles) {
    const fileJudgments = judgments.filter(item => item.file === file)
    const text = readFileSync(file, 'utf8')
    const blocks = diff3Blocks(text)
    if (blocks.length !== fileJudgments.length) {
      throw new Error(`${file}: found ${blocks.length} marked judgment block(s) for ${fileJudgments.length} judgment report(s)`)
    }
    fileJudgments.forEach((item, index) => captured.push({ ...item, evidence: blocks[index] }))
  }
  if (captured.length !== judgments.length) throw new Error('could not capture every numbered judgment hunk')
  return judgments.map(item => captured.find(value => value.file === item.file && value.hunk === item.hunk))
}

async function prepare(issue) {
  const view = await issueView(issue, 'state,labels,title')
  const labels = Array.isArray(view.labels) ? view.labels.map(l => l.name) : []
  if (String(view.state || '').toUpperCase() === 'CLOSED') return { refused: `issue #${issue} is closed` }
  if (!labels.includes('needs-judgment')) return { refused: `issue #${issue} is not labelled needs-judgment — not a fixer's issue` }

  // Routing is permanent once the epic claimed the issue. Verify the strong
  // issue-label view before consuming a retry rung or touching the PR tree.
  await verifyIssueEngine(issue, ARGS.engine)

  // A refusal a retry cannot fix is commented and left `failed` for a human.
  const refuseFinal = async (body, reason, transition = { add: ['failed'], remove: ['in-progress'] }) => {
    const settled = await finalizeFixerIssue({ issue, body, ...transition })
    terminalWindow = settled.budget
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
    return { refused: reason, refusalFinal: true }
  }
  const prefix = `epic/${issue}-`
  const prs = (await openPrs()).filter(p => String(p.headRefName || '').startsWith(prefix))
  if (!prs.length) {
    return refuseFinal(`🤖 fix-conflict refused: no open PR\nIssue #${issue} is labelled needs-judgment but no open PR delivers it (branch epic/${issue}-*). Resolve by hand; strip needs-judgment to take it out of the fixer queue.`,
      `no open PR on an epic/${issue}-* branch`)
  }
  if (prs.length > 1) {
    return refuseFinal(`🤖 fix-conflict refused: multiple open PRs\nIssue #${issue} has ${prs.length} open PRs on epic/${issue}-* branches — ambiguous. Resolve by hand; strip needs-judgment to take it out of the fixer queue.`,
      `multiple open PRs on epic/${issue}-* branches — ambiguous`)
  }
  const pr = prs[0]

  // A clean rebase is normally evidence that the conflict evaporated, but not
  // when this exact head is a partial repair whose declined hunks were already
  // carried as PR-side text. Read authenticated, head-bound evidence before
  // consuming a rung so that state can never be mistaken for a complete merge.
  let actor, comments
  try {
    actor = await authenticatedLogin()
    comments = await issueView(issue, 'comments')
  } catch (e) {
    const detail = e?.message || String(e)
    return refuseFinal(state => {
      const header = '🤖 fix-conflict refused: trusted partial-conflict evidence could not be read'
      const situation = `The authenticated partial record could not be checked (${detail}).`
      if (state.settled) {
        return `${header}\n${situation} needs-judgment has been removed automatically, so the issue is out of the fixer queue and rests at failed. A human must inspect this PR before another fixer round.`
      }
      if (!state.readable) {
        return `${header}\n${situation} The resulting labels could NOT be read back (${state.stateError}), so it is unknown whether the issue left the fixer queue: check by hand that needs-judgment is gone and failed is set. A human must inspect this PR before another fixer round.`
      }
      const queue = state.stuck.includes('needs-judgment')
        ? 'needs-judgment could NOT be removed, so the issue may still be in the fixer queue and dispatchable'
        : 'needs-judgment has been removed automatically, so the issue is out of the fixer queue, but the transition did not complete'
      const repairs = [
        ...(state.missing.length ? [`set ${state.missing.join(', ')}`] : []),
        ...(state.stuck.length ? [`remove ${state.stuck.join(', ')}`] : []),
      ].join(' and ')
      return `${header}\n${situation} ${queue} (${state.stateError}): ${repairs} by hand. A human must inspect this PR before another fixer round.`
    }, 'trusted partial-conflict evidence could not be read',
    terminalTransition({ rest: 'failed', drop: ['needs-judgment'] }))
  }
  const partialRecord = matchingConflictPartial(comments.comments, {
    actor, issue, prNumber: pr.number, branch: pr.headRefName, head: pr.headRefOid,
  })
  if (partialRecord && (labels.includes('fix-attempted') || labels.includes('fix-retried'))) {
    const settled = await finalizeFixerIssue({
      issue,
      body: state => {
        let transition
        if (state.settled) {
          transition = 'The issue is held at ready-to-review with needs-judgment removed.'
        } else if (!state.readable) {
          transition = `The human-held label transition could not be read back (${state.stateError}); check by hand that ready-to-review is set and needs-judgment is gone before dispatch can retry it.`
        } else {
          const repairs = [
            ...(state.missing.length ? [`set ${state.missing.join(', ')}`] : []),
            ...(state.stuck.length ? [`remove ${state.stuck.join(', ')}`] : []),
          ].join(' and ')
          transition = `The human-held label transition could not be verified (${state.stateError}); ${repairs || 'inspect the labels'} by hand before dispatch can retry it.`
        }
        return `🤖 fix-conflict refused: current head is a verified partial repair\nThe authenticated record for ${pr.headRefOid} still names declined judgment hunks. This invocation ran no resolver and cannot promote that head. ${transition} Strip both fix-* ladder labels and restore needs-judgment only to grant another bounded round over the recorded declines.`
      },
      ...terminalTransition({ rest: 'ready-to-review', drop: ['needs-judgment'] }),
    })
    terminalWindow = settled.budget
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
    return { refused: 'current PR head is a verified partial conflict repair with a spent ladder rung', refusalFinal: true }
  }
  if (!partialRecord && labels.includes('fix-retried')) {
    return refuseFinal('🤖 fix-conflict refused: attempt ladder exhausted\nTwo fixer attempts already ran (fix-attempted + fix-retried are both on the issue). A human decides now: resolve the conflict by hand, or strip the fix-attempted and fix-retried labels to grant the fixer another round.',
      'attempt ladder exhausted (fix-retried present)')
  }

  // Attempt ladder + start signal, VERIFIED: an uncounted attempt must not run.
  const attempt = labels.includes('fix-attempted') ? 2 : 1
  const ladderLabel = attempt === 2 ? 'fix-retried' : 'fix-attempted'
  await ensureLabels(['fix-attempted', 'fix-retried', 'in-progress'])
  await editLabels(issue, { add: ['in-progress', ladderLabel], remove: ['failed'] })
  const now = await issueLabels(issue)
  if (!now.includes('in-progress') || !now.includes(ladderLabel) || now.includes('failed')) {
    return { refused: 'could not record the attempt (label write failed)' }
  }
  const base = { attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number, prHead: pr.headRefOid, actor }

  // Git setup, in the session's own worktree. Scrub what a killed predecessor may have left first: a
  // relaunched fixer inherits the previous run's worktree, and a leftover mid-rebase state makes every
  // later step fail on cleanup instead of retrying.
  await git(['rebase', '--abort'])
  await gitOut(['fetch', 'origin', '--prune'], 'git fetch origin --prune')
  const originHead = (await git(['rev-parse', `refs/remotes/origin/${pr.headRefName}`])).out
  if (originHead !== pr.headRefOid) {
    return { ...base, gitBlocked: `branch ${pr.headRefName} moved under the fixer (PR head ${pr.headRefOid}, origin now ${originHead || 'missing'})` }
  }
  // Force: a reused worktree may sit on stale state; everything real is committed.
  await gitOut(['checkout', '-f', '--detach', pr.headRefOid], 'git checkout --detach')
  const mainHead = await gitOut(['rev-parse', 'origin/main'], 'git rev-parse origin/main')
  if (partialRecord) {
    if (partialRecord.base.mainHead !== mainHead) {
      const reason = `origin/main moved after the partial-conflict evidence was captured (${partialRecord.base.mainHead} → ${mainHead}); only a human can reconcile new base changes with the recorded declines`
      return refuseFinal(state => {
        const transition = state.settled
          ? `The issue is held at ready-to-review with needs-judgment and ${ladderLabel} removed, so no automatic retry can reinterpret the stale record and no model attempt was spent.`
          : !state.readable
          ? `The human-held label transition could not be read back (${state.stateError}); check by hand that ready-to-review is set and needs-judgment and ${ladderLabel} are gone.`
          : `The human-held label transition could not be verified (${state.stateError}); ${[
              ...(state.missing.length ? [`set ${state.missing.join(', ')}`] : []),
              ...(state.stuck.length ? [`remove ${state.stuck.join(', ')}`] : []),
            ].join(' and ') || 'inspect the labels'} by hand.`
        return `🤖 fix-conflict held: partial-conflict evidence is stale\n${reason}. This invocation ran no resolver and left the branch unchanged. ${transition}`
      }, reason, terminalTransition({ rest: 'ready-to-review', drop: ['needs-judgment', ladderLabel] }))
    }
    const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
    if (above !== 1) {
      return { ...base, partialRecord, gitBlocked: `the partial PR branch holds ${Number.isNaN(above) ? 'an unknown number of' : above} commit(s) above its captured main — an epic branch holds exactly one` }
    }
    const packages = discoverPackages('.')
    const depLines = packages.length ? await ensureDeps(packages, { pairs: [['origin/main', 'HEAD']] }) : []
    const judgments = partialRecord.declines.map(item => ({ ...item }))
    return {
      ...base,
      partialRecord,
      mergeBase: partialRecord.base.mergeBase,
      mainHead,
      cleanRebase: false,
      report: judgments.map(item => `${item.file}: hunk ${item.hunk}: ${item.report}`).join('\n'),
      markedFiles: [...new Set(judgments.map(item => item.file))],
      judgmentHunks: judgments,
      mainIssues: [],
      packages,
      depLines,
    }
  }
  const mergeBase = await gitOut(['merge-base', pr.headRefOid, 'origin/main'], 'git merge-base')
  // Each squash-merged PR carries a Closes line, and those issue bodies are the intent record for
  // main's side of the conflict.
  const bodies = await gitOut(['log', '--format=%b', `${mergeBase}..origin/main`], 'git log')
  const mainIssues = [...new Set([...bodies.matchAll(/Closes #(\d+)/g)].map(m => Number(m[1])))].sort((a, b) => a - b)

  let cleanRebase = false, report = '', markedFiles = []
  const rb = await git(['-c', 'merge.conflictStyle=diff3', 'rebase', 'origin/main'])
  if (rb.ok) {
    cleanRebase = true
  } else {
    // The deterministic rung settles every mechanical hunk in place and leaves the judgment ones
    // marked exactly as git wrote them. Non-zero means a shape the fixer does not own.
    const top = await gitOut(['rev-parse', '--show-toplevel'], 'git rev-parse --show-toplevel')
    const ar = await sh(AUTORESOLVE, ['--partial', top], { timeoutMs: 10 * 60 * 1000 })
    if (!ar.ok) return { ...base, mergeBase, mainIssues, gitBlocked: `partial autoresolve declined: ${(ar.out || ar.err).split('\n')[0] || failureReason(ar)}` }
    report = ar.out
    markedFiles = (await gitOut(['diff', '--name-only', '--diff-filter=U'], 'git diff --diff-filter=U')).split('\n').filter(Boolean)
    if (!markedFiles.length) {
      // The conflict turned fully mechanical since the merge worker saw it (main moved).
      must(await git(['rebase', '--continue'], { env: { ...process.env, GIT_EDITOR: 'true' } }), 'git rebase --continue')
      if (await rebaseInProgress()) return { ...base, mergeBase, mainIssues, report, gitBlocked: 'more than one commit conflicted — an epic branch holds exactly one' }
    }
  }

  const judgments = judgmentHunks(report)
  if (markedFiles.length && !judgments.length) {
    return { ...base, mergeBase, mainIssues, report, gitBlocked: 'partial autoresolve left marked files but reported no numbered judgment hunks' }
  }
  const judgmentEvidence = markedFiles.length ? captureJudgmentEvidence(markedFiles, judgments) : judgments
  const packages = discoverPackages('.')
  // Either side may have moved the lockfile; a stale install makes the gate lie.
  const depLines = packages.length ? await ensureDeps(packages, { pairs: [[mergeBase, 'HEAD'], [mergeBase, 'origin/main']] }) : []
  return { ...base, mergeBase, mainHead, cleanRebase, report, markedFiles, judgmentHunks: judgmentEvidence, mainIssues, packages, depLines }
}

const nonblank = value => typeof value === 'string' && value.trim().length > 0

// New runs use indexed dispositions. Legacy all-repaired payloads remain
// accepted so an interrupted run or an older engine fixture can complete the
// same safe full-repair path; they are converted only when every named hunk has
// one matching intent record.
function normalizedDispositions(result, hunks) {
  if (result?.escalate) return { problem: `escalated rather than guessed: ${result.escalate}` }
  let dispositions
  if (Array.isArray(result?.dispositions)) {
    dispositions = result.dispositions
  } else if (result?.completed === true && Array.isArray(result.resolutions)) {
    dispositions = hunks.map((hunk, index) => {
      const matches = result.resolutions.filter(r => r.file === hunk.file && Number(r.hunk) === hunk.hunk)
      if (matches.length !== 1) return null
      return { index: index + 1, action: 'repaired', reason: matches[0].resolution, ...matches[0] }
    })
    if (dispositions.some(value => value === null)) {
      return { problem: 'the resolver returned legacy resolutions without exact coverage of every numbered judgment hunk' }
    }
  } else if (result?.completed === false) {
    return { problem: 'the resolver did not complete the rebase' }
  } else {
    return { problem: 'the resolver returned no indexed hunk dispositions' }
  }

  if (dispositions.length !== hunks.length) {
    return { problem: `the resolver returned ${dispositions.length} disposition(s) for ${hunks.length} numbered judgment hunk(s)` }
  }
  const byIndex = new Map()
  for (const disposition of dispositions) {
    const index = Number(disposition?.index)
    if (!Number.isInteger(index) || index < 1 || index > hunks.length || byIndex.has(index)) {
      return { problem: 'the resolver returned duplicate, missing, or out-of-range disposition indexes' }
    }
    if (!['repaired', 'declined'].includes(disposition.action) || !nonblank(disposition.reason)) {
      return { problem: `hunk disposition ${index} needs a repaired/declined action and non-empty reason` }
    }
    if (disposition.action === 'repaired' &&
        ![disposition.mainIntent, disposition.prIntent, disposition.resolution].every(nonblank)) {
      return { problem: `repaired hunk disposition ${index} is missing its main intent, PR intent, or resolution` }
    }
    byIndex.set(index, disposition)
  }
  if (byIndex.size !== hunks.length) return { problem: 'the resolver did not cover every numbered judgment hunk exactly once' }
  return {
    dispositions: hunks.map((hunk, index) => ({ ...hunk, ...byIndex.get(index + 1), file: hunk.file, hunk: hunk.hunk, index: index + 1 })),
  }
}

// What the resolver claims, checked against the tree: no rebase in progress, exactly one commit above
// origin/main, no marker left in the files it owned. Returns the first problem, or null.
async function resolutionProblem(markedFiles) {
  if (await rebaseInProgress()) return 'the rebase is still in progress'
  const count = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (count !== 1) return `the rebased branch holds ${Number.isNaN(count) ? 'an unknown number of' : count} commit(s) above origin/main — an epic branch holds exactly one`
  const markers = await git(['grep', '-n', '-E', '^(<<<<<<<|>>>>>>>|\\|{7})( |$)', 'HEAD', '--', ...markedFiles])
  if (markers.ok) return `conflict markers remain at HEAD: ${markers.out.split('\n')[0]}`
  return null
}

function partialConflictRecord(prep, dispositions, head, verifyDetail, check) {
  const declines = dispositions.filter(item => item.action === 'declined').map(item => ({
    file: item.file,
    hunk: item.hunk,
    report: item.report,
    reason: item.reason,
    evidence: item.evidence,
  }))
  const record = {
    version: 1,
    issue,
    pr: { number: prep.prNumber, url: prep.prUrl, branch: prep.branch, head },
    base: { mainHead: prep.mainHead, mergeBase: prep.mergeBase },
    declines,
    verify: verifyDetail,
    checkConfidence: check.confidence,
  }
  if (!validConflictPartial(record)) throw new Error('refusing to publish incomplete partial-conflict evidence')
  return record
}

// Push, record, relabel. Pinned to the exact head this run inspected, so if ANYTHING else moved the
// branch the push is rejected and nothing further happens. A human-granted
// continuation starts from an already committed partial head, so its checked
// working-tree delta is amended before the push just as CI/defect repairs are.
async function ship(issue, prep, body, { partial = false, dispositions = [], verifyDetail, check } = {}) {
  if (prep.partialRecord) {
    await gitOut(['add', '-A'], 'git add -A')
    if ((await git(['diff', '--cached', '--quiet'])).code === 0) {
      return { pushed: false, labelled: false, note: 'nothing staged to amend' }
    }
    await gitOut(['commit', '-q', '--amend', '--no-edit'], 'git commit --amend')
  }
  const shippedHead = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')
  const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (above !== 1) return { pushed: false, labelled: false, note: `the repaired branch holds ${above} commits above origin/main` }

  // The record is published and read back before the force-push. It is already
  // bound to the exact prospective head, so a rejected push leaves only stale,
  // non-matching evidence; a successful push can never become an unguarded
  // partial merely because the later label transition or audit comment failed.
  if (partial) {
    try {
      const record = partialConflictRecord(prep, dispositions, shippedHead, verifyDetail, check)
      await publishConflictPartial({ issue, actor: prep.actor, record })
    } catch (e) {
      return { pushed: false, labelled: false, note: `partial-conflict evidence could not be published and read back (${e?.message || e})` }
    }
  }
  const push = await git(['push', `--force-with-lease=refs/heads/${prep.branch}:${prep.prHead}`, 'origin', `HEAD:refs/heads/${prep.branch}`])
  if (!push.ok) return { pushed: false, labelled: false, note: pushRejected(push) ? `rejected — ${prep.branch} moved on origin under this run` : failureReason(push) }
  if (partial) {
    const settled = await finalizeFixerIssue({
      issue,
      body: body(shippedHead),
      ...terminalTransition({ rest: 'ready-to-review', drop: ['needs-judgment'] }),
    })
    terminalWindow = settled.budget
    const notes = [
      ...(!settled.settled ? [`terminal label transition failed: ${settled.stateError}`] : []),
      ...(!settled.reported ? [`audit comment failed: ${settled.reportError}`] : []),
    ]
    return { pushed: true, labelled: settled.settled, reported: settled.reported, note: notes.join('; ') }
  }
  // The resolution rewrote lines nobody reviewed, so the audit trail lives where a human will look.
  await comment(issue, body(shippedHead))
  // ready-to-merge: the PR was in the unattended queue before the conflict declined it, and it goes
  // back there — where the merge worker rebases it and RE-RUNS the real checks before anything
  // lands, so a resolution that breaks one cannot merge. The ladder labels stay: they do not reset.
  // From here the run is inside reap's settle window: the swap starts the clock
  // the moment GitHub processes it, so the write and the readback after it share
  // one budget (see terminalBudget) and the run still has a RESULT line to write.
  // A readback that cannot confirm the landing drops into the blocker path, which
  // transitions the labels again — inside THIS window, not a second one.
  const budget = terminalBudget()
  await ensureLabels(['ready-to-merge'], { budget })
  const absent = ['in-progress', 'needs-judgment', 'ready-to-review', 'failed']
  const flip = await editLabels(issue, { add: ['ready-to-merge'], remove: absent }, { budget })
  // Bounded, not single-shot: GitHub can take seconds to show a swap it has
  // already applied, and one immediate read costs the run a retry for nothing.
  let seen
  try {
    seen = await readBack(
      () => issueLabels(issue, { budget }),
      ls => ls.includes('ready-to-merge') && absent.every(l => !ls.includes(l)),
      { budget })
  } catch (e) {
    return { pushed: true, labelled: false, note: e && e.message || String(e) }
  }
  const labels = seen.observed
  return { pushed: true, labelled: seen.matched, note: seen.matched ? '' : (flip.ok ? `observed labels: ${labels.join(', ')}` : failureReason(flip)) }
}

// What happens next is the LADDER's call, never the phase's — so it is a
// field of the block (`- next:`), not a paragraph after it. #272 shipped it
// as a trailing paragraph, the agent read that as narration and dropped it,
// and the operator saw a first-attempt decline with no notice that a retry
// was already queued. Keep every disposition claim inside the block; a
// `reason` string states what broke, never who picks it up.
const attemptRung = attempt => attempt === 2 ? 'fix-retried' : 'fix-attempted'

function attemptGuidance(attempt, state) {
  const normal = attempt >= 2
    ? 'This was the RETRY (fix-attempted and fix-retried are both on the issue), so the fixer is done with it: resolve by hand, or strip the two fix-* labels to grant another round.'
    : attempt === 1
    ? 'This was the first attempt (fix-attempted is on the issue), so dispatch relaunches the fixer once, automatically, a few minutes after this session is reaped. Nothing to do unless the retry also fails.'
    : 'The attempt ladder was not reached, so dispatch will relaunch the fixer on its next tick.'
  if (!state || attempt < 1) return normal
  const rung = attemptRung(attempt)
  if (!state.readable) return `GitHub did not return a label readback; check that ${rung} is present before relaunching so this spent attempt is not refunded.`
  if (!state.labels.includes(rung)) return `${rung} could NOT be restored; set it by hand before relaunching so this spent attempt is not refunded.`
  return normal
}

const blockerBody = ({ phase, reason, prUrl, attempt }, state) =>
  `🤖 fix-conflict blocked\n- phase: ${phase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- next: ${attemptGuidance(attempt, state)}\n`

async function postBlocker({ issue, phase, reason, prUrl, attempt }, budget) {
  // The worktree must not be left mid-rebase for the next run to trip over. The probe is bounded
  // as well as the abort, because its own `rev-parse` subprocesses can stall just as long. Bounded
  // by what the terminal window has left when it is ship's landing swap that failed: past that write
  // reap's settle clock is running, and a stalled local git call costs the blocker report just as an
  // unbounded gh call would. Before any terminal write there is no clock and git's own timeout stands.
  await cleanConflictWorktree(terminalTimeout)
  // needs-judgment keeps the issue in the fixer queue and the ladder labels bound the retries; both
  // stay — and needs-judgment is RESTORED rather than assumed, because a landing swap that GitHub
  // applied but this run could not verify has already stripped it and put `ready-to-merge` on — the
  // one label bin/merge-worker.sh selects on, so a blocked run's PR would be landed unattended. A run
  // resting at `failed` beside a landing label it never verified reports one state and presents
  // another, so the transition names the one label it rests at and derives every removal from it.
  const settled = await finalizeFixerIssue({
    issue,
    body: state => blockerBody({ phase, reason, prUrl, attempt }, state),
    ...terminalTransition({ rest: 'failed', queue: ['needs-judgment'] }),
    budget,
  })
  terminalWindow = settled.budget
  if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
  if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
}

// Once a checked partial branch is pushed, retrying the conflict fixer could
// overwrite or promote work a human now owns. Reporting trouble leaves the
// verified review label alone; an unverified review transition is quarantined
// at failed with the fixer queue deliberately absent.
async function blockPushedPartial(reason, { reviewSettled }) {
  blockerPosted = true
  if (reviewSettled) {
    log(`blocked after partial push: ${reason}`)
  } else {
    const settled = await finalizeFixerIssue({
      issue,
      body: state => blockerBody({ phase: 'ship', reason, prUrl, attempt }, state),
      ...terminalTransition({ rest: 'failed', drop: ['needs-judgment'] }),
      budget: terminalWindow || terminalBudget(),
    })
    terminalWindow = settled.budget
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label quarantine failed (${settled.stateError})`)
  }
  return { blocked: true, issue, phase: 'ship', reason, prUrl: prUrl || undefined, attempt, partialPushed: true }
}

// ───────────────────────── Blocker path ─────────────────────────
// Same shape as epic-run's fail(): comment the blocker, restore the terminal
// label, return a structured block. blockerPosted guards re-entry when the
// outer catch fires after a phase that already failed.
let currentPhase = 'prepare'
let blockerPosted = false
let prUrl = null
let attempt = 0
let terminalWindow = null
async function cleanConflictWorktree(options) {
  const opts = () => typeof options === 'function' ? options() : options
  if (await rebaseInProgress(opts())) await git(['rebase', '--abort'], opts())
  await git(['reset', '--mixed', 'HEAD'], opts())
  await git(['checkout', '-f', '--', '.'], opts())
  await git(['clean', '-fd'], opts())
}
async function holdForQuota(phase, failure, reason) {
  try {
    await cleanConflictWorktree()
    const { hostHold, trigger } = await recordQuotaHold({ vendor: failure.vendor, reason: failure.reason })
    const rung = attemptRung(attempt)
    const finalized = await finalizeFixerQuotaHold({
      issue,
      rung,
      hold: { add: ['failed'], remove: ['in-progress', rung], required: ['failed', 'needs-judgment'] },
      blocked: { add: ['failed'], remove: ['in-progress'], required: ['failed', 'needs-judgment'] },
      body: (state, holdState) => blockerBody({
        phase,
        reason: withAgentFailure(`${reason} Provider quota hold failed: ${holdState.stateError}.`, failure),
        prUrl,
        attempt,
      }, state),
    })
    terminalWindow = finalized.budget
    if (!finalized.held) {
      blockerPosted = true
      if (!finalized.blockState.reported) log(`blocked: GitHub report failed (${finalized.blockState.reportError})`)
      if (!finalized.blockState.settled) log(`blocked: terminal label restoration failed (${finalized.blockState.stateError})`)
      return {
        blocked: true, issue, phase,
        reason: withAgentFailure(`${reason} Provider quota hold failed: ${finalized.holdState.stateError}.`, failure),
        prUrl: prUrl || undefined,
        attempt,
      }
    }
    return { held: true, issue, phase, ...hostHold, ...trigger, attempt }
  } catch (error) {
    return { error: error?.message || String(error) }
  }
}

async function fail(phase, reason) {
  const failure = takeAgentFailure()
  if (failure?.kind === 'quota-exhausted') {
    const held = await holdForQuota(phase, failure, reason)
    if (!held.error) return held
    reason = `${reason} Provider quota hold failed: ${held.error}.`
  }
  reason = withAgentFailure(reason, failure)
  if (!blockerPosted) {
    blockerPosted = true
    try {
      await postBlocker({ issue, phase, reason, prUrl, attempt })
    } catch (e) {
      log(`blocked: could not report on GitHub (${e && e.message || e})`)
    }
  }
  return { blocked: true, issue, phase, reason, prUrl: prUrl || undefined, attempt }
}

// ───────────────────────── The audit comment ─────────────────────────
// Composed here, in the script, from structured pieces. The resolution rewrote
// lines nobody reviewed, so the record has to name every hunk, both intents,
// and every gate that ran.
const buildComment = (prep, dispositions, verifyDetail, check) => {
  const lines = []
  const declined = dispositions.filter(d => d.action === 'declined')
  lines.push(declined.length ? '🤖 fix-conflict landed a partial judgment-conflict repair' : '🤖 fix-conflict resolved a judgment rebase conflict')
  lines.push(`- pr: ${prep.prUrl}`)
  lines.push(`- attempt: ${prep.attempt}`)
  lines.push('')
  if (prep.partialRecord) {
    lines.push('A human granted another bounded round on a previously pushed partial conflict repair. The authenticated head-bound record supplied only its remaining declined hunks; earlier repaired hunks were not reopened.')
  } else if (prep.cleanRebase) {
    lines.push('By the time this run rebased, the conflict had evaporated — origin/main had moved past the decline. The rebase was clean; no judgment was exercised.')
  } else if (!dispositions.length) {
    lines.push('By the time this run rebased, every hunk had turned mechanical — origin/main had moved past the judgment decline. The deterministic rung settled them all under its containment gate; no judgment was exercised:')
    lines.push('')
    lines.push(String(prep.report || "").trim().split('\n').map(l => `- ${l}`).join('\n'))
  } else {
    lines.push('Rebasing onto origin/main conflicted. The mechanical hunks were settled by the deterministic rung under its containment gate; the judgment hunks were resolved by this fixer session:')
    lines.push('')
    lines.push(String(prep.report || "").trim().split('\n').map(l => `- ${l}`).join('\n'))
  }
  if (dispositions.length) {
    lines.push('')
    lines.push('Each judgment-hunk disposition:')
    for (const r of dispositions) {
      lines.push(`- ${r.file} hunk ${r.hunk}:`)
      lines.push(`  - disposition: ${r.action}`)
      lines.push(`  - reason: ${r.reason}`)
      if (r.action === 'declined') {
        lines.push('  - carried text: exact PR-side text retained for human review')
        continue
      }
      lines.push(`  - origin/main intended: ${r.mainIntent}`)
      lines.push(`  - the PR intended: ${r.prIntent}`)
      lines.push(`  - resolution: ${r.resolution}`)
      // An edit outside the marker block is the one thing a reader cannot find by looking at the
      // block, so the record names each: where it landed and whose intent put it there.
      for (const e of (Array.isArray(r.outsideEdits) ? r.outsideEdits : [])) {
        lines.push(`  - edit outside the marker block: ${e.where} — ${e.intent}`)
      }
    }
    lines.push('')
    lines.push(`An adversarial check tested every repaired hunk and confirmed every declined hunk retained its PR-side text (confidence ${check.confidence}/100).`)
  }
  lines.push('')
  lines.push(`verify: ${verifyDetail}`)
  lines.push('')
  lines.push(declined.length
    ? 'The branch now carries the repaired hunks and is force-pushed; the issue is held at ready-to-review with the fixer queue removed. A human decides the declined hunks.'
    : prep.partialRecord
    ? 'The branch now carries the repaired hunks and is force-pushed; the issue is back to ready-to-merge. The merge worker rebases it onto current main and re-runs the real checks before anything lands, so a resolution that breaks one cannot merge.'
    : 'The branch is rebased and force-pushed; the issue is back to ready-to-merge. The merge worker rebases it onto current main and re-runs the real checks before anything lands, so a resolution that breaks one cannot merge.')
  return lines.join('\n')
}

// ───────────────────────── Pipeline ─────────────────────────
async function main() {
try {
  phase('Prepare')
  const prep = await prepare(issue)
  if (prep.refused) {
    log(`Prepare refused: ${prep.refused}`)
    return { skipped: true, issue, reason: prep.refused, refusalFinal: !!prep.refusalFinal }
  }
  attempt = prep.attempt
  prUrl = prep.prUrl || null
  if (prep.gitBlocked) return await fail('prepare', prep.gitBlocked)
  // Fail closed on discovery, exactly like epic-run: an empty package list
  // would make the verify gate a silent no-op on a rewritten merge.
  const packages = Array.isArray(prep.packages) ? prep.packages : []
  if (!packages.length) {
    return await fail('prepare', 'layout discovery found no package declaring an `npm run verify` script — refusing to ship a resolution nothing would verify.')
  }
  const marked = Array.isArray(prep.markedFiles) ? prep.markedFiles : []
  log(prep.partialRecord
    ? `Prepare: attempt ${attempt} on PR ${prep.prUrl} — authenticated partial record selected ${prep.judgmentHunks.length} previously declined hunk(s); captured origin/main is unchanged. Packages: ${pkgList(packages)}.`
    : prep.cleanRebase
    ? `Prepare: attempt ${attempt} on PR ${prep.prUrl} — rebase onto origin/main was CLEAN (the conflict evaporated).`
    : `Prepare: attempt ${attempt} on PR ${prep.prUrl} — mechanical hunks settled, ${marked.length} file(s) left for judgment${marked.length ? ` (${marked.join(', ')})` : ''}. Packages: ${pkgList(packages)}.`)

  // ───────────────────────── Resolve (judgment hunks only) ─────────────────────────
  let dispositions = []
  if (marked.length) {
    currentPhase = 'resolve'
    phase('Resolve')
    const res = await agent(PROMPTS.resolve(issue, prep),
      { label: 'resolve', phase: 'Resolve', step: 'fix-conflicts', schema: RESOLVE_SCHEMA })
    if (!res) return await fail('resolve', 'the resolver produced no result — the rebase is aborted for a clean retry.')
    const normalized = normalizedDispositions(res, prep.judgmentHunks)
    if (normalized.problem) return await fail('resolve', normalized.problem)
    dispositions = normalized.dispositions
    const declined = dispositions.filter(d => d.action === 'declined')
    const repaired = dispositions.filter(d => d.action === 'repaired')
    if (!repaired.length) {
      return await fail('resolve', `the resolver declined every judgment hunk: ${declined.map(d => `${d.file} hunk ${d.hunk}: ${d.reason}`).join('; ')}`)
    }
    // The claim of completion, checked against the tree.
    if (prep.partialRecord) {
      if (!(await gitOut(['status', '--porcelain'], 'git status'))) {
        return await fail('resolve', 'the resolver reported a repaired prior decline but changed no file')
      }
      log(`Resolve: ${repaired.length} previously declined hunk(s) repaired, ${declined.length} still declined; working-tree delta ready for verification.`)
    } else {
      const problem = await resolutionProblem(marked)
      if (problem) return await fail('resolve', `the resolver reported completion but ${problem}.`)
      log(`Resolve: ${repaired.length} judgment hunk(s) repaired, ${declined.length} declined; rebase finished clean.`)
    }
  }

  // ───────────────────────── Verify ─────────────────────────
  // The fixer NEVER fixes code: a red verify here means the resolution (or the
  // combination of the two sides) broke something, and that goes to a human.
  currentPhase = 'verify'
  phase('Verify')
  const v = await runVerify(packages)
  if (!v.green) return await fail('verify', `npm run verify is red after the resolution (${v.detail}) — the fixer never fixes code, so nothing was pushed and the PR branch is untouched.`)
  log(`Verify: green — ${v.detail}`)

  // ───────────────────────── Adversarial check ─────────────────────────
  // Skipped when no judgment was exercised: a clean rebase or an all-
  // mechanical stop has nothing for a skeptic to refute — the containment
  // gate already proved the mechanical share, line by line.
  let check = null
  if (marked.length) {
    currentPhase = 'check'
    phase('Check')
    if (prep.partialRecord) await intentToAdd()
    check = await agent(PROMPTS.check(issue, prep, dispositions),
      { label: 'check', phase: 'Check', step: 'confirm-review', schema: CHECK_SCHEMA })
    if (!check) return await fail('check', 'the adversarial checker produced no result — an unchecked resolution must not ship.')
    if (!check.survives || check.confidence < 75) {
      return await fail('check', `the adversarial check refuted the resolution (survives=${check.survives}, confidence ${check.confidence}): ${check.reasoning}`)
    }
    log(`Check: survived — ${check.reasoning} (confidence ${check.confidence}).`)
  }

  // ───────────────────────── Ship ─────────────────────────
  currentPhase = 'ship'
  phase('Ship')
  const declined = dispositions.filter(d => d.action === 'declined')
  const partial = declined.length > 0
  const shipped = await ship(issue, prep, () => buildComment(prep, dispositions, v.detail, check), {
    partial,
    dispositions,
    verifyDetail: v.detail,
    check,
  })
  if (!shipped.pushed) {
    return await fail('ship', `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`)
  }
  if (partial && (!shipped.labelled || !shipped.reported)) {
    return await blockPushedPartial(
      `the partial repair was pushed, but its human-held landing could not be fully verified${shipped.note ? ` (${shipped.note})` : ''}`,
      { reviewSettled: shipped.labelled })
  }
  if (!shipped.labelled) {
    // Fail closed on the label half too: pushed-but-unlabelled would leave a
    // fixed PR on an issue reap reads as "still working" — a leaked slot and
    // an invisible success. failed + the blocker comment puts a human on it.
    return await fail('ship', `pushed, but the ready-to-merge label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed and rebased.`)
  }
  if (partial) {
    log(`Ship: partial repair pushed and held for review — ${declined.map(d => `${d.file} hunk ${d.hunk}: ${d.reason}`).join('; ')}`)
  } else {
    log(`Ship: pushed and labelled ready-to-merge — ${prep.prUrl}`)
  }

  return {
    issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt,
    cleanRebase: !!prep.cleanRebase,
    resolvedHunks: dispositions.filter(d => d.action === 'repaired').length,
    declinedHunks: declined.map(d => ({ file: d.file, hunk: d.hunk, reason: d.reason })),
    checkConfidence: check ? check.confidence : null,
    verify: v.detail,
    ...(partial ? { readyToReview: true } : { readyToMerge: true }),
  }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

const RESULT = await main()
// Best effort, and awaited so the edit lands before the process goes: this is the
// last thing the issue page will show until a human or the merge worker acts.
await statusFinish(RESULT?.held ? `**held**: provider quota exhausted, resumes after ${RESULT.holdUntil} — vendor: ${RESULT.vendor}; provider reason: "${RESULT.reason}"` : RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToMerge ? `**done** — ${RESULT.prUrl} is back to ready-to-merge` : RESULT?.readyToReview ? `**done, held for review** — ${RESULT.prUrl}; declined: ${RESULT.declinedHunks.map(d => `${d.file} hunk ${d.hunk}: ${d.reason}`).join('; ')}` : '**finished**', { budget: terminalWindow || undefined })
process.exit(finish(RESULT))
