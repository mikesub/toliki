# Toliki workflow

This document describes the current issue-to-merge workflow implemented by the
scripts. It is an operational map, not a second configuration source. The code
and its comments remain authoritative when the two disagree.

## At a glance

```text
plain ready issue
  -> Prepare
  -> Architect
  -> Code + verify
  -> Review
  -> Repair + verify, when findings exist
  -> Final review, when adjudication is needed
  -> Correction + verify + narrow confirmation, when every blocker is concrete
  -> Ship PR
  -> Merge gate
  -> Merge worker
  -> main

ready + task issue
  -> Shared Prepare
  -> One tasker (implement + self-review)
  -> Verify
  -> Rebase + re-verify when main moved cleanly
  -> Shared candidate + handoff
  -> Merge worker
  -> main
```

The call counts below are the primary path. Explicit gate retries and runtime
recovery may add fresh processes as described in each section and in Shared
failure behavior.

| Step | Owner | Primary LLM calls |
| --- | --- | --- |
| 1. Prepare | Shell/Node orchestrators | None |
| 2. Architect | `architect` charter | Usually one; none when the resumed artifacts are all valid |
| 3. Code | `coder` charter | One in direct mode, RED + GREEN in test-first mode; a completed checkpoint initially skips both. The implementing call also returns the delivery record the run is published from |
| 4. Review | `reviewer` charter | One broad review, and the only broad review of the change |
| 5. Repair | `coder` charter | One when findings exist |
| 6. Final review | `reviewer` charter | One when findings need adjudication; it is this repair's exhaustive acceptance check |
| 7. Correction | `coder` + `reviewer` charters | One correction and one narrow confirmation, only when every blocker is a concrete defect |
| 8. Ship | `epic-run.mjs` and transport libraries | None |
| 9. Merge gate | Node orchestrator | None |
| 10. Merge worker | Shell scripts | None |
| Task path | `tasker` charter plus orchestrator | One; at most one fresh diagnostics-driven repair after a genuinely red first verify |

Every LLM call is a new, short-lived process. The selected `engine:<name>` maps
each step to a vendor, model, and effort in [`etc/engines.json`](etc/engines.json).
The eight engine step keys and their charters are fixed in
[`workflows/lib/engine.mjs`](workflows/lib/engine.mjs):

| Engine step | Charter | May edit the worktree? |
| --- | --- | --- |
| `task` | `tasker` | Yes |
| `architect` | `architect` | No |
| `code` | `coder` | Yes |
| `review` | `reviewer` | No |
| `fixes-after-review` | `coder` | Yes |
| `final-review` | `reviewer` | No |
| `fix-conflicts` | `coder` | Yes |
| `fix-ci` | `coder` | Yes |

Git, GitHub, labels, dependency installation, verification, checkpointing,
pushes, PR creation, and merging are always performed by deterministic code.
An agent's report that one of those operations succeeded is never the gate.

The epic pipeline's and the three fixers' prompts are one module per model
step under [`workflows/prompts/`](workflows/prompts): `prompts/epic/`,
`prompts/conflict/`, `prompts/ci/`, `prompts/defect/`, and `prompts/shared/`
for the verification retry every fixer appends. Task-run builds its own two
prompts in [`workflows/task-run.mjs`](workflows/task-run.mjs). Each module exports a builder function taking that step's runtime
arguments; the orchestrator imports it and keeps the capture, the execution and
the control flow around it. Charters and schemas are unchanged by that split:
the standing rules stay in `agents/*.md` and the shape of an answer stays in
the phase's schema.

## Lightweight task path

The persistent `task` label is an explicit human workflow choice, not a
lifecycle state or a model classification. Dispatch sends plain `ready` to
`epic-run.mjs` and `ready` plus `task` to `task-run.mjs`; both reuse the same
`<repo>-epic-<N>` session, `epic/<N>-*` branch namespace and safety-critical
claim, engine-pin, candidate, quota and handoff implementation.

Task-run starts one writable `tasker` process. It receives the settled issue
and must implement it, add meaningful coverage and return structured title,
summary, commit rationale, test, self-review and unresolved-work fields. The
orchestrator then runs every discovered package's `npm run verify`. If that
first gate is genuinely red, one fresh tasker receives the original requirement
and the bounded, sanitized failure diagnostics, inspects the existing worktree,
and repairs it in place; the worktree diff is not duplicated into its prompt.
The orchestrator runs the complete gate once more and that verdict is final. A
clean moved base is rebased and verified again before the candidate is formed;
a conflicting base is left to the merge worker and its conflict fixer. The
squashed candidate commit includes `Closes #N`, and its issue summary records
that the delivery was verified but intentionally not independently reviewed.

There is no architect, RED/GREEN split, reviewer, review repair or correction.
There is also no transient or invalid-schema model respawn: malformed
output, a tasker-declared blocker, a provider/process failure or timeout
preserves the branch and rests the issue at `failed`. The verification repair
is started only for a normal nonzero project-gate result, runs with both
respawns disabled, may not weaken tests or expand scope, and can never spawn a
third tasker. A second red gate blocks with both attempts' diagnostics; a
rebase-time red gate never retries. A hard quota in either tasker records only
the task step's vendor hold and restores `ready` while retaining `task` and the
engine pin. Later conflict or CI fixer prompts carry the intentional review
omission.

