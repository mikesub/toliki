#!/usr/bin/env node
// fix-run — judgment-conflict fixer for a finished epic PR (dispatch launches
// it for `needs-judgment` issues; `--issue N` is the only argument).
//
// Rebases the PR onto current origin/main, lets the deterministic rung settle
// every mechanical hunk (merge-autoresolve.sh --partial, containment-gated),
// has a model resolve ONLY the hunks left marked — stating what each side
// intended and how both survive, escalating instead of guessing — re-runs
// npm run verify, has a blind adversarial agent try to refute the resolution,
// force-pushes, and lands the issue ready-to-review, never ready-to-merge.
// Attempt ladder in labels: fix-attempted, then fix-retried (one retry);
// exhausted → refuses and stays failed.

import { agent, phase, log, initRuntime, onPhase, onLog } from './lib/runtime.mjs'
import { HARNESS_DIR } from './lib/engine.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'
import { initStatus, statusPhase, statusNote, statusFinish } from './lib/status.mjs'

const USAGE = `Usage: fix-run.mjs --issue <N> [--session <name>]

  --issue <N>  the needs-judgment issue whose PR hit the conflict
  --session    name for log lines (the tmux session bin/launch.sh created)

Exit: 0 fixed, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

// ───────────────────────── Why this exists ─────────────────────────
// bin/merge-worker.sh resolves rebase conflicts only when EVERY hunk is
// mechanical; one hunk needing judgment declines the whole PR to `failed` +
// `needs-judgment`. Measured on live declines, that class is concurrent work
// in one file where both intents compose — not contradictions — which is the
// case for waking a model: cheap detection (the awk classifier) has already
// decided there is something worth judging. This run is that model, fenced on
// every side: the mechanical share is re-settled by the same containment-gated
// code (never re-litigated by the model), the judgment share must come with
// stated intents and survive an adversarial check, verify must be green, and
// the landing is ready-to-review — a human glances, but the work is done.

// ───────────────────────── Discovery ─────────────────────────
// Same one-line contract as epic-run.mjs: a package is a directory whose
// package.json declares `scripts.verify`; the repo is the source of truth.
const DISCOVERY =
`Discover this repository's layout — do NOT assume any particular shape or set of packages. Read package.json files to answer; look at the repo root and each directory one level below it, skipping node_modules.
- \`packages\`: every directory whose package.json declares a \`scripts.verify\` entry, as repo-relative paths with no trailing slash (e.g. ["frontend","backend"]); use "." for the repo root itself. This is the exact set the downstream \`npm run verify\` gate runs in, so a package you miss is a package that is never verified.`

// The deterministic rung, by absolute path. Resolved from this file's own
// location rather than from an environment variable: the orchestrator knows
// where the harness is, and a prompt that depends on the engine's shell
// carrying a particular env var is a dependency the next engine may not have.
const AUTORESOLVE = `${HARNESS_DIR}/bin/merge-autoresolve.sh`

