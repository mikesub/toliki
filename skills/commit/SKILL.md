---
name: commit
description: Group all uncommitted changes into logical commits with proper messages and push. Use when the user wants to commit and push their working-tree changes.
disable-model-invocation: true
---

Turn the working tree into a clean series of logical commits, then push.

Optional scope/hint: $ARGUMENTS

## Steps

1. **Survey.** Run in parallel (read-only): `git status --short`, `git diff` (unstaged), `git diff --staged`, `git log --oneline -10` (to match message style), `git branch --show-current`. If the tree is clean, say so and stop.

2. **Group into logical blocks.** Partition the changes by intent — one concern per commit (e.g. a feature, a bugfix, a refactor, a docs/config change). Don't mix unrelated changes. A single file may split across commits via `git add -p` if it contains distinct concerns; keep related files together. If grouping is genuinely ambiguous and `$ARGUMENTS` doesn't resolve it, ask before committing.

3. **Commit each block.** Serialize all mutating git commands — never parallelize them. For each group:
   - Stage exactly that group (`git add <paths>`, or `git add -p` for partial files). Verify with `git diff --staged` before committing.
   - Write the message: a concise one-line summary, then a blank line, then a short body explaining the *why* / notable details. Match the prevailing style in the `git log` from step 1 — some repos use a `type(scope): summary` subject, others plain sentences. Be extremely concise.
   - If a commit finishes a GitHub issue, close it from the message with a closing keyword — `Closes #N` / `Fixes #N` / `Resolves #N`, **not** a bare `(#N)` (which only links). Trunk-based means the commit message is the only auto-close.
   - Use `--body-file` (a temp file) or repeated `-m` flags to avoid shell-escaping issues with backticks/markdown.

4. **Legal check.** If this project's CLAUDE.md defines a legal/policy review trigger (a section stating when a change needs legal review), judge each commit against the criteria written there — not any you remember from elsewhere — and when they're met, add the marker that section specifies to the commit body. If this project defines no such trigger, skip this check entirely: do not invent criteria and do not import another project's.

5. **Push.** Trunk-based: these commits land on `main` unless the user is on / asked for a branch — don't switch branches. `git push`.

6. If the push failed (e.g. non-fast-forward), say so and stop — do not force-push without asking.

## Notes

- Don't amend or rewrite existing commits, and never force-push.
- Don't run `npm run verify` here — this skill is commit+push only.
