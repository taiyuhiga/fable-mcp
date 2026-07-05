#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOW_MODEL_CALL=0
KEEP_TEMP=0

usage() {
  cat <<'EOF'
Run a clean-room Codex plugin live trial.

By default this performs only local install/MCP-registration checks and does not
call Codex models or Fable. Add --allow-model-call to run `codex exec` against
the installed plugin and ask for a local-only fable_status check.

Usage:
  scripts/codex-live-trial.sh [--allow-model-call] [--keep-temp]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-model-call) ALLOW_MODEL_CALL=1 ;;
    --keep-temp) KEEP_TEMP=1 ;;
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

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found"
  exit 1
fi

TMP_HOME="$(mktemp -d)"
PROJECT="$(mktemp -d)"
cleanup() {
  if [ "$KEEP_TEMP" -eq 1 ]; then
    echo "Kept CODEX_HOME=$TMP_HOME"
    echo "Kept project=$PROJECT"
  else
    rm -rf "$TMP_HOME" "$PROJECT"
  fi
}
trap cleanup EXIT

echo "==> Clean-room plugin install"
CODEX_HOME="$TMP_HOME" codex plugin marketplace add "$ROOT"
CODEX_HOME="$TMP_HOME" codex plugin add fable-mcp@fable-mcp
CODEX_HOME="$TMP_HOME" codex mcp list | tee "$TMP_HOME/mcp-list.txt"
grep -q "^fable[[:space:]]" "$TMP_HOME/mcp-list.txt"

if [ "$ALLOW_MODEL_CALL" -ne 1 ]; then
  echo "==> Skipping codex exec live trial"
  echo "Run with --allow-model-call to ask Codex to call fable_status. That uses your Codex/OpenAI account but still does not call Fable."
  exit 0
fi

echo "==> Running codex exec local-only fable_status trial"
(
  cd "$PROJECT"
  git init >/dev/null
  printf '# live trial\n' > README.md
)

CODEX_HOME="$TMP_HOME" codex exec \
  --skip-git-repo-check \
  -C "$PROJECT" \
  "Fableの状態確認だけをしてください。fable_statusを使い、fable_plan/fable_ask/fable_reviewは呼ばないでください。"

echo "codex live trial completed"
