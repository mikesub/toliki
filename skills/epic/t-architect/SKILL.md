---
name: t-architect
description: Explore a local epic spec and propose a proportional implementation design in .epics/title/architecture.md for human discussion before coding.
---

Read the [shared contract](EPIC-CONTRACT.md), locate the workspace with
`status`, and read its `spec.md` completely. If the user brings a prewritten
spec without a workspace, use `start` from main and preserve/copy that spec as
the contract describes. Read the project's applicable instructions.

Explore the relevant code read-only. Capture `snapshot` before and after your
work and require the source, spec, HEAD, staged entries, configuration and Git
metadata to match. Write only `architecture.md`; if inspection changes protected state,
report the violation and stop without reverting someone else's edits.

Propose one approach with enough precision for implementation:

- The approach and existing patterns it follows, cited as `file:line`.
- Implementation units: goals, owned files, dependencies, and contracts between
  units. Default to one unit; split when independent files enable useful parallel
  work. A file has one owner.
- Tests that demonstrate the requirements and integration.
- Trade-offs, risks, assumptions and decisions still requiring the human.

For a straightforward change, keep this to a short plan and explain that a
separate architecture phase could have been skipped. Do not invent complexity
to justify the phase. Requirements ambiguities belong with the human, not an
unannounced architectural interpretation.

Present the design, discuss it, and update the architecture with agreed changes.
Record which choices were agreed and which remain proposals. Stop after the
handover; do not implement or launch t-code.
