// Bounded recovery for an interrupted issue branch whose checkpoint chain no
// longer rebases cleanly onto the fetched main head. This is not the finished-
// PR conflict fixer: there is no PR or candidate commit yet, and the saved
// branch may hold several implementation checkpoints.
//
// The remote branch remains the durable original while recovery is in flight.
// We bind both sides' evidence to immutable SHAs, flatten the local checkpoint
// chain to one temporary commit, and expose at most one diff3 stop to a
// writable builder. The orchestrator alone stages and continues that stop.
// Failure restores the original local chain. The complete recovery tree is
// retained first under a local-only refs/toliki/recovery/* ref so a human can
// recover it without mistaking it for reviewed or remotely published state.

import { existsSync, lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { failureReason } from './proc.mjs'
import { captureDiff, git, gitOut, gitRaw, rebaseInProgress, worktreeTree } from './repo.mjs'
import { captureIssueRecords } from './evidence.mjs'

const MARKER_PATTERN = '^(<<<<<<<|>>>>>>>|\\|{7})( |$)'
const MAX_MAIN_ISSUES = 5
const SHA = '[0-9a-f]{40,64}'

const validatedFiles = files => {
  const result = []
  const seen = new Set()
  for (const value of files) {
    const file = String(value)
    if (!file || file.includes('\0') || path.isAbsolute(file) || file.split('/').includes('..')) {
      throw new Error(`unsafe path in resume recovery evidence: ${JSON.stringify(file)}`)
    }
    const resolved = path.resolve(file)
    const relative = path.relative(path.resolve('.'), resolved)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`resume recovery path escapes the worktree: ${JSON.stringify(file)}`)
    }
    if (!seen.has(file)) { seen.add(file); result.push(file) }
  }
  return result
}

async function rawPaths(args, what) {
  const result = await gitRaw(args)
  if (!result.ok) throw new Error(`${what} failed (${failureReason(result)})`)
  if (!result.out) return []
  if (!result.out.endsWith('\0')) throw new Error(`${what} returned a malformed non-NUL-terminated path list`)
  return validatedFiles(result.out.slice(0, -1).split('\0'))
}

async function markerFiles() {
  return rawPaths(['diff', '--name-only', '--diff-filter=U', '-z'], 'git diff --diff-filter=U')
}

async function changedPaths() {
  return validatedFiles([
    ...await rawPaths(['diff', '--name-only', '-z'], 'git diff --name-only'),
    ...await rawPaths(['diff', '--cached', '--name-only', '-z'], 'git diff --cached --name-only'),
    ...await rawPaths(['ls-files', '--others', '--exclude-standard', '-z'], 'git ls-files --others'),
  ])
}

function pathState(file) {
  let stat
  try { stat = lstatSync(file) } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'deleted' }
    throw error
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', mode: stat.mode, target: readlinkSync(file) }
  if (!stat.isFile()) return { kind: 'unsupported' }
  return { kind: 'file', mode: stat.mode, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }
}

const sameState = (left, right) => JSON.stringify(left) === JSON.stringify(right)

async function indexState(file) {
  const result = await gitRaw(['ls-files', '--stage', '-z', '--', file])
  if (!result.ok) throw new Error(`the index state for ${file} could not be captured (${failureReason(result)})`)
  if (result.out && !result.out.endsWith('\0')) throw new Error(`the index state for ${file} was malformed`)
  return result.out
}

async function captureEpicBoundary(markedFiles) {
  const initialPaths = await changedPaths()
  const marked = new Set(markedFiles)
  const outside = await Promise.all(initialPaths.filter(file => !marked.has(file)).map(async file => ({
    file,
    worktree: pathState(file),
    index: await indexState(file),
  })))
  return { initialPaths, outside }
}

function markerTextProblem(files) {
  for (const file of validatedFiles(files)) {
    if (!existsSync(file)) continue
    const stat = lstatSync(file)
    if (!stat.isFile()) continue
    const text = readFileSync(file).toString('utf8')
    const line = text.split(/\r?\n/u).find(value => /^(<<<<<<<|>>>>>>>|\|{7})( |$)/u.test(value))
    if (line) return `${file}: ${line}`
  }
  return null
}

export const RESUME_RECOVERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['resolved', 'declined'], description: 'resolved only when every supplied diff3 marker was replaced with an integration that preserves both sides; declined when any intent cannot safely be composed' },
    summary: { type: 'string', description: 'non-empty account of the integration or the exact reason it was declined' },
  },
}

