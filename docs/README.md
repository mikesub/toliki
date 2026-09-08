# Toliki workflow

This document describes the current issue-to-merge workflow implemented by the
scripts. It is an operational map, not a second configuration source. The code
and its comments remain authoritative when the two disagree.

## At a glance

```text
ready issue
  -> Prepare
  -> Architect
  -> Code + verify
  -> Review
  -> Repair + verify, when findings exist
  -> Final review, when adjudication is needed
  -> Ship PR
  -> Merge gate
  -> Merge worker
  -> main
```

The call counts below are the primary path. Explicit gate retries and runtime
recovery may add fresh processes as described in each section and in Shared
failure behavior.

| Step | Owner | Primary LLM calls |
| --- | --- | --- |
| 1. Prepare | Shell/Node orchestrators | None |
| 2. Architect | `architect` charter | Usually one; none when a valid resumed plan exists |
| 3. Code | `coder` charter | One in direct mode, RED + GREEN in test-first mode; a completed checkpoint initially skips both |
| 4. Review | `reviewer` charter | One general review, optionally one focused review |
| 5. Repair | `coder` charter | One when findings exist |
| 6. Final review | `reviewer` charter | One when findings need adjudication |
| 7. Ship | `shipper` charter plus orchestrator | One prose/metadata call |
| 8. Merge gate | Node orchestrator | None |
| 9. Merge worker | Shell scripts | None |

Every LLM call is a new, short-lived process. The selected `engine:<name>` maps
each step to a vendor, model, and effort in [`etc/engines.json`](../etc/engines.json).
The eight engine step keys and their charters are fixed in
[`workflows/lib/engine.mjs`](../workflows/lib/engine.mjs):

| Engine step | Charter | May edit the worktree? |
| --- | --- | --- |
| `architect` | `architect` | No |
| `code` | `coder` | Yes |
| `review` | `reviewer` | No |
| `fixes-after-review` | `coder` | Yes |
| `final-review` | `reviewer` | No |
| `ship` | `shipper` | No |
| `fix-conflicts` | `coder` | Yes |
| `fix-ci` | `coder` | Yes |

Git, GitHub, labels, dependency installation, verification, checkpointing,
pushes, PR creation, and merging are always performed by deterministic code.
An agent's report that one of those operations succeeded is never the gate.

## 1. Prepare

**Owner:** [`bin/dispatch.sh`](../bin/dispatch.sh),
[`bin/launch.sh`](../bin/launch.sh), and the `prepare()` phase in
[`workflows/epic-run.mjs`](../workflows/epic-run.mjs). **LLM calls:** none.

1. Cron runs `dispatch.sh`, which checks repair queues first and then walks
   each repo's `ready` issues oldest-first.
2. Dispatch resolves the issue's engine, skips engines under a provider-quota
   hold, skips open `blocked_by` dependencies, and ignores an issue that
   already has an exact `<repo>-epic-<N>` session.
3. `launch.sh` enforces the host-wide slot cap inside the session-creation lock,
   updates the registered clone, creates or reuses the issue worktree, and
   starts `<repo>-epic-<N>` in tmux.
4. The pane runs `node workflows/epic-run.mjs --issue <N> --session <name>
   --engine <name>`; its scrollback becomes the complete phase log.
5. The orchestrator starts one best-effort live status comment on the issue.
   Phase changes edit that comment in place; reporting failure never decides a
   pipeline gate.
6. `epic-run.mjs` reads the issue number, title, body, and state. A closed issue
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
11. On a resumed branch, it inspects checkpoint subjects to distinguish a
    completed code phase from preserved partial work. Completed code is not
    rebuilt later; partial work receives a direct continuation plan.
12. It verifies the exact durable `engine:<name>` label. Only a newly won claim
    may create a missing route; a resume requires the existing singleton and
    never rewrites a conflicting route.
13. It ensures lifecycle labels exist, changes `ready` to `in-progress`, and
    self-assigns the issue. These two reporting writes are best effort after
    the branch claim is secure.
