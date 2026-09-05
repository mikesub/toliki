#!/usr/bin/env node
// defect-run — bounded repair for a finished epic PR whose deterministic ship
// gate held only on concrete defects (`needs-defect-fix`). This is a separate
// session, never a continuation of epic-run's own two fix rounds, which end at
// that gate: it reads the authenticated, PR/head-bound gate envelope epic-run
// persisted on GitHub, edits exactly those defects, runs the project's real
// verify contract, and intent-adds new files before giving the exact delta to a
// blind adversarial checker.
// Only a verified fix is amended and force-pushed under a lease, after which
// the issue returns to ready-to-merge for the merge worker's rebase and check
// re-run. Everything else rests at ready-to-review for a human.
//
// Every readback that verifies one of this run's own writes — the PR head after
// the force push, the labels after the landing swap — is bounded rather than
// single-shot (readBack in lib/github.mjs): GitHub shows a force push seconds
// after it lands, and one immediate read reported two complete repairs as
// unverified landings. Retries change timing, never verdicts.
//
// Landing-only retry: an attempt that pushed a verified and checked repair and
// then could not confirm the landing — the head readback or the label swap —
// leaves the evidence envelope bound to the PRE-push head, so a relaunch finds
// no matching evidence for the head the PR now carries. What is unfinished
// there is the LANDING, not the repair: re-running the fixer would send a
// second repair at defects already repaired. So the audit comment carries a
// landing record bound to the amended head (see lib/defect-evidence.mjs) and is
// posted as soon as the push is a fact, and a relaunch that finds one whose
// priorHead has a matching evidence envelope skips Fix, Verify and Check and
// redoes only the landing swap. The trust model is otherwise unchanged.
//
// Attempt ladder in labels: defect-attempted, then defect-retried. The labels
// are never reset by automation, so this repair session cannot become a loop.
// A hard provider-quota death cleans the unpushed edit and records the
// host-wide hold before labels move. A verified hold refunds this invocation's
// rung; an unverified transition restores it and blocks inside the same
// terminal-report window.

import { agent, phase, log, initRuntime, onPhase, onLog, takeAgentFailure, withAgentFailure } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { failureReason } from './lib/proc.mjs'
import { ensureLabels, editLabels, issueLabels, issueView, comment, openPrs, prView, repositoryView, authenticatedLogin, readBack, waitedFor, terminalBudget, terminalTransition, verifyIssueEngine } from './lib/github.mjs'
import { git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, pushRejected, intentToAdd } from './lib/repo.mjs'
import { matchingDefectEvidenceComment, matchingDefectRepair, renderDefectEvidenceSection, renderDefectRepair } from './lib/defect-evidence.mjs'
import { finalizeFixerIssue, finalizeFixerQuotaHold } from './lib/fixer-finalize.mjs'
import { recordQuotaHold } from './quota-hold.mjs'

const USAGE = `Usage: defect-run.mjs --issue <N> [--session <name>] [--engine <name>]

  --issue <N>  the needs-defect-fix issue whose completed PR is held for review
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase

Exit: 0 fixed or provider-held, 1 usage/crash, 2 skipped/refused, 3 blocked.
The final line is RESULT <json>.`

