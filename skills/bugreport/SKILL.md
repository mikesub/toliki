---
name: bugreport
description: Capture a reproducible bug report from the current context. Use when the user wants to report, file, or log a bug. Focuses on how to reproduce — not how to fix.
disable-model-invocation: true
---

Turn an observed problem into a durable, reproducible report that someone with no access to this session can reproduce later. Capture how to reproduce; do not diagnose or propose a fix.

Bug description: $ARGUMENTS

## 1. Gather from context, no questions yet

Pull everything reproducible that is already visible in this session; do not make the user repeat what is on screen:

- What the user was doing and the symptom they hit.
- Error messages, stack traces, failing assertions, console and network output.
- IDs, verbatim: agent-run or session UUIDs, request IDs, version, build and host identifiers, above all any ID the project's own tooling (a log-fetching skill, a dashboard) can later resolve into full logs or transcripts.
- `file:line` pointers where the symptom surfaces (a location, not a root-cause claim).
- Environment facts, collected yourself: `git rev-parse --short HEAD`, `git branch --show-current`, and `git status --short` (uncommitted changes affect reproducibility).

## 2. Ask only for the gaps

Only if these reproduction essentials are still missing, ask concisely (`AskUserQuestion` when it fits): the exact steps in order, expected versus actual behavior, reproducibility (always, intermittent, saw it once), and the minimal preconditions (which site, which account or data state). Ask the fewest questions that make it reproducible. Never ask for a cause or a fix.

## 3. Compose the issue

**Title**: a concise symptom, e.g. `Canvas: site node duplicates on rapid re-spawn`.

**Body**: fill this template, omitting a section only if genuinely N/A. Write it to a temp file and use `--body-file` to avoid shell-escaping backticks and markdown.

```
## Summary
<one line>

## Steps to reproduce
1. …
2. …

## Expected
<…>

## Actual
<…>

## Reproducibility
<always | intermittent | once>

## Evidence
- Errors / stack traces: <…>
- Logs / IDs: agent-run/session `<uuid>`, request `<id>`, … (name the tool that resolves each, if the project has one)
- Where it surfaces: `path/to/file.ts:NN`
- Screenshots / attachments: <…>

## Notes
<anything else relevant to reproducing — NOT a proposed fix>
```

## 4. File it

**Preferred: a GitHub issue via `gh`.** If `command -v gh` succeeds and `gh auth status` is OK:
`gh issue create -t "<title>" --type Bug --body-file <tmpfile>`
The native `Bug` issue type marks the standalone bug track: no milestone, no sub-issue link, no labels. Report the issue URL it prints.

**Fallback: a local file in `bugs/`** when `gh` is missing or not authed. Path: `bugs/$(date +%F)-<slug>.md`, where `<slug>` is the title lowercased with non-alphanumerics as `-` (e.g. `bugs/2026-06-22-canvas-site-node-duplicates.md`); create `bugs/` if missing. Contents: the title as an H1, then the same body template from step 3. Tell the user the path and that the report sits uncommitted in the working tree.

## Out of scope

No diagnosis, no fix, no patch. A strong hunch about the cause is at most a one-line pointer under Notes. The issue exists so the bug can be fixed later, by whoever picks it up.
