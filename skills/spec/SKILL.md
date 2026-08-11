---
name: spec
description: Interactively author a complete, build-ready spec and file it as a GitHub issue — the one human gate before the autonomous `/epic` pipeline. Use when starting a new epic/feature that needs design clarification before any code is written.
disable-model-invocation: true
---

You author a **build-ready spec** together with the user and file it as a GitHub issue — one per independently deliverable slice of the work. This is the single human gate: the issue body becomes the **definition of done** that the later `/epic #NN` pipeline builds against and is blind-reviewed against. You define *what* to build here — not architecture, not code.

A **trivial** change (one obvious edit, no design choice) does not need an issue or the pipeline — just do it inline.

**Read `ISSUE-TRACKING.md` from this skill's own directory** (it sits next to this SKILL.md) before you file anything. It is the authoritative filing doctrine — how issues are sliced, which primitives exist, how `blocked_by` works — and it is shared harness content, not a file in the project you're working in.

Request: $ARGUMENTS

## What to do

1. **Sanity-check scope.** Quick read of the request (light glance at code only if needed). If trivial, say so and suggest doing it inline — **ask the user to confirm before doing anything else.** Otherwise proceed.

2. **Discovery.** If the request is unclear, ask what problem it solves, what the feature should do, and the constraints. Summarize your understanding back.

3. **Explore the relevant surface (read-only).** Launch `explorer` subagents in parallel to trace the existing patterns and where this slots in. Scope them by breadth, not depth — point each at the specific area you need to understand to write good requirements, rather than the whole system. Read the key files they flag; don't open broad swaths of code you don't need.

4. **Clarifying questions — do not skip.** Identify every underspecified aspect: edge cases, error handling, integration points, scope boundaries, backward compatibility, performance, design preferences. Present them as an organized list and **wait for answers**; recommend and confirm when asked to pick.

5. **Slice it.** With the answers in hand, decide how many issues this is. **Most features are one** — if the work is a single coherent slice, say so in a line and go to step 6. Split only where a piece genuinely stands alone.
   - **Test each candidate** (`ISSUE-TRACKING.md`): could one coherent PR close it and still mean something on its own? One that fails is a horizontal fragment ("add the types", "part 2 of X") — merge it back into its sibling.
   - **Bias toward width, not just correct dependencies.** A dependent doesn't merely wait for its blocker to be *built* — it waits for build + PR + rebase + CI + merge + issue-close, so every `blocked_by` edge serializes a slice through the entire pipeline, while independent slices fill parallel build slots. "I'd naturally do this one first" is **not** a dependency. Wire an edge only where the later slice genuinely cannot be built or verified until the earlier one has landed.
   - **Show the plan and get approval before filing anything**: titles, a one-liner each, and every edge with the justification for it. N issues is not trivially reversible.

6. **Draft the spec — one per slice.** Write each issue body so it **stands on its own as the definition of done** — readable against the eventual diff with no other context. The pipeline's review is **blind**: its lenses judge the diff against that issue body alone, are barred from reading `.epics/`, and get no sibling context at all. So never write one big spec and file N issues pointing at it — "per the design in #41" gives the requirements-coverage lens nothing to judge. Repeat the shared context in each body instead.
   - **Goal** — one line.
   - **Functional requirements.**
   - **Non-goals / out of scope** — and name the sibling that covers each one: *"X is out of scope, covered by #44."* Staying silent about what a sibling does reads as an unmet requirement: the coverage lens flags it, adversarial verify confirms it (it genuinely is absent), and triage "fixes" it by expanding this slice into its sibling's territory, unattended. Ids don't exist yet — write the placeholder now, fill it in at step 7.
   - **Accepted trade-offs & deferrals** — each with the clarifying answer that narrowed scope.
   - **Constraints** — only what constrains *this* build and is not already standing. Never restate the project's own rules: the pipeline's agents already carry `CLAUDE.md`, the path-scoped `.claude/rules/*.md` (auto-attached to any diff touching their paths), and the `coder` agent's red-green TDD and `npm run verify` gate. Copying them in adds nothing and goes stale the moment they change. A bullet earns its place only if it is particular to this feature — a compatibility boundary, a required interaction with existing data or a live surface, a security or privacy property the diff must hold. If nothing qualifies, omit the section.

   Show them to the user and fold in their edits. Confirm the titles. **Do not invent labels or milestones** — see the allowed primitives in `ISSUE-TRACKING.md`; beyond the `ready` label applied in step 7, an epic issue carries none of them (tracking is flat, with `blocked_by` dependencies for ordering).

7. **File them as a graph.** On approval, file in **topological order — blockers first**: the dependency API keys on the blocker's DB `id`, which doesn't exist until it's filed (`ISSUE-TRACKING.md` → recipes). Capture each `id` as you go, wire the edges, then backfill the real issue numbers into the Non-goals placeholders.
   ```
   gh label create ready --color 1D76DB --description "Spec complete; queued for the epic-run pipeline" 2>/dev/null || true
   gh issue create --title "<title>" --body "<spec>" --label ready
   ```
   Label **all** of them `ready`, blocked ones included — that label is the `/epic` build queue, and the queue skips a blocked issue and re-picks it the moment its blocker closes, so a blocked slice belongs in the queue rather than held back.

   Return each issue number and URL (with the edges). Don't append a reminder about how to build them — the user knows the `/epic` flow.