const PROMPTS = {
  fix: (issue, prep) =>
`Repair every concrete defect named by the deterministic ship gate for the finished PR on branch ${prep.branch} (issue #${issue}). HEAD is exactly the captured PR head. This is a bounded repair of an already reviewed change, not a new feature round.

The authenticated, PR/head-bound ship-gate evidence is:

${JSON.stringify(prep.evidence, null, 2)}

The original requirement captured by that completed epic-run is pinned here (do not re-read the mutable issue body):

Title: ${prep.evidence.requirement.title}
Body:
${prep.evidence.requirement.body}

The original PR change is \`git diff origin/main...HEAD\` (also --stat).

Rules:
1. Repair every defect named by the gate evidence; ignore non-defect deferrals, which are context rather than permission to expand this repair.
2. Never reclassify or dismiss a named defect to keep the merge moving. If the evidence does not support a safe code change, escalate instead of guessing.
3. Make no unrelated change. This PR was already reviewed; keep the delta as small as the named defects allow.
4. Never weaken, skip, delete, or loosen a test, check, assertion, type, lint rule, or security guard. If a test is genuinely wrong, make the smallest correction and say so in the summary.
5. Do NOT commit, amend, push, or touch labels/comments. Leave the repair in the working tree for the orchestrator to verify and check.
6. Do NOT open anything under \`.epics/\`; durable GitHub evidence above is the entire repair brief.

Return: completed (true only if every gate-named defect is repaired), escalate (instead of completing when a safe complete repair is not possible), summary, and files (each file touched).`,

  check: (issue, prep, fixDiffCmd) =>
`Adversarially check a ship-gate defect repair you did not write. The finished PR on branch ${prep.branch} (issue #${issue}) was held by the durable evidence below. Something edited the tree, and that edit is exactly \`${fixDiffCmd}\` (also readable with --stat). The fixer's explanation is deliberately withheld: judge only the evidence and code.

Authenticated, PR/head-bound ship-gate evidence:

${JSON.stringify(prep.evidence, null, 2)}

Pinned original requirement (do not re-read the mutable issue body):

Title: ${prep.evidence.requirement.title}
Body:
${prep.evidence.requirement.body}

Try to refute all three claims: every named defect is actually fixed; no test/check/assertion/type/lint/security guard was weakened or removed; and the delta introduces no unrelated behavior or regression. Ignore non-defect deferrals. Never accept reclassification of a named defect as a fix.

Gather the original PR change from \`git diff origin/main...HEAD\`. Do NOT open \`.epics/\`.

Default to refuted. If you cannot positively establish every claim from the code and durable evidence, return survives=false. This issue rejoins the unattended merge queue only on a surviving verdict with confidence at least 75.

Return: survives, confidence (0-100), reasoning (name the evidence, whichever way you rule).`,
}

const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['completed'],
  properties: {
    completed: { type: 'boolean', description: 'true only when every gate-named defect is repaired' },
    escalate: { type: 'string', description: 'set instead of completing when the evidence does not support a safe complete repair' },
    summary: { type: 'string', description: 'what changed and why it repairs the named defects' },
    files: { type: 'array', items: { type: 'string' }, description: 'each file touched' },
  },
}
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['survives', 'confidence', 'reasoning'],
  properties: {
    survives: { type: 'boolean', description: 'true only if every named defect is fixed without weakening a gate or causing unrelated regressions' },
    confidence: { type: 'number', description: '0-100' },
    reasoning: { type: 'string', description: 'names the evidence, whichever way it rules' },
  },
}

let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { allowSlug: false, usage: USAGE })
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write((e.message ? `defect-run: ${e.message}\n\n` : '') + e.usage + '\n')
    process.exit(e.message ? EXIT.ERROR : EXIT.OK)
  }
  throw e
}
initRuntime({ scriptName: 'defect-run', sessionName: ARGS.session, defaultEngine: ARGS.engine, issue: ARGS.issue })
initStatus({ issue: ARGS.issue, script: 'defect-run', session: ARGS.session, phases: ['Prepare', 'Fix', 'Verify', 'Check', 'Ship'] })
onPhase(statusPhase)
onLog(statusNote)
const issue = ARGS.issue
let terminalWindow = null

async function settle(issue, body, { terminal = 'review', removeQueue = false } = {}) {
  // One resting label, every other one derived off it (see terminalTransition): a refusal after the
  // landing swap has to strip the `ready-to-merge` GitHub may already have applied, or a blocked run
  // stays selectable by the merge worker.
  const { add, remove } = terminalTransition({
    rest: terminal === 'failed' ? 'failed' : 'ready-to-review',
    drop: removeQueue ? ['needs-defect-fix'] : [],
  })
  // A body that describes the resting state is a function of the readback, and
  // it is told which label this swap actually asked for, so its prose cannot
  // drift from the labels written here.
  const compose = typeof body === 'function' ? state => body({ ...state, resting: add[0] }) : body
  const settled = await finalizeFixerIssue({ issue, body: compose, add, remove, required: add, absent: remove })
  terminalWindow = settled.budget
  if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
  if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
  return settled
}