14. It makes `.epics/` worktree-locally ignored, writes the issue body to
    `.epics/<slug>/requirements.md`, and creates or resumes `epic.md` as the
    phase log.
15. It discovers the repo root and one-level child packages whose
    `package.json` declares `scripts.verify`.
16. For each discovered package, it runs `npm ci` only when a lockfile exists
    and `node_modules` is missing or that lockfile changed across the base
    transition.
17. Prepare returns the requirement, branch, package list, dependency evidence,
    and resume state to Architect. Finding no verifiable package blocks before
    any model runs.

Manual `--slug` mode does not run Prepare. It uses the current working tree and
requires an existing `.epics/<slug>/requirements.md`.

An operator may launch issue mode through `remote-control.sh epic <N>` instead
of waiting for dispatch. It still goes through `launch.sh` and the same
`epic-run.mjs` Prepare phase. An omitted engine is resolved read-only from the
issue pin or host default; an explicitly selected engine is persisted before
launch. Only this manual pipeline path can request `--over-capacity`.

## 2. Architect

**Owner:** `architect` charter, invoked by
[`workflows/epic-run.mjs`](../workflows/epic-run.mjs). **LLM calls:** zero or
one logical call.

1. The orchestrator loads the prepared requirement and discovered package
   layout.
2. For a new run, it starts one read-only `architect` process. The architect
   explores the real codebase and commits to one proportional implementation
   approach rather than presenting alternatives.
3. The architect returns schema-checked fields: approach, rationale, ordered
   build steps, files, public contract, accepted trade-offs, and verification
   evidence.
4. It chooses one verification mode:
   - `test-first` when a meaningful failing regression materially improves
     confidence.
   - `direct` for a small or low-risk change where a manufactured RED phase
     adds no useful evidence.
5. It may request one concrete focused-review question for a narrow, material
   risk. Otherwise the later review plan contains only the mandatory general
   review.
6. A resumed partial implementation is planned as `direct`; the script refuses
   to pretend a dirty tree still has a clean RED baseline.
7. A resumed code checkpoint first reuses `.epics/<slug>/architecture.json`.
   If that artifact is missing or invalid, a read-only architect reconstructs
   the plan from the finished implementation without changing it.
8. The orchestrator validates the complete structure and non-empty verification
   evidence. Invalid architecture blocks before Code.
9. Deterministic rendering writes `architecture.json` and `architecture.md`;
   the latter is the contract the coder and any RED test writer receive.

## 3. Code

**Owner:** `coder` charter plus the verification/checkpoint code in
[`workflows/epic-run.mjs`](../workflows/epic-run.mjs) and
[`workflows/lib/repo.mjs`](../workflows/lib/repo.mjs). **LLM calls:** zero to
two logical calls, depending on resume state and verification mode.

1. A resumed code checkpoint skips the coding agent and immediately re-runs
   the real verify gate against its newly rebased base.
2. A fresh `test-first` plan begins with orchestrator-run `npm run verify` in
   every discovered package. A red baseline blocks; it cannot be mistaken for
   the requested regression.
3. The RED `coder` process writes tests only and reports the exact expected
   assertion excerpt and why it proves missing required behavior.
4. The orchestrator runs verify and accepts RED only when a runnable test
   failure contains that exact assertion evidence. A green result, timeout,
   spawn error, unrelated failure, or different assertion is rejected.
5. One explicit RED retry is allowed. A second failure to establish meaningful
   RED blocks before implementation.
6. The GREEN `coder` process implements the architecture against the failing
   tests. In `direct` mode, one `coder` process instead implements the change
   and adds or updates useful tests in the same pass.
7. The coder may use `npm run verify` as its feedback loop, but it does not own
   the verdict and may not commit or push.
8. The orchestrator runs `npm run verify` in every discovered package. The exit
   codes and bounded output are the authoritative evidence.
9. If verification is red, the implementation process is respawned once with
   the actual failure output. A second red result blocks before Review.
10. The orchestrator checkpoints all nonignored implementation work as
    `wip(epic <slug>): code checkpoint`. Manual mode uses intent-to-add instead
    of committing.

