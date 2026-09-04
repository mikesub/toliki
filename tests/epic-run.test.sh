#!/usr/bin/env bash
set -uo pipefail

# Exercises workflows/epic-run.mjs and its three fixer orchestrators end to end. The
# orchestrator's own git runs for real against a throwaway bare origin under
# mktemp; `gh` and `npm` are stubs on PATH; the model steps are a stub engine
# that answers each prompt with a fixture keyed by a marker in the prompt and
# can run a side-effect script (what the real step would have written to the
# tree). Nothing here touches the network, a real clone, or a live tmux server.
#
# Both the Claude and Codex adapters are exercised: the codex stub translates
# the test envelope into Codex's --output-last-message contract. The stubs' argv
# logs are what let the suite assert the model tiering and agent charters —
# invisible in production until they bill — and the origin plus the gh stub's
# label state are what let it assert what the run actually did.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EPIC_RUN="$ROOT/workflows/epic-run.mjs"
FIX_RUN="$ROOT/workflows/fix-run.mjs"
CI_RUN="$ROOT/workflows/ci-run.mjs"
DEFECT_RUN="$ROOT/workflows/defect-run.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_rc() { # name want got
  if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want rc $2, got $3)"; fi
}
assert_contains() { # name haystack needle
  if [[ "$2" == *"$3"* ]]; then ok "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"
    printf '%s\n' "$2" | tail -n 12 | sed 's/^/       | /'
  fi
}
assert_not_contains() { # name haystack needle
  if [[ "$2" != *"$3"* ]]; then ok "$1"; else nok "$1 (unexpectedly present: $3)"; fi
}
assert_eq() { # name want got
  if [[ "$2" == "$3" ]]; then ok "$1"; else nok "$1 (want '$2', got '$3')"; fi
}

# ───────────────────────── a throwaway project on a bare origin ─────────────────────────
# One package declaring scripts.verify, .epics/ ignored, an AGENTS.md (the
# Codex adapter fails closed without one). Every run gets a fresh clone; every
# scenario starts from this pristine main with no epic branches.
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
ORIGIN="$TMP/origin.git"
git init -q --bare "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
SEED="$TMP/seed"
git init -q -b main "$SEED"
mkdir -p "$SEED/frontend/src"
printf '{"name":"frontend","scripts":{"verify":"true"}}\n' > "$SEED/frontend/package.json"
printf '{}\n' > "$SEED/frontend/package-lock.json"
printf 'export const items = []\n' > "$SEED/frontend/src/index.ts"
printf '.epics/\nnode_modules/\n' > "$SEED/.gitignore"
printf '# app\n' > "$SEED/README.md"
printf '# Stub project instructions\n' > "$SEED/AGENTS.md"
git -C "$SEED" add -A && git -C "$SEED" commit -qm 'initial'
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push -q origin main
MAIN_INITIAL="$(git -C "$SEED" rev-parse HEAD)"

reset_origin() {
  git -C "$ORIGIN" update-ref refs/heads/main "$MAIN_INITIAL"
  local ref
  for ref in $(git -C "$ORIGIN" for-each-ref --format='%(refname)' refs/heads/); do
    [[ "$ref" == refs/heads/main ]] || git -C "$ORIGIN" update-ref -d "$ref"
  done
  rm -f "$ORIGIN/hooks/pre-receive"
}
fresh_clone() { # -> path; detached at origin/main, like launch.sh's worktree
  local dir="$TMP/run-$RANDOM$RANDOM"
  git clone -q "$ORIGIN" "$dir"
  git -C "$dir" checkout -q --detach main
  printf '%s' "$dir"
}
origin_ref() { git -C "$ORIGIN" rev-parse -q --verify "refs/heads/$1" 2>/dev/null || true; }
origin_count() { git -C "$ORIGIN" rev-list --count "main..$1" 2>/dev/null || echo '?'; }
# Seed origin with a branch built by a helper clone: seed_branch <branch> <base> <script>
# A counter, not $RANDOM: a suite this long draws the same number twice, and a
# collided clone path fails the seed with the scenario's assertions still armed.
SEED_N=0
seed_branch() {
  local branch="$1" base="$2" script="$3"
  SEED_N=$((SEED_N + 1))
  local dir="$TMP/seeder-$SEED_N"
  rm -rf "$dir"
  git clone -q "$ORIGIN" "$dir"
  git -C "$dir" switch -q -c "$branch" "origin/$base"
  (cd "$dir" && bash -c "$script")
  git -C "$dir" push -q origin "HEAD:refs/heads/$branch"
  rm -rf "$dir"
}
scenario() { printf '\n%s\n' "$1"; reset_origin; }

# ───────────────────────── the stub engine ─────────────────────────
# Keys a fixture off the step label the runtime exports as EPIC_STEP_LABEL
# (never off prompt wording, so a prompt can be rephrased without touching a
# test), saves the prompt it was fed (read from stdin, exactly as the adapter
# feeds a real CLI) for the content assertions, counts calls per key so a
# scenario can make the first attempt fail and the second succeed, runs a
# side-effect script when the fixture set carries one (<key>.sh — the files a
# real step would have written to the worktree), and logs its own argv so the
# tiering assertions have something to read.
mkdir -p "$TMP/bin"
cat > "$TMP/bin/claude" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
# One line per call: the charter arrives via --append-system-prompt and is
# multi-line, so squeeze whitespace or a single call would span many lines and
# break every assertion that greps this log.
printf '%s\n' "$*" | tr '\n' ' ' | tr -s ' ' >> "$STUB_LOG"
printf '\n' >> "$STUB_LOG"
prompt="$(cat)"

key=unknown
case "${EPIC_STEP_LABEL:-}" in
  architect:design)                            key=design ;;
  code:red|code:red:retry)                     key=red ;;
  code:green|code:green:retry)                 key=green ;;
  review:0)                                    key=lens-correctness ;;
  review:1)                                    key=lens-simplicity ;;
  review:2)                                    key=lens-seam ;;
  review:3)                                    key=lens-acceptance ;;
  review:4)                                    key=lens-security ;;
  verify:*)                                    key=verify ;;
  fix-check)                                   key=fixcheck ;;
  deferral-check)                              key=defercheck ;;
  fixes-after-review|fixes-after-review:retry) key=triage ;;
  ship:pr)                                     key=ship ;;
  summary:write)                               key=summary ;;
  resolve)                                     key=fix-resolve ;;
  check)                                       key=fix-check ;;
  fix-ci)                                      key=ci-fix ;;
  ci-check)                                    key=ci-check ;;
  fix-defect)                                  key=defect-fix ;;
  defect-check)                                key=defect-check ;;
esac

n="$(cat "$STUB_STATE/$key.n" 2>/dev/null || echo 0)"
printf '%s' "$((n + 1))" > "$STUB_STATE/$key.n"
printf '%s' "$prompt" > "$STUB_STATE/$key.$n.prompt"

if [[ -f "$STUB_FIXTURES/$key.$n.sleep" ]]; then sleep "$(cat "$STUB_FIXTURES/$key.$n.sleep")"; fi
if [[ -f "$STUB_FIXTURES/$key.$n.rc" ]]; then exit "$(cat "$STUB_FIXTURES/$key.$n.rc")"; fi
for f in "$STUB_FIXTURES/$key.$n.sh" "$STUB_FIXTURES/$key.sh"; do
  if [[ -f "$f" ]]; then bash "$f"; break; fi
done
for f in "$STUB_FIXTURES/$key.$n.json" "$STUB_FIXTURES/$key.json"; do
  if [[ -f "$f" ]]; then cat "$f"; exit 0; fi
done
printf 'stub: no fixture for key %s (call %s)\n' "$key" "$n" >&2
exit 9
STUB
chmod +x "$TMP/bin/claude"

# Codex stub: records its own argv, then reuses the fixture router above and
# translates Claude's test envelope into Codex's --output-last-message file.
# This gives the whole orchestrator a second-engine run without duplicating the
# prompt-to-fixture table.
cat > "$TMP/bin/codex" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
# One write per call: five lenses run in parallel and append to the same log,
# so a two-write line would interleave and undercount.
printf '%s\n' "$(printf '%s' "$*" | tr '\n' ' ' | tr -s ' ')" >> "$STUB_CODEX_LOG"
out=""
schema=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output-last-message) out="$2"; shift 2 ;;
    --output-schema) schema="$2"; shift 2 ;;
    *) shift ;;
  esac
done
prompt="$(cat)"
set +e
payload="$(printf '%s' "$prompt" | STUB_LOG=/dev/null "$STUB_CLAUDE")"
rc=$?
set -e
(( rc == 0 )) || exit "$rc"
printf '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":300,"cache_write_input_tokens":0,"output_tokens":234,"reasoning_output_tokens":100}}\n'
if [[ -n "$schema" ]]; then
  printf '%s' "$payload" | jq -c '.structured_output' > "$out"
else
  printf '%s' "$payload" | jq -r '.result' > "$out"
fi
STUB
chmod +x "$TMP/bin/codex"

# gh stub: answers the reads the orchestrator makes from a per-run label file
# and a few scenario knobs (GH_ISSUE_STATE, GH_ISSUE_LABELS, GH_BLOCKED_BY,
# GH_OPEN_PR_BRANCH), records label edits, comments, created issues and PRs,
# and logs argv. A comment prints the URL the status comment keys its edits on.
cat > "$TMP/bin/gh" <<'STUB'
#!/usr/bin/env bash
set -uo pipefail
printf '%s\n' "$*" >> "${STUB_GH_LOG:-/dev/null}"
state="$STUB_GH_STATE"
labels="$state/labels"
[[ -f "$labels" ]] || printf '%s\n' "${GH_ISSUE_LABELS:-}" | tr ',' '\n' | sed '/^$/d' > "$labels"
labels_json() { jq -R -s -c 'split("\n") | map(select(length > 0)) | map({name: .})' "$labels"; }
# Labels are per issue: the run's own issue keeps $labels, and any other issue
# ship touches (a follow-up it files and queues) gets its own file. One shared
# file would let a follow-up's `ready` read back as the epic issue's own label.
labels_for() { [[ "$1" == "${GH_RUN_ISSUE:-42}" ]] && printf '%s' "$labels" || printf '%s' "$state/labels-$1"; }
case "${1:-} ${2:-}" in
  "issue view")
    # The deferred-record probe reads comments; they are stored as blocks
    # separated by a lone --- line, exactly as the comment case writes them.
    if [[ "$*" == *comments* ]]; then
      if [[ "${GH_EVIDENCE_READ_FAIL:-}" == "1" ]] && grep -q '^🤖 defect-fix evidence$' "$state/comments" 2>/dev/null; then
        printf 'HTTP 502\n' >&2
        exit 1
      fi
      if [[ -s "$state/comments" ]]; then
        authors="$(jq -cn --arg raw "${GH_SEED_COMMENT_AUTHORS:-}" '$raw | split(",") | map(select(length > 0))')"
        jq -R -s --argjson authors "$authors" --arg login "${GH_AUTH_LOGIN:-toliki-bot}" \
          'split("\n---\n") | map(select(length > 0)) | to_entries | map({body: .value, author: {login: ($authors[.key] // $login)}}) | {comments: .}' < "$state/comments"
      else
        printf '{"comments":[]}\n'
      fi
      exit 0
    fi
    if [[ "$*" == *"--json labels"* ]]; then
      n="$(cat "$state/label-reads" 2>/dev/null || echo 0)"; n=$((n + 1)); printf '%s' "$n" > "$state/label-reads"
      if [[ "$n" == "${GH_LABEL_READ_FAIL_AT:-}" ]]; then printf 'HTTP 502\n' >&2; exit 1; fi
    fi
    printf '{"number":%s,"title":"Add widget","body":%s,"state":"%s","labels":%s}\n' "${3:-0}" "$(printf '%s' "${GH_ISSUE_BODY:-Build a widget.}" | jq -Rs .)" "${GH_ISSUE_STATE:-OPEN}" "$(labels_json)" ;;
  "issue edit")
    target="$(labels_for "${3:-}")"
    touch "$target"
    shift 3
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --add-label)
          if [[ "$2" != "${GH_DROP_LABEL:-}" ]]; then
            grep -qx -- "$2" "$target" || printf '%s\n' "$2" >> "$target"
          fi
          shift 2 ;;
        --remove-label) grep -vx -- "$2" "$target" > "$target.tmp" || true; mv "$target.tmp" "$target"; shift 2 ;;
        *) shift ;;
      esac
    done ;;
  "issue comment")
    shift 3; body=""; body_file=0
    while [[ $# -gt 0 ]]; do
      case "$1" in --body-file) body="$(cat "$2")"; body_file=1; shift 2 ;; --body) body="$2"; shift 2 ;; *) shift ;; esac
    done
    if [[ "${GH_BODY_FILE_COMMENT_FAIL:-}" == "1" && "$body_file" == "1" ]] || \
       [[ "${GH_EVIDENCE_COMMENT_FAIL:-}" == "1" && "$body" == '🤖 defect-fix evidence'* ]]; then
      printf 'HTTP 502\n' >&2
      exit 1
    fi
    printf '%s\n---\n' "$body" >> "$state/comments"
    printf 'https://github.com/o/r/issues/42#issuecomment-999001\n' ;;
  "issue create")
    shift 2; title=""; body=""
    while [[ $# -gt 0 ]]; do
      case "$1" in --title) title="$2"; shift 2 ;; --body-file) body="$(cat "$2")"; shift 2 ;; *) shift ;; esac
    done
    printf 'TITLE: %s\n%s\n---\n' "$title" "$body" >> "$state/issues-created"
    printf 'https://github.com/o/r/issues/%s\n' "$(( 100 + $(grep -c '^---$' "$state/issues-created") ))" ;;
  "pr list")
    if [[ "$*" == *--search* || -z "${GH_OPEN_PR_BRANCH:-}" ]]; then printf '[]\n'; else
      sha="${GH_PR_HEAD:-$(git -C "$STUB_ORIGIN" rev-parse -q --verify "refs/heads/$GH_OPEN_PR_BRANCH" 2>/dev/null || echo missing)}"
      # statusCheckRollup mirrors what the merge worker reads: GH_RED_CHECKS is a
      # comma-separated list of failing check names, empty for an all-green PR.
      # printf with the trailing newline, or `read` drops the last name.
      rollup="$(printf '%s\n' "${GH_RED_CHECKS:-}" | tr ',' '\n' | sed '/^$/d' | while IFS= read -r c; do
        printf '{"__typename":"CheckRun","name":"%s","status":"COMPLETED","conclusion":"FAILURE","detailsUrl":"https://github.com/o/r/actions/runs/555/job/1"},' "$c"
      done)"
      if [[ "${GH_ONLY_FORK_PR:-}" == "1" ]]; then
        printf '[{"number":8,"url":"https://github.com/fork/r/pull/8","headRefName":"%s","headRefOid":"%s","isCrossRepository":true,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"fork"},"statusCheckRollup":[]}]\n' "$GH_OPEN_PR_BRANCH" "$sha"
      elif [[ "${GH_FORK_PR:-}" == "1" ]]; then
        printf '[{"number":7,"url":"https://github.com/o/r/pull/7","headRefName":"%s","headRefOid":"%s","isCrossRepository":false,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"o"},"statusCheckRollup":[]},{"number":8,"url":"https://github.com/fork/r/pull/8","headRefName":"%s","headRefOid":"%s","isCrossRepository":true,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"fork"},"statusCheckRollup":[]}]\n' "$GH_OPEN_PR_BRANCH" "$sha" "$GH_OPEN_PR_BRANCH" "$sha"
      elif [[ "${GH_OPEN_PR_COUNT:-1}" == "2" ]]; then
        printf '[{"number":7,"url":"https://github.com/o/r/pull/7","headRefName":"%s","headRefOid":"%s","isCrossRepository":false,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"o"},"statusCheckRollup":[]},{"number":8,"url":"https://github.com/o/r/pull/8","headRefName":"epic/42-other","headRefOid":"%s","isCrossRepository":false,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"o"},"statusCheckRollup":[]}]\n' "$GH_OPEN_PR_BRANCH" "$sha" "$sha"
      else
        printf '[{"number":7,"url":"https://github.com/o/r/pull/7","headRefName":"%s","headRefOid":"%s","isCrossRepository":false,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"o"},"statusCheckRollup":[%s{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"SUCCESS"}]}]\n' "$GH_OPEN_PR_BRANCH" "$sha" "$rollup"
      fi
    fi ;;
  "pr view")
    sha="${GH_POST_PUSH_PR_HEAD:-$(git -C "$STUB_ORIGIN" rev-parse -q --verify "refs/heads/${GH_OPEN_PR_BRANCH:-missing}" 2>/dev/null || echo missing)}"
    printf '{"number":7,"headRefName":"%s","headRefOid":"%s","isCrossRepository":false,"headRepository":{"name":"r"},"headRepositoryOwner":{"login":"o"}}\n' "${GH_OPEN_PR_BRANCH:-}" "$sha" ;;
  "repo view") printf '{"nameWithOwner":"o/r"}\n' ;;
  "run view")
    printf '%s\n' "${GH_JOB_LOG:-FAIL src/widget.test.ts: expected createWidget to be exported}" ;;
  "pr create")
    printf '%s\n' "$*" >> "$state/pr-created"
    printf 'https://github.com/o/r/pull/7\n' ;;
  "api "*)
    if [[ "$*" == "api user"* ]]; then
      printf '{"login":"%s"}\n' "${GH_AUTH_LOGIN:-toliki-bot}"
    elif [[ "$*" == *"--method POST"* && "$*" == *dependencies/blocked_by* ]]; then
      # Ship ordering a follow-up behind the epic's own issue. Records
      # "<follow-up> <blocker id>" so a scenario can assert what was linked.
      [[ "${GH_DEP_WRITE_FAIL:-}" != "1" ]] || { printf 'HTTP 422\n' >&2; exit 1; }
      dep_n="$(printf '%s' "$*" | sed -n 's|.*/issues/\([0-9]*\)/dependencies.*|\1|p')"
      dep_id="$(printf '%s' "$*" | sed -n 's|.*issue_id=\([0-9]*\).*|\1|p')"
      printf '%s %s\n' "$dep_n" "$dep_id" >> "$state/deps-created"
      printf '{"number":%s}\n' "${dep_n:-0}"
    elif [[ "$*" == *dependencies/blocked_by* ]]; then
      [[ "${GH_DEPS_FAIL:-}" != "1" ]] || { printf 'HTTP 502\n' >&2; exit 1; }
      printf '%s\n' "${GH_BLOCKED_BY:-[]}"
    elif [[ "$*" == *"--jq .id"* ]]; then
      # The epic issue's database id, which the dependency API takes.
      [[ "${GH_ISSUE_ID_FAIL:-}" != "1" ]] || { printf 'HTTP 404\n' >&2; exit 1; }
      printf '%s\n' "${GH_ISSUE_ID:-900042}"
    else
      # The status comment's edit. Slow on demand, so a scenario can have one
      # in flight when the run finishes.
      [[ "${GH_SLOW_PATCH:-}" != "1" ]] || sleep 1
      printf '{}\n'
    fi ;;
  *) : ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/gh"

