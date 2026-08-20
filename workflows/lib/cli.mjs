// Argv in, RESULT line and exit code out — the orchestrators' outer shell.
//
// The pipelines used to be handed an `args` value by the workflow engine and
// to end by returning an object. Both ends move here: argv becomes that value,
// and the returned object becomes a single machine-readable line plus an exit
// code. The line is what the skill wrappers grep for and what stays in the
// pane's scrollback after the process is gone — the same surface
// `tmux capture-pane` already reads to diagnose a session.

export const EXIT = {
  OK: 0,        // shipped, held for review, or a manual-mode summary
  ERROR: 1,     // the run could not start (bad args) or crashed outside its own blocker path
  SKIPPED: 2,   // nothing ran and nothing changed (claimed elsewhere, closed, blocked_by, …)
  BLOCKED: 3,   // stopped at a blocker; the pipeline has commented on the issue
}

// Accepts `--issue N` / `--slug S` / `--session NAME`, plus a bare positional
// for hand-runs. The positional keeps the old coercion — "81" and "#81" are an
// issue, anything else is a slug — because that is what people type.
//
// Gone with the workflow engine: the "args arrived as a stringified JSON
// object" branch. argv cannot produce one, so it is not a shape to defend
// against here.
export function parseArgs(argv, { allowSlug = false, usage = '' } = {}) {
  const out = { issue: undefined, slug: undefined, session: '' }
  const rest = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.indexOf('=')
    const [flag, inlineValue] = a.startsWith('--') && eq > 0
      ? [a.slice(0, eq), a.slice(eq + 1)]
      : [a, undefined]
    const take = () => {
      if (inlineValue !== undefined) return inlineValue
      const v = argv[++i]
      if (v === undefined) throw new UsageError(`${flag} requires a value`, usage)
      return v
    }
    switch (flag) {
      case '-h': case '--help': throw new UsageError('', usage)
      case '--issue': out.issue = take(); break
      case '--slug': out.slug = take(); break
      case '--session': out.session = take(); break
      default:
        if (flag.startsWith('-')) throw new UsageError(`unknown option ${flag}`, usage)
        rest.push(a)
    }
  }

  if (rest.length > 1) throw new UsageError(`takes at most one positional argument, got ${rest.length}`, usage)
  if (rest.length === 1 && out.issue === undefined && out.slug === undefined) {
    const m = String(rest[0]).trim().match(/^#?(\d+)$/)
    if (m) out.issue = m[1]
    else out.slug = rest[0]
  }

  if (out.issue !== undefined) {
    const n = String(out.issue).trim().replace(/^#/, '')
    if (!/^\d+$/.test(n)) throw new UsageError(`--issue must be a number, got "${out.issue}"`, usage)
    out.issue = Number(n)
  }

  if (out.slug !== undefined) {
    if (!allowSlug) throw new UsageError('this pipeline takes --issue only', usage)
    // Loud-fail a slug that is almost certainly a fat-fingered issue argument:
    // silently building in manual mode would skip git and ship nothing.
    if (typeof out.slug !== 'string' || /^#?\d+$/.test(out.slug) || out.slug.includes('issue')) {
      throw new UsageError(`got slug "${out.slug}" but this looks like an issue reference — pass --issue <N>`, usage)
    }
  }

  if (out.issue === undefined && out.slug === undefined) {
    throw new UsageError('nothing to run: pass --issue <N>' + (allowSlug ? ' or --slug <slug>' : ''), usage)
  }
  return out
}

export class UsageError extends Error {
  constructor(message, usage) {
    super(message)
    this.usage = usage
  }
}

// The single line every consumer reads, then the exit code that summarizes it.
export function finish(result) {
  const value = result && typeof result === 'object' ? result : { error: String(result ?? 'no result') }
  process.stdout.write(`RESULT ${JSON.stringify(value)}\n`)
  if (value.error) return EXIT.ERROR
  if (value.skipped) return EXIT.SKIPPED
  if (value.blocked) return EXIT.BLOCKED
  return EXIT.OK
}