## 4. Review

**Owner:** `reviewer` charter plus the review coordinator in
[`workflows/epic-run.mjs`](../workflows/epic-run.mjs). **LLM calls:** one or two
logical calls.

1. The review plan always contains `review:general`. It adds `review:focus`
   only when Architect supplied a concrete focused-risk question.
2. The orchestrator snapshots the shippable tree, Git/index/config metadata,
   and the complete change diff before any reviewer starts.
3. The general and optional focused reviewers run independently and in
   parallel, subject to the runtime's concurrency cap.
4. Reviewers receive the original requirement and captured diff. They are
   deliberately denied `.epics/` builder notes and do not see coder claims.
5. The general reviewer checks requirement coverage, meaningful defects or
   regressions, and whether verification proves the changed behavior. The
   focused reviewer investigates only its named risk unless another issue is
   necessary evidence.
6. Each finding must include title, severity, confidence, location, concrete
   problem, proposed fix, and useful regression evidence. The reviewer charter
   instructs the agent to return only `Critical` or `Important` findings at
   confidence 75 or above.
7. A dead reviewer is different from a reviewer returning no findings. If any
   requested reviewer produces no valid result after bounded runtime recovery,
   the run blocks.
8. The orchestrator proves the read-only review processes did not change the
   tree or protected Git metadata. Any drift blocks.
9. Exact duplicate findings with the same normalized title and location are
   collapsed; related findings remain independently indexed.
10. The orchestrator writes the numbered finding ledger to
    `.epics/<slug>/review.md`. No findings skips both Repair and Final review.

## 5. Repair

**Owner:** a fresh `coder` process using the `fixes-after-review` step, plus the
orchestrator. **LLM calls:** none when Review found nothing; otherwise one
logical call, with one verification-driven retry available.

1. Every review finding is immediately actionable; there is no separate model
   confirmation pass before repair.
2. One fresh fixer receives the requirement, complete reviewed diff, source
   tree, and numbered findings.
3. For every index it must return exactly one disposition:
   - `fixed`: change the code and add meaningful regression coverage.
   - `disputed`: leave the code alone and cite concrete evidence that the
     finding is false.
   - `deferred`: explain why it cannot safely be repaired in this bounded
     round.
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
   classification is the authority for the later defect-fixer queue.
8. The orchestrator proves Final review changed neither the tree nor protected
   Git metadata. Drift blocks because no later review would see those bytes.
9. A malformed or missing final result clears nothing. Except for a provider
   quota failure, the pipeline records every item as unresolved and continues
   toward a human-held PR rather than inventing a verdict.
10. Regressions become new open findings; unmet requirements become explicit
    non-defect blockers. There is no second repair or third opinion.

## 7. Ship

**Owner:** `shipper` charter for judgmental prose; `epic-run.mjs` and transport
libraries for every mutation. **LLM calls:** one logical call.

1. The orchestrator stages any loose work into a pre-ship checkpoint and
   fetches current `origin/main`.
2. If main advanced, it tries to rebase the entire claim/code/triage checkpoint
   chain before squashing:
   - A clean rebase refreshes dependencies and re-runs `npm run verify`; red
     blocks with the resumable chain preserved.
   - A failed fetch or conflicting rebase falls back to the run's original
     base. The merge worker will rebase and re-check it later.
3. It captures the final diff, the shippable-state snapshot, and opaque IDs for
   every known structured blocker.
4. One read-only `shipper` process returns schema-checked delivery metadata:
   PR/commit title, source-issue delivery narrative, non-empty commit rationale,
   any project-defined legal marker, and the deferred-work ledger.
5. Ship classifies deferrals as `defect`, `missing-gate`, `scope-cut`, or
   `other`, and may request a coherent follow-up issue. These classifications
   record work but do not decide whether this PR may merge.
6. The orchestrator validates all known blocker IDs and rejects unknown,
   duplicate, or missing identities before creating external artifacts.
