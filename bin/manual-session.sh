#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host.  Stops only exact sessions, and applies the stronger
# process/workspace guarantees only when durable manual ownership is proven.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"
source "$HERE/manual-session.lib.sh"

usage() {
  cat <<EOF
Usage: $0 list
       $0 stop --repo <repo> <session>
       $0 stop-manual
       $0 remove-workspace --repo <repo> <session>

stop retains every worktree and branch. stop-manual stops only proven Toliki
manual sessions and owned processes across registered repos. remove-workspace
is separate and refuses dirty, untracked, unmerged, active, or ambiguous work.
EOF
}

ACTION="${1:-}"
[[ $# -eq 0 ]] || shift
REPO=""
SESSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--repo) [[ $# -ge 2 ]] || { echo "[manual] $1 requires a value" >&2; exit 1; }; REPO="$2"; shift 2 ;;
    -r=*|--repo=*) REPO="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) [[ -z "$SESSION" ]] || { echo "[manual] takes one session name" >&2; exit 1; }; SESSION="$1"; shift ;;
  esac
done

tmux_kind() { tmux show-options -t "=$1" -qv @toliki_kind 2>/dev/null || true; }

stop_manual() { # repo, exact session
  local repo="$1" session="$2" kind rc=0
  if manual_load "$repo" "$session"; then
    :
  else
    rc=$?
    [[ $rc -ne 2 ]] || echo "[manual] $MANUAL_ERROR" >&2
    echo "[manual] '$session' is not a proven Toliki manual session; leaving it and its processes alone" >&2
    return 1
  fi
  if tmux has-session -t "=$session" 2>/dev/null; then
    kind="$(tmux_kind "$session")"
    if [[ "$kind" != manual ]]; then
      echo "[manual] '$session' has manual workspace metadata but its live tmux identity is '${kind:-missing}'; leaving it untouched" >&2
      return 1
    fi
    if tmux kill-session -t "=$session"; then
      echo "[manual] '$session': stopped tmux session; workspace retained at $MANUAL_WORKTREE"
    else
      echo "[manual] '$session': tmux refused the stop" >&2
      rc=1
    fi
  else
    echo "[manual] '$session': no tmux session running; workspace retained at $MANUAL_WORKTREE"
  fi
  manual_stop_owned_processes "$session" "$MANUAL_TOKEN" || rc=1
  return "$rc"
}

case "$ACTION" in
  stop)
    [[ -n "$REPO" && -n "$SESSION" ]] || { usage >&2; exit 1; }
    if [[ "$SESSION" =~ ^${REPO}-epic-[0-9]+$ ]]; then
      # Preserve the historical exact named-stop behavior for pipelines.
      if tmux has-session -t "=$SESSION" 2>/dev/null; then
        tmux kill-session -t "=$SESSION"
        echo "[manual] stopped pipeline session '$SESSION' (its worktree was retained)"
      else
        echo "[manual] no session '$SESSION' to stop"
      fi
    else
      stop_manual "$REPO" "$SESSION"
    fi
    ;;
  stop-manual)
    [[ -z "$REPO$SESSION" ]] || { usage >&2; exit 1; }
    rc=0 found=0
    while IFS= read -r repo; do
      while IFS= read -r session; do
        [[ -n "$session" ]] || continue
        found=$((found + 1))
        stop_manual "$repo" "$session" || rc=1
      done < <(manual_sessions_for_repo "$repo")
    done < <(repo_names)
    # A live manual tag without matching durable metadata is ambiguous: report
    # it, never silently exempt it from the safety proof.
    while IFS= read -r session; do
      [[ -n "$session" ]] || continue
      [[ "$(tmux_kind "$session")" == manual ]] || continue
      repo="$(tmux show-options -t "=$session" -qv @repo 2>/dev/null || true)"
      if [[ -z "$repo" ]] || ! manual_load "$repo" "$session" 2>/dev/null; then
        echo "[manual] '$session' is tagged manual but has no recognizable workspace metadata; leaving it untouched" >&2
        rc=1
      fi
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
    (( found > 0 )) || echo "[manual] no proven Toliki manual sessions"
    exit "$rc"
    ;;
  remove-workspace)
    [[ -n "$REPO" && -n "$SESSION" ]] || { usage >&2; exit 1; }
    if manual_load "$REPO" "$SESSION"; then
      :
    else
      rc=$?; [[ $rc -ne 2 ]] || echo "[manual] $MANUAL_ERROR" >&2
      echo "[manual] cannot prove ownership of '$SESSION'; nothing removed" >&2
      exit 1
    fi
    if tmux has-session -t "=$SESSION" 2>/dev/null || [[ -n "$(manual_owned_pids "$MANUAL_TOKEN")" ]]; then
      echo "[manual] '$SESSION' is still active; stop it first. Nothing removed." >&2
      exit 1
    fi
    if [[ -n "$(git -C "$MANUAL_WORKTREE" status --porcelain --untracked-files=all)" ]]; then
      echo "[manual] '$MANUAL_WORKTREE' has dirty or untracked work; nothing removed" >&2
      exit 1
    fi
    if ! git -C "$MANUAL_PROJECT" fetch origin main; then
      echo "[manual] cannot refresh origin/main to prove '$MANUAL_BRANCH' is merged; nothing removed" >&2
      exit 1
    fi
    if ! git -C "$MANUAL_PROJECT" show-ref --verify --quiet refs/remotes/origin/main; then
      echo "[manual] cannot prove '$MANUAL_BRANCH' is merged: origin/main is missing; nothing removed" >&2
      exit 1
    fi
    if ! git -C "$MANUAL_PROJECT" merge-base --is-ancestor "$MANUAL_BRANCH" refs/remotes/origin/main; then
      echo "[manual] '$MANUAL_BRANCH' has local commits not merged into origin/main; nothing removed" >&2
      exit 1
    fi
    branch_tip="$(git -C "$MANUAL_PROJECT" rev-parse "refs/heads/$MANUAL_BRANCH")"
    git -C "$MANUAL_PROJECT" worktree remove "$MANUAL_WORKTREE"
    git -C "$MANUAL_PROJECT" update-ref -d "refs/heads/$MANUAL_BRANCH" "$branch_tip"
    git -C "$MANUAL_PROJECT" config --remove-section "toliki-manual.$SESSION"
    echo "[manual] removed workspace '$MANUAL_WORKTREE' and branch '$MANUAL_BRANCH'"
    ;;
  list)
    [[ -z "$REPO$SESSION" ]] || { usage >&2; exit 1; }
    printf '%-28s %-10s %-8s %-9s %s\n' SESSION REPO CLIENT KIND STATE
    seen=$'\n'
    while IFS= read -r session; do
      [[ -n "$session" ]] || continue
      repo="$(tmux show-options -t "=$session" -qv @repo 2>/dev/null || true)"
      engine="$(tmux show-options -t "=$session" -qv @engine 2>/dev/null || true)"
      kind="$(tmux_kind "$session")"
      pane="$(tmux list-panes -t "=$session" -F '#{pane_current_command}' 2>/dev/null | head -n1 || true)"
      case "$pane" in bash|zsh|sh|dash|'') state=stopped ;; *) state=running ;; esac
      if [[ -z "$kind" && "$session" =~ -epic-[0-9]+$ ]]; then kind=pipeline; fi
      if [[ -z "$kind" && -n "$repo" ]] && project="$(repo_path "$repo" 2>/dev/null)" && manual_find_legacy_worktree "$project" "$session"; then
        kind=manual-legacy
        engine=claude
      fi
      if [[ "$kind" == manual ]] && { [[ -z "$repo" ]] || ! manual_load "$repo" "$session" 2>/dev/null; }; then
        kind=manual?
        state=ambiguous
      fi
      printf '%-28s %-10s %-8s %-9s %s\n' "$session" "${repo:--}" "${engine:--}" "${kind:-unknown}" "$state"
      seen+="$session"$'\n'
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
    while IFS= read -r repo; do
      while IFS= read -r session; do
        [[ -n "$session" && "$seen" != *$'\n'"$session"$'\n'* ]] || continue
        if manual_load "$repo" "$session"; then
          printf '%-28s %-10s %-8s %-9s %s\n' "$session" "$repo" "$MANUAL_ENGINE" manual stopped
        else
          printf '%-28s %-10s %-8s %-9s %s\n' "$session" "$repo" - manual ambiguous
        fi
      done < <(manual_sessions_for_repo "$repo")
    done < <(repo_names)
    ;;
  -h|--help|'') usage; [[ -n "$ACTION" ]] || exit 1 ;;
  *) echo "[manual] unknown action '$ACTION'" >&2; usage >&2; exit 1 ;;
esac
