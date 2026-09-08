#!/usr/bin/env node
// task-run — explicitly opted-in lightweight issue delivery. One writable
// tasker process implements and self-reviews the settled requirement; the
// orchestrator alone claims, verifies, rebases, commits, pushes, opens the PR,
// publishes evidence and hands the candidate to the ordinary merge worker.
// There is no architect, RED step, independent review or correction.
// Runtime respawns are disabled for every call. The one bounded exception is
// a fresh tasker given captured diagnostics after the first project verify is
// genuinely red; its full second verify is final and can never spawn a third.

import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { agent, phase, log, initRuntime, onPhase, onLog, takeAgentFailure, withAgentFailure } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { failureReason } from './lib/proc.mjs'
import { comment, issueLabels, issueView, readBack, terminalSpend } from './lib/github.mjs'
import {
  ISSUE_LIFECYCLE, prepareIssueDelivery, renderIssuePrBody, createIssueCandidate,
  handoffIssue, preserveIssueWork, holdIssueForQuota, restIssueFailed,
  restIssueReadyToReview,
} from './lib/issue-delivery.mjs'
import {
  git, gitOut, pkgList, ensureDeps, runVerify, checkpoint, rebaseInProgress,
  epicDir, updateEpicMd,
} from './lib/repo.mjs'

const USAGE = `Usage: task-run.mjs --issue <N> [--session <name>] [--engine <name>] [--repo <key>]

  --issue    GitHub issue carrying the persistent task selector label
  --session  tmux session name created by bin/launch.sh
  --engine   registered coding-agent engine
  --repo     registered repository key, for usage telemetry identity only

Exit: 0 queued or provider-held, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { usage: USAGE })
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write((error.message ? `task-run: ${error.message}\n\n` : '') + error.usage + '\n')
    process.exit(error.message ? EXIT.ERROR : EXIT.OK)
  }
  throw error
}

initRuntime({ scriptName: 'task-run', sessionName: ARGS.session, defaultEngine: ARGS.engine, issue: ARGS.issue, repo: ARGS.repo })
initStatus({ issue: ARGS.issue, script: 'task-run', session: ARGS.session, phases: ['Prepare', 'Task', 'Verify', 'Rebase', 'Deliver'] })
onPhase(statusPhase)
onLog(statusNote)

const issue = ARGS.issue
let slug = null
let currentPhase = 'prepare'
let blockerPosted = false
let openCandidate = null
let finalVerify = null

// The tasker charter holds the role's rules; this schema is the only place the
// shape of its answer is described, so the charter and the prompts do not
// restate a field list that would then drift from the gate in resultProblem().
const TASK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'title', 'summary', 'commitBody', 'tests', 'selfReview', 'unresolved'],
  properties: {
    status: { enum: ['completed', 'blocked'], description: 'completed only when the implementation and the builder self-review are both finished and nothing is unresolved' },
    title: { type: 'string', description: 'for completed work: the imperative one-line PR and commit title, at most 72 characters' },
    summary: { type: 'string', description: 'concise delivery summary of what changed and the approach used' },
    commitBody: { type: 'string', description: 'for completed work: a non-empty rationale for the durable commit — why the change was made and any significant implementation choice or trade-off, never a verification transcript' },
    tests: { type: 'string', description: 'tests added or updated, or why no test change was meaningful' },
    selfReview: { type: 'string', description: 'what the builder self-review inspected and any defect it corrected' },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'empty for completed work; for blocked work, the concrete unresolved conditions' },
  },
}

const prompt = prep => `Implement issue #${issue} as the explicitly opted-in lightweight task workflow.

Title: ${prep.requirementTitle}

Requirement:
"""
${prep.requirementBody}
"""

This is the initial writable task process, not the verification-driven repair. Implement the complete requirement and self-review it under your charter, then return the structured task result.`

const verifyRepairPrompt = (prep, verified) => `Repair issue #${issue} in the existing lightweight-task worktree after the orchestrator's project verification failed.

Title: ${prep.requirementTitle}

Original requirement:
"""
${prep.requirementBody}
"""

The initial tasker's implementation and every current worktree change are already available to inspect in place. Diagnose them from the real codebase; no generated diff is injected into this prompt.

Captured failure diagnostics from the exact orchestrator-run verification command:
"""
${verified.tail || verified.detail}
"""