7. It proves the shipper changed neither the tree nor protected Git metadata.
8. It folds the checkpoint chain into one commit at the actual merge base. The
   commit contains the shipper's subject/rationale, optional legal marker, and
   deterministic `Closes #N` line.
9. It force-pushes the already-claimed branch with a lease and opens a PR whose
   body contains only deterministic links back to the source issue/run record.
10. After the PR exists, it posts one candidate-SHA-specific delivery summary
    to the source issue and reads it back. Missing or duplicate confirmation
    blocks with the real PR, branch, and SHA recorded for manual recovery.
11. Only after that summary is confirmed does it record deferrals and file up
    to three qualified follow-up issues, defects first. When dependency
    ordering can be written, each follow-up is made `blocked_by` the source
    issue before receiving `ready`. If ordering cannot be established, the
    follow-up is left unqueued.
12. It places the source issue conservatively at `ready-to-review`. The Merge
    gate may promote it, but Ship itself never decides unattended eligibility.

Manual `--slug` mode stops here after a `shipper` call writes
`.epics/<slug>/summary.md`; it does not commit, push, create a PR, or change
GitHub labels.

## 8. Merge gate

**Owner:** structured calculations and GitHub transport in
[`workflows/epic-run.mjs`](../workflows/epic-run.mjs). **LLM calls:** none.

1. The gate reads only structured review outcomes produced before Ship:
   unresolved original findings, repair regressions, unmet requirements,
   missing adjudication, and false no-diff repair claims.
2. Shipper-authored deferrals never enter this calculation; they cannot hold or
   release their own PR.
3. If no blockers remain, the script changes `ready-to-review` to
   `ready-to-merge` and reads the labels back.
4. If promotion cannot be confirmed, it issues a compensating transition back
   to `ready-to-review` and proves that demotion with bounded readback.
5. If neither promotion nor demotion can be proved, it moves to the ordinary
   blocker path rather than leave an unaccounted `ready-to-merge` label.
6. If any blocker remains, the PR stays `ready-to-review` for a human.
7. If every blocker is a concrete defect positively established by Final
   review, the script first publishes authenticated evidence bound to the
   issue, same-repository PR, captured head, and original requirement. Only a
   confirmed envelope allows adding `needs-defect-fix` beside
   `ready-to-review`.
8. Mixed blockers, uncertainty, unmet requirements, or incomplete evidence
   never enter the defect queue.
9. A normally completed or blocked run finishes at exactly one terminal state:
   `ready-to-merge`, `ready-to-review`, or `failed`. A verified provider-quota
   hold instead restores `ready` for a resumable run. Every path emits a final
   `RESULT <json>` line.

The first terminal label write opens one bounded reporting window shared by all
remaining GitHub calls. No new model may start after that window opens.

## 9. Merge worker

**Owner:** [`bin/merge-tick.sh`](../bin/merge-tick.sh),
[`bin/merge-worker.sh`](../bin/merge-worker.sh), and
[`bin/merge-autoresolve.sh`](../bin/merge-autoresolve.sh). **LLM calls:** none.

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
[`workflows/lib/fixer-lifecycle.mjs`](../workflows/lib/fixer-lifecycle.mjs):
Prepare evidence, run one writable repair agent, run orchestrator verification,
run one blind adversarial checker, then publish.

### Judgment-conflict fixer

**Entry:** `failed` + `needs-judgment`. **Script:**
[`workflows/fix-run.mjs`](../workflows/fix-run.mjs). **LLM calls:** normally two:
`fix-conflicts`, then `final-review` as the skeptic.

1. Dispatch moves the resting issue to `in-progress` before launching and the
   fixer verifies the exact engine pin, queue evidence, unique PR, and available
   attempt rung.
2. It fetches the branch, rebases onto captured current main, and runs
   `merge-autoresolve.sh --partial` to settle every mechanical hunk first.
3. The repair agent receives only the remaining judgment hunks and must account
   for each by either preserving both sides' intent or declining it without
   guessing.
4. The orchestrator validates every indexed disposition, completed rebase
   shape, marker cleanup, and allowed edit boundary.
