---
name: spec
description: Interactively author a complete, build-ready spec and file it as a GitHub issue — the one human gate before the autonomous `/epic` pipeline. Use when starting a new epic/feature that needs design clarification before any code is written.
---

Author a build-ready spec with the user and file it as GitHub issues, one per independently deliverable slice. This is the single human gate: the issue body becomes the definition of done that `/epic #N` builds against and is blind-reviewed against. Define what to build, not architecture or code.

A trivial change (one obvious edit, no design choice) needs no issue and no pipeline; do it inline.

Read `ISSUE-TRACKING.md` from this skill's own directory before filing anything. It is the filing doctrine (slicing, the allowed primitives, `blocked_by`), and it is shared harness content, not a file in the project you are working in.

Request: $ARGUMENTS

## What to do

1. **Sanity-check scope.** Quick read of the request, glancing at code only if needed. If trivial, say so, suggest doing it inline, and ask the user to confirm before doing anything else.

2. **Discovery.** If the request is unclear, ask what problem it solves, what it should do, and the constraints. Summarize your understanding back.

3. **Explore the relevant surface (read-only).** Launch `spec-explorer` subagents in parallel, each scoped to the area you need to understand for good requirements, not the whole system. Read the key files they flag; do not open broad swaths of code you do not need.

4. **Clarifying questions, never skipped.** List every underspecified aspect: edge cases, error handling, integration points, scope boundaries, backward compatibility, performance, design preferences. Present them as an organized list and wait for answers; recommend and confirm when asked to pick.

5. **Slice it.** Most features are one issue: say so in a line and go to step 6. Split only where a piece genuinely stands alone.
   - Test each candidate with the `ISSUE-TRACKING.md` test: could one coherent PR close it and still mean something on its own? A horizontal fragment ("add the types", "part 2 of X") is merged back into its sibling.
   - Wire a `blocked_by` edge only where the later slice genuinely cannot be built or verified until the earlier one has merged. "I'd naturally do this one first" is not a dependency: every edge serializes a slice through the blocker's whole build, PR, CI and merge cycle, while independent slices fill parallel build slots.
   - Show the plan and get approval before filing anything: titles, a one-liner each, and every edge with its justification.

6. **Draft the spec, one per slice.** Each body stands on its own as the definition of done, readable against the eventual diff with no other context. The review lenses judge the diff against the issue body alone, barred from `.epics/` and from sibling issues, so never write one big spec and file N issues pointing at it: repeat the shared context in each body.
   - **Goal**: one line.
   - **Functional requirements.**
   - **Non-goals / out of scope**, naming the sibling that covers each: "X is out of scope, covered by #44." A sibling's work left unnamed reads as an unmet requirement, and fixes-after-review will then build it into this slice unattended. Ids do not exist yet: write the placeholder now and fill it in at step 7.
   - **Accepted trade-offs and deferrals**, each with the clarifying answer that narrowed scope.
   - **Constraints**: only what constrains this build and is not already standing. Never restate the project's own rules: the pipeline's agents already read the project's `AGENTS.md`, and architecture selects test-first or direct implementation under the same mandatory `npm run verify` gate and independent review. A bullet earns its place only if it is particular to this feature: a compatibility boundary, a required interaction with existing data or a live surface, a security or privacy property the diff must hold. If nothing qualifies, omit the section.

   Show them to the user and fold in their edits. Confirm the titles. Do not invent labels or milestones: beyond the `ready` label applied in step 7, a spec issue carries none of the primitives in `ISSUE-TRACKING.md`.

7. **File them as a graph.** On approval, file in topological order, blockers first: the dependency API keys on the blocker's DB `id`, which exists only once it is filed (`ISSUE-TRACKING.md`, recipes). Capture each `id` as you go, wire the edges, then backfill the real issue numbers into the Non-goals placeholders.
   ```
   gh label create ready --color 1D76DB --description "Spec complete; queued for the epic-run pipeline" 2>/dev/null || true
   gh issue create --title "<title>" --body "<spec>" --label ready
   ```
   Label all of them `ready`, blocked ones included: the queue skips a blocked issue and re-picks it the moment its blocker closes.

   Return each issue number and URL with the edges. Do not append a reminder about how to build them.