# npm stub: `ci` makes node_modules appear, `run verify` passes unless the
# fixture set carries verify.rc. Logs argv.
cat > "$TMP/bin/npm" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${STUB_NPM_LOG:-/dev/null}"
case "$*" in
  ci) mkdir -p node_modules; exit 0 ;;
  "run verify")
    if [[ -f "${STUB_FIXTURES:-/nonexistent}/verify.rc" ]]; then
      printf 'verify: widget.test.ts expected 2 got 1\n' >&2
      exit "$(cat "$STUB_FIXTURES/verify.rc")"
    fi
    # Like a real test run against the stub project: red exactly while a test
    # exists without its implementation (red wrote widget.test.ts, green has
    # not yet written widget.ts).
    if [[ -f src/widget.test.ts && ! -f src/widget.ts ]]; then
      printf 'FAIL src/widget.test.ts: missing export createWidget\n' >&2
      exit 1
    fi
    printf 'verify ok\n'; exit 0 ;;
esac
exit 0
STUB
chmod +x "$TMP/bin/npm"

# ───────────────────────── ensureDeps: no lockfile means nothing to install ─────────────────────────
# Unit-level, not a full pipeline run: repo.mjs's own contract, exercised
# directly against throwaway directories rather than the shared seed project.
cat > "$TMP/dep-check.mjs" <<'NODE'
const { ensureDeps } = await import(process.env.REPO_MODULE)
process.chdir(process.env.DEP_DIR)
console.log(JSON.stringify(await ensureDeps(['.'])))
NODE

# A Bun-only package: scripts.verify shells out to bun test, no
# package-lock.json anywhere. npm ci requires one by contract and can never
# succeed without it, so it must be skipped rather than attempted and blocked
# (this is the exact shape of purplehills#1's prepare failure on 2026-09-04).
BUN_DIR="$TMP/dep-bun-only"; mkdir -p "$BUN_DIR"
printf '{"name":"b","scripts":{"verify":"bun test"}}\n' > "$BUN_DIR/package.json"
NPM_LOG_BUN="$TMP/npm-bun.log"; : > "$NPM_LOG_BUN"
OUT="$(PATH="$TMP/bin:$PATH" REPO_MODULE="$ROOT/workflows/lib/repo.mjs" DEP_DIR="$BUN_DIR" STUB_NPM_LOG="$NPM_LOG_BUN" node "$TMP/dep-check.mjs")"
assert_contains "a package with no lockfile is reported as nothing to install" "$OUT" "no package-lock.json, nothing to install"
assert_eq "npm is never invoked for a lockfile-less package" "0" "$(wc -l < "$NPM_LOG_BUN" | tr -d ' ')"

# A real npm package with a lockfile and no node_modules yet still gets npm ci.
NPM_DIR="$TMP/dep-npm"; mkdir -p "$NPM_DIR"
printf '{"name":"n","scripts":{"verify":"true"}}\n' > "$NPM_DIR/package.json"
printf '{}\n' > "$NPM_DIR/package-lock.json"
NPM_LOG_REAL="$TMP/npm-real.log"; : > "$NPM_LOG_REAL"
OUT="$(PATH="$TMP/bin:$PATH" REPO_MODULE="$ROOT/workflows/lib/repo.mjs" DEP_DIR="$NPM_DIR" STUB_NPM_LOG="$NPM_LOG_REAL" node "$TMP/dep-check.mjs")"
assert_contains "a package with a lockfile still gets npm ci when node_modules is missing" "$OUT" "npm ci (node_modules missing)"
assert_eq "npm ci ran once for the lockfile-carrying package" "1" "$(grep -c '^ci$' "$NPM_LOG_REAL")"

# A success envelope carrying structured output, exactly the shape the CLI's
# own result schema describes (see lib/engine.mjs).
USAGE='"duration_ms":1200,"num_turns":3,"total_cost_usd":0.05,"usage":{"input_tokens":1000,"output_tokens":200,"cache_read_input_tokens":300,"cache_creation_input_tokens":100}'
fixture() { # dir key structured-json
  printf '{"type":"result","subtype":"success","is_error":false,"result":"ok",%s,"structured_output":%s}\n' "$USAGE" "$3" > "$1/$2.json"
}
# A success envelope with no structured output — what a schema-less step returns.
fixture_text() { # dir key text
  printf '{"type":"result","subtype":"success","is_error":false,%s,"result":"%s"}\n' "$USAGE" "$3" > "$1/$2.json"
}
# A provider-side refusal. Claude currently calls its subtype "success" even
# with is_error:true, so the adapter must use terminal_reason/api_error_status
# and preserve result, where the reset window is reported.
fixture_error() { # dir key api-error-result
  printf '%s\n' "$3" > "$1/$2.json"
}
# What a step would have written to the worktree.
fixture_sh() { # dir key script
  printf '%s\n' "$3" > "$1/$2.sh"
}

# ───────────────────────── the happy-path fixture set ─────────────────────────
BASE="$TMP/fixtures-base"
mkdir -p "$BASE"
fixture "$BASE" design '{"approach":"Thin widget module","rationale":"Fits the existing shape.","steps":["one","two"],"files":["src/widget.ts — new"],"contract":"createWidget(): Widget","tradeoffs":"No caching."}'
fixture_text "$BASE" red "wrote widget.test.ts; fails on missing export"
fixture_sh "$BASE" red 'printf "test(\"widget\", () => {})\n" > frontend/src/widget.test.ts'
fixture_text "$BASE" green "frontend verified green"
fixture_sh "$BASE" green 'printf "export const createWidget = () => ({})\n" > frontend/src/widget.ts'
for lens in lens-simplicity lens-seam lens-acceptance lens-security; do
  fixture "$BASE" "$lens" '{"findings":[]}'
done
fixture "$BASE" lens-correctness '{"findings":[{"title":"Null deref on empty list","severity":"Critical","confidence":90,"location":"src/widget.ts:12","problem":"Crashes when items is empty.","fix":"Guard the access.","gate":"unit test for the empty case"}]}'
fixture "$BASE" verify '{"verdicts":[{"index":1,"real":true,"confidence":90,"reasoning":"Confirmed against the code."}]}'
fixture "$BASE" triage '{"status":"Fixed the null deref, verify green.","deferred":[]}'
fixture_sh "$BASE" triage 'printf "export const createWidget = () => ({ items: [] })\n" > frontend/src/widget.ts'
fixture "$BASE" fixcheck '{"verdicts":[{"index":1,"resolved":true,"confidence":92,"reasoning":"The guard is in place and the empty case is tested."}],"regressions":[]}'
fixture "$BASE" ship '{"title":"Add widget","body":"Adds a widget.\n\n## Review\n\nOne finding fixed.","commitBody":"Thin module, no caching.","deferred":[]}'

# ───────────────────────── the runner ─────────────────────────
RUN_OUT=""
RUN_RC=0
RUN_LOG=""
WT=""
run_pipeline() { # script fixtures-dir args...   (scenario knobs via GH_* env)
  local script="$1" fixtures="$2"; shift 2
  local state="$TMP/state.$RANDOM$RANDOM"
  RUN_LOG="$TMP/argv.$RANDOM$RANDOM"
  CODEX_LOG="$TMP/codex-argv.$RANDOM$RANDOM"
  GH_LOG="$TMP/gh.$RANDOM$RANDOM"
  NPM_LOG="$TMP/npm.$RANDOM$RANDOM"
  mkdir -p "$state/gh"
  # A scenario can put comments on the issue before the run, the way a previous
  # attempt would have left them.
  [[ -z "${SEED_COMMENTS:-}" ]] || printf '%s\n---\n' "$SEED_COMMENTS" > "$state/gh/comments"
  : > "$RUN_LOG"; : > "$CODEX_LOG"; : > "$GH_LOG"; : > "$NPM_LOG"
  WT="$(fresh_clone)"
  RUN_RC=0
  RUN_OUT="$(
    cd "$WT" && \
    PATH="$TMP/bin:$PATH" \
    CLAUDE_BIN="$TMP/bin/claude" \
    CODEX_BIN="$TMP/bin/codex" \
    STUB_CLAUDE="$TMP/bin/claude" \
    STUB_CODEX_LOG="$CODEX_LOG" \
    STUB_FIXTURES="$fixtures" \
    STUB_STATE="$state" \
    STUB_LOG="$RUN_LOG" \
    STUB_GH_LOG="$GH_LOG" \
    STUB_GH_STATE="$state/gh" \
    STUB_ORIGIN="$ORIGIN" \
    STUB_NPM_LOG="$NPM_LOG" \
    GH_ISSUE_STATE="${GH_ISSUE_STATE:-OPEN}" \
    GH_ISSUE_LABELS="${GH_ISSUE_LABELS:-ready}" \
    GH_BLOCKED_BY="${GH_BLOCKED_BY:-[]}" \
    GH_OPEN_PR_BRANCH="${GH_OPEN_PR_BRANCH:-}" \
    GH_OPEN_PR_COUNT="${GH_OPEN_PR_COUNT:-}" \
    GH_PR_HEAD="${GH_PR_HEAD:-}" \
    GH_POST_PUSH_PR_HEAD="${GH_POST_PUSH_PR_HEAD:-}" \
    GH_FORK_PR="${GH_FORK_PR:-}" \
    GH_ONLY_FORK_PR="${GH_ONLY_FORK_PR:-}" \
    GH_DROP_LABEL="${GH_DROP_LABEL:-}" \
    GH_LABEL_READ_FAIL_AT="${GH_LABEL_READ_FAIL_AT:-}" \
    GH_BODY_FILE_COMMENT_FAIL="${GH_BODY_FILE_COMMENT_FAIL:-}" \
    GH_EVIDENCE_COMMENT_FAIL="${GH_EVIDENCE_COMMENT_FAIL:-}" \
    GH_EVIDENCE_READ_FAIL="${GH_EVIDENCE_READ_FAIL:-}" \
    GH_AUTH_LOGIN="${GH_AUTH_LOGIN:-}" \
    GH_SEED_COMMENT_AUTHORS="${GH_SEED_COMMENT_AUTHORS:-}" \
    GH_ISSUE_BODY="${GH_ISSUE_BODY:-}" \
    GH_RED_CHECKS="${GH_RED_CHECKS:-}" \
    GH_DEPS_FAIL="${GH_DEPS_FAIL:-}" \
    GH_SLOW_PATCH="${GH_SLOW_PATCH:-}" \
    GH_JOB_LOG="${GH_JOB_LOG:-}" \
    EPIC_USAGE_LOG="$state/usage.jsonl" \
    node "$script" "$@" 2>&1
  )" || RUN_RC=$?
  STATE_DIR="$state"
}
calls() { cat "$STATE_DIR/$1.n" 2>/dev/null || echo 0; }
usage_log() { cat "$STATE_DIR/usage.jsonl" 2>/dev/null || true; }
gh_labels() { sort "$STATE_DIR/gh/labels" 2>/dev/null | tr '\n' ',' ; }
gh_comments() { cat "$STATE_DIR/gh/comments" 2>/dev/null || true; }
gh_issues_created() { cat "$STATE_DIR/gh/issues-created" 2>/dev/null || true; }
gh_pr_created() { cat "$STATE_DIR/gh/pr-created" 2>/dev/null || true; }

