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
- Do not configure Claude Code as another host agent. Claude Code CLI is the required headless runtime used by fable-mcp and should be installed automatically when missing.

What "setup" means for all clients:

1. Fetch/read the repository's current default branch and release metadata. Never choose a version from an already installed plugin, stale marketplace ref, local clone, task memory, or cached instructions. The installer release in this repository is authoritative.
2. For Codex, remove any existing `fable-mcp@fable-mcp` plugin and `fable-mcp` marketplace registration before adding the requested release. This is required because `marketplace upgrade` preserves old pinned refs such as `v0.8.3`.
3. Confirm Node.js 18+ is available.
4. Install Claude Code CLI automatically if `claude` is missing. The user's setup request authorizes this required runtime installation; `--no-claude-install` is the explicit opt-out.
5. Before configuring authentication, use the host client's structured `AskUserQuestion` / `request_user_input` UI when available. Do not silently infer the billing path from an existing environment variable. Present exactly these choices in this order:
   1. **Claude account login (Recommended)** — launch `claude auth login`; suitable for an existing Claude Pro/Max account.
   2. **Anthropic API key** — metered API billing; independent of a Claude subscription.
   If structured questions are unavailable, use an equivalent interactive menu with Claude login as option 1 and the default. Never ask the user to paste an API key into normal chat, and never print or place API keys in command arguments.
6. Run Claude account login in an interactive PTY/terminal and keep the process alive while the user completes browser authentication. Verify `claude auth status` and perform the minimal live Fable access check. Do not report setup success after failed or missing authentication unless the user explicitly requested `--skip-auth`.
7. Install only the selected host client below.
8. Tell the user to restart that host client and then ask `Fableの状態を確認して`.

Codex setup only:

The examples below show `login`, the first/recommended choice. Replace it with `api` only when the user selected Anthropic API key in AskUserQuestion.

```sh
bash install.sh --auth login
```

or:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client codex --auth login
```

Cursor setup only:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor --auth login
```

Antigravity setup only:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity --auth login
```

PowerShell Codex-only setup:

```powershell
.\install.ps1 -Auth login
```
