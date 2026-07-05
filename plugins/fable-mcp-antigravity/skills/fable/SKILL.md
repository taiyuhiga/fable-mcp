---
name: fable
description: Use when the user mentions Fable, Fable5, Feyble, フェイブル, asks for deep external planning/review, wants a quality/eval loop, or asks to check the Fable MCP setup from Antigravity.
---

# Fable MCP for Antigravity

Use the `fable` MCP server as an external read-only Fable 5 planning and evaluation layer.

## Routing

- Setup or troubleshooting: call `fable_status` first. It is local-only and does not spend API credits.
- Planning: when the user asks to use Fable/Fable5, call `fable_plan` before implementing.
- Questions or wall-ball: call `fable_ask`.
- Review: after implementation, call `fable_review`.
- Quality loop: if the user says "合格まで", "N点まで", "loop", or "eval-loop", call `fable_plan` with `loop_threshold`, show the generated criteria, wait for user approval, call `fable_loop_approve`, implement, then call `fable_review`.

## Required Tool Arguments

- Always pass the current project root as an absolute path in `cwd`.
- For follow-up Fable conversations, pass the returned `session_id`.
- If the user says "max", "deep", or "じっくり", pass `effort: "max"` or `effort: "xhigh"`.
- If the user says "quick", "light", or "軽く", pass `effort: "medium"`.

## Output Handling

- Fable output is canonical. Relay plans, answers, and review results verbatim.
- Do not summarize, rewrite, or replace Fable's sections with your own.
- If you need to add Antigravity-specific implementation notes, put them after the verbatim Fable output under `Fableプランからの変更点`.
- `.fable/last-plan.md` is the canonical saved plan when present.

## Safety

- Fable runs through Claude Code headless plan mode and should remain read-only.
- Implementation, tests, commits, and releases are done by the host agent.
- Do not edit `.fable-loop/` files directly. Use `fable_loop_abort` or `fable_loop_restore_best`.
