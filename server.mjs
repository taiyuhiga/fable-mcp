#!/usr/bin/env node
/**
 * fable-mcp — Claude Fable 5 を「設計・深い推論役」として MCP クライアント
 * (OpenAI Codex など) から呼び出すための MCP サーバー。
 *
 * 内部では Claude Code のヘッドレスモード (`claude -p`) を
 * `--model claude-fable-5 --permission-mode plan` で起動する。
 * プランモード = 読み取り専用なので、Fable はリポジトリを探索できるが
 * ファイルの変更は一切できない。実装はホスト側エージェント (Codex) が行う。
 *
 * 課金: ANTHROPIC_API_KEY が設定されていれば Anthropic API の従量課金。
 * Claude のサブスクリプションは不要。
 *
 * 対応OS: macOS / Linux / Windows
 * - プロンプトは argv ではなく stdin で渡す (Windows の shell 実行でも安全)
 * - キャンセル時は子プロセスを kill (課金の垂れ流しを防ぐ)
 * - FABLE_MAX_TURNS で 1回の呼び出しの探索ターン数に上限
 * - 実行中は MCP 進捗通知で Fable の活動 (読んでいるファイル等) を流す
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.8.3";
const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const TIMEOUT_MS = Number(process.env.FABLE_TIMEOUT_MS || 20 * 60 * 1000); // 20分
const MAX_TURNS = Number(process.env.FABLE_MAX_TURNS ?? 60); // 0 で無制限
const EFFORT = process.env.FABLE_EFFORT || ""; // 空ならモデルのデフォルト (high 相当)
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const HEARTBEAT_MS = 20 * 1000;
const IS_WIN = process.platform === "win32";

const MODEL_RE = /^[\w.:-]+$/;
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

const log = (...args) => console.error("[fable-mcp]", ...args);

const FABLE_MCP_INSTRUCTIONS = `
Use Fable 5 as the external deep-reasoning architect/evaluator.

Routing:
- For setup/troubleshooting questions, call fable_status first. It is local-only and does not call Fable or spend API credits.
- In Codex Plan mode, call fable_plan first unless the user explicitly says "without Fable" / "Fableなし".
- In normal mode, call Fable only when the user mentions Fable/Fable5/Feyble/フェイブル, or asks for a quality loop.
- For "合格まで回して", "N点まで", or "loop/eval-loop", call fable_plan with loop_threshold, show the generated criteria, call fable_loop_approve after approval, implement, then call fable_review.

Relay:
- Fable output is canonical. Present plans, answers, and reviews verbatim. Do not summarize, rename sections, or reformat into Summary/Key Changes.
- In Plan mode, copy the Fable plan into the proposed plan body as-is; put any Codex changes after it under "Fableプランからの変更点".

Continuation:
- Pass the returned session_id for follow-up questions in the same Fable conversation.
- If the user says max/deep/じっくり, pass effort=max or xhigh; if they say quick/light/軽く, pass effort=medium.
`.trim();

/**
 * claude バイナリの解決順:
 * 1. FABLE_CLAUDE_BIN 環境変数
 * 2. この server を動かしている node と同じディレクトリ (npm -g / nvm 環境で確実)
 * 3. PATH 上の "claude" (Windows は shell 経由なので .cmd も解決される)
 */
function resolveClaudeBin() {
  if (process.env.FABLE_CLAUDE_BIN) return process.env.FABLE_CLAUDE_BIN;
  const dir = dirname(process.execPath);
  const names = IS_WIN ? ["claude.cmd", "claude.exe", "claude"] : ["claude"];
  for (const name of names) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return "claude";
}

const CLAUDE_BIN = resolveClaudeBin();

const CLAUDE_NOT_FOUND =
  `claude CLI が見つかりません (${CLAUDE_BIN})。\n` +
  `Claude Code をインストールしてください: npm i -g @anthropic-ai/claude-code\n` +
  `別の場所にある場合は FABLE_CLAUDE_BIN 環境変数でフルパスを指定してください。`;

const SERVER_FILE = fileURLToPath(import.meta.url);

/**
 * claude -p を起動して完了まで待つ。
 * - prompt は stdin で渡す (argv に任意文字列を載せない)
 * - onProgress(message) は Fable がツールを使うたび / 20秒ごとの生存確認で呼ばれる
 * - signal (AbortSignal) が中断されたら子プロセスを kill する
 */
