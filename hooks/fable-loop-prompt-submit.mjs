#!/usr/bin/env node
/**
 * UserPromptSubmit hook for fable-loop.
 *
 * This hook is diagnostic only:
 * - warns about stale active loops
 * - warns when active loops share write_targets
 * - reminds the agent when a previous evaluation is waiting for Stop-hook handling
 *
 * Hook safety: never throw, never block the user's prompt, never call Fable.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const LOOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const STALE_MINUTES = Number(process.env.FABLE_LOOP_STALE_MINUTES || 30);
const WARN_LIMIT = 4;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseInput() {
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  return new Promise((resolve) => {
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(input || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function loopRoot(cwd) {
  return join(cwd, ".fable-loop");
}

function sessionDir(cwd, loopId) {
  return join(loopRoot(cwd), "sessions", loopId);
}

function currentLoopId(cwd) {
  const current = readJson(join(loopRoot(cwd), "current.json"));
  return current?.loop_id && LOOP_ID_RE.test(current.loop_id) ? current.loop_id : "";
}

function listLoops(cwd) {
  const loops = [];
  const sessions = join(loopRoot(cwd), "sessions");
  try {
    for (const entry of readdirSync(sessions, { withFileTypes: true })) {
      if (!entry.isDirectory() || !LOOP_ID_RE.test(entry.name)) continue;
      const dir = sessionDir(cwd, entry.name);
      const statePath = join(dir, "state.json");
      const state = readJson(statePath);
      if (state) loops.push({ loopId: state.loop_id || entry.name, dir, statePath, state, legacy: false });
    }
  } catch {
    /* no session loops */
  }

  const legacyPath = join(loopRoot(cwd), "state.json");
  if (existsSync(legacyPath)) {
    const state = readJson(legacyPath);
    if (state) loops.push({ loopId: "legacy", dir: loopRoot(cwd), statePath: legacyPath, state, legacy: true });
  }
  return loops;
}

function updatedTimeMs(state) {
  const candidates = [state.updated_at, state.approved_at, state.started_at].filter(Boolean);
  for (const value of candidates) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function normalizeTargets(state) {
  return Array.isArray(state.write_targets)
    ? state.write_targets.map((item) => String(item || "").replaceAll("\\", "/")).filter(Boolean)
    : [];
}

function intersection(a, b) {
  const bSet = new Set(b);
  return a.filter((item) => bSet.has(item));
}

async function main() {
  const payload = await parseInput();
  const cwd = payload.cwd || process.cwd();
  const loops = listLoops(cwd).filter((loop) => loop.state?.active);
  if (loops.length === 0) return;

  const current = currentLoopId(cwd);
  const warnings = [];
  const now = Date.now();

  for (const loop of loops) {
    const state = loop.state;
    const phase = state.phase || "implementing";
    const score = Number.isFinite(Number(state.score)) ? Math.floor(Number(state.score)) : "none";
    const threshold = Number.isFinite(Number(state.threshold)) ? Math.floor(Number(state.threshold)) : 90;
    const marker = loop.loopId === current ? "current" : "active";
    warnings.push(
      `[${marker}] Fable loop ${loop.loopId}: phase=${phase}, iteration=${state.iteration ?? 0}/${state.max ?? "?"}, score=${score}/${threshold}.`
    );

    if (phase === "eval") {
      warnings.push(`Fable loop ${loop.loopId} has a fresh evaluation. Let the Stop hook continue/finish it before starting unrelated work.`);
    }

    const updated = updatedTimeMs(state);
    if (updated && Number.isFinite(STALE_MINUTES) && STALE_MINUTES > 0) {
      const ageMin = Math.floor((now - updated) / 60000);
      if (ageMin >= STALE_MINUTES) {
        warnings.push(
          `WARNING: Fable loop ${loop.loopId} may be stalled: no state update for ${ageMin}m. Continue with fable_review or stop it with fable_loop_abort.`
        );
      }
    }
  }

  for (let i = 0; i < loops.length; i++) {
    for (let j = i + 1; j < loops.length; j++) {
      const left = normalizeTargets(loops[i].state);
      const right = normalizeTargets(loops[j].state);
      const overlap = intersection(left, right);
      if (overlap.length > 0) {
        warnings.push(
          `WARNING: Fable loop write_targets conflict: ${loops[i].loopId} and ${loops[j].loopId} both touch ${overlap.join(", ")}. Avoid parallel edits or abort one loop.`
        );
      }
    }
  }

  if (warnings.length > 0) {
    process.stdout.write(["# Fable loop status", ...warnings.slice(0, WARN_LIMIT)].join("\n"));
    if (warnings.length > WARN_LIMIT) {
      process.stdout.write(`\n... ${warnings.length - WARN_LIMIT} more Fable loop notice(s) omitted.`);
    }
  }
}

main().catch(() => {
  /* hook safety */
});
