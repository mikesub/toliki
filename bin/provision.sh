#!/usr/bin/env bash
set -euo pipefail

# Idempotent rebuild of the VPS host: bare Ubuntu -> a box that runs detached
# Claude sessions and Claude/Codex pipeline runs. Runs ON the host, never
# over ssh from the laptop.
#
# Bootstrap on a fresh box (the only hand-typed part):
#
#   sudo apt-get update && sudo apt-get install -y git gh
#   gh auth login
#   gh repo clone mikesub/toliki /home/ubuntu/toliki
#   cd /home/ubuntu/toliki && cp etc/repos.conf.template etc/repos.conf
#   # edit etc/repos.conf (your repos, origins), then:
#   bin/provision.sh
#
# Re-running on a healthy box is a no-op that reports state — every step says
# what it found and what it changed, and nothing is reinstalled just because
# the script ran. Versions already present are left alone rather than upgraded:
# a provision run should not be able to move node or the CLIs under a fleet of
# live sessions.
#
# The things a script fundamentally cannot do — credentialed logins, the
# per-clone workspace-trust dialog, and the bypass-permissions acceptance, all
# one-time interactive consent — are detected, printed as an exact checklist at
# the end, and make the run exit non-zero until they're done.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/../etc/lib.sh"

usage() {
  cat <<EOF
Usage: $0 [-h]

Provisions this Ubuntu host for the coding-agent harness: system packages,
node 24, gh, docker (+ build-cache GC), supabase CLI, Claude Code, Codex CLI,
Bun, clones of the control repo and every repo in etc/repos.conf, and the
~/.claude wiring (/spec and spec-explorer symlinks). Safe to re-run;
reports state and exits non-zero while any manual step is outstanding.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

NODE_MAJOR=24                       # CI pins 24; the host must match it
DOCKER_CONFIG_SRC="$HERE/../etc/docker-daemon.json"
DOCKER_CONFIG_DST="/etc/docker/daemon.json"
LOGROTATE_SRC="$HERE/../etc/harness-logs.logrotate"
LOGROTATE_DST="/etc/logrotate.d/harness-logs"
# Where etc/docker-daemon.json was vendored FROM is machine-local knowledge:
# GC_UPSTREAM_REPO/GC_UPSTREAM_REL in etc/repos.conf, empty when no upstream
# is being tracked (the provenance check below then skips).

CHANGES=()
WARNINGS=()
BLOCKERS=()

say()     { printf '\n[provision] %s\n' "$*"; }
ok()      { printf '  ok       %s\n' "$*"; }
changed() { printf '  CHANGED  %s\n' "$*"; CHANGES+=("$*"); }
warn()    { printf '  warn     %s\n' "$*"; WARNINGS+=("$*"); }
blocked() { printf '  BLOCKED  %s\n' "$*"; BLOCKERS+=("$*"); }
note()    { printf '           %s\n' "$*"; }

# First line of a version probe, or "?" — a probe that misbehaves must not take
# the run down through `set -e` from inside a reporting string.
ver() { local out; out="$("$@" 2>/dev/null | head -n1)" || out=""; printf '%s' "${out:-?}"; }

# Agent CLIs are deliberately only provisioned and authenticated in this slice.
# Keeping their install logic and Codex's auth gate in a sourced helper makes
# them hermetically testable without a test-only mode in this provisioner.
source "$HERE/provision-agent-clis.lib.sh"
source "$HERE/../etc/wire-claude-content.sh"

# ---------------------------------------------------------------- preflight --

say "preflight"

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "[provision] not root and no sudo available" >&2
    exit 1
  fi
  SUDO="sudo"
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  ok "os: ${PRETTY_NAME:-unknown}"
  if [[ "${ID:-}" != "ubuntu" ]]; then
    warn "not Ubuntu — the apt sources below assume Ubuntu package names"
  fi
  UBUNTU_CODENAME="${VERSION_CODENAME:-noble}"
else
  warn "no /etc/os-release; assuming Ubuntu noble"
  UBUNTU_CODENAME="noble"
fi

ARCH="$(dpkg --print-architecture)"
CPUS="$(nproc)"
# Workflow agent concurrency is capped at min(16, cores - 2) per workflow, so
# vCPU count is the direct lever on how much an epic run can fan out (the old
# 4-vCPU box capped a workflow at 2 concurrent agents).
CAP=$(( CPUS - 2 ))
if (( CAP > 16 )); then CAP=16; fi
if (( CAP < 1 )); then CAP=1; fi
ok "arch $ARCH, $CPUS vCPU -> workflow concurrency cap $CAP"
if (( CPUS < 6 )); then
  warn "$CPUS vCPU is below the 6-8 target; workflows will fan out to $CAP agents"
fi

# The harness wiring (~/.claude symlinks, settings.json) lands in $HOME, while
# the clones live under the registry's paths. On a box where those disagree the
# sessions would read a different ~/.claude than the one provisioned here.
EXPECTED_HOME="$(dirname "$HOST_CONTROL_DIR")"
ok "running as $(id -un), HOME=$HOME"
if [[ "$HOME" != "$EXPECTED_HOME" ]]; then
  warn "clones live under $EXPECTED_HOME but HOME is $HOME — ~/.claude wiring will land in $HOME; run this as the user that owns the clones"
fi

# ------------------------------------------------------------ apt machinery --

APT_UPDATED=0

apt_update_once() {
  if [[ $APT_UPDATED -eq 0 ]]; then
    $SUDO apt-get update -qq
    APT_UPDATED=1
  fi
}

# Install only the packages actually missing, so a healthy box does no work and
# the report distinguishes "found" from "installed".
apt_install() {
  local missing=() p
  for p in "$@"; do
    dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    ok "present: $*"
    return 0
  fi
  apt_update_once
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "${missing[@]}"
  changed "installed: ${missing[*]}"
}

# Register a third-party apt source (keyring + one source line). No-op when
# both are already in place; otherwise forces the next apt-get update so the
# new source is actually fetched before we install from it.
add_apt_source() {
  local name="$1" key_url="$2" dearmor="$3" line="$4"
  local key="/etc/apt/keyrings/$name.gpg"
  local list="/etc/apt/sources.list.d/$name.list"

  if [[ -s "$key" && -f "$list" ]] && grep -qxF "$line" "$list"; then
    ok "apt source '$name' registered"
    return 0
  fi
  $SUDO install -m 0755 -d /etc/apt/keyrings
  if [[ ! -s "$key" ]]; then
    if [[ "$dearmor" == "dearmor" ]]; then
      curl -fsSL "$key_url" | $SUDO gpg --batch --yes --dearmor -o "$key"
    else
      $SUDO curl -fsSL "$key_url" -o "$key"
    fi
    $SUDO chmod a+r "$key"
  fi
  printf '%s\n' "$line" | $SUDO tee "$list" >/dev/null
  APT_UPDATED=0
  changed "registered apt source '$name'"
}

# --------------------------------------------------------------- base tools --

say "base packages"
# curl/gnupg/ca-certificates are needed to register the apt sources below, so
# they go in first; jq checks CLI releases and Claude's interactive gates.
# Codex uses bubblewrap to enforce the read-only sandbox
# that fences architect and reviewer phases on Linux. unzip is required by
# Bun's own installer (it fails outright without it — see provision_bun).
apt_install git tmux jq curl ca-certificates gnupg bubblewrap unzip

# --------------------------------------------------------------------- node --

say "node $NODE_MAJOR"
if command -v node >/dev/null 2>&1 && [[ "$(ver node -v)" == v$NODE_MAJOR.* ]]; then
  ok "node $(ver node -v), npm $(ver npm -v)"
else
  if command -v node >/dev/null 2>&1; then
    warn "node $(ver node -v) installed but CI pins $NODE_MAJOR — installing $NODE_MAJOR over it"
  fi
  add_apt_source nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key dearmor \
    "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main"
  apt_update_once
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq nodejs
  changed "installed node $(ver node -v)"
fi

# ----------------------------------------------------------------------- gh --

say "gh"
if command -v gh >/dev/null 2>&1; then
  ok "$(ver gh --version)"
else
  # GitHub publishes an already-dearmored keyring, so this one is downloaded
  # verbatim rather than piped through gpg.
  add_apt_source githubcli https://cli.github.com/packages/githubcli-archive-keyring.gpg raw \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main"
  apt_update_once
  apt_install gh
fi

# ------------------------------------------------------------------- docker --

say "docker"
if command -v docker >/dev/null 2>&1; then
  ok "$(ver docker --version)"
else
  add_apt_source docker https://download.docker.com/linux/ubuntu/gpg dearmor \
    "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $UBUNTU_CODENAME stable"
  apt_update_once
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

if ! $SUDO systemctl is-enabled --quiet docker 2>/dev/null; then
  $SUDO systemctl enable --now docker
  changed "enabled + started dockerd"
else
  DOCKER_STATE="$($SUDO systemctl is-active docker 2>/dev/null || true)"
  ok "dockerd enabled (${DOCKER_STATE:-state unknown})"
fi

if id -nG "$(id -un)" | tr ' ' '\n' | grep -qx docker; then
  ok "$(id -un) is in the docker group"
elif [[ $EUID -eq 0 ]]; then
  ok "running as root; docker group membership not needed"
else
  $SUDO usermod -aG docker "$(id -un)"
  changed "added $(id -un) to the docker group"
  note "log out and back in (or 'newgrp docker') before docker works without sudo"
fi

# Group membership added above isn't live in this shell, so fall back to sudo
# for the rest of this run rather than failing the GC verification on it.
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  DOCKER="$SUDO docker"
fi

# ------------------------------------------------- docker build-cache GC ------
#
# etc/docker-daemon.json was written after BuildKit's cache filled a box to
# 93%, not invented here. It's vendored (rather than read from its source
# repo) so this step doesn't depend on any clone existing first, which makes
# it a snapshot that can drift; the "docker GC config provenance" step below
# diffs it against GC_UPSTREAM_REPO/GC_UPSTREAM_REL from etc/repos.conf once
# that repo is on disk. Three traps it encodes, all of which look fine from
# the outside if you get them wrong:
#
#   1. builder.gc is NOT SIGHUP-reloadable. `systemctl reload docker` logs
#      "Reloaded configuration" and leaves the policy unapplied; only a full
#      restart loads it.
#   2. `dockerd --validate` checks JSON structure, NOT key names. A policy
#      containing "totallyMadeUpKey" still returns "configuration OK", so a
#      typo'd or wrong-schema key is silently dropped while validation passes.
#   3. The age field is `filter: ["unused-for=168h"]`, NOT `keepDuration`.
#      keepDuration is a BuildKit-internal name that dockerd accepts and drops,
#      leaving you with size caps and no age rule at all.
#
# Which is why the check at the end is `docker buildx inspect` — the effective
# rules as BuildKit parsed them — and never "the write succeeded, so it's live".

say "docker build-cache GC"
if [[ -f "$DOCKER_CONFIG_DST" ]] && cmp -s "$DOCKER_CONFIG_SRC" "$DOCKER_CONFIG_DST"; then
  ok "$DOCKER_CONFIG_DST already matches etc/docker-daemon.json"
# Structural validation only (trap 2) — worth running because a malformed
# daemon.json stops dockerd from starting at all, but it proves nothing about
# the policy being understood. Run against the source, so a config that can't
# parse never reaches /etc/docker in the first place.
elif ! $SUDO dockerd --validate --config-file="$DOCKER_CONFIG_SRC" >/dev/null 2>&1; then
  blocked "etc/docker-daemon.json fails 'dockerd --validate' — not installing it; $DOCKER_CONFIG_DST left as it was"
else
  if [[ -f "$DOCKER_CONFIG_DST" ]]; then
    warn "$DOCKER_CONFIG_DST differs from etc/docker-daemon.json; backing it up and replacing it"
    diff -u "$DOCKER_CONFIG_DST" "$DOCKER_CONFIG_SRC" || true
    $SUDO cp -a "$DOCKER_CONFIG_DST" "$DOCKER_CONFIG_DST.bak"
    note "previous config saved at $DOCKER_CONFIG_DST.bak"
  fi
  $SUDO install -m 0755 -d /etc/docker
  $SUDO install -m 0644 "$DOCKER_CONFIG_SRC" "$DOCKER_CONFIG_DST"
  if $SUDO systemctl restart docker; then   # restart, not reload (trap 1)
    changed "installed $DOCKER_CONFIG_DST and restarted dockerd"
    note "live-restore only takes effect from the restart that installs it, so this first"
    note "restart still stopped running containers; later restarts are non-disruptive"
  else
    blocked "installed $DOCKER_CONFIG_DST but 'systemctl restart docker' failed — check journalctl -u docker"
  fi
fi

GC_POLICY="$($DOCKER buildx inspect default 2>/dev/null || true)"
if grep -q '168h' <<<"$GC_POLICY"; then
  ok "GC policy live (effective rules from buildx):"
  grep -A6 'GC Policy' <<<"$GC_POLICY" | sed 's/^/           /' || true
elif [[ -z "$GC_POLICY" ]]; then
  blocked "could not read 'docker buildx inspect default' — verify the GC policy by hand"
else
  # BuildKit's permissive defaults are 48h/1440h with a ~790MiB rule; seeing
  # those means daemon.json did not load, whatever the write reported.
  blocked "GC policy NOT live — buildx reports defaults, not the 168h/2GiB/10GiB rules"
  grep -A6 'GC Policy' <<<"$GC_POLICY" | sed 's/^/           /' || true
fi

# ------------------------------------------------- harness log rotation ------
#
# etc/dispatch.cron appends ~26k lines a day across ~/dispatch.log, ~/reap.log
# and ~/merge.log, and nothing else trims them. Installed by provisioning —
# unlike etc/dispatch.cron itself, which stays a manual step because installing
# it is what turns the box autonomous — because rotation changes nothing about
# how the pipeline behaves: it's host hygiene, the same class as the docker GC
# policy above. missingok inside the config keeps it harmless on a box where
# the cron file was never installed and the logs don't exist yet.

say "harness log rotation"
apt_install logrotate
# The parse check can't run on the checkout's own file: logrotate (3.22 makes
# both errors, not warnings) refuses any config that is group/other-writable
# OR not owned by root, and the clone's copy is ubuntu-owned 0664 courtesy of
# the host's umask. So check a root-owned 0644 temp copy — the exact ownership
# and mode the install below gives the real one.
LR_CHECK="$(mktemp)"
$SUDO install -m 0644 -o root -g root "$LOGROTATE_SRC" "$LR_CHECK"
if [[ -f "$LOGROTATE_DST" ]] && cmp -s "$LOGROTATE_SRC" "$LOGROTATE_DST"; then
  ok "$LOGROTATE_DST already matches etc/harness-logs.logrotate"
# Parse-check before installing (as with daemon.json): logrotate skips a file
# it can't parse and rotates everything else, so a broken config wouldn't
# break rotation loudly — our logs would just quietly never rotate again.
elif ! $SUDO logrotate -d "$LR_CHECK" >/dev/null 2>&1; then
  blocked "etc/harness-logs.logrotate fails 'logrotate -d' — not installing it; $LOGROTATE_DST left as it was"
else
  if [[ -f "$LOGROTATE_DST" ]]; then
    warn "$LOGROTATE_DST differs from etc/harness-logs.logrotate; replacing it"
    diff -u "$LOGROTATE_DST" "$LOGROTATE_SRC" | sed 's/^/           /' || true
  fi
  $SUDO install -m 0644 "$LOGROTATE_SRC" "$LOGROTATE_DST"
  changed "installed $LOGROTATE_DST (monthly, 6 rotations kept, compressed)"
fi
$SUDO rm -f "$LR_CHECK"   # root-owned in sticky /tmp, so plain rm can't

# ------------------------------------------------------------ supabase CLI --

say "supabase CLI"
if command -v supabase >/dev/null 2>&1; then
  ok "supabase $(ver supabase --version)"
else
  # npm -g install is explicitly unsupported by Supabase; the .deb from the
  # release page is the supported Linux path. The asset URL is read out of the
  # release JSON rather than assembled from the version, so a naming change
  # fails loudly here instead of 404-ing.
  DEB_URL="$(curl -fsSL https://api.github.com/repos/supabase/cli/releases/latest \
    | jq -r --arg a "$ARCH" '.assets[] | select(.name | endswith("_linux_" + $a + ".deb")) | .browser_download_url' \
    | head -n1 || true)"
  if [[ -z "$DEB_URL" || "$DEB_URL" == "null" ]]; then
    blocked "no supabase _linux_$ARCH.deb in the latest release — install it by hand from https://github.com/supabase/cli/releases"
  else
    TMP_DEB="$(mktemp)"
    curl -fsSL "$DEB_URL" -o "$TMP_DEB"
    $SUDO dpkg -i "$TMP_DEB" >/dev/null
    rm -f "$TMP_DEB"
    changed "installed supabase $(ver supabase --version) from $(basename "$DEB_URL")"
  fi
fi

# --------------------------------------------------------- Claude Code CLI --

provision_claude_cli

# ---------------------------------------------------------- OpenAI Codex CLI --

# Standalone installer is the official Linux path. Like every CLI here,
# provisioning installs a missing binary but never upgrades one already present
# under a fleet of live sessions. The engine adapter invokes this binary for
# issues routed with engine:codex.
provision_codex_cli

# ------------------------------------------------------------------- Bun --

# Not every registered repo is Node-only; a bun project's scripts.verify can
# shell out to `bun test` etc. npm just execs the string regardless of
# runtime, but the binary itself has to exist on the host.
provision_bun

# ------------------------------------------------------------- gh auth gate --

say "gh authentication"
HAVE_GH_AUTH=0
if gh auth status >/dev/null 2>&1; then
  HAVE_GH_AUTH=1
  ok "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo '?')"
else
  blocked "gh is not authenticated — run: gh auth login   (interactive; cloning is skipped until it's done)"
fi

if [[ $HAVE_GH_AUTH -eq 1 ]]; then
  # Wires git's credential helper to gh, which is what lets the epic pipeline
  # push branches over HTTPS without an ssh key on the box.
  if git config --global --get-regexp 'credential.*helper' | grep -q 'gh auth git-credential'; then
    ok "git credential helper wired to gh"
  else
    gh auth setup-git
    changed "ran 'gh auth setup-git' (git now pushes with gh's credentials)"
  fi

  # Commits made by autonomous runs need an identity or git refuses outright.
  if git config --global user.email >/dev/null 2>&1 && git config --global user.name >/dev/null 2>&1; then
    ok "git identity: $(git config --global user.name) <$(git config --global user.email)>"
  else
    GH_LOGIN="$(gh api user --jq .login)"
    GH_ID="$(gh api user --jq .id)"
    git config --global user.name "$GH_LOGIN"
    git config --global user.email "$GH_ID+$GH_LOGIN@users.noreply.github.com"
    changed "set git identity to $GH_LOGIN <$GH_ID+$GH_LOGIN@users.noreply.github.com>"
  fi
fi

# ---------------------------------------------------------- the control repo --

say "control repo at $HOST_CONTROL_DIR"
SELF_ROOT="$(cd "$HERE/.." && pwd)"
if [[ -d "$HOST_CONTROL_DIR/.git" ]]; then
  if [[ "$SELF_ROOT" == "$HOST_CONTROL_DIR" ]]; then
    ok "in place (this script is running from it)"
  else
    ok "in place (this script is running from $SELF_ROOT instead)"
    note "the wiring below points at $HOST_CONTROL_DIR, which is what the registry declares"
  fi
elif [[ -e "$HOST_CONTROL_DIR" ]]; then
  blocked "$HOST_CONTROL_DIR exists but isn't a git checkout — move it aside and re-run"
else
  CONTROL_ORIGIN="$(git -C "$SELF_ROOT" remote get-url origin 2>/dev/null || true)"
  if [[ -z "$CONTROL_ORIGIN" ]]; then
    blocked "can't tell where to clone the control repo from ($SELF_ROOT has no origin)"
  elif git clone "$CONTROL_ORIGIN" "$HOST_CONTROL_DIR"; then
    changed "cloned control from $CONTROL_ORIGIN to $HOST_CONTROL_DIR"
    note "re-run as $HOST_CONTROL_DIR/bin/provision.sh from here on"
  else
    blocked "cloning $CONTROL_ORIGIN to $HOST_CONTROL_DIR failed — clone it by hand and re-run"
  fi
fi

# ---------------------------------------------------------------- the repos --

say "repo clones"
while IFS= read -r repo; do
  path="$(repo_path "$repo")"
  if [[ -d "$path/.git" ]]; then
    branch="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    ok "$repo -> $path (on $branch)"
    # launch.sh pulls and creates worktrees from whatever is checked out here,
    # so anything but main means every session starts from the wrong base.
    if [[ "$branch" != "main" ]]; then
      warn "$repo is on '$branch', not main — launch.sh assumes main is checked out"
    fi
  elif [[ -e "$path" ]]; then
    blocked "$path exists but isn't a git checkout — move it aside and re-run"
  elif ! origin="$(repo_origin "$repo")"; then
    blocked "$repo has no entry in REPO_ORIGINS (etc/repos.conf) — add '<name>=<owner/repo>' or clone $path by hand"
  elif [[ $HAVE_GH_AUTH -eq 0 ]]; then
    blocked "$repo not cloned (needs gh auth): gh repo clone $origin $path"
  elif gh repo clone "$origin" "$path"; then
    changed "cloned $origin to $path"
  else
    blocked "cloning $origin to $path failed — check access to that repo, then re-run"
  fi
done < <(repo_names)

# ------------------------------------------------ merged-branch auto-delete --
#
# reap.sh's worktree pass proves a run is DELIVERED by the absence of any
# `epic/<N>-*` ref on origin: prepare pushes its claim ref before doing any
# work and Ship force-pushes to that same ref, so no ref means no work anyone
# could still want. That proof silently stops holding when a repo keeps merged
# branches — the ref outlives the merge forever, so the worktree is never
# collected and every issue the box builds leaves a checkout and its
# node_modules behind. It fails SAFE (nothing is wrongly deleted), which is
# exactly why it needs reporting: the leak is invisible until a disk fills.
#
# Checked, never set: turning it on rewrites how a repo handles every PR,
# including ones no pipeline opened, so it stays a human's decision — the same
# rule as the gh/trust/bypass gates. A warning rather than a blocker, because
# the box is fully functional without it.
if [[ $HAVE_GH_AUTH -eq 1 ]]; then
  while IFS= read -r repo; do
    if ! origin="$(repo_origin "$repo")"; then
      continue                              # already reported by the clone step
    fi
    setting="$(gh repo view "$origin" --json deleteBranchOnMerge --jq .deleteBranchOnMerge 2>/dev/null || echo '')"
    case "$setting" in
      true)  ok "$repo deletes merged branches (reap can collect delivered worktrees)" ;;
      false) warn "$repo keeps merged branches — reap.sh will never collect its worktrees under \$EPIC_WORKTREE_ROOT. Turn on Settings -> General -> 'Automatically delete head branches' for $origin, or delete each epic/<N>-* ref by hand after it merges" ;;
      *)     note "$repo: could not read deleteBranchOnMerge for $origin (needs repo admin scope) — if merged branches linger there, reap cannot collect its worktrees" ;;
    esac
  done < <(repo_names)
