#!/usr/bin/env node
// ci-run — red-check fixer for a finished epic PR (dispatch launches it for
// `needs-ci-fix` issues; `--issue N` is the only argument).
//
// The merge worker rebased the PR onto current main, re-ran its checks, and
// they came back RED. That is the one decline class where the code is
// genuinely wrong and there is something to act on. This run reads the failing
// checks' logs, fixes the cause, re-verifies, has a blind adversarial agent
// try to refute the fix, amends the branch's single commit, force-pushes, and
// lands the issue ready-to-merge — back in the unattended queue, where the
// merge worker rebases it again and RE-RUNS THE REAL CHECKS before anything
// lands. That last re-run is what makes this landing safe: a fix that is still
// red cannot merge. What it cannot catch is a fix that is green and wrong,
// which is what the adversarial check below is for.
//
// Attempt ladder in labels: ci-attempted, then ci-retried (one retry);
// exhausted → refuses and stays failed. Its own ladder, not the conflict
// fixer's: a PR can need both, and one budget would starve the other.
//
// Two model steps: the fixer and its skeptic. Everything else — the gates, the
// ladder write, the log gathering, verify, the amend, the push, the audit
// comment, the labels — is the orchestrator's own work.
// A hard provider-quota death cleans the unpushed edit and records the
// host-wide hold before labels move. A verified hold refunds this invocation's
// rung; an unverified transition restores it and blocks inside the same
// terminal-report window.

import { agent, phase, log, initRuntime, onPhase, onLog, takeAgentFailure, withAgentFailure } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { failureReason } from './lib/proc.mjs'
import { gh, ensureLabels, editLabels, issueLabels, issueView, comment, openPrs, withBodyFile, terminalBudget, terminalTimeout, terminalTransition } from './lib/github.mjs'
import { git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, pushRejected } from './lib/repo.mjs'
import { finalizeFixerIssue, finalizeFixerQuotaHold } from './lib/fixer-finalize.mjs'
import { recordQuotaHold } from './quota-hold.mjs'

