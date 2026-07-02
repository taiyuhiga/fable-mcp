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
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const MODEL = process.env.FABLE_MODEL || "claude-fable-5";
const TIMEOUT_MS = Number(process.env.FABLE_TIMEOUT_MS || 20 * 60 * 1000); // 20分
const MAX_BUFFER = 64 * 1024 * 1024;

const log = (...args) => console.error("[fable-mcp]", ...args);

/**
 * claude バイナリの解決順:
 * 1. FABLE_CLAUDE_BIN 環境変数
 * 2. この server を動かしている node と同じディレクトリ (nvm 環境で確実)
 * 3. PATH 上の "claude"
 */
function resolveClaudeBin() {
  if (process.env.FABLE_CLAUDE_BIN) return process.env.FABLE_CLAUDE_BIN;
  const sibling = join(dirname(process.execPath), "claude");
  if (existsSync(sibling)) return sibling;
  return "claude";
}

const CLAUDE_BIN = resolveClaudeBin();

function runClaude({ prompt, cwd, sessionId }) {
  return new Promise((resolve) => {
    const args = [
      "-p",
      prompt,
      "--model",
      MODEL,
      "--permission-mode",
      "plan",
      "--output-format",
      "json",
    ];
    if (sessionId) args.push("--resume", sessionId);

    const startedAt = Date.now();
    log(`spawn: ${CLAUDE_BIN} (model=${MODEL}, cwd=${cwd || process.cwd()}, resume=${sessionId || "-"})`);

    execFile(
      CLAUDE_BIN,
      args,
      { cwd: cwd || process.cwd(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: process.env },
      (err, stdout, stderr) => {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

        if (err && err.code === "ENOENT") {
          resolve({
            isError: true,
            text:
              `claude CLI が見つかりません (${CLAUDE_BIN})。\n` +
              `Claude Code をインストールしてください: npm i -g @anthropic-ai/claude-code\n` +
              `別の場所にある場合は FABLE_CLAUDE_BIN 環境変数でフルパスを指定してください。`,
          });
          return;
        }
        if (err && err.killed) {
          resolve({
            isError: true,
            text: `Fable の応答がタイムアウトしました (${Math.round(TIMEOUT_MS / 60000)}分)。タスクを分割するか FABLE_TIMEOUT_MS を延ばしてください。`,
          });
          return;
        }

        let parsed = null;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          /* JSON でなければ生テキストとして扱う */
        }

        if (parsed && typeof parsed.result === "string") {
          const cost =
            typeof parsed.total_cost_usd === "number" ? `$${parsed.total_cost_usd.toFixed(2)}` : "n/a";
          const footer =
            `\n\n---\n[fable-mcp] session_id: ${parsed.session_id || "n/a"}` +
            ` (同じ会話を続けるには次回この session_id を渡す) | cost: ${cost} | ${elapsedSec}s`;
          resolve({ isError: Boolean(parsed.is_error), text: parsed.result + footer });
          return;
        }

        // JSON が取れなかった / 想定外の形 → 生の出力とエラーを返す
        const raw = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`, err && `error: ${err.message}`]
          .filter(Boolean)
          .join("\n\n");
        resolve({
          isError: Boolean(err),
          text: raw || "claude CLI から出力がありませんでした。",
        });
      }
    );
  });
}

function toToolResult({ isError, text }) {
  return { content: [{ type: "text", text }], isError };
}

const server = new McpServer({ name: "fable-mcp", version: "0.1.0" });

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
  async ({ task, cwd, session_id }) => {
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
    return toToolResult(await runClaude({ prompt, cwd, sessionId: session_id }));
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
  async ({ question, cwd, session_id }) => {
    const prompt = `あなたは深い推論を行うコンサルタントです。以下の質問に、必要ならこのリポジトリの関連ファイルを確認した上で、よく考えて答えてください。質問と同じ言語で回答してください。

<question>
${question}
</question>`;
    return toToolResult(await runClaude({ prompt, cwd, sessionId: session_id }));
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
  async ({ cwd, context, session_id }) => {
    const prompt = `あなたは別のエージェントが書いた実装のレビュアーです。git status / git diff / git diff --staged で現在の変更を確認し、必要なら周辺コードも読んだ上で、以下を報告してください:
- バグ・正しさの問題 (file:line 付き)
- 意図された設計からの乖離
- 簡素化・再利用の余地
重大度順に。特に問題がなければ簡潔にそう言ってください。
${context ? `\n照合すべき設計意図:\n<design>\n${context}\n</design>` : ""}`;
    return toToolResult(await runClaude({ prompt, cwd, sessionId: session_id }));
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready (model=${MODEL}, claude=${CLAUDE_BIN})`);
