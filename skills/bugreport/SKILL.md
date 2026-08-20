---
name: bugreport
description: Capture a reproducible bug report from the current context. Use when the user wants to report, file, or log a bug. Focuses on how to reproduce — not how to fix.
disable-model-invocation: true
---

Turn an observed problem into a **durable, reproducible** report. The goal: someone with no access to this session can reproduce it later. **Capture how to reproduce — do not diagnose or propose a fix.**

Bug description: $ARGUMENTS

## 1. Gather from context (no questions yet)

Pull everything reproducible already visible in this session — don't make the user repeat what's on screen:

- What the user was doing and the symptom they hit.
- Error messages, stack traces, failing assertions, console / network output.
- IDs to capture **verbatim**: agent-run/session UUIDs, request IDs, version/build/host identifiers — above all any ID the project's own tooling (a log-fetching skill, a dashboard) can later resolve into full logs or transcripts.
- `file:line` pointers where the symptom surfaces (a location, not a root-cause claim).

Collect environment facts yourself — don't ask:

- `git rev-parse --short HEAD` and `git branch --show-current`
- `git status --short` — note uncommitted changes; they affect reproducibility.

## 2. Ask only for the gaps

If — and only if — these reproduction essentials are still missing, ask the user concisely (use `AskUserQuestion` when it fits):

- **Exact steps** to reproduce, in order.
- **Expected vs. actual** behavior.
- **Reproducibility**: always / intermittent / saw it once.
- Minimal preconditions: which site, which account/data state.

Ask the fewest questions that make it reproducible. Never ask for a cause or a fix.

## 3. Compose the issue

**Title** — concise symptom, e.g. `Canvas: site node duplicates on rapid re-spawn`.

**Body** — fill this template; omit a section only if genuinely N/A. Write it to a temp file and use `--body-file` to avoid shell-escaping issues with backticks/markdown.

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

**Preferred — GitHub issue via `gh`.** If `command -v gh` succeeds and `gh auth status` is OK:
   `gh issue create -t "<title>" --type Bug --body-file <tmpfile>`
   The native `Bug` issue type marks the standalone bug track — no milestone, no sub-issue link, no labels. Report the issue URL it prints.

**Fallback — local file in `bugs/` (no `gh`, or `gh` not authed).** Save the report into the repo so it's durable and committable; nothing else required:
   - Path: `bugs/$(date +%F)-<slug>.md`, where `<slug>` is the title lowercased, non-alphanumerics → `-` (e.g. `bugs/2026-06-22-canvas-site-node-duplicates.md`). Create `bugs/` if missing.
   - Contents: the title as an H1, then the same body template from step 3:
     ```
     # <title>

     <full markdown body>
     ```
   - Tell the user the path and that it's a bug report sitting in the working tree.

## Out of scope

No diagnosis, no fix, no patch. If you have a strong hunch about the cause, put at most a one-line pointer under **Notes**. The issue exists so the bug can be fixed *later*, by whoever picks it up.