This is the one verification-driven repair process. Fix the reported failure without weakening, skipping, deleting or loosening a test, assertion, type, lint rule, check or safety guard, and without expanding beyond the original requirement. Leave the updated working tree for one final orchestrator verification and return the normal structured task result.`

const nonblank = value => typeof value === 'string' && value.trim().length > 0

function resultProblem(result) {
  if (!result || !['completed', 'blocked'].includes(result.status)) return 'the tasker returned no valid status'
  if (!nonblank(result.summary) || !nonblank(result.tests) || !nonblank(result.selfReview)) return 'the tasker returned incomplete delivery or self-review evidence'
  if (result.status === 'blocked') {
    return Array.isArray(result.unresolved) && result.unresolved.some(nonblank)
      ? null
      : 'the tasker reported blocked without a concrete unresolved condition'
  }
  if (!nonblank(result.title) || result.title.includes('\n') || result.title.trim().length > 72) return 'the tasker returned an invalid title (must be one line and at most 72 characters)'
  if (!nonblank(result.commitBody)) return 'the tasker returned no durable commit rationale'
  if (!Array.isArray(result.unresolved) || result.unresolved.length) return 'the tasker reported completed with unresolved work'
  return null
}

const repairableVerifyFailure = verified => !verified.green &&
  Array.isArray(verified.failures) && verified.failures.length > 0 &&
  verified.failures.every(failure => !failure.timedOut && !failure.spawnError)

const verifyDiagnostic = verified => verified.tail || verified.detail || 'no verification diagnostics captured'

const deliveryMarker = candidate => `<!-- toliki-task-delivery candidate:${candidate.prHead} -->`

function deliverySummary(candidate, result) {
  return [
    '🤖 task delivery summary',
    deliveryMarker(candidate),
    '',
    `Technical PR: [#${candidate.prNumber}](${candidate.prUrl})`,
    `Branch: \`${candidate.branch}\``,
    `Candidate: \`${candidate.prHead}\``,
    '',
    String(result.summary).trim(),
    '',
    `Tests: ${String(result.tests).trim()}`,
    `Builder self-review: ${String(result.selfReview).trim()}`,
    `Orchestrator verification: ${finalVerify?.evidence || finalVerify?.detail || 'not captured'}`,
    '',
    'This task was implemented and verified, but intentionally skipped architecture and independent semantic review because a human applied the `task` selector.',
  ].join('\n') + '\n'
}

async function publishDeliverySummary(candidate, result) {
  const marker = deliveryMarker(candidate)
  const readMatches = async () => {
    const view = await issueView(issue, 'comments')
    return (Array.isArray(view.comments) ? view.comments : [])
      .map(entry => String(entry?.body || ''))
      .filter(body => body.startsWith('🤖 task delivery summary\n') && body.split('\n').includes(marker))
  }
  const before = await readMatches()
  if (before.length > 1) throw new Error(`found ${before.length} task delivery summaries for candidate ${candidate.prHead}`)
  if (before.length === 1) return
  let writeError = null
  try { await comment(issue, deliverySummary(candidate, result)) } catch (error) { writeError = error }
  const seen = await readBack(readMatches, matches => matches.length > 0)
  if (seen.observed.length !== 1) {
    const detail = writeError ? `write failed (${writeError.message || writeError})` : `${seen.observed.length} matching records observed`
    throw new Error(`task delivery summary for ${candidate.prHead} was not confirmed exactly once: ${detail}`)
  }
}

