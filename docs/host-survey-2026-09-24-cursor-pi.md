# Host survey: cursor-pi, 2026-09-24

Written by a research agent from current docs, repos and release data only (the AGENTS.md rule). Inferences are marked [I]/[inf]. The lead session verified the repo moves and star counts (anomalyco/opencode 210k, earendil-works/pi 109k, google-gemini/gemini-cli 107k). The Gemini CLI retirement is partly corroborated (an issue of 2026-06-19 about an antigravity.google link in its error message) but was not found on the Google developers blog front page.

# Host survey: Cursor and Pi, 2026-09-24

Sources are current docs, repos and package registries only. Neither `cursor`, `cursor-agent`/`agent` nor `pi` is installed here, so there is no CLI help. **[I]** marks an inference that no source states.

## 1. Pi

**Identity.** Pi is Mario Zechner's terminal agent. The repo moved: `gh repo view badlogic/pi-mono` now resolves to **github.com/earendil-works/pi** (MIT, 109,053 stars, pushed today). The npm package was renamed as well. `@mariozechner/pi-coding-agent` is deprecated with the message "use @earendil-works/pi-coding-agent". The new name was first published on 2026-05-07, and its latest version is **0.87.1 (2026-09-22)**. Releases are very frequent: 15 GitHub releases between 2026-07-21 and 2026-09-22, several of them weekly. Site: pi.dev. The other product called "Pi" (Inflection) is a consumer chatbot, not a coding harness. I found no other prominent coding harness called pi.

**MCP.** Pi has no MCP support built in. "mcp" does not appear anywhere in the coding-agent docs (grep of `packages/coding-agent/docs`, README, CHANGELOG). Pi is extended through **extensions**, which are in-process TypeScript modules, and through `pi.registerTool()`. The community package **pi-mcp-adapter** (nicobailon, 2.36.0, listed at pi.dev/packages/pi-mcp-adapter) exposes MCP servers through a single proxy `mcp` tool. For Room, a native extension is the better route. room-mcp is already TypeScript, and `createTools` can be wrapped as pi tools directly **[I]**.