# ───────────────────────── epic-run ─────────────────────────
scenario 'epic-run: happy path ships and queues for merge'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT says readyToMerge" "$RUN_OUT" '"readyToMerge":true'
assert_not_contains "a clear gate never advertises defect repair" "$RUN_OUT" '"needsDefectFix":true'
assert_contains "RESULT carries the PR url" "$RUN_OUT" '"prUrl":"https://github.com/o/r/pull/7"'
assert_contains "review tally reported" "$RUN_OUT" '1 confirmed by adversarial verification, 0 refuted'
assert_eq "exactly the twelve model steps ran" 12 "$(wc -l < "$RUN_LOG" | tr -d ' ')"
assert_eq "the fixes were checked once" 1 "$(calls fixcheck)"
assert_eq "no deferrals, no deferral check" 0 "$(calls defercheck)"
assert_contains "the tally records the fix check" "$RUN_OUT" "fix check: 1/1 fixes confirmed, 0 regression(s)"
assert_contains "the fix check was handed the exact delta" "$(cat "$STATE_DIR/fixcheck.0.prompt")" "git diff "
assert_contains "review.md carries the post-fix section" "$(cat "$WT/.epics/42-add-widget/review.md")" "## Post-fix check"
# The usage log: one line per spawn, keyed by the engines.json step, never on GitHub.
assert_eq "one usage record per spawn" 12 "$(usage_log | wc -l | tr -d ' ')"
assert_eq "records name the engines.json steps" "architect:1 code:3 confirm-review:2 fixes-after-review:1 review:5" "$(usage_log | jq -r .step | sort | uniq -c | awk '{print $2":"$1}' | tr '\n' ' ' | sed 's/ $//')"
assert_eq "tokens are what the CLI reported, all four kinds summed" "1600" "$(usage_log | jq -r 'select(.label=="architect:design") | .tokens.total')"
assert_eq "cost and turns ride along" "0.05 3" "$(usage_log | jq -r 'select(.label=="architect:design") | "\(.costUsd) \(.turns)"')"
assert_eq "every record carries the run, issue and engine" "12" "$(usage_log | jq -r 'select(.issue==42 and .engine=="claude" and (.runId|length)>0) | .step' | wc -l | tr -d ' ')"
assert_not_contains "no usage went to GitHub" "$(cat "$GH_LOG")" "tokens"
REPORT="$(node "$ROOT/workflows/usage-report.mjs" --log "$STATE_DIR/usage.jsonl")"
assert_contains "the report groups by script" "$REPORT" "epic-run — 1 run(s): claude 1"
assert_contains "and shows the review lenses as the biggest share" "$REPORT" "review"
assert_contains "with percentages" "$REPORT" "41.7"
assert_eq "all five lenses ran" 5 "$(( $(calls lens-correctness) + $(calls lens-simplicity) + $(calls lens-seam) + $(calls lens-acceptance) + $(calls lens-security) ))"
# What the orchestrator did to the repo and the issue.
assert_eq "origin holds the branch as ONE commit above main" 1 "$(origin_count epic/42-add-widget)"
assert_eq "the squashed commit's subject is the PR title" "Add widget" "$(git -C "$ORIGIN" log -1 --format=%s epic/42-add-widget)"
assert_contains "the squashed commit closes the issue" "$(git -C "$ORIGIN" log -1 --format=%B epic/42-add-widget)" "Closes #42"
assert_contains "the commit body survived the squash" "$(git -C "$ORIGIN" log -1 --format=%B epic/42-add-widget)" "Thin module, no caching."
assert_contains "the fix landed in the squashed tree" "$(git -C "$ORIGIN" show epic/42-add-widget:frontend/src/widget.ts)" "items: []"
assert_contains "the red tests landed too" "$(git -C "$ORIGIN" ls-tree -r --name-only epic/42-add-widget)" "frontend/src/widget.test.ts"
assert_contains "the PR was opened on the branch with the title" "$(gh_pr_created)" "--head epic/42-add-widget --title Add widget"
assert_eq "the issue ends ready-to-merge and nothing else" "ready-to-merge," "$(gh_labels)"
assert_not_contains "no deferred record was posted" "$(gh_comments)" "deferred / not done"
assert_not_contains "no blocker was posted" "$(gh_comments)" "epic-run blocked"
assert_eq "deps were installed once for the discovered package" 1 "$(grep -c '^ci$' "$NPM_LOG")"
assert_eq "the orchestrator ran verify after red, green and the fixes" 3 "$(grep -c '^run verify$' "$NPM_LOG")"
assert_contains "the red gate saw red" "$RUN_OUT" "Code: red gate: verify RED"
assert_contains "the green gate saw green" "$RUN_OUT" "Code: verify gate: verify green"
assert_contains "the fixes gate saw green" "$RUN_OUT" "Fixes after review: verify gate: verify green"
assert_contains "summary.md is the PR body plus the Closes line" "$(cat "$WT/.epics/42-add-widget/summary.md")" "Closes #42"
assert_contains "architecture.md was rendered from the design" "$(cat "$WT/.epics/42-add-widget/architecture.md")" "Approach: Thin widget module"
assert_contains "review.md was rendered from the verdicts" "$(cat "$WT/.epics/42-add-widget/review.md")" "Null deref on empty list"
assert_contains "requirements.md carries the issue body verbatim" "$(cat "$WT/.epics/42-add-widget/requirements.md")" "Build a widget."
# Tiering and charters are invisible in production until they bill; assert them here.
ARGV="$(cat "$RUN_LOG")"
# Charters ride in as --append-system-prompt + an explicit --tools list, never
# --agent: measured 2026-08-20, --agent silently disables --json-schema, so
# every schema'd stage would come back as prose. The --agent check is the
# regression guard; asserting the tool lists is the safety property that flag
# used to provide.
assert_not_contains "no stage uses --agent (it would void --json-schema)" "$ARGV" "--agent "
assert_not_contains "nothing runs on the retired bookkeeping row" "$ARGV" "--model sonnet"
assert_contains "code is chartered as coder (Write/Edit allowed)" "$ARGV" "Bash,Glob,Grep,Read,Edit,Write,"
assert_contains "design runs the strong tier" "$ARGV" "--model fable"
assert_contains "the default tier is pinned to opus" "$ARGV" "--model opus"
assert_contains "every Claude phase runs at xhigh effort" "$ARGV" "--effort xhigh"
assert_contains "architect and reviewer cannot write" "$ARGV" "--tools Glob,Grep,Read,"
assert_contains "the reviewer charter reaches the model" "$ARGV" "Review code against project guidelines"
assert_contains "schemas are enforced by the engine" "$ARGV" "--json-schema"
assert_contains "permissions are pre-granted for autonomy" "$ARGV" "--dangerously-skip-permissions"
assert_contains "the review lens prompt still names its lens (routing did not rely on it)" "$(cat "$STATE_DIR/lens-security.0.prompt")" "security + authorization"

scenario 'epic-run: --engine codex routes every step to the Codex CLI'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42 --engine codex
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT says readyToMerge" "$RUN_OUT" '"readyToMerge":true'
CODEX_ARGV="$(cat "$CODEX_LOG")"
assert_contains "every phase runs at xhigh effort" "$CODEX_ARGV" 'model_reasoning_effort="xhigh"'
assert_contains "every phase uses Sol" "$CODEX_ARGV" "--model gpt-5.6-sol"
assert_not_contains "no phase falls to a cheaper Codex model" "$CODEX_ARGV" "gpt-5.6-luna"
assert_contains "hidden Codex fan-out is disabled" "$CODEX_ARGV" "--disable multi_agent --disable enable_fanout"
assert_contains "Codex runs are ephemeral" "$CODEX_ARGV" "--ephemeral"
assert_eq "all five Codex review lenses ran" 5 "$(( $(calls lens-correctness) + $(calls lens-simplicity) + $(calls lens-seam) + $(calls lens-acceptance) + $(calls lens-security) ))"
assert_eq "no Claude process was spawned" 0 "$(wc -l < "$RUN_LOG" | tr -d ' ')"
assert_eq "origin holds the squashed branch" 1 "$(origin_count epic/42-add-widget)"
assert_eq "Codex tokens are parsed from its event stream" "1234 1000 300 234" "$(usage_log | jq -r 'select(.label=="architect:design") | "\(.tokens.total) \(.tokens.input) \(.tokens.cacheRead) \(.tokens.output)"')"
# 700 fresh input at $4, 300 cached at $0.40, 234 output at $20, per 1M.
assert_eq "Codex records are priced from the table" "0.0076" "$(usage_log | jq -r 'select(.label=="architect:design") | .costUsd')"
assert_eq "and say the figure was computed, not billed" "table" "$(usage_log | jq -r 'select(.label=="architect:design") | .costSource')"

scenario 'epic-run: EPIC_ENGINE=codex routes every phase without a flag'
EPIC_ENGINE=codex run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the run ships" "$RUN_OUT" '"readyToMerge":true'
assert_contains "every phase went to Codex" "$(cat "$CODEX_LOG")" "--model gpt-5.6-sol"
assert_eq "no phase went to Claude directly" 0 "$(grep -c -- '--model' "$RUN_LOG" || true)"

scenario 'epic-run: an unknown EPIC_ENGINE is refused before any side effect'
EPIC_ENGINE=future run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "an unknown EPIC_ENGINE exits 1 (usage)" 1 "$RUN_RC"
assert_contains "and names the allowed engines" "$RUN_OUT" '--engine must be one of claude, codex'
assert_eq "no branch was claimed" "" "$(origin_ref epic/42-add-widget)"

scenario 'epic-run: codex+claude codes on Claude and reviews on Codex'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42 --engine codex+claude
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the run ships" "$RUN_OUT" '"readyToMerge":true'
assert_contains "review went to Codex" "$(cat "$CODEX_LOG")" 'model_reasoning_effort="xhigh"'
assert_eq "exactly the five lenses, the confirm batches and the fix check ran on Codex" "$(( 5 + $(calls verify) + $(calls fixcheck) ))" "$(grep -c -- '--model gpt-5.6-sol' "$CODEX_LOG" || true)"
assert_contains "coding stayed on Claude" "$(cat "$RUN_LOG")" "--model opus"
assert_contains "the architect stayed on Claude" "$(cat "$RUN_LOG")" "--model fable"
assert_contains "the pane names the vendor and model per step" "$RUN_OUT" "[codex gpt-5.6-sol/xhigh]"
# A mixed run's dollars come from two places: Claude bills itself, Codex is
# priced from lib/prices.mjs. The report has to say which is which, or a
# computed floor reads as an invoice.
assert_eq "Claude spawns carry the vendor's own figure" "cli" "$(usage_log | jq -r 'select(.vendor=="claude") | .costSource' | sort -u)"
assert_eq "Codex spawns are priced from the table" "table" "$(usage_log | jq -r 'select(.vendor=="codex") | .costSource' | sort -u)"
MIXED_REPORT="$(node "$ROOT/workflows/usage-report.mjs" --log "$STATE_DIR/usage.jsonl")"
assert_contains "the report separates the computed share" "$MIXED_REPORT" "priced from lib/prices.mjs"
assert_contains "and says it is not the vendor's number" "$MIXED_REPORT" "not billed by the vendor"

scenario 'epic-run: an engines file with a hole is refused before any side effect'
jq 'del(.claude.review)' "$ROOT/etc/engines.json" > "$TMP/engines-broken.json"
EPIC_ENGINES_FILE="$TMP/engines-broken.json" run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 1" 1 "$RUN_RC"
assert_contains "and names the hole" "$RUN_OUT" "has no entry for step 'review'"
assert_eq "no agent process was spawned" 0 "$(wc -l < "$RUN_LOG" | tr -d ' ')"
assert_eq "no GitHub call was made" 0 "$(wc -l < "$GH_LOG" | tr -d ' ')"
assert_eq "no branch was claimed" "" "$(origin_ref epic/42-add-widget)"

scenario 'epic-run: a closed issue is skipped before any side effect'
GH_ISSUE_STATE=CLOSED run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason names the state" "$RUN_OUT" 'issue #42 is closed'
assert_eq "no branch was claimed" "" "$(origin_ref epic/42-add-widget)"
assert_eq "nothing was designed" 0 "$(calls design)"

scenario 'epic-run: open blocked_by dependencies skip the issue'
GH_BLOCKED_BY='[{"number":41,"state":"open"},{"number":40,"state":"closed"}]' run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason names the open blocker only" "$RUN_OUT" 'blocked by open issue(s) #41'
assert_not_contains "a closed dependency does not block" "$RUN_OUT" '#40'
assert_eq "no branch was claimed" "" "$(origin_ref epic/42-add-widget)"

scenario 'epic-run: a dependency check that cannot be read is not a green gate'
GH_DEPS_FAIL=1 run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason says it refused to guess" "$RUN_OUT" 'dependency check could not be read'
assert_eq "no branch was claimed" "" "$(origin_ref epic/42-add-widget)"
assert_eq "nothing was designed" 0 "$(calls design)"

scenario 'epic-run: a failed fetch refuses rather than building on an unconfirmed base'
# The clone is handed a dead origin, so `git fetch origin` fails the way an
# unreachable or renamed remote would.
BROKEN_WT="$(fresh_clone)"
git -C "$BROKEN_WT" remote set-url origin "$TMP/no-such-origin.git"
fresh_clone() { printf '%s' "$BROKEN_WT"; }
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
unset -f fresh_clone
fresh_clone() { local dir="$TMP/run-$RANDOM$RANDOM"; git clone -q "$ORIGIN" "$dir"; git -C "$dir" checkout -q --detach main; printf '%s' "$dir"; }
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason names the unconfirmed base" "$RUN_OUT" 'refusing to build against an unconfirmed base'
assert_eq "nothing was designed" 0 "$(calls design)"

scenario 'epic-run: an open PR already delivering the issue skips it'
GH_OPEN_PR_BRANCH=epic/42-add-widget run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason names the PR" "$RUN_OUT" 'an open PR already delivers this issue (PR #7)'
assert_eq "no branch was claimed" "" "$(origin_ref epic/42-add-widget)"

scenario 'epic-run: a claim-only branch on origin means another run owns the issue'
seed_branch epic/42-add-widget main 'git commit -q --allow-empty -m "chore(epic 42): claim 1-1"'
CLAIM="$(origin_ref epic/42-add-widget)"
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "RESULT says skipped" "$RUN_OUT" '"skipped":true'
assert_contains "the reason survives verbatim" "$RUN_OUT" 'claimed by another run'
assert_eq "nothing was designed" 0 "$(calls design)"
assert_eq "the other run's claim ref is untouched" "$CLAIM" "$(origin_ref epic/42-add-widget)"
assert_not_contains "no blocker was posted" "$(gh_comments)" "epic-run blocked"

scenario 'epic-run: losing the claim push race is a skip, not a retry'
cat > "$ORIGIN/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
while read -r old new ref; do
  [[ "$ref" == refs/heads/epic/42-* ]] && { echo "epic/42 was claimed a moment ago" >&2; exit 1; }
done
exit 0
HOOK
chmod +x "$ORIGIN/hooks/pre-receive"
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the rejected push reads as a lost race" "$RUN_OUT" 'claimed by another run'
assert_eq "nothing was designed" 0 "$(calls design)"
assert_eq "no branch landed on origin" "" "$(origin_ref epic/42-add-widget)"

