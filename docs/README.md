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
  -> Correction + verify + narrow confirmation, when every blocker is concrete
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
| 4. Review | `reviewer` charter | One broad review, and the only broad review of the change |
| 5. Repair | `coder` charter | One when findings exist |
| 6. Final review | `reviewer` charter | One when findings need adjudication; it is this repair's exhaustive acceptance check |
| 7. Correction | `coder` + `reviewer` charters | One correction and one narrow confirmation, only when every blocker is a concrete defect |
| 8. Ship | `shipper` charter plus orchestrator | One prose/metadata call |
| 9. Merge gate | Node orchestrator | None |
| 10. Merge worker | Shell scripts | None |

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
5. A resumed partial implementation is planned as `direct`; the script refuses
   to pretend a dirty tree still has a clean RED baseline.
6. A resumed code checkpoint first reuses `.epics/<slug>/architecture.json`.
   If that artifact is missing or invalid, a read-only architect reconstructs
   the plan from the finished implementation without changing it.
7. The orchestrator validates the complete structure and non-empty verification
   evidence. Invalid architecture blocks before Code.
8. Deterministic rendering writes `architecture.json` and `architecture.md`;
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
[`workflows/epic-run.mjs`](../workflows/epic-run.mjs). **LLM calls:** exactly
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

## 9. Merge gate

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
run one exhaustive acceptance check, then publish.

All three share the **bounded repair contract** in
[`workflows/lib/repair-acceptance.mjs`](../workflows/lib/repair-acceptance.mjs),
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
[`workflows/fix-run.mjs`](../workflows/fix-run.mjs). **LLM calls:** normally two
(`fix-conflicts`, then `final-review` as the acceptance check), and up to four
when a correction runs.

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
5. It runs `npm run verify`, then the acceptance check tries to refute every
   repaired hunk and prove every declined hunk retained the exact PR-side text,
   returning the complete blocker batch rather than the first refutation.
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
[`workflows/ci-run.mjs`](../workflows/ci-run.mjs). **LLM calls:** normally two
(`fix-ci`, then `final-review` as the acceptance check), and up to four when a
correction runs.

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
[`workflows/defect-run.mjs`](../workflows/defect-run.mjs). **LLM calls:** normally
two (`fixes-after-review`, then `final-review` as the acceptance check), and up
to four when a correction runs.

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
   account for each as repaired or declined without reclassification.
4. The orchestrator validates exact coverage, runs `npm run verify`, and
   intent-adds new files so the complete delta reaches the checker.
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