async function postBlocker(phaseName, reason) {
  const branch = slug ? `epic/${slug}` : null
  if (!openCandidate && slug) {
    try { await preserveIssueWork({ slug, phase: phaseName }) }
    catch (error) { log(`blocked: could not preserve the work (${error?.message || error})`) }
  }
  const location = openCandidate
    ? `- PR: ${openCandidate.prUrl} on ${openCandidate.branch}; candidate \`${openCandidate.prHead}\` is pushed but NOT queued for merge\n- next: inspect the evidence and labels by hand; do not rerun task-run while this PR is open`
    : branch
      ? `- branch: ${branch} — re-running remote-control.sh task ${issue} resumes it; delete the local and remote branch only to force a fresh build`
      : `- branch: none — re-running remote-control.sh task ${issue} starts fresh`
  let body = `🤖 task-run blocked\n- phase: ${phaseName}\n- reason: ${reason}\n${location}\n`
  if (slug && existsSync(path.join(epicDir(slug), 'epic.md'))) {
    const match = readFileSync(path.join(epicDir(slug), 'epic.md'), 'utf8').match(/## Phase log[\s\S]*$/)
    if (match) body += `\n${match[0].trim()}\n`
  }
  try { await comment(issue, body, terminalSpend()) }
  catch (error) { log(`blocked: GitHub report failed (${error?.message || error})`) }
  const { flipped } = await restIssueFailed({ issue })
  if (!flipped.ok) log(`blocked: label flip to failed failed (${failureReason(flipped)})`)
}

async function fail(phaseName, reason, suppliedFailure) {
  const failure = suppliedFailure === undefined ? takeAgentFailure() : suppliedFailure
  if (failure?.kind === 'quota-exhausted') {
    const held = await holdIssueForQuota({ issue, slug, phase: phaseName, failure })
    if (!held.error) return held
    reason = `${reason} Provider quota hold failed: ${held.error}.`
  }
  reason = withAgentFailure(reason, failure)
  if (!blockerPosted) {
    blockerPosted = true
    try { await postBlocker(phaseName, reason) }
    catch (error) { log(`blocked: terminal reporting failed (${error?.message || error})`) }
  }
  return { blocked: true, issue, slug: slug || undefined, phase: phaseName, reason, prUrl: openCandidate?.prUrl, outcome: 'human-blocked' }
}

async function main() {
  try {
    currentPhase = 'prepare'
    phase('Prepare')
    const labels = await issueLabels(issue)
    if (!labels.includes('task')) {
      return { skipped: true, issue, reason: 'issue does not carry the persistent task selector label', outcome: 'skipped' }
    }
    const prep = await prepareIssueDelivery({ issue, engine: ARGS.engine, lifecycle: ISSUE_LIFECYCLE })
    if (prep.refused) return { skipped: true, issue, reason: prep.refused, outcome: 'skipped' }
    if (prep.alreadyExists) return { skipped: true, issue, reason: prep.note, outcome: 'skipped' }
    slug = prep.slug
    if (!prep.packages.length) return fail('prepare', 'layout discovery found no package declaring an `npm run verify` script — refusing to build a change that nothing would verify.')
    log(`Prepare: branch ${prep.branch} ${prep.resumed ? 'resumed' : 'claimed'}; deps checked (${prep.depLines.join('; ')}). Packages: ${pkgList(prep.packages)}.`)

    currentPhase = 'task'
    phase('Task')
    let implemented = await agent(prompt(prep), {
      label: 'task', phase: 'Task', step: 'task', schema: TASK_SCHEMA, respawn: false,
    })
    if (!implemented) return fail('task', 'the initial tasker process failed or returned malformed output; the one-process contract forbids a respawn for runtime or schema failure.')
    const problem = resultProblem(implemented)
    if (problem) return fail('task', problem)
    if (implemented.status === 'blocked') {
      return fail('task', `the tasker could not complete safely: ${implemented.unresolved.map(String).join('; ')}`)
    }
    updateEpicMd(epicDir(slug), { phase: 'task → implemented', log: `task: ${implemented.summary}` })

    currentPhase = 'verify'
    phase('Verify')
    finalVerify = await runVerify(prep.packages)
    log(`Verify: ${finalVerify.green ? 'green' : 'RED'} — ${finalVerify.detail}`)
    if (!finalVerify.green && repairableVerifyFailure(finalVerify)) {
      const firstVerify = finalVerify
      log('Verify: RED — starting the one fresh task repair process with captured diagnostics.')
      currentPhase = 'task'
      phase('Task')
      const repaired = await agent(verifyRepairPrompt(prep, firstVerify), {
        label: 'task:verify-repair', phase: 'Task', step: 'task', schema: TASK_SCHEMA,
        retry: true, respawn: false,
      })
      if (!repaired) {
        return fail('task', `the verification repair tasker failed or returned malformed output; no third task process is permitted. Initial verification diagnostics:\n${verifyDiagnostic(firstVerify)}`)
      }
      const repairProblem = resultProblem(repaired)
      if (repairProblem) {
        return fail('task', `${repairProblem} during the verification repair; no third task process is permitted. Initial verification diagnostics:\n${verifyDiagnostic(firstVerify)}`)
      }
      if (repaired.status === 'blocked') {
        return fail('task', `the verification repair tasker could not complete safely: ${repaired.unresolved.map(String).join('; ')}. No third task process is permitted. Initial verification diagnostics:\n${verifyDiagnostic(firstVerify)}`)
      }
      implemented = repaired
      updateEpicMd(epicDir(slug), { phase: 'task → verify repair', log: `task verify repair: ${repaired.summary}` })

      currentPhase = 'verify'
      phase('Verify')
      finalVerify = await runVerify(prep.packages)
      log(`Verify retry: ${finalVerify.green ? 'green' : 'RED'} — ${finalVerify.detail}`)
      if (!finalVerify.green) {
        return fail('verify', `npm run verify remained red after the one diagnostics-driven task repair; no third task process is permitted.\n\nInitial verification diagnostics:\n${verifyDiagnostic(firstVerify)}\n\nFinal verification diagnostics:\n${verifyDiagnostic(finalVerify)}`)
      }
    } else if (!finalVerify.green) {
      return fail('verify', `npm run verify did not produce a repairable test/check failure (${finalVerify.detail}); timeout or process-launch failures never start another task process.`)
    }
    await checkpoint(slug, 'task')

    currentPhase = 'rebase'
    phase('Rebase')
    const fetched = await git(['fetch', 'origin'])
    if (!fetched.ok) return fail('rebase', `git fetch origin failed (${failureReason(fetched)}) — refusing to open a PR against an unconfirmed base.`)
    const landed = Number(await gitOut(['rev-list', '--count', 'HEAD..origin/main'], 'git rev-list')) || 0
    if (landed > 0) {
      const before = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')
      const rebased = await git(['rebase', 'origin/main'])
      if (!rebased.ok) {
        if (await rebaseInProgress()) await git(['rebase', '--abort'])
        log(`Rebase: origin/main moved by ${landed} commit(s) and conflicted — keeping the verified original base for the standard merge worker/fixer path.`)
      } else {
        const depLines = await ensureDeps(prep.packages, { pairs: [[before, 'HEAD']] })
        log(`Rebase: clean onto current origin/main; deps checked (${depLines.join('; ')}).`)
        finalVerify = await runVerify(prep.packages)
        log(`Rebase verify: ${finalVerify.green ? 'green' : 'RED'} — ${finalVerify.detail}`)
        if (!finalVerify.green) return fail('rebase', `npm run verify is red after the clean rebase (${finalVerify.detail}) — refusing an unverified handoff.`)
      }
    } else {
      log('Rebase: origin/main did not move; the verified candidate is current.')
    }

    currentPhase = 'deliver'
    phase('Deliver')
    const body = renderIssuePrBody({ issue, prefix: 'Specification and task delivery record' })
    const candidate = await createIssueCandidate({ issue, slug, decision: implemented, body })
    openCandidate = candidate
    await publishDeliverySummary(candidate, implemented)
    const conservative = await restIssueReadyToReview({ issue })
    if (!conservative.flipped.ok) log(`Deliver: conservative ready-to-review transition was not acknowledged (${failureReason(conservative.flipped)}); handoff readback remains authoritative.`)
    const handed = await handoffIssue({ issue, dir: epicDir(slug), log })
    if (!handed.labelled) {
      const reason = handed.unresolved || handed.summary || 'ready-to-merge was not confirmed'
      return fail('handoff', `the verified task PR was opened, but its ready-to-merge handoff failed (${reason}).`)
    }
    updateEpicMd(epicDir(slug), { phase: 'task → done', log: `task: PR opened ${candidate.prUrl}; ready-to-merge confirmed` })
    return {
      issue, slug, branch: candidate.branch, prUrl: candidate.prUrl, candidate: candidate.prHead,
      readyToMerge: true, verify: finalVerify.detail, outcome: 'merge-queued',
    }
  } catch (error) {
    return fail(currentPhase, error?.message || String(error))
  }
}

const RESULT = await main()
await statusFinish(RESULT?.held
  ? `**held**: provider quota exhausted, resumes after ${RESULT.holdUntil} — vendor: ${RESULT.vendor}; provider reason: "${RESULT.reason}"`
  : RESULT?.blocked
    ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}`
    : RESULT?.skipped
      ? `**skipped**: ${RESULT.reason}`
      : RESULT?.readyToMerge
        ? `**done** — ${RESULT.prUrl} queued for the merge worker`
        : '**finished**', terminalSpend())
process.exit(finish(RESULT))
