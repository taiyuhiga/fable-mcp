#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${1:-$ROOT}"
PLUGIN="${2:-fable-mcp@fable-mcp}"

if ! command -v codex >/dev/null 2>&1; then
  echo "SKIP: codex CLI not found; clean-room plugin install smoke skipped"
  exit 0
fi

TMP_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP_HOME"' EXIT

echo "Using isolated CODEX_HOME=$TMP_HOME"
CODEX_HOME="$TMP_HOME" codex plugin marketplace add "$SOURCE"
CODEX_HOME="$TMP_HOME" codex plugin add "$PLUGIN"
CODEX_HOME="$TMP_HOME" codex plugin list > "$TMP_HOME/plugin-list.txt"
CODEX_HOME="$TMP_HOME" codex mcp list > "$TMP_HOME/mcp-list.txt"

grep -q "fable-mcp" "$TMP_HOME/plugin-list.txt"
grep -q "^fable[[:space:]]" "$TMP_HOME/mcp-list.txt"
grep -q "server.bundled.mjs" "$TMP_HOME/mcp-list.txt"

echo "clean-room Codex plugin install smoke passed"
