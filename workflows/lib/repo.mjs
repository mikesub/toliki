// The pipelines' repository transport: git, npm, the target repo's layout and
// the run's .epics/<slug>/ artifacts. Deterministic and worktree-local; a
// model step never runs git for the run's own bookkeeping.
//
// Discovery is the one per-project contract, exactly one line: a package is a
// directory whose package.json declares `scripts.verify`. It is NOT configured
// anywhere — a config file would restate what each repo already states and go
// stale the moment the repo changed shape — and it is read here, in code, so
// a package cannot be missed by a model that did not look.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stripVTControlCharacters } from 'node:util'
import path from 'node:path'
import { sh, must } from './proc.mjs'

const GIT_TIMEOUT_MS = 5 * 60 * 1000
const NPM_CI_TIMEOUT_MS = 30 * 60 * 1000
// Generous by design: verify runs the project's whole gate, which can
// legitimately boot a database tier. A run this long is pathological, not slow.
const VERIFY_TIMEOUT_MS = Number(process.env.EPIC_AGENT_TIMEOUT_MS) || 90 * 60 * 1000

// Model phases never own Git transport. Neutralize repository hooks on every
// orchestrator Git call so a hook or config mutation cannot execute after the
// last verify/review and change the bytes a deterministic commit, rebase or
// push carries. Append our config entry so it wins over inherited entries,
// while preserving caller-specific environments such as GIT_EDITOR and
// GIT_INDEX_FILE.
const hooklessGitEnv = (source = process.env) => {
  const raw = source.GIT_CONFIG_COUNT
  const count = raw === undefined ? 0 : Number(raw)
  if (raw !== undefined && (!Number.isInteger(count) || count < 0 || String(count) !== String(raw))) {
    throw new Error(`invalid inherited GIT_CONFIG_COUNT: ${String(raw)}`)
  }
  return {
    ...source,
    GIT_CONFIG_COUNT: String(count + 1),
    [`GIT_CONFIG_KEY_${count}`]: 'core.hooksPath',
    [`GIT_CONFIG_VALUE_${count}`]: '/dev/null',
  }
}

export const git = (args, opts = {}) => {
  const { env = process.env, ...rest } = opts
  return sh('git', args, { timeoutMs: GIT_TIMEOUT_MS, ...rest, env: hooklessGitEnv(env) })
}
export async function gitOut(args, what = `git ${args[0]}`) {
  return must(await git(args), what)
}

// ───────────────────────── layout ─────────────────────────
// The repo root and each directory one level below it, skipping node_modules
// and dotdirs. "." stands for the root itself.
export function discoverPackages(root = '.') {
  const declaresVerify = (dir) => {
    const file = path.join(dir, 'package.json')
    if (!existsSync(file)) return false
    try {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      return !!(pkg && pkg.scripts && typeof pkg.scripts.verify === 'string' && pkg.scripts.verify.trim())
    } catch {
      return false
    }
  }
  const found = []
  if (declaresVerify(root)) found.push('.')
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch { entries = [] }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) continue
    if (declaresVerify(path.join(root, e.name))) found.push(e.name)
  }
  return found
}

// How the package list reads inside a prompt: "frontend/, backend/".
export const pkgList = (packages) => packages.map(p => (p === '.' ? 'the repo root' : `${p}/`)).join(', ')

// ───────────────────────── deps ─────────────────────────
// Whether a package's lockfile differs between two refs. A ref that cannot be
// diffed counts as changed: the safe answer is to reinstall.
async function lockfileChanged(pkg, pairs) {
  for (const [a, b] of pairs) {
    const r = await git(['diff', '--quiet', a, b, '--', path.join(pkg, 'package-lock.json')])
    if (r.code !== 0) return true
  }
  return false
}

// `npm ci` where node_modules is missing, or where the lockfile moved between
// the given refs (a worktree made from the clone's HEAD may predate the base).
// Skipped entirely when a package carries no package-lock.json: npm ci requires
// one by contract and can never succeed without it, and a package with none has
// no npm dependency tree to install (e.g. a Bun-only project whose verify shells
// out to `bun test`) — `npm run verify` downstream needs no node_modules either.
// Otherwise skipped when deps are already present: npm ci wipes node_modules
// first, so a blind re-run is minutes of dead time. A failed install throws —
// the verify gate downstream is invalid without deps, and an invalid gate must
// not look like a green one.
export async function ensureDeps(packages, { pairs = [] } = {}) {
  const lines = []
  for (const pkg of packages) {
    const dir = pkg === '.' ? '.' : pkg
    if (!existsSync(path.join(dir, 'package-lock.json'))) {
      lines.push(`${pkg}: no package-lock.json, nothing to install`)
      continue
    }
    let why = null
    if (!existsSync(path.join(dir, 'node_modules'))) why = 'node_modules missing'
    else if (pairs.length && await lockfileChanged(dir, pairs)) why = 'lockfile changed'
    if (!why) { lines.push(`${pkg}: deps present`); continue }
    const r = await sh('npm', ['ci'], { cwd: dir, timeoutMs: NPM_CI_TIMEOUT_MS, stdoutCap: 64 * 1024 })
    must(r, `npm ci in ${pkg} (${why})`)
    lines.push(`${pkg}: npm ci (${why})`)
  }
  return lines
}