function runClaude({ prompt, cwd, sessionId, onProgress, signal, effort }) {
  return new Promise((resolve) => {
    if (!MODEL_RE.test(MODEL)) {
      resolve({ isError: true, text: `FABLE_MODEL の値が不正です: ${MODEL}` });
      return;
    }
    // 呼び出しごとの effort 指定 > FABLE_EFFORT 環境変数 > モデルのデフォルト
    const effortLevel = effort || EFFORT;
    if (effortLevel && !EFFORT_LEVELS.has(effortLevel)) {
      resolve({ isError: true, text: `effort の値が不正です: ${effortLevel} (low / medium / high / xhigh / max)` });
      return;
    }
    if (sessionId && !SESSION_ID_RE.test(sessionId)) {
      resolve({
        isError: true,
        text: "session_id の形式が不正です。前回応答の [fable-mcp] フッターの値をそのまま渡してください。",
      });
      return;
    }

    // パス指定された claude が存在しない場合は、OS 差の出る spawn エラーを待たず即答する
    if ((CLAUDE_BIN.includes("/") || CLAUDE_BIN.includes("\\")) && !existsSync(CLAUDE_BIN)) {
      resolve({ isError: true, text: CLAUDE_NOT_FOUND });
      return;
    }

    const args = [
      "-p",
      "--model",
      MODEL,
      "--permission-mode",
      "plan",
      "--output-format",
      "stream-json",
      "--verbose",
    ];
    if (effortLevel) args.push("--effort", effortLevel);
    if (MAX_TURNS > 0) args.push("--max-turns", String(MAX_TURNS));
    if (sessionId) args.push("--resume", sessionId);

    // Windows は .cmd 起動のため shell 経由。パスの空白対策で引用符を付ける。
    // 可変値は stdin(prompt) と検証済みの MODEL / sessionId のみなので安全。
    const command = IS_WIN ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;

    const startedAt = Date.now();
    log(`spawn: ${CLAUDE_BIN} (model=${MODEL}, effort=${effortLevel || "default"}, cwd=${cwd || process.cwd()}, resume=${sessionId || "-"}, maxTurns=${MAX_TURNS || "∞"})`);

    let child;
    try {
      child = spawn(command, args, {
        cwd: cwd || process.cwd(),
        env: process.env,
        shell: IS_WIN,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({ isError: true, text: e.code === "ENOENT" ? CLAUDE_NOT_FOUND : String(e) });
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let resultEvent = null;
    let stdoutBuf = "";
    let stderrTail = "";
    let progressCount = 0;

    const emitProgress = (message) => {
      progressCount++;
      try {
        onProgress?.(progressCount, message);
      } catch {
        /* 進捗通知の失敗で本体を落とさない */
      }
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, TIMEOUT_MS);

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      emitProgress(`推論中... ${elapsed}秒経過`);
    }, HEARTBEAT_MS);

    const onAbort = () => {
      aborted = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      signal?.removeEventListener("abort", onAbort);
    };

    const handleEvent = (ev) => {
      if (ev.type === "result") {
        resultEvent = ev;
        return;
      }
      if (String(ev.type || "").includes("rate_limit")) {
        const retry =
          ev.retry_after_ms != null
            ? ` retry_after=${Math.round(Number(ev.retry_after_ms) / 1000)}s`
            : ev.retry_after != null
              ? ` retry_after=${ev.retry_after}`
              : "";
        emitProgress(`レート制限中${retry}`.trim());
        return;
      }
      if (ev.type === "assistant") {
        for (const c of ev.message?.content || []) {
          if (c.type === "tool_use") {
            const target = c.input?.file_path || c.input?.pattern || c.input?.command || c.input?.path || "";
            emitProgress(`${c.name} ${String(target)}`.trim().slice(0, 120));
          }
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        try {
          handleEvent(JSON.parse(line));
        } catch {
          /* JSON でない行は無視 */
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ isError: true, text: e.code === "ENOENT" ? CLAUDE_NOT_FOUND : String(e) });
    });

    child.on("close", (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

      if (aborted) {
        resolve({ isError: true, text: "キャンセルされました。Fable のプロセスは停止済みで、以降の課金は発生しません。" });
        return;
      }
      if (timedOut) {
        resolve({
          isError: true,
          text: `Fable の応答がタイムアウトしました (${Math.round(TIMEOUT_MS / 60000)}分)。タスクを分割するか FABLE_TIMEOUT_MS を延ばしてください。`,
        });
        return;
      }
      if (resultEvent && typeof resultEvent.result === "string") {
        const costUsd = typeof resultEvent.total_cost_usd === "number" ? resultEvent.total_cost_usd : null;
        const cost =
          typeof costUsd === "number" ? `$${costUsd.toFixed(2)}` : "n/a";
        const turns = resultEvent.num_turns != null ? `${resultEvent.num_turns} turns` : "";
        const capNote =
          resultEvent.subtype === "error_max_turns"
            ? `\n\n⚠️ ターン数上限 (${MAX_TURNS}) に達したため途中までの結果です。続きは session_id を渡して依頼するか、FABLE_MAX_TURNS を増やしてください。`
            : "";
        const footer =
          `${capNote}\n\n---\n[fable-mcp] session_id: ${resultEvent.session_id || "n/a"}` +
          ` (同じ会話を続けるには次回この session_id を渡す) | effort: ${effortLevel || "default(high)"} | cost: ${cost} | ${turns} | ${elapsedSec}s`;
        resolve({
          isError: Boolean(resultEvent.is_error),
          text: resultEvent.result + footer,
          rawText: resultEvent.result,
          sessionId: resultEvent.session_id || "",
          effort: effortLevel || "default(high)",
          costUsd,
          turns: resultEvent.num_turns ?? null,
        });
        return;
      }
      resolve({
        isError: true,
        text:
          `claude が結果を返さず終了しました (exit ${code}${sig ? `, ${sig}` : ""})。\n` +
          (stderrTail ? `stderr:\n${stderrTail}` : "認証 (claude ログイン or ANTHROPIC_API_KEY) を確認してください。"),
      });
    });

    child.stdin.on("error", () => {
      /* 子プロセスが即死した場合の EPIPE を無視 (close で処理される) */
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function toToolResult({ isError, text }) {
  return { content: [{ type: "text", text }], isError };
}

/** Fable の出力を要約せずそのまま中継させるための、実装エージェント向け指示 */
function withRelayDirective(res, what, extraNote = "") {
  if (!res.isError) {
    res.text +=
      `\n[fable-mcp→実装エージェントへ] この${what}が正です。ユーザーに提示するときは要約・言い換え・再構成をせず全文をそのまま提示してください。` +
      (extraNote || `あなた自身の補足や意見がある場合は Fable の${what}とは分けて別記してください。`);
  }
  return res;
}

/* ========== Fable plan の正本保存 ==========
 * Codex Plan UI がプランを要約・再構成してしまっても、Fable の原文は
 * .fable/last-plan.md に必ず残す。metadata は別ファイルに分け、
 * last-plan.md は表示用の混ぜ物なしの Fable 原文にする。
 */

function fableDir(cwd) {
  return join(cwd, ".fable");
}

function saveLastPlan(cwd, { planText, task, sessionId, effort }) {
  mkdirSync(fableDir(cwd), { recursive: true });
  writeFileSync(join(fableDir(cwd), "last-plan.md"), planText);
  writeFileSync(
    join(fableDir(cwd), "last-plan.meta.json"),
    JSON.stringify(
      {
        saved_at: new Date().toISOString(),
        model: MODEL,
        session_id: sessionId || "",
        effort: effort || "",
        task,
      },
      null,
      2
    )
  );
}

/* ========== 品質ループ (eval-loop) の状態管理 ==========
 * 状態は会話ではなくファイル (.fable-loop/) が持つ。
 * スコアは Fable の採点 JSON → server.mjs (機械パース) → state.json と流れ、
 * 実装役 (Codex) の手を一切通らない。続行判定は Stop フック
 * (hooks/fable-loop-stop.mjs) の整数比較が行う。
 */

const LOOP_SCHEMA_VERSION = 2;
const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function loopRoot(cwd) {
  return join(cwd, ".fable-loop");
}

function loopSessionsDir(cwd) {
  return join(loopRoot(cwd), "sessions");
}

function makeLoopId() {
  return `loop-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
}

function assertLoopId(loopId) {
  if (!LOOP_ID_RE.test(String(loopId || "")) || String(loopId).includes("..")) {
    throw new Error(`Invalid loop_id: ${loopId}`);
  }
}

function readCurrentLoopId(cwd) {
  const current = safeReadJson(join(loopRoot(cwd), "current.json"));
  if (current?.loop_id && LOOP_ID_RE.test(current.loop_id)) return current.loop_id;
  return "";
}

function writeCurrentLoopId(cwd, loopId) {
  mkdirSync(loopRoot(cwd), { recursive: true });
  writeFileSync(join(loopRoot(cwd), "current.json"), JSON.stringify({ loop_id: loopId, updated_at: new Date().toISOString() }, null, 2));
}

function legacyLoopRef(cwd) {
  return {
    loopId: "legacy",
    legacy: true,
    dir: loopRoot(cwd),
    statePath: join(loopRoot(cwd), "state.json"),
    turnsDir: join(loopRoot(cwd), "turns"),
  };
}

function sessionLoopRef(cwd, loopId) {
  assertLoopId(loopId);
  const dir = join(loopSessionsDir(cwd), loopId);
  return {
    loopId,
    legacy: false,
    dir,
    statePath: join(dir, "state.json"),
    turnsDir: join(dir, "turns"),
  };
}

function resolveLoopRef(cwd, loopId) {
  if (loopId) return sessionLoopRef(cwd, loopId);
  const currentId = readCurrentLoopId(cwd);
  if (currentId) {
    const current = sessionLoopRef(cwd, currentId);
    if (existsSync(current.statePath)) return current;
  }
  const legacy = legacyLoopRef(cwd);
  if (existsSync(legacy.statePath)) return legacy;
  return null;
}

function listLoopRefs(cwd) {
  const refs = [];
  try {
    for (const entry of readdirSync(loopSessionsDir(cwd), { withFileTypes: true })) {
      if (entry.isDirectory() && LOOP_ID_RE.test(entry.name)) refs.push(sessionLoopRef(cwd, entry.name));
    }
  } catch {
    /* no sessions yet */
  }
  const legacy = legacyLoopRef(cwd);
  if (existsSync(legacy.statePath)) refs.push(legacy);
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.legacy ? "legacy" : ref.loopId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readLoop(cwd, loopId) {
  const ref = resolveLoopRef(cwd, loopId);
  if (!ref || !existsSync(ref.statePath)) return null;
  try {
    return { ...ref, state: JSON.parse(readFileSync(ref.statePath, "utf8")) };
  } catch {
    return null;
  }
}

function writeLoopState(loop, state) {
  state.updated_at = new Date().toISOString();
  writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
}

function initLoop(cwd, task, criteriaText, threshold, max, { sessionId = "", effort = "", costUsd = null, autoApprove = false } = {}) {
  const loopId = makeLoopId();
  const loop = sessionLoopRef(cwd, loopId);
  const baseline = workingTreeFingerprint(cwd);
  mkdirSync(loop.turnsDir, { recursive: true });
  writeFileSync(join(loop.dir, "task.md"), task);
  writeFileSync(join(loop.dir, "criteria.md"), criteriaText);
  writeLoopState(loop, {
    schema_version: LOOP_SCHEMA_VERSION,
    loop_id: loopId,
    active: Boolean(autoApprove),
    criteria_approved: Boolean(autoApprove),
    phase: autoApprove ? "implementing" : "awaiting_criteria_approval",
    iteration: 0,
    score: 0,
    passed: false,
    threshold,
    max,
    best_score: 0,
    best_iteration: -1,
    best_snapshot_ref: "",
    last_snapshot_ref: "",
    last_blocked_iteration: -1,
    cumulative_cost_usd: typeof costUsd === "number" ? costUsd : 0,
    last_cost_usd: typeof costUsd === "number" ? costUsd : 0,
    fable_session_id: sessionId || "",
    project_dir: cwd,
    effort: effort || "",
    eval_repair_attempts: 0,
    evaluated_iteration: null,
    snapshot_enabled: isGitRepo(cwd),
    snapshot_status: isGitRepo(cwd) ? "ready" : "disabled: not a git repository",
    write_targets: [],
    implementation_baseline_fingerprint: baseline.hash,
    implementation_baseline_paths: baseline.paths,
    review_required_since: "",
    review_required_paths: [],
    ended_reason: "",
    started_at: new Date().toISOString(),
  });
  writeCurrentLoopId(cwd, loopId);
  return loop;
}

function safeReadLoopFile(loop, name) {
  try {
    return readFileSync(join(loop.dir, name), "utf8");
  } catch {
    return "";
  }
}

function runGit(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    env: { ...process.env, ...(options.env || {}) },
    input: options.input,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout ?? 15000,
  });
}

function isGitRepo(cwd) {
  const res = runGit(cwd, ["rev-parse", "--is-inside-work-tree"], { timeout: 5000 });
  return res.status === 0 && String(res.stdout).trim() === "true";
}

function hasHead(cwd) {
  return runGit(cwd, ["rev-parse", "--verify", "HEAD"], { timeout: 5000 }).status === 0;
}

function normalizeRepoPath(path) {
  return String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
}

function isStatePath(path) {
  const p = normalizeRepoPath(path);
  return p === ".fable-loop" || p.startsWith(".fable-loop/") || p === ".fable" || p.startsWith(".fable/");
}

function listChangedPaths(cwd) {
  if (!isGitRepo(cwd)) return [];
  const res = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { timeout: 15000 });
  if (res.status !== 0) return [];
  const parts = res.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i];
    const status = item.slice(0, 2);
    let path = item.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const next = parts[i + 1];
      if (next) {
        path = next;
        i++;
      }
    }
    path = normalizeRepoPath(path);
    if (path && !isStatePath(path)) paths.push(path);
  }
  return [...new Set(paths)].sort();
}

function workingTreeFingerprint(cwd) {
  const paths = listChangedPaths(cwd);
  const hash = createHash("sha256");
  hash.update(`paths:${paths.length}\n`);
  for (const path of paths) {
    hash.update(`path:${path}\n`);
    const abs = join(cwd, path);
    try {
      const stat = statSync(abs);
      hash.update(`stat:${stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other"}:${stat.size}\n`);
      if (stat.isFile()) hash.update(readFileSync(abs));
    } catch {
      hash.update("missing\n");
    }
  }
  return { hash: hash.digest("hex"), paths };
}

function mergeWriteTargets(state, paths) {
  const merged = new Set(Array.isArray(state.write_targets) ? state.write_targets.map(normalizeRepoPath) : []);
  for (const path of paths) {
    const normalized = normalizeRepoPath(path);
    if (normalized && !isStatePath(normalized)) merged.add(normalized);
  }
  state.write_targets = [...merged].sort();
}

function updateLoopCost(state, res) {
  if (typeof res?.costUsd !== "number") return;
  state.last_cost_usd = res.costUsd;
  state.cumulative_cost_usd = Number((Number(state.cumulative_cost_usd || 0) + res.costUsd).toFixed(6));
}

function snapshotRef(loopId, name) {
  assertLoopId(loopId);
  return `refs/fable-loop/${loopId}/${name}`;
}

function createLoopSnapshot(cwd, loop, state, iteration, score) {
  if (!state.snapshot_enabled || loop.legacy || !isGitRepo(cwd)) {
    state.snapshot_status = state.snapshot_status || "disabled";
    return null;
  }

  const gitIndexFile = join(mkdtempSync(join(tmpdir(), "fable-loop-index-")), "index");
  try {
    const env = {
      GIT_INDEX_FILE: gitIndexFile,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "fable-mcp",
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "fable-mcp@example.invalid",
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "fable-mcp",
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "fable-mcp@example.invalid",
    };
    const parentArgs = [];
    if (hasHead(cwd)) {
      const readTree = runGit(cwd, ["read-tree", "HEAD"], { env });
      if (readTree.status !== 0) throw new Error(readTree.stderr || "git read-tree failed");
      const head = runGit(cwd, ["rev-parse", "HEAD"], { timeout: 5000 });
      if (head.status === 0) parentArgs.push("-p", head.stdout.trim());
    } else {
      const readTree = runGit(cwd, ["read-tree", "--empty"], { env });
      if (readTree.status !== 0) throw new Error(readTree.stderr || "git read-tree --empty failed");
    }

    const add = runGit(cwd, ["add", "-A", "--", "."], { env, timeout: 30000 });
    if (add.status !== 0) throw new Error(add.stderr || "git add failed");
    runGit(cwd, ["rm", "-r", "--cached", "--ignore-unmatch", ".fable-loop", ".fable"], { env, timeout: 15000 });
    const tree = runGit(cwd, ["write-tree"], { env });
    if (tree.status !== 0) throw new Error(tree.stderr || "git write-tree failed");

    const msg = `fable-loop ${loop.loopId} iteration ${iteration} score ${score}`;
    const commit = runGit(cwd, ["commit-tree", tree.stdout.trim(), ...parentArgs], { env, input: `${msg}\n`, timeout: 15000 });
    if (commit.status !== 0) throw new Error(commit.stderr || "git commit-tree failed");
    const commitId = commit.stdout.trim();
    const iterRef = snapshotRef(loop.loopId, `iter-${String(iteration).padStart(3, "0")}`);
    const update = runGit(cwd, ["update-ref", iterRef, commitId], { timeout: 15000 });
    if (update.status !== 0) throw new Error(update.stderr || "git update-ref failed");
    state.last_snapshot_ref = iterRef;
    state.snapshot_status = "ok";
    return iterRef;
  } catch (e) {
    state.snapshot_status = `failed: ${e.message}`;
    return null;
  } finally {
    try {
      rmSync(dirname(gitIndexFile), { recursive: true, force: true });
    } catch {
      /* temp cleanup best effort */
    }
  }
}

function markBestSnapshot(cwd, loop, state, iterRef) {
  if (!iterRef || loop.legacy || !isGitRepo(cwd)) return;
  const bestRef = snapshotRef(loop.loopId, "best");
  const commit = runGit(cwd, ["rev-parse", iterRef], { timeout: 5000 });
  if (commit.status !== 0) {
    state.snapshot_status = `failed: ${commit.stderr || "snapshot ref missing"}`;
    return;
  }
  const update = runGit(cwd, ["update-ref", bestRef, commit.stdout.trim()], { timeout: 15000 });
  if (update.status === 0) {
    state.best_snapshot_ref = bestRef;
  } else {
    state.snapshot_status = `failed: ${update.stderr || "best ref update failed"}`;
  }
}

function gitPathExistsAtRef(cwd, ref, path) {
  return runGit(cwd, ["cat-file", "-e", `${ref}:${path}`], { timeout: 5000 }).status === 0;
}

function removeRepoPath(cwd, path) {
  const target = join(cwd, path);
  const rel = relative(cwd, target);
  if (!rel || rel.startsWith("..") || rel === "." || isStatePath(rel)) {
    throw new Error(`Refusing to remove unsafe path: ${path}`);
  }
  rmSync(target, { recursive: true, force: true });
}

function restoreBestSnapshot(cwd, loop, state, paths = []) {
  const ref = state.best_snapshot_ref;
  if (!ref) throw new Error("No best snapshot ref is recorded for this loop.");
  if (!isGitRepo(cwd)) throw new Error("Best snapshot restore requires a git repository.");
  const selected = paths.length ? paths.map(normalizeRepoPath) : Array.isArray(state.write_targets) ? state.write_targets.map(normalizeRepoPath) : [];
  const safePaths = [...new Set(selected.filter((path) => path && !isStatePath(path)))].sort();
  if (safePaths.length === 0) {
    throw new Error("No write_targets are recorded. Pass explicit paths to restore.");
  }

  const restored = [];
  const removed = [];
  for (const path of safePaths) {
    if (gitPathExistsAtRef(cwd, ref, path)) {
      const co = runGit(cwd, ["checkout", ref, "--", path], { timeout: 30000 });
      if (co.status !== 0) throw new Error(co.stderr || `git checkout failed for ${path}`);
      restored.push(path);
    } else {
      removeRepoPath(cwd, path);
      removed.push(path);
    }
  }
  return { restored, removed, ref };
}

function parseEval(text) {
  const m = [...String(text || "").matchAll(/<eval>([\s\S]*?)<\/eval>/g)].pop();
  if (!m) return null;
  try {
    const ev = JSON.parse(m[1].trim());
    const score = Number(ev.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(0, Math.min(100, Math.floor(score))),
      breakdown: ev.breakdown && typeof ev.breakdown === "object" ? ev.breakdown : {},
      feedback: String(ev.feedback || ""),
    };
  } catch {
    return null;
  }
}

function aggregateEvals(evals) {
  const valid = evals.filter(Boolean);
  if (valid.length === 0) return null;
  if (valid.length === 1) return valid[0];
  const scores = valid.map((ev) => ev.score).sort((a, b) => a - b);
  const median = scores[Math.floor(scores.length / 2)];
  const keys = new Set();
  for (const ev of valid) {
    for (const key of Object.keys(ev.breakdown || {})) keys.add(key);
  }
  const breakdown = {};
  for (const key of keys) {
    const nums = valid.map((ev) => Number(ev.breakdown?.[key])).filter(Number.isFinite);
    if (nums.length) breakdown[key] = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  }
  return {
    score: median,
    breakdown,
    feedback: valid.map((ev, idx) => `Evaluator ${idx + 1} (score ${ev.score}):\n${ev.feedback}`).join("\n\n"),
    ensemble_size: valid.length,
    raw_scores: valid.map((ev) => ev.score),
  };
}

/** MCP クライアントが progressToken を渡してきた場合のみ進捗通知を送る */
function makeProgressReporter(extra) {
  const progressToken = extra?._meta?.progressToken;
  return (progress, message) => {
    log(`progress: ${message}`);
    if (progressToken !== undefined && typeof extra?.sendNotification === "function") {
      extra
        .sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress, message: `Fable: ${message}` },
        })
        .catch(() => {});
    }
  };
}

function firstLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "invalid";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `${min}m ${rest}s` : `${min}m`;
}

function runtimeMode() {
  const p = SERVER_FILE.replaceAll("\\", "/");
  if (p.includes("/.codex/plugins/cache/fable-mcp/")) return "Codex plugin cache install";
  if (p.includes("/plugins/fable-mcp/")) return "local Codex plugin package";
  if (p.endsWith("/server.mjs")) return "manual MCP from repository checkout";
  return "manual or bundled MCP";
}

function probeClaudeCli() {
  const pathLike = CLAUDE_BIN.includes("/") || CLAUDE_BIN.includes("\\");
  if (pathLike && !existsSync(CLAUDE_BIN)) {
    return { ok: false, detail: "missing path", version: "", source: process.env.FABLE_CLAUDE_BIN ? "FABLE_CLAUDE_BIN" : "auto-detected" };
  }
  const command = IS_WIN ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;
  const res = spawnSync(command, ["--version"], {
    shell: IS_WIN,
    windowsHide: true,
    encoding: "utf8",
    timeout: 5000,
  });
  if (res.error) {
    return {
      ok: false,
      detail: res.error.code === "ENOENT" ? "not found on PATH" : res.error.message,
      version: "",
      source: process.env.FABLE_CLAUDE_BIN ? "FABLE_CLAUDE_BIN" : pathLike ? "auto-detected" : "PATH",
    };
  }
  const version = firstLine(`${res.stdout || ""}\n${res.stderr || ""}`);
  return {
    ok: res.status === 0,
    detail: res.status === 0 ? "ok" : `exit ${res.status}`,
    version,
    source: process.env.FABLE_CLAUDE_BIN ? "FABLE_CLAUDE_BIN" : pathLike ? "auto-detected" : "PATH",
  };
}

function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeReadText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function codexConfigSnapshot() {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  const hooksPath = join(codexHome, "hooks.json");
  const agentsPath = join(codexHome, "AGENTS.md");
  const config = safeReadText(configPath);
  const hooks = safeReadText(hooksPath);
  const agents = safeReadText(agentsPath);
  return {
    codexHome,
    configPath,
    hooksPath,
    agentsPath,
    manualMcpConfig: /^\s*\[mcp_servers\.fable\]\s*$/m.test(config),
    pluginEnvTable: /^\s*\[plugins\."fable-mcp@fable-mcp"\.mcp_servers\.fable\.env\]\s*$/m.test(config),
    manualHookConfig: hooks.includes("fable-loop-stop.mjs"),
    globalAgentFableRules: /Fable 5 Orchestration|Fable 5 オーケストレーション|fable_plan|fable_review/.test(agents),
  };
}

function codexConfigLines(snapshot) {
  const duplicateRisk = snapshot.manualMcpConfig || snapshot.manualHookConfig || snapshot.globalAgentFableRules;
  return [
    `- CODEX_HOME: ${snapshot.codexHome}`,
    `- manual [mcp_servers.fable]: ${snapshot.manualMcpConfig ? "found" : "not found"}`,
    `- plugin env table: ${snapshot.pluginEnvTable ? "found" : "not found"}`,
    `- manual hooks.json fable-loop-stop: ${snapshot.manualHookConfig ? "found" : "not found"}`,
    `- global AGENTS Fable rules: ${snapshot.globalAgentFableRules ? "found" : "not found"}`,
    `- duplicate-registration risk: ${duplicateRisk ? "attention" : "none detected"}`,
  ];
}

function readLoopSnapshot(cwd) {
  const refs = listLoopRefs(cwd);
  if (refs.length === 0) return { exists: false, root: loopRoot(cwd), loops: [] };
  const currentId = readCurrentLoopId(cwd);
  const loops = refs.map((ref) => {
    const state = safeReadJson(ref.statePath);
    if (!state) return { exists: true, valid: false, loopId: ref.loopId, statePath: ref.statePath, legacy: ref.legacy };
    const threshold = Math.floor(state.threshold ?? 90);
    const iteration = Math.floor(state.iteration ?? 0);
    const max = Number.isFinite(Number(state.max)) ? Math.floor(Number(state.max)) : "unknown";
    const score = Number.isFinite(Number(state.score)) ? Math.floor(Number(state.score)) : "unknown";
    const active = Boolean(state.active);
    const criteriaApproved = Boolean(state.criteria_approved ?? ref.legacy);
    const passed = Boolean(state.passed) || (Number.isFinite(Number(score)) && score >= threshold);
    return {
      exists: true,
      valid: true,
      loopId: state.loop_id || ref.loopId,
      statePath: ref.statePath,
      legacy: ref.legacy,
      threshold,
      iteration,
      max,
      score,
      active,
      criteriaApproved,
      phase: state.phase || (active ? "active" : "inactive"),
      passed,
      endedReason: state.ended_reason || "",
      bestScore: Number.isFinite(Number(state.best_score)) ? Math.floor(Number(state.best_score)) : 0,
      bestIteration: Number.isFinite(Number(state.best_iteration)) ? Math.floor(Number(state.best_iteration)) : -1,
      bestSnapshotRef: state.best_snapshot_ref || "",
      reviewRequiredSince: state.review_required_since || "",
      reviewRequiredPaths: Array.isArray(state.review_required_paths) ? state.review_required_paths : [],
      cumulativeCostUsd: Number(state.cumulative_cost_usd || 0),
    };
  });
  const current =
    loops.find((loop) => !loop.legacy && loop.loopId === currentId) ||
    loops.find((loop) => loop.active) ||
    loops[0];
  return { exists: true, root: loopRoot(cwd), currentId, current, loops };
}

function loopStatusLines(loop) {
  if (!loop.exists) return ["- quality loop: inactive (.fable-loop not found)"];
  const lines = [`- quality loop root: ${loop.root}`];
  for (const item of loop.loops) {
    if (!item.valid) {
      lines.push(`- ${item.loopId}: state exists but is not valid JSON (${item.statePath})`);
      continue;
    }
    const marker = loop.current?.loopId === item.loopId ? "current, " : "";
    const approval = item.criteriaApproved ? "approved" : "awaiting criteria approval";
    const cost = item.cumulativeCostUsd ? ` | cumulative cost ~$${item.cumulativeCostUsd.toFixed(4)}` : "";
    const best =
      item.bestIteration >= 0
        ? ` | best ${item.bestScore}/100 at iteration ${item.bestIteration + 1}${item.bestSnapshotRef ? " (snapshot ready)" : ""}`
        : "";
    lines.push(
      `- ${item.loopId}: ${marker}${item.active ? "active" : "inactive"} | phase ${item.phase} | ${approval} | iteration ${item.iteration}/${item.max} | score ${item.score}/${item.threshold} | passed: ${item.passed ? "yes" : "no"}${best}${cost}`
    );
    if (item.reviewRequiredSince) {
      lines.push(`  review required since: ${item.reviewRequiredSince}`);
      lines.push(`  review required paths: ${item.reviewRequiredPaths.slice(0, 10).join(", ") || "(unknown)"}`);
    }
    lines.push(`  state: ${item.statePath}`);
  }
  return lines;
}

function nextActionLines({ claude, hasApiKey, effort, timeoutValid, maxTurnsValid, lastPlanExists, loop }) {
  const actions = [];

  if (!claude.ok) {
    actions.push("1. Install Claude Code CLI: `npm i -g @anthropic-ai/claude-code`, then restart Codex and run `Fableの状態を確認して` again.");
  }
  if (!hasApiKey) {
    actions.push(
      `${actions.length + 1}. If you want Anthropic API billing, add ` +
        "`ANTHROPIC_API_KEY` under `[plugins.\"fable-mcp@fable-mcp\".mcp_servers.fable.env]`; otherwise run `claude` once to confirm CLI login, then try `Fable5に聞いて: このリポジトリは何をするもの?`."
    );
  }
  if (!timeoutValid || !maxTurnsValid) {
    actions.push(`${actions.length + 1}. Fix invalid numeric env vars: FABLE_TIMEOUT_MS and FABLE_MAX_TURNS must be numbers.`);
  }
  if (effort === "xhigh" || effort === "max") {
    actions.push(`${actions.length + 1}. Cost check: FABLE_EFFORT=${effort}. Prefer per-call max/xhigh only when the user explicitly asks for deep reasoning.`);
  }

  const currentLoop = loop.current;
  if (loop.exists && currentLoop && !currentLoop.valid) {
    actions.push(`${actions.length + 1}. Inspect ${currentLoop.statePath}; the quality-loop state JSON is invalid.`);
  } else if (currentLoop?.valid && !currentLoop.criteriaApproved) {
    actions.push(`${actions.length + 1}. Review the criteria in the loop state, then call ` + "`fable_loop_approve` if the user accepts them.");
  } else if (currentLoop?.valid && currentLoop.active && currentLoop.phase === "implementing") {
    actions.push(`${actions.length + 1}. Quality loop ${currentLoop.loopId} is waiting for implementation. Make the requested changes, then call ` + "`fable_review`.");
  } else if (currentLoop?.valid && currentLoop.active && currentLoop.phase === "eval" && !currentLoop.passed) {
    actions.push(`${actions.length + 1}. Quality loop ${currentLoop.loopId} has a fresh evaluation. Let the Stop hook continue the loop, or inspect the latest turn feedback.`);
  } else if (currentLoop?.valid && currentLoop.active && !currentLoop.passed) {
    actions.push(`${actions.length + 1}. Quality loop ${currentLoop.loopId} is active. Implement the latest feedback, then call ` + "`fable_review` again.");
  } else if (currentLoop?.valid && currentLoop.active && currentLoop.passed) {
    actions.push(`${actions.length + 1}. Quality loop ${currentLoop.loopId} has passed. Finish by summarizing the result or committing the verified changes.`);
  }

  if (actions.length === 0) {
    actions.push("1. Setup looks ready. Try: `Fable5に聞いて: このリポジトリは何をするもの?`");
    actions.push("2. For implementation work, enter Codex Plan mode or ask: `Fableでプラン作って`.");
  } else if (claude.ok && hasApiKey && !lastPlanExists && !(currentLoop?.valid && currentLoop.active)) {
    actions.push(`${actions.length + 1}. After the setup warning is resolved, try: ` + "`Fable5に聞いて: このリポジトリは何をするもの?`");
  } else if (lastPlanExists && !(currentLoop?.valid && currentLoop.active && !currentLoop.passed)) {
    actions.push(`${actions.length + 1}. A saved Fable plan exists. Read ` + "`.fable/last-plan.md`, implement it, then call `fable_review`.");
  }

  return actions;
}

function statusText(cwd) {
  const projectCwd = cwd || process.cwd();
  const claude = probeClaudeCli();
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const effort = EFFORT || "default(high)";
  const timeoutValid = Number.isFinite(TIMEOUT_MS);
  const maxTurnsValid = Number.isFinite(MAX_TURNS);
  const warnings = [];
  if (!claude.ok) warnings.push(`claude CLI is not ready (${claude.detail}). Install with: npm i -g @anthropic-ai/claude-code`);
  if (!hasApiKey) warnings.push("ANTHROPIC_API_KEY is not set. Calls will use the current claude CLI login/session if available.");
  if (EFFORT === "xhigh" || EFFORT === "max") warnings.push(`FABLE_EFFORT=${EFFORT} is expensive. Prefer per-call effort=max only when the user explicitly asks.`);
  if (!timeoutValid) warnings.push("FABLE_TIMEOUT_MS is invalid.");
  if (!maxTurnsValid) warnings.push("FABLE_MAX_TURNS is invalid.");

  const lastPlan = join(fableDir(projectCwd), "last-plan.md");
  const lastPlanExists = existsSync(lastPlan);
  const loop = readLoopSnapshot(projectCwd);
  const codexConfig = codexConfigSnapshot();
  if (runtimeMode().includes("plugin") && codexConfig.manualMcpConfig) {
    warnings.push(`Manual [mcp_servers.fable] is still present in ${codexConfig.configPath}. Remove it when using the Codex plugin to avoid double registration.`);
  }
  if (runtimeMode().includes("plugin") && codexConfig.manualHookConfig) {
    warnings.push(`Manual fable-loop Stop hook is still present in ${codexConfig.hooksPath}. Remove it when using the Codex plugin to avoid double hook execution.`);
  }
  if (runtimeMode().includes("plugin") && codexConfig.globalAgentFableRules) {
    warnings.push(`Global AGENTS.md contains Fable orchestration rules. Prefer the plugin-bundled rules to avoid stale or duplicated routing.`);
  }
  const authMode = hasApiKey
    ? "ANTHROPIC_API_KEY present: Anthropic API metered billing"
    : "no ANTHROPIC_API_KEY: claude CLI login/session, if available";

  return [
    "# fable-mcp status",
    "",
    "## Runtime",
    `- fable-mcp: v${VERSION}`,
    `- install mode: ${runtimeMode()}`,
    `- server file: ${SERVER_FILE}`,
    `- platform: ${process.platform} ${process.arch}`,
    `- node: ${process.version}`,
    `- project cwd: ${projectCwd}`,
    "",
    "## Claude Code / Fable",
    `- model: ${MODEL}`,
    `- claude binary: ${CLAUDE_BIN} (${claude.source})`,
    `- claude check: ${claude.ok ? "ok" : "attention"}${claude.version ? ` | ${claude.version}` : ` | ${claude.detail}`}`,
    `- auth/billing mode: ${authMode}`,
    `- default effort: ${effort}`,
    `- max turns per call: ${MAX_TURNS > 0 ? MAX_TURNS : "unlimited"}`,
    `- timeout per call: ${formatDuration(TIMEOUT_MS)}`,
    "",
    "## Codex Registration",
    ...codexConfigLines(codexConfig),
    "",
    "## Project Files",
    `- last verbatim Fable plan: ${lastPlanExists ? lastPlan : "not found yet (.fable/last-plan.md will be created by fable_plan)"}`,
    ...loopStatusLines(loop),
    "",
    "## Next Actions",
    ...nextActionLines({ claude, hasApiKey, effort: EFFORT, timeoutValid, maxTurnsValid, lastPlanExists, loop }),
    "",
    "## Notes",
    "- This status check is local-only. It does not call Fable and does not spend API credits.",
    "- fable_plan / fable_ask / fable_review start `claude -p --model claude-fable-5 --permission-mode plan`.",
    "- Fable runs read-only through Claude Code plan mode. Codex remains the implementation agent.",
    warnings.length ? "" : "- No obvious local setup warnings.",
    ...warnings.map((warning) => `- Warning: ${warning}`),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const server = new McpServer(
  { name: "fable-mcp", version: VERSION },
  { instructions: FABLE_MCP_INSTRUCTIONS }
);

server.tool(
  "fable_status",
  "fable-mcp のローカル診断を行う。Claude Code CLI、認証/課金モード、推論設定、最後の Fable プラン、品質ループ状態を確認する。Fable 本体は呼ばないため API コストは発生しない。セットアップ確認やトラブルシュートでは最初に呼ぶこと。",
  {
    cwd: z
      .string()
      .optional()
      .describe("診断対象プロジェクトのルート絶対パス。省略時は MCP サーバーの現在ディレクトリ。"),
  },
  async ({ cwd }) => toToolResult({ isError: false, text: statusText(cwd) })
);

server.tool(
  "fable_loop_approve",
  "品質ループの受け入れ基準をユーザーが承認した後に呼ぶ。承認待ちの loop_id を implementing phase で active にし、実装後に変更が入ったら fable_review まで Stop hook が差し戻す。Fable 本体は呼ばないため API コストは発生しない。",
  {
    cwd: z.string().describe("対象プロジェクトのルート絶対パス。"),
    loop_id: z.string().optional().describe("承認する loop_id。省略時は現在ループ。"),
  },
  async ({ cwd, loop_id }) => {
    const loop = readLoop(cwd, loop_id);
    if (!loop) {
      return toToolResult({ isError: true, text: "承認対象の品質ループが見つかりません。先に fable_plan with loop_threshold を呼んでください。" });
    }
    const state = loop.state;
    const baseline = workingTreeFingerprint(cwd);
    state.criteria_approved = true;
    state.active = true;
    state.phase = "implementing";
    state.ended_reason = "";
    state.approved_at = new Date().toISOString();
    state.implementation_baseline_fingerprint = baseline.hash;
    state.implementation_baseline_paths = baseline.paths;
    state.review_required_since = "";
    state.review_required_paths = [];
    writeLoopState(loop, state);
    if (!loop.legacy) writeCurrentLoopId(cwd, loop.loopId);
    return toToolResult({
      isError: false,
      text:
        `品質ループ ${loop.loopId} の受け入れ基準を承認し、active にしました。\n` +
        `次の手順: 実装を進め、完了後に fable_review を呼んで採点してください。`,
    });
  }
);

server.tool(
  "fable_loop_abort",
  "品質ループを安全に中断する。state.json を直接編集せず、active=false と ended_reason を機械的に記録する。Fable 本体は呼ばないため API コストは発生しない。",
  {
    cwd: z.string().describe("対象プロジェクトのルート絶対パス。"),
    loop_id: z.string().optional().describe("中断する loop_id。省略時は現在ループ。"),
    reason: z.string().optional().describe("中断理由。省略時は user_aborted。"),
  },
  async ({ cwd, loop_id, reason }) => {
    const loop = readLoop(cwd, loop_id);
    if (!loop) return toToolResult({ isError: true, text: "中断対象の品質ループが見つかりません。" });
    const state = loop.state;
    state.active = false;
    state.phase = "aborted";
    state.ended_reason = reason || "user_aborted";
    state.aborted_at = new Date().toISOString();
    writeLoopState(loop, state);
    return toToolResult({
      isError: false,
      text:
        `品質ループ ${loop.loopId} を中断しました (reason: ${state.ended_reason})。\n` +
        (state.best_snapshot_ref
          ? `best snapshot は保持されています: ${state.best_snapshot_ref}\n必要なら fable_loop_restore_best で復元できます。`
          : "best snapshot はまだありません。"),
    });
  }
);

server.tool(
  "fable_loop_restore_best",
  "品質ループで記録された best snapshot を作業ツリーへ復元する。復元対象は write_targets または明示 paths に限定し、.fable-loop/.fable は触らない。Fable 本体は呼ばないため API コストは発生しない。",
  {
    cwd: z.string().describe("対象プロジェクトのルート絶対パス。"),
    loop_id: z.string().optional().describe("復元する loop_id。省略時は現在ループ。"),
    paths: z.array(z.string()).optional().describe("復元対象パス。省略時は state.write_targets を使う。"),
  },
  async ({ cwd, loop_id, paths }) => {
    const loop = readLoop(cwd, loop_id);
    if (!loop) return toToolResult({ isError: true, text: "復元対象の品質ループが見つかりません。" });
    try {
      const result = restoreBestSnapshot(cwd, loop, loop.state, paths || []);
      loop.state.restored_best_at = new Date().toISOString();
      loop.state.restored_best_ref = result.ref;
      writeLoopState(loop, loop.state);
      return toToolResult({
        isError: false,
        text:
          `best snapshot を復元しました: ${result.ref}\n` +
          `restored:\n${result.restored.map((path) => `- ${path}`).join("\n") || "- (none)"}\n` +
          `removed:\n${result.removed.map((path) => `- ${path}`).join("\n") || "- (none)"}`,
      });
    } catch (e) {
      return toToolResult({ isError: true, text: `best snapshot の復元に失敗しました: ${e.message}` });
    }
  }
);

server.tool(
  "fable_plan",
  "Claude Fable 5 (deep-reasoning architect) に実装プランの設計を依頼する。複数ファイルにまたがる実装・新機能・アーキテクチャ判断を伴うタスクでは、実装を始める前に必ずこれを呼ぶこと。Fable はリポジトリを読み取り専用で探索してから設計する。応答には数分かかることがある。返ってきたプランに従って実装すること。",
  {
    task: z
      .string()
      .describe(
        "タスクの完全な仕様。目的・背景・制約・ユーザーの要望をすべて含める。省略せずに書くほどプランの質が上がる。"
      ),
    cwd: z.string().describe("対象プロジェクトのルート絶対パス。Fable はこの中を探索する。"),
    session_id: z
      .string()
      .optional()
      .describe("前回の応答に含まれる session_id。渡すと同じ会話の続きとしてフォローアップできる。"),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe(
        "推論の深さ。ユーザーが「じっくり/深く/本気で」と言ったら xhigh か max、「軽く/サクッと」と言ったら medium。未指定ならサーバーのデフォルト。"
      ),
    loop_threshold: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "品質ループの合格点 (推奨: 90)。指定するとプランに受け入れ基準 (採点表) が含まれ、承認待ちの .fable-loop/ が初期化される。以後「基準承認 → 実装 → fable_review 採点 → 未達なら Stop フックが差し戻し」の自動ループが回る。ユーザーが「合格まで回して」「◯点まで仕上げて」「ループで」等と言ったときに指定する。"
      ),
    loop_max_iterations: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe("品質ループの最大周回数 (デフォルト 4)。無限ループ防止のブレーキ。"),
    loop_auto_approve_criteria: z
      .boolean()
      .optional()
      .describe(
        "true の場合だけ、Fable が作った受け入れ基準を人間承認なしで即アクティブ化する。通常は省略し、fable_loop_approve で明示承認する。"
      ),
  },
  async ({ task, cwd, session_id, effort, loop_threshold, loop_max_iterations, loop_auto_approve_criteria }, extra) => {
    const threshold = loop_threshold != null ? Math.floor(loop_threshold) : null;
    const maxIter = Math.floor(loop_max_iterations ?? 4);
    const criteriaSection =
      threshold != null
        ? `

このタスクは品質ループ (実装 → 採点 → 差し戻し) で仕上げます。プランの最後に、必ず次の形式で受け入れ基準 (採点表) を付けてください:
<criteria>
## 受け入れ基準 (合格点: ${threshold}/100)
### 機械チェック (○×で判定できる項目)
- (テスト通過・コマンド実行結果・文字数など、誰が確認しても同じ結果になる項目)
### 採点軸 (LLM評価)
- axis_key (重み): 何を見るか。何点がどういう状態かの目安 (例: 90=..., 70=...)
</criteria>
採点軸のキーは英数字スネークケースで3〜6個。周回をまたいで固定され、後から増減できない前提で選ぶこと。曖昧な形容詞 (「良い」「ちゃんとした」) は数えられる事実か採点可能な観点に翻訳すること。`
        : "";
    const prompt = `あなたは2エージェント構成の「アーキテクト」役です。あなた (Claude Fable 5) が設計し、別の実装エージェント (Codex) がコードを書きます。

このリポジトリを必要なだけ探索し、深く考えた上で、以下のタスクの実装プランを書いてください。プランは実装エージェントがそのまま実行できる具体性で:
- ゴールと主要な設計判断 (理由も簡潔に)
- 作成/変更するファイルと、それぞれに入れる変更内容
- 再利用すべき既存コード・ユーティリティ (パス付き)
- エッジケース・リスク・制約
- 最後に検証方法 (どうテストするか)

タスクと同じ言語で回答してください。${criteriaSection}

<task>
${task}
</task>`;
    const res = await runClaude({ prompt, cwd, sessionId: session_id, effort, onProgress: makeProgressReporter(extra), signal: extra?.signal });
    if (!res.isError && res.rawText) {
      try {
        saveLastPlan(cwd, {
          planText: res.rawText,
          task,
          sessionId: res.sessionId,
          effort: res.effort,
        });
        res.text += `\n[fable-mcp] Fable プラン原文を ${join(cwd, ".fable", "last-plan.md")} に保存しました。`;
      } catch (e) {
        res.text += `\n[fable-mcp] Fable プラン原文の保存に失敗しました: ${e.message}`;
      }
    }
    if (threshold != null && !res.isError) {
      const m = [...res.text.matchAll(/<criteria>([\s\S]*?)<\/criteria>/g)].pop();
      const criteriaText = m ? m[1].trim() : res.text;
      try {
        const loop = initLoop(cwd, task, criteriaText, threshold, maxIter, {
          sessionId: res.sessionId,
          effort: res.effort,
          costUsd: res.costUsd,
          autoApprove: Boolean(loop_auto_approve_criteria),
        });
        res.text +=
          `\n[fable-loop] 品質ループを初期化しました (loop_id: ${loop.loopId}, 合格点 ${threshold}/100, 最大 ${maxIter} 周)。` +
          `状態: ${loop.dir}/` +
          (loop_auto_approve_criteria
            ? ` — 基準は auto-approved です。実装が終わったら fable_review を呼ぶこと。`
            : ` — まず ${join(loop.dir, "criteria.md")} の基準をユーザーに見せ、承認後に fable_loop_approve を呼んでください。`) +
          ` state.json / criteria.md / task.md は直接編集禁止 (採点の改竄に当たる)。`;
      } catch (e) {
        res.text += `\n[fable-loop] 初期化に失敗しました: ${e.message}`;
      }
    }
    return toToolResult(
      withRelayDirective(
        res,
        "プラン",
        "Plan モードの場合、proposed_plan (プラン本文) には Summary や Key Changes などあなたの再構成を書かず、上記プラン全文を一字一句そのままコピーして入れること (この [fable-mcp] フッターは除いてよい)。変更が必要な場合のみ、原文の後に「Fableプランからの変更点」として差分と理由を別記してください。"
      )
    );
  }
);

server.tool(
  "fable_ask",
  "Claude Fable 5 に深い推論が必要な質問・相談をする。ユーザーが「Fable」「Fable5」「フェイブル」に言及したとき (例:「Fable5に聞いて」) は、その内容をこのツールに渡すこと。技術選定・トレードオフ分析・難しいデバッグの仮説出しなどに向く。",
  {
    question: z.string().describe("質問・相談の内容。背景と文脈を含めて書く。"),
    cwd: z
      .string()
      .optional()
      .describe("リポジトリに関する質問なら、そのプロジェクトのルート絶対パス。Fable が中を読んで答える。"),
    session_id: z
      .string()
      .optional()
      .describe("前回の応答に含まれる session_id。渡すと同じ会話の続きになる。"),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe(
        "推論の深さ。ユーザーが「じっくり/深く/本気で」と言ったら xhigh か max、「軽く/サクッと」と言ったら medium。未指定ならサーバーのデフォルト。"
      ),
  },
  async ({ question, cwd, session_id, effort }, extra) => {
    const prompt = `あなたは深い推論を行うコンサルタントです。以下の質問に、必要ならこのリポジトリの関連ファイルを確認した上で、よく考えて答えてください。質問と同じ言語で回答してください。

<question>
${question}
</question>`;
    const res = await runClaude({ prompt, cwd, sessionId: session_id, effort, onProgress: makeProgressReporter(extra), signal: extra?.signal });
    return toToolResult(withRelayDirective(res, "回答"));
  }
);

server.tool(
  "fable_review",
  "実装完了後、Claude Fable 5 にコードレビューを依頼する。現在のリポジトリの未コミット変更 (git diff) を Fable が読み、バグ・設計との乖離・簡素化の余地を指摘する。大きな実装の後に呼ぶとよい。品質ループ (.fable-loop/) が有効なプロジェクトでは「採点係」として動き、受け入れ基準に照らした絶対評価スコアが state.json に機械記録される (未達なら Stop フックが自動で差し戻す)。",
  {
    cwd: z.string().describe("対象プロジェクトのルート絶対パス。"),
    context: z
      .string()
      .optional()
      .describe("照合すべき元の設計プランや意図。fable_plan の出力を渡すと設計との乖離を検出できる。"),
    session_id: z
      .string()
      .optional()
      .describe("fable_plan と同じ会話でレビューさせたい場合、その session_id。"),
    loop_id: z
      .string()
      .optional()
      .describe("品質ループの loop_id。省略時は .fable-loop/current.json の現在ループを使う。"),
    effort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .optional()
      .describe(
        "推論の深さ。徹底的なレビューなら xhigh、軽い確認なら medium。未指定ならサーバーのデフォルト。"
      ),
    evaluator_mode: z
      .enum(["single", "ensemble", "debate"])
      .optional()
      .describe(
        "品質ループ時の採点モード。single は1回、ensemble は独立採点を複数回、debate はFableに内部反証を要求する。デフォルトは single。"
      ),
    review_repeats: z
      .number()
      .int()
      .min(1)
      .max(3)
      .optional()
      .describe("ensemble 採点の回数。最大3。未指定なら ensemble で3、その他で1。"),
  },
  async ({ cwd, context, session_id, loop_id, effort, evaluator_mode, review_repeats }, extra) => {
    const loop = readLoop(cwd, loop_id);
    const state = loop?.state;
    const hasLoop = Boolean(state?.threshold);
    if (hasLoop && !state.criteria_approved && !loop?.legacy) {
      return toToolResult({
        isError: true,
        text:
          `品質ループ ${loop.loopId} は受け入れ基準の承認待ちです。\n` +
          `${join(loop.dir, "criteria.md")} をユーザーに提示し、承認されたら fable_loop_approve を呼んでください。`,
      });
    }
    const loopMode = Boolean(state?.active && state?.criteria_approved);

    let prompt;
    if (loopMode) {
      const taskText = safeReadLoopFile(loop, "task.md");
      const criteriaText = context || safeReadLoopFile(loop, "criteria.md");
      const debateInstruction =
        evaluator_mode === "debate"
          ? "\n- 採点前に、擁護側と反証側の2視点で短く内部討論し、最後は反証側の懸念を反映した厳しめの絶対評価にする"
          : "";
      prompt = `あなたは品質ループの「採点係」です。別のエージェントが実装した現在のリポジトリの状態を、受け入れ基準に照らして絶対評価してください。

契約 (違反した採点は無効):
- git status / git diff / 実ファイルを必ず自分で開いて確認する。他者の報告や自己申告は信用しない
- 受け入れ基準の変更・緩和は禁止。基準にない新しい気づきは feedback に書く (採点軸には加えない)
- 前回スコアとの相対評価をしない。毎回ゼロから、依頼と基準への適合だけで採点する
- 機械チェック項目はできる限り実際にコマンドで確かめる。読み取り専用モードで実行できない場合は、コードとテスト定義を読んで判定し、その旨を feedback に記す
${debateInstruction}

<task>
${taskText}
</task>

<criteria>
${criteriaText}
</criteria>

レビュー本文 (指摘は file:line 付き・重大度順) を書いた後、最後に必ず次の形式で採点JSONを1つだけ出力してください:
<eval>{"score": 0から100の整数, "breakdown": {"採点軸キー": 整数, ...}, "feedback": "次の周回への具体的な修正指示 (何を・なぜ・どう直すか)"}</eval>`;
    } else {
      prompt = `あなたは別のエージェントが書いた実装のレビュアーです。git status / git diff / git diff --staged で現在の変更を確認し、必要なら周辺コードも読んだ上で、以下を報告してください:
- バグ・正しさの問題 (file:line 付き)
- 意図された設計からの乖離
- 簡素化・再利用の余地
重大度順に。特に問題がなければ簡潔にそう言ってください。
${context ? `\n照合すべき設計意図:\n<design>\n${context}\n</design>` : ""}`;
    }

    const repeats = loopMode
      ? Math.max(1, Math.min(3, Math.floor(review_repeats ?? (evaluator_mode === "ensemble" ? 3 : 1))))
      : 1;
    const results = [];
    for (let i = 0; i < repeats; i++) {
      const res = await runClaude({
        prompt: repeats > 1 ? `${prompt}\n\nこの採点は ensemble run ${i + 1}/${repeats} です。他の採点者の結果は見ず、独立に判定してください。` : prompt,
        cwd,
        sessionId: repeats > 1 ? undefined : session_id,
        effort,
        onProgress: makeProgressReporter(extra),
        signal: extra?.signal,
      });
      results.push(res);
      if (res.isError) break;
    }
    const res =
      results.length === 1
        ? results[0]
        : {
            isError: results.some((item) => item.isError),
            text: results.map((item, idx) => `# Fable evaluator ${idx + 1}\n\n${item.text}`).join("\n\n---\n\n"),
            rawText: results.map((item) => item.rawText || item.text).join("\n\n---\n\n"),
            sessionId: results[0]?.sessionId || "",
            effort: results[0]?.effort || "",
            costUsd: results.reduce((sum, item) => sum + (typeof item.costUsd === "number" ? item.costUsd : 0), 0),
          };

    if (loopMode && !res.isError) {
      const evals = results.map((item) => parseEval(item.text));
      const ev = aggregateEvals(evals);
      if (!ev) {
        updateLoopCost(state, res);
        state.phase = "eval";
        state.score = null;
        state.passed = false;
        state.review_required_since = "";
        state.review_required_paths = [];
        state.last_eval_error = "missing_or_invalid_eval_json";
        state.last_eval_error_at = new Date().toISOString();
        try {
          const iter = Math.floor(state.iteration ?? 0);
          writeFileSync(
            join(loop.turnsDir, `turn-${String(iter).padStart(3, "0")}-invalid-eval.json`),
            JSON.stringify(
              {
                error: "missing_or_invalid_eval_json",
                evaluator_mode: evaluator_mode || "single",
                raw_text: res.rawText || res.text,
                evaluated_at: new Date().toISOString(),
              },
              null,
              2
            )
          );
          writeLoopState(loop, state);
        } catch {
          /* best effort: the tool error below still tells the agent what happened */
        }
        res.isError = true;
        res.text +=
          "\n[fable-loop] 採点JSON (<eval>{...}</eval>) を取得できませんでした。state を phase=eval / score=null に更新しました。Stop hook が修復指示を出します。";
      } else {
        // passed は Fable の自己申告ではなく、ここで機械的に確定する
        const score = Math.max(0, Math.min(100, Math.floor(ev.score)));
        const threshold = Math.floor(state.threshold ?? 90);
        const passed = score >= threshold;
        const iter = Math.floor(state.iteration ?? 0);
        try {
          const changedPaths = listChangedPaths(cwd);
          mergeWriteTargets(state, changedPaths);
          updateLoopCost(state, res);
          const iterRef = createLoopSnapshot(cwd, loop, state, iter, score);
          writeFileSync(
            join(loop.turnsDir, `turn-${String(iter).padStart(3, "0")}-eval.json`),
            JSON.stringify(
              {
                score,
                breakdown: ev.breakdown ?? {},
                feedback: ev.feedback ?? "",
                passed,
                threshold,
                iteration: iter,
                evaluator_mode: evaluator_mode || "single",
                ensemble_size: ev.ensemble_size || 1,
                raw_scores: ev.raw_scores || [score],
                changed_paths: changedPaths,
                snapshot_ref: iterRef || "",
                evaluated_at: new Date().toISOString(),
              },
              null,
              2
            )
          );
          state.iteration = iter + 1;
          state.score = score;
          state.passed = passed;
          state.phase = "eval";
          state.evaluated_iteration = iter + 1;
          state.eval_repair_attempts = 0;
          state.review_required_since = "";
          state.review_required_paths = [];
          state.last_eval_error = "";
          if (score > (state.best_score ?? 0)) {
            state.best_score = score;
            state.best_iteration = iter;
            markBestSnapshot(cwd, loop, state, iterRef);
          }
          writeLoopState(loop, state);
          res.text +=
            `\n[fable-loop] loop_id ${loop.loopId} | iteration ${iter + 1}/${state.max} | score ${score}/${threshold} (合否は server 側で機械判定) | ` +
            `cost total ~$${Number(state.cumulative_cost_usd || 0).toFixed(4)} | ` +
            (passed
              ? "✅ 合格 — ループはターン終了時に自動停止します"
              : "❌ 未達 — feedback に従って修正し、再度 fable_review を呼んでください (state.json の直接編集は禁止)") +
            (state.best_snapshot_ref ? `\n[fable-loop] best snapshot: ${state.best_snapshot_ref}` : "");
        } catch (e) {
          res.text += `\n[fable-loop] state 更新に失敗しました: ${e.message}`;
        }
      }
    }

    return toToolResult(
      withRelayDirective(res, "レビュー結果", "指摘の file:line や重大度順を崩さないでください。対応方針はレビュー全文を提示した後に別記してください。")
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready v${VERSION} (model=${MODEL}, claude=${CLAUDE_BIN}, platform=${process.platform})`);