## 1. Prepare

**Owner:** [`bin/dispatch.sh`](bin/dispatch.sh),
[`bin/launch.sh`](bin/launch.sh), shared
[`workflows/lib/issue-delivery.mjs`](workflows/lib/issue-delivery.mjs), and the
epic/task entry points. **LLM calls:** none.

1. Cron runs `dispatch.sh`, which checks repair queues first and then walks
   each repo's `ready` issues oldest-first.
2. Dispatch resolves the issue's engine, skips engines under a provider-quota
   hold, skips open `blocked_by` dependencies, and ignores an issue that
   already has an exact `<repo>-epic-<N>` session.
3. `launch.sh` enforces the host-wide slot cap inside the session-creation lock,
   updates the registered clone, creates or reuses the issue worktree, and
   starts `<repo>-epic-<N>` in tmux.
4. The pane runs `node workflows/epic-run.mjs` or `node workflows/task-run.mjs`
   according to the strong-read labels, with `--issue <N> --session <name>
   --engine <name> --repo <registered-key>`; its scrollback becomes the complete
   phase log. The explicit repository key also keeps host telemetry for equal
   issue numbers in different repositories separate.
5. The orchestrator starts one best-effort live status comment on the issue.
   Phase changes edit that comment in place; reporting failure never decides a
   pipeline gate.
6. The selected run reads the issue number, title, body, and state. A closed issue
   is refused.
7. It reads `blocked_by` again. An open dependency or an unreadable dependency
   query is refused before the issue is claimed.
8. It fetches `origin`, records the worktree's starting SHA for dependency
   comparison, and refuses to build against an unconfirmed base.
9. It searches open PRs for an existing `epic/<N>-*` delivery, including the
   legacy `Closes #N` body form, and skips duplicates.
10. It either claims or resumes the branch:
   - **New run:** derive `epic/<N>-<slug>` from the title, branch from
     `origin/main`, create a unique empty claim commit, and push the ref. The
     push is the cross-host compare-and-swap lock; a rejected push means
     another run won.
   - **Resume:** find the local or remote `epic/<N>-*` branch, refuse a remote
     claim-only branch owned by another run, checkpoint any dirty work,
     and rebase the saved branch onto `origin/main`. A conflicting resume is
     left for manual resolution.
11. On a resumed epic branch, it inspects checkpoint subjects to distinguish a
    completed code phase from preserved partial work. Completed code is not
    rebuilt later; partial work receives a direct continuation plan. A task
    resume keeps the preserved tree but spends its new invocation on one fresh
    tasker process.
12. It verifies the exact durable `engine:<name>` label. Only a newly won claim
    may create a missing route; a resume requires the existing singleton and
    never rewrites a conflicting route.
13. It ensures lifecycle labels exist, changes `ready` to `in-progress`, and
    self-assigns the issue. These two reporting writes are best effort after
    the branch claim is secure.
14. It makes `.epics/` worktree-locally ignored, writes the issue body to
    `.epics/<slug>/requirements.md`, and creates or resumes `epic.md` as the
    phase log. The orchestrator is that log's only writer for the whole run: no
    step is asked to append to it, and every line comes from what a step
    returned or from what the orchestrator itself did.
15. It discovers the repo root and one-level child packages whose
    `package.json` declares `scripts.verify`.
16. For each discovered package, it runs `npm ci` only when a lockfile exists
    and `node_modules` is missing or that lockfile changed across the base
    transition.
17. Prepare returns the requirement, branch, package list, dependency evidence,
    and resume state to Architect or Task. Finding no verifiable package blocks
    before any model runs.

Manual `--slug` mode does not run Prepare. It uses the current working tree and
requires an existing `.epics/<slug>/requirements.md`.

An operator may launch issue mode through `./toliki run epic <N>` or
`./toliki run task <N>` instead of waiting for dispatch. It still goes
through `launch.sh` and the same shared Prepare transport. An omitted engine is
resolved read-only from the issue pin or host default; an explicitly selected engine is persisted before
launch. Only this manual pipeline path can request `--over-capacity`.

## 2. Architect

**Owner:** `architect` charter, invoked by
[`workflows/epic-run.mjs`](workflows/epic-run.mjs). **LLM calls:** zero or
one logical call.

1. The orchestrator loads the prepared requirement and discovered package
   layout.
2. For a new run, it starts one read-only `architect` process. The architect
   explores the real codebase and commits to one proportional implementation
   approach. It treats the supplied requirements as complete and settled,
   making implementation decisions without requesting clarification or
   changing their scope.
3. The architect returns schema-checked fields: approach, rationale, ordered
   build steps, files, public contract, accepted trade-offs, and verification
   evidence.
