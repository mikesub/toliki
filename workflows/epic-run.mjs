#!/usr/bin/env node
// epic-run — autonomous issue-to-PR delivery: prepare → architect → code →
// review → triage → ship, no sign-offs.
//
// Issue mode (`--issue N`): preflight (closed? blocked_by?) → branch
// epic/<N>-<slug> off origin/main and claim it by pushing the ref (atomic; a
// run that loses the race skips), resuming an existing branch when one is left
// over → checkpoint commits after code/triage → squashed single-commit PR at
// ship + blocker-comment → merge gate labels the issue ready-to-merge when
// nothing was deferred, ready-to-review when a human must decide.
// Manual mode (`--slug S`): builds on the current tree, no git; needs
// .epics/<slug>/requirements.md to already exist.
//
// The run never merges: bin/merge-worker.sh drains ready-to-merge serially per
// repo. Each phase below is one engine process (see lib/engine.mjs); this file
// names no vendor.

import { agent, parallel, phase, log, initRuntime } from './lib/runtime.mjs'
import { parseArgs, finish, UsageError, EXIT } from './lib/cli.mjs'

const USAGE = `Usage: epic-run.mjs (--issue <N> | --slug <slug>) [--session <name>]

  --issue <N>    GitHub issue to build: branch, implement, review, open a PR
  --slug <slug>  manual mode: build on the current tree from an existing
                 .epics/<slug>/requirements.md, no git and no PR
  --session      name for log lines (the tmux session bin/launch.sh created)

Exit: 0 shipped or held for review, 1 usage/crash, 2 skipped, 3 blocked.
The final line is RESULT <json>.`

// ───────────────────────── Discovery ─────────────────────────
// This pipeline is shared across projects with different shapes (frontend+backend, frontend+worker),
// so the package list cannot be hardcoded here. It is also deliberately NOT configured: a config file
// would restate what each repo already states in its own package.json, and would go stale the moment a
// repo changed shape. The repo is the source of truth; the pipeline reads it.
//
// The contract is exactly one line: a package is a directory whose package.json declares `scripts.verify`.
// Everything a project wants gated on the way to a green pipeline goes INSIDE that script — including a
// real-database tier, which each project triggers from its own path-diffing bash gate. That keeps the
// decision deterministic (no agent in the loop) and, because CI runs `verify` too, covers manual commits
// to main that an in-pipeline gate could never see.
//
// Discovery rides along on the two agents that already run before any code (prepare in git mode,
// read:requirement in slug mode), so it costs no extra spawn in either path.
const DISCOVERY =
`Discover this repository's layout — do NOT assume any particular shape or set of packages. Read package.json files to answer; look at the repo root and each directory one level below it, skipping node_modules.
- \`packages\`: every directory whose package.json declares a \`scripts.verify\` entry, as repo-relative paths with no trailing slash (e.g. ["frontend","backend"]); use "." for the repo root itself. This is the exact set the downstream \`npm run verify\` gate runs in, so a package you miss is a package that is never verified.`

