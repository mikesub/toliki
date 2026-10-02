# Toliki project instructions

These rules apply to work on **Toliki itself**, not to every project it builds.
Codex discovers this file natively; `CLAUDE.md` links here. Use relative
Markdown links, never `@file` includes.

Toliki is five local agent skills (`skills/epic/t-*`) for a human-led epic
workflow, sharing one contract. The human chooses every phase; the agent does
the Git work with the plain `git` commands the contract spells out. There is no
orchestrator, helper script, daemon, host, database or npm dependency.

## Read what the change touches

- [README.md](README.md): what the workflow is and how setup works.
- [Skills overview](skills/epic/README.md) and
  [shared contract](skills/epic/EPIC-CONTRACT.md): workspace identity,
  handover ownership, git commands, the change fingerprint, shipping and
  cleanup rules. The contract is the authority for skill behavior; each
  `SKILL.md` adds only its phase's role.
- [setup.sh](setup.sh): how committed skills are released into user skill
  directories.

When prose, tests and executable behavior disagree, investigate the intended
contract and fix the stale side in the same change. Do not turn stale prose
into an extra gate or change behavior merely to match it.

## Change rules

1. Inspect the worktree and preserve unrelated edits. Make the smallest
   coherent change; keep existing exit-code contracts.
2. Skills stay harness-neutral: no skill or the contract names a specific
   agent CLI (a test enforces this). In this repo each skill directory links
   the shared `EPIC-CONTRACT.md`; keep that link rather than a copy here
   (setup resolves it when it installs), and never copy skills into target
   projects.
3. Keep the skills' safety in Git's own refusals and in recorded facts: the
   full verification command's real exit status, the change fingerprint, and
   explicit human decisions in the handovers. An agent's claim is never a
   passed check. Prefer a precise git command in the contract over new
   tooling.
4. Preserve fail-closed checks, review independence and positive proof before
   deleting work (`--ff-only`, `branch -d`, never `--force`). Never weaken
   release or cleanup checks to get a flow through.
5. Add hermetic regression coverage for behavior changes; a new gate or
   refusal needs both pass and stop cases. Never weaken or delete tests to get
   green. Tests use `mktemp` repositories and homes and fake executables first
   on `PATH`, never the user's real skill directories, repositories or agent
   CLIs. Use Bash 3.2-compatible scripts and no npm dependencies.
6. Run `./test.sh` (it runs every suite; `TEST_JOBS=1` runs them serially).
   Name one suite to run it alone: `./test.sh tests/setup.test.sh`.

When explicitly asked to commit or push, use `main` directly. No feature
branches or PRs unless requested; readiness alone never authorizes publication.

## Review focus

Prioritize false success on failure paths (stale-green verification, a review
that still looks current after the change moved), unsafe cleanup of worktrees,
branches or ignored user data, lost work during ship's commit/rebase, git
commands in the contract that do not do what the prose claims, setup that
overwrites content it does not own, and tests that reach live
systems.
