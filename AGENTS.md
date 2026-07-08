# fable-mcp Agent Setup Contract

If the user gives you only this request:

```text
https://github.com/sam-mountainman/fable-mcp をセットアップして。
```

treat it as a request to complete the setup for the AI agent/client that received the request. Do not stop at a README summary. Do not set up every supported client.

Single-client policy:

- If this request is running in Codex, set up Codex only.
- If this request is running in Cursor, set up Cursor only.
- If this request is running in Antigravity, set up Antigravity only.
- Never configure Codex, Cursor, and Antigravity together unless the user explicitly asks for multiple named clients.
- Do not install a Claude Code plugin/client as part of Codex, Cursor, or Antigravity setup. Claude Code CLI is only the optional headless runtime used by fable-mcp to call Fable.

What "setup" means for all clients:

1. Confirm Node.js 18+ is available.
2. Confirm whether the Claude Code CLI runtime (`claude`) is available. Do not auto-install it unless the user explicitly asks. If missing, explain that Fable calls need this runtime and give: `npm i -g @anthropic-ai/claude-code`.
3. Ask the user for `ANTHROPIC_API_KEY` only when needed; never invent or require a key if they prefer Claude CLI login.
4. Install only the selected host client below.
5. Tell the user to restart that host client and then ask `Fableの状態を確認して`.

Codex setup only:

```sh
bash install.sh
```

or:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client codex
```

Cursor setup only:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor
```

Antigravity setup only:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity
```

PowerShell Codex-only setup:

```powershell
.\install.ps1
```
