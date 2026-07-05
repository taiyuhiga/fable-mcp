#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = process.cwd();

function tmpProject(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runNode(args, options = {}) {
  return spawnSync("node", args, {
    cwd: repo,
    input: options.input,
    encoding: "utf8",
    timeout: 15000,
  });
}

function makeLoop(cwd, loopId, statePatch = {}) {
  const dir = join(cwd, ".fable-loop", "sessions", loopId);
  mkdirSync(join(dir, "turns"), { recursive: true });
  writeJson(join(cwd, ".fable-loop", "current.json"), { loop_id: loopId });
  writeFileSync(join(dir, "task.md"), "test task\n");
  writeFileSync(join(dir, "criteria.md"), "test criteria\n");
  writeJson(join(dir, "state.json"), {
    schema_version: 2,
    loop_id: loopId,
    active: false,
    criteria_approved: false,
    phase: "awaiting_criteria_approval",
    iteration: 0,
    score: 0,
    threshold: 90,
    max: 4,
    write_targets: [],
    ...statePatch,
  });
  return { dir, statePath: join(dir, "state.json") };
}

function runStopHook(cwd) {
  const res = runNode(["hooks/fable-loop-stop.mjs"], { input: JSON.stringify({ cwd }) });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout) : {};
}

function runPromptHook(cwd) {
  const res = runNode(["hooks/fable-loop-prompt-submit.mjs"], { input: JSON.stringify({ cwd }) });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout;
}

async function withClient(fn) {
  const transport = new StdioClientTransport({ command: "node", args: [join(repo, "server.mjs")], cwd: repo });
  const client = new Client({ name: "fable-loop-smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function main() {
  const cwd = tmpProject("fable-loop-smoke-");
  const loop = makeLoop(cwd, "loop-smoke");

  await withClient(async (client) => {
    const tools = await client.listTools();
    for (const name of ["fable_status", "fable_loop_approve", "fable_loop_abort", "fable_loop_restore_best"]) {
      assert.ok(tools.tools.some((tool) => tool.name === name), `${name} is missing`);
    }

    const status = await client.callTool({ name: "fable_status", arguments: { cwd } });
    assert.match(status.content[0].text, /awaiting criteria approval/);

    const approve = await client.callTool({ name: "fable_loop_approve", arguments: { cwd, loop_id: "loop-smoke" } });
    assert.notEqual(approve.isError, true);
  });

  let state = readJson(loop.statePath);
  assert.equal(state.phase, "implementing");
  assert.deepEqual(runStopHook(cwd), {}, "Stop hook must not block before fable_review sets phase=eval");

  state.phase = "eval";
  state.score = null;
  state.eval_repair_attempts = 0;
  writeJson(loop.statePath, state);
  const invalid = runStopHook(cwd);
  assert.equal(invalid.decision, "block");
  assert.match(invalid.reason, /INVALID EVAL OUTPUT/);

  state = readJson(loop.statePath);
  state.eval_repair_attempts = 2;
  state.phase = "eval";
  state.score = null;
  writeJson(loop.statePath, state);
  assert.deepEqual(runStopHook(cwd), {}, "invalid eval should stop after repair budget");
  assert.equal(readJson(loop.statePath).ended_reason, "invalid_eval_output");

  state = readJson(loop.statePath);
  state.active = true;
  state.phase = "eval";
  state.score = 50;
  state.iteration = 1;
  state.eval_repair_attempts = 0;
  state.ended_reason = "";
  writeJson(loop.statePath, state);
  const block = runStopHook(cwd);
  assert.equal(block.decision, "block");
  assert.equal(readJson(loop.statePath).phase, "implementing");

  const other = makeLoop(cwd, "loop-conflict", {
    active: true,
    criteria_approved: true,
    phase: "implementing",
    write_targets: ["src/a.js"],
  });
  state = readJson(loop.statePath);
  state.active = true;
  state.write_targets = ["src/a.js"];
  writeJson(loop.statePath, state);
  const promptNotice = runPromptHook(cwd);
  assert.match(promptNotice, /write_targets conflict/);
  assert.ok(other.statePath);

  console.log(`fable-loop smoke passed: ${cwd}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