// ───────────────────────── Prompts ─────────────────────────
const PROMPTS = {
  // The ladder labels are the attempt store — queues here are label queries,
  // never comment greps — and the write is VERIFIED because it is the bound
  // that keeps this loop finite: a silently failed write would let dispatch
  // relaunch forever. The in-progress swap is usually already done by
  // dispatch (synchronously at launch, to shield the new session from reap's
  // terminal-label sweep); repeating it here is an idempotent belt for manual
  // launches.
  prepare: (issue) =>
`Prepare phase for the conflict-fixer run on GitHub issue #${issue}, autonomous (NO user interaction). All git/gh/npm work happens here. The issue's PR hit a judgment-class rebase conflict; this run's later phases resolve it. You only set the table — do NOT resolve any conflict content yourself.

1. \`gh issue view ${issue} --json state,labels,title\`. If the command fails, stop and report the failure. Gates, in order:
   a. state CLOSED → refused="issue #${issue} is closed", return, touch nothing.
   b. labels lack \`needs-judgment\` → refused="issue #${issue} is not labelled needs-judgment — not a fixer's issue", return, touch nothing.
   c. labels contain \`fix-retried\` → the attempt ladder is exhausted. Post this comment (via \`gh issue comment ${issue} --body-file -\`, heredoc on stdin):

      🤖 fix-conflict refused: attempt ladder exhausted
      Two fixer attempts already ran (fix-attempted + fix-retried are both on the issue). A human decides now: resolve the conflict by hand, or strip the fix-attempted and fix-retried labels to grant the fixer another round.

      Then \`gh issue edit ${issue} --remove-label in-progress --add-label failed 2>/dev/null || true\`, set refused="attempt ladder exhausted (fix-retried present)" and refusalFinal=true, and return.
2. Find the PR: \`gh pr list --state open --json number,url,headRefName,headRefOid --jq '[.[] | select(.headRefName | startswith("epic/${issue}-"))]'\`. Exactly one is expected. None → post a comment (same heredoc form):

   🤖 fix-conflict refused: no open PR
   Issue #${issue} is labelled needs-judgment but no open PR delivers it (branch epic/${issue}-*). Resolve by hand; strip needs-judgment to take it out of the fixer queue.

   then \`gh issue edit ${issue} --remove-label in-progress --add-label failed 2>/dev/null || true\`, refused="no open PR on an epic/${issue}-* branch", refusalFinal=true, return. More than one → same treatment with refused="multiple open PRs on epic/${issue}-* branches — ambiguous".
3. Attempt ladder + start signal, and this one is VERIFIED, not best-effort — it is the bound that keeps the fixer loop finite. attempt = 2 if \`fix-attempted\` is already in the labels, else 1. Ensure the labels exist (idempotent, each with \`2>/dev/null || true\`): \`gh label create fix-attempted --color FEF2C0 --description "a fixer session has attempted this conflict once"\`, \`gh label create fix-retried --color F9D0C4 --description "the fixer retry is spent — the next failure waits for a human"\`, \`gh label create in-progress --color FBCA04 --description "Actively being worked by epic-run"\`. Then ONE edit: \`gh issue edit ${issue} --add-label in-progress --add-label <fix-attempted|fix-retried by attempt> --remove-label failed\`. Then verify: \`gh issue view ${issue} --json labels --jq '[.labels[].name]'\` must contain in-progress and the ladder label you added, and not failed. If it does not, set refused="could not record the attempt (label write failed)" and return — an uncounted attempt must not run.
4. Git setup, in the session's own worktree (wherever you are — never cd elsewhere):
   a. First scrub what a killed predecessor may have left: \`git rebase --abort 2>/dev/null || true\` — session name == worktree name, so a relaunched fixer inherits the previous run's worktree, and a leftover mid-rebase state makes every later step fail on cleanup instead of retrying (the same scrub merge-worker's ensure_worktree does). Then \`git fetch origin --prune\`.
   b. branch = the PR's headRefName; prHead = its headRefOid. Verify \`git rev-parse refs/remotes/origin/<branch>\` equals prHead — if not, set gitBlocked="branch <branch> moved under the fixer (PR head <prHead>, origin now <sha>)" and return (labels stay; the pipeline files the blocker).
   c. \`git checkout -f --detach <prHead>\` (force: a reused worktree may sit on stale state; everything real is committed).
   d. mergeBase=$(git merge-base <prHead> origin/main). mainIssues = issue numbers in \`git log --format=%b <mergeBase>..origin/main\` matching 'Closes #<n>' (unique, sorted) — each squash-merged PR carries one, and those issue bodies are the intent record for main's side of the conflict.
   e. \`git -c merge.conflictStyle=diff3 rebase origin/main\`. If it COMPLETES with no stop: cleanRebase=true, skip to step 5 (report="", markedFiles=[]).
      If it stops on conflict: run \`${AUTORESOLVE} --partial "$(git rev-parse --show-toplevel)"\` and capture stdout+exit code. Non-zero exit → the conflict has a shape the fixer does not own (symlink/delete-modify/marker-shaped/unparseable): set gitBlocked="partial autoresolve declined: <its first output line>" and return. Zero → report=its stdout (one line per hunk, mechanical and judgment alike; keep it verbatim), markedFiles = \`git diff --name-only --diff-filter=U\` (the files still holding diff3 markers).
      If markedFiles is EMPTY (the conflict turned fully mechanical since the merge worker saw it — main moved): \`GIT_EDITOR=true git rebase --continue\`; if the rebase is then still in progress, gitBlocked="more than one commit conflicted — an epic branch holds exactly one" and return.
   f. Do NOT touch the content inside any conflict markers, do NOT stage marked files, do NOT continue a rebase that still has marked files — the Resolve phase owns that.
5. Discover the layout (needed for the verify gate later):
${DISCOVERY}
6. Deps for the verify gate: in EACH discovered package, run \`npm ci\` if \`node_modules\` is missing, or if \`git diff --quiet <mergeBase> HEAD -- <package>/package-lock.json\` or \`git diff --quiet <mergeBase> origin/main -- <package>/package-lock.json\` reports a change (either side moved the lockfile; a stale install makes the gate lie).
Return: attempt, branch, prUrl, prNumber, prHead, mergeBase, cleanRebase, report, markedFiles, mainIssues, packages — plus refused/refusalFinal/gitBlocked only when set.`,

  // The judgment core — the one stage that exists because a model is needed.
  // It gets the same evidence a human would open: both sides' diffs and both
  // sides' issue bodies. Its charter is narrow: only the marked hunks, both
  // intents stated and preserved, escalate instead of guessing.
  resolve: (issue, prep) =>
`Resolve the JUDGMENT hunks of a rebase conflict. You are mid-rebase: the PR branch ${prep.branch} (issue #${issue}) is being rebased onto origin/main, and the stop is partially settled — every mechanical hunk was already resolved by a containment-gated script and is NOT yours to touch. Yours are exactly the diff3 marker blocks still sitting in: ${prep.markedFiles.join(', ')}.

The machine classification of every hunk in this stop (mechanical ones already settled in place):
${prep.report}

Evidence — read BOTH sides' intent before touching anything:
- The PR side: \`git diff ${prep.mergeBase} ${prep.prHead} -- <the marked files>\` is what the epic changed there, and \`gh issue view ${issue} --json title,body\` is what it set out to do.
- The main side: \`git diff ${prep.mergeBase} origin/main -- <the marked files>\` is what landed on main since the PR branched, \`git log ${prep.mergeBase}..origin/main --format='%h %s'\` names the commits, and ${prep.mainIssues.length ? `these are the issues they delivered — read each: ${prep.mainIssues.map(n => '#' + n).join(', ')} (\`gh issue view <n> --json title,body\`)` : 'their commit messages are the intent record (no Closes #N references found)'}.
- Do NOT open anything under \`.epics/\` — leftovers there carry a previous run's framing and would anchor you; the diffs and issue bodies above are your whole evidence.

For EACH marker block (<<<<<<< ours is origin/main's side, >>>>>>> theirs is the PR's side, ||||||| holds the common base):
1. State what origin/main intended with these lines, and what the PR intended — from the evidence, not from guesswork.
2. Write the resolution in which BOTH intents survive, replacing the whole marker block. Both intents surviving does not always mean both sides' every line survives verbatim — when both sides re-derived the same thing (say, two retypings of one mock), the better derivation stands for both — but nothing either side MEANT may be lost.
3. Watch for merge artifacts a lazy concatenation produces: duplicate object keys, doubled imports, re-declared symbols, a call updated on one side of the block and stale on the other. The verify gate catches some of these; do not lean on it.

**Escalate instead of guessing.** If for ANY hunk you cannot honestly state both intents and show both surviving — the two sides genuinely contradict, or the evidence does not say what a side meant — resolve NOTHING further, return escalate="<file> hunk <n>: <why both intents cannot both survive>". A wrong-but-plausible merge is the failure mode this whole design exists to prevent; a \`failed\` label is recoverable, a silently dropped intent is not.

Boundaries: edit ONLY between and including marker lines, ONLY in the files listed above; never revisit the mechanical resolutions or any other file; never commit anything new; never push.

When every block is resolved: confirm no markers remain (\`git diff --check\` and \`grep -n '^<<<<<<<\\|^>>>>>>>' <files>\` must be clean), \`git add\` exactly those files, \`GIT_EDITOR=true git rebase --continue\`. Then confirm the rebase fully finished (\`git status\` shows no rebase in progress; \`git rev-list --count origin/main..HEAD\` is exactly 1 — if a second stop appears, escalate="rebase stopped again — an epic branch holds exactly one commit" instead of resolving further).

Return: completed (true only when the rebase finished clean), escalate (INSTEAD of completing, when set), and resolutions — one entry per marker block you resolved: file, hunk number (as the classification above numbers them), mainIntent, prIntent, resolution (one sentence: what the merged text does and how it keeps both).`,

  verify: (pkgs) =>
`Verify phase, autonomous. Run \`npm run verify\` in each of: ${pkgs}. Report the outcome — that is the whole job.
The fixer NEVER fixes code: if verify is red, do not repair anything, do not re-run flaky-looking suites more than once, do not touch a single file. A red verify here means the conflict resolution (or the combination of the two sides) broke something, and that goes to a human with this report.
Return: green (true only if every package's verify exited 0), detail (one line per package: package — pass/fail, and for a fail the first genuinely failing thing).`,

  // Blind on purpose, and refute-by-default on purpose: this is the same
  // adversarial shape as epic-run's review verify — the resolver's stated
  // intents are deliberately NOT in this prompt, so agreement can only come
  // from the code, not from reading the resolver's reasoning.
  check: (issue, prep) =>
`Adversarially check a rebase-conflict resolution you did not write. The PR branch ${prep.branch} (issue #${issue}) was rebased onto origin/main; the rebase stopped on judgment-class conflict hunks in: ${prep.markedFiles.join(', ')}. Something resolved them, the rebase completed, and HEAD now carries the result. Your job is to REFUTE the claim: "in every one of those hunks, both what origin/main changed and what the PR changed survive."

The machine classification of the stop's hunks (the mechanical ones were settled by a containment-gated script and are not in question — judge the "needs judgment" ones):
${prep.report}

Gather the evidence yourself:
- What the PR meant to change: \`git diff ${prep.mergeBase} ${prep.prHead} -- <the files>\`, and issue #${issue} (\`gh issue view ${issue} --json title,body\`).
- What main meant to change: \`git diff ${prep.mergeBase} origin/main -- <the files>\`${prep.mainIssues.length ? `, and the issues those commits delivered: ${prep.mainIssues.map(n => '#' + n).join(', ')}` : ''}.
- What actually shipped: \`git diff origin/main HEAD -- <the files>\` and the files at HEAD.
Do NOT open anything under \`.epics/\` — it carries a builder's framing and would anchor you.

Hunt specifically for: a side's change silently dropped (picking a side is the classic failure — and often no test covers the loss); duplicate object keys, doubled imports or re-declared symbols from a lazy keep-both; an edit placed at the wrong spot so the code runs in a changed order; one side's rename or retype applied in the hunk but not to the lines the other side contributed.

Default to refuted: if you cannot positively confirm, from the code in front of you, that both sides' intents survive, say survives=false. An over-cautious refute costs one human review; a wrong pass ships a silently mangled merge.

Return: survives, confidence (0-100), reasoning (name the hunk and the evidence, whichever way you rule).`,

  // Transport, not judgment: push, record, relabel. The comment body arrives
  // fully built — the audit trail is composed in the script from structured
  // pieces, not re-worded by an agent.
  ship: (issue, prep, comment) =>
`Ship the fixer run for issue #${issue}, autonomous. Three steps, in this order:
1. Push the rebased branch: \`git push --force-with-lease=refs/heads/${prep.branch}:${prep.prHead} origin HEAD:refs/heads/${prep.branch}\`. The lease is pinned to the exact head this run inspected, so if ANYTHING else moved the branch the push is rejected — in that case return pushed=false with the error, and do nothing further.
2. Record the audit trail on the issue — the resolution rewrote lines nobody reviewed, so it lives where a human will look. Post EXACTLY this comment (via \`gh issue comment ${issue} --body-file -\`, heredoc on stdin):

${comment.split('\n').map(l => '   ' + l).join('\n')}

3. Relabel — ready-to-review, NEVER ready-to-merge: whether this PR may merge unattended was a gate computed before the conflict existed, and a rewritten resolution resets that to "a human glances". \`gh label create ready-to-review --color 0E8A16 --description "epic-run finished; PR is open and awaiting review" 2>/dev/null || true\`, then \`gh issue edit ${issue} --remove-label in-progress --remove-label needs-judgment --add-label ready-to-review\`. Leave fix-attempted/fix-retried in place — the ladder deliberately does not reset. Then verify: \`gh issue view ${issue} --json labels --jq '[.labels[].name]'\` must contain ready-to-review and neither in-progress nor needs-judgment.
Return: pushed, labelled (true only if step 3's verification held), note (any error text).`,

  // What happens next is the LADDER's call, never the phase's — so it is a
  // field of the block (`- next:`), not a paragraph after it. #272 shipped it
  // as a trailing paragraph, the agent read that as narration and dropped it,
  // and the operator saw a first-attempt decline with no notice that a retry
  // was already queued. Keep every disposition claim inside the block; a
  // `reason` string states what broke, never who picks it up.
  blocked: (issue, phase, reason, prUrl, attempt) => {
    const ladder = attempt >= 2
      ? 'This was the RETRY (fix-attempted and fix-retried are both on the issue), so the fixer is done with it: resolve by hand, or strip the two fix-* labels to grant another round.'
      : attempt === 1
      ? 'This was the first attempt (fix-attempted is on the issue), so dispatch relaunches the fixer once, automatically, a few minutes after this session is reaped. Nothing to do unless the retry also fails.'
      : 'The attempt ladder was not reached, so dispatch will relaunch the fixer on its next tick.'
    return `The autonomous fix-conflict run hit a blocker and must report it on GitHub, then stop. Do this and nothing else:
1. If a rebase is in progress, abort it: \`git rebase --abort 2>/dev/null || true\` — the worktree must not be left mid-rebase for the next run to trip over. Do not commit or push anything.
2. Post a comment on issue #${issue} whose body is EXACTLY this block and nothing else — every value is already filled in, so copy all five lines verbatim, add nothing and drop nothing:

🤖 fix-conflict blocked
- phase: ${phase}
- reason: ${reason}
- pr: ${prUrl || 'not resolved'}
- next: ${ladder}

Post it with \`gh issue comment ${issue} --body-file -\`, feeding the body via a heredoc on stdin.
3. Flip the start-signal back to failed: \`gh label create failed --color B60205 --description "epic-run stopped at a blocker; needs human attention" 2>/dev/null || true\`, then \`gh issue edit ${issue} --remove-label in-progress --add-label failed 2>/dev/null || true\`. Leave needs-judgment and the fix-* labels exactly as they are — needs-judgment keeps the issue in the fixer queue and the ladder labels are what bound the retries.
Return confirmation that the comment was posted and the label was swapped to failed.`
  },
}