else
  note "skipping the merged-branch auto-delete check (needs gh auth)"
fi

# ------------------------------------------------ docker GC config provenance --
#
# etc/docker-daemon.json is a COPY of whatever GC_UPSTREAM_REPO/GC_UPSTREAM_REL
# (etc/repos.conf) point at — its source of truth; a copy drifts silently, and
# a stale GC policy is exactly what filled a box to 93% before. So compare the
# two once the upstream repo is on disk. This sits after the clones rather than
# with the GC step above because that's the first point the upstream file
# exists — the GC step has to run early, and can't wait on gh auth and a clone.
# With no upstream configured the check is skipped.
#
# A warning, never a blocker: drift means "these two need reconciling", not
# "this host is unprovisioned", and the policy installed above is verified live
# on its own terms by `docker buildx inspect`.

say "docker GC config provenance"
if [[ -z "${GC_UPSTREAM_REPO:-}" ]]; then
  note "no upstream configured (GC_UPSTREAM_REPO in etc/repos.conf is empty) — skipping the drift check"
elif ! GC_UPSTREAM_PATH="$(repo_path "$GC_UPSTREAM_REPO")"; then
  note "$GC_UPSTREAM_REPO isn't in REPOS, so etc/docker-daemon.json can't be checked against its source"
else
  GC_UPSTREAM="$GC_UPSTREAM_PATH/$GC_UPSTREAM_REL"
  if [[ ! -d "$GC_UPSTREAM_PATH/.git" ]]; then
    note "no $GC_UPSTREAM_REPO clone yet; re-run once it lands to check etc/docker-daemon.json against $GC_UPSTREAM_REL"
  elif [[ ! -f "$GC_UPSTREAM" ]]; then
    # The pointer is dangling, which is itself drift worth reporting: the file
    # moved or was deleted upstream and our copy is now orphaned.
    warn "$GC_UPSTREAM is gone — etc/docker-daemon.json has no upstream any more; find where $GC_UPSTREAM_REPO keeps it now and re-point this check"
  elif cmp -s "$DOCKER_CONFIG_SRC" "$GC_UPSTREAM"; then
    ok "etc/docker-daemon.json matches $GC_UPSTREAM"
  else
    warn "etc/docker-daemon.json has DRIFTED from $GC_UPSTREAM — that file is the live production config and the source of truth; reconcile them (a stale GC policy is what filled a box to 93%)"
    note "diff (-: this repo's copy, +: $GC_UPSTREAM_REPO's):"
    diff -u "$DOCKER_CONFIG_SRC" "$GC_UPSTREAM" | sed 's/^/           /' || true
  fi
