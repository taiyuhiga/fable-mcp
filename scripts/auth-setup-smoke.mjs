#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "fable-auth-smoke-"));
const fakeJs = join(temp, "fake-claude.mjs");
const marker = join(temp, "logged-in");
const log = join(temp, "args.log");

writeFileSync(fakeJs, `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("fake claude 1.0"); process.exit(0); }
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: existsSync(process.env.FAKE_MARKER) }));
  process.exit(existsSync(process.env.FAKE_MARKER) ? 0 : 1);
}
if (args[0] === "auth" && args[1] === "login") {
  writeFileSync(process.env.FAKE_MARKER, "ok"); process.exit(0);
}
if (args[0] === "-p") {
  if (process.env.FAKE_LIVE_FAIL === "1") { console.error("401 invalid auth"); process.exit(1); }
  console.log(JSON.stringify({ result: "AUTH_OK", is_error: false })); process.exit(0);
}
process.exit(2);
`);

let fakeBin;
if (process.platform === "win32") {
  fakeBin = join(temp, "claude.cmd");
  writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
} else {
  fakeBin = join(temp, "claude");
  writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(fakeBin, 0o755);
}

const verifier = join(root, "scripts", "verify-claude-auth.mjs");
const baseEnv = { ...process.env, FABLE_CLAUDE_BIN: fakeBin, FAKE_MARKER: marker, FAKE_LOG: log };
const run = (args, env = {}) => spawnSync(process.execPath, [verifier, ...args], {
  encoding: "utf8",
  env: { ...baseEnv, ...env },
});

const api = run(["--mode", "api"], { ANTHROPIC_API_KEY: "smoke-secret" });
if (api.status !== 0 || !api.stdout.includes("verified successfully")) throw new Error(`API auth smoke failed: ${api.stderr}`);
if (readFileSync(log, "utf8").includes("smoke-secret")) throw new Error("API key leaked into process arguments");

const login = run(["--mode", "login"]);
if (login.status !== 0 || !login.stdout.includes("Claude account login")) throw new Error(`login smoke failed: ${login.stderr}`);

const rejected = run(["--mode", "api"], { ANTHROPIC_API_KEY: "bad", FAKE_LIVE_FAIL: "1" });
if (rejected.status === 0 || !rejected.stderr.includes("live")) throw new Error("live auth rejection was not detected");

const config = join(temp, "config.toml");
writeFileSync(config, 'model = "test"\n');
const configure = join(root, "scripts", "configure-codex-plugin-env.mjs");
const first = spawnSync(process.execPath, [configure, "--config", config], { input: "first-key", encoding: "utf8" });
if (first.status !== 0) throw new Error(first.stderr);
const second = spawnSync(process.execPath, [configure, "--config", config, "--effort", "high"], { input: "second-key", encoding: "utf8" });
if (second.status !== 0) throw new Error(second.stderr);
const configured = readFileSync(config, "utf8");
if (!configured.includes('ANTHROPIC_API_KEY = "second-key"') || configured.includes("first-key") || !configured.includes('FABLE_EFFORT = "high"')) {
  throw new Error("Codex plugin env was not safely updated");
}
if (`${first.stdout}${second.stdout}${first.stderr}${second.stderr}`.includes("second-key")) throw new Error("API key leaked into helper output");
const removed = spawnSync(process.execPath, [configure, "--config", config, "--remove-api-key"], { encoding: "utf8" });
if (removed.status !== 0 || readFileSync(config, "utf8").includes("ANTHROPIC_API_KEY")) {
  throw new Error("API key override was not removed when switching to Claude login");
}

const agentContract = readFileSync(join(root, "AGENTS.md"), "utf8");
const askIndex = agentContract.indexOf("AskUserQuestion");
const contractLoginIndex = agentContract.indexOf("Claude account login (Recommended)");
const contractApiIndex = agentContract.indexOf("Anthropic API key");
if (askIndex < 0 || contractLoginIndex < 0 || contractApiIndex < 0 || contractLoginIndex > contractApiIndex) {
  throw new Error("Agent setup contract must require AskUserQuestion with Claude login before Anthropic API key");
}

const shellInstaller = readFileSync(join(root, "install.sh"), "utf8");
const shellLoginIndex = shellInstaller.indexOf("1) Claude account login");
const shellApiIndex = shellInstaller.indexOf("2) Anthropic API key");
if (shellLoginIndex < 0 || shellApiIndex < 0 || shellLoginIndex > shellApiIndex || !shellInstaller.includes('mode="api" || mode="login"')) {
  throw new Error("Shell installer must show Claude login first and use it as the default choice");
}

const powershellInstaller = readFileSync(join(root, "install.ps1"), "utf8");
const psLoginIndex = powershellInstaller.indexOf("1) Claude account login");
const psApiIndex = powershellInstaller.indexOf("2) Anthropic API key");
if (psLoginIndex < 0 || psApiIndex < 0 || psLoginIndex > psApiIndex || !powershellInstaller.includes('{ "api" } else { "login" }')) {
  throw new Error("PowerShell installer must show Claude login first and use it as the default choice");
}

console.log("auth setup smoke passed");
