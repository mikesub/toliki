#!/usr/bin/env node
// fix-run — judgment-conflict adapter for a finished PR (needs-judgment).
// This file owns rebase/autoresolve, conflict evidence, scripted settlement,
// partial-conflict records and publication ordering. Shared phase sequencing,
// verify retries, human/operational failure handling and RESULT are owned by
// lib/fixer-lifecycle.mjs; acceptance/correction semantics by
// lib/repair-acceptance.mjs.
//
// Prepare captures both sides' intent, marked-file diffs and main's delivered
// issue context, then lets merge-autoresolve.sh --partial settle mechanical
// hunks. A failed diff capture blocks; an unreadable issue body is explicit.
// Every judging call sees the same captured brief, not its own GitHub fetch.
//
// The resolver edits the supplied conflict text. An edit outside a marker is
// allowed only to carry a side's intent to lines the other side moved.
// Settlement checks markers, stages exactly the judgment files, continues the
// rebase once and validates the completed branch; another stop is not success.
//
// Complete verified/accepted work returns to the merge worker for fresh checks.
// Partial work retains exact PR-side text for declines and publishes its
// authenticated head-bound evidence BEFORE pushing. Automatic redispatch of
// that partial head is refused. A human-granted round after clearing both
// ladder labels consumes only those declines, while captured main is unchanged;
// a stale main holds for a human without spending the newly granted rung.
// The conflict ladder is fix-attempted then fix-retried. Trusted-evidence
// failures before a rung remove the queue instead of creating uncounted retries.
// Quota cleanup aborts an in-progress rebase and never pushes.
import { readFileSync } from 'node:fs'
import { log } from './lib/runtime.mjs'
import { HARNESS_DIR } from './lib/engine.mjs'
import { sh, failureReason } from './lib/proc.mjs'
import { authenticatedLogin, ensureLabels, editLabels, issueLabels, issueView, comment, openPrs, readBack, terminalTransition } from './lib/github.mjs'
import { git, gitOut, captureDiff, changedFiles, discoverPackages, pkgList, ensureDeps, rebaseInProgress, pushRejected, intentToAdd } from './lib/repo.mjs'
import { captureIssueRecord, captureIssueRecords } from './lib/evidence.mjs'
import { runFixerLifecycle, validateIndexedDispositions } from './lib/fixer-lifecycle.mjs'
import { ACCEPTANCE_SCHEMA, CONFIRMATION_SCHEMA, CORRECTION_SCHEMA } from './lib/repair-acceptance.mjs'
import { acceptancePrompt } from './prompts/conflict/acceptance.mjs'
import { confirmPrompt } from './prompts/conflict/confirm.mjs'
import { correctionPrompt } from './prompts/conflict/correction.mjs'
import { resolvePrompt } from './prompts/conflict/resolve.mjs'
import { resolveRetryPrompt } from './prompts/conflict/resolve-retry.mjs'

