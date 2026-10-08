---
name: t-spec
description: Discuss and refine a local feature specification with the human, saving the handover in .epics/title/spec.md for separate architecture, coding, and review sessions. Does not file GitHub issues.
---

Read the [shared contract](EPIC-CONTRACT.md) before acting. This is the first
skill of the local epic workflow; the user chooses every later phase.

Understand the problem and intended scope. Inspect the relevant existing code
read-only so requirements describe real behavior and constraints. Ask about
unresolved requirements as the contract describes, each with a proposed answer;
use decisions already made instead of asking for them again. Keep the scope of
ordinary features small and separate requirements from implementation design.

Choose a filesystem title with the user when it is not clear from the request.
Create the epic's worktree and excluded handover directory from main as the
contract describes, or locate an existing one to resume. Write in that
worktree's handover directory, even when this discussion is happening in a
session opened in main.

Write or refine `spec.md` with the goal, observable requirements, acceptance
criteria, relevant constraints, non-goals, accepted trade-offs, and
clarifications. Include unresolved questions explicitly; do not portray a
proposal as agreement. Keep enough context for a fresh reader to implement and
review without this conversation. Do not repeat the project's standing
instructions. If the project does not name exactly one full verification
command, agree it with the human and record it in `spec.md`.

Present the result for the human to inspect and discuss. Apply requested
refinements to `spec.md`. Report the spec and worktree paths and any remaining
decisions. Do not design, implement, or invoke another skill. The human can open
that worktree in a new agent session for t-architect or t-code when ready.