export function resumeRecoveryProblem(result) {
  if (!result || !['resolved', 'declined'].includes(result.status)) return 'the recovery builder returned no valid status'
  if (typeof result.summary !== 'string' || !result.summary.trim()) return 'the recovery builder returned no recovery summary'
  return result.status === 'declined' ? `the recovery builder declined the integration: ${result.summary.trim()}` : null
}

async function captureMainIntent(mergeBase, mainHead) {
  const mainDiff = await captureDiff([mergeBase, mainHead])
  if (mainDiff === null) throw new Error('current-main diff evidence could not be captured')
  const commits = await git(['log', '--format=%H %s', `${mergeBase}..${mainHead}`])
  if (!commits.ok) throw new Error(`current-main commit evidence could not be captured (${failureReason(commits)})`)
  const bodies = await git(['log', '--format=%b', `${mergeBase}..${mainHead}`])
  if (!bodies.ok) throw new Error(`current-main issue references could not be captured (${failureReason(bodies)})`)
  const mainIssues = [...new Set([...bodies.out.matchAll(/Closes #(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b)
  const selectedMainIssues = mainIssues.slice(0, MAX_MAIN_ISSUES)
  return {
    mainDiff,
    mainCommits: commits.out,
    mainIssueRecords: await captureIssueRecords(selectedMainIssues),
    omittedMainIssues: mainIssues.length - selectedMainIssues.length,
  }
}

async function attachRecoveryMetadata(recovery) {
  const message = await gitOut(['log', '-1', '--format=%B'], 'git log aggregate recovery message')
  const next = `${message.trim()}\n\nToliki-Recovery-Main-Head: ${recovery.mainHead}\nToliki-Recovery-Merge-Base: ${recovery.evidenceMergeBase || recovery.mergeBase}`
  await gitOut(['commit', '--amend', '-q', '-m', next], 'git commit --amend recovery metadata')
}

// A post-integration checkpoint may be force-pushed after a later phase fails.
// These two reachable ancestor SHAs in its internal aggregate commit let the
// next run recapture the main-side intent before review. The old saved chain
// and exact stopped marker bytes are deliberately not claimed as reconstructible.
export async function loadResumeRecoveryEvidence({ issue, slug, branch, currentMainHead, codeDone }) {
  const record = await git(['log', '-1', '--format=%B', '--grep=^Toliki-Recovery-Main-Head:', `${currentMainHead}..HEAD`])
  if (!record.ok) throw new Error(`saved recovery metadata could not be inspected (${failureReason(record)})`)
  if (!record.out) return null
  const mainMatch = record.out.match(new RegExp(`^Toliki-Recovery-Main-Head: (${SHA})$`, 'm'))
  const baseMatch = record.out.match(new RegExp(`^Toliki-Recovery-Merge-Base: (${SHA})$`, 'm'))
  if (!mainMatch || !baseMatch) throw new Error('saved recovery metadata is malformed or incomplete')
  const mainHead = mainMatch[1]
  const mergeBase = baseMatch[1]
  const baseBound = await git(['merge-base', '--is-ancestor', mergeBase, mainHead])
  const headBound = await git(['merge-base', '--is-ancestor', mainHead, 'HEAD'])
  if (!baseBound.ok || !headBound.ok) throw new Error('saved recovery metadata does not describe reachable aggregate ancestors')
  const main = await captureMainIntent(mergeBase, mainHead)
  return {
    issue, slug, branch, savedHead: null, mainHead, mergeBase, evidenceMergeBase: mergeBase, codeDone,
    integrated: true, reloaded: true, markedFiles: [], markerText: [], savedDiff: null,
    ...main,
  }
}

// Called only after the ordinary replay conflicted and was aborted. Evidence
// is captured before local history is rewritten, using immutable SHAs rather
// than mutable remote-tracking names. A clean aggregate replay is possible
// when intermediate checkpoint conflicts cancel out; it still counts as a
// recovered base and must be verified/reviewed by the caller.
export async function startResumeRecovery({ issue, slug, branch, savedHead, mainHead, codeDone, priorRecovery = null }) {
  const mergeBase = await gitOut(['merge-base', savedHead, mainHead], 'git merge-base saved branch and main')
  const evidenceMergeBase = priorRecovery?.evidenceMergeBase || priorRecovery?.mergeBase || mergeBase
  const [savedDiff, main] = await Promise.all([
    captureDiff([mergeBase, savedHead]),
    captureMainIntent(evidenceMergeBase, mainHead),
  ])
  if (savedDiff === null) {
    throw new Error('resume-conflict evidence could not be captured from the saved branch and current main')
  }

  let rewritten = false
  try {
    await gitOut(['reset', '--soft', mergeBase], 'git reset --soft (resume recovery aggregate)')
    rewritten = true
    const staged = await git(['diff', '--cached', '--quiet'])
    if (staged.ok) throw new Error('the interrupted branch contains no change to recover')
    if (staged.code !== 1 || staged.timedOut || staged.spawnError) {
      throw new Error(`the interrupted branch aggregate could not be inspected (${failureReason(staged)})`)
    }
    const checkpoint = codeDone ? 'code' : 'resume'
    await gitOut(['commit', '-q', '-m', `wip(epic ${slug}): ${checkpoint} checkpoint`], 'git commit (resume recovery aggregate)')
    const aggregateHead = await gitOut(['rev-parse', 'HEAD'], 'git rev-parse aggregate recovery head')
    const replay = await git(['-c', 'merge.conflictStyle=diff3', 'rebase', mainHead])
    if (replay.ok) {
      const recovery = {
        issue, slug, branch, savedHead, mainHead, mergeBase, evidenceMergeBase, aggregateHead,
        codeDone, integrated: true, markedFiles: [], markerText: [], savedDiff, ...main,
      }
      await attachRecoveryMetadata(recovery)
      return recovery
    }

    const markedFiles = await markerFiles()
    if (!markedFiles.length || !(await rebaseInProgress())) {
      throw new Error(`the aggregate resume rebase failed without one recoverable conflict stop (${failureReason(replay)})`)
    }
    const markerText = markedFiles.map(file => {
      let text
      try { text = readFileSync(file, 'utf8') } catch (error) {
        throw new Error(`the exact conflict bytes could not be captured for ${file} (${error?.message || error})`)
      }
      if (!/^<<<<<<<( |$)/m.test(text) || !/^>>>>>>>( |$)/m.test(text)) {
        throw new Error(`${file} did not contain a complete captured conflict marker block`)
      }
      return { file, text }
    })
    const epicBoundary = await captureEpicBoundary(markedFiles)
    return {
      issue, slug, branch, savedHead, mainHead, mergeBase, evidenceMergeBase, aggregateHead,
      codeDone, integrated: false, markedFiles, markerText, savedDiff, ...main,
      epicBoundary,
    }
  } catch (error) {
    if (rewritten) {
      if (await rebaseInProgress()) {
        const aborted = await git(['rebase', '--abort'])
        if (!aborted.ok || await rebaseInProgress()) {
          throw new Error(`${error?.message || error}; aborting the recovery rebase also failed (${failureReason(aborted)})`)
        }
      }
      const restored = await git(['reset', '--hard', savedHead])
      if (!restored.ok) {
        throw new Error(`${error?.message || error}; restoring the original saved head also failed (${failureReason(restored)})`)
      }
    }
    throw error
  }
}

export async function preserveResumeRecoveryEdits(recovery, reason) {
  if (!recovery || recovery.integrated || !Array.isArray(recovery.markedFiles)) return null
  // worktreeTree uses a throwaway index seeded from HEAD, so tracked edits,
  // deletions, modes/symlinks and nonignored untracked files are all captured
  // even while the real index is unmerged. A local commit/ref survives
  // worktree reaping and Git GC; it is never pushed or treated as reviewed.
  const tree = await worktreeTree()
  if (!tree) throw new Error('the partial recovery tree could not be captured')
  const message = [
    `toliki resume recovery snapshot for ${recovery.branch}`,
    '',
    `saved-head: ${recovery.savedHead}`,
    `main-head: ${recovery.mainHead}`,
    `merge-base: ${recovery.mergeBase}`,
    `reason: ${String(reason || 'recovery did not complete').replace(/\s+/gu, ' ').trim()}`,
  ].join('\n')
  const commit = await git(['commit-tree', tree, '-p', recovery.savedHead], { stdin: `${message}\n` })
  if (!commit.ok || !commit.out) throw new Error(`the partial recovery snapshot commit could not be created (${failureReason(commit)})`)
  const suffix = `${recovery.mainHead.slice(0, 12)}-${Date.now()}-${process.pid}`
  const ref = `refs/toliki/recovery/${recovery.slug}/${suffix}`
  await gitOut(['update-ref', ref, commit.out], 'git update-ref resume recovery snapshot')
  return { ref, commit: commit.out }
}

export async function abortResumeRecovery(recovery, { preserveEdits = false, reason = '' } = {}) {
  let snapshot = null
  if (preserveEdits) {
    try { snapshot = await preserveResumeRecoveryEdits(recovery, reason) }
    catch (error) {
      // Cleanup would destroy the only copy of builder-written bytes. Leave
      // this exact stopped worktree in place and force a terminal human hold.
      throw new Error(`partial recovery bytes could not be retained, so the recovery worktree was left untouched (${error?.message || error})`)
    }
  }
  if (await rebaseInProgress()) {
    const aborted = await git(['rebase', '--abort'])
    if (!aborted.ok || await rebaseInProgress()) throw new Error(`git rebase --abort failed (${failureReason(aborted)})`)
  }
  const currentBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (!currentBranch.ok || currentBranch.out !== recovery.branch) {
    throw new Error(`the recovery process left HEAD outside ${recovery.branch}; snapshot ${snapshot?.ref || 'creation failed'} retains its bytes, and no foreign branch was rewritten`)
  }
  // Materialize the snapshot commit first so recovery-created untracked paths
  // become tracked, then the saved-head reset removes/restores exactly those
  // captured paths. No worktree-wide untracked sweep is needed.
  if (snapshot) await gitOut(['reset', '--hard', snapshot.commit], 'git reset --hard recovery snapshot')
  await gitOut(['reset', '--hard', recovery.savedHead], 'git reset --hard saved branch')
  if (await rebaseInProgress()) throw new Error('the saved branch reset left rebase metadata in progress')
  return snapshot?.ref || null
}

// allowAdditionalEdits is reserved for task-run's primary tasker: that one
// process both integrates the saved work and completes/self-reviews the task.
// Epic recovery is narrower and may alter only the marked conflict files.
export async function settleResumeRecovery(recovery, { allowAdditionalEdits = false } = {}) {
  if (recovery.integrated) return null
  if (!(await rebaseInProgress())) return 'the resume recovery rebase is no longer in progress'
  const markers = await git(['grep', '-n', '-E', MARKER_PATTERN, '--', ...recovery.markedFiles])
  if (markers.ok) return `conflict markers remain in the recovered tree: ${markers.out.split('\n')[0]}`
  if (markers.code !== 1 || markers.timedOut || markers.spawnError) {
    return `conflict markers could not be checked safely: ${failureReason(markers)}`
  }
  const changed = await changedPaths()
  const residual = markerTextProblem(allowAdditionalEdits ? changed : recovery.markedFiles)
  if (residual) return `conflict marker text remains in a recovery-changed file: ${residual}`
  if (!allowAdditionalEdits) {
    const initial = new Set(recovery.epicBoundary?.initialPaths || [])
    const marked = new Set(recovery.markedFiles)
    const added = changed.filter(file => !marked.has(file) && !initial.has(file))
    if (added.length) return `the recovery builder changed file(s) outside the conflict stop: ${added.join(', ')}`
    for (const entry of recovery.epicBoundary?.outside || []) {
      if (!sameState(entry.worktree, pathState(entry.file)) || entry.index !== await indexState(entry.file)) {
        return `the recovery builder changed ${entry.file} outside the conflict stop`
      }
    }
  }
  const staged = await git(['add', ...(allowAdditionalEdits ? ['-A'] : ['--', ...recovery.markedFiles])])
  if (!staged.ok) return `the recovered files could not be staged: ${failureReason(staged)}`
  const unmerged = await markerFiles()
  if (unmerged.length) return `the recovery stop still has unresolved path(s): ${unmerged.join(', ')}`
  const continued = await git(['rebase', '--continue'], { env: { ...process.env, GIT_EDITOR: 'true' } })
  if (!continued.ok || await rebaseInProgress()) {
    return `continuing the bounded recovery rebase did not finish: ${failureReason(continued)}`
  }
  const based = await git(['merge-base', '--is-ancestor', recovery.mainHead, 'HEAD'])
  if (!based.ok) return 'the recovered branch is not based on the captured current-main head'
  try { await attachRecoveryMetadata(recovery) }
  catch (error) { return `the recovered aggregate could not retain its immutable review context: ${error?.message || error}` }
  const counted = await git(['rev-list', '--count', `${recovery.mainHead}..HEAD`])
  if (!counted.ok) return `the recovered aggregate commit count could not be proved: ${failureReason(counted)}`
  const count = Number(counted.out)
  if (count !== 1) return `the recovered branch holds ${Number.isNaN(count) ? 'an unknown number of' : count} aggregate commit(s) above the captured main head`
  return null
}
