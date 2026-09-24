# Local epic skills

Five separate Codex skills support a human-led local workflow. There is no
`epic` skill and no orchestrator: invoke one skill, inspect its output, discuss
or refine it, then choose what to do next. Architecture is optional. Return to
code for repairs; use a fresh session for independent review.

| Skill | Result |
| --- | --- |
| [spec](spec/SKILL.md) | Agreed requirements in `spec.md` |
| [architect](architect/SKILL.md) | A proposed design in `architecture.md` |
| [code](code/SKILL.md) | Implementation, actual verification, and `code.md` |
| [review](review/SKILL.md) | Independent findings in `review.md` |
| [ship](ship/SKILL.md) | One local commit on main, archived handovers, safe cleanup |

The [shared contract](EPIC-CONTRACT.md) defines workspaces and handovers in
`.epics/<title>/`. The [helper](scripts/workspace.mjs) implements repeated Git
operations and captures evidence. Neither chooses the next skill or calls a
model. Skills resolve shared files from this Toliki checkout, never from a
target project's instructions directory.

The spec skill can create the worktree while discussing requirements. Continue
in that worktree with a new Codex session when useful; keep the coding session
for repairs if you prefer. Changes to the agreement belong in the handover
files before another session takes over.

This bundle stays in Toliki for now; installation and registration are deferred.
Its local `spec` is separate from the existing [GitHub-filing spec](../spec/SKILL.md).
These skills never create issues, push branches, open PRs, or run host jobs.