4. It chooses one verification mode:
   - `test-first` when a meaningful failing regression materially improves
     confidence.
   - `direct` for a small or low-risk change where a manufactured RED phase
     adds no useful evidence.
5. A resumed partial implementation is planned as `direct`; the script refuses
   to pretend a dirty tree still has a clean RED baseline.
6. A resumed code checkpoint first reuses `.epics/<slug>/architecture.json` and
   `.epics/<slug>/delivery.json`. If either artifact is missing or invalid, a
   read-only architect reconstructs it from the finished implementation without
   changing it; whichever artifact survived is kept as it stands.
   Both the reconstruction and a resumed partial continuation receive the
   requirement and the orchestrator-captured diff of the existing work inline;
   a capture that fails blocks rather than sending the architect to find it.
   A fresh design receives the requirement inline and explores the codebase.
7. The orchestrator validates the complete structure and non-empty verification
   evidence. Invalid architecture blocks before Code.
8. Deterministic rendering writes `architecture.json` and `architecture.md`;
   the latter is the contract the coder and any RED test writer receive.

## 3. Code

**Owner:** `coder` charter plus the verification/checkpoint code in
[`workflows/epic-run.mjs`](workflows/epic-run.mjs) and
[`workflows/lib/repo.mjs`](workflows/lib/repo.mjs). **LLM calls:** zero to
two logical calls, depending on resume state and verification mode.

1. A resumed code checkpoint skips the coding agent and immediately re-runs
   the real verify gate against its newly rebased base.
2. A fresh `test-first` plan begins with orchestrator-run `npm run verify` in
   every discovered package. A red baseline blocks; it cannot be mistaken for
   the requested regression.
3. The RED `coder` process receives the requirement inline, writes tests only
   without executing them, and identifies the exact intended failing
   test/assertion, why it proves missing required behavior, and any surface it
   deliberately left uncovered. The orchestrator records that uncovered list in
   the phase log; the RED writer never writes to a run artifact itself.
4. The orchestrator confirms the RED delta contains exactly the declared test
   files, then runs verify and accepts RED only when every failing package
   contains that exact assertion evidence. A green result, timeout, spawn
   error, undeclared-file failure, or different assertion is rejected.
5. One explicit RED retry is allowed. A second failure to establish meaningful
   RED blocks before implementation.
6. The GREEN `coder` process implements the architecture against the failing
   tests. In `direct` mode, one `coder` process instead implements the change
   and adds or updates useful tests in the same pass.
7. The coder receives the requirement inline and returns its edits without
   running tests, builds, linters, type checks, or the project verification
   command, and may not commit or push. Its scope decisions, plan adjustments
   and unresolved questions come back in its returned status, which the
   orchestrator writes into the phase log.
8. The GREEN or direct process also returns the run's **delivery record**: the
   PR/commit title, the durable commit rationale, this project's own legal
   marker when its AGENTS.md defines that trigger and the change meets it, and
   the work it deliberately left undone with the kind of each item and whether
   one coherent PR could close it. There is no later prose step, so this is the
   only place that judgment is collected; the orchestrator validates it and
   writes `.epics/<slug>/delivery.json`. A missing or blank title or commit
   rationale blocks here, before Review spends anything.
9. The orchestrator alone runs `npm run verify` in every discovered package. The exit
   codes and bounded, terminal-formatting-free output are the authoritative
   evidence used in prompts, logs, and GitHub comments.
10. If verification is red, the implementation process is respawned once with
    the actual failure output. A second red result blocks before Review.
11. The orchestrator checkpoints all nonignored implementation work as
    `wip(epic <slug>): code checkpoint`. Manual mode uses intent-to-add instead
    of committing.

## 4. Review

**Owner:** `reviewer` charter plus the review coordinator in
[`workflows/epic-run.mjs`](workflows/epic-run.mjs). **LLM calls:** exactly
one.

1. One broad `review:general` process runs, and it is the only broad review of
   this change. The architect-selected focused reviewer is gone: a second
   pre-repair opinion bought less than the exhaustive acceptance check that now
   runs after the repair, and two broad passes over one diff mostly
   re-litigated each other.
2. The orchestrator snapshots the shippable tree, Git/index/config metadata,
   and the complete change diff before the reviewer starts.
3. The reviewer receives the original requirement and captured diff. It is
   deliberately denied `.epics/` builder notes and does not see coder claims.
4. It checks requirement coverage, meaningful defects or regressions, and
   whether verification proves the changed behavior, across the whole diff.
5. Each finding must include title, severity, confidence, location, concrete
   problem, proposed fix, and useful regression evidence. The reviewer charter
   instructs the agent to return only `Critical` or `Important` findings at
   confidence 75 or above.
6. A dead reviewer is different from a reviewer returning no findings. If it
   produces no valid result after bounded runtime recovery, the run blocks.
7. The orchestrator proves the read-only review process did not change the
   tree or protected Git metadata. Any drift blocks.
8. Exact duplicate findings with the same normalized title and location are
   collapsed; related findings remain independently indexed.
9. The orchestrator writes the numbered finding ledger to
   `.epics/<slug>/review.md`. No findings skips Repair, Final review and
   Correction, and makes no acceptance or confirmation call.

