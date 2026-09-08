// The bounded repair contract, shared by every place Toliki independently
// checks a model-written repair: epic-run's post-review repair and the
// conflict, CI and defect re-entry fixers.
//
// Why it has this shape. A repair checker used to answer one global boolean —
// `survives` — with a free-form reason, and the first counterexample it found
// was enough to say no. That answer is cheap and almost useless downstream:
// automation cannot act on "no", so every refutation cost a whole fresh fixer
// invocation which re-read the requirement, re-derived the repair and produced
// a new answer to check, and the run could spend hours re-preparing work it
// already had. The alternative that keeps automation honest is not a loop but
// ONE exhaustive answer: the checker keeps looking after the first refutation,
// returns a verdict for every original disposition and the COMPLETE batch of
// blockers, and the run gets exactly one scoped, in-process correction over
// that batch before a human takes it.
//
// So the outcome is a three-way decision, never a boolean:
//   clear                — every original item is resolved or disproved, the
//                          repair introduced no regression, declined items are
//                          untouched where partial repair is supported, and the
//                          delta stayed inside its cause-specific boundary;
//   correction-required  — every blocker is a concrete implementation defect
//                          correctable without a product, intent, authorization
//                          or other human judgment call;
//   human                — at least one item is uncertain, unsupported, unsafe
//                          to change, or is a decision rather than an
//                          implementation.
//
// Everything below fails closed. Malformed, incomplete, duplicate, extra,
// unknown, ambiguous or low-confidence evidence is never an authorization: it
// can neither start a correction nor release an unattended merge. A blocker
// carries a run-local identity precisely so the correction and the narrow
// confirmation that follows can be matched to it exactly, rather than by title
// — two blockers may describe the same file and read almost the same.
//
// There is no second correction batch. Semantic failure at any stage after
// acceptance ends in a human-held terminal state inside the same invocation;
// only OPERATIONAL failures (provider quota, a dead process, transport) may
// relaunch a whole fixer under the existing attempt ladder.

import { validate } from './schema.mjs'

const nonblank = value => typeof value === 'string' && value.trim().length > 0
const matchesSchema = (schema, value) => {
  try { return validate(schema, value).length === 0 } catch { return false }
}
const percent = value => Number.isFinite(value) && value >= 0 && value <= 100

// The same bar epic-run's final review and every fixer checker already used.
// Below it the evidence is not a verdict, whichever way it points.
export const ACCEPTANCE_CONFIDENCE = 75

// The four things that can hold a repair. They are distinguished because they
// mean different things to the correction that follows: the first three name a
// concrete implementation defect it may act on, and the fourth never is one.
export const BLOCKER_KINDS = ['original-defect', 'repair-regression', 'out-of-scope', 'human-judgment']

// Run-local, opaque and stable for one invocation. Bounded and character-fenced
// because it is echoed into later prompts and into the audit record.
const BLOCKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export const ACCEPTANCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['outcome', 'verdicts', 'blockers'],
  properties: {
    outcome: {
      enum: ['clear', 'correction-required', 'human'],
      description: 'clear only when nothing blocks; correction-required only when EVERY blocker is a concrete implementation defect; human when any item needs a decision, is unsafe to change, or is uncertain',
    },
    verdicts: {
      type: 'array',
      description: 'exactly one entry per numbered original disposition, even after a refutation is found',
      items: {
        type: 'object', additionalProperties: false,
        required: ['index', 'verdict', 'confidence', 'reasoning'],
        properties: {
          index: { type: 'number', description: '1-based number of the original disposition this decides' },
          verdict: { enum: ['upheld', 'blocked'], description: 'upheld only when the original claim is positively established from the code' },
          confidence: { type: 'number', description: '0-100' },
          reasoning: { type: 'string', description: 'concrete code evidence, whichever way it rules' },
        },
      },
    },
    blockers: {
      type: 'array',
      description: 'the COMPLETE batch of everything that holds this repair, never one sufficient counterexample',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'kind', 'location', 'evidence', 'required', 'confidence'],
        properties: {
          id: { type: 'string', description: 'a short identity unique within this batch, used to match a correction to this blocker' },
          kind: {
            enum: BLOCKER_KINDS,
            description: 'original-defect: an original item still broken. repair-regression: the repair broke something. out-of-scope: an edit outside the permitted boundary or a weakened gate. human-judgment: evidence or intent a person must decide',
          },
          item: { type: 'number', description: 'the 1-based original disposition this blocker is about, when it is about one' },
          location: { type: 'string', description: 'file:line, or the exact identity of the thing that blocks' },
          evidence: { type: 'string', description: 'concrete code evidence that this blocks' },
          required: { type: 'string', description: 'the observable outcome that would clear it' },
          confidence: { type: 'number', description: '0-100' },
        },
      },
    },
  },
}

