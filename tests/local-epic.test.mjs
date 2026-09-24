import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cleanup, release, reviewFinish, reviewStart, snapshot, start, status, verify,
} from '../skills/epic/scripts/workspace.mjs'

// Real Git and Node operate only on mktemp fixtures. Unsafe external commands
// are fake executables first on PATH; global Git settings/hooks are excluded.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'toliki-local-epic-'))
const bin = path.join(temporary, 'bin')
mkdirSync(bin)
for (const name of ['gh', 'ssh', 'tmux', 'codex', 'claude']) {
  writeFileSync(path.join(bin, name), '#!/bin/sh\nprintf "Unexpected external command\\n" >&2\nexit 99\n', { mode: 0o755 })
}
const savedEnv = { ...process.env }
Object.assign(process.env, {
  PATH: `${bin}:${process.env.PATH}`,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_TERMINAL_PROMPT: '0',
})
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  rmSync(temporary, { recursive: true, force: true })
})

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function put(cwd, file, content) {
  const target = path.join(cwd, file)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
}
function commit(cwd, message = 'Implement the fixture') {
  git(cwd, 'add', '-A')
  return git(cwd, 'commit', '-m', message)
}
let next = 0
function fixture() {
  const root = path.join(temporary, `fixture-${next++}`)
  const main = path.join(root, 'project with spaces')
  mkdirSync(main, { recursive: true })
  git(main, 'init', '-b', 'main')
  put(main, 'app.cjs', 'module.exports = 1;\n')
  put(main, 'verify.cjs', 'require("node:assert/strict").equal(require("./app.cjs"), 1);\n')
  commit(main, 'Create fixture')
  const state = start(main, 'saved-searches')
  put(state.artifacts, 'spec.md', '# Saved searches\nReturn two.\n')
  return { ...state, root, command: 'node verify.cjs' }
}
function implement(f) {
  put(f.worktree, 'app.cjs', 'module.exports = 2;\n')
  put(f.worktree, 'verify.cjs', 'require("node:assert/strict").equal(require("./app.cjs"), 2);\n')
}
function review(f) {
  const before = reviewStart(f.worktree)
  put(f.artifacts, 'review.md', `# Review\nContent: ${before.content}\nSpec: ${before.spec}\nNo findings.\n`)
  reviewFinish(f.worktree)
}
async function ready(f, withReview = true) {
  implement(f)
  if (withReview) review(f)
  commit(f.worktree)
  const result = await verify(f.worktree, undefined, f.command)
  assert.equal(result.ok, true)
  return result
}