async function refuseFinal(body, reason, options) {
  await settle(issue, body, options)
  return { refused: reason, refusalFinal: true }
}

// A final refusal that takes the issue out of the fixer queue tells the operator
// where the issue now rests. That is a claim about labels, so it is composed
// from the verified readback and never hardcoded: when the swap fails the issue
// is still dispatchable, and the comment has to say so and name the manual
// repair instead of the structural action alone. Every removeQueue refusal
// builds its body here.
//
// The situation sentence never describes the issue's labels — the swap has
// already happened by the time it is written, so "is labelled needs-defect-fix"
// would contradict the removal reported in the next breath. It states what the
// fixer found; the label state comes from the readback alone.
//
// A half-landed swap is the case worth the care: the readback says per label
// what is missing and what is stuck, so the guidance names those repairs and
// only those. Telling an operator to strip a label that is already gone, or to
// set one that is already there, is exactly as wrong as claiming the swap
// worked. Only an unreadable readback earns the conservative "check both".
const queueRefusal = (header, situation, human = '') => ({ settled, readable, missing, stuck, stateError, resting }) => {
  const then = human ? ` Then: ${human}` : ''
  if (settled) {
    return `${header}\n${situation} needs-defect-fix has been removed automatically, so the issue is out of the fixer queue and rests at ${resting}.` +
      (human ? ` The only remaining step is human: ${human}` : ' A human takes it from there.')
  }
  if (!readable) {
    return `${header}\n${situation} The resulting labels could NOT be read back (${stateError}), so it is unknown whether the issue left the fixer queue: check by hand that needs-defect-fix is gone and ${resting} is set.` + then
  }
  const queue = stuck.includes('needs-defect-fix')
    ? 'needs-defect-fix could NOT be removed, so the issue may still be in the fixer queue and dispatchable'
    : 'needs-defect-fix has been removed automatically, so the issue is out of the fixer queue, but the transition did not complete'
  const repairs = [
    ...(missing.length ? [`set ${missing.join(', ')}`] : []),
    ...(stuck.length ? [`remove ${stuck.join(', ')}`] : []),
  ].join(' and ')
  return `${header}\n${situation} ${queue} (${stateError}): ${repairs} by hand.` + then
}

const prRepositoryName = pr => {
  const owner = String(pr?.headRepositoryOwner?.login || '').trim()
  const name = String(pr?.headRepository?.name || '').trim()
  return owner && name ? `${owner}/${name}` : ''
}