scenario 'epic-run: a leftover branch with real work is resumed, not restarted'
seed_branch epic/42-add-widget main 'printf "leftover\n" > frontend/src/leftover.ts && git add -A && git commit -qm "wip: epic blocked at architect"'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "prepare resumed the branch" "$RUN_OUT" 'resumed and rebased onto origin/main'
assert_eq "design ran: the branch held no code checkpoint" 1 "$(calls design)"
assert_eq "the resumed branch still squashes to one commit" 1 "$(origin_count epic/42-add-widget)"
assert_contains "the leftover work is in the squashed tree" "$(git -C "$ORIGIN" ls-tree -r --name-only epic/42-add-widget)" "frontend/src/leftover.ts"
assert_contains "and so is the new work" "$(git -C "$ORIGIN" ls-tree -r --name-only epic/42-add-widget)" "frontend/src/widget.ts"

scenario 'resume: a branch with a code checkpoint skips architect, red and green'
seed_branch epic/42-add-widget main 'printf "test(\"widget\", () => {})\n" > frontend/src/widget.test.ts && printf "export const createWidget = () => ({})\n" > frontend/src/widget.ts && git add -A && git commit -qm "wip(epic 42-add-widget): code checkpoint"'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "prepare saw the checkpoint" "$RUN_OUT" "a code checkpoint is on it"
assert_contains "the code phase says what it skipped" "$RUN_OUT" "resumed from a code checkpoint — architect, red and green skipped"
assert_eq "no design" 0 "$(calls design)"
assert_eq "no red" 0 "$(calls red)"
assert_eq "no green" 0 "$(calls green)"
assert_contains "the gate still ran on the resumed tree" "$RUN_OUT" "Code: verify gate (resumed): verify green"
assert_eq "review still ran in full" 5 "$(( $(calls lens-correctness) + $(calls lens-simplicity) + $(calls lens-seam) + $(calls lens-acceptance) + $(calls lens-security) ))"
assert_contains "the run ships" "$RUN_OUT" '"readyToMerge":true'
assert_eq "as one commit above main" 1 "$(origin_count epic/42-add-widget)"
assert_contains "the PR body names where the design came from" "$(cat "$STATE_DIR/ship.0.prompt")" "resumed from a code checkpoint"

scenario 'resume: a red code checkpoint gets one green attempt, then review'
seed_branch epic/42-add-widget main 'printf "test(\"widget\", () => {})\n" > frontend/src/widget.test.ts && git add -A && git commit -qm "wip(epic 42-add-widget): code checkpoint"'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "no red" 0 "$(calls red)"
assert_eq "green ran once, handed the failure" 1 "$(calls green)"
assert_contains "the retry prompt carries the verify output" "$(cat "$STATE_DIR/green.0.prompt")" "missing export createWidget"
assert_contains "the run ships" "$RUN_OUT" '"readyToMerge":true'

scenario 'epic-run: a dead review lens fails the run closed and preserves the work'
DEADLENS="$TMP/fixtures-deadlens"; cp -R "$BASE" "$DEADLENS"
printf '1' > "$DEADLENS/lens-security.0.rc"   # first attempt dies
printf '1' > "$DEADLENS/lens-security.1.rc"   # and so does the retry
run_pipeline "$EPIC_RUN" "$DEADLENS" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the blocker names the review phase" "$RUN_OUT" '"phase":"review"'
assert_contains "the reason names the unreviewed lens" "$RUN_OUT" 'security + authorization'
assert_eq "the lens was respawned exactly once" 2 "$(calls lens-security)"
assert_contains "the respawn was announced as transient" "$RUN_OUT" "respawning once (transient)"
assert_contains "a blocker comment was posted" "$(gh_comments)" "🤖 epic-run blocked"
assert_contains "it names the phase" "$(gh_comments)" "- phase: review"
assert_contains "it says how to resume" "$(gh_comments)" "re-running /epic #42 resumes from it"
assert_contains "it carries the phase log" "$(gh_comments)" "## Phase log"
assert_eq "the issue ends failed and nothing else" "failed," "$(gh_labels)"
assert_eq "nothing shipped a PR" "" "$(gh_pr_created)"
assert_eq "the checkpoint was pushed so a re-run resumes it" 2 "$(origin_count epic/42-add-widget)"
assert_contains "the pushed checkpoint holds the implementation" "$(git -C "$ORIGIN" ls-tree -r --name-only epic/42-add-widget)" "frontend/src/widget.ts"
assert_not_contains "the WIP never carries a Closes line" "$(git -C "$ORIGIN" log --format=%B main..epic/42-add-widget)" "Closes #"

scenario 'epic-run: a deferred finding holds the merge gate'
HELD="$TMP/fixtures-held"; cp -R "$BASE" "$HELD"
fixture "$HELD" triage '{"status":"Left one for a human.","deferred":[{"title":"Null deref on empty list","severity":"Critical","why":"The fix needs a product decision."}]}'
run_pipeline "$EPIC_RUN" "$HELD" --issue 42
assert_rc "exits 0 (the PR is real, just held)" 0 "$RUN_RC"
assert_contains "RESULT records why the gate held" "$RUN_OUT" '"mergeSkipped"'
assert_contains "the held reason names the finding" "$RUN_OUT" 'Critical: Null deref on empty list'
assert_not_contains "it is not queued for merge" "$RUN_OUT" '"readyToMerge":true'
assert_contains "RESULT marks an exclusively defect-class hold repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays reviewable and enters the defect-fixer queue" "needs-defect-fix,ready-to-review," "$(gh_labels)"

scenario 'epic-run: repairability is reported only after the queue label is observed'
GH_DROP_LABEL=needs-defect-fix run_pipeline "$EPIC_RUN" "$HELD" --issue 42
assert_rc "the completed PR is still a clean held result" 0 "$RUN_RC"
assert_contains "the original gate reason is preserved" "$RUN_OUT" 'Critical: Null deref on empty list'
assert_not_contains "RESULT cannot claim an unobserved queue handoff" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the conservative review label remains" "ready-to-review," "$(gh_labels)"

scenario 'epic-run: an unpersisted repair brief cannot enter the defect queue'
GH_EVIDENCE_COMMENT_FAIL=1 run_pipeline "$EPIC_RUN" "$HELD" --issue 42
assert_rc "the completed PR remains a held result" 0 "$RUN_RC"
assert_not_contains "a failed evidence write prevents queueing" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "only the review label remains" "ready-to-review," "$(gh_labels)"

scenario 'epic-run: an unreadable repair brief cannot enter the defect queue'
GH_EVIDENCE_READ_FAIL=1 run_pipeline "$EPIC_RUN" "$HELD" --issue 42
assert_rc "the completed PR remains a held result" 0 "$RUN_RC"
assert_not_contains "a failed evidence readback prevents queueing" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "only the review label remains" "ready-to-review," "$(gh_labels)"

scenario 'epic-run: ship classifies deferrals; the script counts, files and records them'
DEFER="$TMP/fixtures-defer"; cp -R "$BASE" "$DEFER"
fixture "$DEFER" ship '{"title":"Add widget","body":"Adds a widget.","commitBody":"","legalMarker":"LEGAL-REVIEW: required","deferred":[
  {"title":"Widget crashes on empty list","why":"Needs a product decision.","kind":"defect","file":true,"issueTitle":"Widget crashes on empty list","issueBody":"Still on main after the merge."},
  {"title":"Second defect","why":"Same.","kind":"defect","file":true},
  {"title":"Third defect","why":"Same.","kind":"defect","file":true},
  {"title":"Fourth defect","why":"Same.","kind":"defect","file":true},
  {"title":"Refactor the helpers","why":"Nice to have.","kind":"other","file":true}]}'
fixture "$DEFER" defercheck '{"verdicts":[{"index":1,"defect":false,"confidence":90,"reasoning":"A refactor idea; nothing breaks."}]}'
run_pipeline "$EPIC_RUN" "$DEFER" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "the skeptic re-judged the deferrals once" 1 "$(calls defercheck)"
assert_contains "only the non-defect item was put to it" "$(cat "$STATE_DIR/defercheck.0.prompt")" "Refactor the helpers"
assert_not_contains "items ship already called defects are not re-judged" "$(cat "$STATE_DIR/defercheck.0.prompt")" "Second defect"
assert_contains "the gate counts defects from the kinds" "$RUN_OUT" '4 deferred defect(s) that still exist on main after this merge'
assert_not_contains "and holds the PR" "$RUN_OUT" '"readyToMerge":true'
assert_contains "RESULT marks deferred defects repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays reviewable and enters the defect-fixer queue" "needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_contains "the deferred record was posted with the exact first line" "$(gh_comments)" "🤖 deferred / not done"
assert_contains "it lists every item, kind and why" "$(gh_comments)" "- Refactor the helpers (other): Nice to have."
assert_eq "at most three follow-ups were filed, defects first" 3 "$(grep -c '^TITLE: ' "$STATE_DIR/gh/issues-created")"
assert_not_contains "an 'other' item is never filed even when asked" "$(gh_issues_created)" "Refactor the helpers"
assert_contains "a follow-up links back with the Follow-up line" "$(gh_issues_created)" "Follow-up to #42"
assert_contains "the record says how many qualified versus filed" "$(gh_comments)" "4 items qualified for a follow-up issue and 3 were filed"
assert_contains "the PR body points at the record" "$(cat "$WT/.epics/42-add-widget/summary.md")" "Deferred items recorded on #42."
assert_contains "the legal marker reaches the PR body" "$(cat "$WT/.epics/42-add-widget/summary.md")" "LEGAL-REVIEW: required"
# Ordering is the idempotency guarantee: everything before the PR can be redone
# by a retry, a filed issue and a posted comment cannot.
GH_ORDER="$(grep -n -E '^(pr create|issue create|issue comment 42)' "$GH_LOG" | head -3 | cut -d: -f2- | cut -d' ' -f1-2 | tr '\n' '|')"
assert_contains "the PR is created before any follow-up issue" "$GH_ORDER" "pr create|issue create"
# Ship queues what it files: each follow-up is ordered behind this issue and
# labelled ready, so the pipeline picks it up once this one closes.
DEPS="$(cat "$STATE_DIR/gh/deps-created" 2>/dev/null || true)"
assert_eq "every filed follow-up is ordered behind the epic issue" 3 "$(grep -c ' 900042$' <<<"$DEPS")"
assert_eq "the follow-ups are the ones just created" "101 102 103" "$(cut -d' ' -f1 <<<"$DEPS" | sort | tr '\n' ' ' | sed 's/ $//')"
assert_eq "each is queued ready" "ready" "$(cat "$STATE_DIR/gh/labels-101" "$STATE_DIR/gh/labels-102" "$STATE_DIR/gh/labels-103" 2>/dev/null | sort -u | tr '\n' ' ' | sed 's/ $//')"
assert_eq "and the epic issue keeps only its gate and repair labels" "needs-defect-fix,ready-to-review," "$(gh_labels)"
# The dependency is what keeps a queued follow-up off a main without its code,
# so it is written FIRST — a `ready` that landed without it would be launchable
# immediately, against a tree that lacks the branch the defect lives in.
DEP_ORDER="$(grep -n -E "^(api --method POST repos/\{owner\}/\{repo\}/issues/101|issue edit 101)" "$GH_LOG" | head -2 | cut -d: -f2- | cut -d' ' -f1-2 | tr '\n' '|')"
assert_contains "the dependency is written before the ready label" "$DEP_ORDER" "api --method|issue edit"

scenario 'epic-run: a follow-up that cannot be ordered is never queued'
GH_DEP_WRITE_FAIL=1 run_pipeline "$EPIC_RUN" "$DEFER" --issue 42
assert_rc "the run still finishes" 0 "$RUN_RC"
assert_eq "the follow-ups are still filed" 3 "$(grep -c '^TITLE: ' "$STATE_DIR/gh/issues-created")"
# Fail closed: unordered means unqueued, never queued-and-unordered.
assert_eq "but none is labelled ready" "" "$(cat "$STATE_DIR/gh/labels-101" "$STATE_DIR/gh/labels-102" "$STATE_DIR/gh/labels-103" 2>/dev/null | tr -d '\n')"
assert_contains "and the run says so" "$RUN_OUT" "left unqueued"

scenario 'epic-run: an unreadable issue id leaves the follow-ups for a human'
GH_ISSUE_ID_FAIL=1 run_pipeline "$EPIC_RUN" "$DEFER" --issue 42
assert_rc "the run still finishes" 0 "$RUN_RC"
assert_eq "the follow-ups are still filed" 3 "$(grep -c '^TITLE: ' "$STATE_DIR/gh/issues-created")"
assert_eq "none is ordered" 0 "$(grep -c . "$STATE_DIR/gh/deps-created" 2>/dev/null || echo 0)"
assert_eq "and none is queued" "" "$(cat "$STATE_DIR/gh/labels-101" 2>/dev/null | tr -d '\n')"
assert_contains "the run says a human orders them" "$RUN_OUT" "for a human to order and label"
assert_contains "and the commit body" "$(git -C "$ORIGIN" log -1 --format=%B epic/42-add-widget)" "LEGAL-REVIEW: required"

scenario 'verify gate: red tests that pass are sent back once, then accepted'
VACUOUS="$TMP/fixtures-vacuous"; cp -R "$BASE" "$VACUOUS"
rm -f "$VACUOUS/red.sh"
fixture_sh "$VACUOUS" red.0 'true'   # writes no test: verify stays green
cp "$BASE/red.sh" "$VACUOUS/red.1.sh"
run_pipeline "$EPIC_RUN" "$VACUOUS" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "red was spawned twice" 2 "$(calls red)"
assert_contains "the retry was announced" "$RUN_OUT" "respawning the red step once"
assert_contains "the retry prompt says why" "$(cat "$STATE_DIR/red.1.prompt")" "pass against a tree with NO implementation"
assert_contains "the run still ships" "$RUN_OUT" '"readyToMerge":true'

scenario 'verify gate: red tests that pass twice block the run'
VACUOUS2="$TMP/fixtures-vacuous2"; cp -R "$BASE" "$VACUOUS2"
rm -f "$VACUOUS2/red.sh"
run_pipeline "$EPIC_RUN" "$VACUOUS2" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "it blocks in the code phase" "$RUN_OUT" '"phase":"code"'
assert_contains "the reason says the tests test nothing" "$RUN_OUT" 'do not test the change'
assert_eq "green never ran" 0 "$(calls green)"
assert_eq "the issue ends failed" "failed," "$(gh_labels)"

scenario 'verify gate: a red verify after green is sent back once, then accepted'
LATE="$TMP/fixtures-late"; cp -R "$BASE" "$LATE"
rm -f "$LATE/green.sh"
fixture_sh "$LATE" green.0 'true'    # claims green, writes nothing
cp "$BASE/green.sh" "$LATE/green.1.sh"
run_pipeline "$EPIC_RUN" "$LATE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "green was spawned twice" 2 "$(calls green)"
assert_contains "the retry was announced" "$RUN_OUT" "respawning green once with the failure"
assert_contains "the retry prompt carries the verify output" "$(cat "$STATE_DIR/green.1.prompt")" "missing export createWidget"
assert_contains "and says it is the one retry" "$(cat "$STATE_DIR/green.1.prompt")" "This is your one retry"
assert_contains "the run still ships" "$RUN_OUT" '"readyToMerge":true'

scenario 'verify gate: a red verify after green twice blocks the run'
NEVER="$TMP/fixtures-never"; cp -R "$BASE" "$NEVER"
rm -f "$NEVER/green.sh"
run_pipeline "$EPIC_RUN" "$NEVER" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "it blocks in the code phase" "$RUN_OUT" '"phase":"code"'
assert_contains "the reason names the red verify" "$RUN_OUT" 'npm run verify is red after the green step and its retry'
assert_eq "green was spawned twice" 2 "$(calls green)"
assert_eq "no review lens ran on an unverified tree" 0 "$(calls lens-correctness)"
assert_contains "the blocker comment says so" "$(gh_comments)" "red after the green step"

