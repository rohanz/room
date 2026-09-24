# Host survey: gemini-opencode, 2026-09-24

Written by a research agent from current docs, repos and release data only (the AGENTS.md rule). Inferences are marked [I]/[inf]. The lead session verified the repo moves and star counts (anomalyco/opencode 210k, earendil-works/pi 109k, google-gemini/gemini-cli 107k). The Gemini CLI retirement is partly corroborated (an issue of 2026-06-19 about an antigravity.google link in its error message) but was not found on the Google developers blog front page.

# Host survey: Gemini CLI and OpenCode, 2026-09-24

This survey uses only current docs, source and release data. Neither CLI is installed here (`which gemini opencode` found nothing), so no claim comes from `--help`. Sources: shallow clones of google-gemini/gemini-cli (main, docs/ at v0.61.0) and anomalyco/opencode (dev, 2026-09-24; `sst/opencode` now redirects there), `gh` repo and release data, and the Google Developers Blog. **[I]** marks my own inference.

## 1. Gemini CLI

**Status: Google is winding it down.** On 2026-05-19 (I/O) Google announced that Gemini CLI would be replaced by **Antigravity CLI** (`agy`, written in Go). On **2026-06-18**, Gemini CLI stopped serving requests for consumers (AI Pro/Ultra and the free tier). It still works with paid Gemini API or Enterprise keys. Source: https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/. The repo still ships releases: stable v0.61.0 came out on 2026-09-23 and nightlies are daily. Recent releases are almost all security hardening, with 50 commits in the last 30 days.

- **Adoption:** 107k stars, 14.6k forks, about 700 contributors. Apache-2.0.

**(a) Instructions.** Gemini CLI puts MCP `instructions` into the system prompt ("instructions provided by the tool server…", `mcp-client-manager.ts#getMcpInstructions`). Context files are `GEMINI.md`, and an extension can rename them with `contextFileName`. Skills live in `skills/<name>/SKILL.md` (Agent Skills since v0.24.0, 2026-01-14).

**(b) Packaging.** `gemini extensions install <git-url|path> [--ref] [--auto-update]`. The manifest is `gemini-extension.json`. It holds `mcpServers`, `contextFileName` and `settings`, with env vars prompted at install. Extensions can also bundle `hooks/hooks.json`, `skills/` and `agents/` (docs/extensions/reference.md). This maps one to one onto Room's Claude plugin layout.

**(c) Hooks.** Hooks are shell commands that take JSON on stdin and return JSON on stdout. The events are:
- `SessionStart`, `SessionEnd`
- `BeforeAgent`, `AfterAgent`
- `BeforeModel`, `AfterModel`, `BeforeToolSelection`
- `BeforeTool`, `AfterTool`
- `PreCompress`, `Notification`

