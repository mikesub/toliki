// The conflict, CI and defect fixers have different admission evidence and
// publication ordering, but the run around that cause-specific work is one
// lifecycle. This fixed-purpose runner owns that lifecycle: argv/runtime/status
// setup, prepare -> repair -> verify (with one diagnostic repair retry) ->
// check -> publish sequencing, shared
// gates, quota/refund handling, blocker fallback, final status, RESULT and exit
// selection. Entry points supply only the cause adapter described below; this
// is deliberately not a configurable workflow framework.
//
// Cause adapters retain the operations whose ordering is part of their safety
// contract: conflict rebase/autoresolve, its scripted `settle` step (marker
// check, staging and rebase continuation, so a repair agent never advances the
// branch itself) and evidence-before-push, CI failure
// capture and local reproduction, and defect evidence binding, head readback,
// evidence refresh and landing-only recovery. Once a partial push is observed,
// state is monotonic: no exception can reach the ordinary requeueing blocker.
//
// The check stage is the bounded repair contract (see lib/repair-acceptance.mjs):
// ONE exhaustive acceptance check over every original disposition and the
// complete repair delta, then — only when every blocker it returns is a
// concrete implementation defect — ONE scoped correction inside this same
// invocation, the orchestrator's full verify contract again, and ONE narrow
// read-only confirmation. There is no second correction batch.
//
// Semantic completion and operational relaunch are separate here, and the
// difference is which terminal state the run comes to rest at. A semantic
// human outcome — acceptance chose `human`, the correction declined or changed
// nothing, the second verify was red, the confirmation refused — REMOVES this
// fixer's queue label so dispatch cannot launch another complete fixer at work
// that already had its one correction, and it spends no extra ladder rung to
// achieve that. An operational failure — provider quota, a dead process,
// transport — keeps the historical blocker path, its refund and its ladder.

import { agent, phase, log, initRuntime, onPhase, onLog, takeAgentFailure, withAgentFailure } from './runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './status.mjs'
import {
  editLabels,
  ensureLabels,
  issueLabels,
  issueView,
  terminalBudget,
  terminalSpend,
  terminalTimeout,
  verifyIssueEngine,
} from './github.mjs'
import { captureDiff, runVerify, worktreeTree } from './repo.mjs'
import { finalizeFixerIssue, finalizeFixerQuotaHold } from './fixer-finalize.mjs'
import {
  ACCEPTANCE_CONFIDENCE,
  validateAcceptance,
  validateConfirmation,
  validateCorrection,
} from './repair-acceptance.mjs'
import { recordQuotaHold } from '../quota-hold.mjs'

const message = error => error?.message || String(error)

// Writable agents do not execute project gates. When their first repair leaves
// the tree red, the orchestrator gives one fresh process its own bounded,
// sanitized output and then runs the complete gate once more. This is separate
// from a provider/process respawn inside agent() and from the fixer's durable
// two-rung attempt ladder.
const verificationRetryPrompt = verified => `

The orchestrator ran the project's full verification command after your repair and it is RED. This is the one verification-driven repair retry in this run; a second red result blocks before the acceptance check.

Captured failure diagnostics:
${verified.tail || verified.detail}

Repair the reported cause without weakening, skipping, deleting or loosening a test, assertion, type, lint rule, check, or security guard. Do not run tests or verification yourself. Leave the updated working tree for the orchestrator to verify, and return the complete structured result requested above again.`