scenario 'verify gate: fixes that leave verify red twice block the run'
BROKEN="$TMP/fixtures-broken"; cp -R "$BASE" "$BROKEN"
fixture_sh "$BROKEN" triage 'rm -f frontend/src/widget.ts'   # the "fix" deletes the implementation
run_pipeline "$EPIC_RUN" "$BROKEN" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "it blocks in the fixes phase" "$RUN_OUT" '"phase":"triage"'
assert_contains "the reason names the red verify" "$RUN_OUT" 'red after the fixes and their retry'
assert_eq "the fixer was spawned twice" 2 "$(calls triage)"
assert_eq "nothing shipped a PR" "" "$(gh_pr_created)"

scenario 'transient retry: a step that dies once is respawned once, then accepted'
FLAKY="$TMP/fixtures-flaky"; cp -R "$BASE" "$FLAKY"
printf '1' > "$FLAKY/design.0.rc"          # dies instantly, no payload
run_pipeline "$EPIC_RUN" "$FLAKY" --issue 42
assert_rc "the run still completes" 0 "$RUN_RC"
assert_eq "design was spawned twice" 2 "$(calls design)"
assert_eq "both attempts are in the usage log, the failed one marked" "false true" "$(usage_log | jq -r 'select(.label=="architect:design") | .ok' | tr '\n' ' ' | sed 's/ $//')"
assert_contains "the respawn was announced" "$RUN_OUT" "design: exited 1"
assert_contains "and named transient" "$RUN_OUT" "respawning once (transient)"

scenario 'transient retry: a step that dies twice is a dead step'
DEAD2="$TMP/fixtures-dead2"; cp -R "$BASE" "$DEAD2"
printf '1' > "$DEAD2/design.0.rc"; printf '1' > "$DEAD2/design.1.rc"
run_pipeline "$EPIC_RUN" "$DEAD2" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_eq "exactly two attempts, never a third" 2 "$(calls design)"
assert_contains "it blocks in the architect phase" "$RUN_OUT" '"phase":"architect"'

scenario 'provider quota: exact reset time reaches the durable blocker'
QUOTA="$TMP/fixtures-quota"; cp -R "$BASE" "$QUOTA"
rm -f "$QUOTA/red.sh"
fixture_error "$QUOTA" red '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error","api_error_status":429,"result":"You\u0027ve hit your session limit · resets 3:50pm (Europe/Amsterdam)","duration_ms":386,"num_turns":1,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
run_pipeline "$EPIC_RUN" "$QUOTA" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_eq "the rejected step is tried exactly twice" 2 "$(calls red)"
assert_eq "implementation never starts" 0 "$(calls green)"
assert_contains "the result names quota exhaustion" "$RUN_OUT" "Provider usage quota exhausted"
assert_contains "Claude's exact message survives" "$RUN_OUT" "You've hit your session limit"
assert_contains "the provider's reset time survives" "$RUN_OUT" "resets 3:50pm (Europe/Amsterdam)"
assert_contains "the blocker carries the exact reset time" "$(gh_comments)" "resets 3:50pm (Europe/Amsterdam)"
assert_contains "the misleading success subtype is ignored" "$(gh_comments)" "API error 429"
assert_eq "failed usage records are classified durably" "quota-exhausted quota-exhausted" "$(usage_log | jq -r 'select(.label=="code:red") | .failureKind' | tr '\n' ' ' | sed 's/ $//')"
assert_contains "usage retains the provider reason" "$(usage_log)" "resets 3:50pm (Europe/Amsterdam)"

scenario 'transient retry: a timeout is never retried'
SLOW="$TMP/fixtures-slow"; cp -R "$BASE" "$SLOW"
printf '3' > "$SLOW/design.0.sleep"        # outlives a 1-second ceiling
EPIC_AGENT_TIMEOUT_MS=1000 run_pipeline "$EPIC_RUN" "$SLOW" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_eq "one attempt only" 1 "$(calls design)"
assert_contains "the reason says it timed out" "$RUN_OUT" "timed out"
assert_not_contains "no respawn on a timeout" "$RUN_OUT" "respawning once (transient)"

scenario 'post-fix check: an unconfirmed fix holds the PR'
UNFIXED="$TMP/fixtures-unfixed"; cp -R "$BASE" "$UNFIXED"
fixture "$UNFIXED" fixcheck '{"verdicts":[{"index":1,"resolved":false,"confidence":90,"reasoning":"The guard checks null, not empty."}],"regressions":[]}'
run_pipeline "$EPIC_RUN" "$UNFIXED" --issue 42
assert_rc "exits 0 (the PR is real, just held)" 0 "$RUN_RC"
assert_contains "the gate names the unconfirmed fix" "$RUN_OUT" 'fix(es) not confirmed by the post-fix check (Null deref on empty list)'
assert_not_contains "it is not queued for merge" "$RUN_OUT" '"readyToMerge":true'
assert_contains "RESULT marks the concrete unresolved fix repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays reviewable and enters the defect-fixer queue" "needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_contains "review.md records the verdict" "$(cat "$WT/.epics/42-add-widget/review.md")" "NOT confirmed"
assert_eq "no second fix round" 1 "$(calls triage)"

scenario 'post-fix check: a regression holds the PR'
REGRESS="$TMP/fixtures-regress"; cp -R "$BASE" "$REGRESS"
fixture "$REGRESS" fixcheck '{"verdicts":[{"index":1,"resolved":true,"confidence":90,"reasoning":"Fixed."}],"regressions":[{"title":"Guard breaks the non-empty path","severity":"Important","confidence":85,"location":"src/widget.ts:14","problem":"Returns early for every list.","fix":"Check length, not truthiness.","gate":"unit test for a non-empty list"}]}'
run_pipeline "$EPIC_RUN" "$REGRESS" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the gate names the regression" "$RUN_OUT" 'regression(s) introduced by the fixes (Important: Guard breaks the non-empty path)'
assert_contains "RESULT marks the concrete regression repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays reviewable and enters the defect-fixer queue" "needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_contains "review.md lists it as a deferred defect" "$(cat "$WT/.epics/42-add-widget/review.md")" "Regressions introduced by the fixes"
assert_eq "no second fix round" 1 "$(calls triage)"

scenario 'post-fix check: a claimed fix with no diff holds the PR without a model'
NODIFF="$TMP/fixtures-nodiff"; cp -R "$BASE" "$NODIFF"
fixture_sh "$NODIFF" triage 'true'      # claims a fix, changes nothing
run_pipeline "$EPIC_RUN" "$NODIFF" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the gate says so" "$RUN_OUT" 'reported fixed but the fixes step changed nothing'
assert_eq "no skeptic was spawned for an empty delta" 0 "$(calls fixcheck)"
assert_contains "RESULT marks a claimed no-delta fix repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays reviewable and enters the defect-fixer queue" "needs-defect-fix,ready-to-review," "$(gh_labels)"

scenario 'post-fix check: a dead check holds the PR, not the run'
DEADCHECK="$TMP/fixtures-deadcheck"; cp -R "$BASE" "$DEADCHECK"
printf '1' > "$DEADCHECK/fixcheck.0.rc"; printf '1' > "$DEADCHECK/fixcheck.1.rc"
run_pipeline "$EPIC_RUN" "$DEADCHECK" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the gate says the fixes are unreviewed" "$RUN_OUT" 'the post-fix check produced no result'
assert_contains "the PR was still opened" "$RUN_OUT" '"prUrl":"https://github.com/o/r/pull/7"'
assert_not_contains "missing post-fix evidence is not autonomously repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays ready-to-review" "ready-to-review," "$(gh_labels)"

scenario 'post-fix check: nothing confirmed means nothing to check'
CLEANREV="$TMP/fixtures-cleanrev"; cp -R "$BASE" "$CLEANREV"
fixture "$CLEANREV" lens-correctness '{"findings":[]}'
run_pipeline "$EPIC_RUN" "$CLEANREV" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "no fixer ran" 0 "$(calls triage)"
assert_eq "no fix check ran" 0 "$(calls fixcheck)"
assert_contains "the run ships" "$RUN_OUT" '"readyToMerge":true'

scenario 'deferral check: an item ship called other but the skeptic calls a defect holds the PR'
DOWNGRADED="$TMP/fixtures-downgraded"; cp -R "$BASE" "$DOWNGRADED"
fixture "$DOWNGRADED" ship '{"title":"Add widget","body":"Adds a widget.","commitBody":"","deferred":[{"title":"Empty list still crashes on submit","why":"Out of scope for this slice.","kind":"other","file":false}]}'
fixture "$DOWNGRADED" defercheck '{"verdicts":[{"index":1,"defect":true,"confidence":92,"reasoning":"Submit with an empty list throws on main after this merge; the requirement covers it."}]}'
run_pipeline "$EPIC_RUN" "$DOWNGRADED" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the gate holds on the reclassified defect" "$RUN_OUT" '1 deferred defect(s) that still exist on main after this merge'
assert_not_contains "it is not queued for merge" "$RUN_OUT" '"readyToMerge":true'
assert_contains "RESULT marks a skeptic-confirmed deferred defect repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays reviewable and enters the defect-fixer queue" "needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_contains "the deferred record shows the reclassification" "$(gh_comments)" "Empty list still crashes on submit (defect): Out of scope for this slice. — reclassified from other to defect by the deferral check"

scenario 'deferral check: a dead check holds the PR, not the run'
DEADDEFER="$TMP/fixtures-deaddefer"; cp -R "$DOWNGRADED" "$DEADDEFER"
printf '1' > "$DEADDEFER/defercheck.0.rc"; printf '1' > "$DEADDEFER/defercheck.1.rc"
run_pipeline "$EPIC_RUN" "$DEADDEFER" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the gate says the items are unclassified" "$RUN_OUT" 'the deferral check produced no result'
assert_contains "the PR was still opened" "$RUN_OUT" '"prUrl":"https://github.com/o/r/pull/7"'
assert_not_contains "missing deferral evidence is not autonomously repairable" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue stays ready-to-review" "ready-to-review," "$(gh_labels)"

scenario 'merge gate: one uncertain blocker keeps concrete defects out of autonomous repair'
MIXED="$TMP/fixtures-mixed-gate"; cp -R "$HELD" "$MIXED"
fixture "$MIXED" ship '{"title":"Add widget","body":"Adds a widget.","commitBody":"","deferred":[{"title":"Maybe update the docs","why":"Classification needs review.","kind":"other","file":false}]}'
printf '1' > "$MIXED/defercheck.0.rc"; printf '1' > "$MIXED/defercheck.1.rc"
run_pipeline "$EPIC_RUN" "$MIXED" --issue 42
assert_rc "exits 0 with a reviewable PR" 0 "$RUN_RC"
assert_contains "the concrete unfixed finding still holds the gate" "$RUN_OUT" 'confirmed review finding(s) left unfixed'
assert_contains "the uncertain deferral also holds it" "$RUN_OUT" 'the deferral check produced no result'
assert_not_contains "mixed evidence cannot enter autonomous repair" "$RUN_OUT" '"needsDefectFix":true'
assert_eq "the issue remains only ready-to-review" "ready-to-review," "$(gh_labels)"

scenario 'epic-run: a deferred record already on the issue is not doubled'
# What a retry sees after a ship that died between recording the deferrals and
# opening the PR: the record is already there, so this run must add nothing.
SEED_COMMENTS='🤖 deferred / not done

- Widget crashes on empty list (defect): Needs a product decision.' \
  run_pipeline "$EPIC_RUN" "$DEFER" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the run says it left the record alone" "$RUN_OUT" 'already on the issue'
assert_eq "no second deferred record is posted" 1 "$(grep -c 'deferred / not done' "$STATE_DIR/gh/comments")"
assert_eq "and no follow-up issue is re-filed" 0 "$(grep -c '^TITLE: ' "$STATE_DIR/gh/issues-created" 2>/dev/null || echo 0)"

scenario 'epic-run: an off-schema payload is respawned once, then accepted'
RETRY="$TMP/fixtures-retry"; cp -R "$BASE" "$RETRY"
# Missing `contract` — the field red writes its tests from.
fixture "$RETRY" design.0 '{"approach":"Thin widget module","rationale":"Fits.","steps":["one"],"files":["src/widget.ts"],"tradeoffs":"None."}'
cp "$BASE/design.json" "$RETRY/design.1.json"
run_pipeline "$EPIC_RUN" "$RETRY" --issue 42
assert_rc "the run still completes" 0 "$RUN_RC"
assert_eq "design was spawned twice" 2 "$(calls design)"
assert_contains "the retry was announced" "$RUN_OUT" 'did not match the schema'

scenario 'epic-run: an off-schema payload twice fails the phase closed'
BADSCHEMA="$TMP/fixtures-badschema"; cp -R "$BASE" "$BADSCHEMA"
fixture "$BADSCHEMA" design '{"approach":"Thin widget module","rationale":"Fits.","steps":["one"],"files":["src/widget.ts"],"tradeoffs":"None."}'
run_pipeline "$EPIC_RUN" "$BADSCHEMA" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "it blocks in the architect phase" "$RUN_OUT" '"phase":"architect"'
assert_eq "nothing was implemented" 0 "$(calls red)"
assert_contains "the blocker names the branch to resume" "$(gh_comments)" "- branch: epic/42-add-widget"
assert_eq "the issue ends failed" "failed," "$(gh_labels)"

scenario 'epic-run: manual slug mode touches no git phase and no issue'
MANUAL="$TMP/fixtures-manual"; cp -R "$BASE" "$MANUAL"
fixture "$MANUAL" summary '{"summary":"summary.md written"}'
MANUAL_WT="$(fresh_clone)"
mkdir -p "$MANUAL_WT/.epics/42-add-widget"
printf 'Build a widget.\n' > "$MANUAL_WT/.epics/42-add-widget/requirements.md"
# run in that prepared clone rather than a fresh one
fresh_clone() { printf '%s' "$MANUAL_WT"; }
run_pipeline "$EPIC_RUN" "$MANUAL" --slug 42-add-widget
unset -f fresh_clone
fresh_clone() { local dir="$TMP/run-$RANDOM$RANDOM"; git clone -q "$ORIGIN" "$dir"; git -C "$dir" checkout -q --detach main; printf '%s' "$dir"; }
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the summary came back" "$RUN_OUT" 'summary.md written'
assert_contains "summary.md was written to the tree" "$(cat "$MANUAL_WT/.epics/42-add-widget/summary.md")" 'summary.md written'
assert_eq "no gh calls at all" "0" "$(wc -l < "$GH_LOG" | tr -d ' ')"
assert_eq "no branch was created on origin" "" "$(origin_ref epic/42-add-widget)"
assert_eq "no fix check in manual mode" 0 "$(calls fixcheck)"
assert_eq "no commit was made on the user's tree" "$MAIN_INITIAL" "$(git -C "$MANUAL_WT" rev-parse HEAD)"
assert_contains "new files were intent-added for the blind review" "$(git -C "$MANUAL_WT" status --porcelain)" "frontend/src/widget.ts"