// ───────────────────────── verify ─────────────────────────
// The project's whole gate, package by package. The exit code is the verdict;
// the detail and retry tail independently bound stdout and stderr so noise in
// one stream cannot displace the useful failure from the other. Terminal
// formatting is removed at this boundary: these diagnostics flow into model
// prompts, logs and GitHub Markdown, where raw escape/control bytes are corrupt
// markup rather than useful evidence.
// Structured failures retain bounded output and process status so test-first
// can match its expected assertion without treating a timeout or spawn failure as RED.
const plainDiagnostic = value => stripVTControlCharacters(String(value || ''))
  .replace(/\r\n?/gu, '\n')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '')

export async function runVerify(packages, { timeoutMs = VERIFY_TIMEOUT_MS, tailLines = 40 } = {}) {
  const details = []
  const evidence = []
  const tails = []
  const failures = []
  let green = true
  for (const pkg of packages) {
    const r = await sh('npm', ['run', 'verify'], { cwd: pkg === '.' ? '.' : pkg, timeoutMs, stdoutCap: 256 * 1024 })
    const stdout = plainDiagnostic(r.out)
    const stderr = plainDiagnostic(r.err)
    const stdoutLines = stdout.split('\n').filter(l => l.trim())
    const stderrLines = stderr.split('\n').filter(l => l.trim())
    const evidenceLines = [...stdoutLines.slice(-3), ...stderrLines.slice(-3)]
    evidence.push(`${pkg} — ${evidenceLines.join(' | ') || (r.ok ? 'exit 0' : `exit ${r.code}`)}`)
    if (r.ok) { details.push(`${pkg} — pass`); continue }
    green = false
    const detailLines = [...stdoutLines.slice(-3), ...stderrLines.slice(-3)]
    const last = r.timedOut ? 'timed out' : (detailLines.join(' | ') || `exit ${r.code}`)
    details.push(`${pkg} — fail: ${last}`)
    const output = `${stdout}\n${stderr}`.trim()
    const stdoutTail = tailLines > 0 ? stdoutLines.slice(-tailLines) : []
    const stderrTail = tailLines > 0 ? stderrLines.slice(-tailLines) : []
    tails.push(`--- ${pkg}: npm run verify ${r.timedOut ? 'timed out' : `exited ${r.code}`} ---\n${[...stdoutTail, ...stderrTail].join('\n')}`)
    failures.push({ package: pkg, code: r.code, timedOut: r.timedOut, spawnError: !!r.spawnError, output })
  }
  return { green, detail: details.join('; '), evidence: evidence.join('; '), tail: tails.join('\n'), failures }
}

// ───────────────────────── git state ─────────────────────────
// opts is forwarded verbatim to both probes, so a caller inside a terminal
// window can bound them the way it bounds the abort that follows. A probe that
// times out is not ok and so reads as no rebase in progress: the blocked run
// skips its abort and the next run's prepare, which aborts unconditionally,
// is the recovery.
export async function rebaseInProgress(opts = {}) {
  for (const p of ['rebase-merge', 'rebase-apply']) {
    const r = await git(['rev-parse', '--git-path', p], opts)
    if (r.ok && r.out && existsSync(path.resolve(r.out))) return true
  }
  return false
}

// .epics/ must never land in a commit — it is the run's scratch, and a WIP
// commit that captured it would carry the builder's notes into the PR. A
// project that does not ignore it gets a worktree-local exclude.
export async function ensureEpicsIgnored() {
  const r = await git(['check-ignore', '-q', '.epics'])
  if (r.ok) return
  const exclude = await git(['rev-parse', '--git-path', 'info/exclude'])
  if (!exclude.ok) return
  const file = path.resolve(exclude.out)
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, '\n.epics/\n')
}

// A durability checkpoint on the branch, NOT the final commit: ship squashes
// the branch into one commit later. Never carries "Closes #N" and never pushes.
export async function checkpoint(slug, label) {
  await gitOut(['add', '-A'], 'git add -A')
  const staged = await git(['diff', '--cached', '--quiet'])
  if (staged.code === 0) return 'clean'
  await gitOut(['commit', '-q', '-m', `wip(epic ${slug}): ${label} checkpoint`], 'git commit (checkpoint)')
  return 'committed'
}

