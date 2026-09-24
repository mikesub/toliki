// Local epic mechanics only. No model calls, phase routing, installation, or
// network operations. Markdown handovers belong to their skills; these records
// bind observed evidence to bytes. They do not constitute human/model approval.
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { run, terminateAll } from '../../../workflows/lib/proc.mjs'

const VERSION = 1
const MAX_OUTPUT = 16 * 1024 * 1024
const fail = message => { throw new Error(message) }
const digest = value => createHash('sha256').update(value).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function git(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    fail(`git ${args[0]} failed: ${String(error.stderr || error.message).trim()}`)
  }
}

function gitOK(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX_OUTPUT })
  if (result.error || ![0, 1].includes(result.status)) {
    fail(`Cannot check git ${args[0]}: ${result.error?.message || result.stderr}`)
  }
  return result.status === 0
}

function stat(file) {
  try { return lstatSync(file) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function directory(file) {
  const current = stat(file)
  if (current && (!current.isDirectory() || current.isSymbolicLink())) fail(`Not a regular directory: ${file}`)
  if (!current) mkdirSync(file)
  return file
}

function artifacts(root, title, create = false) {
  const parent = path.join(root, '.epics')
  const dir = path.join(parent, title)
  for (const file of [parent, dir]) {
    if (create) directory(file)
    else if (!stat(file)?.isDirectory() || stat(file).isSymbolicLink()) fail(`Missing regular handover directory: ${file}`)
  }
  return dir
}

function write(file, value) {
  const temporary = path.join(path.dirname(file), `.write-${randomUUID()}`)
  writeFileSync(temporary, value, { flag: 'wx', mode: 0o600 })
  renameSync(temporary, file)
}

function record(dir, name, value) {
  write(path.join(dir, name), `${JSON.stringify({ version: VERSION, ...value }, null, 2)}\n`)
}

function readRecord(dir, name, optional = false) {
  const file = path.join(dir, name)
  if (!stat(file) && optional) return null
  if (!stat(file)?.isFile()) fail(`Missing regular evidence file: ${file}`)
  let result
  try { result = JSON.parse(readFileSync(file, 'utf8')) } catch { fail(`Invalid evidence: ${file}`) }
  if (!result || result.version !== VERSION) fail(`Unsupported evidence: ${file}`)
  return result
}

function titleName(value) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value || '')) fail('Provide a lowercase hyphenated epic title.')
  return value
}

function repository(cwd) {
  const root = realpathSync(git(cwd, ['rev-parse', '--show-toplevel']).trim())
  const entries = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0')
    return {
      path: fields.find(field => field.startsWith('worktree '))?.slice(9),
      branch: fields.find(field => field.startsWith('branch '))?.slice(7),
    }
  })
  const mainEntry = entries.find(entry => entry.branch === 'refs/heads/main')
  if (!mainEntry || !existsSync(mainEntry.path)) fail('Local main must be checked out in an existing worktree.')
  return { root, main: realpathSync(mainEntry.path), entries }
}

function ignoreArtifacts(main, title) {
  const local = path.join(main, '.epics')
  if (stat(local)) directory(local)
  if (git(main, ['ls-files', '--', '.epics']).trim()) fail('Tracked .epics files must be moved out of version control before starting a local epic.')
  const common = path.resolve(main, git(main, ['rev-parse', '--git-common-dir']).trim())
  const info = directory(path.join(common, 'info'))
  const exclude = path.join(info, 'exclude')
  if (stat(exclude) && !stat(exclude).isFile()) fail(`Not a regular exclude file: ${exclude}`)
  const contents = stat(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!contents.split('\n').includes('/.epics/')) write(exclude, `${contents}${contents.endsWith('\n') ? '' : '\n'}/.epics/\n`)
  if (!gitOK(main, ['check-ignore', '--no-index', '-q', `.epics/${title}/spec.md`])) fail('Project ignore rules override the local .epics exclusion.')
}

export function start(cwd, title) {
  titleName(title)
  const repo = repository(cwd)
  if (repo.root !== repo.main) fail('Start from the main checkout.')
  const branch = `epic/${title}`
  if (gitOK(repo.main, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])) {
    fail(`${branch} already exists; use status to locate and resume it.`)
  }
  // Worktrees sit beside the real main path, outside the project's own tree
  // and tooling. The sibling and title paths cannot be symlinks, and a
  // collision never authorizes removing another workspace.
  const parent = directory(`${repo.main}.worktrees`)
  const worktree = path.join(parent, title)
  if (stat(worktree)) fail(`Worktree path already exists: ${worktree}`)
  ignoreArtifacts(repo.main, title)
  const base = git(repo.main, ['rev-parse', 'main']).trim()
  git(repo.main, ['worktree', 'add', '-b', branch, worktree, base])
  const dir = artifacts(worktree, title, true)
  const state = { title, branch, main: repo.main, worktree: realpathSync(worktree), base }
  record(dir, '.workspace.json', state)
  return { ...state, artifacts: dir }
}

