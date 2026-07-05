# fable-mcp

[![CI](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/taiyuhiga/fable-mcp/actions/workflows/ci.yml)

Use Claude Fable 5 as a read-only deep-reasoning architect and evaluator from OpenAI Codex.

Japanese README: [README.md](README.md)

## Easiest Setup: Paste The GitHub URL Into Codex

For beginners, the easiest path is to paste this into Codex. You do not need to clone the repository or manually fill the custom MCP form.

```text
Set up https://github.com/taiyuhiga/fable-mcp.

Follow the beginner setup in the README and do the whole setup:
1. Check that Node.js 18+ is installed
2. Install Claude Code CLI with npm i -g @anthropic-ai/claude-code if it is missing
3. Install the fable-mcp Codex Plugin
4. Ask me only when ANTHROPIC_API_KEY is needed
5. Verify that fable appears in codex mcp list
6. Leave me ready to ask: Check the Fable status
```

If you prefer a terminal one-liner, use the command for your OS:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.6.2/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/taiyuhiga/fable-mcp/v0.6.2/install.ps1 | iex
```

The installer checks Node.js, Codex CLI, and Claude Code CLI, installs the Codex Plugin, and optionally writes the Anthropic API key into the Codex plugin override. Restart Codex when it finishes, then ask `Check the Fable status`.

```
You -> Codex app (implementation agent)
          |
          | calls MCP tools when planning/review needs deeper reasoning
          v
      fable-mcp -> claude -p --model claude-fable-5 --permission-mode plan
                       |
                       | reads the repository and thinks through the design
                       v
                    plan/review back to Codex -> Codex implements
```

## What Happens On The Claude Code Side

fable-mcp does not make Fable 5 the implementation agent. Each Fable tool call starts a Claude Code headless process like this:

```sh
claude -p --model claude-fable-5 --permission-mode plan --output-format stream-json --verbose
```

- `--permission-mode plan` lets Fable read the local project for planning/review, but it cannot edit files.
- Codex remains responsible for implementation, tests, commits, and releases.
- Tool calls are separate Claude Code processes. For follow-up brainstorming, pass the previous response's `session_id`; fable-mcp resumes the same Claude Code conversation with `--resume`.
- If `ANTHROPIC_API_KEY` is set, calls use Anthropic API metered billing. Otherwise they use the current `claude` CLI login/session if available.

## Recommended Setup: Codex Plugin

Prerequisites:

- Node.js 18+
- Claude Code CLI: `npm i -g @anthropic-ai/claude-code`
- Optional but recommended: an Anthropic API key with billing enabled

Install the pinned plugin release:

```sh
codex plugin marketplace add taiyuhiga/fable-mcp --ref v0.6.2
codex plugin add fable-mcp@fable-mcp
```

Restart the Codex app. If Codex asks whether to trust the bundled Stop hook, approve it.

For local development, clone the repo and use:

```sh
codex plugin marketplace add /ABSOLUTE/PATH/TO/fable-mcp
codex plugin add fable-mcp@fable-mcp
```

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

In a new Codex thread, ask:

```text
Check the Fable status
```

Codex should call `fable_status`. This is local-only and does not spend API credits.

Then test a real Fable call:

```text
Ask Fable5 what this repository does.
```

In Codex Plan mode, the plugin instructions tell Codex to call `fable_plan` unless the user explicitly asks to plan without Fable. In normal chat mode, Codex should only call Fable when the user mentions Fable/Fable5 or asks for a quality loop.

## Tools

| Tool | Purpose |
|---|---|
| `fable_status` | Local setup doctor: Claude Code CLI, auth/billing mode, effort, last saved Fable plan, quality-loop state. Does not call Fable. |
| `fable_plan` | Read-only Fable planning before implementation. Saves the verbatim plan to `.fable/last-plan.md`. Can initialize a quality loop with `loop_threshold`. |
| `fable_ask` | Fable-backed questions, tradeoff analysis, and brainstorming. |
| `fable_review` | Read-only implementation review. In quality-loop mode, records Fable's score into `.fable-loop/state.json`. |

`fable_plan`, `fable_ask`, and `fable_review` return a `session_id` footer. Pass it in the next call to continue the same Fable conversation.

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
