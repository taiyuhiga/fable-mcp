#!/usr/bin/env node
/**
 * fable-loop の「進行係」— Codex の Stop フック。
 *
 * ターン終了のたびに発火し、.fable-loop/state.json を読んで
 * 「score >= threshold か、iteration >= max か」を整数比較するだけ。
 * 未達なら {"decision":"block","reason":...} を返し、Codex に次の周回を
 * 指示する。AI の気分も人の根気も、この判定には一切関わらない。
 *
 * セットアップ (~/.codex/hooks.json):
 *   { "hooks": { "Stop": [ { "hooks": [
 *     { "type": "command", "command": "node /path/to/fable-mcp/hooks/fable-loop-stop.mjs", "timeout": 30 }
 *   ] } ] } }
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    /* 入力が読めなくても cwd フォールバックで続行 */
  }
  const cwd = payload.cwd || process.cwd();
  const statePath = join(cwd, ".fable-loop", "state.json");

  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    out({}); // ループ未使用のプロジェクト: 何もしない
    return;
  }
  if (!state.active) {
    out({});
    return;
  }

  const score = Math.floor(state.score ?? 0);
  const threshold = Math.floor(state.threshold ?? 90);
  const iteration = Math.floor(state.iteration ?? 0);
  const max = Math.floor(state.max ?? 4);

  // 出口1: 合格、または周回上限 → ループを閉じて静かに終了
  if (score >= threshold || iteration >= max) {
    state.active = false;
    state.passed = score >= threshold;
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch {
      /* 書けなくても停止判断は変えない */
    }
    out({});
    return;
  }

  // 二重発火ガード: 同じ周回で既に差し戻し済みなら黙って通す
  // (差し戻したのに fable_review が呼ばれずターンが終わった場合の無限ループ防止)
  if (Math.floor(state.last_blocked_iteration ?? -1) === iteration) {
    out({});
    return;
  }
  state.last_blocked_iteration = iteration;
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  } catch {
    /* 書けない場合も block 自体は返す */
  }

  const turnFile = `turn-${String(Math.max(0, iteration - 1)).padStart(3, "0")}-eval.json`;
  const reason =
    `[fable-loop iteration ${iteration}/${max} | score ${score} < ${threshold}] 品質ループを継続します。次の手順:\n` +
    `1. .fable-loop/turns/${turnFile} の feedback を読む\n` +
    `2. .fable-loop/task.md と criteria.md を読み直す (目標ドリフト防止)\n` +
    `3. feedback で指摘された箇所だけを修正する (まとめて大きく変えない)\n` +
    `4. fable_review ツールを呼んで再採点する\n` +
    `注意: .fable-loop/ 配下のファイルの直接編集は禁止 (採点の改竄に当たる)。ループを中断したい場合のみ、ユーザーの指示を得て state.json の active を false にすること。`;
  out({ decision: "block", reason });
});