async function prepare(issue) {
  const view = await issueView(issue, 'state,labels,title')
  const labels = Array.isArray(view.labels) ? view.labels.map(l => l.name) : []
  if (String(view.state || '').toUpperCase() === 'CLOSED') return { refused: `issue #${issue} is closed` }
  if (!labels.includes('needs-defect-fix')) return { refused: `issue #${issue} is not labelled needs-defect-fix — not a defect fixer's issue` }

  // The later defect session is still part of the claimed change. Its engine
  // must match the durable singleton before evidence reads or attempt writes.
  await verifyIssueEngine(issue, ARGS.engine)
  if (labels.includes('defect-retried')) {
    return refuseFinal('🤖 fix-defect refused: attempt ladder exhausted\nTwo defect fixer attempts already ran (defect-attempted + defect-retried are both on the issue). A human decides now: repair the named defects by hand, or strip both defect-* attempt labels to grant another bounded round.',
      'attempt ladder exhausted (defect-retried present)')
  }

  let repoName
  try {
    repoName = String((await repositoryView('nameWithOwner')).nameWithOwner || '')
    if (!repoName) throw new Error('gh repo view returned no nameWithOwner')
  } catch (e) {
    return refuseFinal(queueRefusal('🤖 fix-defect refused: repository identity could not be verified',
      `The fixer could not bind a PR to the registered origin (${e?.message || e}).`),
      'repository identity could not be verified', { removeQueue: true })
  }
  const prefix = `epic/${issue}-`
  const prs = (await openPrs('number,url,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner')).filter(p =>
    String(p.headRefName || '').startsWith(prefix) && p.isCrossRepository === false &&
    prRepositoryName(p).toLowerCase() === repoName.toLowerCase())
  if (!prs.length) {
    return refuseFinal(queueRefusal('🤖 fix-defect refused: no open PR',
      `The defect fixer found no open PR delivering issue #${issue} (branch epic/${issue}-*).`,
      'restore or open the PR by hand.'),
      `no open PR from the registered repository on an epic/${issue}-* branch`, { terminal: 'failed', removeQueue: true })
  }
  if (prs.length > 1) {
    return refuseFinal(queueRefusal('🤖 fix-defect refused: multiple open PRs',
      `Issue #${issue} has ${prs.length} open PRs on epic/${issue}-* branches — ambiguous.`,
      'close the extra PR(s) by hand so one PR delivers the issue.'),
      `multiple open PRs on epic/${issue}-* branches — ambiguous`, { removeQueue: true })
  }
  const pr = prs[0]

  // The repair brief is privileged input to a write-capable agent. Accept only
  // the current credential's canonical record for this exact PR head, before
  // consuming an attempt or allowing any model to touch the tree.
  let actor, comments
  try {
    actor = await authenticatedLogin()
    comments = await issueView(issue, 'comments')
  } catch (e) {
    return refuseFinal(queueRefusal('🤖 fix-defect refused: trusted defect-fix evidence could not be read',
      `The authenticated repair brief could not be verified (${e?.message || e}).`),
      'trusted defect-fix evidence could not be read', { removeQueue: true })
  }
  const evidenceRecord = matchingDefectEvidenceComment(comments.comments, {
    actor, issue, prNumber: pr.number, branch: pr.headRefName, head: pr.headRefOid,
  })
  // No evidence for THIS head is the normal untrusted case — except in one
  // shape: an earlier attempt already pushed the repair for this head and could
  // not verify its landing swap, which leaves the envelope bound to the head
  // before that push. The landing record it wrote says so, and it is trusted on
  // exactly the terms the envelope is: authored by the current credential and
  // bound to this issue, PR, branch and head. The envelope it names as the head
  // it repaired FROM has to be a trusted one too, so a record alone can never
  // stand in for evidence. Nothing else relaxes: fork PRs, stale heads and
  // mutable issue prose were already rejected above and still are.
  let landing = null
  if (!evidenceRecord) {
    const record = matchingDefectRepair(comments.comments, {
      actor, issue, prNumber: pr.number, branch: pr.headRefName, head: pr.headRefOid,
    })
    const priorEvidenceRecord = record && matchingDefectEvidenceComment(comments.comments, {
      actor, issue, prNumber: pr.number, branch: pr.headRefName, head: record.pr.priorHead,
    })
    if (priorEvidenceRecord) landing = { record, evidenceRecord: priorEvidenceRecord }
  }
  if (!evidenceRecord && !landing) {
    return refuseFinal(queueRefusal('🤖 fix-defect refused: missing trusted defect-fix evidence',
      'No canonical evidence comment authored by the authenticated automation identity matches this issue, PR, branch, and head.'),
      'missing trusted defect-fix evidence for the selected PR head', { removeQueue: true })
  }
  const { evidence, summary: evidenceSummary } = evidenceRecord || landing.evidenceRecord

  // Count and verify the attempt before a model can edit anything.
  const attempt = labels.includes('defect-attempted') ? 2 : 1
  const ladderLabel = attempt === 2 ? 'defect-retried' : 'defect-attempted'
  await ensureLabels(['defect-attempted', 'defect-retried', 'in-progress'])
  await editLabels(issue, { add: ['in-progress', ladderLabel], remove: ['ready-to-review', 'failed'] })
  const now = await issueLabels(issue)
  if (!now.includes('in-progress') || !now.includes(ladderLabel) || now.includes('ready-to-review') || now.includes('failed')) {
    await settle(issue, '🤖 fix-defect blocked\n- phase: prepare\n- reason: could not record the defect-fixer attempt (label write failed)')
    return { refused: 'could not record the defect-fixer attempt (label write failed)' }
  }
  const base = {
    attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number,
    prHead: pr.headRefOid, repoName, evidence, evidenceSummary,
    ...(landing ? { landing: landing.record } : {}),
  }

  await git(['rebase', '--abort'])
  await gitOut(['fetch', 'origin', '--prune'], 'git fetch origin --prune')
  const originHead = (await git(['rev-parse', `refs/remotes/origin/${pr.headRefName}`])).out
  if (originHead !== pr.headRefOid) {
    return { ...base, gitBlocked: `branch ${pr.headRefName} moved under the fixer (PR head ${pr.headRefOid}, origin now ${originHead || 'missing'})` }
  }
  await gitOut(['checkout', '-f', '--detach', pr.headRefOid], 'git checkout --detach')
  const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (above !== 1) {
    return { ...base, gitBlocked: `the PR branch holds ${Number.isNaN(above) ? 'an unknown number of' : above} commit(s) above origin/main — an epic branch holds exactly one, so this is not a shape the defect fixer can amend` }
  }

  // Landing only: the tree is already the repaired one, and nothing here will
  // edit, verify or check it. The branch shape above still had to hold — this
  // run relabels a PR, so the PR must still be the one the record describes.
  if (base.landing) return base

  const packages = discoverPackages('.')
  if (!packages.length) return { ...base, gitBlocked: 'layout discovery found no package declaring an `npm run verify` script — refusing to ship a fix nothing would verify' }
  const depLines = await ensureDeps(packages, { pairs: [['origin/main', 'HEAD']] })
  return { ...base, packages, depLines }
}

