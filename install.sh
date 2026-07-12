#!/usr/bin/env bash
set -euo pipefail

REF="v0.9.1"
REPO="sam-mountainman/fable-mcp"
PLUGIN="fable-mcp@fable-mcp"
DRY_RUN=0
INSTALL_CLAUDE=1
AUTH_MODE="auto"
SKIP_AUTH=0
SKIP_LIVE_CHECK=0

usage() {
  cat <<'EOF'
Install fable-mcp for Codex.

Usage:
  ./install.sh [--dry-run] [--ref v0.9.1] [--auth auto|login|api] [--skip-auth]

Options:
  --dry-run             Print commands without changing anything.
  --ref <git-ref>       Git ref to install from. Default: v0.9.1.
  --auth <mode>         Authentication mode: auto, login, or api (default: auto).
                        Interactive auto asks with Claude login first/default.
  --no-claude-install   Do not install Claude Code CLI automatically if missing.
  --skip-auth           Configure the plugin without authentication (explicitly incomplete setup).
  --skip-live-check     Confirm auth state but skip the minimal Fable access request.
  --install-claude-runtime
                        Deprecated compatibility flag; CLI installation is now the default.
  --no-api-key          Deprecated alias for --auth login.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --ref)
      shift
      [ "$#" -gt 0 ] || { echo "missing value for --ref" >&2; exit 2; }
      REF="$1"
      ;;
    --install-claude-runtime) INSTALL_CLAUDE=1 ;;
    --no-claude-install) INSTALL_CLAUDE=0 ;;
    --auth)
      shift
      [ "$#" -gt 0 ] || { echo "missing value for --auth" >&2; exit 2; }
      AUTH_MODE="$1"
      ;;
    --skip-auth) SKIP_AUTH=1 ;;
    --skip-live-check) SKIP_LIVE_CHECK=1 ;;
    --no-api-key) AUTH_MODE="login" ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

say() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

have() {
  command -v "$1" >/dev/null 2>&1
}

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

prepare_helpers() {
  if [ -f "$SCRIPT_DIR/scripts/verify-claude-auth.mjs" ] && [ -f "$SCRIPT_DIR/scripts/configure-codex-plugin-env.mjs" ]; then
    HELPER_DIR="$SCRIPT_DIR/scripts"
    return
  fi
  have curl || die "curl is required when running the installer directly from GitHub."
  HELPER_TMP="$(mktemp -d)"
  HELPER_DIR="$HELPER_TMP"
  run curl -fsSL "https://raw.githubusercontent.com/${REPO}/${REF}/scripts/verify-claude-auth.mjs" -o "$HELPER_DIR/verify-claude-auth.mjs"
  run curl -fsSL "https://raw.githubusercontent.com/${REPO}/${REF}/scripts/configure-codex-plugin-env.mjs" -o "$HELPER_DIR/configure-codex-plugin-env.mjs"
}

preflight_warnings() {
  say "Preflight warnings"
  warn "Close the Codex desktop app before running this installer. If Codex is open, it may overwrite config.toml when it exits."

  local codex_home config hooks agents
  codex_home="${CODEX_HOME:-$HOME/.codex}"
  config="$codex_home/config.toml"
  hooks="$codex_home/hooks.json"
  agents="$codex_home/AGENTS.md"

  if [ -f "$config" ] && grep -Eq '^\s*\[mcp_servers\.fable\]\s*$' "$config"; then
    warn "Manual [mcp_servers.fable] already exists in $config. Remove it after plugin install to avoid double MCP registration."
  fi
  if [ -f "$hooks" ] && grep -Fq "fable-loop-stop.mjs" "$hooks"; then
    warn "Manual fable-loop Stop hook already exists in $hooks. Remove it after plugin install to avoid double hook execution."
  fi
  if [ -f "$agents" ] && grep -Eq 'Fable 5 Orchestration|Fable 5 オーケストレーション|fable_plan|fable_review' "$agents"; then
    warn "Global AGENTS.md appears to contain Fable routing rules. Prefer the plugin-bundled rules to avoid stale or duplicated instructions."
  fi
}

ensure_node() {
  say "Checking Node.js"
  if ! have node; then
    die "Node.js 18+ is required. Install it from https://nodejs.org, then run this installer again."
  fi

  local major
  major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  if [ "${major:-0}" -lt 18 ]; then
    die "Node.js 18+ is required. Current: $(node --version 2>/dev/null || echo unknown)"
  fi
  echo "Node.js OK: $(node --version)"
}

ensure_codex() {
  say "Checking Codex CLI"
  if ! have codex; then
    die "The codex CLI was not found on PATH. Install/open Codex first, then run this installer from a terminal where 'codex' works."
  fi
  echo "Codex CLI OK: $(codex --version 2>/dev/null || echo installed)"
}

