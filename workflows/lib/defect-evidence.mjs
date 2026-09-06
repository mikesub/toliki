// Canonical handoff between epic-run's deterministic merge gate and the
// bounded defect fixer. The readable summary is reporting only; the complete
// JSON in the collapsed details block remains the authority. Legacy comments
// with raw JSON after the marker stay actionable. Selection requires the
// authenticated author plus the exact issue, PR, branch and head captured by
// the consumer, so mutable or forgeable issue prose never becomes an
// unattended write instruction. Human-facing fields are rendered as inert
// GitHub Markdown; only validated PR and follow-up URLs become links.

import { authenticatedLogin, comment, issueView, readBack } from './github.mjs'

export const DEFECT_EVIDENCE_MARKER = '🤖 defect-fix evidence'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const DETAILS_OPEN = '<details>\n<summary>machine-readable evidence</summary>\n\n```json\n'
const DETAILS_CLOSE = '\n```\n</details>'

const oneLine = value => String(value ?? '').replace(/\s+/g, ' ').trim()
const plainText = value => oneLine(value)
  .replace(/[&\\`*_\[\]{}<>#+!|@~:$]/gu, character => `&#${character.codePointAt(0)};`)
  .replace(/\bwww\.[^\s]*/giu, token => token.replaceAll('.', '&#46;'))

function firstLineValue(...values) {
  for (const value of values) {
    const text = oneLine(value)
    if (text) return text
  }
  return ''
}

function itemTitle(item) {
  return firstLineValue(item?.title, item?.finding?.title)
}

function artifactUrl(value, kind, expectedNumber) {
  let url
  try {
    url = new URL(oneLine(value))
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/([1-9]\d*)\/?$/)
  if (!match || match[3] !== kind) return null
  const number = Number(match[4])
  if (expectedNumber !== undefined && number !== expectedNumber) return null
  return {
    href: url.href,
    number,
    repository: `${url.origin}/${match[1]}/${match[2]}`.toLocaleLowerCase('en-US'),
  }
}

export function validDefectEvidence(value) {
  if (!isObject(value) || value.version !== 1 || !Number.isInteger(value.issue)) return false
  if (!isObject(value.pr) || !Number.isInteger(value.pr.number) || !value.pr.url || !value.pr.branch || !value.pr.head) return false
  if (!isObject(value.requirement) || typeof value.requirement.title !== 'string' || typeof value.requirement.body !== 'string') return false
  if (!Array.isArray(value.blockers) || !value.blockers.length) return false
  return value.blockers.every(blocker => isObject(blocker) && typeof blocker.source === 'string' &&
    typeof blocker.reason === 'string' && Array.isArray(blocker.items) && blocker.items.length > 0)
}

function renderSummary(evidence, followUpFor) {
  const pr = artifactUrl(evidence.pr.url, 'pull', evidence.pr.number)
  const prLabel = pr ? `[#${evidence.pr.number}](${pr.href})` : `PR ${evidence.pr.number}`
  const lines = [
    `PR: ${prLabel} — \`${plainText(evidence.pr.head).slice(0, 7)}\` on \`${plainText(evidence.pr.branch)}\``,
    `Pinned requirement: ${plainText(evidence.requirement.title)}`,
  ]
  for (const blocker of evidence.blockers) {
    const reason = plainText(blocker.reason)
    lines.push(`- \`${plainText(blocker.source)}\` — ${reason}`)
    for (const item of blocker.items) {
      const title = plainText(itemTitle(item))
      const why = plainText(firstLineValue(
        item?.why,
        item?.verdict?.reasoning,
        item?.problem,
        item?.finding?.problem,
        blocker.reason,
      ))
      let line = `  - ${title} — ${why}`
      const followUp = followUpFor?.(item)
      const link = pr && followUp ? artifactUrl(followUp, 'issues') : null
      if (link && link.repository === pr.repository) {
        line += ` — [follow-up #${link.number}](${link.href})`
      }
      lines.push(line)
    }
  }
  return lines.join('\n')
}

export function renderDefectEvidenceSection(evidence, { summary, followUpFor } = {}) {
  if (!validDefectEvidence(evidence)) throw new Error('refusing to render malformed defect-fix evidence')
  const readable = summary === undefined ? renderSummary(evidence, followUpFor) : String(summary)
  return `${readable}\n\n${DETAILS_OPEN}${JSON.stringify(evidence, null, 2)}${DETAILS_CLOSE}`
}

export function renderDefectEvidence(evidence, options = {}) {
  return `${DEFECT_EVIDENCE_MARKER}\n${renderDefectEvidenceSection(evidence, options)}`
}

export function parseDefectEvidenceComment(body) {
  const text = String(body || '')
  if (!text.startsWith(`${DEFECT_EVIDENCE_MARKER}\n`)) return null
  const content = text.slice(DEFECT_EVIDENCE_MARKER.length + 1)

  // The old representation was just the marker and a compact or pretty JSON
  // object. Parsing it first keeps every already-posted repair brief valid.
  try {
    const evidence = JSON.parse(content.trim())
    if (validDefectEvidence(evidence)) return { evidence, summary: renderSummary(evidence) }
  } catch {}

  const details = `\n\n${DETAILS_OPEN}`
  const detailsAt = content.indexOf(details)
  if (detailsAt < 0 || !content.endsWith(DETAILS_CLOSE)) return null
  const summary = content.slice(0, detailsAt)
  const jsonStart = detailsAt + details.length
  const jsonText = content.slice(jsonStart, -DETAILS_CLOSE.length)
  try {
    const evidence = JSON.parse(jsonText)
    if (!validDefectEvidence(evidence)) return null
    // The canonical layout owns a byte-stable machine block. Refuse prose or
    // alternate serialization outside that exact document shape.
    if (jsonText !== JSON.stringify(evidence, null, 2)) return null
    return { evidence, summary }
  } catch {
    return null
  }
}

export function parseDefectEvidence(body) {
  return parseDefectEvidenceComment(body)?.evidence || null
}

export function matchingDefectEvidenceComment(comments, { actor, issue, prNumber, branch, head }) {
  const login = String(actor || '').toLowerCase()
  if (!login || !Array.isArray(comments)) return null
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i]
    if (String(comment?.author?.login || '').toLowerCase() !== login) continue
    const record = parseDefectEvidenceComment(comment?.body)
    if (!record) continue
    const { evidence } = record
    if (evidence.issue !== Number(issue) || evidence.pr.number !== Number(prNumber)) continue
    if (evidence.pr.branch !== branch || evidence.pr.head !== head) continue
    return record
  }
  return null
}

