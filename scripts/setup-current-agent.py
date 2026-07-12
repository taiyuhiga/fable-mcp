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


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

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


def ensure_claude_runtime(skip, no_install):
    if skip:
        return {"label": "claude_runtime", "status": "skipped", "reason": "--skip-runtime-check"}
    claude = shutil.which("claude")
    if claude:
        return {"label": "claude_runtime", "status": "ok", "path": claude, "version": subprocess.getoutput("claude --version")}
    if no_install:
        return {
            "label": "claude_runtime",
            "status": "failed",
            "reason": "claude CLI not found and automatic installation was disabled",
        }
    npm = shutil.which("npm")
    if not npm:
        return {"label": "claude_runtime", "status": "failed", "reason": "npm not found; cannot install Claude Code CLI"}
    result = subprocess.run(
        [npm, "install", "-g", "@anthropic-ai/claude-code"],
        text=True,
        capture_output=True,
    )
    claude = shutil.which("claude")
    if result.returncode == 0 and claude:
        return {
            "label": "claude_runtime",
            "status": "ok",
            "path": claude,
            "version": subprocess.getoutput("claude --version"),
            "installed": True,
        }
    return {
        "label": "claude_runtime",
        "status": "failed",
        "reason": "Claude Code CLI installation failed",
        "output": "\n".join([result.stdout, result.stderr])[-4000:],
    }


