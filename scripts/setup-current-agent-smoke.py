#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "setup-current-agent.py"


def run_client(client, assert_fn):
    with tempfile.TemporaryDirectory(prefix=f"fable-{client}-setup-") as tmp:
        env = os.environ.copy()
        env["FABLE_MCP_HOME"] = tmp
        env["PYTHONIOENCODING"] = "utf-8"
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--client", client, "--skip-runtime-check"],
            cwd=ROOT,
            env=env,
            text=True,
            encoding="utf-8",
            capture_output=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"{client} setup failed\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}")
        summary = json.loads(result.stdout)
        home = Path(tmp)
        if summary["client"] != client:
            raise AssertionError(f"wrong client in summary: {summary['client']}")
        assert_fn(home)


def assert_cursor(home):
    plugin = home / ".cursor" / "plugins" / "local" / "fable-mcp"
    mcp = home / ".cursor" / "mcp.json"
    if not (plugin / ".cursor-plugin" / "plugin.json").exists():
        raise AssertionError("Cursor plugin manifest missing")
    if not (plugin / "dist" / "server.bundled.mjs").exists():
        raise AssertionError("Cursor server bundle missing")
    data = json.loads(mcp.read_text())
    server = data["mcpServers"]["fable"]
    if server.get("type") != "stdio":
        raise AssertionError("Cursor MCP must be stdio")
    if not Path(server["args"][0]).is_absolute():
        raise AssertionError("Cursor setup should rewrite server path to absolute")
    if (home / ".codex").exists():
        raise AssertionError("Cursor setup touched Codex home")
    if (home / ".gemini").exists():
        raise AssertionError("Cursor setup touched Antigravity home")


def assert_antigravity(home):
    plugin = home / ".gemini" / "config" / "plugins" / "fable-mcp"
    if not (plugin / "plugin.json").exists():
        raise AssertionError("Antigravity plugin manifest missing")
    if not (plugin / "dist" / "server.bundled.mjs").exists():
        raise AssertionError("Antigravity server bundle missing")
    data = json.loads((plugin / "mcp_config.json").read_text())
    server = data["mcpServers"]["fable"]
    if not Path(server["args"][0]).is_absolute():
        raise AssertionError("Antigravity setup should rewrite server path to absolute")
    if (home / ".codex").exists():
        raise AssertionError("Antigravity setup touched Codex home")
    if (home / ".cursor").exists():
        raise AssertionError("Antigravity setup touched Cursor home")


def main():
    run_client("cursor", assert_cursor)
    run_client("antigravity", assert_antigravity)
    print("current-agent setup smoke passed")


if __name__ == "__main__":
    main()