// One indexed disposition per blocker, keyed by the blocker's own identity so a
// rephrased title can never re-address the wrong item. `declined` is accepted
// by the schema and refused by the gate: a correction that will not act on a
// blocker it was told is concrete has found a judgment call, and that is a
// human's, not another correction round's.
export const CORRECTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['dispositions'],
  properties: {
    summary: { type: 'string', description: 'a short account of the correction' },
    dispositions: {
      type: 'array',
      description: 'exactly one entry per blocker id, no missing, duplicate, extra or unknown ids',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'action', 'reason'],
        properties: {
          id: { type: 'string', description: 'the exact blocker id from the batch' },
          action: { enum: ['corrected', 'declined'] },
          reason: { type: 'string', description: 'the concrete change that clears it, or why it cannot be corrected' },
        },
      },
    },
  },
}

// Narrow on purpose: it proves the correction and nothing else. It never
// restarts a broad architectural review, and pre-existing work outside the
// correction's remit is not its subject.
export const CONFIRMATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['cleared', 'confidence', 'reasoning', 'blockerVerdicts', 'regressions'],
  properties: {
    cleared: { type: 'boolean', description: 'true only when every blocker is cleared, every previously upheld item is still clear, and the correction introduced no regression, gate weakening or unrelated behavior' },
    confidence: { type: 'number', description: '0-100' },
    reasoning: { type: 'string', description: 'concrete code evidence, whichever way it rules' },
    blockerVerdicts: {
      type: 'array',
      description: 'exactly one entry per blocker id',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'verdict', 'reasoning'],
        properties: {
          id: { type: 'string' },
          verdict: { enum: ['cleared', 'remaining'] },
          reasoning: { type: 'string' },
        },
      },
    },
    regressions: {
      type: 'array',
      description: 'anything the CORRECTION broke, weakened, or changed outside its permitted scope; empty when it broke nothing',
      items: {
        type: 'object', additionalProperties: false,
        required: ['location', 'problem'],
        properties: { location: { type: 'string' }, problem: { type: 'string' } },
      },
    },
  },
}

// The batch as a checker's successor sees it. Rendered here so the correction
// prompt and the narrow-confirmation prompt cannot drift apart, and so every
// cause adapter presents identities the same way.
export function renderBlockerBatch(blockers) {
  if (!Array.isArray(blockers) || !blockers.length) return '(none)'
  return blockers.map(blocker => [
    `- id: ${blocker.id}`,
    `  kind: ${blocker.kind}`,
    ...(Number.isInteger(blocker.item) ? [`  original item: ${blocker.item}`] : []),
    `  location: ${blocker.location}`,
    `  evidence: ${blocker.evidence}`,
    `  required to clear: ${blocker.required}`,
  ].join('\n')).join('\n')
}

// The acceptance verdict per original item, for the narrow confirmer. It is
// told what was already upheld so it can prove those stayed clear, without
// being invited to re-open them.
export function renderAcceptanceVerdicts(verdicts) {
  if (!Array.isArray(verdicts) || !verdicts.length) return '(none)'
  return verdicts.map(verdict => `- item ${verdict.index}: ${verdict.verdict} (confidence ${verdict.confidence}) — ${verdict.reasoning}`).join('\n')
}

