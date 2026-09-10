#!/usr/bin/env node
// ci-run — red-check adapter for a finished PR (needs-ci-fix).
// The merge worker found red checks on the rebased head. This file owns
// failing-check/job-log capture, pinned issue/change evidence, local
// reproduction, the CI-specific repair boundary and publication.
//
// Shared phase sequencing, verify retries, failure/refund handling and RESULT
// live in lib/fixer-lifecycle.mjs. Acceptance/correction/confirmation semantics
// live in lib/repair-acceptance.mjs; this adapter bounds them to the captured
// failures and forbids weakening gates. The repair and independent checker
// receive the same captured bytes, not retrieval commands.
//
// The independent ladder is ci-attempted then ci-retried. A complete accepted
// repair rejoins the merge worker for fresh checks; a verified partial repair
// keeps its work but remains human-held. Audit file lists come from the actual
// delta. Quota cleanup discards only the unpushed repair.
import { log } from './lib/runtime.mjs'
import { failureReason } from './lib/proc.mjs'
import { gh, ensureLabels, editLabels, issueLabels, comment, openPrs, readBack, terminalTransition } from './lib/github.mjs'
import { git, gitOut, captureDiff, changedFiles, discoverPackages, pkgList, ensureDeps, runVerify, pushRejected, intentToAdd } from './lib/repo.mjs'
import { captureIssueRecord } from './lib/evidence.mjs'
import { runFixerLifecycle, validateIndexedDispositions } from './lib/fixer-lifecycle.mjs'
import { ACCEPTANCE_SCHEMA, CONFIRMATION_SCHEMA, CORRECTION_SCHEMA } from './lib/repair-acceptance.mjs'
import { acceptancePrompt } from './prompts/ci/acceptance.mjs'
import { confirmPrompt } from './prompts/ci/confirm.mjs'
import { correctionPrompt } from './prompts/ci/correction.mjs'
import { fixPrompt } from './prompts/ci/fix.mjs'