// ───────────────────────── Prompts ─────────────────────────
// All agent prompt bodies live here as template builders; the orchestration below just wires them.
const PROMPTS = {
  // Claiming (step 4c) is what makes it safe to run epics in parallel. The label swap `ready` → `in-progress`
  // can't be the lock — it's a read-modify-write with a wide window — but creating a ref on origin is a
  // compare-and-swap, so pushing the branch BEFORE any work is a real cross-machine lock with no new
  // infrastructure. Labels stay as the human-readable signal; the ref is the lock.
  //
  // Three layers, in the order prepare hits them, because no single one covers every collision:
  //   1. Local branch already checked out in another worktree (4b) — same host, same clone: sessions share
  //      one .git, so a live run's branch is visible and `git switch` refuses. Predates claiming.
  //   2. A claim-only branch on origin (4b) — catches a competitor on ANY host, and catches it even when the
  //      two runs picked DIFFERENT slugs for the same issue (the slug is a model-written gist of the title,
  //      so it is not reliably identical), because the `epic/<N>-*` glob matches regardless of slug.
  //   3. The push CAS itself (4c) — closes the window where both runs pass 4b before either has pushed.
  // Layer 2 is not optional: a claim ref IS a branch on origin, so without it the loser lands in 4b's resume
  // path and adopts its competitor's branch, never reaching 4c at all.
  prepare: (issue) =>
`Prepare phase for GitHub issue #${issue}, autonomous (NO user interaction). All git/gh/npm work happens here.
1. Run \`gh issue view ${issue} --json number,title,body,state\`. If the command fails, stop and report the failure. If the issue state is CLOSED, set refused="issue #${issue} is closed" and return — do nothing else.
2. Dependency preflight: \`gh api repos/{owner}/{repo}/issues/${issue}/dependencies/blocked_by --jq '[.[] | select(.state == "open") | .number]'\`. If it lists open blockers, set refused="blocked by open issue(s) #<list>" and return — building on an unlanded dependency is exactly what \`blocked_by\` exists to prevent. If the command itself errors, note it and continue (treat as no blockers).
3. \`git fetch origin\` (if it fails, note it and continue — the base may be stale). Capture BASE=$(git rev-parse HEAD) now, BEFORE any branch switch — step 7's deps check needs it.
4. Idempotency / resume guard, in this order:
   a. An open PR already delivering this issue → alreadyExists=true, note which PR, return, do nothing else. Check BOTH \`gh pr list --state open --json number,headRefName --jq '[.[] | select(.headRefName | startswith("epic/${issue}-"))]'\` AND (for legacy title-derived branch names) \`gh pr list --state open --search "Closes #${issue} in:body" --json number,title\`.
   b. An existing branch without an open PR (an interrupted or blocked prior run) → RESUME it, do not start over. Find it via \`git branch --list 'epic/${issue}-*'\` and \`git ls-remote --heads origin 'epic/${issue}-*'\`. Adopt that branch's OWN slug (everything after "epic/"). When the branch exists ONLY on origin, first tell a leftover apart from a live claim: \`git fetch origin <branch>\` then \`git log --format=%s origin/main..FETCH_HEAD\`. If the ONLY commit it carries is a \`chore(epic ${issue}): claim ...\` commit, that branch holds no work — another run claimed this issue in step 4c and is building it right now — so set refused="claimed by another run" and return. A branch carrying any real commit is a genuine leftover: resume it. Check it out: \`git switch <branch>\`, or \`git switch -c <branch> --track origin/<branch>\` when it exists only on origin. If the switch fails because the branch is checked out in another worktree, set refused="epic/<slug> is checked out in another worktree — a run may be live there" and return. Then \`git rebase origin/main\`; on conflict, \`git rebase --abort\` and set refused="resume rebase onto origin/main conflicted — resolve manually on <branch> or delete it for a fresh build" and return. Set resumed=true.
   c. Otherwise start fresh: slug = "${issue}-<short>" where <short> is a 2-4 word kebab-case gist of the issue title (whole slug ≤ 40 chars). \`git switch -c epic/<slug> origin/main\` — ALWAYS branch from origin/main, never from the local checkout (it can be stale). Then CLAIM the issue on origin, RIGHT NOW — before requirements.md, before \`npm ci\`, before anything else expensive:
      \`\`\`
      git commit --allow-empty -m "chore(epic ${issue}): claim $(date +%s)-$$"
      git push origin "HEAD:refs/heads/epic/<slug>"
      \`\`\`
      Creating a ref on origin is a compare-and-swap, so that push IS the lock that stops two runs on different machines building this issue at once. The empty commit is what makes it one: both runs branch from the same origin/main, so pushing HEAD as-is would be a no-op update the server accepts from BOTH ("Everything up-to-date", exit 0) and neither would notice. The unique message gives each run a distinct commit, so the loser's push is a genuine non-fast-forward and is REJECTED. The commit is empty (it changes no files, so it never appears in a diff) and Ship squashes it away.
      If the push is rejected, another run claimed this issue in the last instant: set refused="claimed by another run" and return. Do NOT retry it, do NOT force it, and do NOT pick a different slug to get around it — losing this race is the mechanism working.
5. Signal on GitHub that autonomous work has started (the guards passed, so signal NOW, before the slow deps step). These are best-effort — if one fails, note it and continue; do NOT abort the run:
   a. Label swap, as ONE \`gh issue edit\`. First make sure every label the swap touches exists — \`gh label create\` is idempotent, run each with \`2>/dev/null || true\`: \`in-progress\` (color FBCA04, "Actively being worked by epic-run"), \`ready-to-merge\` (0E8A16, "epic-run finished; PR open and gates cleared — queued for bin/merge-worker.sh"), \`ready-to-review\` (0E8A16, "epic-run finished; PR is open and awaiting review"), \`failed\` (B60205, "epic-run stopped at a blocker; needs human attention"). Then the swap itself: \`gh issue edit ${issue} --add-label in-progress --remove-label ready --remove-label ready-to-merge --remove-label ready-to-review --remove-label failed\`. ONE combined call deliberately, never an add call plus a separate strip call: the swap is best-effort, and two calls allow a lossy half-success — the add lands, the strip silently fails, and the issue is left carrying \`ready\` beside a terminal label, where the dispatch queue would re-pick it every tick. If the edit fails, do NOT abort — but do NOT swallow it either: include a \`- prepare: label swap failed: <error>\` line in the phase log when you write epic.md (step 6), so the failure surfaces in the PR body instead of vanishing. Dropping \`ready\` is what removes the issue from the dispatch queue — leave it on and a finished issue gets picked up and rebuilt. Dropping \`ready-to-merge\` matters just as much in the other direction: it is the merge worker's queue, and a stale one left on an issue this run is rebuilding points that worker at a PR that is being rewritten under it.
   b. Self-assign: \`gh issue edit ${issue} --add-assignee @me\`.
   Do NOT post a comment — the label and the assignment are the start signal; the issue gets a comment only for deferred work and for a blocker.
6. Create \`.epics/<slug>/\` (gitignored) and write \`.epics/<slug>/requirements.md\` = the issue body VERBATIM as the definition of done, prefixed with a line \`Issue: #${issue}\`. Also write \`.epics/<slug>/epic.md\` (fresh; on a resume where it already exists, keep it and append a phase-log line \`- prepare: resumed\`):
   # <Title>
   - slug: <slug>
   - issue: ${issue}
   - phase: prepare
   - approach:

   ## Phase log
   - prepare: done
7. Discover the layout. The downstream verify gate runs in exactly the packages you report here, so under-reporting silently removes a gate rather than failing loudly.
${DISCOVERY}
8. Ensure deps are present in EVERY package you discovered in step 7 — the \`npm run verify\` gate downstream is INVALID without them. In EACH package: if \`node_modules\` is missing, run \`npm ci\`; if it exists but the lockfile changed between this worktree's original checkout and the new base — \`git diff --quiet $BASE HEAD -- <package>/package-lock.json\` exits non-zero — ALSO run \`npm ci\` (the worktree was created from the clone's HEAD, which may predate this base). Otherwise skip: \`npm ci\` always wipes node_modules first, so a blind re-run is minutes of dead time.
Return: slug, branch (epic/<slug>), alreadyExists, resumed, refused (only when refusing), packages from step 7, and requirement = the full verbatim contents of the requirements.md you wrote.`,

  architectDesign: (dir) =>
`Read ${dir}/requirements.md and design the implementation approach for it. It goes straight to implementation.

Ground the design in the real codebase: find how similar features here are already built and reuse their module boundaries, abstractions, and helpers. Default to the pragmatic path that fits existing patterns; introduce a new abstraction only when the requirements make its longevity worth the cost, and say so explicitly when you do.

Your output is schema-enforced JSON — populate every field, do not cram everything into one:
- approach: a SHORT name for the design (3-6 words), used as its audit label.
- rationale: 2-4 sentences on the core idea and why it fits this codebase.
- steps: ordered build steps (one string per step); note which are independent vs. must serialize because they touch the same files.
- files: files to create or modify (one per string, with a few words on what changes).
- contract: the public contract / API surface, explicit enough that tests can be written against it WITHOUT seeing the implementation.
- tradeoffs: what this approach deliberately accepts.`,

  // Transcription only — the design is already decided and arrives whole in the prompt. Kept separate from the
  // design agent because that one is read-only by charter (agentType 'architect' has no Write tool), and the
  // separation is what stops "design the epic" drifting into "start building it".
  architectWrite: (dir, d) =>
`Transcribe the design below into ${dir}/architecture.md. It is ALREADY DECIDED — do not redesign it, re-evaluate it, add to it, or read the codebase to check it.

architecture.md must OPEN with this single line:
Approach: ${d.approach} — <the rationale below, compressed to one line>

Then lay the rest out under clear headings: the rationale; the ordered build steps (preserving which are independent vs. must serialize); the files to create/modify; the public contract / API surface; the deliberately accepted trade-offs. Keep the contract section verbatim-faithful — the next phase writes tests from this file alone, WITHOUT seeing the implementation, so anything you drop there becomes an untested surface.

Rationale: ${d.rationale}

Ordered build steps:
${d.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Files to create/modify:
${d.files.map(f => `- ${f}`).join('\n')}

Public contract / API surface:
${d.contract}

Trade-offs deliberately accepted:
${d.tradeoffs}

Also update ${dir}/epic.md (approach filled in, phase: architect → done, append a phase-log line). Write nothing else.`,

  codeRed: (dir) =>
`Code phase, RED step. Write tests ONLY (no implementation). Read ${dir}/requirements.md and ${dir}/architecture.md, and derive tests from the requirements + the public contract/API surface. Cover what is genuinely testable in this stack (units, pure logic, backend handlers, frontend component behavior); for hard-to-test surfaces (canvas/visual, external I/O), SKIP and note in ${dir}/epic.md what is uncovered and why — do not fake a test.
Return the list of test files you created and a one-line confirmation they fail for the right reason.`,

  codeGreen: (dir, red, finish, pkgs) =>
`Code phase, GREEN step. Read ${dir}/architecture.md and ${dir}/requirements.md and the existing failing tests:
${red}

Implement the feature to make those tests pass, following architecture.md's build steps. Note any scope decision or wrong-test fix in ${dir}/epic.md's phase log. Run \`npm run verify\` in EACH touched package (this repo's packages: ${pkgs}) until green — that script is the project's whole gate, so whatever it runs (including any real-database tier it triggers for itself) has to be green, not just the unit tests.
${finish}
Update ${dir}/epic.md (phase: code → done, phase log). Return a short status: packages verified green, and any in-flight decisions or remaining failures you could not resolve.`,

  readRequirement: (dir) =>
`Read ${dir}/requirements.md and return its full contents VERBATIM in the "requirement" field.
Then report this repo's layout in the "packages" field. This is the manual flow's only pass before code, so it is the one chance to establish the layout; read the package.json files you need for it and nothing else.
${DISCOVERY}`,

  review: (requirement, lens, diffCmd) =>
`Review this change for the lens: ${lens}.

Requirement to judge against — this is the ONLY spec context you get; reconstruct expected behavior from it + the diff alone:
"""
${requirement}
"""

Read \`${diffCmd}\` / \`${diffCmd} --stat\` and the source tree to judge the change. Do NOT open ANY file under \`.epics/\` — architecture.md, epic.md, review.md and summary.md all encode the builder's intended behavior and would anchor you; you have the requirement above and do not need that directory.
If nothing meets your confidence bar, return an empty findings array.`,

  verify: (findings, diffCmd) =>
`Adversarially verify ${findings.length === 1 ? 'a code-review finding' : `${findings.length} code-review findings reported against the same file`}. Default to refuting each unless the code clearly bears it out.

${findings.map((f, i) => `--- Finding ${i + 1} ---
Title: ${f.title}
Severity: ${f.severity}
Location: ${f.location}
Claim: ${f.problem}`).join('\n\n')}

Read the relevant code and \`${diffCmd}\`. Do NOT open anything under \`.epics/\` — it carries the builder's intent and would anchor you. For each finding, determine whether the claim genuinely holds (real) or is a false positive / already handled (not real). Set real=false if you cannot confirm it against the actual code.

Return exactly ${findings.length} verdict${findings.length === 1 ? '' : 's'} — one per finding — with \`index\` set to that finding's number above (${findings.length === 1 ? '1' : `1-${findings.length}`}).${findings.length > 1 ? `

These were reported independently by different review lenses, so several may be one defect restated in different words. Judge each on its own merits: if two are the same defect, say so in the reasoning and let them stand or fall together — do NOT mark one not-real merely because it overlaps another.` : ''}`,

  reviewWrite: (dir, confirmedJson, unconfirmedJson) =>
`Write ${dir}/review.md from the review results below.

Confirmed findings (survived adversarial verification) — these come first, highest severity first. For each: severity, confidence, file:line, the behavior/guideline it breaks, a concrete fix, and the gate (test/type/real-DB check/lint) that would catch its whole class next time. If the list is empty, say so plainly.

Confirmed (JSON):
${confirmedJson}

Unconfirmed findings (adversarial verification refuted them or could not confirm) — if any, add a FINAL section titled exactly "## Unconfirmed — not fixed": one line per finding plus the verifier's reasoning. Open the section by stating that triage and ship MUST NOT act on these — they are recorded only so a human can double-check the discard. If there are none, omit the section.

Unconfirmed (JSON):
${unconfirmedJson}

Then update ${dir}/epic.md (phase: review → done, phase log). Do not fix anything.`,

  triage: (dir, finish, pkgs) =>
`Triage phase, autonomous (NO user sign-off). Read ${dir}/review.md and the diff. Apply fixes for the CONFIRMED findings only, highest severity first — NEVER act on anything under "## Unconfirmed — not fixed" (those were refuted; they are listed for human eyes only). For every finding you fix, also add the automated check that would catch its whole CLASS, not just the instance in front of you — a test, a type, a lint rule, or a shared helper that makes the footgun impossible — so the gate fails on any recurrence. Every review finding is a missing gate. Where this project's CLAUDE.md states its own harden-the-gate rule, follow that wording; this instruction stands on its own where it does not.
When the check that would catch a class is NOT expressible as a test/type/lint but is a convention (a rule about how to write something, a footgun only a human would know to avoid), amend the constitution instead — but only THIS project's own: the relevant section of its CLAUDE.md, or the path-scoped \`.claude/rules/*.md\` covering the code in question, in the file's existing voice and length. Those are the only two places you may write a rule. The skills, agents and this pipeline are shared harness files that live outside this repo and are used by other projects: a rule that belongs to one of them is out of scope for an epic, so do NOT edit or recreate one — record it as DEFERRED in ${dir}/epic.md's phase log, stating the rule you would have written and which harness file it belongs in, and leave the harness untouched. A class with no gate at all is the outcome to avoid — a written rule beats nothing, and a deferred note beats a silent gap. Note any such amendment or deferral in ${dir}/epic.md's phase log so it surfaces in the PR body.
If a finding is genuinely too risky or expensive to fix safely without a human decision, DO NOT guess — leave it, and record it as deferred (with why) in ${dir}/epic.md's phase log so the summary surfaces it.
After fixes, re-run \`npm run verify\` in each touched package (this repo's packages: ${pkgs}) until green.
${finish}
Update ${dir}/epic.md (phase: review→triaged). Return:
- status: a short summary — which findings were fixed, which were deferred and why, and the final verify result.
- deferred: one entry per CONFIRMED finding you did NOT fix; empty array when you fixed them all. This list is a MERGE GATE: an empty list queues the PR to be merged to main unattended, so omitting something you left unfixed ships it. Report every one.`,

  ship: (dir, issue, slug, design, triageStatus, tally) =>
`Ship phase, autonomous. The work is complete and verified; now record deferrals, squash the branch to one commit, push, and open the PR. ALL git/gh work happens here.

1. Write ${dir}/summary.md (the PR body source) — keep it about THIS diff, not future work. Do NOT include a files-modified/diff-stat listing or a verification/test-results section — the PR's Files tab and checks already show both, so in the body they are pure noise. Capture, against ${dir}/requirements.md: what was built; the architecture approach — "${design?.approach}": ${design?.rationale}; review outcome — OPEN that section with this tally verbatim: "${tally}", then the findings that survived verification and which were fixed (ignore review.md's "Unconfirmed — not fixed" section: those were refuted, not deferred — but the refuted COUNT stays in the tally, which is the only durable record they were ever raised, since review.md is gitignored and dies with the worktree). Do NOT enumerate deferred/out-of-scope work in the PR body — instead add a single pointer line: "Deferred items recorded on #${issue}." Triage status: ${triageStatus}

2. Record deferred work on the ISSUE, not the PR. Read ${dir}/epic.md's phase log and ${dir}/review.md (confirmed sections only — refuted "Unconfirmed" findings are NOT deferred work) and collect everything deferred or out of scope: deferred review findings (with why), scope cut, edge cases intentionally skipped, clarifying answers that narrowed scope, uncovered test surfaces.
   a. Filing a follow-up issue is the EXCEPTION, not the default — the comment in (b) is the record, and it costs nothing. An unfiled item is not lost; an over-filed one rots in the backlog forever. An item earns an issue ONLY if it clears BOTH gates:
      GATE 1 — it is one of exactly three kinds:
        i.   a DEFECT that exists on main after this merge — a correctness, security, data-loss, or user-visible breakage bug, whether this diff introduced it or merely exposed it;
        ii.  a MISSING GATE — an automated check whose absence let a class of bug through, that could not be added inside this diff;
        iii. an EXPLICIT SCOPE CUT — a requirement stated in ${dir}/requirements.md that was deliberately not delivered.
      GATE 2 — it passes the slicing test: could ONE coherent PR close it and still mean something on its own? "Decide whether to X", "consider Y", "investigate Z" all FAIL — a question is not a mergeable change.
      Everything else goes in the comment ONLY: refactor and consolidation ideas, nice-to-haves, cosmetic nits, rare edge-case tests, uncovered surfaces with no known defect behind them, follow-up verification or eval runs (if a run is needed to trust THIS diff it is a blocker on this epic, not a future issue), and anything whose value depends on a diff that main will move past within days.
      Cap: file at most 3. If more than 3 clear both gates, file the 3 highest-severity (defects outrank everything) and state in the comment how many qualified versus how many were filed — needing more than 3 means the issue was under-scoped, and that count is the signal.
      To file: \`gh issue create --title "<clear title>" --body "<what + why deferred + Follow-up to #${issue}>"\` — no label. That \`Follow-up to #${issue}\` line IS the relation, and the only one you can set: GitHub records it as a cross-reference on #${issue}'s timeline. GitHub's "relates to" relationship is UI-only (public preview, no REST/GraphQL/\`gh\` surface as of 2026-08) — do NOT go hunting for an API call to set it. Do NOT create or apply a label (the namespace is the pipeline's lifecycle and a follow-up sits outside it), do NOT add a \`blocked_by\`/\`blocking\` dependency (the follow-up gates nothing — that would hold a queue back on work nobody is waiting for), and do NOT make it a sub-issue.
   b. Post ONE comment on issue #${issue} listing all deferred items, each as a bullet; for the filed ones include the follow-up issue link. Start the comment with this exact first line:
      🤖 deferred / not done
   If there is nothing deferred, skip both (a) and (b) and the pointer line in step 1.
   c. Return \`deferredDefects\` = how many of the collected items are GATE 1.i DEFECTS — a correctness, security, data-loss, or user-visible breakage bug that still exists on main AFTER this merges — whether or not you filed an issue for it. 0 when none. This is a MERGE GATE: 0 queues this PR for unattended merge and deploy; anything higher holds it open for a human. Count honestly — a missing gate, a scope cut, a nice-to-have, or a refactor idea is NOT a defect and must not inflate this number, and a real defect must not be rounded down to keep the merge.

3. Squash the branch into ONE clean commit:
   a. Fold any leftover working-tree changes into the checkpoint chain first: \`git add -A\`, then \`git commit -m "wip(epic ${slug}): pre-ship"\` only if something is staged (a clean tree skips this).
   b. \`git reset --soft $(git merge-base HEAD origin/main)\` — soft-reset to the merge base, NOT to origin/main itself (it may have advanced during the run), leaving the entire change staged.
   c. Commit once with the real message. It MUST include \`Closes #${issue}\` on its own line (trunk-based: this is what auto-closes the issue on merge — a bare \`(#${issue})\` only links). Then apply THIS project's own legal/compliance review trigger, if it has one: look in its CLAUDE.md for a section defining when a change needs legal or policy review. If one exists, judge this diff against the criteria written there — not against any you remember from elsewhere — and when they are met, add the exact marker string that section specifies to the commit body and the PR body. If this project's CLAUDE.md defines no such trigger, skip this check entirely: do NOT invent criteria and do NOT import another project's.
4. \`git push -u origin epic/${slug}\`. EXPECT this to be rejected as non-fast-forward, and treat that as normal rather than as an error: the branch has been on origin since Prepare claimed it, and the squash in step 3 just rewrote every commit above the merge base. Re-push with \`git push --force-with-lease -u origin epic/${slug}\`. The lease is what keeps that safe — it overwrites only the ref THIS run has been holding since it claimed the issue, and fails instead if anything else moved it.
5. Open the PR: \`gh pr create --head epic/${slug} --title "<title>" --body "<body>"\`, using ${dir}/summary.md as the body and including \`Closes #${issue}\` in it. Do NOT merge it, and do NOT wait for its CI. NOTHING in this run merges: \`bin/merge-worker.sh\` on the host rebases the PR onto whatever main has become, re-runs its checks and merges it, outside this run entirely.
6. Flip the start-signal to review-ready now that the work is done and the PR is open: \`gh label create ready-to-review --color 0E8A16 --description "epic-run finished; PR is open and awaiting review" 2>/dev/null || true\`, then \`gh issue edit ${issue} --remove-label in-progress --add-label ready-to-review 2>/dev/null || true\`. Leave the assignee in place (it records ownership). Apply \`ready-to-review\` and nothing else: whether this PR may instead be queued for unattended merge is decided by the pipeline AFTER you return, from the number you report in 2c, and it is not yours to pre-empt.
Update ${dir}/epic.md (phase: ship → done). Return the PR URL and deferredDefects.`,

  // Transport, not judgment: the merge gate has already been computed in the script from structured counts,
  // and this only writes its verdict where bin/merge-worker.sh will read it. Kept as a separate step AFTER
  // the gate — rather than folded into ship — so the promoting label can only ever exist downstream of a
  // clear gate. Ship's conservative `ready-to-review` is the state anything that goes wrong here decays to.
  handoff: (dir, issue) =>
`Queue issue #${issue} for the merge worker. The pipeline has ALREADY decided this PR may merge unattended — you are not re-judging that, and you must not merge, edit, rebase, push, or comment on anything.
1. \`gh label create ready-to-merge --color 0E8A16 --description "epic-run finished; PR open and gates cleared — queued for bin/merge-worker.sh" 2>/dev/null || true\`
2. \`gh issue edit ${issue} --remove-label ready-to-review --add-label ready-to-merge\`
3. Verify it landed: \`gh issue view ${issue} --json labels --jq '[.labels[].name]'\` must now contain \`ready-to-merge\` and NOT \`ready-to-review\`.
Append \`- handoff: queued for merge-worker\` to ${dir}/epic.md's phase log. Return labelled=true ONLY if step 3 confirmed both halves; otherwise labelled=false with what you saw.`,

  summaryManual: (dir, design, triageStatus) =>
`Write ${dir}/summary.md and return its full contents. This is the manual flow — do NOT commit, push, or open a PR; leave all changes in the working tree.
Capture, against ${dir}/requirements.md: what was built; the architecture approach — "${design?.approach}": ${design?.rationale}; files modified (\`git diff --stat\`); verify status per package; review outcome (findings that survived verification, which were fixed, which were DEFERRED and why — read ${dir}/review.md and ${dir}/epic.md); anything deferred or out of scope; a suggested next step. Triage status: ${triageStatus}
Update ${dir}/epic.md (phase: ship → done).`,

  blocked: (issue, slug, phase, reason, prUrl) => {
    const branch = slug ? `epic/${slug}` : null
    // A block AFTER ship means the PR is already open, pushed, and complete — the work needs a human, not
    // preservation, and a re-run would skip it (prepare's open-PR guard) rather than resume. Say so, or the
    // generic "re-run to resume" line sends the next run into a no-op.
    const preserve = prUrl
      ? `1. Nothing to preserve — the branch is pushed and PR ${prUrl} is open with the complete change. Run NO git commands.`
      : branch
      ? `1. Preserve the work — checkpoint commits already on ${branch} are durable; only uncommitted changes are at risk:
   a. If the working tree has uncommitted changes, commit them as WIP: \`git add -A && git commit -m "wip: epic blocked at ${phase}"\`. Do NOT add \`Closes #${issue}\` — this is unfinished work and must not auto-close the issue on an accidental merge; do not force-add gitignored paths. A clean tree has nothing to commit — skip this.
   b. Push ONLY if ${branch} has a commit not on origin (a checkpoint, the WIP commit above, or a Ship commit): \`git push -u origin ${branch}\` (ignore errors). A branch with no commits beyond origin/main has nothing worth pushing — skip.`
      : `1. No branch was created before the block — there is nothing to preserve in git.`
    const branchLine = prUrl
      ? `- PR: ${prUrl} — open on ${branch} and NOT merged, and NOT queued for the merge worker; the change itself is complete. Fix the cause above, then merge it by hand. A re-run of /epic #${issue} will skip (an open PR already delivers this issue).`
      : branch
      ? `- branch: ${branch} — re-running /epic #${issue} resumes from it; delete the branch (locally AND on origin) to force a fresh build`
      : `- branch: none (blocked before branch creation; a re-run of /epic #${issue} starts fresh)`
    const phaseLog = branch
      ? ` If \`.epics/${slug}/epic.md\` exists, append its \`## Phase log\` section verbatim under the body above — \`.epics/\` is gitignored and dies with the worktree, so this comment is what survives.`
      : ''
    return `The autonomous epic-run pipeline hit a blocker and must report it on GitHub, then stop. Do this and nothing else:
${preserve}
2. Post a comment on issue #${issue} whose body starts with EXACTLY this (fill the values; keep the first line and field names verbatim):

🤖 epic-run blocked
- phase: ${phase}
- reason: ${reason}
${branchLine}

Post it with \`gh issue comment ${issue} --body-file -\`, feeding the body via a heredoc on stdin.${phaseLog}
3. Flip the start-signal to failed — the autonomous run stopped at a blocker, so it is no longer in progress: \`gh label create failed --color B60205 --description "epic-run stopped at a blocker; needs human attention" 2>/dev/null || true\`, then \`gh issue edit ${issue} --remove-label in-progress --remove-label ready-to-merge --remove-label ready-to-review --add-label failed 2>/dev/null || true\` (a block AFTER ship happens once a terminal label is already on, so every one of them must come off — \`ready-to-merge\` above all, since leaving it would hand a failed run's PR to the merge worker). Leave the assignee in place.
Return confirmation that the comment was posted and the label was swapped to failed.`
  },
}

