# Fable 5 Orchestration

Fable 5 is the external deep-reasoning architect and evaluator for Codex.

- Plan mode: when Codex is in Plan mode, call `fable_plan` before presenting a plan unless the user explicitly says "without Fable" / "Fableなし". Do not wait for the user to mention Fable; Plan mode itself is treated as the user's signal that deeper planning is worth the extra latency/cost.
- Setup/status: for setup checks or troubleshooting ("Fable status", "Fable MCP動いてる?", "状態を確認して"), call `fable_status` first. It is local-only and does not spend API credits.
- Plan fidelity: when presenting a Fable plan, copy the Fable plan body verbatim into the proposed plan. Do not rewrite it into Summary / Key Changes / Answer Structure. If Codex needs to deviate, append a separate "Fableプランからの変更点" section after the verbatim plan.
- Plan source of truth: every `fable_plan` writes the verbatim Fable plan to `.fable/last-plan.md`. If Codex's Plan UI or response formatting conflicts with the tool output, treat `.fable/last-plan.md` as the canonical plan and show/read it verbatim.
- Normal mode: outside Plan mode, call Fable only when the user mentions Fable/Fable5/Feyble/フェイブル, asks for Fable-backed planning/review, or asks for a quality loop.
- Quality loop: for "合格まで回して", "N点まで仕上げて", "ループで", or "eval-loop", call `fable_plan` with `loop_threshold` (default 90). Show the generated criteria to the user, then call `fable_loop_approve` after approval. Implement, then call `fable_review`. The Stop hook is phase-gated and continues/finishes only after `fable_review` writes `phase="eval"`, but it will block if implementation files changed and you try to stop before calling `fable_review`. If the Stop hook continues the turn, read the latest `.fable-loop/sessions/<loop_id>/turns/*-eval.json`, fix only the feedback, and call `fable_review` again. Never edit `.fable-loop/` files directly. Use `fable_loop_abort` to stop and `fable_loop_restore_best` to restore the best snapshot.
- Model: Fable 5 is the default. If the user names any Claude model, pass its Claude Code alias/full ID in `model` (for example Opus 4.8 => `claude-opus-4-8`, Opus 4.7 => `claude-opus-4-7`, Opus 4.6 => `claude-opus-4-6`, Sonnet 5 => `claude-sonnet-5`). Do not restrict future model IDs. Preserve model on session follow-ups.
- Effort: pass an explicit user choice exactly when it is `low`, `medium`, `high`, `xhigh`, or `max`. "maxで", "じっくり", "deep" => `max` or `xhigh`; "軽く", "quick", "サクッと" => `medium`. If unspecified, do not pass effort and let the model default apply. Never silently downgrade an unsupported model/effort pair.
- Relay: Fable output is canonical. Present Fable plans, answers, and reviews verbatim. Any Codex commentary must be clearly separated after the Fable output.
- Continuation: pass the returned `session_id` when following up in the same Fable conversation.
- Latency: Fable may take several minutes. Wait unless the user cancels.
