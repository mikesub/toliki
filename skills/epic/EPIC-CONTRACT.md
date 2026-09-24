# Shared local epic contract

Read this file from the skill's own Toliki directory. All five skills use this
contract and `scripts/workspace.mjs`; do not copy either into target projects.
The helper imports Toliki's existing process primitives to bound verification
and clean up process groups. Keep the script at its Toliki path and run commands
with the target repository as the working directory.

## Human-owned transitions

Perform the invoked skill only. Discuss its result and stop; never invoke the
next skill automatically. Use decisions already agreed in the conversation.
Resolve missing requirements with the human, and record decisions in the owning
document before handing over. Do not invent requirements or expand into rare
edge cases without the user's agreement. Project instructions still apply.

Each skill acts directly in its Codex session. Subagents are optional when the
user authorizes parallel work; they do not replace the human's phase decisions.
Independent reviewers need a fresh context without the builder conversation.

## Workspace identity

`<title>` is a short lowercase hyphenated directory name, such as
`saved-searches`. It identifies branch `epic/<title>` and worktree
`$HOME/.epics/<repo>/<title>`, where `<repo>` is the main checkout's basename.
Use explicit working directories for all tools. Never modify the main checkout's
product code while working on an epic.

The helper discovers the checkout holding local `main`. `start` branches from
that main, establishes `/.epics/` in Git's local exclude file, and creates an
ownership record in the new workspace. It preserves existing work and refuses
branch/path collisions, tracked `.epics/` files, and foreign worktrees. It does
not install dependencies or copy ignored settings. A newly created workspace
does not imply that requirements are settled.

Run `status` to locate an existing workspace; infer the title from the current
`epic/<title>` branch, or take it from the user's title/spec path. A title passed
from main is required when it cannot be inferred. Check the existing artifacts
and actual changes to resume; a commit or architecture file proves no phase
complete. Finish an interrupted rebase explicitly before other work.

Once created, the worktree's `.epics/<title>/` is the authoritative handover
directory. If the user supplies an existing spec, copy it there once, preserving
the source; never overwrite a refined worktree spec on resume.

## Handover ownership

| File | Owner and purpose |
| --- | --- |
| `spec.md` | spec: requirements, clarifications, accepted scope and deferrals |
| `architecture.md` | architect: optional design, units, contracts, open decisions |
| `code.md` | code: implementation, verification, repair dispositions, outstanding work |
| `review.md` | review: findings, unmet requirements, and reviewed snapshot |
| `ship.md` | ship: final commit, release decisions, verification and cleanup outcome |

Every handover distinguishes completed work from proposals, open questions, and
human decisions. Update the owning document as discussion resolves it. Other
skills may read allowed inputs but must not silently rewrite another role's
conclusions. If implementation exposes a requirements change, discuss it and
have the human return to spec or explicitly authorize the spec update.

The helper owns hidden JSON records beside these Markdown documents:
workspace identity, actual verification, review snapshots and the release
receipt. They record facts, not approval or workflow status; never edit them by
hand. `verification.log` contains bounded stdout/stderr tails. Review may read
only `spec.md` and this mechanical evidence from the handover directory, plus
its own review files. It must not read architecture or coding narratives.

## Commands

Here `<helper>` is the absolute path to this bundle's `scripts/workspace.mjs`.
All commands print JSON; errors exit nonzero. Commands take an optional title
except `start`, which requires it. Run them with the target repository as cwd.

```sh
node <helper> start <title>
node <helper> status <title>
node <helper> snapshot <title>
node <helper> verify <title> -- 'the project verification command'
node <helper> review-start <title>
node <helper> review-finish <title>
node <helper> release <title>
node <helper> cleanup <title>
```

`start`, `release`, and `cleanup` run from main. The other commands locate the
registered epic worktree; they do not rely on the caller having changed cwd.
Use the returned path for subsequent file reads and edits. `status` reports the
base for reviewing the entire change, including changes already committed.

`snapshot` hashes tracked and untracked file contents, paths, executable bits,
and symlink targets, plus the spec. It also records HEAD, the staged entries,
Git configuration, hooks and ancestry metadata for read-only integrity checks.
Commit creation alone does not change the content fingerprint. Unreadable
evidence is an error.

`verify` executes the supplied command through Bash, with a 30-minute timeout
and process-group cleanup. It records the command, actual exit, duration, output
tails, and before/after snapshots. A nonzero exit, interruption, timeout, or
change to the tested code/spec is not green. Discover the command from the
project's `scripts.verify` or documented full checks; do not substitute a stub
or a narrower command just to pass. Baseline failures can be discussed during
coding, but shipping requires a passing full verification.

`review-start` captures the read-only baseline and invalidates any older sealed
review. After the reviewer writes `review.md`, `review-finish` checks content
and Git integrity and seals that report against the snapshot. It does not judge
the findings. A changed spec, source tree, or report makes the seal stale.

## Shipping and preservation

Only ship stages, commits, rebases, fast-forwards main, or removes the workspace.
Until then preserve the existing index and branch; never stash, reset or clean
to make a gate pass. Everything remains local: no push, PR, issue or host action.

Shipping checks findings and human decisions from their evidence. A current
review is not automatically a positive review. If review is missing or stale,
tell the human what changed and let them choose review or explicit acceptance
of the unreviewed state. Only that explicit choice permits
`release <title> --accept-unreviewed`; record it in `ship.md`. Do not ask again
for a choice already made for the same code and spec.

Release requires clean main and epic checkouts, exactly one commit above main,
and successful verification bound to the current HEAD, main, contents and spec.
It fast-forwards to the checked commit SHA. Rebase, amendments, interruptions,
and failed checks require fresh verification; never infer green from ancestry.

The helper records the release candidate before fast-forwarding, so interruption
after the merge cannot lose the cleanup handoff. A receipt alone is not proof
of landing: cleanup also requires positive proof that main contains the epic
commit. It archives the entire handover directory under
`.epics/<title>/releases/<commit>/` in main and verifies the copy before removing
the worktree and deleting its branch with an expected old SHA. It never forces
removal. Extra ignored files outside this epic's handover directory cause it to
stop and list them, with a wholly ignored directory as one entry: preserve
local settings and user data, and remove only
outputs you have established are disposable. Never delete an occupied or
foreign path to get cleanup through. If cleanup stops, report which resources
remain. Failures before removal retain the workspace; a branch that advances
during removal is preserved even if its worktree has already been removed.
The release remains complete, and archived handovers are retained.
