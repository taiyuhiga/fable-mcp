#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ] && [ -f "$TMP/output.txt" ]; then
    sed 's/installer-smoke-secret/[REDACTED]/g' "$TMP/output.txt" >&2
  fi
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT
BIN="$TMP/bin"
HOME_DIR="$TMP/home"
mkdir -p "$BIN" "$HOME_DIR"

REAL_NODE="$(command -v node)"
cat >"$BIN/node" <<EOF
#!/bin/sh
exec "$REAL_NODE" "\$@"
EOF
chmod +x "$BIN/node"

cat >"$BIN/codex" <<'EOF'
#!/bin/sh
echo "$*" >>"$FAKE_CODEX_LOG"
echo "fake codex $*"
exit 0
EOF
chmod +x "$BIN/codex"

cat >"$BIN/claude.pending" <<'EOF'
#!/bin/sh
case "${1:-}" in
  --version) echo "fake claude 1.0" ;;
  -p) echo '{"result":"AUTH_OK","is_error":false}' ;;
  *) echo '{"loggedIn":true}' ;;
esac
exit 0
EOF
chmod +x "$BIN/claude.pending"

# On Windows the real npm package exposes claude.cmd. Keep the extensionless
# shim for Git Bash's `command -v`, and use the .cmd shim for Node/cmd.exe.
IS_WINDOWS=0
case "$(uname -s 2>/dev/null || true)" in
  MINGW*|MSYS*|CYGWIN*) IS_WINDOWS=1 ;;
esac
if [ "$IS_WINDOWS" -eq 1 ]; then
  cat >"$BIN/claude.cmd.pending" <<'EOF'
@echo off
if "%1"=="--version" echo fake claude 1.0& exit /b 0
if "%1"=="-p" echo {"result":"AUTH_OK","is_error":false}& exit /b 0
echo {"loggedIn":true}
exit /b 0
EOF
fi

cat >"$BIN/npm" <<'EOF'
#!/bin/sh
echo "$*" >>"$FAKE_NPM_LOG"
mv "$FAKE_BIN/claude.pending" "$FAKE_BIN/claude"
if [ -f "$FAKE_BIN/claude.cmd.pending" ]; then
  mv "$FAKE_BIN/claude.cmd.pending" "$FAKE_BIN/claude.cmd"
fi
exit 0
EOF
chmod +x "$BIN/npm"

OUTPUT="$TMP/output.txt"
if [ "$IS_WINDOWS" -eq 1 ]; then
  export FABLE_CLAUDE_BIN="$(cygpath -w "$BIN/claude.cmd")"
fi
PATH="$BIN:/usr/bin:/bin:/usr/local/bin" \
FAKE_BIN="$BIN" \
FAKE_NPM_LOG="$TMP/npm.log" \
FAKE_CODEX_LOG="$TMP/codex.log" \
CODEX_HOME="$HOME_DIR/.codex" \
ANTHROPIC_API_KEY="installer-smoke-secret" \
bash "$ROOT/install.sh" --auth api --ref main >"$OUTPUT" 2>&1

grep -q 'install -g @anthropic-ai/claude-code' "$TMP/npm.log"
grep -E '^(plugin remove|plugin marketplace remove|plugin marketplace add|plugin add)' "$TMP/codex.log" >"$TMP/codex-plugin-ops.log"
cat >"$TMP/codex-expected.log" <<'EOF'
plugin remove fable-mcp@fable-mcp
plugin marketplace remove fable-mcp
plugin marketplace add sam-mountainman/fable-mcp --ref main
plugin add fable-mcp@fable-mcp
EOF
diff -u "$TMP/codex-expected.log" "$TMP/codex-plugin-ops.log"
grep -q 'Authentication and claude-fable-5 access verified successfully' "$OUTPUT"
grep -q 'ANTHROPIC_API_KEY = "installer-smoke-secret"' "$HOME_DIR/.codex/config.toml"
if grep -q 'installer-smoke-secret' "$OUTPUT"; then
  echo "API key leaked into installer output" >&2
  exit 1
fi

echo "installer auth smoke passed"