const USAGE = `Usage: fix-run.mjs --issue <N> [--session <name>] [--engine <name>] [--repo <key>]

  --issue <N>  the needs-judgment issue whose PR hit the conflict
  --session    name for log lines (the tmux session bin/launch.sh created)
  --engine     registered coding-agent engine for every phase
  --repo       registered repository key, for usage telemetry identity only

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

// How many of main's delivered issues are read into the brief. The list is
// parsed out of arbitrary commit messages, so it has no natural bound; the
// commit subjects stay complete either way, and a stop that spans more landed
// issues than this is one whose intent the subjects have to carry.
const MAX_MAIN_ISSUES = 5

// ───────────────────────── Prompts ─────────────────────────
// One MODULE per model step, under workflows/prompts/conflict/ and imported
// above. Each carries only that step's task; the standing rules are in the
// charter, the answer's shape is in the schema below, and both sides' captured
// evidence is laid out once in prompts/conflict/evidence.mjs so the resolver,
// its retry and the blind checks all read the same bytes in the same order.

// ───────────────────────── Config ─────────────────────────
// Which vendor, model and effort each step runs on is a row of the run's
// engine in etc/engines.json; every agent() call names only its step.
// fix-conflicts is the judgment core — the entire reason a model is in the
// loop — and final-review is the last gate before a rewritten merge ships to
// a force-push, so a row for either wants the strong model.

// ───────────────────────── Schemas ─────────────────────────
const RESOLVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [],
  properties: {
    completed: { type: 'boolean', description: 'true only when every marker block was resolved in the working tree and left, unstaged and uncommitted, for the pipeline to stage and continue' },
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

// Both sides of the conflict, captured before any model call: the PR side and
// the main side of exactly the marked files, the commit subjects behind main's
// side, and the issue bodies that state what each side set out to do. The
// resolver used to be handed those as `git diff` and `gh issue view` command
// lines to run for itself — which meant the adversarial check that judges its
// resolution was told to gather the same evidence separately, and neither could
// be shown to have received any of it. Diffs fail closed here; an issue body
// that cannot be read is reported inside the prompt, exactly as a failing job's
// log already is, because the resolver still has the tree and can decline.
async function captureConflictEvidence({ issue, mergeBase, prHead, markedFiles, mainIssues }) {
  const paths = [...new Set(markedFiles)]
  const selected = [...new Set(mainIssues)].slice(0, MAX_MAIN_ISSUES)
  const [prSide, mainSide, prIssue, mainIssueRecords] = await Promise.all([
    captureDiff([mergeBase, prHead], { paths }),
    captureDiff([mergeBase, 'origin/main'], { paths }),
    captureIssueRecord(issue),
    captureIssueRecords(selected),
  ])
  const commits = await git(['log', '--format=%h %s', `${mergeBase}..origin/main`])
  return {
    prSide,
    mainSide,
    mainCommits: commits.ok ? commits.out : null,
    prIssue,
    mainIssueRecords,
    omittedMainIssues: mainIssues.length - selected.length,
  }
}

async function prepare(ctx, { labels }) {
  const { issue } = ctx

  // A refusal a retry cannot fix is commented and left `failed` for a human.
  const refuseFinal = async (body, reason, transition = { add: ['failed'], remove: ['in-progress'] }) => {
    const settled = await ctx.finalizeIssue({ issue, body, ...transition })
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
    const settled = await ctx.finalizeIssue({
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
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label restoration failed (${settled.stateError})`)
    return { refused: 'current PR head is a verified partial conflict repair with a spent ladder rung', refusalFinal: true }
  }
  if (!partialRecord && labels.includes('fix-retried')) {
    return refuseFinal('🤖 fix-conflict refused: attempt ladder exhausted\nTwo fixer attempts already ran (fix-attempted + fix-retried are both on the issue). A human decides now: resolve the conflict by hand, or strip the fix-attempted and fix-retried labels to grant the fixer another round.',
      'attempt ladder exhausted (fix-retried present)')
  }

  // Attempt ladder + start signal, VERIFIED: an uncounted attempt must not run.
  const consumed = await ctx.consumeAttempt({
    labels,
    first: 'fix-attempted',
    retry: 'fix-retried',
    remove: ['failed'],
  })
  if (!consumed.recorded) {
    return { refused: 'could not record the attempt (label write failed)' }
  }
  const { attempt, rung: ladderLabel } = consumed
  const base = { attempt, branch: pr.headRefName, prUrl: pr.url, prNumber: pr.number, prHead: pr.headRefOid, actor, taskDelivery: labels.includes('task') }

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
    const markedFiles = [...new Set(judgments.map(item => item.file))]
    return {
      ...base,
      partialRecord,
      mergeBase: partialRecord.base.mergeBase,
      mainHead,
      cleanRebase: false,
      report: judgments.map(item => `${item.file}: hunk ${item.hunk}: ${item.report}`).join('\n'),
      markedFiles,
      judgmentHunks: judgments,
      mainIssues: [],
      packages,
      depLines,
      evidence: await captureConflictEvidence({
        issue, mergeBase: partialRecord.base.mergeBase, prHead: pr.headRefOid, markedFiles, mainIssues: [],
      }),
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
      const settled = await continueRebase()
      if (settled) return { ...base, mergeBase, mainIssues, report, gitBlocked: settled }
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
  // Only when there is something to resolve: a conflict that turned out clean
  // runs no resolver and no checker, so it needs no evidence brief.
  const evidence = markedFiles.length
    ? await captureConflictEvidence({ issue, mergeBase, prHead: pr.headRefOid, markedFiles, mainIssues })
    : null
  return { ...base, mergeBase, mainHead, cleanRebase, report, markedFiles, judgmentHunks: judgmentEvidence, mainIssues, packages, depLines, evidence }
}

