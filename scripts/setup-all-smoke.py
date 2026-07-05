#!/usr/bin/env python3
import importlib.util
import json
import os
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SETUP = ROOT / "setup-all.py"

spec = importlib.util.spec_from_file_location("setup_all", SETUP)
setup_all = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup_all)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        home = Path(tmp)
        old_home = os.environ.get("HOME")
        os.environ["HOME"] = str(home)
        try:
            cursor_result = setup_all.configure_cursor(ROOT)
            assert cursor_result["status"] == "ok", cursor_result
            cursor_plugin = home / ".cursor" / "plugins" / "local" / "fable-mcp"
            data = json.loads((cursor_plugin / "mcp.json").read_text())
            server = data["mcpServers"]["fable"]
            assert server["command"], server
            assert server["type"] == "stdio", server
            assert server["args"] == [str(cursor_plugin / "dist" / "server.bundled.mjs")], server

            antigravity_result = setup_all.configure_antigravity(ROOT)
            assert antigravity_result["status"] == "ok", antigravity_result
            ag_plugin = home / ".gemini" / "config" / "plugins" / "fable-mcp"
            ag_data = json.loads((ag_plugin / "mcp_config.json").read_text())
            ag_server = ag_data["mcpServers"]["fable"]
            assert ag_server["command"], ag_server
            assert ag_server["args"] == [str(ag_plugin / "dist" / "server.bundled.mjs")], ag_server
        finally:
            if old_home is None:
                os.environ.pop("HOME", None)
            else:
                os.environ["HOME"] = old_home

    print("setup-all smoke ok")


if __name__ == "__main__":
    main()