## 5. Repair

**Owner:** a fresh `coder` process using the `fixes-after-review` step, plus the
orchestrator. **LLM calls:** none when Review found nothing; otherwise one
logical call, with one verification-driven retry available.

1. Every review finding is immediately actionable; there is no separate model
   confirmation pass before repair.
2. One fresh fixer receives the pinned requirement and the same
   orchestrator-captured diff the reviewer judged, inline, plus the source tree
   and the numbered findings. It is never told to run a Git command for that
   diff or to open the requirement file, so it and the final review that judges
   it read the same bytes.
3. For every index it must return exactly one disposition:
   - `fixed`: change the code and add meaningful regression coverage.
   - `disputed`: leave the code alone and cite concrete evidence that the
     finding is false.
   - `deferred`: explain why it cannot safely be repaired in this bounded
     round, and — only when what is left is concrete material work one coherent
     PR could close — the follow-up issue to file for it. That is the only
     place a review-side follow-up is decided; the orchestrator files what the
     fixer wrote and files nothing for a finding the final review then cleared.
4. The orchestrator rejects missing, duplicate, extra, out-of-range, or empty
   dispositions. Titles are never used as identities.
5. The fixer may make only the smallest change required by the findings and
   may not weaken tests or expand the feature.
6. The orchestrator runs `npm run verify` in every package. A red result starts
   one fresh fixer retry with the real failure output.
7. If verify remains red after that retry, the run blocks and never asks Final
   review to judge an unverified tree.
8. The orchestrator checkpoints the repaired tree as the triage checkpoint and
   captures the exact delta between Code and Repair.
9. If every finding is claimed `fixed` but the fixer produced no diff, those
   claims clear nothing: all findings become unresolved and the PR is held for
   a human without a Final review.
10. There is only one repair round. Later review cannot send the change back
    through this step again.

## 6. Final review

**Owner:** a fresh `reviewer` process using the `final-review` step, plus the
deterministic merge-readiness calculation. **LLM calls:** zero or one logical
call.

1. Final review runs when findings exist and the fixer changed code, disputed
   a finding, or deferred a finding.
2. The orchestrator snapshots the repaired tree and captures both the exact
   repair delta and the complete final change.
3. A fresh read-only reviewer receives the original requirement, every original
   finding and its reported action, the repair delta, and the full diff. The
   fixer's explanatory narrative is withheld.
4. The reviewer returns exactly one indexed verdict per original finding:
   `resolved`, `disproved`, or `unresolved`, with confidence and reasoning.
5. `uncertain` is represented as `unresolved`, never `disproved`. A finding
   clears only when it is resolved or disproved at confidence 75 or above.
6. The reviewer separately reports regressions introduced by the repair and
   any parts of the original requirement the complete change still misses.
7. An unresolved finding may set `defect: true` only when the reviewer
   positively proves the bug remains at confidence 75 or above. That narrow
   classification is what authorizes the scoped correction in step 7.
8. The orchestrator proves Final review changed neither the tree nor protected
   Git metadata. Drift blocks because no later review would see those bytes.
9. A malformed or missing final result clears nothing. Except for a provider
   quota failure, the pipeline records every item as unresolved and continues
   toward a human-held PR rather than inventing a verdict.
10. Regressions become new open findings; unmet requirements become explicit
    non-defect blockers. There is no second repair or third opinion.

Final review is this repair's **exhaustive acceptance check**: it examines every
original disposition and the complete repair delta, and returns a verdict for
each plus the complete batch of what still blocks — never one sufficient
refutation. That batch is what the next step can act on.

## 7. Correction

**Owner:** a fresh `coder` process using the `fixes-after-review` step and a
fresh `reviewer` process using the `final-review` step, plus the orchestrator's
verify contract. **LLM calls:** none unless every remaining blocker is a
concrete defect; otherwise one correction and one narrow confirmation.

1. The stage runs only when the merge gate's blockers exist and **every** one of
   them is a concrete defect Final review positively established. A mixed batch,
   an unmet requirement, uncertainty, a no-diff repair claim, or a missing
   adjudication never earned an automated repair and goes straight to a human.
2. Each blocker gets a run-local opaque identity, its kind (`original-defect` or
   `repair-regression`), location, concrete code evidence, and the observable
   outcome required to clear it. Titles are never identities.
3. The orchestrator snapshots the pre-correction tree, then starts ONE fresh
   writable `coder` process with the pinned requirement, the exact repair delta
   Final review judged, the successful verification evidence, and the complete
   blocker batch. The existing repair is preserved exactly as it is: nothing is
   cleaned, rebuilt, or re-reviewed.
4. The correction may address only those blockers and must return exactly one
   disposition per blocker id — no missing, duplicate, extra, or unknown ids.
   A declined blocker is a judgment call and ends the stage human-held.
5. A correction that changed no file has repaired nothing; the blockers stand
   and the stage ends human-held.
