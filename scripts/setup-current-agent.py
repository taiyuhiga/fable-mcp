#!/usr/bin/env python3
"""Install fable-mcp for exactly one host agent.

This intentionally avoids "set up everything" behavior. If Codex runs it, pass
--client codex; if Cursor runs it, pass --client cursor; if Antigravity runs it,
pass --client antigravity.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


PLUGIN = "fable-mcp@fable-mcp"
SERVER_NAME = "fable"
ENV_KEYS = [
    "ANTHROPIC_API_KEY",
    "FABLE_MODEL",
    "FABLE_EFFORT",
    "FABLE_MAX_TURNS",
    "FABLE_TIMEOUT_MS",
    "FABLE_CLAUDE_BIN",
]


def repo_root():
    return Path(__file__).resolve().parent.parent


def user_home():
    override = os.environ.get("FABLE_MCP_HOME")
    return Path(override).expanduser() if override else Path.home()


def okish(returncode, output):
    if returncode == 0:
        return True
    text = output.lower()
    return "already" in text and any(word in text for word in ["install", "installed", "exist", "configured", "added"])


def run(label, command, *, optional=False, env=None):
    executable = shutil.which(command[0])
    if not executable:
        return {
            "label": label,
            "status": "skipped" if optional else "failed",
            "reason": f"{command[0]} CLI not found",
            "command": command,
        }
    full_command = [executable, *command[1:]]
    result = subprocess.run(full_command, text=True, capture_output=True, env=env)
    combined = "\n".join(part for part in [result.stdout.strip(), result.stderr.strip()] if part)
    return {
        "label": label,
        "status": "ok" if okish(result.returncode, combined) else "failed",
        "returncode": result.returncode,
        "command": command,
        "output": combined[-4000:],
    }


def ensure_node():
    node = shutil.which("node")
    if not node:
        return {"label": "node", "status": "failed", "reason": "Node.js 18+ is required"}
    result = subprocess.run([node, "-p", "Number(process.versions.node.split('.')[0])"], text=True, capture_output=True)
    try:
        major = int(result.stdout.strip())
    except ValueError:
        major = 0
    if major < 18:
        return {"label": "node", "status": "failed", "reason": f"Node.js 18+ is required, got {subprocess.getoutput('node --version')}"}
    return {"label": "node", "status": "ok", "path": node, "version": subprocess.getoutput("node --version")}


def ensure_bundle(root):
    bundle = root / "dist" / "server.bundled.mjs"
    if bundle.exists():
        return {"label": "bundle", "status": "ok", "path": str(bundle)}
    return {"label": "bundle", "status": "failed", "reason": "dist/server.bundled.mjs is missing; run npm install && npm run build"}


def check_claude_runtime(skip):
    if skip:
        return {"label": "claude_runtime", "status": "skipped", "reason": "--skip-runtime-check"}
    claude = shutil.which("claude")
    if claude:
        return {"label": "claude_runtime", "status": "ok", "path": claude, "version": subprocess.getoutput("claude --version")}
    return {
        "label": "claude_runtime",
        "status": "warning",
        "reason": "claude CLI not found. This setup touches only the selected host agent; install the runtime separately with npm i -g @anthropic-ai/claude-code if you want to call Fable.",
    }


def load_json_config(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{path} is not valid JSON: {exc}")


def write_json_config(path, data, *, backup=True):
    path.parent.mkdir(parents=True, exist_ok=True)
    if backup and path.exists():
        backup_path = path.with_suffix(path.suffix + ".fable-mcp.bak")
        backup_path.write_text(path.read_text())
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def mcp_stdio_config(root, *, include_type=False):
    node = shutil.which("node") or "node"
    server = root / "dist" / "server.bundled.mjs"
    env = {}
    claude_bin = shutil.which("claude")
    if claude_bin:
        env["FABLE_CLAUDE_BIN"] = claude_bin
    for key in ENV_KEYS:
        value = os.environ.get(key)
        if value:
            env[key] = value
    config = {
        "command": node,
        "args": [str(server)],
    }
    if include_type:
        config["type"] = "stdio"
    if env:
        config["env"] = env
    return config


def copy_plugin_tree(src, target):
    if not src.exists():
        raise RuntimeError(f"plugin source not found: {src}")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink():
        target.unlink()
    shutil.copytree(src, target, dirs_exist_ok=True)
    return target


def rewrite_plugin_mcp(plugin_root, filename, *, include_type=False):
    path = plugin_root / filename
    data = load_json_config(path)
    servers = data.setdefault("mcpServers", {})
    servers[SERVER_NAME] = mcp_stdio_config(plugin_root, include_type=include_type)
    write_json_config(path, data, backup=False)


def configure_codex(root, source):
    env = os.environ.copy()
    results = [
        run("codex_marketplace", ["codex", "plugin", "marketplace", "add", source], env=env),
        run("codex_plugin", ["codex", "plugin", "add", PLUGIN], env=env),
    ]
    results.append(run("codex_mcp_list", ["codex", "mcp", "list"], optional=True, env=env))
    return results


def configure_cursor(root):
    src = root / "plugins" / "fable-mcp-cursor"
    target = user_home() / ".cursor" / "plugins" / "local" / "fable-mcp"
    copy_plugin_tree(src, target)
    rewrite_plugin_mcp(target, "mcp.json", include_type=True)

    # Cursor plugin marketplace install is UI-driven in some environments, so
    # also write a Cursor-only MCP fallback. This does not touch Codex or
    # Antigravity and makes the server usable even before the plugin UI reloads.
    global_mcp = user_home() / ".cursor" / "mcp.json"
    data = load_json_config(global_mcp)
    servers = data.setdefault("mcpServers", {})
    servers[SERVER_NAME] = mcp_stdio_config(target, include_type=True)
    write_json_config(global_mcp, data)
    return [{"label": "cursor_plugin", "status": "ok", "path": str(target)}, {"label": "cursor_mcp", "status": "ok", "path": str(global_mcp)}]


def configure_antigravity(root):
    src = root / "plugins" / "fable-mcp-antigravity"
    target = user_home() / ".gemini" / "config" / "plugins" / "fable-mcp"
    copy_plugin_tree(src, target)
    rewrite_plugin_mcp(target, "mcp_config.json")
    return [{"label": "antigravity_plugin", "status": "ok", "path": str(target)}]


def parse_args():
    parser = argparse.ArgumentParser(description="Set up fable-mcp for exactly one selected AI agent.")
    parser.add_argument("--client", required=True, choices=["codex", "cursor", "antigravity"], help="Host agent to configure. Only this client is touched.")
    parser.add_argument("--source", default=str(repo_root()), help="Marketplace source for Codex. Defaults to this checkout.")
    parser.add_argument("--skip-runtime-check", action="store_true", help="Skip the claude CLI runtime warning/check.")
    return parser.parse_args()


def main():
    args = parse_args()
    root = repo_root()
    results = [ensure_node(), ensure_bundle(root), check_claude_runtime(args.skip_runtime_check)]

    try:
        if args.client == "codex":
            results.extend(configure_codex(root, args.source))
            next_steps = ["Restart Codex.", "Ask: Fableの状態を確認して"]
        elif args.client == "cursor":
            results.extend(configure_cursor(root))
            next_steps = ["Restart Cursor or reload plugins/MCP.", "Ask: Fableの状態を確認して"]
        elif args.client == "antigravity":
            results.extend(configure_antigravity(root))
            next_steps = ["Restart Antigravity or reload plugins/MCP.", "Ask: Fableの状態を確認して"]
        else:
            raise AssertionError(args.client)
    except Exception as exc:
        results.append({"label": f"{args.client}_setup", "status": "failed", "reason": str(exc)})
        next_steps = []

    summary = {
        "client": args.client,
        "repo": str(root),
        "policy": "configured exactly one host client; no cross-client setup",
        "results": results,
        "next_steps": next_steps,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] == "failed" for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
