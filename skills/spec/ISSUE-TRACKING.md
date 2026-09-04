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

Test: *could one coherent PR close it and still mean something on its own?* If
not, split or merge. This is the unit `/epic` builds, so an issue that fails the
test is an issue the pipeline cannot deliver.

## Ordering / gating: `blocked_by` dependencies

Order and gating live in GitHub's **issue dependencies** — their own primitive,
not a label, a sub-issue, or a comment. **Any** issue can be `blocked_by` any
other, including across unrelated areas of the codebase, and including a
standalone `Bug` report whose fix waits on a refactor. Reach for it whenever one
issue gates another: the `/epic` queue queries dependencies and skips a blocked
issue rather than burning a run on it.

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

Use **only** flat issues, `blocked_by` dependencies, `#N` cross-references (plus
the "relates to" relationship where a human is driving the UI), and GitHub's
native `Bug` issue type (an org-level primitive, distinct from labels — it marks
the standalone bug track; never `Task`/`Feature` types for roadmap issues). No
custom fields, no status taxonomies.

**Do not create labels by hand.** The label namespace belongs to the pipeline's
lifecycle, defined in the shared harness's `workflows/epic-run.mjs` and
`bin/merge-worker.sh`; no `area:*`, `type:*`, `track:*` or `priority:*`
scheme. The one label you ever apply is **`ready`, at filing**: it is the build
queue, and a spec issue is filed carrying it and nothing else.

If a genuinely new need appears, **propose it to the human first** — don't
improvise a convention.

## Issues are durable; todos are not

GitHub issues are the units of delivery — high-level and persistent. Never open
one for a transient coding todo, and never mirror your in-flight task list into
issues; your own task tracker is for that.

## Recipes

```sh
gh issue list --state open

# File a spec issue into the build queue
gh issue create --title "<title>" --body "<spec>" --label ready

# Relate without gating: the `#<other>` in the body is the whole mechanism.
gh issue create --title "<title>" --body "<spec>

Follow-up to #<other>"

# Order constraint: <blocked> is blocked_by <blocker>.
# GOTCHA: the dependency API keys on the issue's DB `id` (`.id`), NOT its `number`.
bid=$(gh api repos/:owner/:repo/issues/<blocker> --jq .id)
gh api -X POST repos/:owner/:repo/issues/<blocked>/dependencies/blocked_by -F issue_id="$bid"
```
