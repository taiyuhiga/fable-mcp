#!/usr/bin/env python3
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


def bundle_root():
    return Path(__file__).resolve().parent


def default_source():
    return str(bundle_root())


def okish(returncode, output):
    if returncode == 0:
        return True
    text = output.lower()
    return "already" in text and any(word in text for word in ["install", "installed", "exist", "configured", "added"])


def run(label, command, *, optional=False):
    executable = shutil.which(command[0])
    if not executable:
        return {
            "label": label,
            "status": "skipped" if optional else "failed",
            "reason": f"{command[0]} CLI not found",
            "command": command,
        }
    full_command = [executable, *command[1:]]
    result = subprocess.run(full_command, text=True, capture_output=True)
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
    if not shutil.which("npm"):
        return {"label": "bundle", "status": "failed", "reason": "dist/server.bundled.mjs missing and npm not found"}
    if not (root / "package.json").exists():
        return {"label": "bundle", "status": "failed", "reason": "package.json not found"}

    install = subprocess.run([shutil.which("npm"), "install"], cwd=root, text=True, capture_output=True)
    build = subprocess.run([shutil.which("npm"), "run", "build"], cwd=root, text=True, capture_output=True) if install.returncode == 0 else None
    output = "\n".join(
        part
        for part in [
            install.stdout[-1000:],
            install.stderr[-1000:],
            build.stdout[-1000:] if build else "",
            build.stderr[-1000:] if build else "",
        ]
        if part
    )
    if bundle.exists():
        return {"label": "bundle", "status": "ok", "path": str(bundle), "output": output[-3000:]}
    return {"label": "bundle", "status": "failed", "reason": "build did not create dist/server.bundled.mjs", "output": output[-3000:]}


def install_claude_cli():
    if shutil.which("claude"):
        return {"label": "claude_cli", "status": "ok", "path": shutil.which("claude"), "version": subprocess.getoutput("claude --version")}
    if not shutil.which("npm"):
        return {"label": "claude_cli", "status": "skipped", "reason": "claude CLI not found and npm not found"}
    result = subprocess.run([shutil.which("npm"), "install", "-g", "@anthropic-ai/claude-code"], text=True, capture_output=True)
    combined = "\n".join(part for part in [result.stdout.strip(), result.stderr.strip()] if part)
    if shutil.which("claude"):
        return {"label": "claude_cli", "status": "ok", "path": shutil.which("claude"), "version": subprocess.getoutput("claude --version"), "output": combined[-2000:]}
    return {"label": "claude_cli", "status": "failed", "returncode": result.returncode, "output": combined[-4000:]}


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
        backup = path.with_suffix(path.suffix + ".fable-mcp.bak")
        backup.write_text(path.read_text())
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


def configure_cursor(root):
    src = root / "plugins" / "fable-mcp-cursor"
    target = Path.home() / ".cursor" / "plugins" / "local" / "fable-mcp"
    copy_plugin_tree(src, target)
    rewrite_plugin_mcp(target, "mcp.json", include_type=True)
    return {"label": "cursor_plugin", "status": "ok", "path": str(target)}


def configure_antigravity(root):
    src = root / "plugins" / "fable-mcp-antigravity"
    target = Path.home() / ".gemini" / "config" / "plugins" / "fable-mcp"
    copy_plugin_tree(src, target)
    rewrite_plugin_mcp(target, "mcp_config.json")
    return {"label": "antigravity_plugin", "status": "ok", "path": str(target)}


def configure_codex(source):
    return [
        run("codex_marketplace", ["codex", "plugin", "marketplace", "add", source], optional=True),
        run("codex_plugin", ["codex", "plugin", "add", PLUGIN], optional=True),
    ]


def configure_claude(source):
    return [
        run("claude_marketplace", ["claude", "plugin", "marketplace", "add", source], optional=True),
        run("claude_plugin", ["claude", "plugin", "install", "--scope", "user", PLUGIN], optional=True),
    ]


def main():
    parser = argparse.ArgumentParser(description="Set up fable-mcp for Codex, Claude Code, Cursor, and Antigravity when available.")
    parser.add_argument("source", nargs="?", default=default_source(), help="Marketplace source. Defaults to this checkout.")
    parser.add_argument("--no-claude-install", action="store_true", help="Do not try to install Claude Code CLI when missing.")
    parser.add_argument("--skip-codex", action="store_true")
    parser.add_argument("--skip-claude", action="store_true")
    parser.add_argument("--skip-cursor", action="store_true")
    parser.add_argument("--skip-antigravity", action="store_true")
    args = parser.parse_args()

    root = bundle_root()
    results = [ensure_node(), ensure_bundle(root)]
    if not args.no_claude_install:
        results.append(install_claude_cli())
    else:
        results.append({"label": "claude_cli", "status": "skipped", "reason": "--no-claude-install"})

    if not args.skip_codex:
        results.extend(configure_codex(args.source))
    if not args.skip_claude:
        results.extend(configure_claude(args.source))
    if not args.skip_cursor:
        results.append(configure_cursor(root))
    if not args.skip_antigravity:
        results.append(configure_antigravity(root))

    summary = {
        "source": args.source,
        "repo": str(root),
        "results": results,
        "next_steps": [
            "Restart Codex if codex_plugin is ok.",
            "Restart Claude Code or run /reload-plugins if claude_plugin is ok.",
            "Restart Cursor if cursor_plugin is ok.",
            "Restart Antigravity if antigravity_plugin is ok.",
            "Ask: Fableの状態を確認して",
            "If authentication is missing, set ANTHROPIC_API_KEY or log in/configure the claude CLI.",
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 1 if any(item["status"] == "failed" for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
