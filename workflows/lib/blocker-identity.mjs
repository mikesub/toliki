// Run-local identity for blockers that cross independent model records before
// ship may turn one into a follow-up issue. Display text is presentation: it
// can be duplicated, reordered or rephrased, so it is never used for lookup.
// The WeakMap also keeps these opaque IDs out of durable defect evidence.

const objectLike = value => value !== null && typeof value === 'object'

export function createBlockerIdentityRegistry() {
  const blockerIds = new WeakMap()
  const blockersById = new Map()
  let serial = 0

  function idFor(item) {
    if (!objectLike(item)) return null
    return blockerIds.get(item) || idFor(item.finding)
  }

  function ensureId(item) {
    if (!objectLike(item)) throw new Error('cannot assign a blocker ID to a non-object item')
    const existing = idFor(item)
    if (existing) {
      blockerIds.set(item, existing)
      return existing
    }
    const identity = objectLike(item.finding) ? item.finding : item
    const id = `blocker-${++serial}`
    blockerIds.set(identity, id)
    blockerIds.set(item, id)
    blockersById.set(id, identity)
    return id
  }

  function catalog(items) {
    const seen = new Set()
    const entries = []
    for (const item of items) {
      if (!objectLike(item)) continue
      const blockerId = ensureId(item)
      if (seen.has(blockerId)) continue
      seen.add(blockerId)
      entries.push({ blockerId, item })
    }
    const text = entries.map(({ blockerId, item }) => {
      const source = objectLike(item.finding) ? item.finding : item
      const title = String(source.title || item.title || '').replace(/\s+/g, ' ').trim()
      const location = String(source.location || item.location || '').replace(/\s+/g, ' ').trim()
      const reason = String(item.why || item.verdict?.reasoning || source.problem || source.why || '').replace(/\s+/g, ' ').trim()
      return `- ${blockerId}: ${title}${location ? ` [${location}]` : ''}${reason ? ` — ${reason}` : ''}`
    }).join('\n') || '(none)'
    return { text, ids: new Set(entries.map(entry => entry.blockerId)) }
  }

  function registerShipDeferrals(decision, expectedIds) {
    const used = new Set()
    const deferred = Array.isArray(decision.deferred) ? decision.deferred : []
    decision.deferred = deferred.map(raw => {
      const requested = String(raw?.blockerId || '').trim()
      if (!requested) throw new Error('Ship returned a deferred item without a blocker ID')
      if (requested !== 'new' && !blockersById.has(requested)) {
        throw new Error(`Ship returned unknown blocker ID ${requested}`)
      }
      if (requested !== 'new' && used.has(requested)) {
        throw new Error(`Ship reused blocker ID ${requested} for more than one deferred item`)
      }
      const { blockerId: _blockerId, ...item } = raw
      const id = requested === 'new' ? ensureId(item) : requested
      blockerIds.set(item, id)
      used.add(id)
      return item
    })
    const missing = [...expectedIds].filter(id => !used.has(id))
    // An empty ship ledger creates no follow-up link and the deterministic
    // merge blockers still hold the PR. Once ship returns any item, its ledger
    // must cover every known blocker so one cannot masquerade as "new" or
    // disappear beside an unrelated filed follow-up.
    if (deferred.length && missing.length) {
      throw new Error(`Ship omitted known blocker ID${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`)
    }
    return decision
  }

  return { catalog, registerShipDeferrals, idFor }
}