# ───────────────────────── fix-run ─────────────────────────
# A finished epic PR (one commit, Closes #42) whose line conflicts with a
# commit that landed on main since: both sides edited the same base line, which
# the deterministic rung classifies as needing judgment and hands to the model.
seed_conflict() {
  seed_branch epic/42-add-widget main 'printf "export const items = [] // pr-guard\n" > frontend/src/index.ts && git commit -qam "feat: add guard" -m "Closes #42"'
  seed_branch main main 'printf "export const items = [] // main-rename\n" > frontend/src/index.ts && git commit -qam "main: rename helper" -m "Closes #41"'
}
seed_clean() {
  seed_branch epic/42-add-widget main 'printf "export const items = [] // pr-guard\n" > frontend/src/index.ts && git commit -qam "feat: add guard" -m "Closes #42"'
  seed_branch main main 'printf "# app\n\nmoved on\n" > README.md && git commit -qam "docs: main moved" -m "Closes #41"'
}
FIXBASE="$TMP/fixtures-fix"
mkdir -p "$FIXBASE"
fixture "$FIXBASE" fix-resolve '{"completed":true,"resolutions":[{"file":"frontend/src/index.ts","hunk":1,"mainIntent":"main renamed the helper","prIntent":"the PR added a guard","resolution":"Keeps the rename and the guard."}]}'
# What the resolver does to the tree: settle the marked block, stage, continue.
fixture_sh "$FIXBASE" fix-resolve 'printf "export const items = [] // main-rename pr-guard\n" > frontend/src/index.ts && git add frontend/src/index.ts && GIT_EDITOR=true git rebase --continue >/dev/null'
fixture "$FIXBASE" fix-check '{"survives":true,"confidence":88,"reasoning":"Both changes are present at HEAD."}'
run_fix() { GH_ISSUE_LABELS="${FIX_LABELS:-failed,needs-judgment}" GH_OPEN_PR_BRANCH=epic/42-add-widget run_pipeline "$FIX_RUN" "$@"; }

scenario 'fix-run: judgment hunk resolved, verified, checked, shipped ready-to-review'
seed_conflict
BEFORE="$(origin_ref epic/42-add-widget)"
run_fix "$FIXBASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT lands ready-to-review" "$RUN_OUT" '"readyToReview":true'
assert_contains "it records one judgment hunk" "$RUN_OUT" '"resolvedHunks":1'
assert_not_contains "no merge queue promotion" "$RUN_OUT" 'readyToMerge'
assert_contains "the resolver was handed the rung's classification" "$(cat "$STATE_DIR/fix-resolve.0.prompt")" 'needs judgment'
assert_eq "the branch on origin was rewritten" "$(git -C "$WT" rev-parse HEAD)" "$(origin_ref epic/42-add-widget)"
assert_not_contains "and is not what it was" "$(origin_ref epic/42-add-widget)" "$BEFORE"
assert_eq "it is exactly one commit above the new main" 1 "$(origin_count epic/42-add-widget)"
assert_contains "both intents are in the shipped file" "$(git -C "$ORIGIN" show epic/42-add-widget:frontend/src/index.ts)" "main-rename pr-guard"
assert_contains "verify ran in the discovered package" "$(cat "$NPM_LOG")" "run verify"
assert_contains "the audit comment states main's intent" "$(gh_comments)" "origin/main intended: main renamed the helper"
assert_contains "the audit comment states the PR's intent" "$(gh_comments)" "the PR intended: the PR added a guard"
assert_contains "the audit comment records the adversarial check" "$(gh_comments)" "confidence 88/100"
assert_eq "the labels: ready-to-review, ladder kept, needs-judgment cleared" "fix-attempted,ready-to-review," "$(gh_labels)"

scenario 'fix-run: the resolver escalates instead of guessing'
seed_conflict
BEFORE="$(origin_ref epic/42-add-widget)"
ESCALATE="$TMP/fixtures-escalate"; cp -R "$FIXBASE" "$ESCALATE"; rm -f "$ESCALATE/fix-resolve.sh"
fixture "$ESCALATE" fix-resolve '{"completed":false,"escalate":"frontend/src/index.ts hunk 1: the two sides set the same flag to opposite values."}'
run_fix "$ESCALATE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the escalation reaches the blocker" "$RUN_OUT" 'escalated rather than guessed'
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "the worktree is not left mid-rebase" "" "$(cd "$WT" && ls -d .git/rebase-merge .git/rebase-apply 2>/dev/null)"
assert_contains "the blocker block names the next step" "$(gh_comments)" "- next: This was the first attempt"
assert_eq "labels: failed, ladder and needs-judgment kept" "failed,fix-attempted,needs-judgment," "$(gh_labels)"

scenario 'fix-run: the retry that fails hands the issue to a human'
seed_conflict
FIX_LABELS="failed,needs-judgment,fix-attempted" run_fix "$ESCALATE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "RESULT records attempt 2" "$RUN_OUT" '"attempt":2'
assert_contains "the blocker block says the ladder is spent" "$(gh_comments)" "- next: This was the RETRY"
assert_contains "fix-retried was recorded" "$(gh_labels)" "fix-retried,"

scenario 'fix-run: a red verify blocks — the fixer never fixes code'
seed_conflict
BEFORE="$(origin_ref epic/42-add-widget)"
REDVERIFY="$TMP/fixtures-redverify"; cp -R "$FIXBASE" "$REDVERIFY"
printf '1' > "$REDVERIFY/verify.rc"
run_fix "$REDVERIFY" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the failing detail reaches the blocker" "$RUN_OUT" 'widget.test.ts expected 2 got 1'
assert_eq "the adversarial check never ran" 0 "$(calls fix-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'fix-run: a refuted resolution blocks'
seed_conflict
BEFORE="$(origin_ref epic/42-add-widget)"
REFUTED="$TMP/fixtures-refuted"; cp -R "$FIXBASE" "$REFUTED"
fixture "$REFUTED" fix-check '{"survives":false,"confidence":20,"reasoning":"The rename was dropped from the guarded branch."}'
run_fix "$REFUTED" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the refutation reaches the blocker" "$RUN_OUT" 'the adversarial check refuted the resolution'
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'fix-run: a resolver that claims completion mid-rebase is caught'
seed_conflict
BEFORE="$(origin_ref epic/42-add-widget)"
LIAR="$TMP/fixtures-liar"; cp -R "$FIXBASE" "$LIAR"; rm -f "$LIAR/fix-resolve.sh"
run_fix "$LIAR" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the tree, not the claim, decides" "$RUN_OUT" 'the rebase is still in progress'
assert_eq "verify never ran" 0 "$(grep -c 'run verify' "$NPM_LOG")"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'fix-run: an exhausted attempt ladder refuses without running'
seed_conflict
BEFORE="$(origin_ref epic/42-add-widget)"
FIX_LABELS="failed,needs-judgment,fix-attempted,fix-retried" run_fix "$FIXBASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the refusal is final" "$RUN_OUT" '"refusalFinal":true'
assert_eq "no resolver was woken" 0 "$(calls fix-resolve)"
assert_contains "the refusal was commented" "$(gh_comments)" "🤖 fix-conflict refused: attempt ladder exhausted"
assert_contains "the issue is left failed" "$(gh_labels)" "failed,"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'fix-run: no open PR is a final refusal'
seed_conflict
GH_OPEN_PR_BRANCH="" GH_ISSUE_LABELS="failed,needs-judgment" run_pipeline "$FIX_RUN" "$FIXBASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason names the missing PR" "$RUN_OUT" 'no open PR on an epic/42-* branch'
assert_contains "the refusal was commented" "$(gh_comments)" "🤖 fix-conflict refused: no open PR"

scenario 'fix-run: a rebase that came back clean skips judgment entirely'
seed_clean
run_fix "$FIXBASE" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_eq "no resolver ran" 0 "$(calls fix-resolve)"
assert_eq "no adversarial check ran" 0 "$(calls fix-check)"
assert_contains "it still verified before shipping" "$RUN_OUT" 'Verify: green'
assert_contains "RESULT records that no judgment was exercised" "$RUN_OUT" '"resolvedHunks":0'
assert_eq "the branch was rebased onto the new main and pushed" 1 "$(origin_count epic/42-add-widget)"
if git -C "$ORIGIN" merge-base --is-ancestor main epic/42-add-widget; then ok "and sits on top of main"; else nok "and sits on top of main"; fi
assert_contains "the audit comment says the conflict evaporated" "$(gh_comments)" "the conflict had evaporated"

# ───────────────────────── ci-run ─────────────────────────
# A finished epic PR the merge worker rebased and re-ran: its checks came back
# red. The seed leaves the branch's single commit holding a test with no
# implementation, so `npm run verify` is red locally too and the fixer's fixture
# writes the missing file — the same shape the epic-run gates use.
seed_ci_pr() {
  seed_branch epic/42-add-widget main 'mkdir -p frontend/src && printf "test(\"widget\", () => {})\n" > frontend/src/widget.test.ts && git add -A && git commit -qm "Add widget" -m "Closes #42"'
}
CIBASE="$TMP/fixtures-ci"
mkdir -p "$CIBASE"
fixture "$CIBASE" ci-fix '{"completed":true,"cause":"createWidget was never exported","summary":"Exports createWidget from the widget module.","files":["frontend/src/widget.ts"]}'
fixture_sh "$CIBASE" ci-fix 'printf "export const createWidget = () => ({})\n" > frontend/src/widget.ts'
fixture "$CIBASE" ci-check '{"survives":true,"confidence":91,"reasoning":"The export is added and nothing else changed."}'
run_ci() { GH_ISSUE_LABELS="${CI_LABELS:-failed,needs-ci-fix}" GH_OPEN_PR_BRANCH=epic/42-add-widget GH_RED_CHECKS="${CI_RED-build}" run_pipeline "$@"; }

scenario 'ci-run: a red check is repaired, checked, and put back in the merge queue'
seed_ci_pr
BEFORE="$(origin_ref epic/42-add-widget)"
run_ci "$CI_RUN" "$CIBASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT lands ready-to-merge" "$RUN_OUT" '"readyToMerge":true'
assert_contains "it names the check that was red" "$RUN_OUT" '"failedChecks":["build"]'
assert_eq "the branch on origin was amended" "$(git -C "$WT" rev-parse HEAD)" "$(origin_ref epic/42-add-widget)"
assert_not_contains "and is not what it was" "$(origin_ref epic/42-add-widget)" "$BEFORE"
assert_eq "it is still exactly one commit above main" 1 "$(origin_count epic/42-add-widget)"
assert_contains "the commit keeps its message and Closes line" "$(git -C "$ORIGIN" log -1 --format=%B epic/42-add-widget)" "Closes #42"
assert_contains "the fix is in the pushed tree" "$(git -C "$ORIGIN" ls-tree -r --name-only epic/42-add-widget)" "frontend/src/widget.ts"
assert_eq "the issue is back on ready-to-merge, ladder kept" "ci-attempted,ready-to-merge," "$(gh_labels)"
assert_contains "the audit comment names the cause" "$(gh_comments)" "Cause: createWidget was never exported"
assert_contains "and records the adversarial check" "$(gh_comments)" "confidence 91/100"
assert_contains "and says the merge worker re-runs the real checks" "$(gh_comments)" "re-runs the real checks before anything lands"
FIXPROMPT="$(cat "$STATE_DIR/ci-fix.0.prompt")"
assert_contains "the fixer is told which checks failed" "$FIXPROMPT" "Checks that failed: build"
assert_contains "and gets the failing job log" "$FIXPROMPT" "expected createWidget to be exported"
assert_contains "and is told the failure reproduces locally" "$FIXPROMPT" "RED locally on this exact tree"
assert_contains "and is forbidden to weaken a test" "$FIXPROMPT" "Never weaken, skip, delete or loosen a test"
assert_eq "verify ran before and after the fix" 2 "$(grep -c '^run verify$' "$NPM_LOG")"

scenario 'ci-run: a failure that does not reproduce locally says so'
GREENLOCAL="$TMP/fixtures-ci-green"; cp -R "$CIBASE" "$GREENLOCAL"
# The implementation is already there, so the local gate is green while CI is red.
seed_branch epic/42-add-widget main 'mkdir -p frontend/src && printf "test(\"widget\", () => {})\n" > frontend/src/widget.test.ts && printf "export const createWidget = () => ({})\n" > frontend/src/widget.ts && git add -A && git commit -qm "Add widget" -m "Closes #42"'
fixture_sh "$GREENLOCAL" ci-fix 'printf "export const createWidget = () => ({ ok: true })\n" > frontend/src/widget.ts'
run_ci "$CI_RUN" "$GREENLOCAL" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the prompt says the local gate is green" "$(cat "$STATE_DIR/ci-fix.0.prompt")" "GREEN locally on this exact tree"
assert_contains "and asks why it fails only there" "$(cat "$STATE_DIR/ci-fix.0.prompt")" "why it fails there and not here"

scenario 'ci-run: the fixer escalates instead of guessing'
seed_ci_pr
ESC="$TMP/fixtures-ci-esc"; cp -R "$CIBASE" "$ESC"; rm -f "$ESC/ci-fix.sh"
fixture "$ESC" ci-fix '{"completed":false,"escalate":"the runner could not reach the package registry — no code change here fixes that."}'
BEFORE="$(origin_ref epic/42-add-widget)"
run_ci "$CI_RUN" "$ESC" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the escalation reaches the blocker" "$RUN_OUT" 'escalated rather than guessed'
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "no adversarial check ran" 0 "$(calls ci-check)"
assert_contains "the blocker block names the next step" "$(gh_comments)" "- next: This was the first attempt"
assert_eq "labels: failed, queue and ladder kept" "ci-attempted,failed,needs-ci-fix," "$(gh_labels)"

scenario 'ci-run: a fix that changes nothing is refused'
seed_ci_pr
NOOP="$TMP/fixtures-ci-noop"; cp -R "$CIBASE" "$NOOP"; rm -f "$NOOP/ci-fix.sh"
BEFORE="$(origin_ref epic/42-add-widget)"
run_ci "$CI_RUN" "$NOOP" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the reason says the checks would come back red" "$RUN_OUT" 'changed no file'
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'ci-run: a red verify after the fix blocks'
seed_ci_pr
REDV="$TMP/fixtures-ci-redverify"; cp -R "$CIBASE" "$REDV"
fixture_sh "$REDV" ci-fix 'printf "broken\n" > frontend/src/other.ts'   # writes something, fixes nothing
BEFORE="$(origin_ref epic/42-add-widget)"
run_ci "$CI_RUN" "$REDV" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the failing detail reaches the blocker" "$RUN_OUT" 'npm run verify is red after the fix'
assert_eq "no adversarial check ran" 0 "$(calls ci-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'ci-run: a refuted fix blocks — a weakened test must not reach the queue'
seed_ci_pr
REF="$TMP/fixtures-ci-refuted"; cp -R "$CIBASE" "$REF"
fixture "$REF" ci-check '{"survives":false,"confidence":15,"reasoning":"The assertion was deleted rather than satisfied."}'
BEFORE="$(origin_ref epic/42-add-widget)"
run_ci "$CI_RUN" "$REF" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the refutation reaches the blocker" "$RUN_OUT" 'the adversarial check refuted the fix'
assert_contains "and quotes its reasoning" "$RUN_OUT" 'assertion was deleted'
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_not_contains "the issue never reaches the merge queue" "$(gh_labels)" "ready-to-merge"

