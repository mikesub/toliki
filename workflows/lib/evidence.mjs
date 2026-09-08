// Orchestrator-captured evidence for model prompts.
//
// A model step is asked for judgment, never for retrieval. Everything a step's
// brief is KNOWN to need — the issue body a change was built against, the diff
// under repair, the commits and both sides of a conflict, a failing job's log —
// is captured HERE, before the call, and pasted into the prompt as bytes.
// Three reasons, in the order they cost a run:
//   1. a judging step has no shell under Claude and only a read-only sandbox
//      under Codex, so evidence it was told to fetch is evidence nothing proved
//      it received — and a step that silently got nothing still answers;
//   2. a builder and the blind checker that later judges it have to read the
//      SAME bytes, or the checker refutes a repair made against something else;
//   3. every `gh` or `git` call inside a model turn is one more place a run can
//      proceed on an empty answer that nothing in the orchestrator can see.
//
// Source EXPLORATION is deliberately untouched: a writable step still reads and
// greps the working tree, and a judging step still uses its read-only tools for
// surrounding context. What moves in here is the fixed list of inputs the
// orchestrator already knows how to fetch.
//
// Capture failure is reported, never hidden. A diff is the thing being judged,
// so its callers fail closed on a null capture. An issue body is context around
// it, so an unreadable one says so inside the prompt — exactly as a failing
// job's log already does — rather than rendering as an issue with nothing in it.

import { issueView } from './github.mjs'

// One shape for every captured artifact, so a prompt reads the same whether the
// bytes came from git, gh or a project's own gate. `missing` is spelled out
// rather than left empty: a blank block is indistinguishable from a real empty
// diff, and one of those two is a reason to stop.
export const evidenceBlock = (tag, body, missing = `(no ${tag} could be captured)`) =>
  `<${tag}>\n${String(body ?? '').trim() || missing}\n</${tag}>`

// An issue body is the durable intent record behind a change — what a PR set
// out to do, or what a commit that landed on main meant. Best effort by
// contract: the caller gets a record that knows whether it was captured.
export async function captureIssueRecord(issue, opts) {
  try {
    const view = await issueView(issue, 'title,body', opts)
    return {
      issue: Number(issue),
      title: String(view?.title || '').trim(),
      body: String(view?.body || '').trim(),
      captured: true,
    }
  } catch (error) {
    return { issue: Number(issue), title: '', body: '', captured: false, error: error?.message || String(error) }
  }
}

export const captureIssueRecords = (issues, opts) =>
  Promise.all([...new Set(issues.map(Number))].map(issue => captureIssueRecord(issue, opts)))

// A record that could not be read says so where the model reads it. Silence
// there would be read as an issue that says nothing about its own intent, which
// is the one conclusion the failure does not support.
export const renderIssueRecord = record => record?.captured
  ? `Issue #${record.issue}: ${record.title || '(no title)'}\n${record.body || '(empty body)'}`
  : `Issue #${record?.issue}: could not be read (${record?.error || 'unknown error'}) — its intent is unknown, not empty.`

export const renderIssueRecords = records => (Array.isArray(records) && records.length
  ? records.map(renderIssueRecord).join('\n\n')
  : '')