// The instructions every acceptance checker shares. The cause adapter supplies
// what to judge; this supplies how the answer has to be shaped, so one wording
// change cannot leave three fixers disagreeing about what `clear` means.
export function acceptanceContract({ itemName, itemCount, boundary }) {
  return `Examine EVERY numbered ${itemName} and the COMPLETE repair delta, and keep going after you find a refutation: a first sufficient counterexample is not the answer here. Return one verdict for each of the ${itemCount} numbered ${itemName}(s) and the complete batch of everything that blocks this repair.

Give every blocker its own short id (unique within your answer), its kind, the original item number when it is about one, its location, the concrete code evidence that it blocks, and the observable outcome that would clear it. Kinds:
- original-defect: a numbered ${itemName} whose problem is still present.
- repair-regression: something the repair itself broke, weakened, or changed beyond its remit.
- out-of-scope: an edit outside the permitted boundary, or a test, assertion, type, lint rule or other gate weakened to pass. ${boundary}
- human-judgment: evidence or intent that a person has to decide — an uncertain reading, an unsupported claim, an authorization or product call, or anything unsafe to change automatically.

Then choose exactly one outcome:
- clear: every numbered ${itemName} is upheld, the repair introduced no regression, and the delta stayed inside its boundary. Return an empty blockers array.
- correction-required: there are blockers and EVERY one of them is a concrete implementation defect that can be corrected without a product, intent, authorization or other human judgment call.
- human: at least one blocker is uncertain, unsupported, unsafe to change, or a decision rather than an implementation. Use this whenever you are not sure.

Report only what you can establish from the code at confidence ${ACCEPTANCE_CONFIDENCE} or above; anything below that bar is not a verdict and not a blocker, so re-examine it until it is one or call the outcome human. Uncertainty is never a clearance.`
}

// The instructions every scoped correction shares.
export function correctionContract({ blockerCount }) {
  return `Address ONLY the ${blockerCount} numbered blocker(s) above. This is one bounded correction inside the current run: there is no second correction round, and anything you leave undone goes to a human rather than to another attempt.

Rules:
1. Make the smallest correct change that produces each blocker's stated required outcome. Never weaken, skip, delete or loosen a test, assertion, type, lint rule or security guard.
2. Change nothing outside the permitted boundary and nothing a blocker did not name. An unrelated edit is itself a refutable defect.
3. Do NOT commit, amend, push, or touch any label or comment. Leave the correction in the working tree; the orchestrator verifies, confirms and publishes it.
4. Do NOT open anything under \`.epics/\`.

Return exactly one disposition per blocker id above — no missing, duplicate, extra or unknown ids — each with the exact id, an action, and a non-empty reason. Use "corrected" with the concrete change you made. Use "declined" only when the blocker turns out to need a human decision; a decline ends this run at human review, so never use it to avoid work you could do.`
}

// The instructions every narrow confirmation shares.
export function confirmationContract({ blockerCount }) {
  return `Prove exactly four things about the correction delta, and nothing else:
1. every one of the ${blockerCount} blocker(s) above is cleared — its stated required outcome is observable in the code;
2. every original item the acceptance check upheld is still clear;
3. every item the repair declined is still unchanged, where declining was permitted;
4. the correction introduced no regression, no weakened gate, and no unrelated behavior.

Do NOT restart a broad architectural review and do NOT report pre-existing work unrelated to these blockers: that is not your subject and a finding of that kind here is noise, not a refutation. The correction's own account of what it did is deliberately withheld — judge the code.

Default to not cleared. Return cleared=true only when you positively established all four points at confidence ${ACCEPTANCE_CONFIDENCE} or above; return one verdict per blocker id, and list anything the correction broke under regressions.`
}