test('start excludes handovers, preserves dirty main, and detects a fresh workspace', () => {
  const f = fixture()
  put(f.main, 'unrelated.txt', 'Keep this local edit.\n')
  assert.equal(git(f.worktree, 'status', '--porcelain'), '')
  assert.equal(git(f.main, 'status', '--porcelain'), '?? unrelated.txt')
  assert.match(readFileSync(path.join(f.main, '.git/info/exclude'), 'utf8'), /\/\.epics\//)
  assert.equal(f.worktree, path.join(`${f.main}.worktrees`, 'saved-searches'))
  const current = status(f.worktree)
  assert.equal(current.title, 'saved-searches')
  assert.equal(current.main, f.main)
  assert.equal(current.reviewCurrent, false)
  assert.equal(current.base, f.base)
})

test('CLI infers the epic title and propagates verification failures', () => {
  const f = fixture()
  const helper = fileURLToPath(new URL('../skills/epic/scripts/workspace.mjs', import.meta.url))
  const current = JSON.parse(execFileSync(process.execPath, [helper, 'status'], { cwd: f.worktree, encoding: 'utf8' }))
  assert.equal(current.title, f.title)
  const failed = spawnSync(process.execPath, [helper, 'verify', '--', 'exit 9'], { cwd: f.worktree, encoding: 'utf8' })
  assert.equal(failed.status, 1)
  assert.equal(JSON.parse(failed.stdout).exitCode, 9)
  const invalid = spawnSync(process.execPath, [helper, 'status', '--unexpected'], { cwd: f.worktree, encoding: 'utf8' })
  assert.equal(invalid.status, 1)
  assert.match(invalid.stderr, /Unexpected arguments/)
})

test('start refuses existing branches and foreign paths without removing them', () => {
  const f = fixture()
  assert.throws(() => start(f.main, f.title), /already exists/)
  const collision = path.join(`${f.main}.worktrees`, 'another-epic')
  put(collision, 'mine.txt', 'User data')
  assert.throws(() => start(f.main, 'another-epic'), /already exists/)
  assert.equal(readFileSync(path.join(collision, 'mine.txt'), 'utf8'), 'User data')
  assert.throws(() => start(f.main, '../outside'), /hyphenated/)
})

test('start never writes through a linked worktrees directory beside main', () => {
  const root = path.join(temporary, `linked-sibling-${next++}`)
  const main = path.join(root, 'app')
  const foreign = path.join(root, 'foreign')
  mkdirSync(main, { recursive: true })
  mkdirSync(foreign)
  git(main, 'init', '-b', 'main')
  put(main, 'app.cjs', 'module.exports = 1;\n')
  commit(main, 'Create fixture')
  symlinkSync(foreign, `${main}.worktrees`)
  assert.throws(() => start(main, 'saved-searches'), /Not a regular directory/)
  assert.deepEqual(readdirSync(foreign), [])
  assert.equal(git(main, 'branch', '--list', 'epic/saved-searches'), '')
})

test('tracked handovers and a foreign ownership record are refused', () => {
  const f = fixture()
  put(f.main, '.epics/old/spec.md', 'Tracked requirements')
  git(f.main, 'add', '-f', '.epics/old/spec.md')
  assert.throws(() => start(f.main, 'another-epic'), /Tracked .epics/)
  const file = path.join(f.artifacts, '.workspace.json')
  const state = JSON.parse(readFileSync(file))
  put(f.artifacts, '.workspace.json', JSON.stringify({ ...state, main: f.root }))
  assert.throws(() => status(f.worktree), /ownership/)
})

test('fingerprints catch same-stat tracked edits, new-file edits, modes and spec edits', () => {
  const f = fixture()
  implement(f)
  put(f.worktree, 'new.cjs', 'module.exports = true;\n')
  const initial = snapshot(f.worktree)
  const initialStatus = git(f.worktree, 'status', '--porcelain')
  const initialStat = git(f.worktree, 'diff', 'HEAD', '--stat')
  put(f.worktree, 'app.cjs', 'module.exports = 3;\n')
  put(f.worktree, 'new.cjs', 'module.exports = false;\n')
  assert.equal(git(f.worktree, 'status', '--porcelain'), initialStatus)
  assert.equal(git(f.worktree, 'diff', 'HEAD', '--stat'), initialStat)
  assert.notEqual(snapshot(f.worktree).content, initial.content)
  const changed = snapshot(f.worktree)
  chmodSync(path.join(f.worktree, 'new.cjs'), 0o755)
  assert.notEqual(snapshot(f.worktree).content, changed.content)
  put(f.artifacts, 'spec.md', '# Changed agreement\n')
  assert.notEqual(snapshot(f.worktree).spec, initial.spec)
})

test('read-only review detects content and Git edits, and cannot seal missing reports', () => {
  const f = fixture()
  implement(f)
  reviewStart(f.worktree)
  assert.throws(() => reviewFinish(f.worktree), /Missing regular file/)
  put(f.artifacts, 'review.md', 'No findings.\n')
  put(f.worktree, 'app.cjs', 'module.exports = 3;\n')
  assert.throws(() => reviewFinish(f.worktree), /Review changed/)
  assert.equal(status(f.worktree).reviewCurrent, false)
  reviewStart(f.worktree)
  git(f.worktree, 'add', 'app.cjs')
  assert.throws(() => reviewFinish(f.worktree), /Review changed/)
  reviewStart(f.worktree)
  git(f.worktree, 'config', 'fixture.changed', 'true')
  assert.throws(() => reviewFinish(f.worktree), /Review changed/)
})

test('review remains current across committing additions, removals, and renames', () => {
  const f = fixture()
  implement(f)
  put(f.worktree, 'new.cjs', 'module.exports = true;\n')
  git(f.worktree, 'mv', 'verify.cjs', 'check.cjs')
  rmSync(path.join(f.worktree, 'app.cjs'))
  review(f)
  const before = snapshot(f.worktree)
  commit(f.worktree)
  assert.equal(snapshot(f.worktree).content, before.content)
  assert.equal(status(f.worktree).reviewCurrent, true)
  assert.notEqual(snapshot(f.worktree).head, before.head)
  put(f.artifacts, 'review.md', 'Edited without resealing\n')
  assert.equal(status(f.worktree).reviewCurrent, false)
})

test('changed hooks and a failed reseal invalidate an earlier completed review', () => {
  const f = fixture()
  implement(f)
  review(f)
  assert.equal(status(f.worktree).reviewCurrent, true)
  put(f.main, '.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n')
  assert.equal(status(f.worktree).reviewCurrent, false)
  assert.throws(() => reviewFinish(f.worktree), /Review changed/)
  assert.equal(JSON.parse(readFileSync(path.join(f.artifacts, '.review.json'))).snapshot, null)
})

test('verification records real failures, output, and a recovered passing run', async () => {
  const f = fixture()
  implement(f)
  const bad = await verify(f.worktree, undefined, 'node -e "console.error(\'fixture failure\'); process.exit(7)"')
  assert.equal(bad.ok, false)
  assert.equal(bad.exitCode, 7)
  assert.match(readFileSync(path.join(f.artifacts, 'verification.log'), 'utf8'), /fixture failure/)
  const good = await verify(f.worktree, undefined, f.command)
  assert.equal(good.ok, true)
  assert.ok(good.durationMs >= 0)
  assert.equal(status(f.worktree).verification.ok, true)
})

test('verification rejects a command that edits the tested source and times out', async () => {
  const f = fixture()
  const mutation = await verify(f.worktree, undefined, 'node -e "require(\'fs\').writeFileSync(\'app.cjs\', \'module.exports = 9;\')"')
  assert.equal(mutation.exitCode, 0)
  assert.equal(mutation.ok, false)
  const timeout = await verify(f.worktree, undefined, 'node -e "setInterval(() => {}, 1000)"', { timeoutMs: 100 })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.timedOut, true)
})

