# Sourced by bin/provision.sh. Kept separate so CLI discovery, installation,
# and authentication gates can be exercised hermetically without running the
# host provisioner.

provision_claude_cli() {
  say "Claude Code CLI"

  local had_local_bin=0
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) had_local_bin=1 ;;
  esac

  if command -v claude >/dev/null 2>&1; then
    ok "claude $(ver claude --version)"
  elif [[ -x "$HOME/.local/bin/claude" ]]; then
    # A non-login SSH command may not inherit ~/.local/bin even though the
    # binary and login-shell setup are healthy. Expose the existing install for
    # this run; never interpret a PATH miss as permission to update the CLI.
    export PATH="$HOME/.local/bin:$PATH"
    hash -r
    ok "claude $(ver claude --version)"
  else
    if curl -fsSL https://claude.ai/install.sh | bash; then
      export PATH="$HOME/.local/bin:$PATH"
      hash -r
      if command -v claude >/dev/null 2>&1; then
        changed "installed claude $(ver claude --version)"
      else
        blocked "Claude install ran but the binary isn't on PATH — check ~/.local/bin"
      fi
    else
      blocked "Claude install failed — re-run, or install it by hand from https://claude.ai"
    fi
  fi

  if [[ -x "$HOME/.local/bin/claude" && $had_local_bin -eq 0 ]]; then
    warn "~/.local/bin is not on PATH; a fresh login shell or tmux pane may not find claude (Ubuntu's ~/.profile normally adds it — verify with: bash -lc 'command -v claude')"
  fi
}

provision_codex_cli() {
  say "Codex CLI"

  local had_local_bin=0
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) had_local_bin=1 ;;
  esac

  if command -v codex >/dev/null 2>&1; then
    ok "codex $(ver codex --version)"
  elif [[ -x "$HOME/.local/bin/codex" ]]; then
    # The binary exists, but this shell cannot see it. Do not run the installer
    # as an accidental update: expose the existing install for this run and
    # report the persistent PATH problem below.
    export PATH="$HOME/.local/bin:$PATH"
    hash -r
    ok "codex $(ver codex --version)"
  else
    if curl -fsSL https://chatgpt.com/codex/install.sh | bash; then
      export PATH="$HOME/.local/bin:$PATH"
      hash -r
      if command -v codex >/dev/null 2>&1; then
        changed "installed codex $(ver codex --version)"
      else
        blocked "Codex install ran but the binary isn't on PATH — check ~/.local/bin"
      fi
    else
      blocked "Codex install failed — re-run, or install it by hand from https://learn.chatgpt.com/docs/codex/cli"
    fi
  fi

  # Codex Desktop starts the remote app server through the remote user's login
  # shell. The export above fixes only this provision run; a missing persistent
  # PATH would leave the installed CLI unusable over the SSH connection.
  if [[ -x "$HOME/.local/bin/codex" && $had_local_bin -eq 0 ]]; then
    warn "~/.local/bin is not on PATH; a fresh login shell may not find codex (Ubuntu's ~/.profile normally adds it — verify with: bash -lc 'command -v codex')"
  fi
}

provision_codex_auth_gate() {
  say "Codex login"
  if ! command -v codex >/dev/null 2>&1; then
    blocked "Codex authentication cannot be checked until the CLI is installed"
  elif codex login status >/dev/null 2>&1; then
    ok "Codex authenticated"
  else
    blocked "Codex is not authenticated — run interactively: codex login --device-auth   (open the printed link in a browser and enter the one-time code)"
  fi
}

provision_bun() {
  say "Bun runtime"

  local had_bun_bin=0
  case ":$PATH:" in
    *":$HOME/.bun/bin:"*) had_bun_bin=1 ;;
  esac

  if command -v bun >/dev/null 2>&1; then
    ok "bun $(ver bun --version)"
  elif [[ -x "$HOME/.bun/bin/bun" ]]; then
    # A non-login SSH command may not inherit ~/.bun/bin even though the
    # binary and login-shell setup are healthy. Expose the existing install for
    # this run; never interpret a PATH miss as permission to update the CLI.
    export PATH="$HOME/.bun/bin:$PATH"
    hash -r
    ok "bun $(ver bun --version)"
  else
    if curl -fsSL https://bun.sh/install | bash; then
      export PATH="$HOME/.bun/bin:$PATH"
      hash -r
      if command -v bun >/dev/null 2>&1; then
        changed "installed bun $(ver bun --version)"
      else
        blocked "Bun install ran but the binary isn't on PATH — check ~/.bun/bin"
      fi
    else
      blocked "Bun install failed — re-run, or install it by hand from https://bun.sh"
    fi
  fi

  # bun's installer appends its own PATH line to ~/.bashrc, not ~/.profile, so
  # a non-interactive SSH command (the shape every dispatched session runs
  # under) won't pick it up the way ~/.local/bin does for claude/codex.
  if [[ -x "$HOME/.bun/bin/bun" && $had_bun_bin -eq 0 ]]; then
    warn "~/.bun/bin is not on PATH; a fresh login shell or non-interactive SSH command may not find bun — verify with: bash -lc 'command -v bun' (add 'export PATH=\"\$HOME/.bun/bin:\$PATH\"' to ~/.profile if missing)"
  fi
}