def verify_auth(root, skip, skip_live_check, auth_mode):
    if skip:
        return {"label": "claude_auth", "status": "skipped", "reason": "explicit auth/runtime skip"}
    node = shutil.which("node")
    verifier = root / "scripts" / "verify-claude-auth.mjs"
    resolved_mode = auth_mode
    if resolved_mode == "auto":
        resolved_mode = "api" if os.environ.get("ANTHROPIC_API_KEY") else "login"
    if resolved_mode == "api" and not os.environ.get("ANTHROPIC_API_KEY"):
        return {
            "label": "claude_auth",
            "status": "failed",
            "reason": "API authentication was selected, but ANTHROPIC_API_KEY is not set",
        }
    command = [node, str(verifier), "--mode", resolved_mode]
    if skip_live_check:
        command.append("--skip-live-check")
    auth_env = os.environ.copy()
    if resolved_mode == "login":
        auth_env.pop("ANTHROPIC_API_KEY", None)
    result = subprocess.run(command, text=True, capture_output=True, env=auth_env)
    output = "\n".join(part for part in [result.stdout.strip(), result.stderr.strip()] if part)
    return {
        "label": "claude_auth",
        "status": "ok" if result.returncode == 0 else "failed",
        "returncode": result.returncode,
        "output": output[-4000:],
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


def mcp_stdio_config(root, *, include_type=False, auth_mode="auto"):
    node = shutil.which("node") or "node"
    server = root / "dist" / "server.bundled.mjs"
    env = {}
    claude_bin = shutil.which("claude")
    if claude_bin:
        env["FABLE_CLAUDE_BIN"] = claude_bin
    for key in ENV_KEYS:
        if key == "ANTHROPIC_API_KEY" and auth_mode == "login":
            continue
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


def rewrite_plugin_mcp(plugin_root, filename, *, include_type=False, auth_mode="auto"):
    path = plugin_root / filename
    data = load_json_config(path)
    servers = data.setdefault("mcpServers", {})
    servers[SERVER_NAME] = mcp_stdio_config(plugin_root, include_type=include_type, auth_mode=auth_mode)
    write_json_config(path, data, backup=False)


def configure_codex(root, source, auth_mode):
    env = os.environ.copy()
    results = [
        run("codex_marketplace", ["codex", "plugin", "marketplace", "add", source], env=env),
        run("codex_plugin", ["codex", "plugin", "add", PLUGIN], env=env),
    ]
    results.append(run("codex_mcp_list", ["codex", "mcp", "list"], optional=True, env=env))
    api_key = os.environ.get("ANTHROPIC_API_KEY") if auth_mode != "login" else None
    config = user_home() / ".codex" / "config.toml"
    helper = root / "scripts" / "configure-codex-plugin-env.mjs"
    node = shutil.which("node") or "node"
    if api_key:
        result = subprocess.run(
            [node, str(helper), "--config", str(config), "--effort", os.environ.get("FABLE_EFFORT", "medium")],
            input=api_key,
            text=True,
            capture_output=True,
        )
        results.append({
            "label": "codex_api_env",
            "status": "ok" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "output": "\n".join([result.stdout.strip(), result.stderr.strip()])[-4000:],
        })
    else:
        result = subprocess.run(
            [node, str(helper), "--config", str(config), "--remove-api-key"],
            text=True,
            capture_output=True,
        )
        results.append({
            "label": "codex_login_env",
            "status": "ok" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "output": "\n".join([result.stdout.strip(), result.stderr.strip()])[-4000:],
        })
    return results


def configure_cursor(root, auth_mode):
    src = root / "plugins" / "fable-mcp-cursor"
    target = user_home() / ".cursor" / "plugins" / "local" / "fable-mcp"
    copy_plugin_tree(src, target)
    rewrite_plugin_mcp(target, "mcp.json", include_type=True, auth_mode=auth_mode)

    # Cursor plugin marketplace install is UI-driven in some environments, so
    # also write a Cursor-only MCP fallback. This does not touch Codex or
    # Antigravity and makes the server usable even before the plugin UI reloads.
    global_mcp = user_home() / ".cursor" / "mcp.json"
    data = load_json_config(global_mcp)
    servers = data.setdefault("mcpServers", {})
    servers[SERVER_NAME] = mcp_stdio_config(target, include_type=True, auth_mode=auth_mode)
    write_json_config(global_mcp, data)
    return [{"label": "cursor_plugin", "status": "ok", "path": str(target)}, {"label": "cursor_mcp", "status": "ok", "path": str(global_mcp)}]


def configure_antigravity(root, auth_mode):
    src = root / "plugins" / "fable-mcp-antigravity"
    target = user_home() / ".gemini" / "config" / "plugins" / "fable-mcp"
    copy_plugin_tree(src, target)
    rewrite_plugin_mcp(target, "mcp_config.json", auth_mode=auth_mode)
    return [{"label": "antigravity_plugin", "status": "ok", "path": str(target)}]


def parse_args():
    parser = argparse.ArgumentParser(description="Set up fable-mcp for exactly one selected AI agent.")
    parser.add_argument("--client", required=True, choices=["codex", "cursor", "antigravity"], help="Host agent to configure. Only this client is touched.")
    parser.add_argument("--source", default=str(repo_root()), help="Marketplace source for Codex. Defaults to this checkout.")
    parser.add_argument("--skip-runtime-check", action="store_true", help="Test/setup-only compatibility flag: skip Claude runtime and auth.")
    parser.add_argument("--no-claude-install", action="store_true", help="Fail instead of installing Claude Code CLI when it is missing.")
    parser.add_argument("--skip-auth", action="store_true", help="Explicitly allow an incomplete setup without Claude authentication.")
    parser.add_argument("--skip-live-check", action="store_true", help="Confirm auth state without the minimal live Fable request.")
    parser.add_argument("--auth", choices=["auto", "login", "api"], default="auto", help="Authentication selected by the host agent's AskUserQuestion. Claude login should be offered first.")
    return parser.parse_args()


def main():
    args = parse_args()
    root = repo_root()
    skip_auth = args.skip_auth or args.skip_runtime_check
    results = [
        ensure_node(),
        ensure_bundle(root),
        ensure_claude_runtime(args.skip_runtime_check, args.no_claude_install),
    ]
    if not any(item["status"] == "failed" for item in results):
        results.append(verify_auth(root, skip_auth, args.skip_live_check, args.auth))

    try:
        if args.client == "codex":
            results.extend(configure_codex(root, args.source, args.auth))
            next_steps = ["Restart Codex.", "Ask: Fableの状態を確認して"]
        elif args.client == "cursor":
            results.extend(configure_cursor(root, args.auth))
            next_steps = ["Restart Cursor or reload plugins/MCP.", "Ask: Fableの状態を確認して"]
        elif args.client == "antigravity":
            results.extend(configure_antigravity(root, args.auth))
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