// The manual flow's stand-in for a checkpoint: intent-to-add, so new files show
// in the `git diff` the blind reviewers read. Respects .gitignore.
export async function intentToAdd() {
  await gitOut(['add', '-N', '.'], 'git add -N')
}

// Push outcomes that mean "someone else holds this ref", as opposed to a
// network or auth failure: the former is a refusal the run reports, the latter
// a blocker.
export const pushRejected = (r) => /rejected|non-fast-forward|stale info|fetch first/i.test(`${r.err}\n${r.out}`)

// ───────────────────────── evidence capture ─────────────────────────
// Judging phases have no shell under Claude and only a read-only sandbox under
// Codex, so the orchestrator captures the diff they judge. Disable external
// diff/textconv drivers: repository configuration is untrusted input here, and
// capturing evidence must not execute project code. Returns null when the
// capture failed, which every caller treats as missing evidence rather than as
// an empty change.
export async function captureDiff(refs = [], { stat = false, paths = [] } = {}) {
  const args = ['diff', '--no-ext-diff', '--no-textconv', stat ? '--stat' : '--binary', ...refs]
  if (paths.length) args.push('--', ...paths)
  const result = await git(args)
  return result.ok ? result.out : null
}

// Which paths a change touched, derived here rather than reported by the step
// that made it. A repair agent's own list of files is a claim like any other,
// and the audit comment that names them is a durable record — so the record is
// built from what git says the tree did, not from what the model said it did.
// Same untrusted-configuration boundary as captureDiff. Returns null when the
// capture failed, which callers report as unknown rather than as "no files".
export async function changedFiles(refs = [], { paths = [] } = {}) {
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--name-only', ...refs]
  if (paths.length) args.push('--', ...paths)
  const result = await git(args)
  return result.ok ? result.out.split('\n').map(line => line.trim()).filter(Boolean) : null
}

// A tree object for the whole worktree — tracked content whether staged or not,
// plus untracked files — written through a THROWAWAY index so neither the run's
// index nor a user's index is disturbed. It exists so a delta can be taken
// ACROSS an uncommitted edit: a correction leaves its work in the working tree,
// and `git diff HEAD` cannot separate it from the repair that preceded it.
//
// The index is seeded from HEAD before staging. An index that starts empty
// knows no path as tracked, so `git add -A` applies the ignore rules to all of
// them and a file that is tracked but ALSO matched by an ignore rule (a
// committed build artifact, a checked-in config) is missing from the snapshot.
// read-tree makes it see every path git itself would ship. Untracked files are
// therefore included, which is what makes a new file part of the delta a
// checker receives.
export async function worktreeTree() {
  const work = mkdtempSync(path.join(tmpdir(), 'toliki-tree-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(work, 'index') }
    if (!(await git(['read-tree', 'HEAD'], { env })).ok) return null
    if (!(await git(['add', '-A'], { env })).ok) return null
    const tree = await git(['write-tree'], { env })
    return tree.ok ? tree.out : null
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ───────────────────────── slugs ─────────────────────────
// "<issue>-<2-4 word kebab gist of the title>", whole slug ≤ 40 chars. Derived
// mechanically: a resume adopts the branch's own slug anyway, so nothing
// depends on two runs deriving the same one.
export function slugify(issue, title) {
  const words = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean)
  const stop = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'as', 'is'])
  const picked = []
  for (const w of words) {
    if (picked.length && stop.has(w)) continue
    picked.push(w)
    if (picked.length === 4) break
  }
  let short = (picked.length ? picked : ['issue']).join('-')
  const max = 40 - String(issue).length - 1
  while (short.length > max && short.includes('-')) short = short.slice(0, short.lastIndexOf('-'))
  if (short.length > max) short = short.slice(0, max)
  return `${issue}-${short.replace(/-+$/, '') || 'issue'}`
}

// ───────────────────────── .epics/<slug>/ artifacts ─────────────────────────
export const epicDir = (slug) => `.epics/${slug}`

export function writeRequirements(dir, issue, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'requirements.md'), `Issue: #${issue}\n\n${String(body || '').trim()}\n`)
}

export function readRequirements(dir) {
  return readFileSync(path.join(dir, 'requirements.md'), 'utf8')
}

// epic.md is the run's own log; fresh on a new run, kept and appended to on a
// resume so the phase log tells the whole story of the branch. It is a factual
// record of what the orchestrator did and what each step decided, so the
// orchestrator writes every line of it: a run record maintained by the models
// being recorded is a claim, and one of them forgetting to append is a hole.
export function initEpicMd(dir, { title, slug, issue }) {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'epic.md')
  if (existsSync(file)) {
    appendFileSync(file, '- prepare: resumed\n')
    return 'resumed'
  }
  writeFileSync(file, `# ${title}\n- slug: ${slug}\n- issue: ${issue}\n- phase: prepare\n- approach:\n\n## Phase log\n- prepare: done\n`)
  return 'fresh'
}