// ───────────────────────── Config ─────────────────────────
// Stage model tiering. Everything not listed here runs on the engine's own configured default model.
// MECHANICAL — the prompt is a fully-specified procedure with no judgment call: transport, transcription,
// scripted git/gh. Deliberately NOT applied to ship:pr (weighs the project's own legal/compliance trigger
// where it has one, and decides which deferrals become filed issues) or any code/review/triage stage.
// ship:handoff IS mechanical — the gate it writes down was already decided in the script, and a wrong
// answer there fails loudly and safely (the issue stays `ready-to-review`, where a human is looking).
// Downgrade a stage only when a wrong answer would fail loudly.
// DESIGN — the architect designs the epic in one pass. It is the one stage that fixes the shape of everything
// downstream (red writes its tests from that contract), so a weak call here is the most expensive kind. The
// transcription half of the phase is MECHANICAL.
// ADJUDICATE — the adversarial verifier is the last judgment before triage AUTO-APPLIES a fix with no human
// sign-off, so a wrong "real" here becomes a committed change and a wrong "not real" buries a live bug. It
// runs once per file cluster (a handful of spawns), not once per lens, which is what makes upgrading it cheap.
// The five finders stay at the default tier deliberately: they drive recall, and more cheap finders beat fewer
// expensive ones. If recall proves weak, add a sixth lens rather than upgrading the existing five.
//
// These are model names, not engines: every stage runs on the default engine (lib/engine.mjs) unless a
// stage also passes `engine`. That is the seam a second vendor plugs into — per stage, not per pipeline.
const MECHANICAL = 'sonnet'
const DESIGN = 'fable'
const ADJUDICATE = 'fable'