scenario 'ci-run: checks that are green again are refused without a model'
seed_ci_pr
BEFORE="$(origin_ref epic/42-add-widget)"
CI_RED= run_ci "$CI_RUN" "$CIBASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the refusal is final" "$RUN_OUT" '"refusalFinal":true'
assert_contains "and says why" "$RUN_OUT" 'checks are no longer failing'
assert_eq "no fixer was woken" 0 "$(calls ci-fix)"
assert_contains "it is commented on the issue" "$(gh_comments)" "the checks are no longer red"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'ci-run: an exhausted attempt ladder refuses without running'
seed_ci_pr
CI_LABELS="failed,needs-ci-fix,ci-attempted,ci-retried" run_ci "$CI_RUN" "$CIBASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the refusal is final" "$RUN_OUT" '"refusalFinal":true'
assert_eq "no fixer was woken" 0 "$(calls ci-fix)"
assert_contains "the refusal was commented" "$(gh_comments)" "🤖 fix-ci refused: attempt ladder exhausted"

scenario 'ci-run: the retry that fails hands the issue to a human'
seed_ci_pr
CI_LABELS="failed,needs-ci-fix,ci-attempted" run_ci "$CI_RUN" "$ESC" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "RESULT records attempt 2" "$RUN_OUT" '"attempt":2'
assert_contains "the blocker block says the ladder is spent" "$(gh_comments)" "- next: This was the RETRY"
assert_contains "ci-retried was recorded" "$(gh_labels)" "ci-retried,"

scenario 'ci-run: a branch that is not a single epic commit is refused'
seed_branch epic/42-add-widget main 'mkdir -p frontend/src && printf "a\n" > frontend/src/widget.test.ts && git add -A && git commit -qm "Add widget" -m "Closes #42" && printf "b\n" >> frontend/src/widget.test.ts && git commit -qam "second commit"'
BEFORE="$(origin_ref epic/42-add-widget)"
run_ci "$CI_RUN" "$CIBASE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the reason names the shape" "$RUN_OUT" 'commit(s) above origin/main'
assert_eq "no fixer was woken" 0 "$(calls ci-fix)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'ci-run: an issue without the queue label is not a CI fixer issue'
seed_ci_pr
CI_LABELS="failed" run_ci "$CI_RUN" "$CIBASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason says so" "$RUN_OUT" 'not labelled needs-ci-fix'
assert_eq "no fixer was woken" 0 "$(calls ci-fix)"

# ───────────────────────── defect-run ─────────────────────────
# A finished epic PR whose deterministic merge gate held only on concrete
# defects. Unlike ci-run, the durable input is one authenticated, PR/head-bound
# evidence envelope: .epics and the mutable live issue body are deliberately
# unavailable to this later session.
seed_defect_pr() {
  seed_branch epic/42-add-widget main 'printf "export const firstItem = items => items[0].name\n" > frontend/src/widget.ts && git add -A && git commit -qm "Add widget" -m "Closes #42"'
}
make_defect_evidence() { # head [blocker title] [requirement body]
  local head="$1" title="${2:-Empty list still crashes}" body="${3:-Build a widget.}"
  printf '🤖 defect-fix evidence\n'
  jq -cn --arg head "$head" --arg title "$title" --arg body "$body" '{
    version: 1,
    issue: 42,
    pr: {number: 7, url: "https://github.com/o/r/pull/7", branch: "epic/42-add-widget", head: $head},
    requirement: {title: "Add widget", body: $body},
    blockers: [{source: "ship-deferral", reason: $title, items: [{title: $title, severity: "Important", why: "firstItem dereferences items[0] without a guard."}]}]
  }'
}
DEFECTBASE="$TMP/fixtures-defect"
mkdir -p "$DEFECTBASE"
fixture "$DEFECTBASE" defect-fix '{"completed":true,"summary":"Adds the missing empty-list guard (PRIVATE_FIXER_EXPLANATION).","files":["frontend/src/widget.ts"]}'
fixture_sh "$DEFECTBASE" defect-fix 'printf "export const firstItem = items => items.length ? items[0].name : null\n" > frontend/src/widget.ts'
fixture "$DEFECTBASE" defect-check '{"survives":true,"confidence":91,"reasoning":"The exact delta guards the named empty-list dereference and changes no other path."}'
run_defect() {
  local comments
  if [[ -n "${DEFECT_COMMENTS+x}" ]]; then comments="$DEFECT_COMMENTS"
  else comments="$(make_defect_evidence "$(origin_ref epic/42-add-widget)")"
  fi
  GH_ISSUE_LABELS="${DEFECT_LABELS-ready-to-review,needs-defect-fix}" \
  GH_OPEN_PR_BRANCH="${DEFECT_BRANCH-epic/42-add-widget}" \
  SEED_COMMENTS="$comments" \
    run_pipeline "$@"
}

scenario 'defect-run: named gate defects are repaired, checked, and returned to the merge queue'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "RESULT lands ready-to-merge" "$RUN_OUT" '"readyToMerge":true'
assert_contains "RESULT records attempt 1" "$RUN_OUT" '"attempt":1'
assert_eq "the branch on origin was amended" "$(git -C "$WT" rev-parse HEAD)" "$(origin_ref epic/42-add-widget)"
assert_not_contains "the amended head differs from the captured PR head" "$(origin_ref epic/42-add-widget)" "$BEFORE"
assert_eq "the amended branch is still exactly one commit above main" 1 "$(origin_count epic/42-add-widget)"
assert_contains "the commit keeps its Closes line" "$(git -C "$ORIGIN" log -1 --format=%B epic/42-add-widget)" "Closes #42"
assert_contains "the guarded implementation is in the pushed tree" "$(git -C "$ORIGIN" show epic/42-add-widget:frontend/src/widget.ts)" "items.length"
assert_eq "only ready-to-merge and the permanent ladder remain" "defect-attempted,ready-to-merge," "$(gh_labels)"
assert_not_contains "the defect queue label is removed" "$(gh_labels)" "needs-defect-fix"
assert_not_contains "ready-to-review is removed" "$(gh_labels)" "ready-to-review"
assert_contains "the audit comment names the repaired gate" "$(gh_comments)" "Empty list still crashes"
assert_contains "the audit comment records the adversarial confidence" "$(gh_comments)" "91"
assert_contains "the audit says the merge worker re-runs the real checks" "$(gh_comments)" "re-runs the real checks"
assert_eq "one fixer and one skeptic ran" "1 1" "$(calls defect-fix) $(calls defect-check)"
FIXPROMPT="$(cat "$STATE_DIR/defect-fix.0.prompt")"
CHECKPROMPT="$(cat "$STATE_DIR/defect-check.0.prompt")"
assert_contains "the fixer receives the durable named defect" "$FIXPROMPT" "Empty list still crashes"
assert_contains "the fixer receives the pinned original requirement" "$FIXPROMPT" "Build a widget."
assert_contains "the fixer is told to ignore non-defect deferrals" "$FIXPROMPT" "ignore non-defect"
assert_contains "the fixer is forbidden to weaken tests" "$FIXPROMPT" "Never weaken"
assert_contains "the skeptic sees the durable named defect" "$CHECKPROMPT" "Empty list still crashes"
assert_contains "the skeptic is pointed at the exact captured-head delta" "$CHECKPROMPT" "git diff $BEFORE"
assert_not_contains "the skeptic is blind to the fixer's explanation" "$CHECKPROMPT" "PRIVATE_FIXER_EXPLANATION"
assert_eq "verify runs once after the edit" 1 "$(grep -c '^run verify$' "$NPM_LOG")"

scenario 'defect-run: only trusted evidence for the selected PR head can direct the repair'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
VALID="$(make_defect_evidence "$BEFORE" 'Empty list still crashes' 'Pinned original requirement.')"
FORGED="$(make_defect_evidence "$BEFORE" 'ATTACKER CONTROLLED REPAIR' 'ATTACKER REQUIREMENT')"
STALE="$(make_defect_evidence "$MAIN_INITIAL" 'STALE TRUSTED REPAIR' 'STALE REQUIREMENT')"
DEFECT_COMMENTS="$VALID
---
$FORGED
---
$STALE" GH_SEED_COMMENT_AUTHORS="toliki-bot,untrusted-user,toliki-bot" \
  GH_ISSUE_BODY="MUTATED ISSUE BODY PROMPT INJECTION" run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the matching trusted envelope repairs successfully" 0 "$RUN_RC"
FIXPROMPT="$(cat "$STATE_DIR/defect-fix.0.prompt")"
assert_contains "the pinned original requirement is used" "$FIXPROMPT" "Pinned original requirement."
assert_contains "the matching trusted defect is used" "$FIXPROMPT" "Empty list still crashes"
assert_not_contains "a later forged repair instruction is ignored" "$FIXPROMPT" "ATTACKER CONTROLLED REPAIR"
assert_not_contains "a trusted record for another head is ignored" "$FIXPROMPT" "STALE TRUSTED REPAIR"
assert_not_contains "a post-queue issue edit is not re-read" "$FIXPROMPT" "MUTATED ISSUE BODY PROMPT INJECTION"

scenario 'defect-run: untrusted-only evidence refuses before consuming an attempt'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_COMMENTS="$(make_defect_evidence "$BEFORE" 'ATTACKER CONTROLLED REPAIR')" \
  GH_SEED_COMMENT_AUTHORS="untrusted-user" run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the forged brief is refused" 2 "$RUN_RC"
assert_contains "the refusal names trusted matching evidence" "$RUN_OUT" "trusted defect-fix evidence"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_not_contains "no attempt was consumed" "$(gh_labels)" "defect-attempted"
assert_eq "the invalid queue entry is left for review, not redispatch" "ready-to-review," "$(gh_labels)"

scenario 'defect-run: trusted evidence for another head refuses before consuming an attempt'
seed_defect_pr
DEFECT_COMMENTS="$(make_defect_evidence "$MAIN_INITIAL" 'STALE TRUSTED REPAIR')" \
  run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the stale brief is refused" 2 "$RUN_RC"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_not_contains "no attempt was consumed" "$(gh_labels)" "defect-attempted"
assert_eq "the stale queue entry is left for review, not redispatch" "ready-to-review," "$(gh_labels)"

scenario 'defect-run: a fixer that declines leaves the review queue intact'
seed_defect_pr
DECLINE="$TMP/fixtures-defect-decline"; cp -R "$DEFECTBASE" "$DECLINE"; rm -f "$DECLINE/defect-fix.sh"
fixture "$DECLINE" defect-fix '{"completed":false,"escalate":"the durable record does not identify a safe code change."}'
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$DECLINE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the refusal is reported without reclassification" "$RUN_OUT" "escalated"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "no skeptic ran" 0 "$(calls defect-check)"
assert_eq "review state, queue, and ladder are preserved without failed" "defect-attempted,needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_contains "the blocker comment keeps the named reason visible" "$(gh_comments)" "🤖 fix-defect blocked"

scenario 'defect-run: a blocker comment failure cannot strand a declined repair in progress'
seed_defect_pr
GH_BODY_FILE_COMMENT_FAIL=1 run_defect "$DEFECT_RUN" "$DECLINE" --issue 42
assert_rc "the declined repair is still blocked" 3 "$RUN_RC"
assert_eq "review state is restored independently of reporting" "defect-attempted,needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_not_contains "the issue is not stranded in progress" "$(gh_labels)" "in-progress"
assert_not_contains "the issue is never mergeable" "$(gh_labels)" "ready-to-merge"

scenario 'defect-run: a claimed fix with no delta is blocked before verify'
seed_defect_pr
NOOPDEFECT="$TMP/fixtures-defect-noop"; cp -R "$DEFECTBASE" "$NOOPDEFECT"; rm -f "$NOOPDEFECT/defect-fix.sh"
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$NOOPDEFECT" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the reason names the unchanged tree" "$RUN_OUT" "changed no file"
assert_eq "verify and the skeptic never run" "0 0" "$(grep -c '^run verify$' "$NPM_LOG" || true) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "it rests at ready-to-review, never failed" "defect-attempted,needs-defect-fix,ready-to-review," "$(gh_labels)"

scenario 'defect-run: red verification blocks without pushing'
seed_defect_pr
REDDEFECT="$TMP/fixtures-defect-red"; cp -R "$DEFECTBASE" "$REDDEFECT"; printf '1' > "$REDDEFECT/verify.rc"
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$REDDEFECT" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the failure names npm run verify" "$RUN_OUT" "npm run verify is red"
assert_eq "the skeptic never sees a red tree" 0 "$(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "it rests at ready-to-review, never failed" "defect-attempted,needs-defect-fix,ready-to-review," "$(gh_labels)"

scenario 'defect-run: an adversarial refutation blocks a weakened fix'
seed_defect_pr
REFUTEDEFECT="$TMP/fixtures-defect-refuted"; cp -R "$DEFECTBASE" "$REFUTEDEFECT"
fixture "$REFUTEDEFECT" defect-check '{"survives":false,"confidence":15,"reasoning":"The test was deleted instead of the empty-list defect being fixed."}'
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$REFUTEDEFECT" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the skeptic reasoning reaches the blocker" "$RUN_OUT" "test was deleted"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_not_contains "a refuted fix never reaches the merge queue" "$(gh_labels)" "ready-to-merge"
assert_eq "it rests at ready-to-review, never failed" "defect-attempted,needs-defect-fix,ready-to-review," "$(gh_labels)"

scenario 'defect-run: new files are visible in the exact adversarial delta and cleaned after refutation'
seed_defect_pr
NEWFILE="$TMP/fixtures-defect-new-file"; cp -R "$DEFECTBASE" "$NEWFILE"
fixture_sh "$NEWFILE" defect-fix 'printf "test new guard\n" > frontend/src/empty-list.test.ts'
fixture_sh "$NEWFILE" defect-check 'git diff --name-only HEAD > "$STUB_STATE/check-names"; git diff HEAD > "$STUB_STATE/check-diff"'
fixture "$NEWFILE" defect-check '{"survives":false,"confidence":20,"reasoning":"The new regression test does not repair the implementation."}'
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$NEWFILE" --issue 42
assert_rc "the adversarial refutation blocks" 3 "$RUN_RC"
assert_contains "the checker sees the new path" "$(cat "$STATE_DIR/check-names" 2>/dev/null)" "frontend/src/empty-list.test.ts"
assert_contains "the checker sees the new file content" "$(cat "$STATE_DIR/check-diff" 2>/dev/null)" "test new guard"
assert_eq "the refuted intent-to-add tree and index are clean" "" "$(git -C "$WT" status --porcelain)"
assert_eq "the unseen file was never pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'defect-run: confidence below 75 blocks even when survives is true'
seed_defect_pr
LOWDEFECT="$TMP/fixtures-defect-low-confidence"; cp -R "$DEFECTBASE" "$LOWDEFECT"
fixture "$LOWDEFECT" defect-check '{"survives":true,"confidence":74,"reasoning":"The guard looks plausible, but the adjacent path could not be confirmed."}'
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$LOWDEFECT" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the below-threshold confidence is reported" "$RUN_OUT" "confidence 74"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_not_contains "an uncertain fix never reaches the merge queue" "$(gh_labels)" "ready-to-merge"