// ───────────────────────── Config ─────────────────────────
// Same tiering rationale as epic-run.mjs (including that these are CLI aliases,
// resolved by the installed binary — see the note there). MECHANICAL runs the fully-scripted
// stages. RESOLVE is the judgment core — the entire reason a model is in the
// loop — and ADJUDICATE is the last gate before a rewritten merge ships to a
// force-push, so both get the strong model.
const MECHANICAL = 'sonnet'
const RESOLVE = 'fable'
const ADJUDICATE = 'fable'

// ───────────────────────── Schemas ─────────────────────────
const PREP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['attempt', 'cleanRebase', 'markedFiles'],
  properties: {
    refused: { type: 'string', description: 'set ONLY when the run must not proceed (closed, not needs-judgment, ladder exhausted, no/ambiguous PR, ladder label write failed) — the reason' },
    refusalFinal: { type: 'boolean', description: 'true when the refusal was already commented and the issue left failed (exhausted ladder, missing PR) — nothing retries it' },
    gitBlocked: { type: 'string', description: 'set when the git half failed AFTER the labels went on (branch moved, partial autoresolve declined, multi-commit rebase) — the pipeline files the blocker' },
    attempt: { type: 'number', description: '1 on the first run (fix-attempted applied), 2 on the retry (fix-retried applied); 0 when refused before the ladder write' },
    branch: { type: 'string', description: 'the PR head branch, epic/<N>-<slug>' },
    prUrl: { type: 'string' },
    prNumber: { type: 'number' },
    prHead: { type: 'string', description: 'the PR head sha BEFORE the rebase — the force-with-lease anchor' },
    mergeBase: { type: 'string', description: 'merge-base of the old PR head and origin/main' },
    cleanRebase: { type: 'boolean', description: 'true when the rebase completed without stopping (the conflict evaporated — main moved since the decline)' },
    report: { type: 'string', description: 'merge-autoresolve.sh --partial stdout, verbatim: one line per hunk, mechanical and judgment alike' },
    markedFiles: { type: 'array', items: { type: 'string' }, description: 'files still holding diff3 markers after the partial resolve (empty when cleanRebase, or when the stop turned out fully mechanical)' },
    mainIssues: { type: 'array', items: { type: 'number' }, description: 'issue numbers closed by the commits in mergeBase..origin/main' },
    packages: { type: 'array', items: { type: 'string' }, description: 'repo-relative path of every directory whose package.json declares scripts.verify; "." for the repo root' },
  },
}
const RESOLVE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['completed'],
  properties: {
    completed: { type: 'boolean', description: 'true only when every marker block was resolved, the files staged, and rebase --continue finished with exactly one commit on top of origin/main' },
    escalate: { type: 'string', description: 'set INSTEAD of completing when any hunk is a genuine contradiction or its intents cannot be established — which file/hunk and why both intents cannot both survive' },
    resolutions: {
      type: 'array',
      description: 'one entry per resolved marker block',
      items: {
        type: 'object', additionalProperties: false,
        required: ['file', 'hunk', 'mainIntent', 'prIntent', 'resolution'],
        properties: {
          file: { type: 'string' },
          hunk: { type: 'number', description: 'the hunk number as the machine classification numbers it' },
          mainIntent: { type: 'string', description: 'what origin/main intended with these lines' },
          prIntent: { type: 'string', description: 'what the PR intended with these lines' },
          resolution: { type: 'string', description: 'one sentence: what the merged text does and how it keeps both' },
        },
      },
    },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['green', 'detail'],
  properties: {
    green: { type: 'boolean', description: 'true only if every package\'s npm run verify exited 0' },
    detail: { type: 'string', description: 'one line per package: pass/fail, and for a fail the first genuinely failing thing' },
  },
}
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['survives', 'confidence', 'reasoning'],
  properties: {
    survives: { type: 'boolean', description: 'true only if both sides\' intents demonstrably survive in every judgment hunk' },
    confidence: { type: 'number', description: '0-100' },
    reasoning: { type: 'string', description: 'names the hunk(s) and the evidence, whichever way it rules' },
  },
}
const SHIP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['pushed', 'labelled'],
  properties: {
    pushed: { type: 'boolean' },
    labelled: { type: 'boolean', description: 'true only if gh issue view was observed carrying ready-to-review and neither in-progress nor needs-judgment' },
    note: { type: 'string', description: 'any error text' },
  },
}