const USAGE = `Usage: ci-run.mjs --issue <N> [--session <name>] [--engine <name>]

  --issue <N>  the needs-ci-fix issue whose PR came back red on its checks
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase

Exit: 0 fixed or provider-held, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

// How much of a failing job's log the fixer gets. Enough to hold a stack trace
// and the assertion around it; short enough that three failing jobs do not
// bury the prompt.
const LOG_LINES = 200
const MAX_JOBS = 3

// ───────────────────────── Prompts ─────────────────────────
const PROMPTS = {
  // The judgment core. It gets what a human would open: which checks failed,
  // what their logs said, whether the failure reproduces locally, and the
  // change under repair.
  fix: (issue, prep) =>
`Fix the failing checks on a finished PR. The change on branch ${prep.branch} (issue #${issue}) was built, reviewed and verified, then the merge worker rebased it onto current origin/main and re-ran its checks — and they came back RED. HEAD is that rebased commit. Your job is exactly the failure below: make those checks pass without changing what the PR set out to do.

Checks that failed: ${prep.failedChecks.join(', ')}.

${prep.localVerify.green
  ? `\`npm run verify\` is GREEN locally on this exact tree (${prep.localVerify.detail}). The failure is therefore something the local gate does not run — a job configured only in CI, a platform or version difference, a missing fixture, a check against the merged result — so read the logs below rather than expecting to reproduce it, and be explicit in your summary about why it fails there and not here.`
  : `\`npm run verify\` is RED locally on this exact tree too (${prep.localVerify.detail}), so the failure reproduces here and you can iterate against it.`}

${prep.logs || 'No job logs could be retrieved; the check names above and the local verify result are your whole evidence.'}

The change under repair: \`git diff origin/main...HEAD\` (also --stat), and issue #${issue} (\`gh issue view ${issue} --json title,body\`) is the requirement it was built against.

Rules:
1. Fix the CAUSE. Never weaken, skip, delete or loosen a test, an assertion, a type or a lint rule to make a check pass — that is the failure mode this whole step is watched for, and an adversarial reviewer reads your diff for exactly it afterwards. If a test is genuinely wrong, fix the smallest thing and say so explicitly in your summary.
2. Stay inside the PR's intent. You are repairing a finished change, not extending it: no refactors, no drive-by improvements, no new features. The smallest diff that makes the checks pass is the right one.
3. Do NOT commit, amend, push, or touch any label or comment — the pipeline does all of that after it has verified and checked your work. Leave your fix in the working tree.
4. Do NOT open anything under \`.epics/\`: it carries the builder's framing and would anchor you.
5. **Escalate instead of guessing.** If the failure is not something a code change here can fix — an infrastructure or runner problem, a missing secret or credential, a flaky external dependency, a workflow misconfiguration, a check that is red for a reason outside this diff — change NOTHING and return escalate="<what is failing and why no code change here fixes it>". A \`failed\` label is recoverable; a plausible-looking fix that papers over a real defect is not.

Return: completed (true only when you believe the failing checks would now pass), escalate (INSTEAD of completing, when set), cause (one sentence: what actually made the checks red), summary (what you changed and why it fixes that cause), files (each file you touched).`,

  // Blind on purpose: the fixer's own reasoning is deliberately NOT in this
  // prompt, so agreement can only come from the code. This is the last gate a
  // human is not part of — the issue lands ready-to-merge — so it is aimed at
  // the two ways a green check can lie.
  check: (issue, prep, fixDiffCmd) =>
`Adversarially check a fix you did not write. The PR on branch ${prep.branch} (issue #${issue}) failed these checks after being rebased onto current origin/main: ${prep.failedChecks.join(', ')}. Something then edited the tree to fix them, and that edit is exactly \`${fixDiffCmd}\` (also readable with --stat). Your job is to REFUTE two claims about it.

${prep.logs || 'No job logs were retrievable for this failure.'}

Claim 1 — "it fixes the cause". Does the edit address what actually made those checks red, or does it hide it? Hunt specifically for: a test weakened, skipped, deleted, or its assertion loosened; an expectation rewritten to match wrong behavior; a type widened or an error swallowed; a lint rule disabled or a suppression added; a check excluded from a config. Any of those is a refutation, not a fix, however green it makes the run.
2 — "it changes nothing else". The PR was already reviewed and verified before this edit; anything the edit does beyond the failure is unreviewed. Hunt for: behavior changed outside the failing path, a dropped side effect, a broken neighbour, scope creep dressed as a fix.

Gather the evidence yourself: the change under repair is \`git diff origin/main...HEAD\` and the requirement is issue #${issue} (\`gh issue view ${issue} --json title,body\`). Do NOT open anything under \`.epics/\` — it carries a builder's framing and would anchor you.

Default to refuted: if you cannot positively confirm, from the code in front of you, that the edit fixes the cause and touches nothing else, say survives=false. This issue goes back into the unattended merge queue on your word, so an over-cautious refute costs one human glance while a wrong pass ships a hidden defect to main.

Return: survives, confidence (0-100), reasoning (name the evidence, whichever way you rule).`,
}

// ───────────────────────── Config ─────────────────────────
// Which vendor, model and effort each step runs on is a row of the run's
// engine in etc/engines.json; every agent() call names only its step.
// fix-ci is the repair itself, and confirm-review is the last gate before an
// unattended merge, so a row for either wants the strong model.

// ───────────────────────── Schemas ─────────────────────────
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['completed'],
  properties: {
    completed: { type: 'boolean', description: 'true only when the failing checks should now pass' },
    escalate: { type: 'string', description: 'set INSTEAD of completing when no code change here can fix the failure — what is failing and why' },
    cause: { type: 'string', description: 'one sentence: what actually made the checks red' },
    summary: { type: 'string', description: 'what changed and why it fixes that cause' },
    files: { type: 'array', items: { type: 'string' }, description: 'each file touched' },
  },
}
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['survives', 'confidence', 'reasoning'],
  properties: {
    survives: { type: 'boolean', description: 'true only if the edit fixes the cause AND changes nothing else' },
    confidence: { type: 'number', description: '0-100' },
    reasoning: { type: 'string', description: 'names the evidence, whichever way it rules' },
  },
}