export function matchingDefectEvidence(comments, criteria) {
  return matchingDefectEvidenceComment(comments, criteria)?.evidence || null
}

// The fixer addresses one flat, numbered list even though the durable envelope
// retains blocker groups for provenance. Keep the numbering and filtering in
// this module so epic-run's publisher and defect-run's later-round handoff
// cannot disagree about which item an index names.
export function defectEvidenceItems(evidence) {
  if (!validDefectEvidence(evidence)) throw new Error('refusing to flatten malformed defect-fix evidence')
  const items = []
  for (let blockerIndex = 0; blockerIndex < evidence.blockers.length; blockerIndex++) {
    const blocker = evidence.blockers[blockerIndex]
    for (let itemIndex = 0; itemIndex < blocker.items.length; itemIndex++) {
      const item = blocker.items[itemIndex]
      items.push({
        index: items.length + 1,
        blockerIndex,
        itemIndex,
        source: blocker.source,
        reason: blocker.reason,
        title: itemTitle(item) || `defect ${items.length + 1}`,
        item,
      })
    }
  }
  return items
}

export function filterDefectEvidence(evidence, indexes, { head } = {}) {
  const flat = defectEvidenceItems(evidence)
  const wanted = new Set(indexes)
  if (!head || wanted.size !== indexes.length || [...wanted].some(index => !Number.isInteger(index) || index < 1 || index > flat.length)) {
    throw new Error('refusing to filter defect-fix evidence with invalid item indexes or head')
  }
  const blockers = evidence.blockers.map((blocker, blockerIndex) => ({
    ...blocker,
    items: blocker.items.filter((_item, itemIndex) =>
      flat.some(entry => entry.blockerIndex === blockerIndex && entry.itemIndex === itemIndex && wanted.has(entry.index))),
  })).filter(blocker => blocker.items.length)
  const filtered = { ...evidence, pr: { ...evidence.pr, head }, blockers }
  if (!validDefectEvidence(filtered)) throw new Error('refusing to publish empty filtered defect-fix evidence')
  return filtered
}

// Canonical publication is one authenticated write/readback operation shared
// by epic-run and defect-run. `options` may be a function because epic-run is
// already inside its one terminal-report window and must ask for the remaining
// budget separately for each GitHub call.
export async function publishDefectEvidence({ issue, evidence, actor, renderOptions, options } = {}) {
  if (!validDefectEvidence(evidence) || evidence.issue !== Number(issue)) {
    throw new Error('refusing to publish malformed or mismatched defect-fix evidence')
  }
  const opts = () => typeof options === 'function' ? options() : options
  const login = actor || await authenticatedLogin(opts())
  await comment(issue, renderDefectEvidence(evidence, renderOptions), opts())
  const criteria = {
    actor: login,
    issue,
    prNumber: evidence.pr.number,
    branch: evidence.pr.branch,
    head: evidence.pr.head,
  }
  const seen = await readBack(
    () => issueView(issue, 'comments', opts()),
    view => !!matchingDefectEvidence(view.comments, criteria),
    opts())
  if (!seen.matched) throw new Error('canonical defect-fix evidence was not observed after posting')
  return matchingDefectEvidenceComment(seen.observed.comments, criteria)
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