// The landing half: the swap back into the unattended merge queue and the
// readback that verifies it. Separate from the push half because a relaunch
// after a pushed-but-unverified landing has only this left to do. The caller
// posts its own audit comment first — before the swap, so the record it carries
// is durable no matter how the landing then goes.
async function land(issue) {
  // From here the run is inside reap's settle window: the swap starts the clock
  // the moment GitHub processes it, so the write and the readback after it share
  // one budget (see terminalBudget) and the run still has a RESULT line to write.
  // A readback that cannot confirm the landing drops into the blocker path, which
  // transitions the labels again — inside THIS window, not a second one.
  const budget = terminalBudget()
  const absent = ['ready-to-review', 'in-progress', 'failed', 'needs-defect-fix']
  await ensureLabels(['ready-to-merge'], { budget })
  const flip = await editLabels(issue, { add: ['ready-to-merge'], remove: absent }, { budget })
  let seen
  try {
    seen = await readBack(
      () => issueLabels(issue, { budget }),
      ls => ls.includes('ready-to-merge') && absent.every(l => !ls.includes(l)),
      { budget })
  } catch (e) {
    return { labelled: false, note: e && e.message || String(e) }
  }
  const labels = seen.observed
  return { labelled: seen.matched, note: seen.matched ? '' : (flip.ok ? `observed labels: ${labels.join(', ')}` : failureReason(flip)) }
}

