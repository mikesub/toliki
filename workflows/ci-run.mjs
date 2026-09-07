#!/usr/bin/env node
// ci-run — red-check fixer for a finished epic PR (dispatch launches it for
// `needs-ci-fix` issues; `--issue N` is the only argument).
//
// The merge worker rebased the PR onto current main, re-ran its checks, and
// they came back RED. That is the one decline class where the code is
// genuinely wrong and there is something to act on. This run reads the failing
// checks' logs, fixes the cause, re-verifies, has a blind adversarial agent
// try to refute the fix, amends the branch's single commit, and force-pushes.
// A complete repair lands ready-to-merge; a verified partial repair keeps its
// safe work but rests at ready-to-review with the CI-fixer queue removed. The
// merge worker rebases it again and RE-RUNS THE REAL CHECKS before anything
// lands. That last re-run is what makes this landing safe: a fix that is still
// red cannot merge. What it cannot catch is a fix that is green and wrong,
// which is what the adversarial check below is for.
//
// Attempt ladder in labels: ci-attempted, then ci-retried (one retry);
// exhausted → refuses and stays failed. Its own ladder, not the conflict
// fixer's: a PR can need both, and one budget would starve the other.
//
// Two model steps: the fixer and its skeptic. The shared fixed-purpose fixer
// lifecycle owns their sequencing, common gates, failure/refund handling and
// final RESULT; this adapter owns red-check capture, prompts and publication.
// A hard provider-quota death cleans the unpushed edit and records the
// host-wide hold before labels move. A verified hold refunds this invocation's
// rung; an unverified transition restores it and blocks inside the same
// terminal-report window.

import { log } from './lib/runtime.mjs'
import { failureReason } from './lib/proc.mjs'
import { gh, ensureLabels, editLabels, issueLabels, comment, openPrs, readBack, terminalTransition } from './lib/github.mjs'
import { git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, pushRejected, intentToAdd } from './lib/repo.mjs'
import { runFixerLifecycle, validateIndexedDispositions } from './lib/fixer-lifecycle.mjs'

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
Numbered for the disposition record:
${prep.failedChecks.map((name, index) => `${index + 1}. ${name}`).join('\n')}.

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
5. **Decline instead of guessing.** Judge each numbered failed check independently. If a check is not something a code change here can fix — an infrastructure or runner problem, a missing secret or credential, a flaky external dependency, or another cause outside this tree — do not change it and mark that check declined with the reason. Continue repairing the other checks. Never claim that a declined check was repaired.