// Exact indexed coverage is the common contract between every repair agent and
// its blind checker. `legacy` preserves the entry point's existing safe
// interrupted-run payload, while `validate` adds cause-specific fields (the
// conflict resolver's two intents and resolution, for example).
export function validateIndexedDispositions(result, items, {
  subject,
  itemName,
  missing,
  incomplete,
  legacy,
  validate,
  decorate = (item, disposition, index) => ({ ...disposition, index, ...item }),
} = {}) {
  if (result?.escalate) return { problem: `escalated rather than guessed: ${result.escalate}` }

  let dispositions
  if (Array.isArray(result?.dispositions)) {
    dispositions = result.dispositions
  } else if (legacy) {
    const converted = legacy(result, items)
    if (converted?.problem) return converted
    dispositions = converted?.dispositions
  }
  if (!Array.isArray(dispositions)) {
    if (result?.completed === false && incomplete) return { problem: incomplete }
    return { problem: missing }
  }
  if (dispositions.length !== items.length) {
    return { problem: `${subject} returned ${dispositions.length} disposition(s) for ${items.length} ${itemName}(s)` }
  }

  const byIndex = new Map()
  for (const disposition of dispositions) {
    const index = Number(disposition?.index)
    if (!Number.isInteger(index) || index < 1 || index > items.length || byIndex.has(index)) {
      return { problem: `${subject} returned duplicate, missing, or out-of-range disposition indexes` }
    }
    if (!['repaired', 'declined'].includes(disposition.action) ||
        typeof disposition.reason !== 'string' || !disposition.reason.trim()) {
      return { problem: `${itemName} disposition ${index} needs a repaired/declined action and non-empty reason` }
    }
    const problem = validate?.(disposition, index)
    if (problem) return { problem }
    byIndex.set(index, disposition)
  }
  if (byIndex.size !== items.length) return { problem: `${subject} did not cover every ${itemName} exactly once` }
  return {
    dispositions: items.map((item, offset) => decorate(item, byIndex.get(offset + 1), offset + 1)),
  }
}