- **(a) Instructions.** Pi loads `AGENTS.md`/`CLAUDE.md` context files (docs/configuration.md) and supports skills that load on demand. `pi --append-system-prompt`. The extension `before_agent_start` event can edit prompt sections. Extensions can call `pi.setActiveTools()` to show or hide tools; changes are recorded in the transcript (#9548).
- **(b) Packaging.** Pi packages install with `pi install npm:@x/y@1.0.0 | git:github.com/x/y@v1 | ./local`, or load for one run with `pi -e npm:…` (docs/packages.md). Project `.pi/extensions` goes through a **project-trust** prompt; user-level extensions do not. Unlike Codex, there are no hash-trusted hook definitions: an update is just a new package version.
- **(c) Hooks.** These are extension events (`pi.on`), not shell hooks. Full list from `src/core/extensions/types.ts`: `session_start`, `session_shutdown`, `project_trust`, `input`, `before_agent_start`, `agent_start`, `agent_before_settle`, `agent_settled`, `agent_end`, `turn_start`, `turn_end`, `message_start/update/end`, `context`, `context_with_system`, `tool_call` (can mutate the input or block), `tool_execution_start/update/end`, `tool_result` (can rewrite the result), `user_bash`, `model_select`, `thinking_level_select`, `session_compact`, `session_tree`, `provider_stream_event` (0.87.x), and others. Room's before-edit hook maps to `tool_call` on `edit`/`write`/`bash`, which could append a "someone is near this file" note to the result through `tool_result`. `turn_end`/`agent_before_settle` can request one continuation (0.87.0, 2026-09-21).
- **(d) Waking and mid-turn delivery.** This is the best of the four hosts. An extension runs in the Pi process. `pi.sendMessage(msg, { triggerTurn: true, deliverAs: "steer" | "followUp" | "nextTurn" })` and `pi.sendUserMessage(text, { deliverAs })` inject a message into a running or idle session. The shipped example `examples/extensions/file-trigger.ts` does exactly that: it watches a file and injects the contents with `triggerTurn: true`. Room's extension would open its inbox socket in `session_start`, as the docs require: no sockets in the factory. It would then deliver peer messages as `custom_message` entries, which carry no user authority. A steering message "enters after the current assistant turn" (docs/how-pi-works.md). No external client can attach to a running TUI session, so the extension is the only way in **[I]**.
- **(e) Headless workers.**
  - Run: `pi -p "…"` for the final text, or `pi --mode json "…"` for JSONL events. The first record is `{"type":"session","id":…}`.
  - Stdio protocol: `--mode rpc` takes JSONL commands (`prompt` with `streamingBehavior`, `steer`, `follow_up`, `abort`, `get_state` → `sessionId`, `set_model`).
  - SDK: an in-process TypeScript SDK (docs/sdk.md).
  - Model and effort: `--model <pattern>`, `--thinking off…max`.
  - Resume: fix the id with `--session-id <id>`, then continue with `--session <id>`.
  - Tools and loading: `--tools`/`--exclude-tools`, `-e <ext>`, `--no-extensions`.
  - **No worktree flag**: Room sets the worktree as `cwd`. **No sandbox or approvals**: "does not ask for approval before every tool call" (docs/security.md). Isolation comes from a container, or from the example `sandbox` extension, which wraps `bash` with `@anthropic-ai/sandbox-runtime`.
- **(f) Session id and model.** `ctx.sessionManager.getSessionId()`, `getSessionFile()`, `ctx.model`, plus the `model_select` event. All exact; nothing to guess.

**Easier than CC/Codex.** Waking and steering work in-process with no preview flags. Tools are native TypeScript with no MCP hop. Updates carry no frozen-hook problem. The licence is MIT. **Harder:** Room must maintain a second tool-registration path (pi tools rather than MCP). Pi has no permission system, so a worker is unsandboxed unless Room ships the sandbox wrapper. Pi is multi-provider, so worker model names vary by user. The API churns (breaking changes in 0.87.0), so the extension needs a version pin.

## 2. Cursor (editor agent + CLI `agent`)

Cursor is proprietary: `cursor/cursor` has no licence and is an issue tracker with 33,251 stars. It has a very large commercial user base. CLI releases come every 2–3 weeks (changelog: 2026-07-13, 07-20, 08-11, 08-26). `@cursor/sdk` ships weekly: 1.0.31 on 2026-09-03, 1.0.32 on 2026-09-22.

- **(a) Instructions.** Project rules in `.cursor/rules/*.mdc` (with `alwaysApply`/globs), `AGENTS.md` at the root, and skills (docs/rules.md). MCP supports stdio servers, prompts, resources, roots and elicitation (docs/mcp.md). The docs do not say whether the MCP `instructions` field is honoured, so Room should put its rules in a plugin rule **[I]**.
- **(b) Packaging.** **Cursor Plugins** (`.cursor-plugin/plugin.json`) bundle rules, skills, agents, commands, MCP servers and hooks. `${CURSOR_PLUGIN_ROOT}` is available in `mcp.json`. Cursor also loads the open **Agent Plugins** standard (root `plugin.json`, skills + MCP only) (docs/plugins.md, docs/reference/plugins.md). Plugins are distributed through the Marketplace (manually reviewed, submitted at cursor.com/marketplace/publish) or a team marketplace (Teams/Enterprise). The CLI has `--plugin-dir <path>`. **Plugin hooks run in the CLI only since the 2026-08-11 CLI release.** A third manifest could live beside Room's two existing ones in `plugins/room/` **[I]**.
- **(c) Hooks** (`hooks.json`, docs/hooks.md). The agent hooks are `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart/Stop`, `beforeShellExecution`/`afterShellExecution`, `beforeMCPExecution`/`afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `stop`, and `preCompact`. The Tab hooks are `beforeTabFileRead`/`afterTabFileEdit`, and the app hook is `workspaceOpen`. **What matters for Room:**
  - `sessionStart` is fire-and-forget and returns `additional_context` and `env`. It does not run in cloud agents.
  - `preToolUse` returns only `allow`/`deny` plus `agent_message` **on deny**, and `updated_input`. It **cannot add context to an allowed edit**.
  - `postToolUse` and `postToolUseFailure` return `additional_context`, which is injected after the tool result.

  So the near-file warning has to come **after** the edit through `postToolUse`, or be a deny-with-message when the file is claimed. That is weaker than Claude Code's before-edit context.
- **(d) Waking and mid-turn delivery.** **There is no documented way for an outside process to post into a human's running IDE or CLI session.** The partial substitutes:
  - `postToolUse` `additional_context` delivers at tool boundaries, but only while the agent is working.
  - A `stop` hook `followup_message` auto-continues at the end of a turn, up to `loop_limit` times (default 5). It can drain the inbox once the agent finishes, but cannot wake a session that is already idle.

  Sessions that Room itself owns *can* be steered:
  - The SDK's `run.steer(text)` (1.0.31, 2026-09-03; TypeScript **local** runs only).
  - `agent acp` (JSON-RPC over stdio: `session/new`, `session/load`, `session/prompt`, `session/cancel`).
  - Cloud Agents API follow-up runs (`POST /v1/agents/{id}/runs`).
  - `agent persist` + `attach` (2026-08-26) keeps a CLI session alive, but no injection API is documented for it.
- **(e) Headless workers.** The CLI (docs/cli/reference/parameters):
  - Run: `agent -p "…" --output-format stream-json`. Records include `session_id` and the model.
  - Model: `--model` (effort is part of the model variant or `model_params`).
  - Worktree: `-w/--worktree [name]` with `--worktree-base`, created under `~/.cursor/worktrees/<repo>/<name>`.
  - Sandbox and approvals: `--sandbox enabled|disabled`; on 2026-08-11 the sandbox gained a read boundary and SOCKS for git over SSH. `--force`, `--trust`, `--approve-mcps`.
  - Resume: `--resume [chatId]`.
  - Headless runs wait for their subagents (2026-08-11).

  The SDK adds `Agent.create({ local: { cwd, sandboxOptions } })`, `Agent.resume`, `customTools`, `tools`/`disallowedTools` and a structured error. All inference runs on Cursor's hosted models and is billed to the user's Cursor plan or API key.
- **(f) Session id and model.** Every hook receives `conversation_id`, `generation_id`, `model`, `model_id`, `model_params` (thinking/effort/context) and `transcript_path`. `sessionStart` also gets `session_id` (the same value as `conversation_id`) and `is_background_agent`. The docs do not say whether the MCP server process gets a session id in its environment. A `sessionStart` hook can write it for the server, as Room already does **[I]**.

**Easier:** the MCP server, skills and plugin layout port almost directly, and the worker CLI flags are the richest of any host, with a native worktree flag. **Harder:** idle waking, the before-edit context gap, a closed source base, marketplace review, and paid-plan testing. Two surfaces (IDE and CLI) have historically diverged: plugin hooks reached the CLI only on 2026-08-11.

## Integration cost and verdict

| | Minimum | Full parity | Impossible today | Effort |
|---|---|---|---|---|
| **Pi** | A pi package: one extension that registers Room's tools natively (or pi-mcp-adapter as a stopgap), a skill, a `session_start` status line, and a socket that delivers the inbox through `sendMessage` with `deliverAs` | Plus near-file context through `tool_call`/`tool_result`; a `pi` worker host in `workers.ts` (`--mode json --session-id`, resume with `--session`, `--model`/`--thinking`, worktree cwd), shipped with the sandbox extension; exact session id and model | Nothing structural. Sandboxing is Room's job, not Pi's | Minimum 1.5–2 days; full 4–5 |
| **Cursor** | A Cursor plugin: `mcp.json` with the same server, rules/skill, `sessionStart` context, `postToolUse` near-file and inbox context, and a `stop` follow-up to drain the inbox | Plus a `cursor` worker host (`agent -p --output-format stream-json --worktree --sandbox enabled --resume`), or the SDK with `run.steer` for workers; marketplace listing | **Waking an idle human session**; **context before an allowed edit**; mid-turn delivery outside tool boundaries | Minimum 2 days; full 5–6 (plus marketplace review time) |

**Verdicts.**
- **Pi: worth it now.** It is cheap and TypeScript-native. It has the cleanest wake and steer path of any host, which is exactly the part Room fights for on CC and Codex. MIT, huge momentum (109k stars, near-weekly releases). Pin the version because the extension API churns.
- **Cursor: later, minimum only at first.** It has the biggest audience, and the worker CLI is excellent. But the core "a peer's message reaches your agent" promise degrades to "at the next tool call or end of turn", and nothing can wake an idle session. Ship the plugin and the `cursor` worker host once Room's no-wake mode is proven. Revisit parity if Cursor documents an injection API for `agent persist` or the IDE (inferred to be the likely next step, given SDK `run.steer`).