// This pipeline used to run its own real-database gate: an agent listed the changed paths, the script
// path-matched them, and a second agent ran the project's `test:db` suite. That whole tier is gone — the
// real-DB check now lives inside each project's `npm run verify`, triggered by a bash gate in the repo
// that diffs the paths itself. It is strictly better there: no agent in the loop to misjudge or misreport
// it, and CI runs `verify` too, so it also covers manual commits to main — which an in-pipeline gate could
// never reach. "verify green" now IMPLIES the real tier ran wherever it was needed, which is why nothing
// downstream attests to it separately.

// Lens 3 watches the boundary between the repo's halves — whichever two the repo actually has
// (frontend↔backend, frontend↔worker). Derived from the discovered package list, since a seam named for
// a package this repo does not have points the reviewer at nothing.
const reviewLenses = (pkgs) => [
  'correctness + concurrency (logic errors, null/undefined, races, dropped side-effects)',
  'simplicity + DRY + project conventions',
  pkgs.length > 1
    ? `test honesty + the ${pkgs.join('↔')} seam (a bug that spans the package boundary, each side correct-looking alone)`
    : 'test honesty + module seams (a bug that spans two modules, each correct-looking alone)',
  'requirements coverage / acceptance (walk EVERY requirement in the spec above one by one: verify the diff actually delivers it, and flag anything unmet, partially met, or silently narrowed)',
  'security + authorization (tenant/owner scoping on EVERY read and write, secret and token handling, injection, unsafe trust of client input)',
]

