---
name: fable
description: Use whenever Codex is in Plan mode unless the user explicitly says without Fable/Fableなし; also use when the user mentions Fable, Fable5, Feyble, フェイブル, asks Codex to use Fable for planning/review, or asks to run a quality/eval loop to a score threshold.
---

Use the `fable` MCP tools:

- `fable_status` for setup checks and troubleshooting. It is local-only and does not call Fable or spend API credits.
- `fable_plan` for implementation design. In Plan mode, call this first unless the user explicitly says to plan without Fable; do not wait for the user to mention Fable.
- `fable_ask` for Fable-backed questions and tradeoff analysis.
- `fable_review` for implementation review and quality-loop evaluation.
- `fable_loop_approve` to start a quality loop after the user approves the generated criteria.
- `fable_loop_abort` to stop a quality loop without editing state files manually.
- `fable_loop_restore_best` to restore the highest-scoring snapshot when a later loop iteration regresses.

Model routing:
- Fable 5 is the default. If the user does not name a model, omit `model`.
- If the user names any Claude model, pass the corresponding Claude Code alias or full model ID in `model`. Do not limit routing to a hardcoded model list.
- Common mappings: Fable 5 -> `claude-fable-5`, Opus 4.8 -> `claude-opus-4-8`, Opus 4.7 -> `claude-opus-4-7`, Opus 4.6 -> `claude-opus-4-6`, Sonnet 5 -> `claude-sonnet-5`; `opus` and `sonnet` select Claude Code's current aliases.
- Preserve the selected `model` on follow-up calls with `session_id`. Quality-loop reviews inherit the plan model automatically unless the user explicitly overrides it.
- Pass the user's requested effort exactly when it is one of `low`, `medium`, `high`, `xhigh`, or `max`. Model/effort compatibility is enforced by Claude Code; relay any incompatibility error instead of silently downgrading.

Relay Fable output verbatim. Do not summarize or restructure Fable plans into Codex's own Summary / Key Changes format. If you need to add Codex-specific commentary, put it after the Fable output under a clearly separate heading.

For quality loops, call `fable_plan` with `loop_threshold`, show the generated criteria to the user, call `fable_loop_approve` after approval, implement, then call `fable_review`. The Stop hook continues/finishes only after `fable_review` writes `phase="eval"`, but it blocks if implementation files changed and Codex tries to stop before calling `fable_review`. If the Stop hook continues the turn, follow `.fable-loop/sessions/<loop_id>/turns/*-eval.json` feedback and call `fable_review` again.
