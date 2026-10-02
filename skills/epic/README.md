# Local epic skills

Five separate skills support a human-led local workflow in any agent harness
that loads `SKILL.md` skills; Claude Code and Codex are wired by
`./setup.sh`. There is no `epic` skill and no orchestrator: invoke one
skill, inspect its output, discuss or refine it, then choose what to do next.
Architecture is optional. Return to t-code for repairs; use a fresh session for
independent review.

| Skill | Result |
| --- | --- |
| [t-spec](t-spec/SKILL.md) | Agreed requirements in `spec.md` |
| [t-architect](t-architect/SKILL.md) | A proposed design in `architecture.md` |
| [t-code](t-code/SKILL.md) | Implementation, actual verification, and `code.md` |
| [t-review](t-review/SKILL.md) | Independent findings in `review.md` |
| [t-ship](t-ship/SKILL.md) | One local commit on main, archived handovers, safe cleanup |

The [shared contract](EPIC-CONTRACT.md) defines workspaces, handovers in
`.epics/<title>/`, the git commands each phase uses, and the change fingerprint
that ties verification and review to exact code. It never chooses the next
skill. In this repo every skill directory links the contract; `./setup.sh`
installs each skill as a self-contained copy that carries its own.

t-spec can create the worktree while discussing requirements. Continue in that
worktree with a new agent session when useful; keep the coding session for
repairs if you prefer. Changes to the agreement belong in the handover files
before another session takes over.

The `t-` prefix keeps these apart from other skills of the same name. These
skills never create issues, push branches, or open PRs.