const USAGE = `Usage: ci-run.mjs --issue <N> [--session <name>] [--engine <name>] [--repo <key>]

  --issue <N>  the needs-ci-fix issue whose PR came back red on its checks
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase
  --repo       registered repository key, for usage telemetry identity only

Exit: 0 fixed or provider-held, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

// How much of a failing job's log the fixer gets. Enough to hold a stack trace
// and the assertion around it; short enough that three failing jobs do not
// bury the prompt.
const LOG_LINES = 200
const MAX_JOBS = 3

// ───────────────────────── Prompts ─────────────────────────
// One MODULE per model step, under workflows/prompts/ci/ and imported above.
// Each carries only that step's task and the evidence this file captured for
// it; the standing rules are in the charter and the answer's shape is in the
// schema below.

// ───────────────────────── Config ─────────────────────────
// Which vendor, model and effort each step runs on is a row of the run's
// engine in etc/engines.json; every agent() call names only its step.
// fix-ci is the repair itself, and final-review is the last gate before an
// unattended merge, so a row for either wants the strong model.

// ───────────────────────── Schemas ─────────────────────────
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [],
  properties: {
    completed: { type: 'boolean', description: 'true only when the failing checks should now pass' },
    escalate: { type: 'string', description: 'set INSTEAD of completing when no code change here can fix the failure — what is failing and why' },
    cause: { type: 'string', description: 'one sentence: what actually made the checks red' },
    summary: { type: 'string', description: 'what changed and why it fixes that cause' },
    dispositions: {
      type: 'array',
      description: 'one repaired or declined disposition per numbered failed check',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'action', 'reason'],
        properties: {
          index: { type: 'number' },
          action: { enum: ['repaired', 'declined'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

// ───────────────────────── Transport ─────────────────────────
// Which checks are red on a PR head, from the same rollup the merge worker
// reads. Skipped and neutral count as success there and here; a check with no
// conclusion counts as failure, never as green.
function failedChecks(rollup) {
  const out = []
  for (const c of Array.isArray(rollup) ? rollup : []) {
    const name = c.name || c.context || 'check'
    if (c.__typename === 'CheckRun') {
      if (c.status === 'COMPLETED' && !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(c.conclusion)) out.push({ name, detailsUrl: c.detailsUrl })
    } else if (c.__typename === 'StatusContext') {
      if (!['SUCCESS', 'PENDING', 'EXPECTED'].includes(c.state)) out.push({ name, detailsUrl: c.targetUrl })
    }
  }
  return out
}

function normalizedDispositions(result, checks) {
  return validateIndexedDispositions(result, checks, {
    subject: 'the fixer', itemName: 'failed check',
    missing: 'the fixer returned no indexed failed-check dispositions',
    incomplete: 'the fixer did not complete',
    // Compatibility for complete pre-disposition payloads. The generic reason
    // keeps the repairer's private narrative out of the blind checker.
    legacy: value => value?.completed === true ? {
      dispositions: checks.map((_name, index) => ({ index: index + 1, action: 'repaired', reason: 'reported repaired' })),
    } : null,
    decorate: (name, disposition, index) => ({ ...disposition, index, name }),
  })
}

// The failing jobs' logs, which is the evidence a human would open first.
// Best effort: a log that cannot be fetched leaves the fixer with the check
// names and the local verify result, which the prompt says out loud rather
// than pretending the logs were empty.
async function jobLogs(checks) {
  const runIds = []
  for (const c of checks) {
    const m = String(c.detailsUrl || '').match(/\/actions\/runs\/(\d+)/)
    if (m && !runIds.includes(m[1])) runIds.push(m[1])
  }
  const blocks = []
  for (const id of runIds.slice(0, MAX_JOBS)) {
    const r = await gh(['run', 'view', id, '--log-failed'], { timeoutMs: 3 * 60 * 1000 })
    if (!r.ok || !r.out.trim()) continue
    const lines = r.out.split('\n').filter(l => l.trim())
    blocks.push(`--- failing job log (run ${id}, last ${Math.min(LOG_LINES, lines.length)} lines) ---\n${lines.slice(-LOG_LINES).join('\n')}`)
  }
  return blocks.length ? `What the failing job(s) printed:\n\n${blocks.join('\n\n')}` : ''
}

async function prepare(ctx, { labels }) {
  const { issue } = ctx

  const refuseFinal = async (body, reason) => {
    const settled = await ctx.finalizeIssue({ issue, body, add: ['failed'], remove: ['in-progress'] })
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
    return { refused: reason, refusalFinal: true }
  }
  if (labels.includes('ci-retried')) {
    return refuseFinal('🤖 fix-ci refused: attempt ladder exhausted\nTwo CI fixer attempts already ran (ci-attempted + ci-retried are both on the issue). A human decides now: fix the checks by hand, or strip the ci-attempted and ci-retried labels to grant the fixer another round.',
      'attempt ladder exhausted (ci-retried present)')
  }

  const prefix = `epic/${issue}-`
  const prs = (await openPrs('number,url,headRefName,headRefOid,statusCheckRollup')).filter(p => String(p.headRefName || '').startsWith(prefix))
  if (!prs.length) {
    return refuseFinal(`🤖 fix-ci refused: no open PR\nIssue #${issue} is labelled needs-ci-fix but no open PR delivers it (branch epic/${issue}-*). Resolve by hand; strip needs-ci-fix to take it out of the fixer queue.`,
      `no open PR on an epic/${issue}-* branch`)
  }
  if (prs.length > 1) {
    return refuseFinal(`🤖 fix-ci refused: multiple open PRs\nIssue #${issue} has ${prs.length} open PRs on epic/${issue}-* branches — ambiguous. Resolve by hand; strip needs-ci-fix to take it out of the fixer queue.`,
      `multiple open PRs on epic/${issue}-* branches — ambiguous`)
  }
  const pr = prs[0]

  // Attempt ladder + start signal, VERIFIED: an uncounted attempt must not run.
  const consumed = await ctx.consumeAttempt({
    labels,
    first: 'ci-attempted',
    retry: 'ci-retried',
    remove: ['failed'],
  })
  if (!consumed.recorded) {
    return { refused: 'could not record the attempt (label write failed)' }
  }
  const { attempt } = consumed
  const base = { attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number, prHead: pr.headRefOid, taskDelivery: labels.includes('task') }

  // The checks have to be red RIGHT NOW, not when the merge worker looked: a
  // re-run may have gone green since, and there is nothing to fix then.
  const failed = failedChecks(pr.statusCheckRollup)
  if (!failed.length) {
    return refuseFinal(`🤖 fix-ci refused: the checks are no longer red\nIssue #${issue} was queued for the CI fixer, but PR #${pr.number}'s checks on ${pr.headRefOid} are not failing now. Nothing to fix — swap this issue back to ready-to-merge if it should land, or leave it for a human.`,
      'the PR\'s checks are no longer failing')
  }

  // Work on the PR head exactly as the merge worker left it. Rebasing here
  // would duplicate the merge worker's job and drag conflict handling into a
  // run that has no business resolving one — that is the other fixer's queue.
  await git(['rebase', '--abort'])
  await gitOut(['fetch', 'origin', '--prune'], 'git fetch origin --prune')
  const originHead = (await git(['rev-parse', `refs/remotes/origin/${pr.headRefName}`])).out
  if (originHead !== pr.headRefOid) {
    return { ...base, gitBlocked: `branch ${pr.headRefName} moved under the fixer (PR head ${pr.headRefOid}, origin now ${originHead || 'missing'})` }
  }
  await gitOut(['checkout', '-f', '--detach', pr.headRefOid], 'git checkout --detach')
  // An epic branch holds exactly one commit, and the fix amends it. Anything
  // else means this is not the shape this run knows how to repair.
  const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (above !== 1) {
    return { ...base, gitBlocked: `the PR branch holds ${Number.isNaN(above) ? 'an unknown number of' : above} commit(s) above origin/main — an epic branch holds exactly one, so this is not a shape the CI fixer can amend` }
  }

  const packages = discoverPackages('.')
  if (!packages.length) return { ...base, gitBlocked: 'layout discovery found no package declaring an `npm run verify` script — refusing to ship a fix nothing would verify' }
  const depLines = await ensureDeps(packages, { pairs: [['origin/main', 'HEAD']] })
  // Whether the failure reproduces locally decides how the fixer works, and is
  // worth one verify run to know rather than guess.
  const localVerify = await runVerify(packages)
  const logs = await jobLogs(failed)
  // The rest of the brief, captured here rather than fetched by the fixer and
  // then separately by the checker that judges it: the change under repair and
  // the requirement it was built against. A diff that cannot be captured is
  // said so in the prompt, exactly as an unretrievable job log already is.
  const [changeDiff, changeStat, issueRecord] = await Promise.all([
    captureDiff(['origin/main...HEAD']),
    captureDiff(['origin/main...HEAD'], { stat: true }),
    captureIssueRecord(issue),
  ])
  return { ...base, packages, depLines, localVerify, logs, changeDiff, changeStat, issueRecord, failedChecks: failed.map(f => f.name) }
}

