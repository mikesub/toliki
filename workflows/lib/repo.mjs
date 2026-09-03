// The pipelines' repository transport: git, npm, the target repo's layout and
// the run's .epics/<slug>/ artifacts. Deterministic and worktree-local; a
// model step never runs git for the run's own bookkeeping.
//
// Discovery is the one per-project contract, exactly one line: a package is a
// directory whose package.json declares `scripts.verify`. It is NOT configured
// anywhere — a config file would restate what each repo already states and go
// stale the moment the repo changed shape — and it is read here, in code, so
// a package cannot be missed by a model that did not look.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { sh, must } from './proc.mjs'

const GIT_TIMEOUT_MS = 5 * 60 * 1000
const NPM_CI_TIMEOUT_MS = 30 * 60 * 1000
// Generous by design: verify runs the project's whole gate, which can
// legitimately boot a database tier. A run this long is pathological, not slow.
const VERIFY_TIMEOUT_MS = Number(process.env.EPIC_AGENT_TIMEOUT_MS) || 90 * 60 * 1000

export const git = (args, opts = {}) => sh('git', args, { timeoutMs: GIT_TIMEOUT_MS, ...opts })
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
// Otherwise skipped: npm ci wipes node_modules first, so a blind re-run is
// minutes of dead time. A failed install throws — the verify gate downstream
// is invalid without deps, and an invalid gate must not look like a green one.
export async function ensureDeps(packages, { pairs = [] } = {}) {
  const lines = []
  for (const pkg of packages) {
    const dir = pkg === '.' ? '.' : pkg
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
// the detail line carries the first genuinely failing thing for a human.
export async function runVerify(packages, { timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
  const details = []
  let green = true
  for (const pkg of packages) {
    const r = await sh('npm', ['run', 'verify'], { cwd: pkg === '.' ? '.' : pkg, timeoutMs, stdoutCap: 256 * 1024 })
    if (r.ok) { details.push(`${pkg} — pass`); continue }
    green = false
    const tail = r.timedOut ? 'timed out' : ((r.err || r.out).split('\n').filter(l => l.trim()).slice(-3).join(' | ') || `exit ${r.code}`)
    details.push(`${pkg} — fail: ${tail}`)
  }
  return { green, detail: details.join('; ') }
}

// ───────────────────────── git state ─────────────────────────
export async function rebaseInProgress() {
  for (const p of ['rebase-merge', 'rebase-apply']) {
    const r = await git(['rev-parse', '--git-path', p])
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
// resume so the phase log tells the whole story of the branch.
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
// the log line is appended. Agents also write notes here, which is why nothing
// is ever rewritten wholesale.
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
`
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'architecture.md'), text)
  return text
}

// review.md, rendered from the verdicts. Confirmed findings first, highest
// severity first; refuted ones under a section fixes-after-review and ship
// are told never to act on — recorded so a human can double-check the discard.
export function renderReview(dir, confirmed, unconfirmed) {
  const order = { Critical: 0, Important: 1 }
  const sorted = [...confirmed].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  const finding = (f, i) => `### Finding ${i + 1}: ${f.title}
- severity: ${f.severity}
- confidence: ${f.confidence}
- location: ${f.location}
- problem: ${f.problem}
- fix: ${f.fix}
- gate: ${f.gate}
`
  let text = `# Review\n\n## Confirmed findings\n\n`
  text += sorted.length ? sorted.map(finding).join('\n') : 'No finding survived adversarial verification.\n'
  if (unconfirmed.length) {
    text += `\n## Unconfirmed — not fixed\n\nFixes-after-review and ship MUST NOT act on these. Adversarial verification refuted them or could not confirm them; they are recorded only so a human can double-check the discard.\n\n`
    text += unconfirmed.map(f => `- ${f.title} (${f.location}; ${f.severity}): ${f.verdict?.reasoning || 'no reasoning recorded'}`).join('\n') + '\n'
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'review.md'), text)
  return text
}