// ───────────────────────── the fail-closed gates ─────────────────────────
// Each returns either { problem } — never an authorization — or the validated
// structure. A caller may not act on anything a gate did not return.

export function validateAcceptance(result, itemCount) {
  if (!result) return { problem: 'the acceptance check produced no result' }
  if (!matchesSchema(ACCEPTANCE_SCHEMA, result)) return { problem: 'the acceptance check returned output that does not match its schema' }

  const { outcome, verdicts, blockers } = result
  if (verdicts.length !== itemCount) {
    return { problem: `the acceptance check returned ${verdicts.length} verdict(s) for ${itemCount} original item(s)` }
  }
  const byIndex = new Map()
  for (const verdict of verdicts) {
    const index = Number(verdict.index)
    if (!Number.isInteger(index) || index < 1 || index > itemCount || byIndex.has(index)) {
      return { problem: 'the acceptance check returned duplicate, missing, or out-of-range verdict indexes' }
    }
    if (!nonblank(verdict.reasoning)) return { problem: `acceptance verdict ${index} has no reasoning` }
    if (!percent(verdict.confidence)) return { problem: `acceptance verdict ${index} has no usable confidence` }
    if (verdict.confidence < ACCEPTANCE_CONFIDENCE) {
      return { problem: `acceptance verdict ${index} is below the ${ACCEPTANCE_CONFIDENCE} confidence bar (${verdict.confidence}) — low-confidence evidence authorizes nothing` }
    }
    byIndex.set(index, verdict)
  }

  const ids = new Set()
  const blockedItems = new Set()
  for (const blocker of blockers) {
    if (!nonblank(blocker.id) || !BLOCKER_ID.test(blocker.id.trim())) {
      return { problem: 'the acceptance check returned a blocker without a usable run-local id' }
    }
    const id = blocker.id.trim()
    if (ids.has(id)) return { problem: `the acceptance check reused blocker id ${id}` }
    ids.add(id)
    if (!BLOCKER_KINDS.includes(blocker.kind)) return { problem: `blocker ${id} has no recognised kind` }
    for (const field of ['location', 'evidence', 'required']) {
      if (!nonblank(blocker[field])) return { problem: `blocker ${id} is missing its ${field}` }
    }
    if (!percent(blocker.confidence)) return { problem: `blocker ${id} has no usable confidence` }
    if (blocker.confidence < ACCEPTANCE_CONFIDENCE) {
      return { problem: `blocker ${id} is below the ${ACCEPTANCE_CONFIDENCE} confidence bar (${blocker.confidence}) — low-confidence evidence authorizes nothing` }
    }
    if (blocker.item !== undefined) {
      const item = Number(blocker.item)
      if (!Number.isInteger(item) || item < 1 || item > itemCount) {
        return { problem: `blocker ${id} names original item ${blocker.item}, which does not exist` }
      }
      if (byIndex.get(item).verdict !== 'blocked') {
        return { problem: `blocker ${id} names original item ${item}, which the same answer upheld — the verdicts and the batch contradict each other` }
      }
      blockedItems.add(item)
    }
  }
  // A blocked item with nothing in the batch to clear it is exactly the
  // ambiguity this contract exists to remove: the correction would have no
  // worklist for it and the merge gate would have no evidence against it.
  for (const [index, verdict] of byIndex) {
    if (verdict.verdict === 'blocked' && !blockedItems.has(index)) {
      return { problem: `original item ${index} is blocked but no blocker in the batch names it` }
    }
  }

  if (outcome === 'clear') {
    if (blockers.length) return { problem: 'the acceptance check chose clear while returning blockers' }
    if ([...byIndex.values()].some(verdict => verdict.verdict !== 'upheld')) {
      return { problem: 'the acceptance check chose clear while leaving an original item blocked' }
    }
  } else if (!blockers.length) {
    return { problem: `the acceptance check chose ${outcome} without naming a single blocker` }
  } else if (outcome === 'correction-required' && blockers.some(blocker => blocker.kind === 'human-judgment')) {
    return { problem: 'the acceptance check asked for a correction over a blocker it classed as a human judgment call' }
  }

  return {
    outcome,
    verdicts: [...byIndex.keys()].sort((a, b) => a - b).map(index => byIndex.get(index)),
    blockers: blockers.map(blocker => ({ ...blocker, id: blocker.id.trim() })),
  }
}

