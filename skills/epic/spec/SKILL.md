---
name: spec
description: Discuss and refine a local feature specification with the human, saving the handover in .epics/title/spec.md for separate architecture, coding, and review sessions. Does not file GitHub issues.
---

Read the [shared contract](../EPIC-CONTRACT.md) before acting. This is the local
spec skill in the Codex epic bundle; the user chooses every later phase.

Understand the problem and intended scope. Inspect the relevant existing code
read-only so requirements describe real behavior and constraints. Ask concrete
questions about unresolved requirements, with proposed answers where helpful;
use decisions already made instead of asking for them again. Keep ordinary
changes small and separate requirements from implementation design.

Choose a filesystem title with the user when it is not clear from the request.
Use the shared helper's `start` from main for a new epic, or `status` for an
existing one. Write in the returned worktree's handover directory, even when
this discussion is happening in a session opened in main. If starting from an
existing local spec, preserve the source and copy it only when the destination
does not already exist.

Write or refine `spec.md` with the goal, observable requirements, acceptance
criteria, relevant constraints, non-goals, accepted trade-offs, and clarifications.
Include unresolved questions explicitly; do not portray a proposal as agreement.
Keep enough context for a fresh reader to implement and review without this
conversation. Do not repeat the project's standing instructions.

Present the result for the human to inspect and discuss. Apply requested
refinements to `spec.md`. Report the spec and worktree paths and any remaining
decisions. Do not design, implement, or invoke another skill. The human can open
that worktree in a new Codex session for architect or code when ready.
