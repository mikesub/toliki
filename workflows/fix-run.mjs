#!/usr/bin/env node
// fix-run — judgment-conflict fixer for a finished epic PR (dispatch launches
// it for `needs-judgment` issues; `--issue N` is the only argument).
//
// Rebases the PR onto current origin/main, lets the deterministic rung settle
// every mechanical hunk (merge-autoresolve.sh --partial, containment-gated),
// has a model resolve ONLY the hunks left marked — stating what each side
// intended and how both survive, escalating instead of guessing — re-runs
// npm run verify, has a blind adversarial agent try to refute the resolution,
// force-pushes, and lands the issue ready-to-review, never ready-to-merge.
// Attempt ladder in labels: fix-attempted, then fix-retried (one retry);
// exhausted → refuses and stays failed.
//
// Two model steps: the resolver and its skeptic. Everything else — the gates,
// the ladder write, the rebase, the partial autoresolve, verify, the push, the
// audit comment, the labels — is the orchestrator's own work through
// lib/github.mjs and lib/repo.mjs, so what got pushed and what got labelled is
// a fact this script established, not a claim a model reported.

import { agent, phase, log, initRuntime, onPhase, onLog, withAgentFailure } from './lib/runtime.mjs'
import { HARNESS_DIR } from './lib/engine.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'
import { sh, must, failureReason } from './lib/proc.mjs'
import { ensureLabels, editLabels, issueLabels, issueView, comment, openPrs } from './lib/github.mjs'
import { git, gitOut, discoverPackages, pkgList, ensureDeps, runVerify, rebaseInProgress, pushRejected } from './lib/repo.mjs'
import { finalizeFixerIssue } from './lib/fixer-finalize.mjs'

