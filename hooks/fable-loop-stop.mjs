#!/usr/bin/env node
/**
 * fable-loop の「進行係」— Codex の Stop フック。
 *
 * ターン終了のたびに発火し、現在の .fable-loop セッションを読んで
 * 「score >= threshold か、iteration >= max か」を整数比較するだけ。
 * 未達なら {"decision":"block","reason":...} を返し、Codex に次の周回を
 * 指示する。AI の気分も人の根気も、この判定には一切関わらない。
 *
 * v0.7 以降の状態:
 *   .fable-loop/current.json
 *   .fable-loop/sessions/<loop_id>/state.json
 *
 * v0.6 以前の状態も互換で読む:
 *   .fable-loop/state.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function resolveLoop(cwd) {
  const root = join(cwd, ".fable-loop");
  const current = readJson(join(root, "current.json"));
  if (current?.loop_id && LOOP_ID_RE.test(current.loop_id)) {
    const dir = join(root, "sessions", current.loop_id);
    const statePath = join(dir, "state.json");
    if (existsSync(statePath)) {
      return {
        loopId: current.loop_id,
        statePath,
        turnsDir: join(dir, "turns"),
      };
    }
  }

  const legacyState = join(root, "state.json");
  if (existsSync(legacyState)) {
    return {
      loopId: "legacy",
      statePath: legacyState,
      turnsDir: join(root, "turns"),
    };
  }

  return null;
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
  const loop = resolveLoop(cwd);
  if (!loop) {
    out({});
    return;
  }

  const state = readJson(loop.statePath);
  if (!state || !state.active) {
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
    state.phase = state.passed ? "passed" : "max_iterations";
    state.ended_reason = state.passed ? "threshold_met" : "max_iterations";
    state.ended_at = new Date().toISOString();
    try {
      writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
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
  state.updated_at = new Date().toISOString();
  try {
    writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
  } catch {
    /* 書けない場合も block 自体は返す */
  }

  const turnFile = `turn-${String(Math.max(0, iteration - 1)).padStart(3, "0")}-eval.json`;
  const stateDir = loop.statePath.replace(/[/\\]state\.json$/, "");
  const reason =
    `[fable-loop ${loop.loopId} iteration ${iteration}/${max} | score ${score} < ${threshold}] 品質ループを継続します。次の手順:\n` +
    `1. ${join(stateDir, "turns", turnFile)} の feedback を読む\n` +
    `2. ${join(stateDir, "task.md")} と criteria.md を読み直す (目標ドリフト防止)\n` +
    `3. feedback で指摘された箇所だけを修正する (まとめて大きく変えない)\n` +
    `4. fable_review ツールを呼んで再採点する\n` +
    `注意: .fable-loop/ 配下のファイルの直接編集は禁止 (採点の改竄に当たる)。ループを中断したい場合は fable_loop_abort を呼ぶこと。`;
  out({ decision: "block", reason });
});