test('a hangup stops the verification process group and records an interruption', async () => {
  const f = fixture()
  const helper = fileURLToPath(new URL('../skills/epic/scripts/workspace.mjs', import.meta.url))
  const pidFile = path.join(f.root, 'verify.pid')
  const child = spawn(process.execPath, [helper, 'verify', '--', `echo $$ > '${pidFile}'; exec sleep 300`], { cwd: f.worktree, stdio: 'ignore' })
  const exited = once(child, 'exit')
  let pid = 0
  try {
    for (let i = 0; i < 200 && !pid; i++) {
      if (existsSync(pidFile)) pid = Number(readFileSync(pidFile, 'utf8')) || 0
      else await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(pid, 'the verification command started')
    child.kill('SIGHUP')
    const [code] = await exited
    assert.equal(code, 1)
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    const evidence = JSON.parse(readFileSync(path.join(f.artifacts, '.verification.json'), 'utf8'))
    assert.equal(evidence.ok, false)
    assert.equal(evidence.interrupted, true)
  } finally {
    child.kill('SIGKILL')
    if (pid) try { process.kill(pid, 'SIGKILL') } catch {}
  }
})

test('verification commands cannot leave an earlier green result behind on failure', async () => {
  const f = fixture()
  await ready(f)
  assert.equal((await verify(f.worktree, undefined, 'exit 1')).ok, false)
  assert.throws(() => release(f.main, f.title), /fresh passing verification/)
  assert.equal(git(f.main, 'rev-parse', 'main'), f.base)
})

test('release needs final-commit verification and a current review', async () => {
  const f = fixture()
  implement(f)
  review(f)
  assert.equal((await verify(f.worktree, undefined, f.command)).ok, true)
  commit(f.worktree)
  assert.throws(() => release(f.main, f.title), /fresh passing verification/)
  await verify(f.worktree, undefined, f.command)
  put(f.artifacts, 'spec.md', '# Revised agreement\n')
  assert.throws(() => release(f.main, f.title), /fresh passing verification/)
  await verify(f.worktree, undefined, f.command)
  assert.throws(() => release(f.main, f.title), /Review is missing or stale/)
  review(f)
  const released = release(f.main, f.title)
  assert.equal(git(f.main, 'rev-parse', 'main'), released.commit)
})

test('explicit acceptance can release unreviewed code but cannot waive verification', async () => {
  const f = fixture()
  await ready(f, false)
  assert.throws(() => release(f.main, f.title), /Review is missing or stale/)
  const result = release(f.main, f.title, { acceptUnreviewed: true })
  assert.equal(result.released, true)
  const bad = fixture()
  implement(bad)
  commit(bad.worktree)
  assert.throws(() => release(bad.main, bad.title, { acceptUnreviewed: true }), /Missing regular evidence/)
})

test('release refuses dirty main, dirty epic, and multiple commits', async () => {
  const f = fixture()
  git(f.main, 'config', 'status.showUntrackedFiles', 'no')
  await ready(f)
  put(f.main, 'unrelated.txt', 'Local edit\n')
  assert.throws(() => release(f.main, f.title), /Uncommitted changes/)
  rmSync(path.join(f.main, 'unrelated.txt'))
  put(f.worktree, 'unrelated.txt', 'Local edit\n')
  assert.throws(() => release(f.main, f.title), /Uncommitted changes/)
  commit(f.worktree, 'Additional commit')
  assert.throws(() => release(f.main, f.title), /exactly one commit/)
})

test('a clean rebase invalidates verification even with one commit and ancestor main', async () => {
  const f = fixture()
  await ready(f)
  put(f.main, 'independent.txt', 'Main moved\n')
  commit(f.main, 'Advance main')
  assert.throws(() => release(f.main, f.title), /Main moved/)
  git(f.worktree, 'rebase', 'main')
  assert.equal(git(f.worktree, 'rev-list', '--count', 'main..HEAD'), '1')
  assert.equal(git(f.worktree, 'status', '--porcelain'), '')
  assert.throws(() => release(f.main, f.title), /fresh passing verification/)
  await verify(f.worktree, undefined, f.command)
  assert.throws(() => release(f.main, f.title), /Review is missing or stale/)
  review(f)
  release(f.main, f.title)
})

test('status locates a detached conflicted rebase without claiming it is ready', async () => {
  const f = fixture()
  await ready(f)
  put(f.main, 'app.cjs', 'module.exports = 99;\n')
  commit(f.main, 'Conflicting main')
  const result = spawnSync('git', ['rebase', 'main'], { cwd: f.worktree, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.equal(status(f.main, f.title).interrupted, true)
  assert.throws(() => release(f.main, f.title), /pending Git operation/)
})

test('cleanup archives all handovers, removes only the proven worktree and branch', async () => {
  const f = fixture()
  await ready(f)
  put(f.artifacts, 'architecture.md', '# Design\nAgreed approach\n')
  put(f.artifacts, 'code.md', '# Code\nImplementation notes\n')
  put(f.artifacts, 'ship.md', '# Ship\nFinal decisions\n')
  symlinkSync('spec.md', path.join(f.artifacts, 'spec-link.md'))
  const released = release(f.main, f.title)
  const before = readdirSync(f.artifacts).sort()
  const result = cleanup(f.main, f.title)
  assert.deepEqual(readdirSync(result.archive).sort(), before)
  assert.equal(readFileSync(path.join(result.archive, 'code.md'), 'utf8'), '# Code\nImplementation notes\n')
  assert.equal(existsSync(f.worktree), false)
  assert.equal(git(f.main, 'branch', '--list', f.branch), '')
  assert.equal(git(f.main, 'rev-parse', 'main'), released.commit)
  assert.equal(git(f.main, 'status', '--porcelain'), '')
})

test('cleanup preserves extra ignored local data and unlanded branches', async () => {
  const f = fixture()
  await ready(f)
  assert.throws(() => cleanup(f.main, f.title), /Missing regular evidence/)
  release(f.main, f.title)
  const exclude = path.join(f.main, '.git/info/exclude')
  writeFileSync(exclude, `${readFileSync(exclude, 'utf8')}\n.env\nnode_modules/\n`)
  put(f.worktree, '.env', 'USER_DATA=keep\n')
  put(f.worktree, 'node_modules/pkg/lib/index.js', 'module.exports = 1;\n')
  put(f.worktree, '.epics/notes.txt', 'Outside this epic\n')
  assert.throws(() => cleanup(f.main, f.title), error => {
    const [message, ...listed] = error.message.split('\n')
    assert.match(message, /Ignored files.*preservation/)
    assert.deepEqual(listed.sort(), ['.env', '.epics/notes.txt', 'node_modules/'])
    return true
  })
  assert.equal(readFileSync(path.join(f.worktree, '.env'), 'utf8'), 'USER_DATA=keep\n')
  assert.ok(existsSync(f.worktree))
})

test('a release receipt alone cannot authorize cleanup before main contains the commit', async () => {
  const f = fixture()
  await ready(f)
  const candidate = git(f.worktree, 'rev-parse', 'HEAD')
  // State left by interruption immediately before the fast-forward.
  put(f.artifacts, '.release.json', JSON.stringify({ version: 1, commit: candidate, acceptUnreviewed: false }))
  assert.throws(() => cleanup(f.main, f.title), /exact released/)
  assert.ok(existsSync(f.worktree))
  // State left by interruption immediately after the same fast-forward.
  git(f.main, 'merge', '--ff-only', candidate)
  const result = cleanup(f.main, f.title)
  assert.equal(result.commit, candidate)
  assert.equal(existsSync(f.worktree), false)
})

test('cleanup refuses changed source, divergent archive, and a main that lost the commit', async () => {
  const f = fixture()
  await ready(f)
  const landed = release(f.main, f.title)
  put(f.worktree, 'new.txt', 'Uncommitted work\n')
  assert.throws(() => cleanup(f.main, f.title), /Uncommitted changes/)
  rmSync(path.join(f.worktree, 'new.txt'))
  const archive = path.join(f.main, '.epics', f.title, 'releases', landed.commit)
  put(archive, 'spec.md', 'Other archived data\n')
  assert.throws(() => cleanup(f.main, f.title), /different contents/)
  assert.equal(readFileSync(path.join(archive, 'spec.md'), 'utf8'), 'Other archived data\n')
  // Move only the disposable fixture's main ref to simulate an external rewind.
  git(f.main, 'update-ref', 'refs/heads/main', f.base, landed.commit)
  assert.throws(() => cleanup(f.main, f.title), /exact released/)
  assert.ok(existsSync(f.worktree))
})

test('cleanup refuses symlinked archive directories', async () => {
  const f = fixture()
  await ready(f)
  release(f.main, f.title)
  const foreign = path.join(f.root, 'foreign')
  mkdirSync(foreign)
  symlinkSync(foreign, path.join(f.main, '.epics'))
  assert.throws(() => cleanup(f.main, f.title), /Not a regular directory/)
  assert.deepEqual(readdirSync(foreign), [])
  assert.ok(existsSync(f.worktree))
})

test('each installed skill reaches the shared contract and helper through its own directory', () => {
  const bundle = fileURLToPath(new URL('../skills/epic/', import.meta.url))
  const skills = readdirSync(bundle).filter(name => existsSync(path.join(bundle, name, 'SKILL.md'))).sort()
  assert.deepEqual(skills, ['t-architect', 't-code', 't-review', 't-ship', 't-spec'])
  // Harnesses load skills through links such as ~/.claude/skills/t-spec.
  const installed = path.join(temporary, 'installed-skills')
  mkdirSync(installed)
  const f = fixture()
  for (const name of skills) {
    const text = readFileSync(path.join(bundle, name, 'SKILL.md'), 'utf8')
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`))
    assert.match(text, /\]\(EPIC-CONTRACT\.md\)/)
    assert.doesNotMatch(text, /codex|claude/i, `${name} names no specific harness`)
    symlinkSync(path.join(bundle, name), path.join(installed, name))
    assert.equal(readFileSync(path.join(installed, name, 'EPIC-CONTRACT.md'), 'utf8'), readFileSync(path.join(bundle, 'EPIC-CONTRACT.md'), 'utf8'))
    const helper = path.join(installed, name, 'scripts', 'workspace.mjs')
    const current = JSON.parse(execFileSync(process.execPath, [helper, 'status'], { cwd: f.worktree, encoding: 'utf8' }))
    assert.equal(current.title, f.title)
  }
  assert.doesNotMatch(readFileSync(path.join(bundle, 'EPIC-CONTRACT.md'), 'utf8'), /codex|claude/i)
})
