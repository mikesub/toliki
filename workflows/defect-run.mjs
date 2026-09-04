#!/usr/bin/env node
// defect-run — bounded repair for a finished epic PR whose deterministic ship
// gate held only on concrete defects (`needs-defect-fix`). This is a separate
// session, never a second round inside epic-run: it reads the authenticated,
// PR/head-bound gate envelope epic-run persisted on GitHub, edits exactly those
// defects, runs the project's real verify contract, and intent-adds new files
// before giving the exact delta to a blind adversarial checker.
// Only a verified fix is amended and force-pushed under a lease, after which
// the issue returns to ready-to-merge for the merge worker's rebase and check
// re-run. Everything else rests at ready-to-review for a human.
//
// Attempt ladder in labels: defect-attempted, then defect-retried. The labels
// are never reset by automation, so this repair session cannot become a loop.

import { agent, phase, log, initRuntime, onPhase, onLog } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { failureReason } from './lib/proc.mjs'
import { ensureLabels, editLabels, issueLabels, issueView, comment, openPrs, prView, repositoryView, authenticatedLogin, terminalBudget } from './lib/github.mjs'
import { git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, pushRejected, intentToAdd } from './lib/repo.mjs'
import { matchingDefectEvidence } from './lib/defect-evidence.mjs'
import { finalizeFixerIssue } from './lib/fixer-finalize.mjs'

const USAGE = `Usage: defect-run.mjs --issue <N> [--session <name>] [--engine <name>]

  --issue <N>  the needs-defect-fix issue whose completed PR is held for review
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase

Exit: 0 fixed, 1 usage/crash, 2 skipped/refused, 3 blocked.
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

async function settle(issue, body, { terminal = 'review', removeQueue = false } = {}) {
  const add = terminal === 'failed' ? ['failed'] : ['ready-to-review']
  const remove = terminal === 'failed'
    ? ['in-progress', 'ready-to-review', 'ready-to-merge', ...(removeQueue ? ['needs-defect-fix'] : [])]
    : ['in-progress', 'failed', 'ready-to-merge', ...(removeQueue ? ['needs-defect-fix'] : [])]
  // A body that describes the resting state is a function of the readback, and
  // it is told which label this swap actually asked for, so its prose cannot
  // drift from the labels written here.
  const compose = typeof body === 'function' ? state => body({ ...state, resting: add[0] }) : body
  const settled = await finalizeFixerIssue({ issue, body: compose, add, remove, required: add, absent: remove })
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
  const evidence = matchingDefectEvidence(comments.comments, {
    actor, issue, prNumber: pr.number, branch: pr.headRefName, head: pr.headRefOid,
  })
  if (!evidence) {
    return refuseFinal(queueRefusal('🤖 fix-defect refused: missing trusted defect-fix evidence',
      'No canonical evidence comment authored by the authenticated automation identity matches this issue, PR, branch, and head.'),
      'missing trusted defect-fix evidence for the selected PR head', { removeQueue: true })
  }

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
  const base = { attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number, prHead: pr.headRefOid, repoName, evidence }

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

  const packages = discoverPackages('.')
  if (!packages.length) return { ...base, gitBlocked: 'layout discovery found no package declaring an `npm run verify` script — refusing to ship a fix nothing would verify' }
  const depLines = await ensureDeps(packages, { pairs: [['origin/main', 'HEAD']] })
  return { ...base, packages, depLines }
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
  let observedPr
  try {
    observedPr = await prView(prep.prNumber, 'number,headRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner')
  } catch (e) {
    return { pushed: true, labelled: false, note: `the selected PR could not be read after push (${e?.message || e})` }
  }
  if (observedPr.number !== prep.prNumber || observedPr.headRefName !== prep.branch || observedPr.headRefOid !== amendedHead ||
      observedPr.isCrossRepository !== false || prRepositoryName(observedPr).toLowerCase() !== prep.repoName.toLowerCase()) {
    return { pushed: true, labelled: false, note: `selected PR head did not advance to amended HEAD ${amendedHead} (observed ${observedPr.headRefOid || 'missing'})` }
  }
  await comment(issue, body)
  // From here the run is inside reap's settle window: the swap starts the clock
  // the moment GitHub processes it, so the write and the readback after it share
  // one budget (see terminalBudget) and the run still has a RESULT line to write.
  const budget = terminalBudget()
  await ensureLabels(['ready-to-merge'], { budget })
  const flip = await editLabels(issue, { add: ['ready-to-merge'], remove: ['ready-to-review', 'in-progress', 'failed', 'needs-defect-fix'] }, { budget })
  let labels
  try {
    labels = await issueLabels(issue, { budget })
  } catch (e) {
    return { pushed: true, labelled: false, note: e && e.message || String(e) }
  }
  const absent = ['ready-to-review', 'in-progress', 'failed', 'needs-defect-fix']
  const labelled = labels.includes('ready-to-merge') && absent.every(l => !labels.includes(l))
  return { pushed: true, labelled, note: labelled ? '' : (flip.ok ? `observed labels: ${labels.join(', ')}` : failureReason(flip)) }
}

async function postBlocker({ phase: failedPhase, reason, prUrl, attempt }) {
  const next = attempt >= 2
    ? 'This was the RETRY (defect-attempted and defect-retried are both on the issue), so the defect fixer is done: repair by hand, or strip both defect-* attempt labels to grant another bounded round.'
    : attempt === 1
    ? 'This was the first attempt (defect-attempted is on the issue), so opted-in dispatch relaunches the fixer once after this session is reaped. A non-opted-in repo waits for an explicit operator launch.'
    : 'The attempt ladder was not reached; the issue remains ready-to-review for a human.'
  await settle(issue, `🤖 fix-defect blocked\n- phase: ${failedPhase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- next: ${next}\n`)
}

let currentPhase = 'prepare'
let blockerPosted = false
let prUrl = null
let attempt = 0
async function fail(failedPhase, reason) {
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

const buildComment = (prep, fix, verifyDetail, check) => [
  '🤖 fix-defect repaired ship-gate defects',
  `- pr: ${prep.prUrl}`,
  `- attempt: ${prep.attempt}`,
  '',
  'Gate evidence:',
  JSON.stringify(prep.evidence),
  '',
  `Fix: ${fix.summary || 'not stated'}`,
  ...(Array.isArray(fix.files) && fix.files.length ? [`Files: ${fix.files.join(', ')}`] : []),
  '',
  `An adversarial check, blind to the fixer's explanation, confirmed every named defect is repaired without a weakened gate or unrelated regression (confidence ${check.confidence}/100).`,
  '',
  `verify: ${verifyDetail}`,
  '',
  'The branch is amended and force-pushed; the issue is back to ready-to-merge. The merge worker rebases it onto current main and re-runs the real checks before anything lands.',
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
  const shipped = await ship(issue, prep, buildComment(prep, fix, verified.detail, check))
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
await statusFinish(RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToMerge ? `**done** — ${RESULT.prUrl} is back to ready-to-merge` : '**finished**')
process.exit(finish(RESULT))
