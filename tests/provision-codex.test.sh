#!/usr/bin/env bash
set -euo pipefail

# Exercises the Codex-specific part of provisioning against fake curl/codex
# binaries and throwaway homes. Hermetic: no network, credentials, host, or
# real ~/.codex state. The sourced helper is the exact code provision.sh calls.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok_test() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
nok() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1"; }
assert_contains() {
  if [[ "$2" == *"$3"* ]]; then ok_test "$1"; else
    nok "$1"; printf '       missing: %s\n' "$3"; printf '%s\n' "$2" | sed 's/^/         /' | head -20
  fi
}
assert_not_contains() {
  if [[ "$2" != *"$3"* ]]; then ok_test "$1"; else nok "$1 (unexpectedly present: $3)"; fi
}
assert_eq() { if [[ "$2" == "$3" ]]; then ok_test "$1"; else nok "$1 (want $2, got $3)"; fi; }

mkdir -p "$TMP/bin"
INSTALL_LOG="$TMP/install.log"

# The official installer endpoint is represented by a curl stub that emits an
# installer script on stdout, exactly matching `curl ... | bash`.
cat > "$TMP/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$INSTALL_LOG"
[[ -z "${INSTALL_FAIL:-}" ]] || exit 22
cat <<'INSTALLER'
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/codex" <<'CODEX'
#!/usr/bin/env bash
case "$*" in
  --version) echo "codex-cli 9.9.9" ;;
  "login status")
    [[ -n "${AUTH_OK:-}" ]] && { echo "Logged in using ChatGPT"; exit 0; }
    echo "Not logged in" >&2
    exit 1 ;;
esac
CODEX
chmod +x "$HOME/.local/bin/codex"
INSTALLER
STUB
chmod +x "$TMP/bin/curl"

RUN_OUT=""
run_case() {
  local name="$1" setup="${2:-}" auth="${3:-}"
  local home="$TMP/home-$name" path="$TMP/bin:/usr/bin:/bin"
  mkdir -p "$home"
  rm -f "$INSTALL_LOG"

  if [[ "$setup" == "path" ]]; then
    mkdir -p "$home/on-path"
    cp "$TMP/codex-template" "$home/on-path/codex"
    chmod +x "$home/on-path/codex"
    path="$home/on-path:$path"
  elif [[ "$setup" == "local" ]]; then
    mkdir -p "$home/.local/bin"
    cp "$TMP/codex-template" "$home/.local/bin/codex"
    chmod +x "$home/.local/bin/codex"
  fi

  RUN_OUT="$(
    HOME="$home" PATH="$path" AUTH_OK="$auth" INSTALL_LOG="$INSTALL_LOG" \
      LIB="$ROOT/bin/provision-codex.lib.sh" bash -c '
        set -euo pipefail
        say() { printf "SAY|%s\n" "$*"; }
        ok() { printf "OK|%s\n" "$*"; }
        changed() { printf "CHANGED|%s\n" "$*"; }
        warn() { printf "WARN|%s\n" "$*"; }
        blocked() { printf "BLOCKED|%s\n" "$*"; }
        ver() { local out; out="$("$@" 2>/dev/null | head -n1)" || out=""; printf "%s" "${out:-?}"; }
        source "$LIB"
        provision_codex_cli
        provision_codex_auth_gate
      '
  )"
}

cat > "$TMP/codex-template" <<'CODEX'
#!/usr/bin/env bash
case "$*" in
  --version) echo "codex-cli 1.2.3" ;;
  "login status") [[ -n "${AUTH_OK:-}" ]] && exit 0 || exit 1 ;;
esac
CODEX

printf '\nexisting Codex on PATH\n'
run_case existing path yes
assert_contains "reports the installed version" "$RUN_OUT" "OK|codex codex-cli 1.2.3"
assert_contains "reports authenticated" "$RUN_OUT" "OK|Codex authenticated"
assert_eq "does not invoke the installer" "" "$(cat "$INSTALL_LOG" 2>/dev/null || true)"

printf '\nexisting local Codex outside PATH\n'
run_case local local yes
assert_contains "finds the existing local binary" "$RUN_OUT" "OK|codex codex-cli 1.2.3"
assert_contains "warns that the persistent PATH is missing" "$RUN_OUT" "WARN|~/.local/bin is not on PATH"
assert_eq "does not upgrade the hidden existing binary" "" "$(cat "$INSTALL_LOG" 2>/dev/null || true)"

printf '\nmissing Codex installs, then asks for login\n'
run_case install "" ""
assert_contains "records the install" "$RUN_OUT" "CHANGED|installed codex codex-cli 9.9.9"
assert_contains "uses the official installer URL" "$(cat "$INSTALL_LOG")" "https://chatgpt.com/codex/install.sh"
assert_contains "blocks on missing authentication" "$RUN_OUT" "BLOCKED|Codex is not authenticated"
assert_contains "names the headless login command" "$RUN_OUT" "codex login --device-auth"

printf '\nmissing Codex installs into an authenticated host\n'
run_case ready "" yes
assert_contains "installs successfully" "$RUN_OUT" "CHANGED|installed codex codex-cli 9.9.9"
assert_contains "the status probe passes" "$RUN_OUT" "OK|Codex authenticated"
assert_not_contains "no auth blocker remains" "$RUN_OUT" "BLOCKED|Codex is not authenticated"

printf '\ninstaller failure\n'
INSTALL_FAIL=1 run_case failure "" ""
assert_contains "the install failure is a blocker" "$RUN_OUT" "BLOCKED|Codex install failed"
assert_contains "auth remains blocked without a CLI" "$RUN_OUT" "BLOCKED|Codex authentication cannot be checked"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
