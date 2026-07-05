# fable-mcp Agent Setup Contract

If the user gives you only this request:

```text
https://github.com/taiyuhiga/fable-mcp をセットアップして。
```

treat it as a request to complete the full local setup. Do not stop at a README summary.

What "setup" means:

1. Confirm Node.js 18+ is available.
2. Confirm the Claude Code CLI (`claude`) is available; install it with `npm i -g @anthropic-ai/claude-code` when possible. fable-mcp uses this CLI as the local Fable 5 runner even from Cursor/Codex/Antigravity.
3. Run the all-client setup script from the cloned checkout:

   ```sh
   python3 setup-all.py
   ```

   If `python3` is unavailable but `python` is available, use `python setup-all.py`.
4. The setup script should install/register every available client:
   - Codex: plugin marketplace + plugin install when `codex` CLI exists.
   - Claude Code: plugin marketplace + plugin install when `claude` CLI exists.
   - Cursor: local Cursor plugin under `~/.cursor/plugins/local/fable-mcp`.
   - Antigravity: local Antigravity plugin under `~/.gemini/config/plugins/fable-mcp`.
5. Ask the user for `ANTHROPIC_API_KEY` only when needed; never invent or require a key if they prefer Claude CLI login.
6. Tell the user to restart the relevant apps and then ask `Fableの状態を確認して`.

Recommended commands from a cloned checkout:

```sh
# macOS / Linux
python3 setup-all.py
```

```powershell
# Windows PowerShell
python setup-all.py
```

`install.sh` and `install.ps1` are Codex-focused legacy convenience installers. Prefer `setup-all.py` when the user wants Cursor or Claude Code support too.