ensure_claude() {
  say "Checking Claude Code CLI"
  if have claude; then
    echo "Claude Code CLI OK: $(claude --version 2>/dev/null || echo installed)"
    return
  fi

  if [ "$INSTALL_CLAUDE" -ne 1 ]; then
    warn "claude CLI not found and automatic installation was disabled."
    [ "$SKIP_AUTH" -eq 1 ] || die "Fable calls require Claude Code CLI. Re-run without --no-claude-install or use --skip-auth for an intentionally incomplete setup."
    return
  fi

  if ! have npm; then
    die "npm not found, so Claude Code CLI cannot be installed automatically. Install Node.js/npm and retry."
  fi

  say "Installing Claude Code CLI"
  if run npm install -g @anthropic-ai/claude-code; then
    if have claude; then
      echo "Claude Code CLI OK: $(claude --version 2>/dev/null || echo installed)"
    else
      warn "npm install finished, but 'claude' is still not on PATH. Open a new terminal or set FABLE_CLAUDE_BIN."
    fi
  else
    die "Claude Code CLI install failed. Install manually with: npm i -g @anthropic-ai/claude-code"
  fi
}

install_plugin() {
  say "Installing fable-mcp Codex plugin from ${REPO}@${REF}"
  # `marketplace upgrade` preserves an old pinned ref (for example v0.8.3).
  # Remove both registrations first so the requested release is authoritative.
  run codex plugin remove "$PLUGIN" || true
  run codex plugin marketplace remove fable-mcp || true
  run codex plugin marketplace add "$REPO" --ref "$REF"
  run codex plugin add "$PLUGIN"
}

escape_toml_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

configure_auth() {
  [ "$DRY_RUN" -eq 0 ] || return 0
  if [ "$SKIP_AUTH" -eq 1 ]; then
    warn "Authentication was skipped explicitly. Fable calls are not guaranteed to work."
    return 0
  fi
  prepare_helpers

  local mode="$AUTH_MODE" api_key="${ANTHROPIC_API_KEY:-}" tty=""
  [ -r /dev/tty ] && tty="/dev/tty"

  if [ "$mode" = "auto" ] && [ -n "$tty" ]; then
    say "Choose Claude authentication"
    printf '%s\n' '1) Claude account login (recommended; opens browser)' '2) Anthropic API key (metered billing; subscription-independent)'
    printf 'Select [1/2, default 1]: '
    local choice
    IFS= read -r choice <"$tty" || true
    [ "${choice:-1}" = "2" ] && mode="api" || mode="login"
  elif [ "$mode" = "auto" ]; then
    [ -n "$api_key" ] && mode="api" || mode="login"
  fi

  case "$mode" in
    api)
      if [ -z "$api_key" ]; then
        [ -n "$tty" ] || die "API auth requires ANTHROPIC_API_KEY in a non-interactive shell."
        printf 'Paste ANTHROPIC_API_KEY (input hidden): '
        local old_stty
        old_stty="$(stty -g <"$tty")"
        stty -echo <"$tty"
        IFS= read -r api_key <"$tty" || true
        stty "$old_stty" <"$tty"
        printf '\n'
      fi
      [ -n "$api_key" ] || die "API key authentication was selected, but no key was provided."
      say "Verifying Anthropic API authentication"
      if [ "$SKIP_LIVE_CHECK" -eq 1 ]; then
        ANTHROPIC_API_KEY="$api_key" node "$HELPER_DIR/verify-claude-auth.mjs" --mode api --skip-live-check
      else
        ANTHROPIC_API_KEY="$api_key" node "$HELPER_DIR/verify-claude-auth.mjs" --mode api
      fi
      local config="${CODEX_HOME:-$HOME/.codex}/config.toml"
      printf '%s' "$api_key" | node "$HELPER_DIR/configure-codex-plugin-env.mjs" --config "$config" --effort medium
      unset api_key
      ;;
    login)
      say "Verifying Claude account authentication"
      if [ -n "$tty" ]; then
        if [ "$SKIP_LIVE_CHECK" -eq 1 ]; then
          (unset ANTHROPIC_API_KEY; node "$HELPER_DIR/verify-claude-auth.mjs" --mode login --skip-live-check <"$tty")
        else
          (unset ANTHROPIC_API_KEY; node "$HELPER_DIR/verify-claude-auth.mjs" --mode login <"$tty")
        fi
      else
        if [ "$SKIP_LIVE_CHECK" -eq 1 ]; then
          (unset ANTHROPIC_API_KEY; node "$HELPER_DIR/verify-claude-auth.mjs" --mode login --non-interactive --skip-live-check)
        else
          (unset ANTHROPIC_API_KEY; node "$HELPER_DIR/verify-claude-auth.mjs" --mode login --non-interactive)
        fi
      fi
      node "$HELPER_DIR/configure-codex-plugin-env.mjs" --config "${CODEX_HOME:-$HOME/.codex}/config.toml" --remove-api-key
      ;;
    *) die "unsupported --auth mode: $mode (use auto, api, or login)" ;;
  esac
}

print_next_steps() {
  say "Done"
  run codex mcp list || true
  cat <<EOF

Next steps:
Installed/checked:
- Codex Plugin/MCP: registers the fable MCP server for Codex.
- Claude Code CLI runtime: installed automatically if it was missing.
- Authentication: configured and verified unless --skip-auth was passed.

1. Restart the Codex app.
2. If Codex asks whether to trust the bundled Stop hook, approve it.
3. In a new Codex thread, ask:

   Fableの状態を確認して

The installer only reports success after Claude authentication and a minimal Fable access check,
unless an explicit skip option was used.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR=""
HELPER_TMP=""
trap '[ -n "${HELPER_TMP:-}" ] && rm -rf "$HELPER_TMP"' EXIT
preflight_warnings
ensure_node
ensure_codex
ensure_claude
install_plugin
configure_auth
print_next_steps
