// Canonical handoff between epic-run's deterministic merge gate and the
// bounded defect fixer. The marker is human-readable; the JSON is the authority.
// Selection requires the authenticated author plus the exact issue, PR, branch
// and head captured by the consumer, so mutable or forgeable issue prose never
// becomes an unattended write instruction.

export const DEFECT_EVIDENCE_MARKER = '🤖 defect-fix evidence'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validDefectEvidence(value) {
  if (!isObject(value) || value.version !== 1 || !Number.isInteger(value.issue)) return false
  if (!isObject(value.pr) || !Number.isInteger(value.pr.number) || !value.pr.url || !value.pr.branch || !value.pr.head) return false
  if (!isObject(value.requirement) || typeof value.requirement.title !== 'string' || typeof value.requirement.body !== 'string') return false
  if (!Array.isArray(value.blockers) || !value.blockers.length) return false
  return value.blockers.every(blocker => isObject(blocker) && typeof blocker.source === 'string' &&
    typeof blocker.reason === 'string' && Array.isArray(blocker.items) && blocker.items.length > 0)
}

export function renderDefectEvidence(evidence) {
  if (!validDefectEvidence(evidence)) throw new Error('refusing to render malformed defect-fix evidence')
  return `${DEFECT_EVIDENCE_MARKER}\n${JSON.stringify(evidence)}`
}

export function parseDefectEvidence(body) {
  const text = String(body || '')
  if (!text.startsWith(`${DEFECT_EVIDENCE_MARKER}\n`)) return null
  try {
    const value = JSON.parse(text.slice(DEFECT_EVIDENCE_MARKER.length).trim())
    return validDefectEvidence(value) ? value : null
  } catch {
    return null
  }
}

export function matchingDefectEvidence(comments, { actor, issue, prNumber, branch, head }) {
  const login = String(actor || '').toLowerCase()
  if (!login || !Array.isArray(comments)) return null
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]
    if (String(comment?.author?.login || '').toLowerCase() !== login) continue
    const evidence = parseDefectEvidence(comment?.body)
    if (!evidence) continue
    if (evidence.issue !== Number(issue) || evidence.pr.number !== Number(prNumber)) continue
    if (evidence.pr.branch !== branch || evidence.pr.head !== head) continue
    return evidence
  }
  return null
}
