#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("..", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "fable-model-effort-"));
const project = join(temp, "project");
const fakeJs = join(temp, "fake-claude.mjs");
const fakeBin = join(temp, process.platform === "win32" ? "claude.cmd" : "claude");
const logPath = join(temp, "calls.jsonl");

await import("node:fs/promises").then(({ mkdir }) => mkdir(project, { recursive: true }));

writeFileSync(
  fakeJs,
  `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + "\\n");
let result = "MODEL_EFFORT_OK";
if (prompt.includes("<criteria>")) {
  result = "Plan\\n<criteria>\\n## Acceptance criteria\\n### machine\\n- smoke passes\\n### axes\\n- correctness (100): exact forwarding\\n</criteria>";
}
if (prompt.includes("<eval>")) {
  result = 'Review\\n<eval>{"score":100,"breakdown":{"correctness":100},"feedback":"none"}</eval>';
}
console.log(JSON.stringify({
  type: "result",
  subtype: "success",
  result,
  session_id: "12345678-1234-1234-1234-123456789abc",
  is_error: false,
  num_turns: 1,
  total_cost_usd: 0
}));
`
);

if (process.platform === "win32") {
  writeFileSync(fakeBin, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
} else {
  writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${fakeJs}" "$@"\n`);
  chmodSync(fakeBin, 0o755);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, "server.mjs")],
  env: {
    ...process.env,
    FABLE_CLAUDE_BIN: fakeBin,
    FAKE_CLAUDE_LOG: logPath,
    FABLE_MODEL: "claude-fable-5",
    FABLE_MAX_TURNS: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "model-effort-smoke", version: "1.0.0" });

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${result.content?.[0]?.text || "unknown"}`);
  return result;
};

try {
  await client.connect(transport);

  // Fable 5 remains the default and every documented effort value is forwarded exactly.
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
    await call("fable_ask", { question: `effort ${effort}`, cwd: project, effort });
  }

  // Model IDs are pass-through, not a fixed allowlist. Include provider/future-style syntax.
  await call("fable_ask", {
    question: "Opus 4.7",
    cwd: project,
    model: "claude-opus-4-7",
    effort: "max",
  });
  await call("fable_ask", {
    question: "future model",
    cwd: project,
    model: "arn:aws:bedrock:us-east-1:123456789012:inference-profile/future-model-6",
    effort: "high",
  });

  // Quality-loop review inherits both the plan model and effort when omitted on review.
  await call("fable_plan", {
    task: "verify model inheritance",
    cwd: project,
    model: "claude-opus-4-8",
    effort: "xhigh",
    loop_threshold: 90,
  });
  await call("fable_loop_approve", { cwd: project });
  await call("fable_review", { cwd: project });
} finally {
  await client.close();
}

const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const argValue = (entry, flag) => entry.args[entry.args.indexOf(flag) + 1];

for (let i = 0; i < 5; i++) {
  if (argValue(calls[i], "--model") !== "claude-fable-5") {
    throw new Error(`default model was not Fable 5 on call ${i + 1}`);
  }
  if (argValue(calls[i], "--effort") !== ["low", "medium", "high", "xhigh", "max"][i]) {
    throw new Error(`effort was not forwarded exactly on call ${i + 1}`);
  }
}

if (argValue(calls[5], "--model") !== "claude-opus-4-7" || argValue(calls[5], "--effort") !== "max") {
  throw new Error("Opus 4.7 model/effort was not passed through");
}

if (argValue(calls[6], "--model") !== "arn:aws:bedrock:us-east-1:123456789012:inference-profile/future-model-6") {
  throw new Error("future/provider model ID was not passed through");
}

const planCall = calls.at(-2);
const reviewCall = calls.at(-1);
for (const entry of [planCall, reviewCall]) {
  if (argValue(entry, "--model") !== "claude-opus-4-8" || argValue(entry, "--effort") !== "xhigh") {
    throw new Error("quality-loop review did not inherit the plan model and effort");
  }
}

console.log("model/effort smoke passed");