// ───────────────────────── Schemas ─────────────────────────
// Carried by both discovery-reporting agents. Kept OUT of either schema's `required` on purpose: prepare
// can legitimately return before it ever looks at the layout (refused, or an open PR already delivers the
// issue). The script validates it instead, after those early exits — see applyDiscovery.
const DISCOVERY_PROPS = {
  packages: {
    type: 'array', items: { type: 'string' },
    description: 'repo-relative path of every directory whose package.json declares scripts.verify (e.g. ["frontend","backend"]); "." for the repo root',
  },
}

const PREP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['alreadyExists', 'resumed'],
  properties: {
    ...DISCOVERY_PROPS,
    slug: { type: 'string', description: '"<issue>-<short-kebab-gist>", e.g. "42-locate-crop-pad" (≤ 40 chars; empty when refused)' },
    branch: { type: 'string', description: 'the branch name, epic/<slug>' },
    alreadyExists: { type: 'boolean', description: 'true if an open PR already delivers this issue (work was skipped)' },
    resumed: { type: 'boolean', description: 'true when an existing epic/<N>-* branch was found and resumed (rebased onto origin/main)' },
    refused: { type: 'string', description: 'set ONLY when the run must not start (closed issue, open blocked_by dependencies, "claimed by another run" when the claim push lost the race or a claim ref is already on origin, branch checked out elsewhere, resume-rebase conflict) — the reason' },
    requirement: { type: 'string', description: 'full verbatim contents of the requirements.md that was written' },
    note: { type: 'string', description: 'optional note, e.g. which PR made this a duplicate' },
  },
}
const REQ_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['requirement'],
  properties: {
    ...DISCOVERY_PROPS,
    requirement: { type: 'string', description: 'full verbatim contents of requirements.md' },
  },
}
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['approach', 'rationale', 'steps', 'files', 'contract', 'tradeoffs'],
  properties: {
    approach: { type: 'string', description: 'SHORT name for the design (3-6 words), used as its audit label' },
    rationale: { type: 'string', description: '2-4 sentences: the core idea and why it fits this codebase' },
    steps: { type: 'array', items: { type: 'string' }, description: 'ordered build steps; note which are independent vs. must serialize' },
    files: { type: 'array', items: { type: 'string' }, description: 'files to create/modify, each with a few words on what changes' },
    contract: { type: 'string', description: 'public contract / API surface, explicit enough to write tests against without the implementation' },
    tradeoffs: { type: 'string', description: 'what this approach deliberately accepts' },
  },
}
const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['title', 'severity', 'confidence', 'location', 'problem', 'fix', 'gate'],
        properties: {
          title: { type: 'string' },
          severity: { enum: ['Critical', 'Important'] },
          confidence: { type: 'number', description: '0-100' },
          location: { type: 'string', description: 'file:line (for an unmet requirement: the file where it should live, or the requirement itself)' },
          problem: { type: 'string', description: 'the behavior or guideline it breaks' },
          fix: { type: 'string', description: 'concrete fix' },
          gate: { type: 'string', description: 'the automated check that would catch this whole class next time' },
        },
      },
    },
  },
}
// One verify agent covers every finding at a file, so verdicts come back as an array keyed by the
// finding's 1-based number in the prompt. A missing/extra entry is handled at the call site (fail-closed
// to unconfirmed) rather than trusted, since one batch now carries a whole file's findings.
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      description: 'Exactly one entry per finding listed in the prompt, in that order',
      items: {
        type: 'object', additionalProperties: false, required: ['index', 'real', 'confidence', 'reasoning'],
        properties: {
          index: { type: 'number', description: '1-based number of the finding this verdict judges' },
          real: { type: 'boolean', description: 'true only if the finding genuinely holds against the code' },
          confidence: { type: 'number', description: '0-100' },
          reasoning: { type: 'string' },
        },
      },
    },
  },
}
const TRIAGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['status', 'deferred'],
  properties: {
    status: { type: 'string', description: 'short summary: what was fixed, what was deferred and why, final verify result' },
    deferred: {
      type: 'array',
      description: 'one entry per CONFIRMED finding left unfixed; empty when all were fixed (an empty list is what lets the PR be queued for unattended merge)',
      items: {
        type: 'object', additionalProperties: false, required: ['title', 'severity', 'why'],
        properties: {
          title: { type: 'string' },
          severity: { enum: ['Critical', 'Important'] },
          why: { type: 'string', description: 'why it was left for a human' },
        },
      },
    },
  },
}
const SHIP_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['prUrl', 'deferredDefects'],
  properties: {
    prUrl: { type: 'string', description: 'URL of the opened PR' },
    deferredDefects: { type: 'number', description: 'how many deferred items are DEFECTS that still exist on main after this merges (0 when none)' },
  },
}
const HANDOFF_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['labelled'],
  properties: {
    labelled: { type: 'boolean', description: 'true ONLY if `gh issue view` was observed carrying ready-to-merge and not ready-to-review' },
    summary: { type: 'string', description: 'one line on what was observed' },
  },
}