// ───────────────────────── Args ─────────────────────────
let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { allowSlug: false, usage: USAGE })
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write((e.message ? `fix-run: ${e.message}\n\n` : '') + e.usage + '\n')
    process.exit(e.message ? EXIT.ERROR : EXIT.OK)
  }
  throw e
}
initRuntime({ scriptName: 'fix-run', sessionName: ARGS.session })
// The issue's live status comment mirrors the pane's narration: the label says
// WHICH state the issue is in, this says whether the run is alive and where it
// got to. Issue mode only — slug mode has no issue to report on.
initStatus({ issue: ARGS.issue, script: 'fix-run', session: ARGS.session, phases: ['Prepare', 'Resolve', 'Verify', 'Check', 'Ship'] })
onPhase(statusPhase)
onLog(statusNote)
const issue = ARGS.issue

// ───────────────────────── Blocker path ─────────────────────────
// Same shape as epic-run's fail(): comment the blocker, restore the terminal
// label, return a structured block. blockerPosted guards re-entry when the
// blocked agent itself throws and the outer catch calls fail() again.
let currentPhase = 'prepare'
let blockerPosted = false
let prUrl = null
let attempt = 0
async function fail(phase, reason) {
  if (!blockerPosted) {
    blockerPosted = true
    await agent(PROMPTS.blocked(issue, phase, reason, prUrl, attempt),
      { label: 'ship:blocked', phase: 'Ship', agentType: 'coder', model: MECHANICAL })
  }
  return { blocked: true, issue, phase, reason, prUrl: prUrl || undefined, attempt }
}

