---
name: commit
description: Group all uncommitted changes into logical commits with proper messages and push. Use when the user wants to commit and push their working-tree changes.
disable-model-invocation: true
---

Turn the working tree into a clean series of logical commits, then push.

Optional scope/hint: $ARGUMENTS

## Steps

1. **Survey.** Run in parallel, read-only: `git status --short`, `git diff`, `git diff --staged`, `git log --oneline -10` (to match message style), `git branch --show-current`. If the tree is clean, say so and stop.

2. **Group by intent.** One concern per commit: a feature, a bugfix, a refactor, a docs or config change. Never mix unrelated changes. A single file may split across commits with `git add -p` when it holds distinct concerns; keep related files together. If the grouping is genuinely ambiguous and `$ARGUMENTS` does not settle it, ask before committing.

3. **Commit each group.** Serialize every mutating git command; never parallelize them. For each group:
   - Stage exactly that group (`git add <paths>`, or `git add -p` for partial files). Check with `git diff --staged` before committing.
   - Message: a concise one-line summary, a blank line, then a short body with the why and notable details. Match the prevailing style in the `git log` from step 1, whether `type(scope): summary` or plain sentences. Be extremely concise.
   - If a commit finishes a GitHub issue, close it from the message with `Closes #N`, `Fixes #N` or `Resolves #N`, never a bare `(#N)`, which only links. Trunk-based: the commit message is the only auto-close.
   - Pass the message with `--body-file` (a temp file) or repeated `-m` flags to avoid shell-escaping backticks and markdown.

4. **Legal check.** If this project's `AGENTS.md` defines a legal or policy review trigger (a section stating when a change needs legal review), judge each commit against the criteria written there, not any you remember from elsewhere, and when they are met add the marker that section specifies to the commit body. If the project defines no such trigger, skip this check entirely: do not invent criteria and do not import another project's.

5. **Push.** Trunk-based: `git push` on the current branch. Do not switch branches.

6. If the push fails (for example non-fast-forward), say so and stop. Never force-push.

## Notes

- Do not amend or rewrite existing commits.
- Do not run `npm run verify` here; this skill is commit and push only.