export async function runFixerLifecycle(spec) {
  let args
  try {
    args = parseArgs(process.argv.slice(2), { allowSlug: false, usage: spec.usage })
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write((error.message ? `${spec.scriptName}: ${error.message}\n\n` : '') + error.usage + '\n')
      process.exit(error.message ? EXIT.ERROR : EXIT.OK)
    }
    throw error
  }

  initRuntime({ scriptName: spec.scriptName, sessionName: args.session, defaultEngine: args.engine, issue: args.issue, repo: args.repo })
  initStatus({ issue: args.issue, script: spec.scriptName, session: args.session, phases: spec.phases })
  onPhase(statusPhase)
  // Once a terminal write opens reap's clock, only the final awaited edit may
  // join the status queue. The same rule now applies to all three fixers.
  onLog(note => { if (!terminalSpend()) statusNote(note) })

  const state = {
    phase: 'prepare',
    blockerPosted: false,
    prUrl: null,
    attempt: 0,
    terminalWindow: null,
    partialPushed: false,
    // What the run's own terminal transition read back: whether it verified,
    // which label the issue was left resting at, and whether the fixer queue
    // is still on it. The outcome classification is derived from this and
    // nothing else — a queue nobody confirmed is not a queued repair.
    rest: null,
  }

  const ctx = {
    args,
    issue: args.issue,
    state,
    get attempt() { return state.attempt },
    get prUrl() { return state.prUrl },
    get terminalWindow() { return state.terminalWindow },
    enter(key, title) {
      state.phase = key
      phase(title)
    },
    openTerminalBudget() {
      const budget = terminalBudget()
      state.terminalWindow = budget
      return budget
    },
    async finalizeIssue(options) {
      const settled = await finalizeFixerIssue(options)
      state.terminalWindow = settled.budget
      state.rest = {
        verified: settled.settled,
        resting: options.add?.[0] || null,
        queued: settled.labels.includes(spec.queue.label),
      }
      return settled
    },
    async consumeAttempt({ labels, first, retry, remove }) {
      const attempt = labels.includes(first) ? 2 : 1
      const rung = attempt === 2 ? retry : first
      state.attempt = attempt
      await ensureLabels([first, retry, 'in-progress'])
      await editLabels(ctx.issue, { add: ['in-progress', rung], remove })
      const current = await issueLabels(ctx.issue)
      return {
        attempt,
        rung,
        current,
        recorded: current.includes('in-progress') && current.includes(rung) &&
          remove.every(label => !current.includes(label)),
      }
    },
  }

  const noteFinalization = (settled, kind = 'restoration') => {
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label ${kind} failed (${settled.stateError})`)
  }

  // Which side of the handoff line a blocked run falls on, from the verified
  // resting state alone:
  //   - a pushed partial belongs to a person the moment it lands, and is a
  //     human hold when the landing labels were confirmed;
  //   - a transition the run could not verify is never an automated queue: the
  //     next dispatch may not happen at all, so it waits for a person;
  //   - a confirmed queue label with a rung left is the next fixer's work;
  //   - a spent ladder, or a rest at `failed`, is a person's.
  const outcomeForBlocker = (shipped = {}) => {
    if (state.partialPushed) {
      return (state.rest?.verified && state.rest.resting === 'ready-to-review') || shipped.labelled
        ? 'human-review'
        : 'human-blocked'
    }
    if (!state.rest?.verified) return 'human-blocked'
    if (state.rest.queued && state.attempt < 2) return 'repair-queued'
    return state.rest.resting === 'ready-to-review' ? 'human-review' : 'human-blocked'
  }

  const blockedResult = (failedPhase, reason, extra = {}, shipped = {}) => ({
    blocked: true,
    issue: ctx.issue,
    phase: failedPhase,
    reason,
    prUrl: state.prUrl || undefined,
    attempt: state.attempt,
    outcome: outcomeForBlocker(shipped),
    ...extra,
  })

  async function partialFailure(reason, shipped = {}) {
    state.partialPushed = true
    state.blockerPosted = true
    try {
      await spec.partialFailure(ctx, reason, shipped)
    } catch (error) {
      log(`blocked after partial push: could not finish the human hold (${message(error)})`)
    }
    return blockedResult('ship', reason, { partialPushed: true }, shipped)
  }

  async function postBlocker(failedPhase, reason) {
    await spec.cleanup?.(ctx, terminalTimeout)
    const transition = spec.blocker.transition(ctx)
    const settled = await ctx.finalizeIssue({
      issue: ctx.issue,
      body: labelState => spec.blocker.body(ctx, { phase: failedPhase, reason }, {
        ...labelState,
        resting: transition.add?.[0],
      }),
      ...transition,
      budget: state.terminalWindow || undefined,
    })
    noteFinalization(settled)
  }

  async function holdForQuota(failedPhase, failure, reason) {
    try {
      await spec.cleanup?.(ctx)
      const { hostHold, trigger } = await recordQuotaHold({ vendor: failure.vendor, reason: failure.reason })
      const rung = spec.attemptRung(state.attempt)
      const transitions = spec.quota(ctx, rung)
      const finalized = await finalizeFixerQuotaHold({
        issue: ctx.issue,
        rung,
        hold: transitions.hold,
        blocked: transitions.blocked,
        body: (labelState, holdState) => spec.blocker.body(ctx, {
          phase: failedPhase,
          reason: withAgentFailure(`${reason} Provider quota hold failed: ${holdState.stateError}.`, failure),
        }, labelState),
        budget: state.terminalWindow || undefined,
      })
      state.terminalWindow = finalized.budget
      if (!finalized.held) {
        state.blockerPosted = true
        // The hold could not be verified, so the fallback blocker transition is
        // this run's resting state — classify from that readback, not the hold.
        state.rest = {
          verified: finalized.blockState.settled,
          resting: (transitions.blocked.add || [])[0] || null,
          queued: finalized.blockState.labels.includes(spec.queue.label),
        }
        noteFinalization(finalized.blockState)
        return blockedResult(failedPhase,
          withAgentFailure(`${reason} Provider quota hold failed: ${finalized.holdState.stateError}.`, failure))
      }
      return { held: true, issue: ctx.issue, phase: failedPhase, ...hostHold, ...trigger, attempt: state.attempt, outcome: 'quota-held' }
    } catch (error) {
      return { error: message(error) }
    }
  }

  // A semantic dead end inside the bounded repair contract. It differs from
  // fail() in exactly one way that matters: the fixer's own queue label comes
  // OFF and the human-held resting state is verified, so dispatch cannot send a
  // second complete fixer at blockers a correction was already given its one
  // chance at. No ladder rung is manufactured to obtain that — the queue removal
  // is the mechanism, not a spent retry label.
  async function humanHold(failedPhase, reason) {
    state.blockerPosted = true
    try {
      await spec.cleanup?.(ctx, terminalTimeout)
      const transition = spec.humanHold.transition(ctx)
      const settled = await ctx.finalizeIssue({
        issue: ctx.issue,
        body: labelState => spec.humanHold.body(ctx, { phase: failedPhase, reason }, {
          ...labelState,
          resting: transition.add?.[0],
        }),
        ...transition,
        budget: state.terminalWindow || undefined,
      })
      noteFinalization(settled, 'quarantine')
    } catch (error) {
      log(`blocked: could not report the human-held result on GitHub (${message(error)})`)
    }
    log(`Check: held for a human — ${reason}`)
    return { ...blockedResult(failedPhase, reason), humanHeld: true }
  }

  // A narrow confirmation that died or came back malformed confirmed nothing,
  // and relaunching a whole fixer would repeat a correction this repair already
  // had its one chance at — so that is a semantic dead end. A provider quota is
  // the exception: it keeps the refund, the hold and the durable recovery.
  const quotaOrHuman = (failedPhase, reason) => {
    const failure = takeAgentFailure()
    return failure?.kind === 'quota-exhausted'
      ? fail(failedPhase, reason, failure)
      : humanHold(failedPhase, reason)
  }

  async function fail(failedPhase, originalReason, suppliedFailure = undefined) {
    let reason = originalReason
    const failure = suppliedFailure === undefined ? takeAgentFailure() : suppliedFailure
    if (failure?.kind === 'quota-exhausted' && !state.partialPushed) {
      const held = await holdForQuota(failedPhase, failure, reason)
      if (!held.error) return held
      reason = `${reason} Provider quota hold failed: ${held.error}.`
    }
    reason = withAgentFailure(reason, failure)

    // A pushed partial is owned by a human from this instant onward. Never
    // scrub its tree, refund its rung, restore its fixer queue or expose merge.
    if (state.partialPushed) return partialFailure(reason, { stage: 'exception' })

    if (!state.blockerPosted) {
      state.blockerPosted = true
      try {
        await postBlocker(failedPhase, reason)
      } catch (error) {
        log(`blocked: could not report on GitHub (${message(error)})`)
      }
    }
    return blockedResult(failedPhase, reason)
  }
  ctx.fail = fail

  // The one scoped correction, run inside this invocation on the repair that is
  // still unpushed. Nothing about the run is rewound first: the worktree is not
  // cleaned, the queue is not restored, the ladder rung is not consumed and no
  // second whole fixer is launched. The correction sees the pinned requirement
  // and cause evidence its adapter supplies, every original disposition, the
  // complete cumulative repair delta, the exhaustive blocker batch and the
  // successful verification evidence, and may address only those blockers.
  //
  // Every way this can end short of a clean narrow confirmation is a human-held
  // result. That is the whole point of batching: automation gets ONE informed
  // correction opportunity, never the hours-long review/fix loop that repeated
  // whole repairs turned into.
  async function runCorrection(ctx, prep, dispositions, accepted, cumulative, verified) {
    const stop = async result => ({ stopped: true, result: await result })
    const before = await worktreeTree()
    if (before === null) {
      return stop(fail('check', 'the pre-correction tree could not be captured — refusing to run a correction whose exact delta could not be shown.'))
    }

    log(`Check: ${accepted.blockers.length} concrete blocker(s) — running one scoped correction (${accepted.blockers.map(blocker => blocker.id).join(', ')}).`)
    const raw = await agent(
      spec.check.correction.prompt(ctx, prep, dispositions, {
        blockers: accepted.blockers, verdicts: accepted.verdicts, cumulative, verified,
      }),
      { ...spec.check.correction.agent, retry: true })
    // The correction is a writable repair step: a death here is operational and
    // keeps the historical refund, ladder and blocker behavior.
    if (!raw) return stop(fail('check', spec.check.correction.noResult))
    const validated = validateCorrection(raw, accepted.blockers)
    if (validated.problem) return stop(humanHold('check', `${validated.problem}.`))

    // A correction that reported success and produced nothing has repaired
    // nothing: the blockers stand exactly as the acceptance check found them.
    const after = await worktreeTree()
    if (after === null) {
      return stop(fail('check', 'the corrected tree could not be captured — refusing to confirm a correction whose exact delta could not be shown.'))
    }
    if (after === before) {
      return stop(humanHold('check', `the scoped correction reported ${validated.dispositions.length} corrected blocker(s) but changed no file — every blocker stands exactly as the acceptance check found it.`))
    }
    const correctionDelta = await captureDiff([before, after])
    if (correctionDelta === null) {
      return stop(fail('check', 'the exact correction delta could not be captured — refusing to confirm a correction on incomplete evidence.'))
    }

    // The full orchestrator verification contract again, never a lighter one: a
    // correction edits code nothing has run since. Red ends the run for a human
    // and starts neither another correction nor another autonomous whole fixer.
    ctx.enter('verify', 'Verify')
    const reverified = await runVerify(spec.verify.packages(prep))
    spec.verify.log(ctx, prep, reverified)
    if (!reverified.green) {
      return stop(humanHold('verify', `npm run verify is red after the scoped correction (${reverified.detail}) — the correction is not pushed, and no further correction or fixer attempt runs.`))
    }

    ctx.enter('check', 'Check')
    const cumulativeAfter = await spec.check.delta(ctx, prep)
    if (cumulativeAfter === null) {
      return stop(fail('check', 'the cumulative repair delta could not be recaptured after the correction.'))
    }
    // Read-only, blind to the correction's own account, and narrow: it proves
    // the batch cleared and nothing else broke, and it never restarts a broad
    // review of work that was already accepted.
    const confirmRaw = await agent(
      spec.check.confirm.prompt(ctx, prep, dispositions, {
        blockers: accepted.blockers,
        verdicts: accepted.verdicts,
        cumulative: cumulativeAfter,
        correction: correctionDelta,
      }),
      spec.check.confirm.agent)
    if (!confirmRaw) return stop(quotaOrHuman('check', spec.check.confirm.noResult))
    const confirmed = validateConfirmation(confirmRaw, accepted.blockers)
    if (confirmed.problem) return stop(humanHold('check', `${confirmed.problem} — there is no second correction batch.`))

    log(`Check: the scoped correction cleared every blocker and a narrow confirmation proved it at confidence ${confirmed.confirmation.confidence} (bar ${ACCEPTANCE_CONFIDENCE}).`)
    return {
      stopped: false,
      blockers: accepted.blockers,
      dispositions: validated.dispositions,
      confirmation: confirmed.confirmation,
      delta: correctionDelta,
      verified: reverified,
    }
  }

  async function main() {
    try {
      ctx.enter('prepare', 'Prepare')
      const view = await issueView(ctx.issue, 'state,labels,title')
      const labels = Array.isArray(view.labels) ? view.labels.map(label => label.name) : []
      let prep
      if (String(view.state || '').toUpperCase() === 'CLOSED') {
        prep = { refused: `issue #${ctx.issue} is closed` }
      } else if (!labels.includes(spec.queue.label)) {
        prep = { refused: spec.queue.missing(ctx.issue) }
      } else {
        // A fixer always inherits the durable route recorded by the original
        // claim. This stays ahead of evidence reads, attempt writes and git.
        await verifyIssueEngine(ctx.issue, ctx.args.engine)
        prep = await spec.prepare(ctx, { view, labels })
      }
      if (prep.refused) {
        log(`Prepare refused: ${prep.refused}`)
        // A final refusal has already made and read back its terminal human
        // transition. Classifying it as a generic skip would let a later
        // exhausted-ladder probe overwrite the issue lifetime's real handoff.
        // Ordinary closed/missing-queue refusals did no such work and remain
        // skipped. An unverified final transition is conservatively blocked.
        const outcome = prep.refusalFinal
          ? (state.rest?.verified && state.rest.resting === 'ready-to-review' ? 'human-review' : 'human-blocked')
          : 'skipped'
        return { skipped: true, issue: ctx.issue, reason: prep.refused, refusalFinal: !!prep.refusalFinal, outcome }
      }
      state.attempt = prep.attempt
      state.prUrl = prep.prUrl || null
      if (prep.gitBlocked) return fail('prepare', prep.gitBlocked)
      await spec.prepared?.(ctx, prep)

      if (spec.recovery?.needed(prep)) return await spec.recovery.run(ctx, prep)

      let repairResult = null
      let dispositions = []
      let repairRetried = false
      const repairNeeded = spec.repair.needed(prep)
      const runRepair = async (failedVerify = null) => {
        ctx.enter(spec.repair.key, spec.repair.phase)
        const retry = failedVerify !== null
        if (retry) repairRetried = true
        const options = retry
          ? { ...spec.repair.agent, label: `${spec.repair.agent.label}:retry`, retry: true }
          : spec.repair.agent
        repairResult = await agent(
          spec.repair.prompt(ctx, prep, { retry, failedVerify }) + (retry ? verificationRetryPrompt(failedVerify) : ''),
          options)
        if (!repairResult) return { stopped: true, result: await fail(spec.repair.key, spec.repair.noResult) }
        const normalized = spec.repair.normalize(repairResult, prep)
        if (normalized.problem) return { stopped: true, result: await fail(spec.repair.key, normalized.problem) }
        dispositions = normalized.dispositions
        const repaired = dispositions.filter(item => item.action === 'repaired')
        const declined = dispositions.filter(item => item.action === 'declined')
        if (!repaired.length) return { stopped: true, result: await fail(spec.repair.key, spec.repair.allDeclined(declined)) }
        // The scripted finish of whatever repository state the repair agent was
        // left sitting in — the conflict fixer's staging and rebase
        // continuation. It runs only once every item has a disposition and at
        // least one is a repair, and its first problem blocks: work the
        // orchestrator could not carry forward itself is never a finished
        // repair, whatever the agent claimed.
        const settleProblem = await spec.repair.settle?.(ctx, prep, dispositions)
        if (settleProblem) return { stopped: true, result: await fail(spec.repair.key, settleProblem) }
        const treeProblem = await spec.repair.treeProblem?.(ctx, prep, repairResult, dispositions)
        if (treeProblem) return { stopped: true, result: await fail(spec.repair.key, treeProblem) }
        spec.repair.log(ctx, prep, repairResult, repaired, declined)
        return { stopped: false }
      }

      if (repairNeeded) {
        const repaired = await runRepair()
        if (repaired.stopped) return repaired.result
      }

      ctx.enter('verify', 'Verify')
      let verified = await runVerify(spec.verify.packages(prep))
      spec.verify.log(ctx, prep, verified)
      if (!verified.green && repairNeeded) {
        log('Verify: RED — respawning the repair once with the scripted failure diagnostics.')
        const repaired = await runRepair(verified)
        if (repaired.stopped) return repaired.result
        ctx.enter('verify', 'Verify')
        verified = await runVerify(spec.verify.packages(prep))
        spec.verify.log(ctx, prep, verified)
      }
      if (!verified.green) {
        const reason = spec.verify.failure(prep, verified)
        return fail('verify', repairNeeded
          ? `${reason} The gate remained red after its one diagnostic repair retry.`
          : reason)
      }

      let check = null
      let corrected = null
      let finalVerified = verified
      if (spec.check.needed(prep, dispositions)) {
        ctx.enter('check', 'Check')
        // Orchestrator-captured, never a command the checker is asked to run:
        // a judging step has no shell under Claude and only a read-only sandbox
        // under Codex, and evidence a step gathered for itself is evidence
        // nothing proved it received. New and untracked files are included.
        const cumulative = await spec.check.delta(ctx, prep)
        if (cumulative === null) {
          return fail('check', 'the complete repair delta could not be captured — refusing to check a repair on incomplete evidence.')
        }

        const raw = await agent(spec.check.prompt(ctx, prep, dispositions, { cumulative }), spec.check.agent)
        if (!raw) return fail('check', spec.check.noResult)
        const accepted = validateAcceptance(raw, dispositions.length)
        // Malformed, incomplete, duplicate, extra or low-confidence evidence
        // authorizes nothing — neither a correction nor an unattended merge —
        // and it is a checker that misbehaved rather than a repair judged
        // wanting, so it keeps the ordinary blocker path.
        if (accepted.problem) return fail('check', `${accepted.problem} — refusing to act on acceptance evidence that decides nothing.`)
        const floor = Math.min(...accepted.verdicts.map(verdict => verdict.confidence))
        check = { ...accepted, confidence: floor, reasoning: accepted.verdicts.map(v => `item ${v.index}: ${v.reasoning}`).join(' ') }
        spec.check.log(ctx, prep, check)

        if (accepted.outcome === 'human') {
          return humanHold('check', `the acceptance check held ${accepted.blockers.length} blocker(s) for a human: ${accepted.blockers.map(b => `${b.id} (${b.kind}) ${b.location}: ${b.evidence}`).join('; ')}`)
        }
        if (accepted.outcome === 'correction-required') {
          const applied = await runCorrection(ctx, prep, dispositions, accepted, cumulative, verified)
          if (applied.stopped) return applied.result
          corrected = applied
          check = { ...check, corrected: applied.dispositions, confidence: Math.min(floor, applied.confirmation.confidence) }
          finalVerified = applied.verified
        }
      }

      ctx.enter('ship', 'Ship')
      const declined = dispositions.filter(item => item.action === 'declined')
      const partial = declined.length > 0
      const shipped = await spec.ship(ctx, {
        prep, repairResult, dispositions, declined, verified: finalVerified, check, corrected, partial, repairRetried,
      })
      if (!shipped.pushed) return fail('ship', spec.shipFailure(shipped))
      if (partial) state.partialPushed = true
      if (partial && (!shipped.labelled || !shipped.reported)) {
        return partialFailure(spec.partialShipFailure(shipped), shipped)
      }
      if (!shipped.labelled) return fail('ship', spec.landingFailure(shipped))
      spec.shipLog(ctx, prep, declined, partial)
      // A partial landing is a human hold by construction: its labelled and
      // reported readbacks were both required above, so the issue is resting in
      // front of a person rather than in any queue.
      return {
        ...spec.result(ctx, { prep, repairResult, dispositions, declined, verified: finalVerified, check, corrected, partial, repairRetried, shipped }),
        outcome: partial ? 'human-review' : 'merge-queued',
      }
    } catch (error) {
      return fail(state.phase, message(error))
    }
  }

  const result = await main()
  await statusFinish(spec.status(result), { budget: state.terminalWindow || undefined })
  process.exit(finish(result))
}