fi

# ------------------------------------------------------------ ~/.claude wiring --

say "~/.claude wiring"
# Host launchers execute pipeline scripts directly, and the engine reads its
# charters from the control clone. Only /spec and its spec-explorer are useful as
# user-level content, matching laptop-side setup.sh exactly.
wire_claude_content "$HOST_CONTROL_DIR"

# ------------------------------------------------------- the interactive gates --
#
# All of these need a TTY, which is exactly what a provisioning script and a
# detached session don't have. They're checked, never attempted.

say "Claude Code login"
# File-presence heuristic, not a verified session: the only authoritative check
# would be spending a request. Treat a miss as "log in", not as "broken".
if [[ -s "$HOME/.claude/.credentials.json" ]] \
   || jq -e '.oauthAccount // empty' "$HOME/.claude.json" >/dev/null 2>&1; then
  ok "credentials found (heuristic — run 'claude' once if sessions still bounce)"
else
  blocked "Claude Code looks logged out — run 'claude' and complete /login (interactive)"
fi

# Device-code login is the official headless-host flow. Unlike Claude's
# file-presence heuristic, Codex exposes a read-only authoritative status probe.
provision_codex_auth_gate

say "workspace trust"
# The one that bites. Trust is per-directory and interactive; it can't be done
# from a detached session, and --dangerously-skip-permissions does NOT cover
# it. When it's missing the failure is indirect: --worktree refuses to create a
# worktree in an untrusted directory, claude exits instantly, and the tmux
# session still looks like it started — it only shows up as dead under `ls`.
# Acceptance is recorded in ~/.claude.json, so it can at least be checked.
TRUST_DB="$HOME/.claude.json"
while IFS= read -r repo; do
  path="$(repo_path "$repo")"
  if [[ ! -d "$path" ]]; then
    note "$repo: no clone yet; trust it once it exists"
  elif [[ -f "$TRUST_DB" ]] && jq -e --arg p "$path" \
        '.projects[$p].hasTrustDialogAccepted == true' "$TRUST_DB" >/dev/null 2>&1; then
    ok "$repo trusted"
  else
    blocked "$repo not trusted — run interactively: cd $path && claude   (accept the dialog, then exit)"
  fi