6. The orchestrator checkpoints the correction and runs the full `npm run
   verify` contract again. Red blocks the run with the resumable chain intact
   and starts neither another correction nor any automated repair queue.
7. One fresh read-only `reviewer` process narrowly confirms the correction. It
   receives the requirement, the blocker batch, Final review's verdict per
   original finding, the complete cumulative change and the exact correction
   delta — never the correction's own explanation.
8. It proves exactly four things: every blocker cleared, every previously
   upheld finding still clear, declined items unchanged, and no regression,
   gate weakening or unrelated behavior. It never restarts a broad review.
9. A complete, high-confidence confirmation clears those blockers, and the run
   takes the ordinary complete landing path. Anything else — a remaining
   blocker, a new regression, a missing verdict, a dead or malformed result, or
   low confidence — leaves the blockers standing and the PR held for a human.
10. There is exactly one correction batch. The orchestrator proves the
    confirmation changed neither the tree nor protected Git metadata.

## 8. Ship

**Owner:** [`workflows/epic-run.mjs`](workflows/epic-run.mjs) and the transport
libraries. **LLM calls:** none. Every piece of judgment this phase publishes was
collected where it was made: the coding phase's delivery record, the review
ledger's structured final states, and the fixer's own follow-up decisions.

1. The orchestrator stages any loose work into a pre-ship checkpoint and
   fetches current `origin/main`.
2. If main advanced, it tries to rebase the entire claim/code/triage checkpoint
   chain before squashing:
   - A clean rebase refreshes dependencies and re-runs `npm run verify`; red
     blocks with the resumable chain preserved.
   - A failed fetch or conflicting rebase falls back to the run's original
     base. The merge worker will rebase and re-check it later.
3. It derives the changed-file list from the same refs the candidate commit is
   formed at; a capture that fails blocks rather than reporting a list nobody
   established.
4. It assembles the remaining-work list from two structured sources and
   re-judges neither: every item behind a deterministic merge blocker, each
   carrying the run-local opaque identity assigned to that exact object, and
   the coding phase's own deferrals. Kinds rank filing order; they never gate
   the merge.
5. It folds the checkpoint chain into one commit at the actual merge base. The
   commit contains the delivery record's subject and rationale, its optional
   legal marker, and the deterministic `Closes #N` line.
6. It force-pushes the already-claimed branch with a lease and opens a PR whose
   body contains only deterministic links back to the source issue/run record.
7. After the PR exists, it posts one candidate-SHA-specific delivery summary to
   the source issue and reads it back. That record is rendered here: the durable
   commit rationale, the architect's chosen approach, one line per finding with
   its final verdict and confidence, the orchestrator's real verify evidence and
   changed-file list, the remaining work, and the gate state at capture time.
   Missing or duplicate confirmation blocks with the real PR, branch, and SHA
   recorded for manual recovery.
8. Only after that summary is confirmed does it post the deferred record and
   file up to three follow-up issues, defects first. A follow-up is filed only
   where a model wrote one — the fixer's follow-up for a finding it deferred and
   the final review left open, or a coding-phase deferral marked filable — so
   nothing is filed from slicing judgment a script made up. When dependency
   ordering can be written, each follow-up is made `blocked_by` the source issue
   before receiving `ready`. If ordering cannot be established, the follow-up is
   left unqueued.
9. It places the source issue conservatively at `ready-to-review`. The Merge
   gate may promote it, but this phase never decides unattended eligibility.

Manual `--slug` mode renders the same record into `.epics/<slug>/summary.md`
without the candidate identity it has no PR for; it does not commit, push,
create a PR, or change GitHub labels.

## 9. Merge gate

**Owner:** structured calculations and GitHub transport in
[`workflows/epic-run.mjs`](workflows/epic-run.mjs). **LLM calls:** none.

1. The gate reads only structured review outcomes produced before Ship:
   unresolved original findings, repair regressions, unmet requirements,
   missing adjudication, and false no-diff repair claims.
2. Builder-classified deferrals never enter this calculation; they cannot hold
   or release their own PR.
3. If no blockers remain, the script changes `ready-to-review` to
   `ready-to-merge` and reads the labels back.
4. If promotion cannot be confirmed, it issues a compensating transition back
   to `ready-to-review` and proves that demotion with bounded readback.
5. If neither promotion nor demotion can be proved, it moves to the ordinary
   blocker path rather than leave an unaccounted `ready-to-merge` label.
6. If any blocker remains, the PR stays `ready-to-review` for a human and no
   repair queue is opened. Epic-run no longer writes `needs-defect-fix`: the
   only hold that ever qualified for it — one made entirely of concrete
   defects — now gets its one scoped correction in step 7, inside the run that
   still has the context. `defect-run` remains for evidence older runs already
   published, and a re-run still strips a stale `needs-defect-fix`.
7. A normally completed or blocked run finishes at exactly one terminal state:
   `ready-to-merge`, `ready-to-review`, or `failed`. A verified provider-quota
   hold instead restores `ready` for a resumable run. Every path emits a final
   `RESULT <json>` line.

The first terminal label write opens one bounded reporting window shared by all
remaining GitHub calls. No new model may start after that window opens.