// Tolerant edits: the phase line and approach line are replaced where present,
// the log line is appended. The orchestrator is the only writer — a model
// returns its decisions and reasons in structured output and this file records
// them — but nothing is ever rewritten wholesale, because a resumed run appends
// to the log an earlier run left behind.
export function updateEpicMd(dir, { phase, approach, log } = {}) {
  const file = path.join(dir, 'epic.md')
  let text = existsSync(file) ? readFileSync(file, 'utf8') : '# epic\n- phase:\n- approach:\n\n## Phase log\n'
  if (phase !== undefined) text = /^- phase:.*$/m.test(text) ? text.replace(/^- phase:.*$/m, `- phase: ${phase}`) : text + `\n- phase: ${phase}`
  if (approach !== undefined) text = /^- approach:.*$/m.test(text) ? text.replace(/^- approach:.*$/m, `- approach: ${approach}`) : text + `\n- approach: ${approach}`
  if (log) {
    if (!/## Phase log/.test(text)) text = text.replace(/\s*$/, '\n\n## Phase log\n')
    text = text.replace(/\s*$/, `\n- ${log}\n`)
  }
  writeFileSync(file, text)
}

// architecture.md, rendered from the design JSON. The contract section is kept
// verbatim: the red step writes its tests from this file alone, WITHOUT seeing
// the implementation, so anything dropped there becomes an untested surface.
export function renderArchitecture(dir, d) {
  const steps = (d.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n')
  const files = (d.files || []).map(f => `- ${f}`).join('\n')
  const text = `Approach: ${d.approach} — ${String(d.rationale || '').replace(/\s+/g, ' ').trim()}

## Rationale

${d.rationale}

## Ordered build steps

${steps}

## Files to create/modify

${files}

## Public contract / API surface

${d.contract}

## Trade-offs deliberately accepted

${d.tradeoffs}

## Verification plan

Mode: ${d.verification.mode}

${d.verification.rationale}

${d.verification.evidence.map(item => `- ${item}`).join('\n')}
`
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'architecture.md'), text)
  writeFileSync(path.join(dir, 'architecture.json'), `${JSON.stringify(d, null, 2)}\n`)
  return text
}
// delivery.json: the run's delivery record, written from what the coding phase
// returned. It sits beside architecture.json for the same reason — a re-run
// that still has this scratch directory publishes the checkpoint straight from
// it, and one that lost it reconstructs the record read-only rather than
// inventing a rationale for a change nobody in that run made.
export function renderDelivery(dir, delivery) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'delivery.json'), `${JSON.stringify(delivery, null, 2)}\n`)
  return delivery
}

// The assessment ledger preserves every finding and its index. A coder's
// dispute is only a claim; only the independent final review can mark an item
// cleared. The published record is rendered from those same structured verdicts
// — including uncertainty and what the review found still unmet — never
// reconstructed from builder prose or matched by potentially duplicate titles.
export function renderReview(dir, items, { checked = false, note = null, unmet = [] } = {}) {
  let text = '# Review\n\n'
  if (checked) {
    text += '## Final review\n\n'
    if (note) text += `${note}.\n\n`
    text += `${items.filter(item => item.cleared && item.verdict?.verdict === 'resolved').length} resolved; ${items.filter(item => item.cleared && item.verdict?.verdict === 'disproved').length} disproved; ${items.filter(item => !item.cleared).length} unresolved.\n\n`
    if (unmet.length) {
      text += '### Unmet requirements\n\n'
      for (const u of unmet) text += `- ${u.requirement} — ${u.evidence}\n`
      text += '\n'
    }
  }
  text += '## Findings\n\n'
  if (!items.length) text += 'No review findings.\n'
  items.forEach((item, i) => {
    const { finding: f, assessment, verdict } = item
    const state = item.cleared
      ? (verdict.verdict === 'disproved' ? 'disproved — not deferred work' : 'resolved')
      : verdict?.defect === true && verdict.confidence >= 75
        ? 'OPEN — unresolved, defect still present'
        : 'OPEN — unresolved; a human decides'
    text += `### Finding ${i + 1}: ${f.title}
- severity: ${f.severity}
- confidence: ${f.confidence}
- location: ${f.location}
- problem: ${f.problem}
- fix: ${f.fix}
- gate: ${f.gate}
- assessment: ${assessment ? `${assessment.action} — ${assessment.reason}` : 'pending'}
- final verdict: ${verdict ? `${verdict.verdict} (confidence ${verdict.confidence}) — ${verdict.reasoning}` : 'pending'}
- state: ${state}

`
  })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'review.md'), text)
  return text
}
