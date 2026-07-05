# fable-mcp

[![CI](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml)

Use Claude Fable 5 as a read-only deep-reasoning architect and evaluator from Codex, Cursor, or Antigravity.

Japanese README: [README.md](README.md)

## Easiest Setup: One Sentence

For beginners, the easiest path is to paste this one sentence into the AI agent you want to use. You do not need to clone the repository manually or fill the custom MCP form yourself.

```text
Set up https://github.com/taiyuhiga/fable-mcp.
```

When an AI agent receives that sentence, it should treat this README plus `AGENTS.md` as the setup contract and configure only its own client. If Codex receives the request, configure Codex only. If Cursor receives it, configure Cursor only. If Antigravity receives it, configure Antigravity only.

1. Check that Node.js 18+ is installed
2. Install only the fable-mcp plugin/MCP config for the requesting client
3. Check whether Claude Code CLI (`claude`) exists as the Fable runtime, but do not install it unless the user explicitly asks
4. Ask me only when ANTHROPIC_API_KEY is needed
5. Leave me ready to ask: Check the Fable status

This repository ships a Codex Plugin, a Cursor Plugin, and an Antigravity Plugin. Setup is intentionally single-client: it does not fan out into other AI agents. Claude Code CLI is only the optional headless runtime used for Fable calls; it is not treated as another host agent to set up.

If you want to set up Codex from a terminal, use the command for your OS:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.8.0/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.8.0/install.ps1 | iex
```

The installer checks Node.js, Codex CLI, and the Claude Code CLI runtime, installs the Codex Plugin, and optionally writes the Anthropic API key into the Codex plugin override. It does not install Claude Code CLI unless you explicitly pass the runtime-install flag. Close the Codex desktop app before running it, then restart Codex when it finishes and ask `Check the Fable status`.

For Cursor or Antigravity manual setup:

```sh
git clone https://github.com/taiyuhiga/fable-mcp.git
cd fable-mcp
npm install
npm run build

# Configure Cursor only
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor

# Configure Antigravity only
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity
```

```
You -> Codex / Cursor / Antigravity (implementation agent)
          |
          | calls MCP tools when planning/review needs deeper reasoning
          v
      fable-mcp -> claude -p --model claude-fable-5 --permission-mode plan
                       |
                       | reads the repository and thinks through the design
                       v
                    plan/review back to host agent -> host agent implements
```

## What Happens On The Claude Code Side

fable-mcp does not make Fable 5 the implementation agent. Each Fable tool call starts a Claude Code headless process like this:

```sh
claude -p --model claude-fable-5 --permission-mode plan --output-format stream-json --verbose
```

- `--permission-mode plan` lets Fable read the local project for planning/review, but it cannot edit files.
- The host agent remains responsible for implementation, tests, commits, and releases.
- Tool calls are separate Claude Code processes. For follow-up brainstorming, pass the previous response's `session_id`; fable-mcp resumes the same Claude Code conversation with `--resume`.
- If `ANTHROPIC_API_KEY` is set, calls use Anthropic API metered billing. Otherwise they use the current `claude` CLI login/session if available.

## Setup

Configure only the client that received the setup request.

## Codex Plugin

Prerequisites:

- Node.js 18+
- Claude Code CLI runtime, optional until the first Fable call: `npm i -g @anthropic-ai/claude-code`
- Optional but recommended: an Anthropic API key with billing enabled

Install the pinned plugin release:

```sh
codex plugin marketplace add taiyuhiga/fable-mcp --ref v0.8.0
codex plugin add fable-mcp@fable-mcp
```

Restart the Codex app. If Codex asks whether to trust the bundled Stop hook, approve it.

For local development, clone the repo and use:

```sh
codex plugin marketplace add /ABSOLUTE/PATH/TO/fable-mcp
codex plugin add fable-mcp@fable-mcp
```

If you previously installed fable-mcp manually, remove the old manual entries after installing the plugin:

- `[mcp_servers.fable]` in `~/.codex/config.toml`
- `fable-loop-stop.mjs` in `~/.codex/hooks.json`
- older Fable routing rules pasted into `~/.codex/AGENTS.md`

Leaving them in place can double-register the MCP server or fire the Stop hook twice. `fable_status` reports these duplicate-registration risks locally.

## Cursor Plugin

Cursor plugin files live in `.cursor-plugin/marketplace.json` and `plugins/fable-mcp-cursor/`. If Cursor receives the GitHub setup request, it should run:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client cursor
```

The script copies the plugin to `~/.cursor/plugins/local/fable-mcp` and updates only Cursor's `~/.cursor/mcp.json` entry for `fable`.

## Antigravity Plugin

Antigravity plugin files live in `plugins/fable-mcp-antigravity/`. If Antigravity receives the GitHub setup request, it should run:

```sh
node scripts/run-python.mjs scripts/setup-current-agent.py --client antigravity
```

The script copies the plugin to `~/.gemini/config/plugins/fable-mcp` and rewrites only that plugin's `mcp_config.json`.

## API Key And Billing

You can pass the API key through your shell:

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
export FABLE_EFFORT="medium" # optional: low / medium / high / xhigh / max
```

Or through the Codex plugin MCP override:

```toml
[plugins."fable-mcp@fable-mcp".mcp_servers.fable.env]
ANTHROPIC_API_KEY = "sk-ant-..."
FABLE_EFFORT = "medium"
```

If `ANTHROPIC_API_KEY` is not set, the underlying `claude` CLI decides which logged-in session or subscription state to use.

## Verify The Install

In a new thread in the configured host agent, ask:

```text
Check the Fable status
```

The host agent should call `fable_status`. This is local-only and does not spend API credits.

Then test a real Fable call:

```text
Ask Fable5 what this repository does.
```

In Codex Plan mode, the plugin instructions tell Codex to call `fable_plan` unless the user explicitly asks to plan without Fable. In normal chat mode, Codex should only call Fable when the user mentions Fable/Fable5 or asks for a quality loop.

## Tools

| Tool | Purpose |
|---|---|
| `fable_status` | Local setup doctor: Claude Code CLI, auth/billing mode, effort, last saved Fable plan, quality-loop state. Does not call Fable. |
| `fable_plan` | Read-only Fable planning before implementation. Saves the verbatim plan to `.fable/last-plan.md`. Can initialize a criteria-approval quality loop with `loop_threshold`. |
| `fable_ask` | Fable-backed questions, tradeoff analysis, and brainstorming. |
| `fable_review` | Read-only implementation review. In quality-loop mode, records Fable's score, cumulative cost, and best snapshot into loop state. Supports optional ensemble scoring. |
| `fable_loop_approve` | Activates a quality loop in `implementing` phase after the user approves the generated criteria. Local-only and free. |
| `fable_loop_abort` | Safely aborts a quality loop without editing state files manually. Local-only and free. |
| `fable_loop_restore_best` | Restores the highest-scoring git snapshot, limited to recorded write targets or explicit paths. Local-only and free. |

`fable_plan`, `fable_ask`, and `fable_review` return a `session_id` footer. Pass it in the next call to continue the same Fable conversation.

## Quality Loop Notes

When `fable_plan` is called with `loop_threshold`, it creates a loop under `.fable-loop/sessions/<loop_id>/` and leaves it awaiting criteria approval by default. Codex should show the generated `criteria.md` to the user, then call `fable_loop_approve` before implementation/review starts. The old v0.6 `.fable-loop/state.json` layout is still read for compatibility.

The Stop hook is phase-gated: it continues or finishes a loop only when `phase="eval"`, after `fable_review` has written a fresh score. It stays silent right after criteria approval, but if implementation files changed and Codex tries to stop before calling `fable_review`, the hook blocks with a review-required message. This prevents a loop from silently dying after implementation.

During review, fable-mcp parses Fable's `<eval>{...}</eval>` score, records cumulative cost, captures git snapshots under `refs/fable-loop/<loop_id>/...`, and marks the best-scoring snapshot for optional restore. If a rate-limit event appears in Claude Code's stream, the progress message says that Fable is rate-limited instead of looking frozen. A UserPromptSubmit watchdog also warns locally about stale active loops and overlapping `write_targets`.

## Acceptance Smoke

Run the local, no-Fable smoke harness before releases:

```sh
npm run smoke
npm run codex-smoke
```

`npm run codex-smoke` uses an isolated `CODEX_HOME` to verify `marketplace add -> plugin add -> codex mcp list`. It skips automatically when the Codex CLI is not installed.

For a Codex live trial that still avoids Fable API spend:

```sh
npm run live-trial
npm run live-trial -- --allow-model-call
```

`--allow-model-call` asks Codex to call only `fable_status`. It does not call Fable, but it does use your Codex/OpenAI account. For a full release trial, use a new Codex thread and run `fable_plan -> show criteria -> fable_loop_approve -> implement -> fable_review -> Stop hook`. That full path calls Fable and can spend API credits.

## Environment Variables

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Use Anthropic API metered billing. If unset, use the current `claude` CLI auth/session. |
| `FABLE_MODEL` | `claude-fable-5` | Model passed to `claude -p`. |
| `FABLE_EFFORT` | model default, roughly high | Default reasoning effort: `low`, `medium`, `high`, `xhigh`, `max`. Prefer `medium` for low-cost testing and per-call `max`/`xhigh` for important design work. |
| `FABLE_MAX_TURNS` | `60` | Per-call exploration cap. `0` disables the cap. |
| `FABLE_TIMEOUT_MS` | `1200000` | Per-call timeout. |
| `FABLE_CLAUDE_BIN` | auto-detect | Full path to the `claude` CLI if auto-detection fails. |

## Cost Safety

- `fable_status` is free because it is local-only.
- Real Fable calls are metered when `ANTHROPIC_API_KEY` is set. A repository-aware planning call can cost around $1-5 depending on repository size and effort. Lightweight questions can be much cheaper.
- Start with `FABLE_EFFORT=medium`. Use `effort=max` or `effort=xhigh` only for work that actually needs it.
- `FABLE_MAX_TURNS=60` prevents one call from exploring indefinitely. If the cap is reached, continue with the returned `session_id`.
- Cancelling a tool call kills the underlying `claude` process, stopping further spend for that call.
- Check the response footer's `cost` value and Anthropic Console Usage for actual spend.

## Privacy And Security

Fable runs through Claude Code plan mode, so it is read-only with respect to your files. It can inspect the local project to produce plans and reviews, but it cannot create, edit, delete, or mutate files. Codex performs implementation.

Read-only does not mean "secret-blind." If secrets, `.env` files, customer data, private keys, or unreleased documents are readable from the project, Fable may read them if they look relevant. Move or exclude sensitive material before use.

When `ANTHROPIC_API_KEY` is used, prompts, relevant file contents, and model outputs are sent to Anthropic's API and handled under your Anthropic API data policy. Confirm your organization's retention and Zero Data Retention requirements before using this on sensitive repositories.

fable-mcp itself does not upload files directly or keep a remote copy. Local state is limited to `.fable/last-plan.md` and `.fable-loop/` quality-loop files.

## Manual MCP Fallback

If you cannot use the Codex plugin, clone the repository and register the MCP server manually:

```toml
[mcp_servers.fable]
command = "node"
args = ["/ABSOLUTE/PATH/TO/fable-mcp/server.mjs"]
startup_timeout_sec = 60
tool_timeout_sec = 1200

[mcp_servers.fable.env]
ANTHROPIC_API_KEY = "sk-ant-..."
FABLE_EFFORT = "medium"
```

Then add the routing instructions from `fable-session.md` or the Japanese README's AGENTS snippet to your global Codex instructions.
