// Minimal JSON-Schema shape checker — the second half of the structured-output
// gate. The engine enforces the schema on its own side (the claude CLI retries
// the model until the output validates, or gives up with
// `error_max_structured_output_retries`), so this is not the primary check: it
// is what stops a *silently shaped-wrong* payload from reaching a gate that
// reads `.deferred.length` or `.verdicts[i].real` and finds undefined.
//
// It covers exactly the vocabulary the pipeline's own schemas use — type,
// required, properties, items, enum — and nothing else. Anything richer than
// that in a schema is ignored rather than guessed at.
//
// Deliberately LENIENT on extra properties, even though every schema here says
// `additionalProperties: false`: an extra key is a payload that carries
// everything the pipeline asked for plus something it will never read, and
// rejecting it would burn a respawn (and possibly a whole phase) over a field
// nothing looks at. Missing and mistyped are the failures that matter.

const typeOf = (v) => {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// Returns [] when the value matches, or a list of human-readable problems.
export function validate(schema, value, path = '') {
  const errs = []
  if (!schema || typeof schema !== 'object') return errs
  const at = path || '(root)'

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) errs.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`)
    return errs
  }

  if (schema.type) {
    const actual = typeOf(value)
    // JSON Schema's "integer" is not used here; "number" covers it.
    const want = schema.type
    if (actual !== want) {
      errs.push(`${at}: expected ${want}, got ${actual}`)
      return errs // a wrong container makes every nested complaint noise
    }
  }

  if (schema.type === 'object' || schema.properties) {
    if (typeOf(value) !== 'object') {
      errs.push(`${at}: expected object, got ${typeOf(value)}`)
      return errs
    }
    for (const key of schema.required || []) {
      if (value[key] === undefined) errs.push(`${at}: missing required field "${key}"`)
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      // Absent optional fields are fine; absent required ones were already reported.
      if (value[key] === undefined) continue
      errs.push(...validate(sub, value[key], path ? `${path}.${key}` : key))
    }
  }

  if (schema.type === 'array' && schema.items) {
    value.forEach((item, i) => errs.push(...validate(schema.items, item, `${path}[${i}]`)))
  }

  return errs
}