export function validateCorrection(result, blockers) {
  if (!result) return { problem: 'the scoped correction produced no result' }
  if (!matchesSchema(CORRECTION_SCHEMA, result)) return { problem: 'the scoped correction returned output that does not match its schema' }

  const expected = new Map(blockers.map(blocker => [blocker.id, blocker]))
  const seen = new Map()
  for (const disposition of result.dispositions) {
    const id = String(disposition.id || '').trim()
    if (!expected.has(id)) return { problem: `the scoped correction returned a disposition for unknown blocker id ${id || '(blank)'}` }
    if (seen.has(id)) return { problem: `the scoped correction returned two dispositions for blocker id ${id}` }
    if (!nonblank(disposition.reason)) return { problem: `the scoped correction gave blocker ${id} no reason` }
    seen.set(id, disposition)
  }
  const missing = blockers.filter(blocker => !seen.has(blocker.id)).map(blocker => blocker.id)
  if (missing.length) return { problem: `the scoped correction left blocker id(s) ${missing.join(', ')} without a disposition` }

  const declined = blockers.filter(blocker => seen.get(blocker.id).action === 'declined')
  if (declined.length) {
    return {
      problem: `the scoped correction declined blocker id(s) ${declined.map(blocker => `${blocker.id} (${seen.get(blocker.id).reason})`).join('; ')} — a declined blocker is a judgment call and ends this run at human review`,
    }
  }
  return { dispositions: blockers.map(blocker => ({ ...seen.get(blocker.id), id: blocker.id })) }
}

export function validateConfirmation(result, blockers) {
  if (!result) return { problem: 'the narrow confirmation produced no result' }
  if (!matchesSchema(CONFIRMATION_SCHEMA, result)) return { problem: 'the narrow confirmation returned output that does not match its schema' }

  const expected = new Set(blockers.map(blocker => blocker.id))
  const seen = new Map()
  for (const verdict of result.blockerVerdicts) {
    const id = String(verdict.id || '').trim()
    if (!expected.has(id)) return { problem: `the narrow confirmation returned a verdict for unknown blocker id ${id || '(blank)'}` }
    if (seen.has(id)) return { problem: `the narrow confirmation returned two verdicts for blocker id ${id}` }
    if (!nonblank(verdict.reasoning)) return { problem: `the narrow confirmation gave blocker ${id} no reasoning` }
    seen.set(id, verdict)
  }
  const missing = blockers.filter(blocker => !seen.has(blocker.id)).map(blocker => blocker.id)
  if (missing.length) return { problem: `the narrow confirmation left blocker id(s) ${missing.join(', ')} without a verdict` }

  const remaining = [...seen.values()].filter(verdict => verdict.verdict === 'remaining')
  if (remaining.length) {
    return { problem: `the narrow confirmation found blocker id(s) ${remaining.map(verdict => `${verdict.id} (${verdict.reasoning})`).join('; ')} still unresolved` }
  }
  if (result.regressions.length) {
    return { problem: `the narrow confirmation found the correction introduced ${result.regressions.length} regression(s): ${result.regressions.map(item => `${item.location}: ${item.problem}`).join('; ')}` }
  }
  if (!percent(result.confidence)) return { problem: 'the narrow confirmation returned no usable confidence' }
  if (result.cleared !== true || result.confidence < ACCEPTANCE_CONFIDENCE) {
    return { problem: `the narrow confirmation did not clear the correction (cleared=${result.cleared}, confidence ${result.confidence}): ${result.reasoning}` }
  }
  return { confirmation: result }
}