const nonblank = value => typeof value === 'string' && value.trim().length > 0

// New runs use indexed dispositions. Legacy all-repaired payloads remain
// accepted so an interrupted run or an older engine fixture can complete the
// same safe full-repair path; they are converted only when every named hunk has
// one matching intent record.
function normalizedDispositions(result, hunks) {
  return validateIndexedDispositions(result, hunks, {
    subject: 'the resolver', itemName: 'hunk',
    missing: 'the resolver returned no indexed hunk dispositions',
    incomplete: 'the resolver did not complete the rebase',
    legacy: value => {
      if (value?.completed !== true || !Array.isArray(value.resolutions)) return null
      const dispositions = hunks.map((hunk, index) => {
        const matches = value.resolutions.filter(r => r.file === hunk.file && Number(r.hunk) === hunk.hunk)
        return matches.length === 1
          ? { index: index + 1, action: 'repaired', reason: matches[0].resolution, ...matches[0] }
          : null
      })
      return dispositions.some(value => value === null)
        ? { problem: 'the resolver returned legacy resolutions without exact coverage of every numbered judgment hunk' }
        : { dispositions }
    },
    validate: (disposition, index) => disposition.action === 'repaired' &&
      ![disposition.mainIntent, disposition.prIntent, disposition.resolution].every(nonblank)
      ? `repaired hunk disposition ${index} is missing its main intent, PR intent, or resolution`
      : null,
    decorate: (hunk, disposition, index) => ({ ...hunk, ...disposition, file: hunk.file, hunk: hunk.hunk, index }),
  })
}

// The diff3 markers git writes into a stopped rebase, as `git grep` reads them.
const MARKER_PATTERN = '^(<<<<<<<|>>>>>>>|\\|{7})( |$)'

// Continue a stopped rebase exactly once. A rebase still in progress afterwards
// is never a finished repair, so the caller blocks on it rather than measuring
// the branch — and the two ways that happens want different reasons: unmerged
// paths mean git reached a further conflicting commit, a shape this fixer does
// not own, while none mean the continuation itself refused (an empty commit, a
// bad state) and git's own first line is the useful reason.
// Returns the problem, or null.
async function continueRebase() {
  const cont = await git(['rebase', '--continue'], { env: { ...process.env, GIT_EDITOR: 'true' } })
  if (!(await rebaseInProgress())) {
    return cont.ok ? null : `git rebase --continue failed: ${failureReason(cont)}`
  }
  const unmerged = (await git(['diff', '--name-only', '--diff-filter=U'])).out
  return unmerged
    ? 'continuing the rebase stopped again on further conflicts — more than one commit conflicted, and an epic branch holds exactly one'
    : `git rebase --continue left the rebase in progress: ${`${cont.err || ''}\n${cont.out || ''}`.split('\n').find(Boolean) || failureReason(cont)}`
}

// The scripted completion of the stop the resolver edited. The model owns the
// marked text and nothing else: the orchestrator confirms no marker survived,
// stages exactly the files the resolver was allowed to touch, refuses a stop
// that still holds an unresolved path outside them, and continues the rebase
// itself — so no claim of a finished repair can carry the branch forward.
// A verification-driven retry and a human-granted continuation both amend a
// rebase that already finished, which is why the in-progress check gates this.
// Returns the first problem, or null.
async function settleResolution(markedFiles) {
  if (!(await rebaseInProgress())) return null
  const markers = await git(['grep', '-n', '-E', MARKER_PATTERN, '--', ...markedFiles])
  if (markers.ok) return `conflict markers remain in the resolved tree: ${markers.out.split('\n')[0]}`
  const staged = await git(['add', '--', ...markedFiles])
  if (!staged.ok) return `the resolved file(s) could not be staged: ${failureReason(staged)}`
  const unmerged = (await gitOut(['diff', '--name-only', '--diff-filter=U'], 'git diff --diff-filter=U')).split('\n').filter(Boolean)
  if (unmerged.length) return `the stop still holds unresolved path(s) the resolver was not given: ${unmerged.join(', ')}`
  return continueRebase()
}