// ───────────────────────── The audit comment ─────────────────────────
// Composed here, in the script, from structured pieces — the ship agent
// transports it verbatim. The resolution rewrote lines nobody reviewed, so
// the record has to name every hunk, both intents, and every gate that ran.
const buildComment = (prep, resolutions, verifyDetail, check) => {
  const lines = []
  lines.push('🤖 fix-conflict resolved a judgment rebase conflict')
  lines.push(`- pr: ${prep.prUrl}`)
  lines.push(`- attempt: ${prep.attempt}`)
  lines.push('')
  if (prep.cleanRebase) {
    lines.push('By the time this run rebased, the conflict had evaporated — origin/main had moved past the decline. The rebase was clean; no judgment was exercised.')
  } else if (!resolutions.length) {
    lines.push('By the time this run rebased, every hunk had turned mechanical — origin/main had moved past the judgment decline. The deterministic rung settled them all under its containment gate; no judgment was exercised:')
    lines.push('')
    lines.push(String(prep.report || "").trim().split('\n').map(l => `- ${l}`).join('\n'))
  } else {
    lines.push('Rebasing onto origin/main conflicted. The mechanical hunks were settled by the deterministic rung under its containment gate; the judgment hunks were resolved by this fixer session:')
    lines.push('')
    lines.push(String(prep.report || "").trim().split('\n').map(l => `- ${l}`).join('\n'))
    lines.push('')
    lines.push('Each judgment resolution, with both sides\' intents:')
    for (const r of resolutions) {
      lines.push(`- ${r.file} hunk ${r.hunk}:`)
      lines.push(`  - origin/main intended: ${r.mainIntent}`)
      lines.push(`  - the PR intended: ${r.prIntent}`)
      lines.push(`  - resolution: ${r.resolution}`)
    }
    lines.push('')
    lines.push(`An adversarial check, blind to this session's reasoning, tried to refute "both intents survived" and failed to (confidence ${check.confidence}/100).`)
  }
  lines.push('')
  lines.push(`verify: ${verifyDetail}`)
  lines.push('')
  lines.push('The branch is rebased and force-pushed; the issue is ready-to-review. Promoting to ready-to-merge is a human\'s call — the merge worker re-runs CI on the true base before anything lands.')
  return lines.join('\n')
}

