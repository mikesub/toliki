#!/usr/bin/env bash
set -euo pipefail

# Runs ON the host, from cron: one merge tick. bin/merge-worker.sh is strictly
# per-repo — serial WITHIN a repo is forced (each merge moves that repo's main),
# while across repos there is nothing to serialize — so this wrapper is what
# turns the registry into one cron line: it fires one worker per registered
# repo, concurrently, and exits non-zero if any of them did. It exists so the
# cron file doesn't hardcode the repo list — etc/repos.conf stays the only
# registry, and "adding a repo" stays three steps.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

PIDS=()
while IFS= read -r repo; do
  "$HERE/merge-worker.sh" -r "$repo" &
  PIDS+=($!)
done < <(repo_names)

RC=0
for pid in "${PIDS[@]}"; do
  wait "$pid" || RC=1
done
exit "$RC"
