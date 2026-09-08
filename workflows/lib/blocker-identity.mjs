// Run-local identity for blockers that cross independent model records before
// one of them may turn into a follow-up issue. Display text is presentation: it
// can be duplicated, reordered or rephrased, so it is never used for lookup —
// two findings with the same title and reason still keep their own follow-up.
// The WeakMap also keeps these opaque IDs out of durable defect evidence.

const objectLike = value => value !== null && typeof value === 'object'

export function createBlockerIdentityRegistry() {
  const blockerIds = new WeakMap()
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
    return id
  }

  return { ensureId, idFor }
}