done < <(repo_names)

say "bypass-permissions acceptance"
# The nastiest gate, because missing it deadlocks silently. launch.sh starts
# every session with --dangerously-skip-permissions, and the first such run on
# a fresh host stops at the "Bypass Permissions mode" consent dialog. claude IS
# the foreground process, so `ls` reports the session as running (claude) — a
# healthy-looking session doing nothing — and reap.sh can't catch it either:
# the issue never reaches in-progress, so no terminal label ever appears.
# Acceptance is global, one dialog per host, recorded in settings.json.
# Checked, never set: accepting it is a consent decision, the same class as
# the logins and trust above, not a default a script should assume.
SETTINGS="$HOME/.claude/settings.json"
if jq -e '.skipDangerousModePermissionPrompt == true' "$SETTINGS" >/dev/null 2>&1; then
  ok "bypass-permissions dialog accepted"
else
  blocked "bypass-permissions not accepted — run interactively: claude --dangerously-skip-permissions   (accept the warning, then exit; a dispatched session otherwise hangs at the dialog while looking alive)"
fi

# ----------------------------------------------------------------- summary --

say "summary"
if [[ ${#CHANGES[@]} -eq 0 ]]; then
  ok "nothing changed — host was already provisioned"
else
  printf '  %d change(s):\n' "${#CHANGES[@]}"
  for c in "${CHANGES[@]}"; do printf '    - %s\n' "$c"; done
fi

if [[ ${#WARNINGS[@]} -gt 0 ]]; then
  printf '  %d warning(s):\n' "${#WARNINGS[@]}"
  for w in "${WARNINGS[@]}"; do printf '    - %s\n' "$w"; done
fi

if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
  printf '\n  %d step(s) left, none of which this script can do for you:\n' "${#BLOCKERS[@]}"
  for b in "${BLOCKERS[@]}"; do printf '    - %s\n' "$b"; done
  printf '\n  Do those, then re-run this script — it will pick up where it left off.\n'
  exit 1
fi

printf '\n  Host is provisioned. Launch a session from the laptop with ./remote-control.sh\n'