Every hook receives `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `timestamp` (docs/hooks/reference.md). The mapping to Room:
- `SessionStart` accepts `additionalContext`.
- **`BeforeTool` cannot add context.** It can only deny, rewrite arguments or stop. The "someone is near this file" note therefore has to go through `AfterTool`, which appends `additionalContext` to the tool result, or through a deny whose reason goes to the model.
- MCP tools match on `mcp_<server>_<tool>`.
- The changelog shows hook UI by v0.24.0. The first hooks release is not stated.

**(d) Wake and mid-turn delivery.** No documented way exists for an outside process to post into a running interactive session. Three partial routes exist:
- `AfterAgent` with `decision:"deny"` makes the model retry, and `reason` arrives as a new prompt. That can deliver a pending room message **at the end of a turn** [I], but it cannot wake an idle session.
- Model steering (experimental, `experimental.modelSteering`, v0.32.0, 2026-03-03) only handles text the user types.
- `--acp` (JSON-RPC over stdio) and `packages/a2a-server` ("experimental") would let Room *host* its own session, as roomagent does, but they cannot attach to a person's TUI.

Waking an idle session is therefore **impossible without a terminal hack** (tmux `send-keys`) [I].

**(e) Workers.** The worker command would be:

```
gemini -p "<brief>" -m <model> -o stream-json --approval-mode yolo -s -w <name>
```

- `stream-json` emits an `init` event carrying the session id and model, then `result`.
- `-s` turns on the sandbox (Seatbelt or container).
- `-w` creates a worktree under `.gemini/worktrees/` and needs `experimental.worktrees` [I: Room would pass its own `--include-directories`/cwd instead].
- There is **no effort flag**, only model aliases.
- Resume is `gemini -r <session-id> "<follow-up>"`, which works headless.
- Exit codes: 0, 1, 42 (input), 53 (turn limit).

**(f) Session id and model.** The session id reaches every hook. The model appears in `BeforeModel`'s `llm_request.model` and in the `init` event of stream-json. MCP servers get only `GEMINI_CLI=1` in their environment (`mcp-client.ts`). The session id is not passed to MCP servers, so a hook has to relay it, as Room does on Codex.

**Easier or harder than Claude Code and Codex.** Hooks, extensions and resume are closest to Claude Code, which makes Gemini CLI the cheapest port on paper. The problems:
- It has no wake mechanism.
- It has no before-edit context injection.
- The product is being retired for most users. The real target is Antigravity CLI. Third-party guides say its `plugin.json` bundles skills, agents, rules, `hooks.json` and `mcp_config.json`, with `PreToolUse` hooks and `agy -p --output-format json`. These are not verified against official docs. Antigravity CLI would need its own survey from antigravity.google/docs.

## 2. OpenCode

- **Adoption:** 210k stars, 27.7k forks, about 1,000 contributors. MIT licence.
- **Momentum:** 263 commits in 30 days. Releases arrive every 3–7 days (v1.18.21 to v1.18.32 between 2026-08-21 and 2026-09-21).
- **Architecture:** a client/server design. The TUI runs on top of a local HTTP server with an OpenAPI 3.1 spec, and there is a JS SDK (`@opencode-ai/sdk`).

**(a) Instructions.** OpenCode puts MCP `instructions` into the system prompt inside `<mcp_instructions>` (`session/system.ts`). It reads `AGENTS.md` and falls back to `CLAUDE.md`, including `~/.claude/CLAUDE.md`. It loads skills from `.claude/skills/`, `.agents/skills/` and its own directories. Room's existing Claude skills would load unchanged [I, same SKILL.md format].

**(b) Packaging.** It has no bundle format like Claude plugins or Gemini extensions. The options are an npm plugin listed in `opencode.json` (`"plugin": ["@room/opencode"]`, installed by Bun at startup) or files in `.opencode/plugins/`. MCP servers go under `mcp` in `opencode.json`. A plugin's `config` hook receives the config, so it may be able to register the MCP server itself [I, not documented]. The fallback is a one-line `opencode.json` edit.

**(c) Hooks.** Hooks are **in-process JS/TS functions**, not shell commands (`packages/plugin/src/index.ts`):
- `event` receives every bus event: `session.created`, `session.idle`, `session.status`, `session.diff`, `file.edited`, `message.*`, `permission.*`, `tool.*`, `tui.*`, and more.
- `chat.message`
- `chat.params`
- `chat.headers`
- `permission.ask`
- `command.execute.before`
- `tool.execute.before`, which gets `tool`, `sessionID`, `callID` and mutable `args`
- `tool.execute.after`, which can rewrite `output`
- `shell.env`
- `tool.definition`
- `experimental.chat.system.transform`, which gets `sessionID` and `model` and a mutable `system[]`
- `experimental.chat.messages.transform`
- `experimental.session.compacting`

Like Gemini's `BeforeTool`, `tool.execute.before` cannot inject text; it can only throw or rewrite arguments. There are better paths:
- **`experimental.chat.system.transform` runs before every model call**, so Room could put "someone is near X" and inbox lines into each step of a turn.
- `tool.execute.after` can append to a tool's output.

This is finer-grained than any hook on Claude Code or Codex. It is marked experimental.

**(d) Wake and mid-turn delivery. This is the best of the four hosts.**
- The plugin receives `client`, an SDK client already bound to the running server, plus `serverUrl`. Calling `client.session.promptAsync({ sessionID, parts })`, which is `POST /session/:id/prompt_async` and returns 204, **wakes an idle session with no TUI hack**.
- An external process can do the same when the TUI runs with a fixed `--port`.
- `/tui/append-prompt` plus `/tui/submit-prompt` drive the visible TUI.
- `GET /event` (SSE) streams `session.idle` and `session.status`.
- `noReply: true` stores a message without starting a turn.

A prompt sent to a busy session joins the running loop (`SessionRunState.ensureRunning` returns the existing runner) [I, from source, not docs]. Through `system.transform`, mid-turn delivery is supported directly.

**(e) Workers.** The worker command would be:

```
opencode run "<brief>" -m provider/model --variant high --format json --auto --dir <worktree> --title <name>
```

- `--variant` is the reasoning effort.
- `--format json` prints raw JSON events.
- Resume is `opencode run -s <id> "<follow-up>"`, with `--fork` available.
- Workers can also be sessions on one `opencode serve`, driven over HTTP with the SDK (`session.create` and `session.prompt`), which gives structured output and abort (`/session/:id/abort`).

What is missing:
- **No OS sandbox.** Only permission rules (allow, ask or deny per tool and path, plus `external_directory`); sandboxes come from third-party plugins such as opencode-daytona.
- **No built-in worktree flag.** Room already creates worktrees itself.

The upside is that a worker can bind sockets and write `.git`, which Codex's sandbox cannot [I].

**(f) Session id and model.** Every hook receives `sessionID`. `chat.message`, `chat.params` and `system.transform` receive the model. The plugin runs in-process, so no env-var relay is needed. The MCP server would still get the id from the plugin [I, via a shared file or a room tool argument].

**Easier or harder.** OpenCode is easier on wake, mid-turn delivery, session id and resume. It is harder in three ways:
- The glue is a TS plugin, not frozen shell hooks, so the hook scripts would need rewriting. There is no content-hash trust issue, though.
- Workers have no sandbox.
- It runs any provider's model, so instruction-following varies. Sessions on weak models will follow room etiquette less well [I].

## Minimum integration (MCP + context file, messages on next tool call)

Both hosts need the same three steps:
1. Register `plugins/room/server` as a stdio MCP server.
2. Rely on MCP `instructions`, which both read, and ship the SKILL.md files.
3. Deliver messages by appending them to room_* tool results, as Room already does.

Per host:
- **Gemini:** a `gemini-extension.json` gives a one-command install. About **0.5 day**.
- **OpenCode:** an `opencode.json` snippet plus the `.claude/skills` it already reads. About **0.5 day**.

Host detection in `config.ts`/`session.ts` and a README section add about 0.5 day each.

## Full parity (hooks + wake + workers)

**OpenCode: feasible today.**
- Write an `@room/opencode` plugin:
  - SessionStart on `event: session.created`.
  - Nearby-file and inbox context through `system.transform` or `tool.execute.after`.
  - Wake through `client.session.promptAsync` on room messages, gated on `session.idle`.
- Add a `host: 'opencode'` worker backend in `workers.ts` using `opencode run --format json` and `-s` resume.
- Estimate: **4–6 days**, with eval runs.
- Risk: the `experimental.*` hooks may change. Fallback: `tool.execute.after`.

**Gemini CLI: partial only.**
- Feasible: SessionStart context, `AfterTool` context, `AfterAgent` end-of-turn delivery, and the worker backend (`-p -o stream-json -s`, `-r` resume). About **3–4 days**.
- **Impossible today:** waking an idle interactive session, and context before an edit (only a deny or context after the edit).

## Verdict

- **OpenCode: worth it now** (after the current release work). It has the largest and fastest-moving community of the four hosts, an MIT licence, and a supported API for waking and steering a live session, which Room had to work around on both existing hosts. It already reads `CLAUDE.md` and `.claude/skills`, and the plugin gives exact session and model ids. Do the minimum first to prove routing, then the plugin.
- **Gemini CLI: no.** Consumers lost access on 2026-06-18, it cannot be woken, and new work there is maintenance. Survey **Antigravity CLI** instead ("later"): its plugin, hook and headless shape reportedly carries the Gemini extension model forward, but it is unverified here and may not be open source.