async function ship(issue, prep, body) {
  await gitOut(['add', '-A'], 'git add -A')
  if ((await git(['diff', '--cached', '--quiet'])).code === 0) return { pushed: false, labelled: false, note: 'nothing staged to amend' }
  await gitOut(['commit', '-q', '--amend', '--no-edit'], 'git commit --amend')
  const amendedHead = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')
  const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (above !== 1) return { pushed: false, labelled: false, note: `the amended branch holds ${above} commits above origin/main` }

  const push = await git(['push', `--force-with-lease=refs/heads/${prep.branch}:${prep.prHead}`, 'origin', `HEAD:refs/heads/${prep.branch}`])
  if (!push.ok) return { pushed: false, labelled: false, note: pushRejected(push) ? `rejected — ${prep.branch} moved on origin under this run` : failureReason(push) }
  // The audit comment goes on the issue as soon as the push is a fact, before
  // anything this run still has to verify. It carries the landing record, and
  // the record's whole purpose is to survive a landing this run cannot finish:
  // written after the head readback it would be missing in exactly the case it
  // exists for, and the next attempt would repair defects already repaired.
  await comment(issue, body(amendedHead))
  // GitHub shows a force push seconds after it lands, so the head is re-read
  // until it equals the amended commit or the window ends. No terminal label has
  // been written yet, so this is on the default budget and outside reap's settle
  // window. A read that errors still fails immediately: it carries no verdict.
  const matches = observed => observed.number === prep.prNumber && observed.headRefName === prep.branch &&
    observed.headRefOid === amendedHead && observed.isCrossRepository === false &&
    prRepositoryName(observed).toLowerCase() === prep.repoName.toLowerCase()
  let seen
  try {
    seen = await readBack(
      () => prView(prep.prNumber, 'number,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner'),
      matches)
  } catch (e) {
    return { pushed: true, labelled: false, note: `the selected PR could not be read after push (${e?.message || e})` }
  }
  if (!seen.matched) {
    return { pushed: true, labelled: false, note: `selected PR head did not advance to amended HEAD ${amendedHead} (observed ${seen.observed.headRefOid || 'missing'} after ${seen.reads} reads over ${waitedFor(seen.waitedMs)})` }
  }
  return { pushed: true, amendedHead, ...(await land(issue)) }
}

const attemptRung = attempt => attempt === 2 ? 'defect-retried' : 'defect-attempted'

function attemptGuidance(attempt, state) {
  const normal = attempt >= 2
    ? 'This was the RETRY (defect-attempted and defect-retried are both on the issue), so the defect fixer is done: repair by hand, or strip both defect-* attempt labels to grant another bounded round.'
    : attempt === 1
    ? 'This was the first attempt (defect-attempted is on the issue), so opted-in dispatch relaunches the fixer once after this session is reaped. A non-opted-in repo waits for an explicit operator launch.'
    : 'The attempt ladder was not reached; the issue remains ready-to-review for a human.'
  if (!state || attempt < 1) return normal
  const rung = attemptRung(attempt)
  if (!state.readable) return `GitHub did not return a label readback; check that ${rung} is present before relaunching so this spent attempt is not refunded.`
  if (!state.labels.includes(rung)) return `${rung} could NOT be restored; set it by hand before relaunching so this spent attempt is not refunded.`
  return normal
}

const blockerBody = ({ failedPhase, reason, prUrl, attempt }, state) =>
  `🤖 fix-defect blocked\n- phase: ${failedPhase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- next: ${attemptGuidance(attempt, state)}\n`

async function postBlocker({ phase: failedPhase, reason, prUrl, attempt }) {
  await settle(issue, state => blockerBody({ failedPhase, reason, prUrl, attempt }, state))
}

