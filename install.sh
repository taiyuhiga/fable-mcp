#!/usr/bin/env bash
set -euo pipefail

REF="v0.8.3"
REPO="sam-mountainman/fable-mcp"
PLUGIN="fable-mcp@fable-mcp"
DRY_RUN=0
INSTALL_CLAUDE=0
ASK_API_KEY=1

usage() {
  cat <<'EOF'
Install fable-mcp for Codex.

Usage:
  ./install.sh [--dry-run] [--ref v0.8.3] [--install-claude-runtime] [--no-api-key]

Options:
  --dry-run             Print commands without changing anything.
  --ref <git-ref>       Git ref to install from. Default: v0.8.3.
  --install-claude-runtime
                        Install Claude Code CLI if missing. Off by default so
                        Codex setup does not also set up Claude Code unless
                        the user explicitly asks.
  --no-api-key          Do not prompt for ANTHROPIC_API_KEY.
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
    --no-claude-install) INSTALL_CLAUDE=0 ;; # kept for old docs/scripts
    --no-api-key) ASK_API_KEY=0 ;;
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
    warn "claude CLI not found. This installer configures only Codex, but Fable calls need the Claude Code CLI runtime."
    warn "Install it separately only if you want this machine to call Fable: npm i -g @anthropic-ai/claude-code"
    return
  fi

  if ! have npm; then
    warn "npm not found, so Claude Code CLI cannot be installed automatically. Install it later with: npm i -g @anthropic-ai/claude-code"
    return
  fi

  say "Installing Claude Code CLI"
  if run npm install -g @anthropic-ai/claude-code; then
    if have claude; then
      echo "Claude Code CLI OK: $(claude --version 2>/dev/null || echo installed)"
    else
      warn "npm install finished, but 'claude' is still not on PATH. Open a new terminal or set FABLE_CLAUDE_BIN."
    fi
  else
    warn "Claude Code CLI install failed. Install manually with: npm i -g @anthropic-ai/claude-code"
  fi
}

install_plugin() {
  say "Installing fable-mcp Codex plugin from ${REPO}@${REF}"
  if ! run codex plugin marketplace add "$REPO" --ref "$REF"; then
    warn "marketplace add failed, trying marketplace upgrade for existing source"
    run codex plugin marketplace upgrade fable-mcp || true
  fi
  run codex plugin add "$PLUGIN"
}

escape_toml_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "$value"
}

configure_api_key() {
  [ "$ASK_API_KEY" -eq 1 ] || return 0
  [ "$DRY_RUN" -eq 0 ] || return 0
  [ -t 0 ] || {
    warn "non-interactive shell: skipping ANTHROPIC_API_KEY prompt"
    return 0
  }

  say "Optional Anthropic API key setup"
  printf 'Paste ANTHROPIC_API_KEY (leave blank to use your current claude CLI login/session): '
  local old_stty
  old_stty="$(stty -g)"
  stty -echo
  local api_key
  IFS= read -r api_key || true
  stty "$old_stty"
  printf '\n'

  [ -n "$api_key" ] || {
    echo "No API key written. If needed, run 'claude' login or add ANTHROPIC_API_KEY later."
    return 0
  }

  local codex_home config table escaped
  codex_home="${CODEX_HOME:-$HOME/.codex}"
  config="$codex_home/config.toml"
  table='[plugins."fable-mcp@fable-mcp".mcp_servers.fable.env]'
  mkdir -p "$codex_home"
  touch "$config"

  if grep -Fqx "$table" "$config"; then
    warn "fable-mcp plugin env table already exists in $config. Not overwriting it."
    echo "Make sure it contains ANTHROPIC_API_KEY and optionally FABLE_EFFORT."
    return 0
  fi

  cp "$config" "$config.bak.$(date +%Y%m%d%H%M%S)"
  escaped="$(escape_toml_string "$api_key")"
  cat >>"$config" <<EOF

$table
ANTHROPIC_API_KEY = "$escaped"
FABLE_EFFORT = "medium"
EOF
  echo "Wrote plugin env to $config"
}

print_next_steps() {
  say "Done"
  run codex mcp list || true
  cat <<EOF

Next steps:
Installed/checked:
- Codex Plugin/MCP: registers the fable MCP server for Codex.
- Claude Code CLI runtime: checked only. It is not installed unless --install-claude-runtime was passed.

1. Restart the Codex app.
2. If Codex asks whether to trust the bundled Stop hook, approve it.
3. In a new Codex thread, ask:

   Fableの状態を確認して

If the status says the claude CLI is missing, install the runtime separately with:

   npm i -g @anthropic-ai/claude-code

If the status says ANTHROPIC_API_KEY is missing, either add it to ~/.codex/config.toml
or log in/configure the claude CLI runtime.
EOF
}

preflight_warnings
ensure_node
ensure_codex
ensure_claude
install_plugin
configure_api_key
print_next_steps