// Amend the branch's single commit, keeping its message (and so its Closes
// line), then push under a lease pinned to the head this run inspected.
async function ship(ctx, prep, body, { partial = false } = {}) {
  const { issue } = ctx
  await gitOut(['add', '-A'], 'git add -A')
  if ((await git(['diff', '--cached', '--quiet'])).code === 0) return { pushed: false, labelled: false, note: 'nothing staged to amend' }
  await gitOut(['commit', '-q', '--amend', '--no-edit'], 'git commit --amend')
  const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (above !== 1) return { pushed: false, labelled: false, note: `the amended branch holds ${above} commits above origin/main` }

  const push = await git(['push', `--force-with-lease=refs/heads/${prep.branch}:${prep.prHead}`, 'origin', `HEAD:refs/heads/${prep.branch}`])
  if (!push.ok) return { pushed: false, labelled: false, note: pushRejected(push) ? `rejected — ${prep.branch} moved on origin under this run` : failureReason(push) }
  if (partial) {
    const settled = await ctx.finalizeIssue({
      issue,
      body,
      ...terminalTransition({ rest: 'ready-to-review', drop: ['needs-ci-fix'] }),
    })
    const notes = [
      ...(!settled.settled ? [`terminal label transition failed: ${settled.stateError}`] : []),
      ...(!settled.reported ? [`audit comment failed: ${settled.reportError}`] : []),
    ]
    return { pushed: true, labelled: settled.settled, reported: settled.reported, note: notes.join('; ') }
  }
  await comment(issue, body)
  // ready-to-merge: back into the unattended queue, where the merge worker
  // rebases and RE-RUNS the real checks before anything lands. The ladder
  // labels stay — a second red check must not get a fresh pair of attempts.
  // From here the run is inside reap's settle window: the swap starts the clock
  // the moment GitHub processes it, so the write and the readback after it share
  // one budget (see terminalBudget) and the run still has a RESULT line to write.
  // A readback that cannot confirm the landing drops into the blocker path, which
  // transitions the labels again — inside THIS window, not a second one.
  const budget = ctx.openTerminalBudget()
  await ensureLabels(['ready-to-merge'], { budget })
  const flip = await editLabels(issue, { add: ['ready-to-merge'], remove: ['in-progress', 'needs-ci-fix'] }, { budget })
  // Bounded, not single-shot: GitHub can take seconds to show a swap it has
  // already applied, and one immediate read demotes a landed PR for nothing.
  let seen
  try {
    seen = await readBack(
      () => issueLabels(issue, { budget }),
      ls => ls.includes('ready-to-merge') && !ls.includes('in-progress') && !ls.includes('needs-ci-fix'),
      { budget })
  } catch (e) {
    return { pushed: true, labelled: false, note: e && e.message || String(e) }
  }
  const labels = seen.observed
  return { pushed: true, labelled: seen.matched, note: seen.matched ? '' : (flip.ok ? `observed labels: ${labels.join(', ')}` : failureReason(flip)) }
}

