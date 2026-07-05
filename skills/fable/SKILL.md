---
name: fable
description: Use when the user mentions Fable, Fable5, Feyble, フェイブル, asks Codex to use Fable for planning/review, asks for Plan mode with Fable, or asks to run a quality/eval loop to a score threshold.
---

Use the `fable` MCP tools:

- `fable_status` for setup checks and troubleshooting. It is local-only and does not call Fable or spend API credits.
- `fable_plan` for implementation design. In Plan mode, use this unless the user explicitly says to plan without Fable.
- `fable_ask` for Fable-backed questions and tradeoff analysis.
- `fable_review` for implementation review and quality-loop evaluation.

Relay Fable output verbatim. Do not summarize or restructure Fable plans into Codex's own Summary / Key Changes format. If you need to add Codex-specific commentary, put it after the Fable output under a clearly separate heading.

For quality loops, call `fable_plan` with `loop_threshold`, implement, then call `fable_review`. If the Stop hook continues the turn, follow `.fable-loop/turns/*-eval.json` feedback and call `fable_review` again.
