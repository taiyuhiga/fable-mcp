---
name: fable
description: Use when the user mentions Fable, Fable5, Feyble, フェイブル, asks Codex to use Fable for planning/review, asks for Plan mode with Fable, or asks to run a quality/eval loop to a score threshold.
---

Use the `fable` MCP tools:

- `fable_status` for setup checks and troubleshooting. It is local-only and does not call Fable or spend API credits.
- `fable_plan` for implementation design. In Plan mode, use this unless the user explicitly says to plan without Fable.
- `fable_ask` for Fable-backed questions and tradeoff analysis.
- `fable_review` for implementation review and quality-loop evaluation.
- `fable_loop_approve` to start a quality loop after the user approves the generated criteria.
- `fable_loop_abort` to stop a quality loop without editing state files manually.
- `fable_loop_restore_best` to restore the highest-scoring snapshot when a later loop iteration regresses.

Relay Fable output verbatim. Do not summarize or restructure Fable plans into Codex's own Summary / Key Changes format. If you need to add Codex-specific commentary, put it after the Fable output under a clearly separate heading.

For quality loops, call `fable_plan` with `loop_threshold`, show the generated criteria to the user, call `fable_loop_approve` after approval, implement, then call `fable_review`. If the Stop hook continues the turn, follow `.fable-loop/sessions/<loop_id>/turns/*-eval.json` feedback and call `fable_review` again.
