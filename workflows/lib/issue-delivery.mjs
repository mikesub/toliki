// Shared safety-critical transport for issue-to-PR workflows. Epic and task
// runs differ in model judgment, never in how they claim work, pin an engine,
// form the one candidate commit, preserve failures, or hand work to merge.

import { failureReason, must } from './proc.mjs'
import {
  ensureLabels, editLabels, issueLabels, issueView, openBlockers, assignSelf,
  openPrs, searchOpenPrs, prCreate, withBodyFile, readBack,
  terminalBudget, terminalSpend, terminalTransition, verifyIssueEngine,
} from './github.mjs'
import {
  git, gitOut, discoverPackages, ensureDeps, ensureEpicsIgnored, pushRejected,
  slugify, epicDir, writeRequirements, readRequirements, initEpicMd, updateEpicMd, rebaseInProgress,
} from './repo.mjs'
import { loadResumeRecoveryEvidence, startResumeRecovery } from './resume-recovery.mjs'
import { recordQuotaHold } from '../quota-hold.mjs'

export const ISSUE_LIFECYCLE = ['in-progress', 'ready-to-merge', 'ready-to-review', 'failed', 'needs-defect-fix']

// Package parsing and dependency installation must happen only after a resume
// conflict is settled. package.json and lockfiles may themselves be unmerged;
// reading either side of that stop would make the later verify gate describe a
// tree that never became the candidate.
export async function finishIssuePreparation(prep) {
  const packages = discoverPackages('.')
  const depLines = packages.length ? await ensureDeps(packages, { pairs: [[prep.worktreeBase, 'HEAD']] }) : []
  return { ...prep, packages, depLines }
}