function workspace(cwd, requestedTitle) {
  const repo = repository(cwd)
  const current = git(repo.root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const title = titleName(requestedTitle || (current.startsWith('epic/') ? current.slice(5) : null))
  const branch = `epic/${title}`
  // During a conflicted rebase the registered entry is detached. Its ownership
  // record still locates it so status can explain how to resume that operation.
  const candidates = repo.entries.filter(entry => entry.path !== repo.main && existsSync(entry.path))
  const entry = candidates.find(item => item.branch === `refs/heads/${branch}`) || candidates.find(item => {
    const file = path.join(item.path, '.epics', title, '.workspace.json')
    return stat(file)?.isFile()
  })
  if (!entry) fail(`No managed worktree found for ${branch}.`)
  const worktree = realpathSync(entry.path)
  const dir = artifacts(worktree, title)
  const state = readRecord(dir, '.workspace.json')
  if (state.title !== title || state.branch !== branch || state.main !== repo.main || state.worktree !== worktree || !/^[0-9a-f]{40,64}$/.test(state.base || '')) {
    fail('Workspace ownership does not match this repository, title and worktree.')
  }
  return { ...state, root: repo.root, artifacts: dir }
}

function settled(state) {
  const actual = git(state.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  const pending = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some(name =>
    existsSync(path.resolve(state.worktree, git(state.worktree, ['rev-parse', '--git-path', name]).trim())))
  return actual === state.branch && !pending
}

function requireSettled(state) {
  if (!settled(state)) fail('Finish the pending Git operation in the epic worktree before continuing.')
}

function fileHash(file) {
  if (!stat(file)?.isFile()) fail(`Missing regular file: ${file}`)
  return digest(readFileSync(file))
}

function contentHash(cwd) {
  const names = [...new Set(git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort()
  const hash = createHash('sha256')
  for (const name of names) {
    if (name === '.epics' || name.startsWith('.epics/')) fail('Handover files are not excluded from version control.')
    const file = path.join(cwd, name)
    const current = stat(file)
    if (!current) continue // Deleted paths disappear after commit; fingerprints must remain stable.
    hash.update(`${name}\0`)
    if (current.isSymbolicLink()) hash.update(`link\0${readlinkSync(file)}\0`)
    else if (current.isFile()) hash.update(`file\0${current.mode & 0o111}\0${digest(readFileSync(file))}\0`)
    else fail(`Cannot capture a regular source file at ${name}; inspect nested repositories before proceeding.`)
  }
  return hash.digest('hex')
}

export function snapshot(cwd, title) {
  const state = workspace(cwd, title)
  requireSettled(state)
  const common = path.resolve(state.worktree, git(state.worktree, ['rev-parse', '--git-common-dir']).trim())
  const metadata = ['hooks', 'refs/replace', 'info/grafts'].map(name => {
    const file = path.join(common, name)
    return [name, stat(file) ? directoryHash(file) : null]
  })
  return {
    content: contentHash(state.worktree),
    spec: fileHash(path.join(state.artifacts, 'spec.md')),
    head: git(state.worktree, ['rev-parse', 'HEAD']).trim(),
    main: git(state.worktree, ['rev-parse', 'main']).trim(),
    index: digest(git(state.worktree, ['ls-files', '--stage', '-v', '-z'])),
    config: digest(git(state.worktree, ['config', '--null', '--show-origin', '--list'])),
    metadata: digest(JSON.stringify(metadata)),
  }
}

const sameContents = (a, b) => !!a && !!b && a.content === b.content && a.spec === b.spec
const sameIntegrity = (a, b) => sameContents(a, b) && a.head === b.head && a.index === b.index && a.config === b.config && a.metadata === b.metadata

function currentReview(state, current) {
  const review = readRecord(state.artifacts, '.review.json', true)
  const report = path.join(state.artifacts, 'review.md')
  return !!review && sameContents(review.snapshot, current) && review.snapshot.config === current.config &&
    review.snapshot.metadata === current.metadata && stat(report)?.isFile() === true && review.report === fileHash(report)
}

export function status(cwd, title) {
  const state = workspace(cwd, title)
  if (!settled(state)) return { ...state, interrupted: true }
  const current = stat(path.join(state.artifacts, 'spec.md')) ? snapshot(cwd, state.title) : null
  return {
    ...state, interrupted: false,
    base: git(state.worktree, ['merge-base', 'main', 'HEAD']).trim(),
    changes: git(state.worktree, ['status', '--porcelain', '--untracked-files=all']),
    snapshot: current,
    reviewCurrent: current ? currentReview(state, current) : false,
    verification: readRecord(state.artifacts, '.verification.json', true),
    release: readRecord(state.artifacts, '.release.json', true),
  }
}

export async function verify(cwd, title, command, { timeoutMs = 30 * 60 * 1000 } = {}) {
  if (typeof command !== 'string' || !command.trim()) fail('Supply the documented verification command after --.')
  const state = workspace(cwd, title)
  const before = snapshot(cwd, state.title)
  // Clear older green evidence before launching; a killed session cannot leave
  // an earlier success looking like the result of this invocation.
  record(state.artifacts, '.verification.json', { ok: false, command, before, reason: 'verification started' })
  // The command runs in its own process group, so a closed session's hangup
  // must be forwarded like an interrupt or the tree outlives its timeout.
  let interrupted = false
  const stop = () => { interrupted = true; void terminateAll() }
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  for (const signal of signals) process.on(signal, stop)
  const started = Date.now()
  let result
  try {
    result = await run('bash', ['-c', command], { cwd: state.worktree, timeoutMs, stdoutCap: 64 * 1024 })
  } finally {
    for (const signal of signals) process.off(signal, stop)
  }
  const after = snapshot(cwd, state.title)
  const evidence = {
    command, before, after, durationMs: Date.now() - started,
    exitCode: result.code, timedOut: result.timedOut, interrupted,
    spawnError: result.spawnError ? String(result.spawnError.message || result.spawnError) : null,
    ok: result.code === 0 && !result.timedOut && !result.spawnError && !interrupted && sameIntegrity(before, after) && before.main === after.main,
  }
  write(path.join(state.artifacts, 'verification.log'), `STDOUT (tail)\n${result.stdout}\nSTDERR (tail)\n${result.stderr}\n`)
  record(state.artifacts, '.verification.json', evidence)
  return evidence
}

export function reviewStart(cwd, title) {
  const state = workspace(cwd, title)
  const before = snapshot(cwd, state.title)
  record(state.artifacts, '.review.json', { snapshot: null, report: null })
  record(state.artifacts, '.review-before.json', { snapshot: before })
  return before
}

export function reviewFinish(cwd, title) {
  const state = workspace(cwd, title)
  record(state.artifacts, '.review.json', { snapshot: null, report: null })
  const before = readRecord(state.artifacts, '.review-before.json').snapshot
  const after = snapshot(cwd, state.title)
  if (!sameIntegrity(before, after)) fail('Review changed source, spec, HEAD, index, Git configuration or hooks/ancestry metadata; review is not sealed.')
  const report = fileHash(path.join(state.artifacts, 'review.md'))
  record(state.artifacts, '.review.json', { snapshot: after, report })
  return { snapshot: after, report }
}

function clean(cwd) {
  if (git(cwd, ['status', '--porcelain', '--untracked-files=all']).trim()) fail(`Uncommitted changes remain in ${cwd}.`)
}

export function release(cwd, title, { acceptUnreviewed = false } = {}) {
  const state = workspace(cwd, title)
  if (state.root !== state.main) fail('Release from the main checkout.')
  requireSettled(state)
  clean(state.main)
  clean(state.worktree)
  const current = snapshot(cwd, state.title)
  if (!gitOK(state.worktree, ['merge-base', '--is-ancestor', 'main', 'HEAD'])) fail('Main moved; rebase and verify the epic again.')
  if (git(state.worktree, ['rev-list', '--count', 'main..HEAD']).trim() !== '1') fail('Release requires exactly one commit above main.')
  const verification = readRecord(state.artifacts, '.verification.json')
  if (verification.ok !== true || !same(verification.after, current)) fail('The final commit, main and spec need fresh passing verification.')
  if (!currentReview(state, current) && !acceptUnreviewed) fail('Review is missing or stale; the human must choose review or explicitly accept unreviewed code.')
  // Write the candidate receipt first. If interrupted immediately after the
  // merge, cleanup can still prove landing from main's actual ancestry. A
  // receipt alone never permits cleanup when the fast-forward failed.
  record(state.artifacts, '.release.json', { commit: current.head, acceptUnreviewed })
  git(state.main, ['merge', '--ff-only', current.head])
  if (git(state.main, ['rev-parse', 'HEAD']).trim() !== current.head) fail('Main did not land on the checked commit; inspect before cleanup.')
  return { commit: current.head, worktree: state.worktree, released: true }
}

function directoryHash(dir) {
  const hash = createHash('sha256')
  function visit(file, relative) {
    const current = lstatSync(file)
    hash.update(`${relative}\0${current.mode & 0o777}\0`)
    if (current.isSymbolicLink()) hash.update(`link\0${readlinkSync(file)}\0`)
    else if (current.isDirectory()) {
      hash.update('directory\0')
      for (const name of readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`)
    } else if (current.isFile()) hash.update(`file\0${digest(readFileSync(file))}\0`)
    else fail(`Cannot archive special file ${file}.`)
  }
  visit(dir, '')
  return hash.digest('hex')
}

function cleanupProof(state, commit) {
  requireSettled(state)
  clean(state.worktree)
  if (git(state.worktree, ['rev-parse', 'HEAD']).trim() !== commit ||
      !gitOK(state.main, ['merge-base', '--is-ancestor', commit, 'main'])) fail('Main does not contain the exact released worktree commit.')
  const prefix = `.epics/${state.title}/`
  const ignored = (...args) => git(state.worktree, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...args]).split('\0').filter(Boolean)
  // Wholly ignored directories such as node_modules/ are one entry; only the
  // handover parent is listed file by file to find anything beside this epic.
  const listed = [...ignored('--directory').filter(name => name !== '.epics/'), ...ignored('--', '.epics')]
  const extra = [...new Set(listed)].filter(name => !name.startsWith(prefix))
  if (extra.length) fail(`Ignored files outside the handover need preservation or explicit disposal before cleanup:\n${extra.join('\n')}`)
}

export function cleanup(cwd, title) {
  const state = workspace(cwd, title)
  if (state.root !== state.main) fail('Cleanup from the main checkout.')
  const receipt = readRecord(state.artifacts, '.release.json')
  if (!/^[0-9a-f]{40,64}$/.test(receipt.commit || '')) fail('Missing released commit evidence.')
  cleanupProof(state, receipt.commit)
  ignoreArtifacts(state.main, state.title)
  const archiveRoot = directory(path.join(artifacts(state.main, state.title, true), 'releases'))
  const archive = path.join(archiveRoot, receipt.commit)
  const before = directoryHash(state.artifacts)
  if (stat(archive)) {
    if (!stat(archive).isDirectory() || stat(archive).isSymbolicLink() || directoryHash(archive) !== before) fail(`Archive already exists with different contents: ${archive}`)
  } else {
    cpSync(state.artifacts, archive, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  }
  if (directoryHash(archive) !== before || directoryHash(state.artifacts) !== before) fail('Handover archive did not match; worktree retained.')
  cleanupProof(state, receipt.commit)
  git(state.main, ['worktree', 'remove', state.worktree])
  // An expected old value preserves a branch someone advanced during cleanup.
  try { git(state.main, ['update-ref', '-d', `refs/heads/${state.branch}`, receipt.commit]) } catch (error) {
    fail(`Worktree removed and handovers archived at ${archive}; branch ${state.branch} retained. ${error.message}`)
  }
  return { commit: receipt.commit, archive, removedWorktree: state.worktree, removedBranch: state.branch }
}

async function cli(args) {
  const [command, ...rest] = args
  const title = rest[0] && !rest[0].startsWith('--') ? rest.shift() : undefined
  const cwd = process.cwd()
  if (command === 'verify') {
    if (rest.length !== 2 || rest[0] !== '--') fail('Usage: verify [title] -- "verification command"')
    const result = await verify(cwd, title, rest[1])
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }
  const allowUnreviewed = command === 'release' && rest.length === 1 && rest[0] === '--accept-unreviewed'
  if (rest.length && !allowUnreviewed) fail('Unexpected arguments.')
  const commands = { start, status, snapshot, 'review-start': reviewStart, 'review-finish': reviewFinish, cleanup }
  const result = command === 'release' ? release(cwd, title, { acceptUnreviewed: allowUnreviewed })
    : commands[command] ? commands[command](cwd, title)
      : fail('Use start, status, snapshot, verify, review-start, review-finish, release, or cleanup.')
  console.log(JSON.stringify(result, null, 2))
}

// Installed skills reach this file through symlinks, while Node reports the
// module's real path; compare real paths or the CLI would silently do nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  cli(process.argv.slice(2)).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
