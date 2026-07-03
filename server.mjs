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

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.2.0";
const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const TIMEOUT_MS = Number(process.env.FABLE_TIMEOUT_MS || 20 * 60 * 1000); // 20分
const MAX_TURNS = Number(process.env.FABLE_MAX_TURNS ?? 60); // 0 で無制限
const HEARTBEAT_MS = 20 * 1000;
const IS_WIN = process.platform === "win32";

const MODEL_RE = /^[\w.:-]+$/;
const SESSION_ID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/;

const log = (...args) => console.error("[fable-mcp]", ...args);

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

/**
 * claude -p を起動して完了まで待つ。
 * - prompt は stdin で渡す (argv に任意文字列を載せない)
 * - onProgress(message) は Fable がツールを使うたび / 20秒ごとの生存確認で呼ばれる
 * - signal (AbortSignal) が中断されたら子プロセスを kill する
 */
function runClaude({ prompt, cwd, sessionId, onProgress, signal }) {
  return new Promise((resolve) => {
    if (!MODEL_RE.test(MODEL)) {
      resolve({ isError: true, text: `FABLE_MODEL の値が不正です: ${MODEL}` });
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
    if (MAX_TURNS > 0) args.push("--max-turns", String(MAX_TURNS));
    if (sessionId) args.push("--resume", sessionId);

    // Windows は .cmd 起動のため shell 経由。パスの空白対策で引用符を付ける。
    // 可変値は stdin(prompt) と検証済みの MODEL / sessionId のみなので安全。
    const command = IS_WIN ? `"${CLAUDE_BIN}"` : CLAUDE_BIN;

    const startedAt = Date.now();
    log(`spawn: ${CLAUDE_BIN} (model=${MODEL}, cwd=${cwd || process.cwd()}, resume=${sessionId || "-"}, maxTurns=${MAX_TURNS || "∞"})`);

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
        const cost =
          typeof resultEvent.total_cost_usd === "number" ? `$${resultEvent.total_cost_usd.toFixed(2)}` : "n/a";
        const turns = resultEvent.num_turns != null ? `${resultEvent.num_turns} turns` : "";
        const capNote =
          resultEvent.subtype === "error_max_turns"
            ? `\n\n⚠️ ターン数上限 (${MAX_TURNS}) に達したため途中までの結果です。続きは session_id を渡して依頼するか、FABLE_MAX_TURNS を増やしてください。`
            : "";
        const footer =
          `${capNote}\n\n---\n[fable-mcp] session_id: ${resultEvent.session_id || "n/a"}` +
          ` (同じ会話を続けるには次回この session_id を渡す) | cost: ${cost} | ${turns} | ${elapsedSec}s`;
        resolve({ isError: Boolean(resultEvent.is_error), text: resultEvent.result + footer });
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

const server = new McpServer({ name: "fable-mcp", version: VERSION });

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
  },
  async ({ task, cwd, session_id }, extra) => {
    const prompt = `あなたは2エージェント構成の「アーキテクト」役です。あなた (Claude Fable 5) が設計し、別の実装エージェント (Codex) がコードを書きます。

このリポジトリを必要なだけ探索し、深く考えた上で、以下のタスクの実装プランを書いてください。プランは実装エージェントがそのまま実行できる具体性で:
- ゴールと主要な設計判断 (理由も簡潔に)
- 作成/変更するファイルと、それぞれに入れる変更内容
- 再利用すべき既存コード・ユーティリティ (パス付き)
- エッジケース・リスク・制約
- 最後に検証方法 (どうテストするか)

タスクと同じ言語で回答してください。

<task>
${task}
</task>`;
    const res = await runClaude({ prompt, cwd, sessionId: session_id, onProgress: makeProgressReporter(extra), signal: extra?.signal });
    return toToolResult(
      withRelayDirective(res, "プラン", "変更が必要な場合のみ「Fableプランからの変更点」として差分と理由を別記してください。")
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
  },
  async ({ question, cwd, session_id }, extra) => {
    const prompt = `あなたは深い推論を行うコンサルタントです。以下の質問に、必要ならこのリポジトリの関連ファイルを確認した上で、よく考えて答えてください。質問と同じ言語で回答してください。

<question>
${question}
</question>`;
    const res = await runClaude({ prompt, cwd, sessionId: session_id, onProgress: makeProgressReporter(extra), signal: extra?.signal });
    return toToolResult(withRelayDirective(res, "回答"));
  }
);

server.tool(
  "fable_review",
  "実装完了後、Claude Fable 5 にコードレビューを依頼する。現在のリポジトリの未コミット変更 (git diff) を Fable が読み、バグ・設計との乖離・簡素化の余地を指摘する。大きな実装の後に呼ぶとよい。",
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
  },
  async ({ cwd, context, session_id }, extra) => {
    const prompt = `あなたは別のエージェントが書いた実装のレビュアーです。git status / git diff / git diff --staged で現在の変更を確認し、必要なら周辺コードも読んだ上で、以下を報告してください:
- バグ・正しさの問題 (file:line 付き)
- 意図された設計からの乖離
- 簡素化・再利用の余地
重大度順に。特に問題がなければ簡潔にそう言ってください。
${context ? `\n照合すべき設計意図:\n<design>\n${context}\n</design>` : ""}`;
    const res = await runClaude({ prompt, cwd, sessionId: session_id, onProgress: makeProgressReporter(extra), signal: extra?.signal });
    return toToolResult(
      withRelayDirective(res, "レビュー結果", "指摘の file:line や重大度順を崩さないでください。対応方針はレビュー全文を提示した後に別記してください。")
    );
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready v${VERSION} (model=${MODEL}, claude=${CLAUDE_BIN}, platform=${process.platform})`);
