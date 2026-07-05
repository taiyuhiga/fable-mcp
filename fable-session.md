# Fable 5 Orchestration

Fable 5 is the external deep-reasoning architect and evaluator for Codex.

- Plan mode: when Codex is in Plan mode, call `fable_plan` before presenting a plan unless the user explicitly says "without Fable" / "Fableなし". Plan mode itself is treated as the user's signal that deeper planning is worth the extra latency/cost.
- Plan fidelity: when presenting a Fable plan, copy the Fable plan body verbatim into the proposed plan. Do not rewrite it into Summary / Key Changes / Answer Structure. If Codex needs to deviate, append a separate "Fableプランからの変更点" section after the verbatim plan.
- Plan source of truth: every `fable_plan` writes the verbatim Fable plan to `.fable/last-plan.md`. If Codex's Plan UI or response formatting conflicts with the tool output, treat `.fable/last-plan.md` as the canonical plan and show/read it verbatim.
- Normal mode: outside Plan mode, call Fable only when the user mentions Fable/Fable5/Feyble/フェイブル, asks for Fable-backed planning/review, or asks for a quality loop.
- Quality loop: for "合格まで回して", "N点まで仕上げて", "ループで", or "eval-loop", call `fable_plan` with `loop_threshold` (default 90), implement, then call `fable_review`. If the Stop hook continues the turn, read `.fable-loop/turns/*-eval.json`, fix only the feedback, and call `fable_review` again. Never edit `.fable-loop/state.json`, `criteria.md`, or `task.md` unless the user explicitly asks to abort the loop.
- Effort: "maxで", "じっくり", "deep" => pass `effort: "max"` or `"xhigh"`. "軽く", "quick", "サクッと" => pass `effort: "medium"`. If unspecified, do not pass effort and let the server default apply.
- Relay: Fable output is canonical. Present Fable plans, answers, and reviews verbatim. Any Codex commentary must be clearly separated after the Fable output.
- Continuation: pass the returned `session_id` when following up in the same Fable conversation.
- Latency: Fable may take several minutes. Wait unless the user cancels.