// The remote ref is the cross-host claim. Existing epic/<N>-* branches are
// resumed so task deliveries remain visible to reap, fixers and PR discovery.
export async function prepareIssueDelivery({ issue, engine, lifecycle = ISSUE_LIFECYCLE }) {
  const notes = []
  const view = await issueView(issue, 'number,title,body,state')
  if (String(view.state || '').toUpperCase() === 'CLOSED') return { refused: `issue #${issue} is closed` }

  const deps = await openBlockers(issue)
  if (deps.error) return { refused: `the blocked_by dependency check could not be read (${deps.error}) — refusing to build as if unblocked` }
  if (deps.blockers.length) return { refused: `blocked by open issue(s) ${deps.blockers.map(n => `#${n}`).join(', ')}` }

  const fetched = await git(['fetch', 'origin'])
  if (!fetched.ok) return { refused: `git fetch origin failed (${failureReason(fetched)}) — refusing to build against an unconfirmed base` }
  const base = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')

  const prefix = `epic/${issue}-`
  const delivering = (await openPrs('number,headRefName')).find(p => String(p.headRefName || '').startsWith(prefix))
  if (delivering) return { alreadyExists: true, note: `an open PR already delivers this issue (PR #${delivering.number})` }
  const legacy = await searchOpenPrs(`Closes #${issue} in:body`)
  if (legacy.length) return { alreadyExists: true, note: `an open PR already delivers this issue (PR #${legacy[0].number})` }

  const local = (await gitOut(['branch', '--list', `${prefix}*`, '--format=%(refname:short)'], 'git branch --list'))
    .split('\n').map(s => s.trim()).filter(Boolean)
  const remote = (await gitOut(['ls-remote', '--heads', 'origin', `${prefix}*`], 'git ls-remote'))
    .split('\n').map(l => l.trim().split(/\s+/)[1]).filter(Boolean).map(r => r.replace(/^refs\/heads\//, ''))
  let branch = local[0] || remote[0] || null
  let slug
  let resumed = false
  let codeDone = false
  let partialWork = false
  let resumeRecovery = null
  let resumeRecoveryError = null
  if (branch) {
    slug = branch.slice('epic/'.length)
    let switched
    if (local.includes(branch)) {
      // Route persistence is a prerequisite for adopting or changing an
      // interrupted branch. Check it before switching, checkpointing a dirty
      // local tree, flattening commits, or starting any writable process.
      await verifyIssueEngine(issue, engine, { allowCreate: false })
      switched = await git(['switch', branch])
    } else {
      await gitOut(['fetch', 'origin', branch], `git fetch origin ${branch}`)
      const subjects = (await gitOut(['log', '--format=%s', 'origin/main..FETCH_HEAD'], 'git log')).split('\n').filter(Boolean)
      if (subjects.length && subjects.every(s => s.startsWith(`chore(epic ${issue}): claim`))) return { refused: 'claimed by another run' }
      await verifyIssueEngine(issue, engine, { allowCreate: false })
      switched = await git(['switch', '-c', branch, '--track', `origin/${branch}`])
    }
    if (!switched.ok) {
      if (/already (checked out|used by worktree)/i.test(`${switched.err}\n${switched.out}`)) {
        return { refused: `${branch} is checked out in another worktree — a run may be live there` }
      }
      must(switched, `git switch ${branch}`)
    }
    if (await gitOut(['status', '--porcelain'], 'git status')) {
      await gitOut(['add', '-A'], 'git add -A')
      if ((await git(['diff', '--cached', '--quiet'])).code !== 0) {
        await gitOut(['commit', '-q', '-m', `wip(epic ${slug}): resume checkpoint`], 'git commit (resume checkpoint)')
      }
    }
    const savedHead = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse saved branch head')
    const mainHead = await gitOut(['rev-parse', 'origin/main'], 'git rev-parse origin/main')
    const subjects = (await gitOut(['log', '--format=%s', `${mainHead}..${savedHead}`], 'git log')).split('\n')
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    codeDone = subjects.some(s => new RegExp(`^wip\\(epic ${escaped}\\): (code|triage) checkpoint$`).test(s.trim()))
    partialWork = !codeDone && subjects.some(s => s.trim() && !s.startsWith(`chore(epic ${issue}): claim`))
    // A prior invocation may already have integrated an interrupted chain and
    // then checkpointed a later failure. Recover its reachable main-side
    // review context before rebasing or starting another writable process.
    const retainedRecovery = await loadResumeRecoveryEvidence({ issue, slug, branch, currentMainHead: mainHead, codeDone })

    const rebased = await git(['rebase', mainHead])
    if (!rebased.ok) {
      const aborted = await git(['rebase', '--abort'])
      if (!aborted.ok || await rebaseInProgress()) {
        resumeRecoveryError = `the initial resume rebase conflicted and could not be aborted cleanly (${failureReason(aborted)})`
        resumeRecovery = { issue, slug, branch, savedHead, mainHead, integrated: false, markedFiles: [] }
      } else {
        try {
          resumeRecovery = await startResumeRecovery({ issue, slug, branch, savedHead, mainHead, codeDone, priorRecovery: retainedRecovery })
        } catch (error) {
          resumeRecoveryError = error?.message || String(error)
          resumeRecovery = { issue, slug, branch, savedHead, mainHead, integrated: false, markedFiles: [] }
        }
      }
    } else if (retainedRecovery) {
      resumeRecovery = retainedRecovery
    }
    resumed = true
  } else {
    slug = slugify(issue, view.title)
    branch = `epic/${slug}`
    await gitOut(['switch', '-c', branch, 'origin/main'], `git switch -c ${branch} origin/main`)
    await gitOut(['commit', '--allow-empty', '-q', '-m', `chore(epic ${issue}): claim ${Math.floor(Date.now() / 1000)}-${process.pid}`], 'git commit (claim)')
    const pushed = await git(['push', 'origin', `HEAD:refs/heads/${branch}`])
    if (!pushed.ok) {
      if (pushRejected(pushed)) return { refused: 'claimed by another run' }
      must(pushed, 'git push (claim)')
    }
    await verifyIssueEngine(issue, engine, { allowCreate: true })
  }

  await ensureLabels(lifecycle)
  const swap = await editLabels(issue, { add: ['in-progress'], remove: ['ready', 'ready-to-merge', 'ready-to-review', 'failed', 'needs-defect-fix'] })
  if (!swap.ok) notes.push(`prepare: label swap failed: ${failureReason(swap)}`)
  const assigned = await assignSelf(issue)
  if (!assigned.ok) notes.push(`prepare: self-assign failed: ${failureReason(assigned)}`)

  const dir = epicDir(slug)
  await ensureEpicsIgnored()
  writeRequirements(dir, issue, view.body)
  initEpicMd(dir, { title: view.title, slug, issue })
  for (const note of notes) updateEpicMd(dir, { log: note })
  const prepared = {
    slug, branch, resumed, codeDone, partialWork,
    requirement: readRequirements(dir),
    requirementTitle: String(view.title || ''),
    requirementBody: String(view.body || ''),
    worktreeBase: base,
    resumeRecovery,
    resumeRecoveryError,
  }
  return resumeRecovery && !resumeRecovery.integrated || resumeRecoveryError
    ? { ...prepared, packages: null, depLines: [] }
    : finishIssuePreparation(prepared)
}

export function renderIssuePrBody({ issue, prefix = 'Specification and run record', detail = '', legalMarker = '' }) {
  const pointer = `${prefix}: #${issue}.${detail ? ` ${detail}` : ''}`
  return [pointer, legalMarker, `Closes #${issue}`].filter(Boolean).join('\n\n') + '\n'
}

export async function createIssueCandidate({ issue, slug, decision, body }) {
  const branch = `epic/${slug}`
  const title = String(decision.title || '').trim().split('\n')[0]
  if (!title) throw new Error('delivery returned no PR title')
  const commitBody = String(decision.commitBody || '').trim()
  if (!commitBody) throw new Error('delivery returned no commit rationale')

  await gitOut(['add', '-A'], 'git add -A')
  if ((await git(['diff', '--cached', '--quiet'])).code !== 0) {
    await gitOut(['commit', '-q', '-m', `wip(epic ${slug}): pre-ship`], 'git commit (pre-ship)')
  }
  const mergeBase = await gitOut(['merge-base', 'HEAD', 'origin/main'], 'git merge-base')
  await gitOut(['reset', '--soft', mergeBase], 'git reset --soft')
  if ((await git(['diff', '--cached', '--quiet'])).code === 0) throw new Error('nothing to ship — the branch holds no change against origin/main')
  const message = [title, '', commitBody, decision.legalMarker ? `\n${decision.legalMarker}` : '', '', `Closes #${issue}`]
    .join('\n').replace(/\n{3,}/g, '\n\n')
  await withBodyFile(message, file => gitOut(['commit', '-q', '-F', file], 'git commit (squash)'))

  const pushed = await git(['push', '--force-with-lease', '-u', 'origin', branch])
  if (!pushed.ok) {
    throw new Error(pushRejected(pushed)
      ? `the force-with-lease push was rejected — ${branch} moved on origin under this run`
      : `git push failed (${failureReason(pushed)})`)
  }
  const prHead = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse HEAD')
  const prUrl = await withBodyFile(body, file => prCreate({ head: branch, title, bodyFile: file }))
  const prNumber = Number(String(prUrl).trim().split('/').pop())
  return { prUrl, prNumber, prHead, branch, title, body }
}

export async function handoffIssue({ issue, dir, log = () => {} }) {
  const spend = terminalSpend
  const readLabels = async () => {
    try { return await issueLabels(issue, spend()) }
    catch (error) {
      log(`handoff: the issue's labels could not be read back (${error?.message || error})`)
      return null
    }
  }
  const observedIn = labels => labels ? `observed labels: ${labels.join(', ') || 'none'}` : 'the labels could not be read back'
  await ensureLabels(['ready-to-merge'], spend())
  const write = await editLabels(issue, { add: ['ready-to-merge'], remove: ['ready-to-review'] }, spend())
  const labels = await readLabels()
  const why = write.ok ? observedIn(labels) : `${failureReason(write)}; ${observedIn(labels)}`
  if (labels && labels.includes('ready-to-merge') && !labels.includes('ready-to-review')) {
    try { updateEpicMd(dir, { log: 'handoff: queued for merge-worker' }) } catch { /* pane log is enough */ }
    return { labelled: true, summary: write.ok ? 'ready-to-merge observed' : `the write itself was not confirmed (${failureReason(write)}) but ready-to-merge is observed on the issue` }
  }

  const rest = terminalTransition({ rest: 'ready-to-review' })
  await ensureLabels(rest.add, spend())
  const undo = await editLabels(issue, rest, spend())
  const after = (await readBack(readLabels,
    value => value === null || (value.includes('ready-to-review') && !value.includes('ready-to-merge')), spend())).observed
  if (after && after.includes('ready-to-review') && !after.includes('ready-to-merge')) {
    return { labelled: false, summary: `${why} — the promotion was taken back off and ready-to-review confirmed` }
  }
  const undoneWhy = undo.ok ? observedIn(after) : `${failureReason(undo)}; ${observedIn(after)}`
  return { labelled: false, summary: why, unresolved: `${why} — and the demotion back to ready-to-review could not be verified (${undoneWhy})` }
}

export async function preserveIssueWork({ slug, phase }) {
  if (!slug) return
  const branch = `epic/${slug}`
  if (await gitOut(['status', '--porcelain'], 'git status')) {
    await gitOut(['add', '-A'], 'git add -A')
    if ((await git(['diff', '--cached', '--quiet'])).code !== 0) {
      await gitOut(['commit', '-q', '-m', `wip: epic blocked at ${phase}`], 'git commit (wip)')
    }
  }
  const claimed = `refs/remotes/origin/${branch}`
  const hasClaim = (await git(['rev-parse', '--verify', '-q', claimed])).ok
  let push
  if (hasClaim) {
    const head = (await git(['rev-parse', 'HEAD'])).out
    const remote = (await git(['rev-parse', claimed])).out
    push = !!head && !!remote && head !== remote && (await git(['merge-base', '--is-ancestor', 'HEAD', claimed])).code !== 0
  } else {
    push = (Number((await git(['rev-list', '--count', 'origin/main..HEAD'])).out) || 0) > 0
  }
  if (push) {
    const pushed = await git(['push', '--force-with-lease', '-u', 'origin', branch])
    if (!pushed.ok) throw new Error(`git push failed (${failureReason(pushed)})`)
  }
}

export async function holdIssueForQuota({ issue, slug, phase, failure }) {
  try {
    await preserveIssueWork({ slug, phase })
    const { hostHold, trigger } = await recordQuotaHold({ vendor: failure.vendor, reason: failure.reason })
    terminalBudget()
    await ensureLabels(['ready'], terminalSpend())
    const remove = ['in-progress', 'failed', 'ready-to-merge', 'ready-to-review', 'needs-defect-fix']
    const flip = await editLabels(issue, { add: ['ready'], remove }, terminalSpend())
    const labels = await issueLabels(issue, terminalSpend())
    if (!flip.ok || !labels.includes('ready') || remove.some(label => labels.includes(label))) {
      throw new Error(flip.ok ? `observed labels: ${labels.join(', ') || 'none'}` : failureReason(flip))
    }
    return { held: true, issue, slug, phase, ...hostHold, ...trigger, outcome: 'quota-held' }
  } catch (error) {
    return { error: error?.message || String(error) }
  }
}

export async function restIssueFailed({ issue, drop = ['ready', 'needs-defect-fix'] }) {
  terminalBudget()
  const rest = terminalTransition({ rest: 'failed', drop })
  await ensureLabels(rest.add, terminalSpend())
  const flipped = await editLabels(issue, rest, terminalSpend())
  return { flipped, transition: rest }
}

export async function restIssueReadyToReview({ issue }) {
  terminalBudget()
  const rest = terminalTransition({ rest: 'ready-to-review' })
  await ensureLabels(rest.add, terminalSpend())
  const flipped = await editLabels(issue, rest, terminalSpend())
  return { flipped, transition: rest }
}