const attemptRung = attempt => attempt === 2 ? 'ci-retried' : 'ci-attempted'

function attemptGuidance(attempt, state) {
  const normal = attempt >= 2
    ? 'This was the RETRY (ci-attempted and ci-retried are both on the issue), so the CI fixer is done with it: fix the checks by hand, or strip the two ci-* labels to grant another round.'
    : attempt === 1
    ? 'This was the first attempt (ci-attempted is on the issue), so dispatch relaunches the CI fixer once, automatically, a few minutes after this session is reaped. Nothing to do unless the retry also fails.'
    : 'The attempt ladder was not reached, so dispatch will relaunch the CI fixer on its next tick.'
  if (!state || attempt < 1) return normal
  const rung = attemptRung(attempt)
  if (!state.readable) return `GitHub did not return a label readback; check that ${rung} is present before relaunching so this spent attempt is not refunded.`
  if (!state.labels.includes(rung)) return `${rung} could NOT be restored; set it by hand before relaunching so this spent attempt is not refunded.`
  return normal
}

const blockerBody = ({ phase, reason, prUrl, attempt }, state) =>
  `🤖 fix-ci blocked\n- phase: ${phase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- next: ${attemptGuidance(attempt, state)}\n`

// A semantic dead end in the bounded repair contract takes needs-ci-fix OFF, so
// this guidance is a claim about labels and is composed from the verified
// readback rather than hardcoded: telling an operator to strip a label that is
// already gone is exactly as wrong as claiming a failed transition worked. The
// ladder is deliberately untouched — the queue removal is what stops a
// relaunch, never a manufactured spent rung.
const humanHoldBody = ({ phase, reason, prUrl }, state) => {
  const repairs = [
    ...(state.missing.length ? [`set ${state.missing.join(', ')}`] : []),
    ...(state.stuck.length ? [`remove ${state.stuck.join(', ')}`] : []),
  ].join(' and ') || 'inspect the labels'
  const where = state.settled
    ? `needs-ci-fix has been removed and the issue rests at ${state.resting}, so dispatch cannot launch another CI fixer at blockers this attempt already corrected once.`
    : !state.readable
    ? `The resulting labels could NOT be read back (${state.stateError}): check by hand that needs-ci-fix is gone and ${state.resting} is set, or dispatch may relaunch the CI fixer.`
    : `${state.stuck.includes('needs-ci-fix')
        ? 'needs-ci-fix could NOT be removed, so the issue may still be in the fixer queue and dispatchable'
        : 'needs-ci-fix has been removed, but the transition did not complete'} (${state.stateError}): ${repairs} by hand.`
  return `🤖 fix-ci held for a human\n- phase: ${phase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- attempt ladder: untouched — this repair already had its one bounded correction, so no rung was spent to stop a relaunch.\n- next: ${where}\n`
}