## 10. Merge worker

**Owner:** [`bin/merge-tick.sh`](bin/merge-tick.sh),
[`bin/merge-worker.sh`](bin/merge-worker.sh), and
[`bin/merge-autoresolve.sh`](bin/merge-autoresolve.sh). **LLM calls:** none.

1. Cron runs `merge-tick.sh`, which starts one worker per registered repo in
   parallel.
2. Each `merge-worker.sh` takes a non-blocking repo-specific lock. Within one
   repo it processes `ready-to-merge` issues oldest-first and strictly serially,
   because every merge moves that repo's main.
3. For the selected issue, it requires exactly one open PR on an
   `epic/<N>-*` branch. Multiple PRs are ambiguous; no PR is either reconciled
   as already merged or failed as missing.
4. It creates or scrubs a dedicated merge worktree, fetches origin, and verifies
   the remote branch still equals the PR head it inspected.
5. It checks out that exact head and rebases it onto current `origin/main` with
   diff3 conflict markers.
6. On conflict, `merge-autoresolve.sh` may resolve only containment-proven
   mechanical hunks. The worker records successful mechanical resolutions on
   the issue.
7. If any conflict requires judgment, the whole rebase is aborted and the
   issue receives `failed` plus `needs-judgment`. Other unresolvable failures
   receive plain `failed`.
8. A changed rebased head is force-pushed with a lease against the inspected
   PR head. An unchanged head reuses checks already tied to that exact SHA.
9. The worker waits for GitHub checks on the exact rebased SHA:
   - Pending checks wait up to the configured bound.
   - Success, skipped, and neutral conclusions pass.
   - A red completed check sets `failed` plus `needs-ci-fix`.
   - A registered-check timeout is infrastructure and becomes plain `failed`.
   - No checks after the registration grace is the supported no-CI case.
10. It reads the non-empty commit subject and body from that checked SHA; it
    never substitutes mutable PR prose or repository defaults.
11. It requests a squash merge with `--match-head-commit <checked-sha>`. Any
    push between the check gate and merge makes GitHub refuse instead of
    landing unverified bytes.
12. It reads the PR state back as `MERGED`, removes any leftover
    `ready-to-merge` label, and continues draining. `Closes #N` closes the
    source issue.
13. GitHub/network query failures abort the worker without writing a false PR
    verdict; cron retries next tick. A genuine PR-specific refusal is reported
    on the issue and the worker moves to the next candidate.
14. One invocation handles at most 20 candidates as a backstop against an
    unbounded drain.

## Repair and re-entry workflows

Repair queues are processed before new `ready` work. They reuse the same issue
session name and durable engine pin. Each has a two-rung attempt ladder: first
attempt, one retry, then human intervention. Their common sequence lives in
[`workflows/lib/fixer-lifecycle.mjs`](workflows/lib/fixer-lifecycle.mjs):
Prepare evidence, run one writable repair agent, run orchestrator verification,
run one exhaustive acceptance check, then publish. Prepare captures the whole
brief before the first call — the issue bodies, the pinned diffs, both conflict
sides and the commit subjects behind them, the failing jobs' logs — so the
repair and the blind checker that judges it read the same bytes, and the audit
comment's changed-file list is derived from the repair's own delta rather than
copied from what the repair said it touched. If the first repair is red,
the orchestrator gives one fresh repair process its bounded captured diagnostics
and runs the full gate again before any acceptance check. This in-run diagnostic
retry does not consume another durable attempt-ladder rung.

All three share the **bounded repair contract** in
[`workflows/lib/repair-acceptance.mjs`](workflows/lib/repair-acceptance.mjs),
the same contract epic-run's Final review and Correction use:

- The acceptance check replaces a global `survives` boolean and a free-form
  reason. It keeps examining every original disposition and the complete repair
  delta after it finds a refutation, returns an exact verdict per item, and
  returns the COMPLETE blocker batch rather than one sufficient counterexample.
- Every blocker carries a run-local identity, its kind (`original-defect`,
  `repair-regression`, `out-of-scope`, `human-judgment`), the original item when
  it names one, a location, concrete code evidence, and the observable outcome
  that clears it.
- The outcome is one of `clear`, `correction-required` (every blocker is a
  concrete implementation defect), or `human` (anything uncertain, unsupported,
  unsafe to change, or a decision rather than an implementation).
- Malformed, incomplete, duplicate, extra, unknown, ambiguous or low-confidence
  evidence authorizes nothing: it can neither start a correction nor release an
  unattended merge.
- On `correction-required` the current unpushed repair is preserved in place and
  ONE fresh writable correction runs in the same invocation over the whole
  batch. Nothing is cleaned, no queue is restored, no retry rung is consumed,
  and no second whole fixer is launched. The correction may address only those
  blockers, returns one indexed disposition per blocker id, and must produce a
  relevant delta; a decline, a missing disposition, or no change ends human-held.
- The full `npm run verify` contract then runs again, followed by ONE narrow
  read-only confirmation that receives the complete cumulative repair delta and
  the exact correction delta but never the correction's narrative. There is no
  second correction batch.