const USAGE = `Usage: fix-run.mjs --issue <N> [--session <name>] [--engine <name>]

  --issue <N>  the needs-judgment issue whose PR hit the conflict
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase

Exit: 0 fixed, 1 usage/crash, 2 skipped, 3 blocked.
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
// stated intents and survive an adversarial check, verify must be green, and
// the landing is ready-to-review — a human glances, but the work is done.

// The deterministic rung, by absolute path. Resolved from this file's own
// location: the orchestrator knows where the harness is.
const AUTORESOLVE = `${HARNESS_DIR}/bin/merge-autoresolve.sh`

// ───────────────────────── Prompts ─────────────────────────
const PROMPTS = {
  // The judgment core — the one stage that exists because a model is needed.
  // It gets the same evidence a human would open: both sides' diffs and both
  // sides' issue bodies. Its charter is narrow: only the marked hunks, both
  // intents stated and preserved, escalate instead of guessing.
  resolve: (issue, prep) =>
`Resolve the JUDGMENT hunks of a rebase conflict. You are mid-rebase: the PR branch ${prep.branch} (issue #${issue}) is being rebased onto origin/main, and the stop is partially settled — every mechanical hunk was already resolved by a containment-gated script and is NOT yours to touch. Yours are exactly the diff3 marker blocks still sitting in: ${prep.markedFiles.join(', ')}.

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

**Escalate instead of guessing.** If for ANY hunk you cannot honestly state both intents and show both surviving — the two sides genuinely contradict, or the evidence does not say what a side meant — resolve NOTHING further, return escalate="<file> hunk <n>: <why both intents cannot both survive>". A \`failed\` label is recoverable; a silently dropped intent is not.

Boundaries: edit ONLY between and including marker lines, ONLY in the files listed above; never revisit the mechanical resolutions or any other file; never commit anything new; never push.

When every block is resolved: confirm no markers remain (\`git diff --check\` and \`grep -n '^<<<<<<<\\|^>>>>>>>' <files>\` must be clean), \`git add\` exactly those files, \`GIT_EDITOR=true git rebase --continue\`. Then confirm the rebase fully finished (\`git status\` shows no rebase in progress; \`git rev-list --count origin/main..HEAD\` is exactly 1 — if a second stop appears, escalate="rebase stopped again — an epic branch holds exactly one commit" instead of resolving further). The pipeline checks all of that again before anything ships.

Return: completed (true only when the rebase finished clean), escalate (INSTEAD of completing, when set), and resolutions — one entry per marker block you resolved: file, hunk number (as the classification above numbers them), mainIntent, prIntent, resolution (one sentence: what the merged text does and how it keeps both).`,

  // Blind on purpose, and refute-by-default on purpose: this is the same
  // adversarial shape as epic-run's review verify — the resolver's stated
  // intents are deliberately NOT in this prompt, so agreement can only come
  // from the code, not from reading the resolver's reasoning.
  check: (issue, prep) =>
`Adversarially check a rebase-conflict resolution you did not write. The PR branch ${prep.branch} (issue #${issue}) was rebased onto origin/main; the rebase stopped on judgment-class conflict hunks in: ${prep.markedFiles.join(', ')}. Something resolved them, the rebase completed, and HEAD now carries the result. Your job is to REFUTE the claim: "in every one of those hunks, both what origin/main changed and what the PR changed survive."

The machine classification of the stop's hunks (the mechanical ones were settled by a containment-gated script and are not in question — judge the "needs judgment" ones):
${prep.report}

Gather the evidence yourself:
- What the PR meant to change: \`git diff ${prep.mergeBase} ${prep.prHead} -- <the files>\`, and issue #${issue} (\`gh issue view ${issue} --json title,body\`).
- What main meant to change: \`git diff ${prep.mergeBase} origin/main -- <the files>\`${prep.mainIssues.length ? `, and the issues those commits delivered: ${prep.mainIssues.map(n => '#' + n).join(', ')}` : ''}.
- What actually shipped: \`git diff origin/main HEAD -- <the files>\` and the files at HEAD.
Do NOT open anything under \`.epics/\` — it carries a builder's framing and would anchor you.

Hunt specifically for: a side's change silently dropped (picking a side is the classic failure, and often no test covers the loss); duplicate object keys, doubled imports or re-declared symbols from a lazy keep-both; an edit placed at the wrong spot so the code runs in a changed order; one side's rename or retype applied in the hunk but not to the lines the other side contributed.

Default to refuted: if you cannot positively confirm, from the code in front of you, that both sides' intents survive, say survives=false. An over-cautious refute costs one human review; a wrong pass ships a silently mangled merge.

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
  required: ['completed'],
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
        },
      },
    },
  },
}
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['survives', 'confidence', 'reasoning'],
  properties: {
    survives: { type: 'boolean', description: 'true only if both sides\' intents demonstrably survive in every judgment hunk' },
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
async function prepare(issue) {
  const view = await issueView(issue, 'state,labels,title')
  const labels = Array.isArray(view.labels) ? view.labels.map(l => l.name) : []
  if (String(view.state || '').toUpperCase() === 'CLOSED') return { refused: `issue #${issue} is closed` }
  if (!labels.includes('needs-judgment')) return { refused: `issue #${issue} is not labelled needs-judgment — not a fixer's issue` }

  // A refusal a retry cannot fix is commented and left `failed` for a human.
  const refuseFinal = async (body, reason) => {
    const settled = await finalizeFixerIssue({ issue, body, add: ['failed'], remove: ['in-progress'] })
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
    return { refused: reason, refusalFinal: true }
  }
  if (labels.includes('fix-retried')) {
    return refuseFinal('🤖 fix-conflict refused: attempt ladder exhausted\nTwo fixer attempts already ran (fix-attempted + fix-retried are both on the issue). A human decides now: resolve the conflict by hand, or strip the fix-attempted and fix-retried labels to grant the fixer another round.',
      'attempt ladder exhausted (fix-retried present)')
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

  // Attempt ladder + start signal, VERIFIED: an uncounted attempt must not run.
  const attempt = labels.includes('fix-attempted') ? 2 : 1
  const ladderLabel = attempt === 2 ? 'fix-retried' : 'fix-attempted'
  await ensureLabels(['fix-attempted', 'fix-retried', 'in-progress'])
  await editLabels(issue, { add: ['in-progress', ladderLabel], remove: ['failed'] })
  const now = await issueLabels(issue)
  if (!now.includes('in-progress') || !now.includes(ladderLabel) || now.includes('failed')) {
    return { refused: 'could not record the attempt (label write failed)' }
  }
  const base = { attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number, prHead: pr.headRefOid }

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

  const packages = discoverPackages('.')
  // Either side may have moved the lockfile; a stale install makes the gate lie.
  const depLines = packages.length ? await ensureDeps(packages, { pairs: [[mergeBase, 'HEAD'], [mergeBase, 'origin/main']] }) : []
  return { ...base, mergeBase, cleanRebase, report, markedFiles, mainIssues, packages, depLines }
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

// Push, record, relabel. Pinned to the exact head this run inspected, so if ANYTHING else moved the
// branch the push is rejected and nothing further happens.
async function ship(issue, prep, body) {
  const push = await git(['push', `--force-with-lease=refs/heads/${prep.branch}:${prep.prHead}`, 'origin', `HEAD:refs/heads/${prep.branch}`])
  if (!push.ok) return { pushed: false, labelled: false, note: pushRejected(push) ? `rejected — ${prep.branch} moved on origin under this run` : failureReason(push) }
  // The resolution rewrote lines nobody reviewed, so the audit trail lives where a human will look.
  await comment(issue, body)
  // ready-to-review, NEVER ready-to-merge: a rewritten resolution needs a human glance before it may
  // merge unattended. The ladder labels stay: the ladder deliberately does not reset.
  await ensureLabels(['ready-to-review'])
  const flip = await editLabels(issue, { add: ['ready-to-review'], remove: ['in-progress', 'needs-judgment'] })
  let labels
  try {
    labels = await issueLabels(issue)
  } catch (e) {
    return { pushed: true, labelled: false, note: e && e.message || String(e) }
  }
  const labelled = labels.includes('ready-to-review') && !labels.includes('in-progress') && !labels.includes('needs-judgment')
  return { pushed: true, labelled, note: labelled ? '' : (flip.ok ? `observed labels: ${labels.join(', ')}` : failureReason(flip)) }
}

// What happens next is the LADDER's call, never the phase's — so it is a
// field of the block (`- next:`), not a paragraph after it. #272 shipped it
// as a trailing paragraph, the agent read that as narration and dropped it,
// and the operator saw a first-attempt decline with no notice that a retry
// was already queued. Keep every disposition claim inside the block; a
// `reason` string states what broke, never who picks it up.
async function postBlocker({ issue, phase, reason, prUrl, attempt }) {
  // The worktree must not be left mid-rebase for the next run to trip over.
  if (await rebaseInProgress()) await git(['rebase', '--abort'])
  const ladder = attempt >= 2
    ? 'This was the RETRY (fix-attempted and fix-retried are both on the issue), so the fixer is done with it: resolve by hand, or strip the two fix-* labels to grant another round.'
    : attempt === 1
    ? 'This was the first attempt (fix-attempted is on the issue), so dispatch relaunches the fixer once, automatically, a few minutes after this session is reaped. Nothing to do unless the retry also fails.'
    : 'The attempt ladder was not reached, so dispatch will relaunch the fixer on its next tick.'
  // needs-judgment keeps the issue in the fixer queue and the ladder labels bound the retries; both stay.
  const settled = await finalizeFixerIssue({
    issue,
    body: `🤖 fix-conflict blocked\n- phase: ${phase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- next: ${ladder}\n`,
    add: ['failed'],
    remove: ['in-progress'],
  })
  if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
  if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
}

// ───────────────────────── Blocker path ─────────────────────────
// Same shape as epic-run's fail(): comment the blocker, restore the terminal
// label, return a structured block. blockerPosted guards re-entry when the
// outer catch fires after a phase that already failed.
let currentPhase = 'prepare'
let blockerPosted = false
let prUrl = null
let attempt = 0
async function fail(phase, reason) {
  reason = withAgentFailure(reason)
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
const buildComment = (prep, resolutions, verifyDetail, check) => {
  const lines = []
  lines.push('🤖 fix-conflict resolved a judgment rebase conflict')
  lines.push(`- pr: ${prep.prUrl}`)
  lines.push(`- attempt: ${prep.attempt}`)
  lines.push('')
  if (prep.cleanRebase) {
    lines.push('By the time this run rebased, the conflict had evaporated — origin/main had moved past the decline. The rebase was clean; no judgment was exercised.')
  } else if (!resolutions.length) {
    lines.push('By the time this run rebased, every hunk had turned mechanical — origin/main had moved past the judgment decline. The deterministic rung settled them all under its containment gate; no judgment was exercised:')
    lines.push('')
    lines.push(String(prep.report || "").trim().split('\n').map(l => `- ${l}`).join('\n'))
  } else {
    lines.push('Rebasing onto origin/main conflicted. The mechanical hunks were settled by the deterministic rung under its containment gate; the judgment hunks were resolved by this fixer session:')
    lines.push('')
    lines.push(String(prep.report || "").trim().split('\n').map(l => `- ${l}`).join('\n'))
    lines.push('')
    lines.push('Each judgment resolution, with both sides\' intents:')
    for (const r of resolutions) {
      lines.push(`- ${r.file} hunk ${r.hunk}:`)
      lines.push(`  - origin/main intended: ${r.mainIntent}`)
      lines.push(`  - the PR intended: ${r.prIntent}`)
      lines.push(`  - resolution: ${r.resolution}`)
    }
    lines.push('')
    lines.push(`An adversarial check, blind to this session's reasoning, tried to refute "both intents survived" and failed to (confidence ${check.confidence}/100).`)
  }
  lines.push('')
  lines.push(`verify: ${verifyDetail}`)
  lines.push('')
  lines.push('The branch is rebased and force-pushed; the issue is ready-to-review. Promoting to ready-to-merge is a human\'s call — the merge worker re-runs CI on the true base before anything lands.')
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
  log(prep.cleanRebase
    ? `Prepare: attempt ${attempt} on PR ${prep.prUrl} — rebase onto origin/main was CLEAN (the conflict evaporated).`
    : `Prepare: attempt ${attempt} on PR ${prep.prUrl} — mechanical hunks settled, ${marked.length} file(s) left for judgment${marked.length ? ` (${marked.join(', ')})` : ''}. Packages: ${pkgList(packages)}.`)

  // ───────────────────────── Resolve (judgment hunks only) ─────────────────────────
  let resolutions = []
  if (marked.length) {
    currentPhase = 'resolve'
    phase('Resolve')
    const res = await agent(PROMPTS.resolve(issue, prep),
      { label: 'resolve', phase: 'Resolve', step: 'fix-conflicts', schema: RESOLVE_SCHEMA })
    if (!res) return await fail('resolve', 'the resolver produced no result — the rebase is aborted for a clean retry.')
    if (res.escalate) return await fail('resolve', `escalated rather than guessed: ${res.escalate}`)
    if (!res.completed) return await fail('resolve', 'the resolver did not complete the rebase.')
    resolutions = Array.isArray(res.resolutions) ? res.resolutions : []
    // "States what each side intended and shows both surviving" is the
    // contract, not decoration — a resolution without its intent record is
    // unauditable and the adversarial check below would be its only witness.
    if (!resolutions.length) {
      return await fail('resolve', 'the resolver reported completion but returned no per-hunk intent statements — refusing to ship an unauditable resolution.')
    }
    // The claim of completion, checked against the tree.
    const problem = await resolutionProblem(marked)
    if (problem) return await fail('resolve', `the resolver reported completion but ${problem}.`)
    log(`Resolve: ${resolutions.length} judgment hunk(s) resolved with stated intents; rebase finished clean.`)
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
    check = await agent(PROMPTS.check(issue, prep),
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
  const shipped = await ship(issue, prep, buildComment(prep, resolutions, v.detail, check))
  if (!shipped.pushed) {
    return await fail('ship', `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`)
  }
  if (!shipped.labelled) {
    // Fail closed on the label half too: pushed-but-unlabelled would leave a
    // fixed PR on an issue reap reads as "still working" — a leaked slot and
    // an invisible success. failed + the blocker comment puts a human on it.
    return await fail('ship', `pushed, but the ready-to-review label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed and rebased.`)
  }
  log(`Ship: pushed and labelled ready-to-review — ${prep.prUrl}`)

  return {
    issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt,
    cleanRebase: !!prep.cleanRebase,
    resolvedHunks: resolutions.length,
    checkConfidence: check ? check.confidence : null,
    verify: v.detail,
    readyToReview: true,
  }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

const RESULT = await main()
// Best effort, and awaited so the edit lands before the process goes: this is the
// last thing the issue page will show until a human or the merge worker acts.
await statusFinish(RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToReview ? `**done** — ${RESULT.prUrl} is ready-to-review` : '**finished**')
process.exit(finish(RESULT))
