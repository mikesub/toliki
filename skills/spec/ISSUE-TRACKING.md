# Issue tracking — filing doctrine

Work is tracked as a **flat list of GitHub issues**. There is no grouping layer:
no Projects/boards, no milestones, no sub-issues, no parent/tracking issues.

## Slice issues as autonomous changes

Every issue stands on its own as a **meaningful, finished change** — mergeable
and verifiable independently, leaving the tree green. Not always user-facing (a
refactor or an internal seam counts), but:

- never a horizontal fragment that only makes sense bundled with its siblings
  ("add the types", "part 2 of X");
- never a grab-bag of several unrelated changes.

Test: *could one coherent squashed commit close it and still mean something on
its own?* If not, split or merge. This is the unit the build queue delivers, so
an issue that fails the test is an issue neither workflow can deliver.

## Ordering / gating: `blocked_by` dependencies

Order and gating live in GitHub's **issue dependencies** — their own primitive,
not a label, a sub-issue, or a comment. Any issue can be `blocked_by` any
other. Reach for it whenever one issue gates another: the dispatch queue walk
queries dependencies and skips a blocked issue rather than burning a run on it.

## Relating without gating: a plain `#N` cross-reference

A link that carries no ordering (a follow-up and the issue it came out of, two
issues worth reading together) is a plain `#N` mention in the body, which
GitHub records as a cross-reference on that issue's timeline. GitHub's own
**"relates to"** relationship (issue sidebar → Relationships) means the same
thing and a human may set it, but as of 2026-08 it is UI-only with no REST,
GraphQL or `gh` surface, so a scripted run uses the cross-reference instead.
Do **not** substitute `blocked_by`, which would hold the queue back on work
nobody is waiting for, and do not invent a label for it.

## Allowed primitives — do not extend

Use **only** flat issues, `blocked_by` dependencies, `#N` cross-references.
No custom fields, no status taxonomies.

**Do not create labels by hand.** The label namespace belongs to the pipeline;
no `area:*`, `type:*`, `track:*` or `priority:*` scheme. `/spec` may apply only
**`ready`**, the build queue, and the persistent **`task`** workflow selector.
Create issues unqueued, finish every body and required dependency in the batch,
and read them back from GitHub before applying either label. Dispatch may claim
a `ready` issue immediately; it must never see missing dependencies or
unresolved sibling placeholders. If a body or dependency write or readback
fails, leave the batch unqueued and report the incomplete work. Once the whole
batch is complete, apply `ready` in one bulk `gh issue edit` command per
repository, adding `task` only to the explicitly selected issue numbers. Read
back each issue's labels even if an update fails, and report any incomplete
queueing.

`/spec` selects `task` only after an explicit human choice, for a clear,
low-risk implementation whose requirements and approach are already settled.
It must not infer the selector from issue size or let a model choose it. Keep
the ordinary epic path for architecture, security, migrations, infrastructure,
policy, broad refactors, or any work where independent review is material.
Plain `ready` means epic; `ready` plus `task` means the deliberately cheaper
single-agent workflow with verification but no independent model review.

If a genuinely new need appears, **propose it to the human first** — don't
improvise a convention.

## Issues are durable; todos are not

GitHub issues are the units of delivery — high-level and persistent. Never open
one for a transient coding todo, and never mirror your in-flight task list into
issues; your own task tracker is for that.

## Recipes

```sh
gh issue list --state open

# Create each issue unqueued. Keep multiline bodies in files.
# For a relation without gating, put the `#<other>` mention in that file.
gh issue create --title "<title>" --body-file /path/to/spec.md

# Once sibling numbers exist, replace placeholders in the body file and save.
gh issue edit <number> --body-file /path/to/spec.md

# Order constraint: <blocked> is blocked_by <blocker>.
# GOTCHA: the dependency API keys on the issue's DB `id` (`.id`), NOT its `number`.
bid=$(gh api repos/:owner/:repo/issues/<blocker> --jq .id)
gh api -X POST repos/:owner/:repo/issues/<blocked>/dependencies/blocked_by -F issue_id="$bid"

# Read back each final body and its required dependencies.
gh issue view <number> --json body
gh api repos/:owner/:repo/issues/<number>/dependencies/blocked_by --jq '.[].number'

# Only after the whole batch matches the intended bodies and dependencies:
# Pass every issue number in this repository to one bulk label update.
gh issue edit <number-1> <number-2> --add-label ready
# For the human-selected lightweight subset only:
gh label create task --color C5DEF5 --description "Human-selected lightweight single-agent task workflow"
gh issue edit <task-number-1> <task-number-2> --add-label task
# Read each issue back, even if the bulk update reported an error.
gh issue view <number> --json labels --jq '.labels[].name'
```