async function cleanUnpushedEdits(options) {
  const opts = () => typeof options === 'function' ? options() : options
  await git(['reset', '--mixed', 'HEAD'], opts())
  await git(['checkout', '-f', '--', '.'], opts())
  await git(['clean', '-fd'], opts())
}

// ───────────────────────── The audit comment ─────────────────────────
// Composed here from structured pieces. The fix edited a reviewed change, so
// the record names every disposition, the files, and every gate that ran.
const buildComment = (prep, fix, dispositions, verifyDetail, check, corrected, touched) => {
  const declined = dispositions.filter(d => d.action === 'declined')
  return [
  declined.length ? '🤖 fix-ci landed a partial red-check repair' : '🤖 fix-ci repaired a red check',
  `- pr: ${prep.prUrl}`,
  `- attempt: ${prep.attempt}`,
  `- checks that were red: ${prep.failedChecks.join(', ')}`,
  `- source workflow: ${prep.taskDelivery ? 'lightweight task — implemented and verified, intentionally not independently reviewed' : 'epic — implemented, independently reviewed and verified'}`,
  '',
  'Check dispositions:',
  ...dispositions.map(d => `- ${d.name}: ${d.action} — ${d.reason}`),
  '',
  `Cause: ${fix.cause || 'not stated'}`,
  '',
  `Fix: ${fix.summary || 'not stated'}`,
  '',
  // Derived from the repair's own delta rather than copied from the fixer's
  // account of what it touched: this record is durable, so it states a fact.
  `Files: ${touched === null ? 'could not be derived' : touched.length ? touched.join(', ') : 'none'}`,
  '',
  `An exhaustive acceptance check examined every repaired claim, every declined check and the complete delta, and returned ${check.blockers.length} blocker(s) (confidence floor ${check.confidence}/100).`,
  ...(corrected ? [
    '',
    'One scoped correction ran inside this same attempt over the complete blocker batch — no second fixer was launched and no ladder rung was spent on it:',
    ...corrected.dispositions.map(d => `- ${d.id}: ${d.action} — ${d.reason}`),
    `A narrow independent confirmation then proved every blocker cleared with no regression, gate weakening or unrelated change (confidence ${corrected.confirmation.confidence}/100).`,
  ] : []),
  '',
  `verify: ${verifyDetail}`,
  '',
  declined.length
    ? 'The branch now carries the repairs and is force-pushed; the issue is held at ready-to-review with the CI-fixer queue removed. A human decides the declined checks.'
    : 'The branch is amended and force-pushed; the issue is back to ready-to-merge. The merge worker rebases it onto current main and re-runs the real checks before anything lands, so a fix that is still red cannot merge.',
].join('\n')
}

