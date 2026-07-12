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

cat >"$BIN/npm" <<'EOF'
#!/bin/sh
echo "$*" >>"$FAKE_NPM_LOG"
mv "$FAKE_BIN/claude.pending" "$FAKE_BIN/claude"
exit 0
EOF
chmod +x "$BIN/npm"

OUTPUT="$TMP/output.txt"
PATH="$BIN:/usr/bin:/bin:/usr/local/bin" \
FAKE_BIN="$BIN" \
FAKE_NPM_LOG="$TMP/npm.log" \
CODEX_HOME="$HOME_DIR/.codex" \
ANTHROPIC_API_KEY="installer-smoke-secret" \
bash "$ROOT/install.sh" --auth api --ref main >"$OUTPUT" 2>&1

grep -q 'install -g @anthropic-ai/claude-code' "$TMP/npm.log"
grep -q 'Authentication and claude-fable-5 access verified successfully' "$OUTPUT"
grep -q 'ANTHROPIC_API_KEY = "installer-smoke-secret"' "$HOME_DIR/.codex/config.toml"
if grep -q 'installer-smoke-secret' "$OUTPUT"; then
  echo "API key leaked into installer output" >&2
  exit 1
fi

echo "installer auth smoke passed"
