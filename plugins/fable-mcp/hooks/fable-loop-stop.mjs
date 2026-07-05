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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function isInternalPath(path) {
  const p = String(path || "").replaceAll("\\", "/").replace(/^\/+/, "");
  return p === ".fable-loop" || p.startsWith(".fable-loop/") || p === ".fable" || p.startsWith(".fable/");
}

function listChangedPaths(cwd) {
  const res = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  if (res.status !== 0 || !res.stdout) return [];
  const entries = res.stdout.split("\0").filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    let path = entry.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const next = entries[i + 1];
      if (next) {
        path = next;
        i++;
      }
    }
    path = String(path || "").replaceAll("\\", "/");
    if (path && !isInternalPath(path)) paths.push(path);
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

  const phase = state.phase || "implementing";
  if (phase === "implementing") {
    const current = workingTreeFingerprint(cwd);
    const baseline = state.implementation_baseline_fingerprint || "";
    if (!baseline && current.paths.length > 0) {
      state.implementation_baseline_fingerprint = current.hash;
      state.implementation_baseline_paths = current.paths;
      state.review_required_since = "";
      state.review_required_paths = [];
      try {
        writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
      } catch {
        /* fall through */
      }
    } else if (current.paths.length > 0 && current.hash !== baseline) {
      state.review_required_since = state.review_required_since || new Date().toISOString();
      state.review_required_paths = current.paths;
      state.last_review_required_at = new Date().toISOString();
      try {
        writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
      } catch {
        /* block anyway */
      }
      const reason =
        `[fable-loop ${loop.loopId} | review required before stopping]\n` +
        `品質ループの実装修正が検出されましたが、まだ fable_review が呼ばれていません。\n` +
        `変更パス:\n${current.paths.slice(0, 20).map((p) => `- ${p}`).join("\n")}` +
        (current.paths.length > 20 ? `\n- ... and ${current.paths.length - 20} more` : "") +
        `\n次の手順: fable_review を呼んで、Fable に受け入れ基準で採点させてください。` +
        `\n注意: レビュー前にターンを終えると品質ループが止まって見えるため、このStop hookが差し戻しています。`;
      out({ decision: "block", reason });
      return;
    }
  }
  if (phase !== "eval") {
    out({});
    return;
  }

  const threshold = Math.floor(state.threshold ?? 90);
  const iteration = Math.floor(state.iteration ?? 0);
  const max = Math.floor(state.max ?? 4);
  const rawScoreValue = state.score;
  const rawScore = Number(rawScoreValue);

  if (rawScoreValue === null || rawScoreValue === undefined || rawScoreValue === "" || !Number.isFinite(rawScore)) {
    const repairAttempts = Math.floor(Number(state.eval_repair_attempts ?? 0));
    if (repairAttempts >= 2) {
      state.active = false;
      state.phase = "invalid_eval_output";
      state.ended_reason = "invalid_eval_output";
      state.ended_at = new Date().toISOString();
      try {
        writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
      } catch {
        /* hook safety */
      }
      out({});
      return;
    }

    state.eval_repair_attempts = repairAttempts + 1;
    state.updated_at = new Date().toISOString();
    try {
      writeFileSync(loop.statePath, JSON.stringify(state, null, 2));
    } catch {
      /* 書けない場合も block 自体は返す */
    }
    const stateDir = loop.statePath.replace(/[/\\]state\.json$/, "");
    const invalidFile = join(stateDir, "turns", `turn-${String(iteration).padStart(3, "0")}-invalid-eval.json`);
    const reason =
      `[fable-loop ${loop.loopId} iteration ${iteration}/${max} | INVALID EVAL OUTPUT]\n` +
      `採点フェーズは完了しましたが score が有効な整数ではありません。\n` +
      `1. ${invalidFile} があれば内容を確認する\n` +
      `2. fable_review をもう一度呼んで、必ず <eval>{\"score\": 0-100, ...}</eval> を返させる\n` +
      `3. .fable-loop/ 配下は直接編集しない。修復が2回失敗したらループは invalid_eval_output で終了します。`;
    out({ decision: "block", reason });
    return;
  }

  const score = Math.max(0, Math.min(100, Math.floor(rawScore)));

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
  state.phase = "implementing";
  const baseline = workingTreeFingerprint(cwd);
  state.implementation_baseline_fingerprint = baseline.hash;
  state.implementation_baseline_paths = baseline.paths;
  state.review_required_since = "";
  state.review_required_paths = [];
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