await runFixerLifecycle({
  scriptName: 'ci-run',
  usage: USAGE,
  phases: ['Prepare', 'Fix', 'Verify', 'Check', 'Ship'],
  queue: {
    label: 'needs-ci-fix',
    missing: issue => `issue #${issue} is not labelled needs-ci-fix — not a CI fixer's issue`,
  },
  prepare,
  prepared: (ctx, prep) => log(`Prepare: attempt ${ctx.attempt} on PR ${prep.prUrl} — red: ${prep.failedChecks.join(', ')}. Local verify ${prep.localVerify.green ? 'GREEN (the failure does not reproduce here)' : 'red (the failure reproduces here)'}. Packages: ${pkgList(prep.packages)}.`),
  repair: {
    needed: () => true,
    key: 'fix', phase: 'Fix',
    prompt: (ctx, prep) => fixPrompt(ctx.issue, prep),
    agent: { label: 'fix-ci', phase: 'Fix', step: 'fix-ci', schema: FIX_SCHEMA },
    noResult: 'the fixer produced no result — nothing was pushed and the PR branch is untouched.',
    normalize: (result, prep) => normalizedDispositions(result, prep.failedChecks),
    allDeclined: declined => `the fixer declined every failed check: ${declined.map(d => `${d.name}: ${d.reason}`).join('; ')}`,
    treeProblem: async () => (await gitOut(['status', '--porcelain'], 'git status'))
      ? null
      : 'the fixer reported a fix but changed no file — the checks would come back red exactly as they are.',
    log: (_ctx, _prep, fix) => log(`Fix: ${fix.cause || 'cause not stated'} — ${fix.summary || 'no summary'}`),
  },
  verify: {
    packages: prep => prep.packages,
    log: (_ctx, _prep, verified) => log(`Verify: ${verified.green ? 'green' : 'RED'} — ${verified.detail}`),
    failure: (_prep, verified) => `npm run verify is red after the fix (${verified.detail}) — nothing was pushed and the PR branch is untouched.`,
  },
  check: {
    needed: () => true,
    // The delta the checkers judge is captured HERE, not gathered by them: a
    // judging step has no shell under Claude and only a read-only sandbox under
    // Codex, and evidence a step fetched for itself is evidence nothing proved
    // it received. intent-to-add first, so a file the repair or the correction
    // created is inside the delta rather than invisible beside it.
    delta: async (_ctx, prep) => {
      await intentToAdd()
      return captureDiff([prep.prHead])
    },
    prompt: (ctx, prep, dispositions, { cumulative }) => acceptancePrompt(ctx.issue, prep, dispositions, cumulative),
    agent: { label: 'ci-acceptance', phase: 'Check', step: 'final-review', schema: ACCEPTANCE_SCHEMA },
    noResult: 'the acceptance check produced no result — an unchecked fix must not rejoin the merge queue.',
    log: (_ctx, _prep, check) => log(`Check: acceptance ${check.outcome} — ${check.blockers.length} blocker(s), confidence floor ${check.confidence}.`),
    correction: {
      prompt: (ctx, prep, dispositions, evidence) => correctionPrompt(ctx.issue, prep, dispositions, evidence),
      agent: { label: 'ci-correction', phase: 'Check', step: 'fix-ci', schema: CORRECTION_SCHEMA },
      noResult: 'the scoped correction produced no result — nothing was pushed and the PR branch is untouched.',
    },
    confirm: {
      prompt: (ctx, prep, _dispositions, evidence) => confirmPrompt(ctx.issue, prep, evidence),
      agent: { label: 'ci-confirm', phase: 'Check', step: 'final-review', schema: CONFIRMATION_SCHEMA },
      noResult: 'the narrow confirmation produced no result — an unconfirmed correction must not rejoin the merge queue.',
    },
  },
  ship: async (ctx, { prep, repairResult, dispositions, verified, check, corrected, partial }) => {
    // Before the amend, from the same head the checked delta used.
    const touched = await changedFiles([prep.prHead])
    return ship(ctx, prep, buildComment(prep, repairResult, dispositions, verified.detail, check, corrected, touched), { partial })
  },
  shipFailure: shipped => `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`,
  partialShipFailure: shipped => `the partial repair was pushed, but its human-held landing could not be fully verified${shipped.note ? ` (${shipped.note})` : ''}`,
  landingFailure: shipped => `pushed, but the ready-to-merge label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed.`,
  shipLog: (_ctx, prep, declined, partial) => log(partial
    ? `Ship: partial repair pushed and held for review — ${declined.map(d => `${d.name}: ${d.reason}`).join('; ')}`
    : `Ship: pushed and labelled ready-to-merge — ${prep.prUrl}`),
  result: (ctx, { prep, repairResult, declined, verified, check, corrected, partial }) => ({
    issue: ctx.issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt: ctx.attempt,
    failedChecks: prep.failedChecks,
    cause: repairResult.cause,
    declinedChecks: declined.map(d => ({ name: d.name, reason: d.reason })),
    checkConfidence: check.confidence,
    correctedBlockers: corrected ? corrected.dispositions.map(d => d.id) : [],
    verify: verified.detail,
    ...(partial ? { readyToReview: true } : { readyToMerge: true }),
  }),
  cleanup: (_ctx, options) => cleanUnpushedEdits(options),
  attemptRung,
  quota: (_ctx, rung) => ({
    hold: { add: ['failed', 'needs-ci-fix'], remove: ['in-progress', rung] },
    blocked: { add: ['failed', 'needs-ci-fix'], remove: ['in-progress'] },
  }),
  blocker: {
    transition: () => terminalTransition({ rest: 'failed', queue: ['needs-ci-fix'] }),
    body: (ctx, { phase, reason }, state) => blockerBody({ phase, reason, prUrl: ctx.prUrl, attempt: ctx.attempt }, state),
  },
  // Semantic, not operational: the repair was judged and could not be made
  // right inside its one correction, so the queue comes off rather than being
  // restored for another complete fixer.
  humanHold: {
    transition: () => terminalTransition({ rest: 'failed', drop: ['needs-ci-fix'] }),
    body: (ctx, { phase, reason }, state) => humanHoldBody({ phase, reason, prUrl: ctx.prUrl }, state),
  },
  partialFailure: async (ctx, reason, { labelled }) => {
    if (labelled) return log(`blocked after partial push: ${reason}`)
    const settled = await ctx.finalizeIssue({
      issue: ctx.issue,
      body: state => blockerBody({ phase: 'ship', reason, prUrl: ctx.prUrl, attempt: ctx.attempt }, state),
      ...terminalTransition({ rest: 'failed', drop: ['needs-ci-fix'] }),
      budget: ctx.terminalWindow || ctx.openTerminalBudget(),
    })
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label quarantine failed (${settled.stateError})`)
  },
  status: result => result?.held ? `**held**: provider quota exhausted, resumes after ${result.holdUntil} — vendor: ${result.vendor}; provider reason: "${result.reason}"` : result?.blocked ? `**blocked** at ${result.phase}: ${result.reason}` : result?.skipped ? `**skipped**: ${result.reason}` : result?.readyToMerge ? `**done** — ${result.prUrl} is back to ready-to-merge` : result?.readyToReview ? `**done, held for review** — ${result.prUrl}; declined: ${result.declinedChecks.map(d => `${d.name}: ${d.reason}`).join('; ')}` : '**finished**',
})