// ───────────────────────── Args & mode ─────────────────────────
// Issue mode (--issue N): self-contained — branch, build, ship a PR, or post a blocker comment.
// Slug mode (--slug S): manual — build on the current tree from an existing requirements.md, no git.
let ARGS
try {
  ARGS = parseArgs(process.argv.slice(2), { allowSlug: true, usage: USAGE })
} catch (e) {
  if (e instanceof UsageError) {
    process.stderr.write((e.message ? `epic-run: ${e.message}\n\n` : '') + e.usage + '\n')
    process.exit(e.message ? EXIT.ERROR : EXIT.OK)
  }
  throw e
}
initRuntime({ scriptName: 'epic-run', sessionName: ARGS.session })

const issue = ARGS.issue
let slug = ARGS.slug
const gitMode = issue != null

// In git mode the blocker path posts a comment on the issue; in slug mode it just returns the error.
// blockerPosted guards the double-post: fail() can be re-entered when the blocked agent itself throws
// (e.g. the engine dying), and the outer catch calls fail() again.
// openPr is set once ship succeeds: a block after that point must not tell the reader to resume a branch
// whose work is already delivered by an open PR.
let currentPhase = 'prepare'
let blockerPosted = false
let openPr = null
async function fail(phase, reason) {
  if (gitMode) {
    if (!blockerPosted) {
      blockerPosted = true
      await agent(PROMPTS.blocked(issue, slug, phase, reason, openPr),
        { label: 'ship:blocked', phase: 'Ship', agentType: 'coder', model: MECHANICAL })
    }
    return { blocked: true, issue, slug, phase, reason, prUrl: openPr || undefined }
  }
  return { error: `${phase}: ${reason}` }
}

// The issue carries no per-phase commentary: the ready → in-progress → ready-to-merge/ready-to-review/failed
// label lifecycle is the live signal, the PR body is the record of HOW it was built, and the only comments
// are the deferred list (nothing else records it) and the blocker report. Per-phase posts duplicated the PR
// body, notified watchers five times per run, and each one cost an awaited agent spawn on the critical path.

let requirement
// Discovered layout: which packages the verify gate runs in. Set once, by whichever pre-code agent this
// mode runs (prepare in git mode, read:requirement in slug mode).
let packages = []

// Fail closed on discovery, like every other gate in this file: an empty package list would make the
// verify gate a silent no-op — the run finishes "green" having verified nothing.
// Returns null when the discovery is usable, or the blocker reason when it is not.
const applyDiscovery = (d) => {
  const clean = (p) => String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '')
  const pkgs = Array.isArray(d.packages) ? d.packages.map(clean).filter(Boolean) : []
  if (!pkgs.length) {
    return 'layout discovery found no package declaring an `npm run verify` script, so the verify gate downstream would be a silent no-op — refusing to build a change that nothing would verify.'
  }
  packages = pkgs
  return null
}
// How the package list reads inside a prompt: "frontend/, backend/".
const pkgList = () => packages.map(p => (p === '.' ? 'the repo root' : `${p}/`)).join(', ')

