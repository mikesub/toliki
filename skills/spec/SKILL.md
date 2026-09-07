---
name: spec
description: Interactively author a complete, build-ready spec and file it as a GitHub issue. Use when starting a new epic/feature that needs design clarification before any code is written.
---

Author a build-ready spec with the user and file it as GitHub issues, one per independently deliverable slice. The human resolves requirements and confirms any split into multiple issues; the skill writes the issue bodies without asking the user to review them. The issue body becomes the definition of done that `/epic #N` builds against and is blind-reviewed against. Define what to build, not architecture or code.

Read `ISSUE-TRACKING.md` from this skill's own directory before filing anything. It is the filing doctrine (slicing, the allowed primitives, `blocked_by`), and it is shared harness content, not a file in the project you are working in.

Request: $ARGUMENTS

## What to do

1. **Sanity-check scope.** Quick read of the request, glancing at code only if needed. Keep an obvious change proportionally small.

2. **Discovery.** If the request is unclear, ask what problem it solves, what it should do, and the constraints. Summarize your understanding back.

3. **Explore the relevant surface (read-only).** Launch `spec-explorer` subagents in parallel, each scoped to the area you need to understand for good requirements, not the whole system. Read the key files they flag; do not open broad swaths of code you do not need.

4. **Resolve uncertainties.** Check for missing requirements, edge cases, error handling, integration points, scope boundaries, backward compatibility, performance and design preferences. Ask only questions whose answers are still needed to define the work, and wait for those answers. Use decisions already made in the conversation; when the user delegates a choice, make it. If nothing remains unclear, continue without a confirmation turn.

5. **Slice it.** Most features are one issue: once the requirements are clear, write and file it immediately without asking for title, body or filing approval. Split only where a piece genuinely stands alone.
   - Test each candidate with the `ISSUE-TRACKING.md` test: could one coherent squashed commit close it and still mean something on its own? A horizontal fragment ("add the types", "part 2 of X") is merged back into its sibling.
   - Wire a `blocked_by` edge only where the later slice genuinely cannot be built or verified until the earlier one has merged. "I'd naturally do this one first" is not a dependency: every edge serializes a slice through the blocker's whole build, PR, CI and merge cycle, while independent slices fill parallel build slots.
   - For multiple issues only, confirm the split before filing: show the proposed titles, with a short scope or dependency explanation only where needed to make the split clear. Once that split is confirmed, proceed without another approval. An unchanged split already confirmed in the conversation needs no repeat confirmation.

6. **Write the spec, one per slice.** Write the bodies internally; the user sees the issue titles, not a draft-body review. If writing exposes a new ambiguity that affects the requirements or split, ask that specific question and then continue. Each body stands on its own as the definition of done, readable against the eventual diff with no other context. The review lenses judge the diff against the issue body alone, barred from `.epics/` and from sibling issues, so never write one big spec and file N issues pointing at it: repeat the shared context in each body.
   - **Goal**: one line.
   - **Functional requirements.**
   - **Non-goals / out of scope**, naming the sibling that covers each: "X is out of scope, covered by #44." A sibling's work left unnamed reads as an unmet requirement, and fixes-after-review will then build it into this slice unattended. Ids do not exist yet: write the placeholder now and fill it in at step 7.
   - **Accepted trade-offs and deferrals**, each with the clarifying answer that narrowed scope.
   - **Constraints**: only what constrains this build and is not already standing. Never restate the project's own rules: the pipeline's agents already read the project's agent markdown instructions, and architecture selects test-first or direct implementation under the same mandatory `npm run verify` gate and independent review. A bullet earns its place only if it is particular to this feature: a compatibility boundary, a required interaction with existing data or a live surface, a security or privacy property the diff must hold. If nothing qualifies, omit the section.

7. **File, then queue.** Create GitHub issues without `ready`, in topological order, blockers first: the dependency API keys on the blocker's DB `id`, which exists only once it is filed (`ISSUE-TRACKING.md`, recipes). Capture each number and `id` as you go, wire the edges, then backfill the real issue numbers into the Non-goals placeholders. Use body files for multiline specs.
   Read back the final bodies and required dependencies from GitHub before queueing any issue in the batch. If filing, linking or verification fails, leave the batch unqueued and report what remains incomplete; reuse the created issues on retry. Once the whole batch is complete, bulk-apply `ready` with one `gh issue edit <numbers...> --add-label ready` command per repository, blocked issues included: the queue skips a blocked issue and re-picks it the moment its blocker closes. Read back each issue's labels even if the bulk command reports failure, and report any incomplete queueing. A single issue follows the same sequence without pausing for user approval.

   Return only each issue number linked to its URL and its title, one per line: `[#123](url) — Title`. If filing or queueing was incomplete, add the specific failure and affected issue numbers. Do not append issue bodies or a reminder about how to build them.