- A semantic dead end — `human`, a failed correction, a red second verify, a
  refused or malformed confirmation — REMOVES that fixer's queue label and
  verifies the human-held resting state, so dispatch cannot launch another
  complete fixer. No spent retry label is manufactured to achieve that. Only
  operational failures (provider quota, a dead process, transport) keep the
  existing refund, ladder and durable-recovery behavior.

### Judgment-conflict fixer

**Entry:** `failed` + `needs-judgment`. **Script:**
[`workflows/fix-run.mjs`](workflows/fix-run.mjs). **LLM calls:** normally two
(`fix-conflicts`, then `final-review` as the acceptance check), up to three when
verification needs a repair retry, up to four when a correction runs, and five
when both paths are needed.

1. Dispatch moves the resting issue to `in-progress` before launching and the
   fixer verifies the exact engine pin, queue evidence, unique PR, and available
   attempt rung.
2. It fetches the branch, rebases onto captured current main, and runs
   `merge-autoresolve.sh --partial` to settle every mechanical hunk first.
3. The repair agent receives only the remaining judgment hunks, plus the
   captured brief: both sides' diffs of exactly the marked files, the commit
   subjects behind main's side, and the issue bodies stating what each side set
   out to do (up to five of main's, since that list is parsed out of arbitrary
   commit messages; the subjects always carry the rest). It edits nothing but
   the conflict text it was given, and must account for each hunk by either
   preserving both sides' intent or declining it without guessing. It never
   stages, continues the rebase, or judges the branch. The acceptance check and
   any scoped correction receive that same captured brief.
4. The orchestrator validates every indexed disposition, then finishes the stop
   itself: no marker survives, exactly the judgment files are staged, one
   `git rebase --continue` runs, and the completed branch's shape and edit
   boundary are checked. A stop that survives that continuation blocks — it is
   never a completed repair.
5. It runs `npm run verify`; a red result and its captured diagnostics go back
   to one fresh resolver before the full gate runs again. Only a green tree
   reaches the acceptance check, which tries to refute every repaired hunk and
   prove every declined hunk retained the exact PR-side text, returning the
   complete blocker batch rather than the first refutation.
6. A `correction-required` batch gets one scoped correction that must keep both
   sides' authenticated intent; its edits go into the same amended commit, and
   the verify contract and narrow confirmation run again before any push.
7. A complete surviving repair is force-pushed and returns to
   `ready-to-merge`; the merge worker rebases and checks it again.
8. A verified partial repair is preserved, but authenticated head-bound evidence
   names the declined hunks and the issue rests at `ready-to-review` with the
   fixer queue removed.

### CI fixer

**Entry:** `failed` + `needs-ci-fix`. **Script:**
[`workflows/ci-run.mjs`](workflows/ci-run.mjs). **LLM calls:** normally two
(`fix-ci`, then `final-review` as the acceptance check), up to three when
verification needs a repair retry, up to four when a correction runs, and five
when both paths are needed.

1. It verifies routing, queue state, unique PR/head, and its independent CI
   attempt ladder.
2. It reads the failing check names, captures bounded logs for up to three
   failed jobs, captures the change under repair and the issue body it was built
   against, installs dependencies, and runs local verify to establish whether
   the failure reproduces. The fixer, the acceptance check and any correction
   all receive that captured brief inline.
3. The fixer accounts for every failed check as repaired or declined and may
   change only the smallest code necessary to fix the cause. It may not weaken
   a test, type, lint rule, assertion, or check.
4. The orchestrator validates the indexed dispositions and runs the full
   `npm run verify` contract. A red result and its captured diagnostics go back
   to one fresh fixer before the full gate runs again; a second red blocks.
5. The acceptance check inspects the orchestrator-captured repair delta and
   refutes by default if a cause remains, a gate was weakened, a decline
   changed, or unrelated behavior moved.
6. A `correction-required` batch gets one scoped correction bounded to the
   captured failing checks, which may not weaken a gate to clear a blocker, and
   the verify contract and narrow confirmation run again before any push.
7. A complete surviving repair amends and force-pushes the PR, then restores
   `ready-to-merge` for a fresh merge-worker rebase and CI run.
8. A verified partial repair is pushed but rests at `ready-to-review` with
   `needs-ci-fix` removed for human judgment.

### Defect fixer

**Entry:** `ready-to-review` + `needs-defect-fix`, and only in repos opted into
automatic defect repair. Manual launch remains possible. **Script:**
[`workflows/defect-run.mjs`](workflows/defect-run.mjs). **LLM calls:** normally
two (`fixes-after-review`, then `final-review` as the acceptance check), up to
three when verification needs a repair retry, up to four when a correction
runs, and five when both paths are needed.

Epic-run no longer publishes new defect evidence or writes `needs-defect-fix`:
that hold now gets its one scoped correction inside the epic. This fixer remains
so durable evidence older runs already published is still serviceable, and so a
manual launch stays available.

