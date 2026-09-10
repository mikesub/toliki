![piglets.png](piglets.png)

# toliki

A self-hosted coding-agent harness that turns settled GitHub issues into
verified pull requests and merges eligible ones unattended. A VPS runs plain
Node pipelines in tmux; cron admits work, checks delivery and reaps completed
sessions. Claude Code and Codex are supported.

You write specifications with `/spec`. An ordinary issue gets the independently
reviewed epic workflow; a human may explicitly choose the cheaper, self-reviewed
task workflow. Deterministic code owns Git/GitHub operations and the project's
verification gate. Models supply implementation and judgment.

## The loop

```text
/spec -> ready issue -> dispatch -> epic or task -> open PR
                                                   |
                                      merge worker + fresh checks
                                                   |
                                                  main
```

Conflicts and failing CI can enter bounded fixer runs; unresolved judgment
holds for a human. [WORKFLOW.md](WORKFLOW.md) maps the phases, labels and
contract owners. [DOCTRINE.md](DOCTRINE.md) explains the trade-offs.
Neither setup nor this overview redefines those contracts.

## What it expects

- An Ubuntu VPS you can SSH into.
- Authenticated `gh` and the agent CLIs you intend to use on that host.
- Projects whose `package.json` declares `scripts.verify`: the project's
  complete verification contract.
- Settled issue requirements; pipeline sessions have no steering channel.

## Setup

The commands below change the host and its queues. Agent authorization rules
are in [AGENTS.md](AGENTS.md#live-host-safety).

### On the VPS

```bash
sudo apt-get update && sudo apt-get install -y git gh
gh auth login
gh repo clone mikesub/toliki /home/ubuntu/toliki
cd /home/ubuntu/toliki
cp etc/repos.conf.template etc/repos.conf   # initial setup only; edit your registry
bin/provision.sh
```

[repos.conf.template](etc/repos.conf.template) documents the configuration
values. The actual `etc/repos.conf` is machine-local and must never be committed
or overwritten during an update. Set `HOST_TIMEZONE` there before provisioning
when UTC is not the desired host clock.

[provision.sh](bin/provision.sh) is repeatable and reports the interactive steps
it cannot perform: authentication, per-clone workspace trust and
bypass-permissions consent. It does not accept consent or upgrade an already
installed agent CLI on your behalf.

Turn on autonomous work only after provisioning is green: install
[dispatch.cron](etc/dispatch.cron) using the instructions at its top. Install
all three pipeline cron lines or none. Its `PATH` must reach `node`, `claude`
and `codex`, plus `bun` if any project's verify script uses it. The installed
cron file—not an SSH caller's environment—owns the host's `EPIC_ENGINE`
default and must contain exactly one assignment.

### On the laptop

```bash
gh repo clone mikesub/toliki
cd toliki
./toliki setup
./toliki session list
```

Setup wires `/spec` and `spec-explorer` into both supported clients and seeds
the laptop registry. Node and Codex are required for Codex agent registration.
Re-run setup after an older installation is updated, then start a fresh client
session. [operator/setup.sh](operator/setup.sh) owns registration and migration;
[wire-claude-content.sh](etc/wire-claude-content.sh) owns shared content links.
Project-local copies can shadow those shared skills/agents; never copy them
into target repositories. Pipeline charters stay internal.

### Operating commands

`./toliki` runs on the laptop; its implementations live in `operator/`.
Everything in `bin/` runs on the host. Use `./toliki help` or a command's
`--help` for its current options.

```bash
./toliki config show
./toliki config set --engine codex --max 3
./toliki session list|start|stop|restart|stop-manual|remove-workspace|stop-all
./toliki run epic|task|fix|ci|defect <issue>
./toliki route next <engine>
./toliki usage [days] [engine]
./toliki sync
```

Engines are named tables in [engines.json](etc/engines.json). Manual `run`
accepts an optional `--engine`: omission inherits; specifying it persists the
issue route. The exact pin and admission contracts are linked from
[Prepare](WORKFLOW.md#1-prepare).
Manual pipeline launches can explicitly override capacity with
`--over-capacity` and bypass a provider hold; automatic dispatch cannot.

`session start [name] --engine claude|codex` opens the actual interactive
client over tmux (Claude is the independent default). Toliki creates a local
`manual/<session>` branch and retained worktree from current `origin/main` on
first use; stop/start and restart preserve dirty files, commits, and the chosen
client. Manual sessions neither enter pipeline automation nor consume
`MAX_PARALLEL_EPICS`, though they keep the host non-idle for CLI updates.
Every successful start prints exact attach, detach, stop, batch-manual-stop and
safe workspace-removal commands. `session stop-manual` never touches pipelines
or unrelated tmux; `session stop-all` retains its older host-wide meaning.
Workspace removal is deliberately separate from process stopping and refuses
dirty, untracked, unmerged, active, or ambiguously-owned work.

Autonomous defect repair is opt-in through `DEFECT_FIX_REPOS` in the host
registry. Every entry must name a registered repo; an empty list disables its
automatic admission without removing the explicit manual command.

### Host traps

Read this before adding a repo or changing host configuration:

- Add both `REPOS` and `REPO_ORIGINS` entries, re-run provisioning, and accept
  workspace trust when the interactive client asks in a new manual worktree.
  Login and consent prompts remain visible in the tmux pane; Toliki does not
  accept them automatically.
- Accept bypass-permissions consent once by hand on the host. Provisioning
  detects it but must never set it; a waiting consent dialog can look stalled.
- Enable GitHub's automatic deletion of merged branches for every registered
  repo. Retained remote refs prevent worktree collection and leak disk.
- Re-run provisioning after changing `HOST_TIMEZONE`. Existing panes keep
  their launched zone; new panes receive the registry value.
- Claude model aliases depend on the installed CLI. Use the idle-host
  [CLI updater](bin/update-claude.sh), not an upgrade during active runs.
- Docker GC changes require a full daemon restart, not reload; check effective
  policy with `docker buildx inspect`. Unknown keys may be silently ignored.
  Provisioning owns the installation and readback.

### Inspecting work

`./toliki session list` shows live sessions; `./toliki usage` shows model cost
and issue-lifetime outcomes. The source issue holds the specification, immutable
candidate delivery summary and later status/fixer history. The PR holds the
diff and checks.

A pipeline pane contains its phase log and final `RESULT` line; inspect with
read-only tmux commands. It is not an interactive agent. Manual panes run
Claude or Codex directly; SSH/tmux reconnects to either, while Claude also
retains its Remote Control integration.
[The project triage skill](.agents/skills/toliki/SKILL.md) collects stuck work
using read-only probes.

## Reading order

- [AGENTS.md](AGENTS.md): short maintenance, testing and live-host safety rules;
  `CLAUDE.md` is only its pointer.
- [WORKFLOW.md](WORKFLOW.md): flow map and authoritative contract-owner index.
- [DOCTRINE.md](DOCTRINE.md): design rationale and rejected alternatives.
- [Issue tracking](skills/spec/ISSUE-TRACKING.md): work slicing and filing.
- The relevant source owner and its tests: exact behavior, schema, ordering and
  local incident notes. Do not synchronize copied manuals in several places.

## Caveats

This is a personal setup shared as-is, not a hosted product. Agent sessions can
run with permission bypass on your VPS; git worktrees are not a security
boundary. Read the doctrine before pointing it at a project you care about.

If a fix benefits more than your local setup, a PR is welcome.
