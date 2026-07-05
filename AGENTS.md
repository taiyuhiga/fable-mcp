# fable-mcp Agent Setup Contract

If the user gives you only this request:

```text
https://github.com/taiyuhiga/fable-mcp をセットアップして。
```

treat it as a request to complete the full local setup. Do not stop at a README summary.

What "setup" means:

1. Confirm Node.js 18+ is available.
2. Confirm the `codex` CLI is available. If it is missing, tell the user they need Codex installed/opened first.
3. Confirm the Claude Code CLI (`claude`) is available; install it with `npm i -g @anthropic-ai/claude-code` when possible.
4. Install the Codex plugin with `codex plugin marketplace add ...` and `codex plugin add fable-mcp@fable-mcp`.
5. Ask the user for `ANTHROPIC_API_KEY` only when needed; never invent or require a key if they prefer Claude CLI login.
6. Verify with `codex mcp list` that `fable` is registered.
7. Tell the user to restart the Codex desktop app and then ask `Fableの状態を確認して`.

Recommended commands from a cloned checkout:

```sh
# macOS / Linux
bash install.sh
```

```powershell
# Windows PowerShell
.\install.ps1
```

The installer sets up both sides: Claude Code CLI for the Fable headless process and the Codex plugin/MCP registration for Codex.
