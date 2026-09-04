// Published per-model prices, for the vendors whose CLI does not report cost.
//
// Claude's CLI returns total_cost_usd with every result, so nothing here prices
// it. Codex reports token counts only, so its dollars are computed from this
// table and stamped costSource:"table" in the usage log — a number this file
// produced must never be read back as a vendor's own accounting.
//
// Not in etc/: these are vendor facts, published and identical on every host,
// not the machine-local or per-run choices etc/ carries. They change when the
// vendor changes them, in lockstep with adding a model to etc/engines.json.
//
// Dollars per 1M tokens, from OpenAI's short-context column (read 2026-09-04).
// The long-context column is exactly 2x every cell and bills per request above
// the context threshold. A usage record cannot reach it: the CLI reports one
// turn's tokens summed across every request that turn made, so a 2M-token turn
// is indistinguishable from thirty small requests. Short rates are therefore
// the floor — and being uniform, they leave the step-against-step comparisons
// this data exists for exact.
//
// Every row holds the same two ratios: cached input is a tenth of input, a
// cache write is 1.25x it. Both are subsets of input_tokens, not additions to
// it, which is what codexCostUsd's subtraction below relies on.
export const CODEX_PRICES = {
  'gpt-6-astra':   { input: 10,  cachedInput: 1,    cacheWrite: 12.5, output: 50 },
  'gpt-5.6-sol':   { input: 4,   cachedInput: 0.4,  cacheWrite: 5,    output: 20 },
  'gpt-5.6-terra': { input: 2,   cachedInput: 0.2,  cacheWrite: 2.5,  output: 12 },
  'gpt-5.6-luna':  { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
}

const PER_MILLION = 1e6

// What one Codex spawn cost. Null when the model has no row or the CLI reported
// no tokens: an unpriced model records an unknown cost, never a zero, the same
// way an unreported token count does — a zero would quietly drag every average
// that includes it toward free.
export function codexCostUsd(model, tokens) {
  const price = CODEX_PRICES[model]
  if (!price || !tokens) return null
  const { input, output } = tokens
  if (input === null && output === null) return null
  const cacheRead = tokens.cacheRead ?? 0
  const cacheWrite = tokens.cacheCreate ?? 0
  // Cached and cache-write tokens are billed out of input_tokens, so only the
  // remainder carries the full input rate. Clamped at zero: if that accounting
  // ever changes, an overlap must not subtract money from the total.
  const fresh = Math.max((input ?? 0) - cacheRead - cacheWrite, 0)
  const dollars = fresh * price.input
    + cacheRead * price.cachedInput
    + cacheWrite * price.cacheWrite
    + (output ?? 0) * price.output
  return dollars / PER_MILLION
}