5. It runs `npm run verify`, then a blind adversarial reviewer tries to refute
   every repaired hunk and prove every declined hunk retained the exact PR-side
   text.
6. A complete surviving repair is force-pushed and returns to
   `ready-to-merge`; the merge worker rebases and checks it again.
7. A verified partial repair is preserved, but authenticated head-bound evidence
   names the declined hunks and the issue rests at `ready-to-review` with the
   fixer queue removed.

### CI fixer

**Entry:** `failed` + `needs-ci-fix`. **Script:**
[`workflows/ci-run.mjs`](../workflows/ci-run.mjs). **LLM calls:** normally two:
`fix-ci`, then `final-review` as the skeptic.

1. It verifies routing, queue state, unique PR/head, and its independent CI
   attempt ladder.
2. It reads the failing check names, captures bounded logs for up to three
   failed jobs, installs dependencies, and runs local verify to establish
   whether the failure reproduces.
3. The fixer accounts for every failed check as repaired or declined and may
   change only the smallest code necessary to fix the cause. It may not weaken
   a test, type, lint rule, assertion, or check.
4. The orchestrator validates the indexed dispositions and runs the full
   `npm run verify` contract.
5. A blind adversarial checker inspects the exact fixer delta and refutes by
   default if the cause remains, a gate was weakened, a decline changed, or
   unrelated behavior moved.
6. A complete surviving repair amends and force-pushes the PR, then restores
   `ready-to-merge` for a fresh merge-worker rebase and CI run.
7. A verified partial repair is pushed but rests at `ready-to-review` with
   `needs-ci-fix` removed for human judgment.

### Defect fixer

**Entry:** `ready-to-review` + `needs-defect-fix`, and only in repos opted into
automatic defect repair. Manual launch remains possible. **Script:**
[`workflows/defect-run.mjs`](../workflows/defect-run.mjs). **LLM calls:** normally
two: `fixes-after-review`, then `final-review` as the skeptic.

1. It verifies the exact route, queue state, unique same-repository PR, attempt
   rung, and authenticated evidence authored by the automation identity.
2. It requires the evidence to match this issue, PR, branch, and current head;
   it uses the envelope's pinned original requirement rather than mutable issue
   prose.
3. The fixer may repair only the numbered, gate-confirmed defects and must
   account for each as repaired or declined without reclassification.
4. The orchestrator validates exact coverage, runs `npm run verify`, and
   intent-adds new files so the complete delta reaches the checker.
5. A blind adversarial checker tries to refute each repair, prove declines were
   untouched, detect weakened gates, and reject unrelated behavior.
6. A surviving repair is amended and force-pushed with a lease. The script
   confirms the PR advanced to that head over a bounded readback window and
   immediately publishes a landing audit record.
7. A complete repair returns to `ready-to-merge`. A partial repair stays
   `ready-to-review`, removes the defect queue, and publishes fresh evidence on
   the amended head containing only declined defects.
8. If a verified repair was pushed but landing confirmation failed, a trusted
   audit record allows the next attempt to redo only the label landing; it does
   not edit already-repaired defects a second time.

## Shared failure behavior

1. Every structured model call is schema checked. Runtime may respawn once for
   a transient process failure and once for an off-schema result; timeouts and
   hard provider-quota failures are not transiently retried.
2. On a hard provider quota failure, an epic checkpoints and pushes resumable
   work before restoring `ready`. A fixer cleans unpushed edits and refunds its
   current rung. Both record a vendor-specific host hold and accept the hold
   only after the required label state is verified.
3. Queries fail closed: an unreadable dependency, route, PR head, review result,
   CI conclusion, or write readback is never interpreted as success.
4. A model phase that judges a change is read-only. The orchestrator hashes the
   tree and protected Git state around Review, Final review, and Ship and blocks
   if either moved.
5. Pipeline sessions are not interactive agent sessions. They contain a plain
   Node orchestrator which spawns disposable headless model processes; they
   cannot be steered and may only be inspected or killed.
