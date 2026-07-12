#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const getArg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const config = getArg("--config");
const effort = getArg("--effort", "medium");
const removeApiKey = process.argv.includes("--remove-api-key");
const table = '[plugins."fable-mcp@fable-mcp".mcp_servers.fable.env]';

if (!config) {
  console.error("--config is required");
  process.exit(2);
}

let apiKey = "";
if (!removeApiKey) for await (const chunk of process.stdin) apiKey += chunk;
apiKey = apiKey.replace(/[\r\n]+$/, "");
if (!removeApiKey && !apiKey) {
  console.error("ANTHROPIC_API_KEY was empty; config was not changed.");
  process.exit(2);
}

const quote = (value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
mkdirSync(dirname(config), { recursive: true });
const existed = existsSync(config);
let source = existed ? readFileSync(config, "utf8") : "";
const lines = source.split(/\r?\n/);
const indexes = lines.flatMap((line, index) => line.trim() === table ? [index] : []);
if (indexes.length > 1) {
  console.error(`Multiple ${table} sections found; refusing to guess.`);
  process.exit(1);
}

const values = removeApiKey ? [] : [
  `ANTHROPIC_API_KEY = ${quote(apiKey)}`,
  `FABLE_EFFORT = ${quote(effort)}`,
];

if (indexes.length === 0) {
  if (removeApiKey) {
    console.log(`No fable-mcp API override found in ${config}`);
    process.exit(0);
  }
  source = `${source.replace(/\s*$/, "")}\n\n${table}\n${values.join("\n")}\n`;
} else {
  const start = indexes[0];
  let end = start + 1;
  while (end < lines.length && !/^\s*\[.*\]\s*$/.test(lines[end])) end += 1;
  const body = lines.slice(start + 1, end)
    .filter((line) => !/^\s*(ANTHROPIC_API_KEY|FABLE_EFFORT)\s*=/.test(line));
  lines.splice(start + 1, end - start - 1, ...values, ...body);
  source = lines.join("\n");
  if (!source.endsWith("\n")) source += "\n";
}

if (existed) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const backup = `${config}.bak.${stamp}`;
  copyFileSync(config, backup);
  chmodSync(backup, 0o600);
}
writeFileSync(config, source, { mode: 0o600 });
console.log(removeApiKey
  ? `Removed fable-mcp API-key override from ${config}; Claude login will be used`
  : `Configured fable-mcp API billing in ${config}`);
