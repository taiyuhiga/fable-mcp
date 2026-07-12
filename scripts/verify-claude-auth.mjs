#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const getArg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};

const mode = getArg("--mode", "auto");
const model = getArg("--model", process.env.FABLE_MODEL || "claude-fable-5");
const nonInteractive = args.has("--non-interactive");
const skipLiveCheck = args.has("--skip-live-check");
const claude = process.env.FABLE_CLAUDE_BIN || "claude";

if (!["auto", "api", "login"].includes(mode)) {
  console.error(`Unsupported auth mode: ${mode}`);
  process.exit(2);
}

function run(commandArgs, options = {}) {
  return spawnSync(claude, commandArgs, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    env: process.env,
    input: options.input,
    windowsHide: true,
    shell: process.platform === "win32",
  });
}

function fail(message, result) {
  console.error(`Authentication setup failed: ${message}`);
  const detail = `${result?.stderr || ""}\n${result?.stdout || ""}`.trim();
  if (detail) console.error(detail.slice(-2000));
  process.exit(1);
}

const version = run(["--version"]);
if (version.error?.code === "ENOENT") {
  fail("Claude Code CLI was not found on PATH.", version);
}
if (version.status !== 0) fail("Claude Code CLI could not be started.", version);

const resolvedMode = mode === "auto"
  ? (process.env.ANTHROPIC_API_KEY ? "api" : "login")
  : mode;

if (resolvedMode === "api") {
  if (!process.env.ANTHROPIC_API_KEY) {
    fail("API mode requires ANTHROPIC_API_KEY in the environment.");
  }
  console.log("Authentication method: Anthropic API key (metered billing)");
} else {
  const statusBefore = run(["auth", "status"]);
  let loggedIn = false;
  if (statusBefore.status === 0) {
    try {
      loggedIn = Boolean(JSON.parse(statusBefore.stdout).loggedIn);
    } catch {
      loggedIn = /logged.?in/i.test(statusBefore.stdout);
    }
  }

  if (!loggedIn) {
    if (nonInteractive) {
      fail("Claude account login is required, but setup is non-interactive.", statusBefore);
    }
    console.log("Opening Claude account login...");
    const login = run(["auth", "login"], { inherit: true });
    if (login.status !== 0) fail("`claude auth login` did not complete successfully.", login);
  }

  const statusAfter = run(["auth", "status"]);
  if (statusAfter.status !== 0) fail("`claude auth status` failed after login.", statusAfter);
  try {
    if (!JSON.parse(statusAfter.stdout).loggedIn) fail("Claude CLI still reports loggedIn=false.", statusAfter);
  } catch {
    if (!/logged.?in/i.test(statusAfter.stdout)) fail("Could not confirm Claude login status.", statusAfter);
  }
  console.log("Authentication method: Claude account login");
}

if (skipLiveCheck) {
  console.log("Authentication state confirmed; live Fable check skipped by explicit option.");
  process.exit(0);
}

console.log(`Checking access to ${model} with one minimal request...`);
const live = run([
  "-p",
  "Reply with exactly AUTH_OK and nothing else.",
  "--model", model,
  "--permission-mode", "plan",
  "--output-format", "json",
  "--max-turns", "1",
]);
if (live.status !== 0) fail(`A live ${model} request was rejected.`, live);

let payload;
try {
  payload = JSON.parse(live.stdout);
} catch {
  fail("Claude returned non-JSON output during the live check.", live);
}
if (payload.is_error || !String(payload.result || "").includes("AUTH_OK")) {
  fail(`Claude did not confirm access to ${model}.`, live);
}

console.log(`Authentication and ${model} access verified successfully.`);