Return dispositions with exactly one entry for every numbered failed check: index, action ("repaired" or "declined"), and a non-empty reason. Also return cause, summary, and files (each file touched). No missing, duplicate, or extra indexes.`,

  // Blind to the fixer's narrative beyond the indexed claims: agreement still
  // has to come from the code. A complete repair lands ready-to-merge; a
  // partial one is held for a human, but both face the same exact-delta gate.
  check: (issue, prep, fixDiffCmd, dispositions) =>
`Adversarially check a fix you did not write. The PR on branch ${prep.branch} (issue #${issue}) failed these checks after being rebased onto current origin/main: ${prep.failedChecks.join(', ')}. Something then edited the tree to fix them, and that edit is exactly \`${fixDiffCmd}\` (also readable with --stat). Your job is to REFUTE two claims about it.

${prep.logs || 'No job logs were retrievable for this failure.'}

The fixer's indexed claims (claims to test, never authority):
${dispositions.map(d => `${d.index}. ${d.name}: ${d.action} — ${d.reason}`).join('\n')}

Refute if a repaired check's cause remains, if the delta changes anything attributed to a declined check, or if the fix weakens a gate or causes an unrelated regression.

Claim 1 — "it fixes the cause". Does the edit address what actually made those checks red, or does it hide it? Hunt specifically for: a test weakened, skipped, deleted, or its assertion loosened; an expectation rewritten to match wrong behavior; a type widened or an error swallowed; a lint rule disabled or a suppression added; a check excluded from a config. Any of those is a refutation, not a fix, however green it makes the run.
2 — "it changes nothing else". The PR was already reviewed and verified before this edit; anything the edit does beyond the failure is unreviewed. Hunt for: behavior changed outside the failing path, a dropped side effect, a broken neighbour, scope creep dressed as a fix.

Gather the evidence yourself: the change under repair is \`git diff origin/main...HEAD\` and the requirement is issue #${issue} (\`gh issue view ${issue} --json title,body\`). Do NOT open anything under \`.epics/\` — it carries a builder's framing and would anchor you.

Default to refuted: if you cannot positively confirm, from the code in front of you, that the edit satisfies every indexed claim and touches nothing else, say survives=false. A complete repair goes back into the unattended merge queue; a verified partial is held for a human.

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
  required: [],
  properties: {
    completed: { type: 'boolean', description: 'true only when the failing checks should now pass' },
    escalate: { type: 'string', description: 'set INSTEAD of completing when no code change here can fix the failure — what is failing and why' },
    cause: { type: 'string', description: 'one sentence: what actually made the checks red' },
    summary: { type: 'string', description: 'what changed and why it fixes that cause' },
    files: { type: 'array', items: { type: 'string' }, description: 'each file touched' },
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
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['survives', 'confidence', 'reasoning'],
  properties: {
    survives: { type: 'boolean', description: 'true only if the edit fixes the cause AND changes nothing else' },
    confidence: { type: 'number', description: '0-100' },
    reasoning: { type: 'string', description: 'names the evidence, whichever way it rules' },
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

async function cleanUnpushedEdits(options) {
  const opts = () => typeof options === 'function' ? options() : options
  await git(['reset', '--mixed', 'HEAD'], opts())
  await git(['checkout', '-f', '--', '.'], opts())
  await git(['clean', '-fd'], opts())
}

// ───────────────────────── The audit comment ─────────────────────────
// Composed here from structured pieces. The fix edited a reviewed change, so
// the record names every disposition, the files, and every gate that ran.
const buildComment = (prep, fix, dispositions, verifyDetail, check) => {
  const declined = dispositions.filter(d => d.action === 'declined')
  return [
  declined.length ? '🤖 fix-ci landed a partial red-check repair' : '🤖 fix-ci repaired a red check',
  `- pr: ${prep.prUrl}`,
  `- attempt: ${prep.attempt}`,
  `- checks that were red: ${prep.failedChecks.join(', ')}`,
  '',
  'Check dispositions:',
  ...dispositions.map(d => `- ${d.name}: ${d.action} — ${d.reason}`),
  '',
  `Cause: ${fix.cause || 'not stated'}`,
  '',
  `Fix: ${fix.summary || 'not stated'}`,
  ...(Array.isArray(fix.files) && fix.files.length ? ['', `Files: ${fix.files.join(', ')}`] : []),
  '',
  `An adversarial check tested every repaired claim, every declined check, and the complete delta (confidence ${check.confidence}/100).`,
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
    prompt: (ctx, prep) => PROMPTS.fix(ctx.issue, prep),
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
    before: () => intentToAdd(),
    prompt: (ctx, prep, dispositions) => PROMPTS.check(ctx.issue, prep, `git diff ${prep.prHead}`, dispositions),
    agent: { label: 'ci-check', phase: 'Check', step: 'confirm-review', schema: CHECK_SCHEMA },
    noResult: 'the adversarial checker produced no result — an unchecked fix must not rejoin the merge queue.',
    refuted: check => `the adversarial check refuted the fix (survives=${check.survives}, confidence ${check.confidence}): ${check.reasoning}`,
    log: (_ctx, _prep, check) => log(`Check: survived — ${check.reasoning} (confidence ${check.confidence}).`),
  },
  ship: (ctx, { prep, repairResult, dispositions, verified, check, partial }) =>
    ship(ctx, prep, buildComment(prep, repairResult, dispositions, verified.detail, check), { partial }),
  shipFailure: shipped => `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`,
  partialShipFailure: shipped => `the partial repair was pushed, but its human-held landing could not be fully verified${shipped.note ? ` (${shipped.note})` : ''}`,
  landingFailure: shipped => `pushed, but the ready-to-merge label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed.`,
  shipLog: (_ctx, prep, declined, partial) => log(partial
    ? `Ship: partial repair pushed and held for review — ${declined.map(d => `${d.name}: ${d.reason}`).join('; ')}`
    : `Ship: pushed and labelled ready-to-merge — ${prep.prUrl}`),
  result: (ctx, { prep, repairResult, declined, verified, check, partial }) => ({
    issue: ctx.issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt: ctx.attempt,
    failedChecks: prep.failedChecks,
    cause: repairResult.cause,
    declinedChecks: declined.map(d => ({ name: d.name, reason: d.reason })),
    checkConfidence: check.confidence,
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
