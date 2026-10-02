![piglets.png](piglets.png)

# toliki

Five agent skills for a human-led coding workflow on your own machine. You
drive each feature ("epic") through phases yourself — spec, optional
architecture, code, independent review, ship — and the agent does the Git work
with plain `git` commands the skills spell out. Works in any agent harness that
loads `SKILL.md` skills; setup wires Claude Code and Codex.

```text
t-spec -> [t-architect] -> t-code -> t-review -> t-ship
                             ^           |
                             +- repairs -+
```

No skill starts the next one. You read each handover, discuss it, and choose
what happens next. See the [skills overview](skills/epic/README.md) and the
[shared contract](skills/epic/EPIC-CONTRACT.md) for the exact rules.

## How an epic runs

- **t-spec** agrees requirements with you and creates branch `epic/<title>`
  in a worktree at `worktrees/<repo>/<title>`, in a shared folder beside the
  main checkout (`~/code/app` -> `~/code/worktrees/app/<title>`).
- **t-architect** (optional) proposes a design for discussion.
- **t-code** implements in that worktree, stages the change, runs the
  project's full verification command, and records the result with a
  fingerprint of the exact change it tested.
- **t-review** runs in a fresh session, reads only the spec and the code
  (never the coder's notes), runs the relevant tests itself, and records the
  fingerprint of the change it reviewed.
- **t-ship** makes one commit, re-verifies it, and fast-forwards local `main`
  (`--ff-only`) only when the review's fingerprint still matches the change,
  or you explicitly accept unreviewed code. It then archives the handovers and
  removes the worktree and branch with Git's own safety checks (no `--force`,
  `branch -d` only).

The change fingerprint hashes `git diff --binary` against the merge base with
main (the [contract](skills/epic/EPIC-CONTRACT.md) gives the exact command):
it survives committing, and a rebase when main changed none of the epic's
files, but changes with any edit, so ship can tell whether the reviewed code is
the code it is about to land.

Handovers live in the worktree's `.epics/<title>/` (excluded from Git) and are
archived under the main checkout's `.epics/<title>/releases/<commit>/`. Other
ignored files in the worktree are copied to `.epics/<title>/preserved/<commit>/`
unless you confirm a project command recreates them.
Everything stays local: nothing is pushed, and no issue or PR is created.

## What it expects

- Git. The skills run no scripts of their own.
- Target repositories with a local `main` branch checked out in the main
  checkout.
- A documented full verification command per project, ideally
  `package.json`'s `scripts.verify`; otherwise t-spec agrees one with you and
  records it in the spec.

## Setup

```bash
gh repo clone mikesub/toliki
cd toliki
./setup.sh
```

[setup.sh](setup.sh) installs each skill as a self-contained copy of this
checkout's **committed** `HEAD` into `~/.claude/skills` and `~/.agents/skills`.
Uncommitted edits are never installed, so you can develop the skills here and
release them when ready: commit, re-run `./setup.sh`, and start a fresh agent
session. Each copy carries a `.toliki-install` marker naming its commit; setup
overwrites only marked copies, removes marked copies of skills that no longer
exist, and refuses to touch anything else. Never copy the skills into target
repositories.

## Developing

[AGENTS.md](AGENTS.md) has the maintenance rules; `CLAUDE.md` only points to
it. `./test.sh` runs every suite; they are hermetic and use temporary
repositories and homes.

## Caveats

This is a personal setup shared as-is. Git worktrees are not a security
boundary, and the agents run whatever your harness permits. If a fix benefits
more than your local setup, a PR is welcome.