// ───────────────────────── Pipeline ─────────────────────────
async function main() {
try {
  phase('Prepare')
  const prep = await agent(PROMPTS.prepare(issue),
    { label: 'prepare', phase: 'Prepare', agentType: 'coder', model: MECHANICAL, schema: PREP_SCHEMA })
  if (!prep) return await fail('prepare', 'Prepare produced no result — could not reach git/gh.')
  if (prep.refused) {
    log(`Prepare refused: ${prep.refused}`)
    return { skipped: true, issue, reason: prep.refused, refusalFinal: !!prep.refusalFinal }
  }
  attempt = prep.attempt
  prUrl = prep.prUrl || null
  if (prep.gitBlocked) return await fail('prepare', prep.gitBlocked)
  if (!prep.branch || !prep.prHead || !prep.mergeBase) {
    return await fail('prepare', 'Prepare returned no branch/prHead/mergeBase — the git half never got set up.')
  }
  // Fail closed on discovery, exactly like epic-run: an empty package list
  // would make the verify gate a silent no-op on a rewritten merge.
  const packages = (Array.isArray(prep.packages) ? prep.packages : [])
    .map(p => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(Boolean)
  if (!packages.length) {
    return await fail('prepare', 'layout discovery found no package declaring an `npm run verify` script — refusing to ship a resolution nothing would verify.')
  }
  const pkgList = packages.map(p => (p === '.' ? 'the repo root' : `${p}/`)).join(', ')
  const marked = Array.isArray(prep.markedFiles) ? prep.markedFiles : []
  log(prep.cleanRebase
    ? `Prepare: attempt ${attempt} on PR ${prep.prUrl} — rebase onto origin/main was CLEAN (the conflict evaporated).`
    : `Prepare: attempt ${attempt} on PR ${prep.prUrl} — mechanical hunks settled, ${marked.length} file(s) left for judgment${marked.length ? ` (${marked.join(', ')})` : ''}. Packages: ${pkgList}.`)

  // ───────────────────────── Resolve (judgment hunks only) ─────────────────────────
  let resolutions = []
  if (marked.length) {
    currentPhase = 'resolve'
    phase('Resolve')
    const res = await agent(PROMPTS.resolve(issue, prep),
      { label: 'resolve', phase: 'Resolve', agentType: 'coder', model: RESOLVE, schema: RESOLVE_SCHEMA })
    if (!res) return await fail('resolve', 'the resolver produced no result — the rebase is aborted for a clean retry.')
    if (res.escalate) return await fail('resolve', `escalated rather than guessed: ${res.escalate}`)
    if (!res.completed) return await fail('resolve', 'the resolver did not complete the rebase.')
    resolutions = Array.isArray(res.resolutions) ? res.resolutions : []
    // "States what each side intended and shows both surviving" is the
    // contract, not decoration — a resolution without its intent record is
    // unauditable and the adversarial check below would be its only witness.
    if (!resolutions.length) {
      return await fail('resolve', 'the resolver reported completion but returned no per-hunk intent statements — refusing to ship an unauditable resolution.')
    }
    log(`Resolve: ${resolutions.length} judgment hunk(s) resolved with stated intents.`)
  }

  // ───────────────────────── Verify ─────────────────────────
  currentPhase = 'verify'
  phase('Verify')
  const v = await agent(PROMPTS.verify(pkgList),
    { label: 'verify', phase: 'Verify', agentType: 'coder', model: MECHANICAL, schema: VERIFY_SCHEMA })
  if (!v) return await fail('verify', 'the verify agent produced no result — an unverified resolution must not ship.')
  if (!v.green) return await fail('verify', `npm run verify is red after the resolution (${v.detail}) — the fixer never fixes code, so nothing was pushed and the PR branch is untouched.`)
  log(`Verify: green — ${v.detail}`)

  // ───────────────────────── Adversarial check ─────────────────────────
  // Skipped when no judgment was exercised: a clean rebase or an all-
  // mechanical stop has nothing for a skeptic to refute — the containment
  // gate already proved the mechanical share, line by line.
  let check = null
  if (marked.length) {
    currentPhase = 'check'
    phase('Check')
    check = await agent(PROMPTS.check(issue, prep),
      { label: 'check', phase: 'Check', agentType: 'reviewer', model: ADJUDICATE, schema: CHECK_SCHEMA })
    if (!check) return await fail('check', 'the adversarial checker produced no result — an unchecked resolution must not ship.')
    if (!check.survives || check.confidence < 75) {
      return await fail('check', `the adversarial check refuted the resolution (survives=${check.survives}, confidence ${check.confidence}): ${check.reasoning}`)
    }
    log(`Check: survived — ${check.reasoning} (confidence ${check.confidence}).`)
  }

  // ───────────────────────── Ship ─────────────────────────
  currentPhase = 'ship'
  phase('Ship')
  const comment = buildComment(prep, resolutions, v.detail, check)
  const shipped = await agent(PROMPTS.ship(issue, prep, comment),
    { label: 'ship', phase: 'Ship', agentType: 'coder', model: MECHANICAL, schema: SHIP_SCHEMA })
  if (!shipped || !shipped.pushed) {
    return await fail('ship', `the force-with-lease push did not land${shipped?.note ? ` (${shipped.note})` : ''} — the branch on origin is untouched.`)
  }
  if (!shipped.labelled) {
    // Fail closed on the label half too: pushed-but-unlabelled would leave a
    // fixed PR on an issue reap reads as "still working" — a leaked slot and
    // an invisible success. failed + the blocker comment puts a human on it.
    return await fail('ship', `pushed, but the ready-to-review label swap could not be verified${shipped?.note ? ` (${shipped.note})` : ''} — a human finishes the labels; the PR itself is fixed and rebased.`)
  }
  log(`Ship: pushed and labelled ready-to-review — ${prep.prUrl}`)

  return {
    issue,
    prUrl: prep.prUrl,
    branch: prep.branch,
    attempt,
    cleanRebase: !!prep.cleanRebase,
    resolvedHunks: resolutions.length,
    checkConfidence: check ? check.confidence : null,
    verify: v.detail,
    readyToReview: true,
  }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

const RESULT = await main()
// Best effort, and awaited so the edit lands before the process goes: this is the
// last thing the issue page will show until a human or the merge worker acts.
await statusFinish(RESULT?.blocked ? `**blocked** at ${RESULT.phase}: ${RESULT.reason}` : RESULT?.skipped ? `**skipped**: ${RESULT.reason}` : RESULT?.readyToReview ? `**done** — ${RESULT.prUrl} is ready-to-review` : '**finished**')
process.exit(finish(RESULT))