// ───────────────────────── Args ─────────────────────────
let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { allowSlug: false, usage: USAGE })
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write((e.message ? `ci-run: ${e.message}\n\n` : '') + e.usage + '\n')
    process.exit(e.message ? EXIT.ERROR : EXIT.OK)
  }
  throw e
}
initRuntime({ scriptName: 'ci-run', sessionName: ARGS.session, defaultEngine: ARGS.engine, issue: ARGS.issue })
initStatus({ issue: ARGS.issue, script: 'ci-run', session: ARGS.session, phases: ['Prepare', 'Fix', 'Verify', 'Check', 'Ship'] })
onPhase(statusPhase)
onLog(statusNote)
const issue = ARGS.issue

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

async function prepare(issue) {
  const view = await issueView(issue, 'state,labels,title')
  const labels = Array.isArray(view.labels) ? view.labels.map(l => l.name) : []
  if (String(view.state || '').toUpperCase() === 'CLOSED') return { refused: `issue #${issue} is closed` }
  if (!labels.includes('needs-ci-fix')) return { refused: `issue #${issue} is not labelled needs-ci-fix — not a CI fixer's issue` }

  const refuseFinal = async (body, reason) => {
    const settled = await finalizeFixerIssue({ issue, body, add: ['failed'], remove: ['in-progress'] })
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
  const attempt = labels.includes('ci-attempted') ? 2 : 1
  const ladderLabel = attempt === 2 ? 'ci-retried' : 'ci-attempted'
  await ensureLabels(['ci-attempted', 'ci-retried', 'in-progress'])
  await editLabels(issue, { add: ['in-progress', ladderLabel], remove: ['failed'] })
  const now = await issueLabels(issue)
  if (!now.includes('in-progress') || !now.includes(ladderLabel) || now.includes('failed')) {
    return { refused: 'could not record the attempt (label write failed)' }
  }
  const base = { attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number, prHead: pr.headRefOid }

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
  return { ...base, packages, depLines, localVerify, logs, failedChecks: failed.map(f => f.name) }
}

// Amend the branch's single commit, keeping its message (and so its Closes
// line), then push under a lease pinned to the head this run inspected.
async function ship(issue, prep, body) {
  await gitOut(['add', '-A'], 'git add -A')
  if ((await git(['diff', '--cached', '--quiet'])).code === 0) return { pushed: false, labelled: false, note: 'nothing staged to amend' }
  await gitOut(['commit', '-q', '--amend', '--no-edit'], 'git commit --amend')
  const above = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (above !== 1) return { pushed: false, labelled: false, note: `the amended branch holds ${above} commits above origin/main` }

  const push = await git(['push', `--force-with-lease=refs/heads/${prep.branch}:${prep.prHead}`, 'origin', `HEAD:refs/heads/${prep.branch}`])
  if (!push.ok) return { pushed: false, labelled: false, note: pushRejected(push) ? `rejected — ${prep.branch} moved on origin under this run` : failureReason(push) }
  await comment(issue, body)
  // ready-to-merge: back into the unattended queue, where the merge worker
  // rebases and RE-RUNS the real checks before anything lands. The ladder
  // labels stay — a second red check must not get a fresh pair of attempts.
  // From here the run is inside reap's settle window: the swap starts the clock
  // the moment GitHub processes it, so the write and the readback after it share
  // one budget (see terminalBudget) and the run still has a RESULT line to write.
  // A readback that cannot confirm the landing drops into the blocker path, which
  // transitions the labels again — inside THIS window, not a second one.
  const budget = terminalBudget()
  await ensureLabels(['ready-to-merge'], { budget })
  const flip = await editLabels(issue, { add: ['ready-to-merge'], remove: ['in-progress', 'needs-ci-fix'] }, { budget })
  let labels
  try {
    labels = await issueLabels(issue, { budget })
  } catch (e) {
    return { pushed: true, labelled: false, note: e && e.message || String(e) }
  }
  const labelled = labels.includes('ready-to-merge') && !labels.includes('in-progress') && !labels.includes('needs-ci-fix')
  return { pushed: true, labelled, note: labelled ? '' : (flip.ok ? `observed labels: ${labels.join(', ')}` : failureReason(flip)) }
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

async function postBlocker({ issue, phase, reason, prUrl, attempt }, budget) {
  // needs-ci-fix keeps the issue in the queue and the ladder labels bound the retries; both stay —
  // and `needs-ci-fix` is RESTORED rather than assumed, because a landing swap that GitHub applied
  // but this run could not verify has already stripped it and put `ready-to-merge` on. Resting at
  // `failed` beside that landing label would hand a blocked run's PR to the merge worker, so the
  // transition names the one label the run rests at and derives every removal from it.
  const settled = await finalizeFixerIssue({
    issue,
    body: state => blockerBody({ phase, reason, prUrl, attempt }, state),
    ...terminalTransition({ rest: 'failed', queue: ['needs-ci-fix'] }),
    budget,
  })
  terminalWindow = settled.budget
  if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
  if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
}

// ───────────────────────── Blocker path ─────────────────────────
let currentPhase = 'prepare'
let blockerPosted = false
let prUrl = null
let attempt = 0
let terminalWindow = null
async function holdForQuota(phase, failure, reason) {
  try {
    await git(['checkout', '-f', '--', '.'])
    const { hostHold, trigger } = await recordQuotaHold({ vendor: failure.vendor, reason: failure.reason })
    const rung = attemptRung(attempt)
    const finalized = await finalizeFixerQuotaHold({
      issue,
      rung,
      hold: { add: ['failed', 'needs-ci-fix'], remove: ['in-progress', rung] },
      blocked: { add: ['failed', 'needs-ci-fix'], remove: ['in-progress'] },
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
      // Never leave a half-applied fix in a worktree the next run reuses. Bounded by whatever the
      // terminal window has left when ship's landing swap is what failed: past that write reap's
      // settle clock is running, and a stalled local git call costs the blocker report just as an
      // unbounded gh call would. Before any terminal write there is no clock and git's own timeout stands.
      await git(['checkout', '-f', '--', '.'], terminalTimeout())
      await postBlocker({ issue, phase, reason, prUrl, attempt })
    } catch (e) {
      log(`blocked: could not report on GitHub (${e && e.message || e})`)
    }
  }
  return { blocked: true, issue, phase, reason, prUrl: prUrl || undefined, attempt }
}

// ───────────────────────── The audit comment ─────────────────────────
// Composed here from structured pieces. The fix edited a reviewed change and
// the issue goes straight back to the merge queue, so the record names the
// cause, the files, and every gate that ran.
const buildComment = (prep, fix, verifyDetail, check) => [
  '🤖 fix-ci repaired a red check',
  `- pr: ${prep.prUrl}`,
  `- attempt: ${prep.attempt}`,
  `- checks that were red: ${prep.failedChecks.join(', ')}`,
  '',
  `Cause: ${fix.cause || 'not stated'}`,
  '',
  `Fix: ${fix.summary || 'not stated'}`,
  ...(Array.isArray(fix.files) && fix.files.length ? ['', `Files: ${fix.files.join(', ')}`] : []),
  '',
  `An adversarial check, blind to this session's reasoning, tried to refute "it fixes the cause and changes nothing else" and failed to (confidence ${check.confidence}/100).`,
  '',
  `verify: ${verifyDetail}`,
  '',
  'The branch is amended and force-pushed; the issue is back to ready-to-merge. The merge worker rebases it onto current main and re-runs the real checks before anything lands, so a fix that is still red cannot merge.',
].join('\n')

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
  log(`Prepare: attempt ${attempt} on PR ${prep.prUrl} — red: ${prep.failedChecks.join(', ')}. Local verify ${prep.localVerify.green ? 'GREEN (the failure does not reproduce here)' : 'red (the failure reproduces here)'}. Packages: ${pkgList(prep.packages)}.`)

  // ───────────────────────── Fix ─────────────────────────
  currentPhase = 'fix'
  phase('Fix')
  const fix = await agent(PROMPTS.fix(issue, prep),
    { label: 'fix-ci', phase: 'Fix', step: 'fix-ci', schema: FIX_SCHEMA })
  if (!fix) return await fail('fix', 'the fixer produced no result — nothing was pushed and the PR branch is untouched.')
  if (fix.escalate) return await fail('fix', `escalated rather than guessed: ${fix.escalate}`)
  if (!fix.completed) return await fail('fix', 'the fixer did not complete.')
  // A fix that changed nothing cannot have fixed anything.
  if (!(await gitOut(['status', '--porcelain'], 'git status'))) {
    return await fail('fix', 'the fixer reported a fix but changed no file — the checks would come back red exactly as they are.')
  }
  log(`Fix: ${fix.cause || 'cause not stated'} — ${fix.summary || 'no summary'}`)

  // ───────────────────────── Verify ─────────────────────────
  // Necessary, not sufficient: the failing check may be one `npm run verify`
  // never runs (a CI-only job, another platform). The merge worker re-running
  // the real checks on the true base is what finally proves it; this gate is
  // what stops an obviously broken tree from getting that far.
  currentPhase = 'verify'
  phase('Verify')
  const v = await runVerify(prep.packages)
  log(`Verify: ${v.green ? 'green' : 'RED'} — ${v.detail}`)
  if (!v.green) return await fail('verify', `npm run verify is red after the fix (${v.detail}) — nothing was pushed and the PR branch is untouched.`)

  // ───────────────────────── Adversarial check ─────────────────────────
  // The last gate before this rejoins the unattended merge queue.
  currentPhase = 'check'
  phase('Check')
  const check = await agent(PROMPTS.check(issue, prep, `git diff ${prep.prHead}`),
    { label: 'ci-check', phase: 'Check', step: 'confirm-review', schema: CHECK_SCHEMA })
  if (!check) return await fail('check', 'the adversarial checker produced no result — an unchecked fix must not rejoin the merge queue.')
  if (!check.survives || check.confidence < 75) {
    return await fail('check', `the adversarial check refuted the fix (survives=${check.survives}, confidence ${check.confidence}): ${check.reasoning}`)
  }
  log(`Check: survived — ${check.reasoning} (confidence ${check.confidence}).`)

  // ───────────────────────── Ship ─────────────────────────
  currentPhase = 'ship'
  phase('Ship')
  const shipped = await ship(issue, prep, buildComment(prep, fix, v.detail, check))
  if (!shipped.pushed) {
    return await fail('ship', `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`)
  }
  if (!shipped.labelled) {
    return await fail('ship', `pushed, but the ready-to-merge label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed.`)
  }
  log(`Ship: pushed and labelled ready-to-merge — ${prep.prUrl}`)

  return {
    issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt,
    failedChecks: prep.failedChecks,
    cause: fix.cause,
    checkConfidence: check.confidence,
    verify: v.detail,
    readyToMerge: true,
  }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

const RESULT = await main()
await statusFinish(RESULT?.held ? `**held**: provider quota exhausted, resumes after ${RESULT.holdUntil} — vendor: ${RESULT.vendor}; provider reason: "${RESULT.reason}"` : RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToMerge ? `**done** — ${RESULT.prUrl} is back to ready-to-merge` : '**finished**', { budget: terminalWindow || undefined })
process.exit(finish(RESULT))
