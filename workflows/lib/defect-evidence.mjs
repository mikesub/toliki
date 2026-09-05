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

// ───────────────────────── the landing record ─────────────────────────
// The second half of the same handoff, written by the defect fixer instead of
// epic-run. A fixer that pushed a verified and checked repair and then could
// not confirm the label swap leaves the issue back in the fixer queue with the
// PR already carrying the amended head — and the evidence envelope still bound
// to the head BEFORE that push, so the next attempt finds no matching evidence
// and refuses a complete repair as untrusted (toliki #16).
//
// So the audit comment the fixer posts before its landing swap carries this
// record: the same authenticated, PR/head-bound shape, plus the head the
// evidence it worked from was bound to. A later attempt that finds one for the
// CURRENT head, whose priorHead has a matching evidence envelope, knows the
// repair on this head is already done and only the landing is left. It is
// carried inside the audit comment rather than as its own comment, so the
// human-readable record and the machine-readable one cannot drift apart.
export const DEFECT_REPAIR_MARKER = '🤖 defect-fix landing record'

export function validDefectRepair(value) {
  if (!isObject(value) || value.version !== 1 || !Number.isInteger(value.issue)) return false
  if (!isObject(value.pr) || !Number.isInteger(value.pr.number) || !value.pr.url) return false
  if (!value.pr.branch || !value.pr.head || !value.pr.priorHead || value.pr.head === value.pr.priorHead) return false
  if (typeof value.verify !== 'string' || !Number.isFinite(value.checkConfidence)) return false
  return true
}

export function renderDefectRepair(record) {
  if (!validDefectRepair(record)) throw new Error('refusing to render a malformed defect-fix landing record')
  return `${DEFECT_REPAIR_MARKER}\n${JSON.stringify(record)}`
}

// The marker is a line of a longer comment, so the record is read as the line
// after it rather than as the whole body.
export function parseDefectRepair(body) {
  const lines = String(body || '').split('\n')
  const at = lines.indexOf(DEFECT_REPAIR_MARKER)
  if (at < 0) return null
  try {
    const value = JSON.parse(lines[at + 1] || '')
    return validDefectRepair(value) ? value : null
  } catch {
    return null
  }
}

export function matchingDefectRepair(comments, { actor, issue, prNumber, branch, head }) {
  const login = String(actor || '').toLowerCase()
  if (!login || !Array.isArray(comments)) return null
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]
    if (String(comment?.author?.login || '').toLowerCase() !== login) continue
    const record = parseDefectRepair(comment?.body)
    if (!record) continue
    if (record.issue !== Number(issue) || record.pr.number !== Number(prNumber)) continue
    if (record.pr.branch !== branch || record.pr.head !== head) continue
    return record
  }
  return null
}