async function main() {
try {
  // ───────────────────────── Phase 0: Prepare (issue mode only) ─────────────────────────
  if (gitMode) {
    phase('Prepare')
    const prep = await agent(PROMPTS.prepare(issue),
      { label: 'prepare', phase: 'Prepare', agentType: 'coder', model: MECHANICAL, schema: PREP_SCHEMA })
    if (!prep) return await fail('prepare', 'Prepare failed — could not fetch the issue or reach git/gh.')
    if (prep.refused) {
      log(`Prepare refused to start: ${prep.refused}`)
      return { skipped: true, issue, reason: prep.refused }
    }
    if (prep.alreadyExists) {
      log(`Prepare: an open PR for #${issue} already exists — skipping to avoid duplicate work.`)
      return { skipped: true, issue, slug: prep.slug, reason: prep.note || 'an open PR for this issue already exists' }
    }
    if (!prep.slug || !prep.requirement) return await fail('prepare', 'Prepare returned no slug/requirement — branch or requirements.md was not set up.')
    const badLayout = applyDiscovery(prep)
    if (badLayout) return await fail('prepare', badLayout)
    slug = prep.slug
    requirement = prep.requirement
    log(`Prepare: requirements written, branch epic/${slug} ${prep.resumed ? 'resumed and rebased onto origin/main' : 'created off origin/main'}, deps checked. Packages: ${pkgList()}.`)
  }

  const dir = `.epics/${slug}`
  // Git mode reviews the checkpoint-committed branch against the fresh base; manual mode reviews the working tree.
  const DIFF = gitMode ? 'git diff origin/main...HEAD' : 'git diff'
  // How code/triage make their work visible downstream: git mode checkpoint-commits (durability + clean
  // origin/main...HEAD diffs); manual mode keeps the git add -N dance (no commits allowed on the user's tree).
  const checkpoint = (label) => gitMode
    ? `Then checkpoint the work so it survives an interrupted run: \`git add -A && git commit -m "wip(epic ${slug}): ${label} checkpoint"\`. This is a durability checkpoint, NOT the final commit — Ship squashes the branch into one clean commit later. NEVER put "Closes #..." in a checkpoint message; do NOT push. (.gitignore keeps \`.epics/\` out, and committing makes new files visible to the review's \`git diff origin/main...HEAD\`.)`
    : `Then run \`git add -N .\` (intent-to-add) so the downstream blind review can see your work: new files are untracked and would otherwise be INVISIBLE to the \`git diff\` / \`git diff --stat\` the reviewers read. This respects .gitignore, so \`.epics/\` stays excluded. Do NOT commit — this is the manual flow.`

  // ───────────────────────── Phase 1: Architect ─────────────────────────
  // One read-only architect designs the epic outright; one mechanical coder transcribes it to architecture.md.
  currentPhase = 'architect'
  phase('Architect')

  // The spec is fed inline to the blind reviewers so they never need to enter .epics/<slug>/ (where
  // epic.md/architecture.md/etc. would anchor them). Issue mode gets it straight from Prepare's output;
  // manual mode has no Prepare, so one agent reads the file (the orchestrator itself has no FS access to it).
  if (!gitMode) {
    const reqRes = await agent(PROMPTS.readRequirement(dir),
      { label: 'read:requirement', phase: 'Architect', agentType: 'coder', model: MECHANICAL, effort: 'low', schema: REQ_SCHEMA })
    if (!reqRes || !reqRes.requirement) return await fail('architect', 'Could not read requirements.md — aborting before code.')
    const badLayout = applyDiscovery(reqRes)
    if (badLayout) return await fail('architect', badLayout)
    requirement = reqRes.requirement
    log(`Packages: ${pkgList()}.`)
  }

  const design = await agent(PROMPTS.architectDesign(dir),
    { label: 'architect:design', phase: 'Architect', agentType: 'architect', model: DESIGN, schema: DESIGN_SCHEMA },
  )
  if (!design) return await fail('architect', 'Architect design failed — aborting before code.')

  // Fail closed if the artifact never lands: red and green both read architecture.md, so building on a missing
  // one means implementing against nothing but the requirements — silently, and only visible in the diff.
  const wrote = await agent(PROMPTS.architectWrite(dir, design),
    { label: 'architect:write', phase: 'Architect', agentType: 'coder', model: MECHANICAL },
  )
  if (!wrote) return await fail('architect', 'architecture.md was not written — aborting before code, which reads it.')
  log(`Architecture: ${design.approach} — ${design.rationale}`)

  // ───────────────────────── Phase 2: Code (red → green → gate) ─────────────────────────
  currentPhase = 'code'
  phase('Code')

  // Red: tests only, written blind to any implementation (none exists yet), from requirements + the public contract.
  const red = await agent(PROMPTS.codeRed(dir),
    { label: 'code:red', phase: 'Code', agentType: 'coder' },
  )
  if (!red) return await fail('code', 'Red step failed — no tests written, aborting before implementation.')
  log('Code: red tests written and failing for the right reason.')

  // Green: implement against architecture + the red tests, then pass the gate. Single agent to keep the working tree coherent.
  const green = await agent(PROMPTS.codeGreen(dir, red, checkpoint('code'), pkgList()),
    { label: 'code:green', phase: 'Code', agentType: 'coder' },
  )
  if (!green) return await fail('code', 'Green step failed — implementation did not complete, aborting before review.')
  log('Code: implementation complete, verify gate run.')

  // ───────────────────────── Phase 3: Review (blind, adversarially verified) ─────────────────────────
  currentPhase = 'review'
  phase('Review')

  // Built here, not at module scope: lens 3's seam names the packages discovery actually found.
  const LENSES = reviewLenses(packages)

  // A finder that DIED must never look like a finder that found nothing. Coercing a null agent straight to []
  // hands the rest of the phase a clean bill of health for a lens that never ran, and the tally then ASSERTS a
  // full N-lens review in the PR body — the diff ships looking reviewed through a lens it never saw. Retry once
  // (these die from transient agent/API failures far more often than from anything reproducible), then fail
  // closed: review is the only gate between code and an auto-opened PR, so a hole in it stops the run.
  const shortLens = i => LENSES[i].split(' (')[0]
  const runLens = async (lens, i, attempt = 1) => {
    const r = await agent(PROMPTS.review(requirement, lens, DIFF),
      { label: `review:${i}${attempt > 1 ? ':retry' : ''}`, phase: 'Review', agentType: 'reviewer', schema: FINDINGS_SCHEMA },
    ).catch(() => null)
    if (r && Array.isArray(r.findings)) return r.findings
    if (attempt === 1) {
      log(`Review: lens "${shortLens(i)}" returned no result — retrying once.`)
      return runLens(lens, i, 2)
    }
    return null // sentinel: the lens died. Distinct from [], which means "ran, found nothing".
  }

  const lensResults = await parallel(LENSES.map((lens, i) => () => runLens(lens, i)))
  const deadLenses = lensResults.map((r, i) => (r === null ? i : -1)).filter(i => i >= 0)
  if (deadLenses.length) {
    return await fail('review', `${deadLenses.length} of ${LENSES.length} review lenses produced no result after a retry (${deadLenses.map(shortLens).map(n => `"${n}"`).join(', ')}) — the diff was never reviewed through them. Refusing to ship a PR whose body would claim a full ${LENSES.length}-lens review.`)
  }
  const reviews = lensResults.flat()

  // Soft dedup before the verify fan-out (free — reviews is already fully materialized). Overlapping lenses
  // (correctness vs. the seam lens) can restate the same defect, which otherwise gets verified twice, listed
  // twice in review.md, and fixed twice in triage. Collapse ONLY a confident duplicate — same location AND same
  // normalized title. Biased toward keeping: when in doubt we keep both, so distinct bugs at one file:line
  // survive (different titles) and nothing is ever dropped on location alone.
  const seen = new Set()
  const uniqueReviews = reviews.filter(f => {
    const k = `${(f.location || '').trim()}::${(f.title || '').trim().toLowerCase().replace(/\s+/g, ' ')}`
    return seen.has(k) ? false : seen.add(k)
  })
  // Cluster by FILE (line numbers stripped) before the adversarial fan-out. The title dedup above only catches
  // verbatim restatements; overlapping lenses (correctness vs. the seam lens) word one defect differently and
  // slip through. On #194 that put five paraphrases of a single history.ts bug in front of five separate
  // skeptics, each re-reading the same diff to re-confirm it. One skeptic per file pays that cost once and can
  // see the claims are one defect — a call the per-finding verifiers each had to make blind. Verdicts stay PER
  // FINDING: clustering changes who judges, never what survives.
  const fileOf = f => (f.location || '').trim().replace(/:\s*\d+(?:\s*-\s*\d+)?\s*$/, '') || '(unspecified)'
  const clusters = new Map()
  for (const f of uniqueReviews) {
    const k = fileOf(f)
    if (!clusters.has(k)) clusters.set(k, [])
    clusters.get(k).push(f)
  }
  log(`Review: ${reviews.length} raw finding(s) across ${LENSES.length} lenses; adversarially verifying ${uniqueReviews.length} in ${clusters.size} file batch(es).`)

  // Adversarial verify: an independent skeptic tries to REFUTE each finding before it counts. Refuted /
  // low-confidence findings are NOT silently dropped — they land in review.md's "Unconfirmed" section for
  // human eyes (triage and ship are told to ignore them). Fail closed on a missing verdict: batching means a
  // dead agent or a short array would otherwise take a whole file's findings with it, and a lost finding must
  // surface as unconfirmed (a human re-checks it), never vanish and never pass as confirmed.
  const noVerdict = f => ({
    finding: f,
    verdict: { real: false, confidence: 0, reasoning: 'Batched verifier returned no verdict for this finding — recorded as unconfirmed rather than dropped. Re-check by hand.' },
  })
  const verdicts = (await parallel([...clusters.entries()].map(([loc, group]) => () =>
    agent(PROMPTS.verify(group, DIFF),
      { label: `verify:${loc}`, phase: 'Review', agentType: 'reviewer', model: ADJUDICATE, schema: VERDICT_SCHEMA },
    ).then(v => group.map((f, i) => {
      const got = v && Array.isArray(v.verdicts) ? v.verdicts.find(x => Number(x.index) === i + 1) : null
      return got && typeof got.real === 'boolean' ? { finding: f, verdict: got } : noVerdict(f)
    })).catch(() => group.map(noVerdict)),
  ))).flat().filter(Boolean)

  const verified = verdicts.filter(r => r.verdict.real && r.verdict.confidence >= 75).map(r => r.finding)
  const unconfirmed = verdicts.filter(r => !(r.verdict.real && r.verdict.confidence >= 75))
    .map(r => ({ ...r.finding, verdict: r.verdict }))

  // The one line of the review that has to outlive the worktree. review.md is gitignored and the PR body is
  // told to skip the refuted findings, so without this tally in the PR nothing records they were ever raised.
  const reviewTally = `${reviews.length} raw finding(s) across ${LENSES.length} blind lenses → ${verified.length} confirmed by adversarial verification, ${unconfirmed.length} refuted`
  log(`Review: ${reviewTally}.`)

  // Write review.md from the surviving findings (+ the unconfirmed record).
  await agent(PROMPTS.reviewWrite(dir, JSON.stringify(verified, null, 2), JSON.stringify(unconfirmed, null, 2)),
    { label: 'review:write', phase: 'Review', agentType: 'coder', model: MECHANICAL },
  )

  // ───────────────────────── Phase 4: Triage (auto-apply, no sign-off) ─────────────────────────
  currentPhase = 'triage'
  phase('Triage')

  let triageStatus = 'No confirmed findings — nothing to triage.'
  let triageDeferred = []
  if (verified.length) {
    const triaged = await agent(PROMPTS.triage(dir, checkpoint('triage'), pkgList()),
      { label: 'triage:fix', phase: 'Triage', agentType: 'coder', schema: TRIAGE_SCHEMA },
    )
    // Fail closed: a dead triage agent leaves confirmed findings in an unknown state — some fixed, some not,
    // verify possibly never re-run — and the merge gate below reads exactly that list to decide whether main
    // gets this change unattended. "We don't know what it left unfixed" must never merge.
    if (!triaged) return await fail('triage', `triage produced no result for ${verified.length} confirmed finding(s) — their state is unknown (partially applied fixes may sit in the tree) and the merge gate has nothing to read.`)
    triageStatus = triaged.status
    triageDeferred = Array.isArray(triaged.deferred) ? triaged.deferred : []
  }
  log(`Triage: ${triageStatus}`)

  // ───────────────────────── Phase 5: Ship ─────────────────────────
  // Issue mode: write summary.md, squash to one commit (Closes #N), push, open the PR. Slug mode: summary.md only, no git.
  currentPhase = 'ship'
  phase('Ship')

  if (!gitMode) {
    const summary = await agent(PROMPTS.summaryManual(dir, design, triageStatus),
      { label: 'summary:write', phase: 'Ship', agentType: 'coder', model: MECHANICAL },
    )
    return { slug, approach: design?.approach, greenStatus: green, findingsConfirmed: verified.length, findingsUnconfirmed: unconfirmed.length, triageStatus, summary }
  }

  const shipped = await agent(PROMPTS.ship(dir, issue, slug, design, triageStatus, reviewTally),
    { label: 'ship:pr', phase: 'Ship', agentType: 'coder', schema: SHIP_SCHEMA },
  )
  if (!shipped || !shipped.prUrl) return await fail('ship', 'Ship failed — commit/push/PR did not complete; the change is on epic/' + slug + ' (checkpoint commits + working tree).')
  openPr = shipped.prUrl
  log(`Ship: PR opened — ${shipped.prUrl}`)

  const result = {
    issue,
    slug,
    branch: `epic/${slug}`,
    prUrl: shipped.prUrl,
    approach: design?.approach,
    findingsConfirmed: verified.length,
    findingsUnconfirmed: unconfirmed.length,
    triageStatus,
    readyToMerge: false,
  }

  // ───────────────────────── The merge gate ─────────────────────────
  // Everything the pipeline could verify is green by here: verify per package (whatever that script gates,
  // including any real-database tier the project triggers for itself), five blind lenses adversarially
  // verified, and triage's fixes re-verified. What is left is the judgment calls the pipeline explicitly
  // refused to make. Those refusals ARE the gate — a deferred confirmed finding or a defect that outlives
  // this merge is the pipeline saying "a human decides this", and a human cannot decide it after it has
  // already deployed. Counted HERE in the script from structured values, never inside an agent that could
  // talk itself past them.
  //
  // The gate no longer merges anything; it chooses which terminal label the issue wears, and
  // `bin/merge-worker.sh` acts on that — rebasing onto current main, re-running CI, merging serially per
  // repo. Merging inside the run would park a build slot on a lock while the whole queue waited behind it.
  const deferredDefects = Number(shipped.deferredDefects) || 0
  const mergeBlockers = []
  if (triageDeferred.length) {
    mergeBlockers.push(`${triageDeferred.length} confirmed review finding(s) left unfixed by triage (${triageDeferred.map(d => `${d.severity}: ${d.title}`).join('; ')})`)
  }
  if (deferredDefects > 0) {
    mergeBlockers.push(`${deferredDefects} deferred defect(s) that still exist on main after this merge`)
  }

  if (mergeBlockers.length) {
    const why = mergeBlockers.join(' + ')
    log(`Merge gate: held — ${why}. PR stays ready-to-review for a human.`)
    return { ...result, mergeSkipped: why }
  }

  // Promotion, never demotion: ship already applied the conservative `ready-to-review`, so every way this
  // step can go wrong leaves the issue in front of a human rather than in an unattended merge queue. That
  // asymmetry is the reason it is a separate step instead of something ship decided for itself.
  const handed = await agent(PROMPTS.handoff(dir, issue),
    { label: 'ship:handoff', phase: 'Ship', agentType: 'coder', model: MECHANICAL, schema: HANDOFF_SCHEMA },
  ).catch(() => null)
  if (!handed || !handed.labelled) {
    const why = `merge gate was clear but ready-to-merge could not be applied${handed?.summary ? ` (${handed.summary})` : ''} — the PR is complete and stays ready-to-review`
    log(`Merge gate: clear, handoff FAILED — ${why}.`)
    return { ...result, mergeSkipped: why }
  }
  log(`Merge gate: clear — #${issue} is ready-to-merge; bin/merge-worker.sh owns it from here.`)

  return { ...result, readyToMerge: true }
} catch (e) {
  return await fail(currentPhase, (e && e.message) || String(e))
}
}

process.exit(finish(await main()))
