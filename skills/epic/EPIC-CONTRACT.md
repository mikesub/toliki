# Shared local epic contract

All five skills follow this contract. Each skill directory carries a copy, so
read it from the invoked skill's own directory. Never copy skills or this
contract into target projects.

## Human-owned transitions

Perform the invoked skill only. Discuss its result and stop; never invoke the
next skill automatically. Use decisions already agreed in the conversation.
Resolve missing requirements with the human, and record decisions in the owning
document before handing over. Do not invent requirements or expand into rare
edge cases without the user's agreement. Project instructions still apply.

Each skill acts directly in the current agent session, whichever harness runs
it. Subagents are optional when the user authorizes parallel work; they do not
replace the human's phase decisions. Independent reviewers need a fresh context
without the builder conversation.

## Workspace

`<title>` is a short lowercase hyphenated name, such as `saved-searches`. It
names branch `epic/<title>` and a worktree in a shared `worktrees/` directory
beside the main checkout, one subdirectory per repository: `~/code/app` keeps
its epics under `~/code/worktrees/app/<title>`. Here `<main>` is the checkout
that has local `main` checked out (find it with `git worktree list`) and
`<worktree>` is the epic's worktree. Use explicit paths or `git -C` for every
command; never change the main checkout's product code while working on an
epic.

Create a new epic from main:

```sh
git -C <main> worktree add -b epic/<title> <main>/../worktrees/<repo>/<title> main
```

If the branch or path already exists, do not create or remove anything: it is
an existing epic to resume, or a collision to raise with the human. Creating
does not install dependencies or copy ignored local settings, and does not mean
the requirements are settled.

Handovers live in `<worktree>/.epics/<title>/` and must never be committed.
Ensure `/.epics/` is a line in the file `git -C <main> rev-parse
--git-path info/exclude` names, relative to `<main>` (create it if missing; it
applies to every worktree), and confirm `git -C <worktree> check-ignore -q
.epics/<title>/spec.md` succeeds. If the user brings an existing spec, copy it
to `spec.md` once, preserving the source; never overwrite a refined worktree
spec on resume.

To resume, locate the worktree through `git worktree list` (branch
`epic/<title>`) and read the existing handovers and actual changes; a commit or
handover file alone proves no phase complete. Finish an interrupted rebase
before other work.

## The change and its fingerprint

The change is everything between the base and the worktree, committed or not.
The base is `git -C <worktree> merge-base main HEAD`. Review the whole change
with `git -C <worktree> diff <base>`, never only `git diff HEAD`, which loses
changes once committed. Every intended new file must be staged (`git add`),
so the diff includes it; untracked files are not part of the change.

The change fingerprint identifies exactly what was verified or reviewed:

```sh
git -C <worktree> diff --binary <base> | git hash-object --stdin
```

Committing or a clean rebase that leaves the change identical keeps the
fingerprint; any edit to the change alters it. The spec is identified by `git
hash-object <worktree>/.epics/<title>/spec.md`. Record both with the
verification in `code.md` and with the review in `review.md`.

## Verification

Discover the project's full verification command from `scripts.verify` or its
documented full checks; never substitute a narrower command or a stub to pass.
Run it in the worktree and report the actual command, exit status and the
fingerprint it ran against. Only an exit status of 0 from that full command on
an unchanged fingerprint is green. A claim without a run, a timeout, an
interruption, or a run during which the change was edited is not green.
Baseline failures can be discussed during coding, but shipping requires a
passing run on the final commit.

## Handover ownership

| File | Owner and purpose |
| --- | --- |
| `spec.md` | spec: requirements, clarifications, accepted scope and deferrals |
| `architecture.md` | architect: optional design, units, contracts, open decisions |
| `code.md` | code: implementation, verification, repair dispositions, outstanding work |
| `review.md` | review: findings, unmet requirements, and the reviewed fingerprint and spec hash |
| `ship.md` | ship: final commit, release decisions, verification and cleanup outcome |

Every handover distinguishes completed work from proposals, open questions, and
human decisions. Update the owning document as discussion resolves it. Other
skills may read allowed inputs but must not silently rewrite another role's
conclusions. If implementation exposes a requirements change, discuss it and
have the human return to spec or explicitly authorize the spec update. Review
may read only `spec.md` and its own earlier review from the handover directory,
never the architecture or coding narratives.

## Shipping and preservation

Only ship commits, rebases, fast-forwards main, or removes the workspace. Until
then preserve the existing branch and changes; never stash, reset or clean to
make a check pass. Everything remains local: no push, PR, or issue.

A review is current only when its recorded fingerprint and spec match the
change now. A current review is not automatically a positive one. If review is
missing or stale, tell the human what changed and let them choose another
review or explicit acceptance of the unreviewed state; record that choice in
`ship.md`. Do not ask again for a choice already made for the same change.

Main advances only by `git -C <main> merge --ff-only <commit>` to the exact
commit that just passed full verification with a clean worktree, and only with
exactly one epic commit above main. Rebase, amendments, interruptions and
failed checks require fresh verification; never infer green from ancestry.

After main contains the commit (`git -C <main> merge-base --is-ancestor
<commit> main`), archive the entire handover directory to
`<main>/.epics/<title>/releases/<commit>/` and confirm the copy is complete
before removing anything. Then remove the worktree with `git -C <main> worktree
remove <worktree>` and the branch with `git -C <main> branch -d epic/<title>`.
Never pass `--force` or `-D`; when Git refuses, report why and leave the
resources. Before removal, list ignored files in the worktree (`git -C
<worktree> status --ignored --short`): preserve anything that is not a
reproducible output or this epic's handovers, and ask about anything unclear.
If cleanup stops, the release remains complete; report which resources remain.
