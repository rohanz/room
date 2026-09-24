# Host feature survey: claude-code, 2026-09-24

Written by a research agent from current documentation, changelogs and CLI help only (the AGENTS.md rule). Items marked [I] or [inferred] are the agent's inference. The lead session verified: claude --effort/--name/--max-budget-usd, claude plugin eval, CLAUDE_CODE_SESSION_ID in the MCP server environment, codex exec resume and exec --json.

# Claude Code host survey for Room (2026-09-24)

Installed: Claude Code 2.1.281 (npm 2026-09-23). Sources: code.claude.com/docs/llms.txt and the pages below, CHANGELOG.md, `npm view` dates. [I] marks an inference I did not read in the docs.

## Ranked by value to Room

**1. Cross-session messaging inbox socket.** Replaces channel wake-ups on Claude. 2.1.224 (2026-08-07); token 2.1.228; Bedrock/Vertex/Foundry and telemetry-off 2.1.248 (2026-08-27); `-p` sender notices 2.1.271. https://code.claude.com/docs/en/cross-session-messaging
- What it is: every session binds a per-session Unix socket (a named pipe on Windows). Messages written to it are delivered between tool calls, or start a new turn when the session is idle.
- Env vars: `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are exported to hooks and Bash "before any hook runs, including SessionStart". The docs name only hooks and Bash. For MCP servers they list only `CLAUDE_CODE_SESSION_ID`, so the SessionStart script should write the socket path into Room's per-session state file.
- Delivery rules: if no `crossSessionInbound` value is set, messages the session's own child processes send are delivered. The check uses process evidence, or on macOS the token auth line once the poster has exited. Sessions running with bypassed permissions hold unverified messages for approval.
- Headless workers: `claude -p` workers bind a socket too, but need `--settings '{"crossSessionInbound":"accept"}'` to take messages unattended. `--bare` does not bind one.
- Limits: at most 50 messages queued, per-sender rate limit, drops identical repeats, about 1M characters per message, and the connection closes if no complete line arrives within 30 s.
- Benefit: no research-preview flag, no confirmation prompt, no `claude-room` alias. Works on Bedrock, Vertex and Foundry, where channels do not.
- Risks: the docs cover only the auth line. The message line format is undocumented [I], so pin it with a version-gated test. Codex needs its own path.
- Recommendation: **Adopt now**, finishing the batch in progress.

**2. Plugin monitors.** Another flagless way to wake a session. 2.1.105 (2026-04-13); schema moved under `experimental.monitors` in 2.1.129. https://code.claude.com/docs/en/plugins-reference#monitors
- What it is: `monitors/monitors.json` starts a command for the whole session and sends each stdout line to Claude.
- Why it fits: it is a new component, so the frozen hook files do not change. A monitor that tails Room's per-session wake file would cover versions and hosts where the socket is missing.
- Risks: experimental schema. Interactive CLI only. Not available on Bedrock/Vertex/Foundry or with `DISABLE_TELEMETRY`. Every line costs a turn. Waking an idle session is inferred [I] from "Claude interjects" and changelog 2.0.64.
- Recommendation: **Try**, as a fallback to #1.

**3. `claude plugin eval`.** Complements Room's tool-description routing checks. 2.1.269 (2026-09-11). https://code.claude.com/docs/en/plugins-reference#plugin-eval
- What it is: runs scored test cases, by default with and without the plugin.
- Benefit: replaces the manual "human-phrasing check" in AGENTS.md (for example "get codex to do half" must reach `room_spawn`) with a suite you can rerun in CI.
- Risks: every run makes real model calls. Claude only.
- Recommendation: **Adopt now**.

**4. Session and model facts provided by the host.** Replaces most of the transcript scraping. https://code.claude.com/docs/en/hooks#common-input-fields and https://code.claude.com/docs/en/env-vars
- `CLAUDE_CODE_SESSION_ID` is in stdio MCP server env (2.1.154, 2026-05-28). Room does not read it today. It removes the guesswork of matching the MCP process to a hook-written session file. Caveat: the MCP process keeps its spawn-time ID across `/clear`.
- Hook input carries `effort.level` on every event, and `model` on SessionStart "not always".
- `PostModelSwitch` (2.1.251, 2026-08-28) reports model changes. Using it means adding a hook, so see #5.
- The docs say the transcript file "is written asynchronously and may lag".
- Recommendation: **Adopt now** for the session ID and effort. Keep the transcript tail only as the fallback for a `/model` change.

**5. Hooks in skill frontmatter, `asyncRewake`, and `mcp_tool` hooks.** Complements Room's hooks without touching the frozen files. https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents
- Skill hooks (2.1.0): a skill such as room-etiquette can register Stop, SessionEnd or PostModelSwitch hooks for the rest of the session once it loads.
  - Stop could run a merge preview before finishing.
  - SessionEnd could release claims on exit.
  - The frozen `hooks/claude.json` stays untouched.
- `asyncRewake: true` wakes an idle session when the hook exits with code 2. The timeout still applies. The changelog does not say which version added it.
- `type: "mcp_tool"` hooks (2.1.118) call a Room tool directly instead of starting `node`. They are skipped on launch-time SessionStart.
- Risks: Codex ignores all of this [I], so Room keeps its own paths there.
- Recommendation: **Try.**

**6. Worker CLI flags.** Complements `room_spawn`. https://code.claude.com/docs/en/cli-reference
- `--effort` exists (low to max). workers.ts passes effort inside the prompt with the comment "no unverified host flag"; the flag is now documented.
- `--name` and `--session-id` make workers visible in `ListAgents` and let leads message them.
- `--max-budget-usd` caps spend.
- `--output-format stream-json --input-format stream-json` allows steering a worker while it runs.
- Workers get `--dangerously-load-development-channels` even though they run with `-p`. Drop it once #1 lands.
- Recommendation: **Adopt now** for effort, name and budget. **Try** stream-json.

**7. MCP client features.** Complements room-mcp. https://code.claude.com/docs/en/mcp
- Automatic backgrounding (2.1.212, 2026-07-16):
  - A main-session tool call still running after 2 minutes becomes a background task, and its result arrives as a notification.
  - A long `room_wait` therefore stops blocking the session. It may also wake the session when the result arrives [I].
  - The stdio idle timeout is 30 minutes unless the server sends progress notifications.
- Tool search defers Room's tools, as seen in this session. `_meta["anthropic/alwaysLoad"]` (2.1.121) can keep `room_state` and `room_send` loaded upfront. Tool descriptions and server instructions are cut at 2,048 characters.
- `_meta["anthropic/requiresUserInteraction"]` (2.1.199) always prompts for `room_close` and `room_create`.
- Elicitation, including URL mode (2.1.281), could handle confirm-before-act and GitHub device login.
- Recommendation: **Adopt now** for requiresUserInteraction and alwaysLoad on 2 or 3 tools. **Try** elicitation.

**8. `userConfig` in the plugin manifest.** Complements `ROOM_SERVER`, `room_join` and remembered config. 2.1.83 (2026-03-24). https://code.claude.com/docs/en/plugins-reference#user-configuration
- What it is: Claude Code prompts for values such as the server URL when the plugin is enabled.
- Benefit: fewer environment variables.
- Recommendation: **Try.**

**9. Agent view and `claude --bg`.** Could inform or complement workers. 2.1.139 (2026-05-11), research preview. https://code.claude.com/docs/en/agent-view
- What it is: supervised background sessions that a human can attach to, with `claude agents --json` as the supported way to read their state.
- Conflicts with Room:
  - Background sessions move into `.claude/worktrees/` before their first edit.
  - They commit and push unless CLAUDE.md or memory says otherwise.
- **Risk to act on now [I]:** if a human backgrounds a Room session with `←`/`/background`, its edits land in `.claude/worktrees/…`, which roomd does not watch, so the edits are invisible to the room. Detect this, or document `worktree.bgIsolation: "none"`.
- Recommendation: **Watch** as a way to run workers. **Handle the isolation risk now.**

**10. `.worktreeinclude`.** Overlaps with `.roomlinks`. https://code.claude.com/docs/en/worktrees
- What it is: gitignored files copied into worktrees Claude Code creates.
- Benefit: users would write one file for both.
- Recommendation: **Try** reading it as a default for `.roomlinks`.

**11. Agent teams, dynamic workflows, Projects, Remote Control, routines and cloud sessions.**
- Agent teams: experimental, behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, no worktree isolation.
- Dynamic workflows (2.1.154): Claude subagents only.
- Projects: cloud only, beta.
- Remote Control and cross-machine `SendMessage`: reach only the same account's own sessions, never another person's.
- Every one of these is Claude-only and single-user, so none replaces Room's shared room across people and Codex.
- Recommendation: **No / watch.**

## Room should stop doing (Claude side)

- Channel wake-ups, the `claude-room` alias and the flag explanation in README and onboarding, once #1 is proven. Keep channels only as an opt-in.
- Adding `--dangerously-load-development-channels` to `claude -p` worker spawns.
- Passing effort through the prompt. Use `--effort`.
- Tail-parsing the transcript for session identity. Use `CLAUDE_CODE_SESSION_ID` and the hook fields.
- The manual phrasing check. Use `claude plugin eval`.

## Deprecated, changing, or at risk

- **Channels are still a research preview.** The docs say the "flag syntax and protocol contract may change". Channels need claude.ai or Console authentication, are unavailable on Bedrock/Vertex/Foundry, and Team/Enterprise organisations must enable them. Since 2.1.281, `--channels` plugin entries must also match the plugin name.
- **MCP v2 runtime.**
  - It is the default wherever feature flags are fetched (2.1.232), and elsewhere since 2.1.274.
  - A channel server that negotiates protocol 2026-07-28 is not registered as a channel.
  - Upgrading room-mcp to MCP SDK 2.x or setting `MCP_PROTOCOL_NEGOTIATION=auto` would silently break channel wake-ups.
- **Before-edit matcher.**
  - `MultiEdit` does not appear anywhere in the current tools reference or hooks reference, so it is probably gone [I]. The matcher entry is dead but harmless.
  - The docs say to match `Bash|PowerShell` for shell commands. Room's matcher misses PowerShell (Windows) and Monitor commands.
- **Transcript files lag the conversation.** `~/.claude/jobs/*` "is not a stable interface".
- **`bypassPermissions` in project `.claude/settings.json` is ignored since week 36.**
- **Question to verify [I]:** Claude Code does not hash-trust plugin hooks; its docs describe only workspace trust. The freeze on `hooks/claude.json` may be needed only if Codex also reads that file.
