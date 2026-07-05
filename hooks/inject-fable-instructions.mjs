#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function pluginRoot() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  return resolve(fileURLToPath(import.meta.url), "..", "..");
}

try {
  const content = readFileSync(join(pluginRoot(), "fable-session.md"), "utf8").trim();
  if (content) process.stdout.write(content);
} catch {
  // SessionStart context is helpful but not required. Fail closed with no output.
}
