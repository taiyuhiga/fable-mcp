#!/usr/bin/env node
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pluginRoot = join(root, "plugins", "fable-mcp");
const cursorPluginRoot = join(root, "plugins", "fable-mcp-cursor");
const antigravityPluginRoot = join(root, "plugins", "fable-mcp-antigravity");

mkdirSync(join(pluginRoot, "dist"), { recursive: true });
mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
mkdirSync(join(pluginRoot, "skills"), { recursive: true });
mkdirSync(join(cursorPluginRoot, "dist"), { recursive: true });
mkdirSync(join(antigravityPluginRoot, "dist"), { recursive: true });

cpSync(join(root, "dist", "server.bundled.mjs"), join(pluginRoot, "dist", "server.bundled.mjs"));
cpSync(join(root, "dist", "server.bundled.mjs"), join(cursorPluginRoot, "dist", "server.bundled.mjs"));
cpSync(join(root, "dist", "server.bundled.mjs"), join(antigravityPluginRoot, "dist", "server.bundled.mjs"));
cpSync(join(root, "fable-session.md"), join(pluginRoot, "fable-session.md"));
cpSync(join(root, "hooks", "hooks.json"), join(pluginRoot, "hooks", "hooks.json"));
cpSync(join(root, "hooks", "fable-loop-stop.mjs"), join(pluginRoot, "hooks", "fable-loop-stop.mjs"));
cpSync(join(root, "hooks", "fable-loop-prompt-submit.mjs"), join(pluginRoot, "hooks", "fable-loop-prompt-submit.mjs"));
cpSync(join(root, "hooks", "inject-fable-instructions.mjs"), join(pluginRoot, "hooks", "inject-fable-instructions.mjs"));
cpSync(join(root, "skills", "fable"), join(pluginRoot, "skills", "fable"), { recursive: true });
