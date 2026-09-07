// The conflict, CI and defect fixers have different admission evidence and
// publication ordering, but the run around that cause-specific work is one
// lifecycle. This fixed-purpose runner owns that lifecycle: argv/runtime/status
// setup, prepare -> repair -> verify -> check -> publish sequencing, shared
// gates, quota/refund handling, blocker fallback, final status, RESULT and exit
// selection. Entry points supply only the cause adapter described below; this
// is deliberately not a configurable workflow framework.
//
// Cause adapters retain the operations whose ordering is part of their safety
// contract: conflict rebase/autoresolve and evidence-before-push, CI failure
// capture and local reproduction, and defect evidence binding, head readback,
// evidence refresh and landing-only recovery. Once a partial push is observed,
// state is monotonic: no exception can reach the ordinary requeueing blocker.

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
import { runVerify } from './repo.mjs'
import { finalizeFixerIssue, finalizeFixerQuotaHold } from './fixer-finalize.mjs'
import { recordQuotaHold } from '../quota-hold.mjs'

const message = error => error?.message || String(error)

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

  initRuntime({ scriptName: spec.scriptName, sessionName: args.session, defaultEngine: args.engine, issue: args.issue })
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

  const blockedResult = (failedPhase, reason, extra = {}) => ({
    blocked: true,
    issue: ctx.issue,
    phase: failedPhase,
    reason,
    prUrl: state.prUrl || undefined,
    attempt: state.attempt,
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
    return blockedResult('ship', reason, { partialPushed: true })
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
        noteFinalization(finalized.blockState)
        return blockedResult(failedPhase,
          withAgentFailure(`${reason} Provider quota hold failed: ${finalized.holdState.stateError}.`, failure))
      }
      return { held: true, issue: ctx.issue, phase: failedPhase, ...hostHold, ...trigger, attempt: state.attempt }
    } catch (error) {
      return { error: message(error) }
    }
  }

  async function fail(failedPhase, originalReason) {
    let reason = originalReason
    const failure = takeAgentFailure()
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
        return { skipped: true, issue: ctx.issue, reason: prep.refused, refusalFinal: !!prep.refusalFinal }
      }
      state.attempt = prep.attempt
      state.prUrl = prep.prUrl || null
      if (prep.gitBlocked) return fail('prepare', prep.gitBlocked)
      await spec.prepared?.(ctx, prep)

      if (spec.recovery?.needed(prep)) return await spec.recovery.run(ctx, prep)

      let repairResult = null
      let dispositions = []
      if (spec.repair.needed(prep)) {
        ctx.enter(spec.repair.key, spec.repair.phase)
        repairResult = await agent(spec.repair.prompt(ctx, prep), spec.repair.agent)
        if (!repairResult) return fail(spec.repair.key, spec.repair.noResult)
        const normalized = spec.repair.normalize(repairResult, prep)
        if (normalized.problem) return fail(spec.repair.key, normalized.problem)
        dispositions = normalized.dispositions
        const repaired = dispositions.filter(item => item.action === 'repaired')
        const declined = dispositions.filter(item => item.action === 'declined')
        if (!repaired.length) return fail(spec.repair.key, spec.repair.allDeclined(declined))
        const treeProblem = await spec.repair.treeProblem?.(ctx, prep, repairResult, dispositions)
        if (treeProblem) return fail(spec.repair.key, treeProblem)
        spec.repair.log(ctx, prep, repairResult, repaired, declined)
      }

      ctx.enter('verify', 'Verify')
      const verified = await runVerify(spec.verify.packages(prep))
      spec.verify.log(ctx, prep, verified)
      if (!verified.green) return fail('verify', spec.verify.failure(prep, verified))

      let check = null
      if (spec.check.needed(prep, dispositions)) {
        ctx.enter('check', 'Check')
        await spec.check.before?.(ctx, prep, dispositions)
        check = await agent(spec.check.prompt(ctx, prep, dispositions), spec.check.agent)
        if (!check) return fail('check', spec.check.noResult)
        if (!check.survives || check.confidence < 75) return fail('check', spec.check.refuted(check))
        spec.check.log(ctx, prep, check)
      }

      ctx.enter('ship', 'Ship')
      const declined = dispositions.filter(item => item.action === 'declined')
      const partial = declined.length > 0
      const shipped = await spec.ship(ctx, {
        prep, repairResult, dispositions, declined, verified, check, partial,
      })
      if (!shipped.pushed) return fail('ship', spec.shipFailure(shipped))
      if (partial) state.partialPushed = true
      if (partial && (!shipped.labelled || !shipped.reported)) {
        return partialFailure(spec.partialShipFailure(shipped), shipped)
      }
      if (!shipped.labelled) return fail('ship', spec.landingFailure(shipped))
      spec.shipLog(ctx, prep, declined, partial)
      return spec.result(ctx, { prep, repairResult, dispositions, declined, verified, check, partial, shipped })
    } catch (error) {
      return fail(state.phase, message(error))
    }
  }

  const result = await main()
  await statusFinish(spec.status(result), { budget: state.terminalWindow || undefined })
  process.exit(finish(result))
}
