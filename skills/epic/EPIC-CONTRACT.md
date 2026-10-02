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
replace the human's phase decisions. A reviewer is a fresh session that has not
run t-architect or t-code for the epic and was not launched by one.

## Workspace

`<title>` is a short lowercase hyphenated name, such as `saved-searches`. It
names branch `epic/<title>` and a worktree in a shared `worktrees/` directory
beside the main checkout, one subdirectory per repository: `~/code/app` keeps
its epics under `~/code/worktrees/app/<title>`. Here `<main>` is the checkout
that has local `main` checked out (find it with `git worktree list`) and
`<worktree>` is the epic's worktree; `<repo>` is the main checkout's directory
name (`app` here). Use explicit paths or `git -C` for every
command; never change the main checkout's product code while working on an
epic.

Create a new epic from main:

```sh
git -C <main> worktree add -b epic/<title> <main>/../worktrees/<repo>/<title> main
```

If the branch or path already exists, do not create or remove anything: it is
an existing epic to resume, or a collision to raise with the human. Creating
does not install dependencies or copy ignored local settings, and does not mean
the requirements are settled. Whichever phase is invoked first with a spec but
no worktree creates it this way.

Handovers live in `<worktree>/.epics/<title>/` and must never be committed.
Ensure `/.epics/` is a line in the file `git -C <main> rev-parse
--git-path info/exclude` names, relative to `<main>` (create it if missing; it
applies to every worktree), and confirm `git -C <worktree> check-ignore -q
.epics/<title>/spec.md` succeeds. If the user brings an existing spec, copy it
to `spec.md` once, preserving the source; never overwrite a refined worktree
spec on resume.

To resume, locate the worktree through `git worktree list` (branch
`epic/<title>`) and read the existing handovers and actual changes; a commit or
handover file alone proves no phase complete. An interrupted rebase belongs to
ship: when `git -C <worktree> status` reports a rebase in progress, only ship
resumes it, and any other phase reports it and stops.

## The change and its fingerprint

The change is every committed, staged and unstaged edit to tracked files since
the base, plus staged new files; untracked files are not part of it, so stage
each new file when you create it. The base is `git -C <worktree> merge-base main
HEAD`; read the change with `git -C <worktree> diff <base>`, never `git diff
HEAD`, which loses changes once committed.

The change fingerprint identifies exactly what was verified or reviewed.
Compute it with this one command, never with a base carried over from an
earlier command:

```sh
git -C <worktree> diff --binary --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ "$(git -C <worktree> merge-base main HEAD)" | git -C <worktree> hash-object --stdin
```

`e69de29bb2d1d6434b8b29ae775ad8c2e48c5391` is the hash of empty input: the
command failed or there is no change. Never record or accept it. Committing
keeps the fingerprint, a rebase keeps it only when main changed none of the
epic's files, and any edit changes it. The spec hash is `git -C <worktree>
hash-object .epics/<title>/spec.md`. Record both as one line, the change key
`change <fingerprint> spec <spec-hash>`, with the verification in `code.md`
and with the review in `review.md`.

## Verification

The full verification command is `package.json`'s `scripts.verify` or the
project's documented full check; when neither names exactly one command, agree
it with the human and record it in `spec.md`. Every full verification run uses
exactly that command, never a narrower one or a stub.
Run it in the worktree, compute the fingerprint immediately before and after,
and report the command, exit status and fingerprint. Green means exit status 0
with the same fingerprint before and after; a claim without a run, a timeout or
an interruption is not green.
A failure that already exists on main still blocks shipping: fix it in this
epic with a spec change, or land a fix first.

## Handover ownership

| File | Owner and purpose |
| --- | --- |
| `spec.md` | spec: requirements, clarifications, accepted scope and deferrals |
| `architecture.md` | architect: optional design, units, contracts, open decisions |
| `code.md` | code: implementation, verification, repair dispositions, outstanding work |
| `review.md` | review: findings, unmet requirements, and the reviewed change key |
| `ship.md` | ship: acceptances with the change key each covers, the landed commit and its verification, the confirmed reproducible paths |

Every handover distinguishes completed work from proposals, open questions, and
human decisions. Update the owning document as discussion resolves it. Other
skills may read allowed inputs but must not silently rewrite another role's
conclusions. If design or implementation exposes a requirements change, discuss
it and have the human return to spec or explicitly authorize the spec update.
Review may read only `spec.md` and its own earlier review from the handover
directory, never the architecture or coding narratives.

## Shipping and preservation

Only ship commits, rebases, fast-forwards main, or removes the workspace. Until
then preserve the existing branch and changes; never stash, discard or clean to
make a check pass. The only reset is ship's `reset --soft` squash. Everything
remains local: no push, PR, or issue.

Ship rebases only on a clean worktree, with `git -C <worktree> rebase
--no-autostash main`, so `rebase.autoStash` cannot stash anything. Resume with
`git -C <worktree> rebase --continue`, or with `git -C <worktree> rebase
--abort` when a conflict's intent is unclear; never `git rebase --skip` the epic
commit, which drops the work. Main may have changed dependencies, so reinstall
them in the worktree as the project documents before verifying a rebase.

A review is current only when the change key in `review.md` equals the current
one. If it is missing or stale, say whether the code or the spec moved and let
the human choose another review or acceptance of the unreviewed state. Record
every acceptance in `ship.md` with the change key it covers; it never applies
to another key.

The worktree is clean when `git -C <worktree> status --porcelain
--untracked-files=all` prints nothing. Immediately before advancing main,
confirm for `<commit>`:

- it is the worktree's `HEAD`, and `git -C <worktree> rev-list --count
  main..HEAD` prints `1`;
- the worktree was clean before and after its green full verification;
- its change key equals `review.md`'s or a recorded acceptance's, and every
  open finding, unmet requirement and open decision has a recorded acceptance;
- `git -C <main> branch --show-current` prints `main`.

Then run `git -C <main> merge --ff-only --no-autostash --no-overwrite-ignore
<commit>`. Any rebase, amendment, interruption or failed check restarts these
checks; never infer green from ancestry.

After main contains the commit (`git -C <main> merge-base --is-ancestor
<commit> main`), save everything the worktree holds outside Git before removing
anything. `git worktree remove` refuses untracked files but deletes ignored ones
without asking, so:

1. List every ignored file with `git -C <worktree> ls-files --others --ignored
   --exclude-standard`; `status --ignored` hides the files inside ignored
   directories. Outside `.epics/<title>/`, a file is reproducible only when it
   lies under a path that a documented project command recreates, such as
   installed dependencies or build output. Propose those paths with their
   commands, have the human confirm them, and record the decision in
   `ship.md`. Every other ignored file is preserved.
2. Archive the handovers: `mkdir -p <main>/.epics/<title>/releases/<commit>`,
   `cp -R <worktree>/.epics/<title>/. <main>/.epics/<title>/releases/<commit>`,
   and confirm `diff -r <worktree>/.epics/<title>
   <main>/.epics/<title>/releases/<commit>` exits 0.
3. Copy each preserved file to `<main>/.epics/<title>/preserved/<commit>/<path>`
   and confirm each copy with `cmp`.

Only then remove the worktree with `git -C <main> worktree remove <worktree>`
and the branch with `git -C <main> branch -d epic/<title>`. Never pass
`--force` or `-D`; when Git refuses, report why and leave the resources. If
cleanup stops, main keeps the commit; report which resources remain.