let currentPhase = 'prepare'
let blockerPosted = false
let prUrl = null
let attempt = 0
async function holdForQuota(failedPhase, failure, reason) {
  try {
    await git(['reset', '--mixed', 'HEAD'])
    await git(['checkout', '-f', '--', '.'])
    await git(['clean', '-fd'])
    const { hostHold, trigger } = await recordQuotaHold({ vendor: failure.vendor, reason: failure.reason })
    const rung = attemptRung(attempt)
    const finalized = await finalizeFixerQuotaHold({
      issue,
      rung,
      hold: {
        add: ['ready-to-review', 'needs-defect-fix'],
        remove: ['in-progress', 'failed', 'ready-to-merge', rung],
      },
      blocked: {
        add: ['ready-to-review', 'needs-defect-fix'],
        remove: ['in-progress', 'failed', 'ready-to-merge'],
      },
      body: (state, holdState) => blockerBody({
        failedPhase,
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
        blocked: true, issue, phase: failedPhase,
        reason: withAgentFailure(`${reason} Provider quota hold failed: ${finalized.holdState.stateError}.`, failure),
        prUrl: prUrl || undefined,
        attempt,
      }
    }
    return { held: true, issue, phase: failedPhase, ...hostHold, ...trigger, attempt }
  } catch (error) {
    return { error: error?.message || String(error) }
  }
}

async function fail(failedPhase, reason) {
  const failure = takeAgentFailure()
  if (failure?.kind === 'quota-exhausted') {
    const held = await holdForQuota(failedPhase, failure, reason)
    if (!held.error) return held
    reason = `${reason} Provider quota hold failed: ${held.error}.`
  }
  reason = withAgentFailure(reason, failure)
  if (!blockerPosted) {
    blockerPosted = true
    try {
      await git(['reset', '--mixed', 'HEAD'])
      await git(['checkout', '-f', '--', '.'])
      await git(['clean', '-fd'])
      await postBlocker({ phase: failedPhase, reason, prUrl, attempt })
    } catch (e) {
      log(`blocked: could not report on GitHub (${e && e.message || e})`)
    }
  }
  return { blocked: true, issue, phase: failedPhase, reason, prUrl: prUrl || undefined, attempt }
}

// Posted BEFORE the landing swap, so the landing record it carries is durable
// even when the swap that follows cannot be verified — which is the whole case
// the record exists for.
const buildComment = (prep, fix, verifyDetail, check, amendedHead) => [
  '🤖 fix-defect repaired ship-gate defects',
  `- pr: ${prep.prUrl}`,
  `- attempt: ${prep.attempt}`,
  '',
  'Gate evidence:',
  renderDefectEvidenceSection(prep.evidence, { summary: prep.evidenceSummary }),
  '',
  `Fix: ${fix.summary || 'not stated'}`,
  ...(Array.isArray(fix.files) && fix.files.length ? [`Files: ${fix.files.join(', ')}`] : []),
  '',
  `An adversarial check, blind to the fixer's explanation, confirmed every named defect is repaired without a weakened gate or unrelated regression (confidence ${check.confidence}/100).`,
  '',
  `verify: ${verifyDetail}`,
  '',
  'The branch is amended and force-pushed. The issue goes back to ready-to-merge next, and the merge worker rebases it onto current main and re-runs the real checks before anything lands.',
  '',
  renderDefectRepair({
    version: 1,
    issue,
    pr: { number: prep.prNumber, url: prep.prUrl, branch: prep.branch, head: amendedHead, priorHead: prep.prHead },
    attempt: prep.attempt,
    verify: verifyDetail,
    checkConfidence: check.confidence,
  }),
].join('\n')

// The landing-only relaunch's own record. It claims nothing about code: the
// code claim belongs to the attempt that made it, and is named here as that
// attempt's, not as this one's.
const buildLandingComment = prep => [
  '🤖 fix-defect finished an unverified landing',
  `- pr: ${prep.prUrl}`,
  `- attempt: ${prep.attempt}`,
  '',
  `Attempt ${prep.landing.attempt || 1} repaired the gate-named defects on this exact head (${prep.prHead}), verified them (${prep.landing.verify}) and had them survive a blind adversarial check (confidence ${prep.landing.checkConfidence}/100), pushed the amended commit, and then could not verify the label swap. The repair is on origin already.`,
  '',
  'Only the landing was redone here: no file was touched, no repair was re-run, and no second repair was sent at defects that are already repaired. The issue goes back to ready-to-merge next, and the merge worker rebases it onto current main and re-runs the real checks before anything lands.',
].join('\n')

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

  if (prep.landing) {
    // Landing only. The repair on this head is already verified, checked and
    // pushed; a second repair round here would edit defects that no longer
    // exist. Nothing but the swap and its readback runs.
    log(`Prepare: attempt ${attempt} on PR ${prep.prUrl}. A durable landing record binds this head to an already verified and checked repair — redoing the landing only, no repair round.`)
    currentPhase = 'ship'
    phase('Ship')
    await comment(issue, buildLandingComment(prep))
    const landed = await land(issue)
    if (!landed.labelled) return await fail('ship', `the earlier attempt's repair is already pushed, but the ready-to-merge label swap could not be verified${landed.note ? ` (${landed.note})` : ''} — a human finishes the labels; the PR itself is fixed.`)
    log(`Ship: landing redone and labelled ready-to-merge — ${prep.prUrl}`)
    return {
      issue,
      prUrl: prep.prUrl,
      branch: prep.branch,
      attempt,
      landingOnly: true,
      verify: prep.landing.verify,
      checkConfidence: prep.landing.checkConfidence,
      note: `the repair on ${prep.prHead} was already verified and checked by attempt ${prep.landing.attempt || 1}; only the landing was redone`,
      readyToMerge: true,
    }
  }

  log(`Prepare: attempt ${attempt} on PR ${prep.prUrl}. Durable gate evidence found; packages: ${pkgList(prep.packages)}. ${prep.depLines.join('; ')}`)

  currentPhase = 'fix'
  phase('Fix')
  const fix = await agent(PROMPTS.fix(issue, prep),
    { label: 'fix-defect', phase: 'Fix', step: 'fixes-after-review', schema: FIX_SCHEMA })
  if (!fix) return await fail('fix', 'the defect fixer produced no result — nothing was pushed and the PR branch is untouched.')
  if (fix.escalate) return await fail('fix', `escalated rather than guessed: ${fix.escalate}`)
  if (!fix.completed) return await fail('fix', 'the defect fixer did not complete every named repair.')
  if (!(await gitOut(['status', '--porcelain'], 'git status'))) {
    return await fail('fix', 'the defect fixer reported a fix but changed no file — the named defects remain in the captured PR tree.')
  }
  log(`Fix: ${fix.summary || 'no summary'}`)

  currentPhase = 'verify'
  phase('Verify')
  const verified = await runVerify(prep.packages)
  log(`Verify: ${verified.green ? 'green' : 'RED'} — ${verified.detail}`)
  if (!verified.green) return await fail('verify', `npm run verify is red after the defect repair (${verified.detail}) — nothing was pushed and the PR branch is untouched.`)

  currentPhase = 'check'
  phase('Check')
  await intentToAdd()
  const check = await agent(PROMPTS.check(issue, prep, `git diff ${prep.prHead}`),
    { label: 'defect-check', phase: 'Check', step: 'confirm-review', schema: CHECK_SCHEMA })
  if (!check) return await fail('check', 'the adversarial checker produced no result — an unchecked repair must not rejoin the merge queue.')
  if (!check.survives || check.confidence < 75) {
    return await fail('check', `the adversarial check refuted the repair (survives=${check.survives}, confidence ${check.confidence}): ${check.reasoning}`)
  }
  log(`Check: survived — ${check.reasoning} (confidence ${check.confidence}).`)

  currentPhase = 'ship'
  phase('Ship')
  const shipped = await ship(issue, prep, amendedHead => buildComment(prep, fix, verified.detail, check, amendedHead))
  if (!shipped.pushed) return await fail('ship', `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`)
  if (!shipped.labelled) return await fail('ship', `pushed, but the ready-to-merge label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed.`)
  log(`Ship: pushed and labelled ready-to-merge — ${prep.prUrl}`)

  return {
    issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt,
    summary: fix.summary,
    checkConfidence: check.confidence,
    verify: verified.detail,
    readyToMerge: true,
  }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

const RESULT = await main()
await statusFinish(RESULT?.held ? `**held**: provider quota exhausted, resumes after ${RESULT.holdUntil} — vendor: ${RESULT.vendor}; provider reason: "${RESULT.reason}"` : RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToMerge ? `**done** — ${RESULT.prUrl} is back to ready-to-merge` : '**finished**', { budget: terminalWindow || undefined })
process.exit(finish(RESULT))
