// A single status comment on the issue, EDITED in place for the life of a run.
//
// The label lifecycle already says which state an issue is in; what it cannot
// say is whether an `in-progress` run is alive and how far it got. That gap is
// what sends an operator to `tmux capture-pane` for a question GitHub should be
// able to answer, and it is the one thing /triage cannot see without ssh.
//
// Edited rather than re-posted, which is what makes it affordable at all — the
// three reasons per-phase comments were removed all turn on re-posting: an edit
// notifies no watcher, this carries run state rather than a second copy of the
// PR body, and the orchestrator does it directly instead of spending an agent
// spawn on the critical path. The PR keeps its job (what was built, the review
// outcome, line comments); this only answers "alive, and where?".
//
// Every call is BEST EFFORT and swallows its errors. A status comment is
// reporting, never a gate — a GitHub blip must not fail a run that is building
// correctly, and a run whose status went quiet is exactly the case the stale
// timestamp is meant to describe.
import { execFile } from 'node:child_process'

// Its own clock rather than runtime's: runtime registers THIS module's hooks,
// and importing back the other way would make the two files circular.
const ts = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const GH_TIMEOUT_MS = 20_000
// Long enough that a chatty phase cannot turn into an API burst, short enough
// that "last updated" stays a believable liveness signal.
const MIN_INTERVAL_MS = 90_000

let issue = null
let session = ''
let phases = []
let commentId = null
let startedAt = null
let currentPhase = ''
let lastNote = ''
let lastWriteAt = 0
let inFlight = false
let disabled = false

const gh = (args) => new Promise((resolve) => {
  execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout) => {
    resolve(err ? null : String(stdout || '').trim())
  })
})

export function initStatus({ issue: n, session: s, phases: p } = {}) {
  if (!n) return                       // slug mode has no issue to report on
  issue = n
  session = s || ''
  phases = Array.isArray(p) ? p : []
  startedAt = ts()
}

function body() {
  const i = phases.indexOf(currentPhase)
  const step = i >= 0 && phases.length ? ` (${i + 1}/${phases.length})` : ''
  const lines = [
    `🤖 **epic-run**${session ? ` · \`${session}\`` : ''} · phase: **${currentPhase || 'starting'}**${step}`,
    `started ${startedAt} · updated ${ts()}`,
  ]
  if (lastNote) lines.push('', lastNote)
  lines.push('', '_Live status, edited in place. The PR carries what was built and the review outcome._')
  return lines.join('\n')
}

// Writes are serialised through `inFlight`: two overlapping creates would post
// two comments and then edit only one of them, leaving a stray forever.
async function write(force) {
  if (disabled || !issue || inFlight) return
  const now = Date.now()
  if (!force && now - lastWriteAt < MIN_INTERVAL_MS) return
  inFlight = true
  lastWriteAt = now
  try {
    const text = body()
    if (!commentId) {
      const url = await gh(['issue', 'comment', String(issue), '--body', text])
      const m = url && url.match(/#issuecomment-(\d+)/)
      if (m) commentId = m[1]
      // No id parsed means every later update would post ANOTHER comment, so
      // stop after this one rather than dribble a comment per phase.
      else disabled = true
      return
    }
    await gh(['api', '--method', 'PATCH', `repos/{owner}/{repo}/issues/comments/${commentId}`, '-f', `body=${text}`])
  } finally {
    inFlight = false
  }
}

export function statusPhase(title) {
  if (!issue) return
  currentPhase = title
  lastNote = ''
  void write(true)                     // a phase change is always worth a write
}

export function statusNote(message) {
  if (!issue || !message) return
  lastNote = String(message).length > 300 ? `${String(message).slice(0, 297)}…` : String(message)
  void write(false)                    // throttled: milestones can arrive in bursts
}

export function statusFinish(outcome) {
  if (!issue) return Promise.resolve()
  currentPhase = 'finished'
  lastNote = outcome ? String(outcome) : ''
  lastWriteAt = 0
  return write(true)
}
