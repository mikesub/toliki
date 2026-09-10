#!/usr/bin/env bash

# Shared host-side ownership rules for persistent interactive workspaces.
# Callers source etc/lib.sh first.  Manual identity is durable repository-local
# metadata; a tmux name or executable name alone is never sufficient proof.

manual_default_branch() { printf 'manual/%s' "$2"; }
manual_default_worktree() {
  printf '%s/%s/%s' "${MANUAL_WORKTREE_ROOT:-$HOME/.toliki-worktrees}" "$1" "$2"
}

manual_config_get() { # project, session, key
  git -C "$1" config --get "toliki-manual.$2.$3" 2>/dev/null || true
}

manual_load() { # repo, session; fills MANUAL_*; 0 owned, 1 absent, 2 ambiguous
  local repo="$1" session="$2" project branch worktree engine token recorded_repo top actual_branch canonical_worktree canonical_top
  project="$(repo_path "$repo")" || return 2
  recorded_repo="$(manual_config_get "$project" "$session" repo)"
  branch="$(manual_config_get "$project" "$session" branch)"
  worktree="$(manual_config_get "$project" "$session" worktree)"
  engine="$(manual_config_get "$project" "$session" engine)"
  token="$(manual_config_get "$project" "$session" token)"
  if [[ -z "$recorded_repo$branch$worktree$engine$token" ]]; then
    return 1
  fi
  if [[ "$recorded_repo" != "$repo" || -z "$branch" || -z "$worktree" || \
        ( "$engine" != claude && "$engine" != codex ) || -z "$token" ]]; then
    MANUAL_ERROR="manual metadata for '$session' in $project is incomplete or inconsistent; leaving it untouched"
    return 2
  fi
  if [[ ! -d "$worktree" ]] || ! top="$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" || \
     ! canonical_worktree="$(cd "$worktree" && pwd -P)" || ! canonical_top="$(cd "$top" && pwd -P)" || \
     [[ "$canonical_top" != "$canonical_worktree" ]] || ! actual_branch="$(git -C "$worktree" symbolic-ref --quiet --short HEAD 2>/dev/null)" || \
     [[ "$actual_branch" != "$branch" ]]; then
    MANUAL_ERROR="manual metadata for '$session' points to '$worktree' on '$branch', but that workspace is missing or different; leaving it untouched"
    return 2
  fi
  MANUAL_REPO="$repo"
  MANUAL_SESSION="$session"
  MANUAL_PROJECT="$project"
  MANUAL_BRANCH="$branch"
  MANUAL_WORKTREE="$worktree"
  MANUAL_ENGINE="$engine"
  MANUAL_TOKEN="$token"
  return 0
}

manual_record() { # project, session, repo, branch, worktree, engine, token
  local project="$1" session="$2"
  git -C "$project" config "toliki-manual.$session.repo" "$3" &&
    git -C "$project" config "toliki-manual.$session.branch" "$4" &&
    git -C "$project" config "toliki-manual.$session.worktree" "$5" &&
    git -C "$project" config "toliki-manual.$session.engine" "$6" &&
    git -C "$project" config "toliki-manual.$session.token" "$7"
}

manual_find_legacy_worktree() { # project, session; fills LEGACY_*; 0 unique
  local project="$1" session="$2" line path="" branch="" count=0 ambiguous=0
  LEGACY_WORKTREE=""
  LEGACY_BRANCH=""
  LEGACY_AMBIGUOUS=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      worktree\ *) path="${line#worktree }"; branch="" ;;
      branch\ refs/heads/*) branch="${line#branch refs/heads/}" ;;
      '')
        if [[ -n "$path" && "$path" != "$project" && "${path##*/}" == "$session" ]]; then
          if [[ "$path" == */.claude/worktrees/"$session" && -n "$branch" && "$branch" != epic/* ]]; then
            count=$((count + 1)); LEGACY_WORKTREE="$path"; LEGACY_BRANCH="$branch"
          else
            ambiguous=$((ambiguous + 1))
          fi
        fi
        path=""; branch=""
        ;;
    esac
  done < <(git -C "$project" worktree list --porcelain; printf '\n')
  if (( count == 1 && ambiguous == 0 )); then return 0; fi
  (( count == 0 && ambiguous == 0 )) || LEGACY_AMBIGUOUS=1
  return 1
}

manual_owned_pids() { # ownership token; prints exact currently-owned pids
  local token="$1" proc pid env
  for proc in /proc/[0-9]*; do
    [[ -r "$proc/environ" ]] || continue
    pid="${proc##*/}"
    [[ "$pid" != "$$" ]] || continue
    env="$(tr '\0' '\n' < "$proc/environ" 2>/dev/null || true)"
    if grep -qxF "TOLIKI_MANUAL_OWNER=$token" <<<"$env"; then
      printf '%s\n' "$pid"
    fi
  done
}

manual_stop_owned_processes() { # session, token; bounded, verified
  local session="$1" token="$2" pids pid tries survivors=""
  pids="$(manual_owned_pids "$token")"
  [[ -n "$pids" ]] || { echo "[manual] '$session': no owned client processes running"; return 0; }
  while IFS= read -r pid; do kill -TERM "$pid" 2>/dev/null || true; done <<<"$pids"
  tries=0
  while (( tries < 25 )); do
    survivors="$(manual_owned_pids "$token")"
    [[ -z "$survivors" ]] && break
    sleep 0.2
    tries=$((tries + 1))
  done
  if [[ -n "$survivors" ]]; then
    while IFS= read -r pid; do kill -KILL "$pid" 2>/dev/null || true; done <<<"$survivors"
    sleep 0.2
  fi
  survivors="$(manual_owned_pids "$token")"
  if [[ -n "$survivors" ]]; then
    echo "[manual] '$session': could not stop owned process(es): ${survivors//$'\n'/ }" >&2
    return 1
  fi
  echo "[manual] '$session': stopped owned client processes"
}

manual_sessions_for_repo() { # repo; prints durable session names
  local project key value
  project="$(repo_path "$1")" || return 0
  git -C "$project" config --get-regexp '^toliki-manual\..*\.repo$' 2>/dev/null |
    while read -r key value; do
      [[ "$value" == "$1" ]] || continue
      key="${key#toliki-manual.}"
      printf '%s\n' "${key%.repo}"
    done
}