scenario 'defect-run: failed merge-label readback is actively demoted to review on the first attempt'
seed_defect_pr
GH_LABEL_READ_FAIL_AT=2 run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the unverified handoff blocks" 3 "$RUN_RC"
assert_contains "the ship blocker names label verification" "$RUN_OUT" "label swap could not be verified"
assert_eq "ready-to-merge is removed during review restoration" "defect-attempted,ready-to-review," "$(gh_labels)"

scenario 'defect-run: failed merge-label readback is actively demoted to review on the retry'
seed_defect_pr
DEFECT_LABELS="ready-to-review,needs-defect-fix,defect-attempted" GH_LABEL_READ_FAIL_AT=2 \
  run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the unverified retry handoff blocks" 3 "$RUN_RC"
assert_eq "ready-to-merge is absent and the bounded ladder remains" "defect-attempted,defect-retried,ready-to-review," "$(gh_labels)"

scenario 'defect-run: missing durable evidence refuses without a model or push'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_COMMENTS='🤖 deferred / not done

- Empty list still crashes (defect): Legacy, unbound prose is not repair authority.' \
  run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 2 (skipped/refused before work)" 2 "$RUN_RC"
assert_contains "the refusal names the missing trusted envelope" "$RUN_OUT" "trusted defect-fix evidence"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_not_contains "the issue never reaches the merge queue" "$(gh_labels)" "ready-to-merge"
assert_not_contains "invalid evidence does not consume an attempt" "$(gh_labels)" "defect-attempted"
assert_not_contains "invalid evidence is removed from autonomous dispatch" "$(gh_labels)" "needs-defect-fix"

scenario 'defect-run: a completed status without the deferred record also refuses'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_COMMENTS='🤖 **epic-run** · `myapp-epic-42` · phase: **finished**

**done, held for review** — https://github.com/o/r/pull/7 (1 deferred defect(s) that still exist on main after this merge)' \
  run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 2 (skipped/refused before work)" 2 "$RUN_RC"
assert_contains "the refusal names the missing trusted envelope" "$RUN_OUT" "trusted defect-fix evidence"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'defect-run: a branch that moved after the PR read fails closed'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_COMMENTS="$(make_defect_evidence "$MAIN_INITIAL")" GH_PR_HEAD="$MAIN_INITIAL" \
  run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the mismatch names the moved branch" "$RUN_OUT" "moved under the fixer"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'defect-run: a fork PR with the same branch name cannot make the origin PR ambiguous'
seed_defect_pr
GH_FORK_PR=1 run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the same-repository PR is repaired" 0 "$RUN_RC"
assert_eq "one fixer and one skeptic ran" "1 1" "$(calls defect-fix) $(calls defect-check)"
assert_contains "the selected origin PR is reported" "$RUN_OUT" "https://github.com/o/r/pull/7"

scenario 'defect-run: a fork-only PR cannot reach an agent even with the origin ref oid'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
GH_ONLY_FORK_PR=1 run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the fork-only shape is a final refusal" 2 "$RUN_RC"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "the origin branch is untouched" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "the issue is removed from autonomous repair" "failed," "$(gh_labels)"

scenario 'defect-run: a stale PR head after push blocks label promotion'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
GH_POST_PUSH_PR_HEAD="$BEFORE" run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "the stale post-push PR observation blocks" 3 "$RUN_RC"
assert_contains "the blocker names the PR head mismatch" "$RUN_OUT" "PR head"
assert_not_contains "a stale PR never reaches the merge queue" "$(gh_labels)" "ready-to-merge"
assert_contains "the fixed branch did push before the stale observation" "$(git -C "$ORIGIN" show epic/42-add-widget:frontend/src/widget.ts)" "items.length"

scenario 'defect-run: a branch with two commits is not an amendable epic shape'
seed_branch epic/42-add-widget main 'printf "one\n" > frontend/src/widget.ts && git add -A && git commit -qm "Add widget" -m "Closes #42" && printf "two\n" >> frontend/src/widget.ts && git commit -qam "second commit"'
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the reason names the branch shape" "$RUN_OUT" "commit(s) above origin/main"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'defect-run: no verifiable package refuses the repair'
seed_branch epic/42-add-widget main 'git rm -q frontend/package.json && git commit -qm "Add widget" -m "Closes #42"'
BEFORE="$(origin_ref epic/42-add-widget)"
run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "the refusal names missing verification" "$RUN_OUT" "no package declaring"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'defect-run: the retry is counted independently and then rests for a human'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_LABELS="ready-to-review,needs-defect-fix,defect-attempted" run_defect "$DEFECT_RUN" "$DECLINE" --issue 42
assert_rc "exits 3 (blocked)" 3 "$RUN_RC"
assert_contains "RESULT records attempt 2" "$RUN_OUT" '"attempt":2'
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "both permanent ladder labels and the review queue remain" "defect-attempted,defect-retried,needs-defect-fix,ready-to-review," "$(gh_labels)"
assert_contains "the blocker says this was the retry" "$(gh_comments)" "RETRY"

scenario 'defect-run: an exhausted ladder refuses without waking a model'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_LABELS="ready-to-review,needs-defect-fix,defect-attempted,defect-retried" run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 2 (skipped/refused)" 2 "$RUN_RC"
assert_contains "the reason names the exhausted ladder" "$RUN_OUT" "attempt ladder exhausted"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "automation never resets the ladder or review state" "defect-attempted,defect-retried,needs-defect-fix,ready-to-review," "$(gh_labels)"

scenario 'defect-run: missing queue label is not a defect-fixer issue'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_LABELS="ready-to-review" run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 2 (skipped)" 2 "$RUN_RC"
assert_contains "the reason names the required label" "$RUN_OUT" "not labelled needs-defect-fix"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"

scenario 'defect-run: no open epic PR is a final refusal'
BEFORE="$(origin_ref epic/42-add-widget)"
DEFECT_BRANCH= GH_BODY_FILE_COMMENT_FAIL=1 run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 2 (skipped/refused)" 2 "$RUN_RC"
assert_contains "the reason names the missing PR" "$RUN_OUT" "no open PR"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "no-PR is failed and removed from autonomous repair even when reporting fails" "failed," "$(gh_labels)"
NO_PR_LABELS="$(gh_labels)"; NO_PR_LABELS="${NO_PR_LABELS%,}"
DEFECT_LABELS="$NO_PR_LABELS" DEFECT_BRANCH= run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_contains "another launch sees it is no longer in the queue" "$RUN_OUT" "not labelled needs-defect-fix"
assert_not_contains "the final structural refusal is not posted again" "$(gh_comments)" "fix-defect refused: no open PR"

scenario 'defect-run: multiple open epic PRs are ambiguous and refused'
seed_defect_pr
BEFORE="$(origin_ref epic/42-add-widget)"
GH_OPEN_PR_COUNT=2 run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_rc "exits 2 (skipped/refused)" 2 "$RUN_RC"
assert_contains "the reason names the ambiguity" "$RUN_OUT" "multiple open PRs"
assert_eq "no model ran" "0 0" "$(calls defect-fix) $(calls defect-check)"
assert_eq "nothing was pushed" "$BEFORE" "$(origin_ref epic/42-add-widget)"
assert_eq "ambiguous PRs are left for review and removed from autonomous repair" "ready-to-review," "$(gh_labels)"
MULTI_LABELS="$(gh_labels)"; MULTI_LABELS="${MULTI_LABELS%,}"
DEFECT_LABELS="$MULTI_LABELS" GH_OPEN_PR_COUNT=2 run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
assert_contains "another launch sees ambiguity is no longer queued" "$RUN_OUT" "not labelled needs-defect-fix"
assert_not_contains "the final ambiguity refusal is not posted again" "$(gh_comments)" "fix-defect refused: multiple open PRs"

# The queue label and its canonical evidence are one invariant. Carry the real
# comments and labels produced by epic-run into a fresh defect-run process;
# never seed a hand-written replacement brief for these handoff scenarios.
assert_defect_handoff() { # name epic-fixtures expected blocker text
  local name="$1" epic_fixtures="$2" expected="$3" comments labels
  scenario "epic-run -> defect-run: $name carries its complete durable repair brief"
  run_pipeline "$EPIC_RUN" "$epic_fixtures" --issue 42
  assert_rc "$name epic finishes held" 0 "$RUN_RC"
  assert_contains "$name enters the bounded repair queue" "$(gh_labels)" "needs-defect-fix"
  comments="$(gh_comments)"; labels="$(gh_labels)"; labels="${labels%,}"
  DEFECT_LABELS="$labels" DEFECT_COMMENTS="$comments" run_defect "$DEFECT_RUN" "$DEFECTBASE" --issue 42
  assert_rc "$name evidence is accepted without synthetic comments" 0 "$RUN_RC"
  assert_contains "$name blocker reaches the fixer" "$(cat "$STATE_DIR/defect-fix.0.prompt")" "$expected"
}
assert_defect_handoff "triage deferral" "$HELD" "Null deref on empty list"
assert_defect_handoff "unconfirmed fix" "$UNFIXED" "Null deref on empty list"
assert_defect_handoff "fix regression" "$REGRESS" "Guard breaks the non-empty path"
assert_defect_handoff "claimed no-delta fix" "$NODIFF" "fixes step changed nothing"
assert_defect_handoff "ship deferral" "$DEFER" "Second defect"

# ───────────────────── defect grouping (restatements across files) ─────────────────────
# Five blind lenses reporting one fault is the design working — it is how #66's migration
# bug was caught five times over — but the fixer must not then fix and gate that fault five
# times. The skeptic links restatements with sameDefectAs; the script unions them into
# defects and tells the fixer, WITHOUT dropping any finding.
scenario 'grouping: restatements across files become one defect for the fixer'
GROUP="$TMP/fixtures-group"
cp -R "$BASE" "$GROUP"
fixture "$GROUP" lens-correctness '{"findings":[{"title":"Unusable schedule does not block submit","severity":"Critical","confidence":90,"location":"src/dialog.tsx:40","problem":"Submit stays enabled.","fix":"Block it.","gate":"unit test"}]}'
fixture "$GROUP" lens-simplicity '{"findings":[{"title":"Block gate tests the wrong condition","severity":"Important","confidence":85,"location":"src/gate.ts:12","problem":"Checks null, not empty.","fix":"Check emptiness.","gate":"unit test"}]}'
fixture "$GROUP" lens-seam '{"findings":[{"title":"Test asserts the wrong guard","severity":"Important","confidence":80,"location":"src/gate.test.ts:8","problem":"Encodes the wrong rule.","fix":"Assert emptiness.","gate":"unit test"}]}'
# One skeptic sees all three (one batch) and links 2 and 3 back to 1.
fixture "$GROUP" verify '{"verdicts":[
  {"index":1,"real":true,"confidence":90,"reasoning":"Confirmed."},
  {"index":2,"real":true,"confidence":88,"reasoning":"Same fault as 1.","sameDefectAs":1},
  {"index":3,"real":true,"confidence":85,"reasoning":"Same fault as 1.","sameDefectAs":1}]}'
run_pipeline "$EPIC_RUN" "$GROUP" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "one batch, not one per file" "$RUN_OUT" "in 1 batch(es)"
assert_contains "the tally keeps BOTH counts" "$RUN_OUT" "3 confirmed by adversarial verification, which are 1 distinct defect(s)"
TRIAGE_PROMPT="$(cat "$STATE_DIR/triage.0.prompt")"
assert_contains "the fixer is told they are one defect" "$TRIAGE_PROMPT" "SAME underlying defect"
assert_contains "grouping lists every finding, losing none" "$TRIAGE_PROMPT" "Block gate tests the wrong condition"
assert_contains "...including the third" "$TRIAGE_PROMPT" "Test asserts the wrong guard"
assert_contains "the grouping is advisory, not an order" "$TRIAGE_PROMPT" "hint, not an instruction"

scenario 'grouping: distinct defects stay distinct'
DISTINCT="$TMP/fixtures-distinct"
cp -R "$GROUP" "$DISTINCT"
fixture "$DISTINCT" verify '{"verdicts":[
  {"index":1,"real":true,"confidence":90,"reasoning":"Confirmed."},
  {"index":2,"real":true,"confidence":88,"reasoning":"Distinct fault."},
  {"index":3,"real":true,"confidence":85,"reasoning":"Distinct fault."}]}'
run_pipeline "$EPIC_RUN" "$DISTINCT" --issue 42
assert_rc "exits 0" 0 "$RUN_RC"
assert_not_contains "no defect collapsing is claimed" "$RUN_OUT" "distinct defect(s)"
TRIAGE_PROMPT="$(cat "$STATE_DIR/triage.0.prompt")"
assert_not_contains "and the fixer is told nothing about groups" "$TRIAGE_PROMPT" "SAME underlying defect"

# ───────────────────── the issue's live status comment ─────────────────────
# The label says WHICH state an issue is in; this says whether the run is alive
# and where it got to — the one question that otherwise needs ssh + capture-pane.
# It must be posted ONCE and edited thereafter: a comment per phase is the thing
# that made per-phase commentary not worth having.
scenario 'status comment: posted once, edited in place, ends with the outcome'
run_pipeline "$EPIC_RUN" "$BASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
GH="$(cat "$GH_LOG")"
CREATES="$(grep -c '^issue comment 42' "$GH_LOG" || true)"
EDITS="$(grep -c 'issues/comments/999001' "$GH_LOG" || true)"
assert_eq "exactly one comment is created" "1" "$CREATES"
if [[ "$EDITS" -ge 1 ]]; then ok "later updates edit that comment ($EDITS)"; else nok "later updates edit that comment (got $EDITS)"; fi
assert_contains "it names the phase and the session" "$GH" "epic-run"
assert_contains "and the session name" "$GH" "myapp-epic-42"
assert_contains "the last write reports the outcome" "$GH" "queued for the merge worker"

# GitHub renders every bare #N as that issue/PR's TITLE, so numbering findings
# "#1, #2, #3" in the PR body splices three unrelated PR titles into the review
# section — which is exactly what shipped on vms#69's PR before this rule.
SHIP_PROMPT="$(cat "$STATE_DIR/ship.0.prompt")"
assert_contains "ship is told not to number anything with a bare #N" "$SHIP_PROMPT" "Never write a bare"
assert_contains "and told what GitHub does with one" "$SHIP_PROMPT" "renders it as that issue or PR"

scenario 'status comment: the final outcome lands even with an edit in flight'
# Every phase change forces a write; a slow edit means one is still in flight
# when the run finishes. The final write must queue behind it, not be dropped —
# otherwise the comment shows an earlier phase for as long as the issue is open.
GH_SLOW_PATCH=1 run_pipeline "$EPIC_RUN" "$BASE" --issue 42 --session myapp-epic-42
assert_rc "exits 0" 0 "$RUN_RC"
assert_contains "the last write still reports the outcome" "$(cat "$GH_LOG")" "queued for the merge worker"

scenario 'status comment: a blocked run says so on the issue'
run_pipeline "$EPIC_RUN" "$DEADLENS" --issue 42 --session myapp-epic-42
GH="$(cat "$GH_LOG")"
assert_contains "the status comment records the block" "$GH" "blocked"

scenario 'status comment: a fixer run says fix-run, not epic-run'
seed_conflict
run_fix "$FIXBASE" --issue 42 --session myapp-epic-42
GH="$(cat "$GH_LOG")"
assert_contains "the comment names fix-run" "$GH" "fix-run"
assert_not_contains "and never claims to be epic-run" "$GH" "**epic-run**"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