1. It verifies the exact route, queue state, unique same-repository PR, attempt
   rung, and authenticated evidence authored by the automation identity.
2. It requires the evidence to match this issue, PR, branch, and current head;
   it uses the envelope's pinned original requirement rather than mutable issue
   prose.
3. The fixer may repair only the numbered, gate-confirmed defects and must
   account for each as repaired or declined without reclassification. The
   pinned requirement is rendered once, above the rest of the envelope rather
   than pasted both inside and outside it. Beside it the fixer receives the
   orchestrator-captured diff of the reviewed change on the captured head, and
   so does the acceptance check; the PR change is never a Git command either is
   told to run.
4. The orchestrator validates exact coverage and runs `npm run verify`. A red
   result and its captured diagnostics go back to one fresh fixer before the
   full gate runs again; a second red blocks. It intent-adds new files only
   after verification is green so the complete delta reaches the checker.
5. The acceptance check tries to refute each repair, prove declines were
   untouched, detect weakened gates, and reject unrelated behavior, returning
   the complete blocker batch rather than the first refutation.
6. A `correction-required` batch gets one scoped correction bound to the same
   authenticated evidence, which may not reclassify a named defect or weaken a
   gate, and the verify contract and narrow confirmation run again before any
   push.
7. A surviving repair is amended and force-pushed with a lease. The script
   immediately posts its audit comment, including a landing record for a
   complete repair, then confirms the PR advanced to that head over a bounded
   readback window. Publishing the record first preserves recovery evidence
   even if head confirmation fails.
8. A complete repair returns to `ready-to-merge`. A partial repair stays
   `ready-to-review`, removes the defect queue, and publishes fresh evidence on
   the amended head containing only declined defects.
9. If a verified complete repair was pushed but landing confirmation failed, a
   trusted audit record allows the next attempt to redo only the label landing;
   it does not edit already-repaired defects a second time.

## Run telemetry and usage report

`workflows/lib/usage.mjs` appends best-effort host telemetry to
`EPIC_USAGE_LOG` (normally `~/epic-usage.jsonl`). A failed append never changes
a pipeline result or exit code. Every model process writes a typed `spawn`
record. Every epic, task, conflict-fixer, CI-fixer, and defect-fixer invocation also
writes a `run-start` after engine validation and before Prepare, then a
`run-finish` after final status reporting and its `RESULT` line. A killed or
crashed process can therefore remain as a visible start with no finish. All
stored timestamps are canonical UTC ISO 8601.

The finish records the pipeline's confirmed result: queued for merge, queued
for another automated repair, held for provider quota, held for human review,
blocked for a human, skipped/refused, error, or unknown. That result describes
where the invocation left the issue; it does not query or imply whether GitHub
later merged the PR or closed the issue.

`./toliki usage [days] [engine]` renders two views from the host's
log:

- The per-step tuning view preserves record-level `--since`, `--engine`, and
  `--script` filtering. Its duration is **model-active time**, the sum of model
  spawn durations; parallel spawns can make it exceed wall time.
- The issue-lifetime view joins every retained invocation for one
  `(repository, issue)` pair. It reports cumulative completed-run **wall time**
  separately from the **elapsed lifetime span** between first start and latest
  finish, along with launches, fixer attempts, relaunches, in-run retries,
  runtime respawns, tokens, cost provenance, latest result, and human handoff.
  Its `--since` selects by latest lifecycle activity and then totals the whole
  retained lifetime. Engine and script filters select by the latest completed
  run without truncating that lifetime.

The handoff rate counts each issue once and only when its latest completed
result conclusively queued merge or handed the issue to a human. Repair queues,
quota holds, skips, errors, and incomplete/unknown histories are listed outside
the denominator. Legacy untyped spawn rows remain in the tuning totals but
cannot acquire repository identity, wall time, or a result. The report labels
all history log-known, keeps unattributed runs separate, shows missing usage or
price data, and reports malformed interior JSONL records; only a torn final
line is ignored as a possible concurrent append.

## Shared failure behavior

1. Every structured model call is schema checked. Runtime may respawn once for
   a transient process failure and once for an off-schema result; timeouts and
   hard provider-quota failures are not transiently retried. Task-run disables
   both respawns for each call; its only second call is the explicit bounded
   repair after a normal red first project verify.
2. On a hard provider quota failure, an epic or task checkpoints and pushes
   resumable work before restoring `ready`; task retains its selector. A fixer
   cleans unpushed edits and refunds its current rung. All record a
   vendor-specific host hold and accept it only after the required label state
   is verified.
3. Queries fail closed: an unreadable dependency, route, PR head, review result,
   CI conclusion, or write readback is never interpreted as success.
4. A model phase that judges a change is read-only. The orchestrator hashes the
   tree and protected Git state around Review, Final review, and the narrow
   confirmation and blocks if either moved. Ship spawns no model at all, so the
   last process a run starts is one of those judging phases.
5. Pipeline sessions are not interactive agent sessions. They contain a plain
   Node orchestrator which spawns disposable headless model processes; they
   cannot be steered and may only be inspected or killed.