// The completed branch, checked against the tree after that continuation: no
// rebase in progress, exactly one commit above origin/main, no marker left in
// the files the resolver owned. Returns the first problem, or null.
async function resolutionProblem(markedFiles) {
  if (await rebaseInProgress()) return 'the rebase is still in progress'
  const count = Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out)
  if (count !== 1) return `the rebased branch holds ${Number.isNaN(count) ? 'an unknown number of' : count} commit(s) above origin/main — an epic branch holds exactly one`
  const whitespace = await git(['diff', '--check', 'origin/main', '--', ...markedFiles])
  if (!whitespace.ok) return `the resolved tree fails git diff --check: ${whitespace.err || whitespace.out || `exit ${whitespace.code}`}`
  // Read the working tree, not only HEAD: the scripted continuation commits the
  // first resolution, while a verification-driven retry deliberately leaves its
  // amendment uncommitted for the orchestrator to inspect and fold into that
  // commit.
  const markers = await git(['grep', '-n', '-E', MARKER_PATTERN, '--', ...markedFiles])
  if (markers.ok) return `conflict markers remain in the resolved tree: ${markers.out.split('\n')[0]}`
  return null
}

function partialConflictRecord(issue, prep, dispositions, head, verifyDetail, check) {
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
async function ship(ctx, prep, body, { partial = false, dispositions = [], verifyDetail, check, corrected = null, repairRetried = false } = {}) {
  const { issue } = ctx
  // A human-granted continuation starts from an already committed partial head,
  // and either a scoped correction or a verification-driven repair retry leaves
  // working-tree edits on top of a resolution the rebase already committed.
  // All are amended into the branch's single commit before the push: verified
  // edits left in the working tree would otherwise be silently dropped.
  if (prep.partialRecord || corrected || repairRetried) {
    await gitOut(['add', '-A'], 'git add -A')
    if ((await git(['diff', '--cached', '--quiet'])).code === 0) {
      if (prep.partialRecord) return { pushed: false, labelled: false, note: 'nothing staged to amend' }
    } else {
      await gitOut(['commit', '-q', '--amend', '--no-edit'], 'git commit --amend')
    }
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
      const record = partialConflictRecord(issue, prep, dispositions, shippedHead, verifyDetail, check)
      await publishConflictPartial({ issue, actor: prep.actor, record })
    } catch (e) {
      return { pushed: false, labelled: false, note: `partial-conflict evidence could not be published and read back (${e?.message || e})` }
    }
  }
  const push = await git(['push', `--force-with-lease=refs/heads/${prep.branch}:${prep.prHead}`, 'origin', `HEAD:refs/heads/${prep.branch}`])
  if (!push.ok) return { pushed: false, labelled: false, note: pushRejected(push) ? `rejected — ${prep.branch} moved on origin under this run` : failureReason(push) }
  if (partial) {
    const settled = await ctx.finalizeIssue({
      issue,
      body: body(shippedHead),
      ...terminalTransition({ rest: 'ready-to-review', drop: ['needs-judgment'] }),
    })
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
  const budget = ctx.openTerminalBudget()
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

// A semantic dead end in the bounded repair contract takes needs-judgment OFF,
// so this guidance is a claim about labels and is composed from the verified
// readback rather than hardcoded. The ladder is deliberately untouched: the
// queue removal is what stops a relaunch, never a manufactured spent rung.
const humanHoldBody = ({ phase, reason, prUrl }, state) => {
  const repairs = [
    ...(state.missing.length ? [`set ${state.missing.join(', ')}`] : []),
    ...(state.stuck.length ? [`remove ${state.stuck.join(', ')}`] : []),
  ].join(' and ') || 'inspect the labels'
  const where = state.settled
    ? `needs-judgment has been removed and the issue rests at ${state.resting}, so dispatch cannot launch another conflict fixer at blockers this attempt already corrected once.`
    : !state.readable
    ? `The resulting labels could NOT be read back (${state.stateError}): check by hand that needs-judgment is gone and ${state.resting} is set, or dispatch may relaunch the fixer.`
    : `${state.stuck.includes('needs-judgment')
        ? 'needs-judgment could NOT be removed, so the issue may still be in the fixer queue and dispatchable'
        : 'needs-judgment has been removed, but the transition did not complete'} (${state.stateError}): ${repairs} by hand.`
  return `🤖 fix-conflict held for a human\n- phase: ${phase}\n- reason: ${reason}\n- pr: ${prUrl || 'not resolved'}\n- branch: nothing was pushed; the PR branch on origin is untouched.\n- attempt ladder: untouched — this resolution already had its one bounded correction, so no rung was spent to stop a relaunch.\n- next: ${where}\n`
}

async function cleanConflictWorktree(options) {
  const opts = () => typeof options === 'function' ? options() : options
  if (await rebaseInProgress(opts())) await git(['rebase', '--abort'], opts())
  await git(['reset', '--mixed', 'HEAD'], opts())
  await git(['checkout', '-f', '--', '.'], opts())
  await git(['clean', '-fd'], opts())
}

// ───────────────────────── The audit comment ─────────────────────────
// Composed here, in the script, from structured pieces. The resolution rewrote
// lines nobody reviewed, so the record has to name every hunk, both intents,
// and every gate that ran.
const buildComment = (prep, dispositions, verifyDetail, check, corrected, touched) => {
  const lines = []
  const declined = dispositions.filter(d => d.action === 'declined')
  lines.push(declined.length ? '🤖 fix-conflict landed a partial judgment-conflict repair' : '🤖 fix-conflict resolved a judgment rebase conflict')
  lines.push(`- pr: ${prep.prUrl}`)
  lines.push(`- attempt: ${prep.attempt}`)
  lines.push(`- source workflow: ${prep.taskDelivery ? 'lightweight task — implemented and verified, intentionally not independently reviewed' : 'epic — implemented, independently reviewed and verified'}`)
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
    lines.push(`An exhaustive acceptance check examined every repaired hunk, confirmed every declined hunk retained its PR-side text, and returned ${check.blockers.length} blocker(s) (confidence floor ${check.confidence}/100).`)
    if (corrected) {
      lines.push('')
      lines.push('One scoped correction ran inside this same attempt over the complete blocker batch — no second fixer was launched and no ladder rung was spent on it:')
      for (const item of corrected.dispositions) lines.push(`- ${item.id}: ${item.action} — ${item.reason}`)
      lines.push(`Its edits are part of the amended commit. A narrow independent confirmation then proved every blocker cleared, both sides' intent intact, with no regression or unrelated change (confidence ${corrected.confirmation.confidence}/100).`)
    }
    lines.push('')
    // Derived by the orchestrator from the resolution's own delta, not reported
    // by the resolver: an out-of-block edit that carries a side's intent lands
    // in a file the per-hunk list above cannot show on its own.
    lines.push(`files changed: ${touched === null ? 'could not be derived' : touched.length ? touched.join(', ') : 'none'}`)
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

await runFixerLifecycle({
  scriptName: 'fix-run',
  usage: USAGE,
  phases: ['Prepare', 'Resolve', 'Verify', 'Check', 'Ship'],
  queue: {
    label: 'needs-judgment',
    missing: issue => `issue #${issue} is not labelled needs-judgment — not a fixer's issue`,
  },
  prepare,
  prepared: async (ctx, prep) => {
    // An empty package list would turn verification of a rewritten merge into
    // a silent no-op, so discovery remains a hard pre-model gate.
    const packages = Array.isArray(prep.packages) ? prep.packages : []
    if (!packages.length) throw new Error('layout discovery found no package declaring an `npm run verify` script — refusing to ship a resolution nothing would verify.')
    const marked = Array.isArray(prep.markedFiles) ? prep.markedFiles : []
    log(prep.partialRecord
      ? `Prepare: attempt ${ctx.attempt} on PR ${prep.prUrl} — authenticated partial record selected ${prep.judgmentHunks.length} previously declined hunk(s); captured origin/main is unchanged. Packages: ${pkgList(packages)}.`
      : prep.cleanRebase
      ? `Prepare: attempt ${ctx.attempt} on PR ${prep.prUrl} — rebase onto origin/main was CLEAN (the conflict evaporated).`
      : `Prepare: attempt ${ctx.attempt} on PR ${prep.prUrl} — mechanical hunks settled, ${marked.length} file(s) left for judgment${marked.length ? ` (${marked.join(', ')})` : ''}. Packages: ${pkgList(packages)}.`)
  },
  repair: {
    needed: prep => Array.isArray(prep.markedFiles) && prep.markedFiles.length > 0,
    key: 'resolve', phase: 'Resolve',
    prompt: (ctx, prep, { retry } = {}) => retry && !prep.partialRecord
      ? resolveRetryPrompt(ctx.issue, prep)
      : resolvePrompt(ctx.issue, prep),
    agent: { label: 'resolve', phase: 'Resolve', step: 'fix-conflicts', schema: RESOLVE_SCHEMA },
    noResult: 'the resolver produced no result — the rebase is aborted for a clean retry.',
    normalize: (result, prep) => normalizedDispositions(result, prep.judgmentHunks),
    allDeclined: declined => `the resolver declined every judgment hunk: ${declined.map(d => `${d.file} hunk ${d.hunk}: ${d.reason}`).join('; ')}`,
    // Marker check, staging and rebase continuation are the orchestrator's, and
    // they run only after every hunk has a disposition and at least one repair:
    // a round that declined everything leaves the stop for the abort in cleanup.
    settle: (_ctx, prep) => settleResolution(prep.markedFiles),
    treeProblem: async (_ctx, prep) => {
      if (prep.partialRecord) return (await gitOut(['status', '--porcelain'], 'git status'))
        ? null
        : 'the resolver reported a repaired prior decline but changed no file'
      const problem = await resolutionProblem(prep.markedFiles)
      return problem ? `the settled resolution is not shippable: ${problem}.` : null
    },
    log: (_ctx, prep, _result, repaired, declined) => log(prep.partialRecord
      ? `Resolve: ${repaired.length} previously declined hunk(s) repaired, ${declined.length} still declined; working-tree delta ready for verification.`
      : `Resolve: ${repaired.length} judgment hunk(s) repaired, ${declined.length} declined; the pipeline staged the resolution and the rebase is finished.`),
  },
  verify: {
    packages: prep => prep.packages,
    log: (_ctx, _prep, verified) => { if (verified.green) log(`Verify: green — ${verified.detail}`) },
    failure: (_prep, verified) => `npm run verify is red after the resolution (${verified.detail}) — nothing was pushed and the PR branch is untouched.`,
  },
  check: {
    needed: prep => Array.isArray(prep.markedFiles) && prep.markedFiles.length > 0,
    // Captured HERE, not gathered by the checker: a judging step has no shell
    // under Claude and only a read-only sandbox under Codex, and evidence a step
    // fetched for itself is evidence nothing proved it received. A continuation
    // is measured from the pushed partial head; an ordinary resolution from
    // origin/main, which is also where an unpushed correction shows up. The
    // intent-add puts a file the correction created inside the delta.
    delta: async (_ctx, prep) => {
      await intentToAdd()
      return captureDiff([prep.partialRecord ? prep.prHead : 'origin/main'])
    },
    prompt: (ctx, prep, dispositions, { cumulative }) => acceptancePrompt(ctx.issue, prep, dispositions, cumulative),
    agent: { label: 'acceptance', phase: 'Check', step: 'final-review', schema: ACCEPTANCE_SCHEMA },
    noResult: 'the acceptance check produced no result — an unchecked resolution must not ship.',
    log: (_ctx, _prep, check) => log(`Check: acceptance ${check.outcome} — ${check.blockers.length} blocker(s), confidence floor ${check.confidence}.`),
    correction: {
      prompt: (ctx, prep, dispositions, evidence) => correctionPrompt(ctx.issue, prep, dispositions, evidence),
      agent: { label: 'correction', phase: 'Check', step: 'fix-conflicts', schema: CORRECTION_SCHEMA },
      noResult: 'the scoped correction produced no result — nothing was pushed and the PR branch is untouched.',
    },
    confirm: {
      prompt: (ctx, prep, _dispositions, evidence) => confirmPrompt(ctx.issue, prep, evidence),
      agent: { label: 'narrow-confirm', phase: 'Check', step: 'final-review', schema: CONFIRMATION_SCHEMA },
      noResult: 'the narrow confirmation produced no result — an unconfirmed correction must not ship.',
    },
  },
  ship: async (ctx, { prep, dispositions, verified, check, corrected, partial, repairRetried }) => {
    // Captured before the amend, from the same base the checked delta used, so
    // the audit record names what the resolution actually touched.
    const touched = await changedFiles([prep.partialRecord ? prep.prHead : 'origin/main'])
    return ship(
      ctx, prep, () => buildComment(prep, dispositions, verified.detail, check, corrected, touched),
      { partial, dispositions, verifyDetail: verified.detail, check, corrected, repairRetried })
  },
  shipFailure: shipped => `the force-with-lease push did not land${shipped.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`,
  partialShipFailure: shipped => `the partial repair was pushed, but its human-held landing could not be fully verified${shipped.note ? ` (${shipped.note})` : ''}`,
  landingFailure: shipped => `pushed, but the ready-to-merge label swap could not be verified${shipped.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed and rebased.`,
  shipLog: (_ctx, prep, declined, partial) => log(partial
    ? `Ship: partial repair pushed and held for review — ${declined.map(d => `${d.file} hunk ${d.hunk}: ${d.reason}`).join('; ')}`
    : `Ship: pushed and labelled ready-to-merge — ${prep.prUrl}`),
  result: (ctx, { prep, dispositions, declined, verified, check, corrected, partial }) => ({
    issue: ctx.issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt: ctx.attempt,
    cleanRebase: !!prep.cleanRebase,
    resolvedHunks: dispositions.filter(d => d.action === 'repaired').length,
    declinedHunks: declined.map(d => ({ file: d.file, hunk: d.hunk, reason: d.reason })),
    checkConfidence: check ? check.confidence : null,
    correctedBlockers: corrected ? corrected.dispositions.map(d => d.id) : [],
    verify: verified.detail,
    ...(partial ? { readyToReview: true } : { readyToMerge: true }),
  }),
  cleanup: (_ctx, options) => cleanConflictWorktree(options),
  attemptRung,
  quota: (_ctx, rung) => ({
    hold: { add: ['failed'], remove: ['in-progress', rung], required: ['failed', 'needs-judgment'] },
    blocked: { add: ['failed'], remove: ['in-progress'], required: ['failed', 'needs-judgment'] },
  }),
  blocker: {
    transition: () => terminalTransition({ rest: 'failed', queue: ['needs-judgment'] }),
    body: (ctx, { phase, reason }, state) => blockerBody({ phase, reason, prUrl: ctx.prUrl, attempt: ctx.attempt }, state),
  },
  // Semantic, not operational: the resolution was judged and could not be made
  // right inside its one correction, so the queue comes off rather than being
  // restored for another complete fixer.
  humanHold: {
    transition: () => terminalTransition({ rest: 'failed', drop: ['needs-judgment'] }),
    body: (ctx, { phase, reason }, state) => humanHoldBody({ phase, reason, prUrl: ctx.prUrl }, state),
  },
  partialFailure: async (ctx, reason, { labelled }) => {
    if (labelled) return log(`blocked after partial push: ${reason}`)
    const settled = await ctx.finalizeIssue({
      issue: ctx.issue,
      body: state => blockerBody({ phase: 'ship', reason, prUrl: ctx.prUrl, attempt: ctx.attempt }, state),
      ...terminalTransition({ rest: 'failed', drop: ['needs-judgment'] }),
      budget: ctx.terminalWindow || ctx.openTerminalBudget(),
    })
    if (!settled.reported) log(`blocked: GitHub report failed (${settled.reportError})`)
    if (!settled.settled) log(`blocked: terminal label quarantine failed (${settled.stateError})`)
  },
  status: result => result?.held ? `**held**: provider quota exhausted, resumes after ${result.holdUntil} — vendor: ${result.vendor}; provider reason: "${result.reason}"` : result?.blocked ? `**blocked** at ${result.phase}: ${result.reason}` : result?.skipped ? `**skipped**: ${result.reason}` : result?.readyToMerge ? `**done** — ${result.prUrl} is back to ready-to-merge` : result?.readyToReview ? `**done, held for review** — ${result.prUrl}; declined: ${result.declinedHunks.map(d => `${d.file} hunk ${d.hunk}: ${d.reason}`).join('; ')}` : '**finished**',
})
