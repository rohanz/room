# Codex host snapshot, 2026-11-05

Taken before the local-plumbing implementation batches (CLAUDE.md: read current host docs, not memory).
Installed: codex-cli 0.166.0 (released 2026-10-29; 0.167 and 0.168 exist only as alphas). Docs moved from
developers.openai.com/codex to learn.chatgpt.com/docs (308 redirects); the CHANGELOG.md in the repo holds only
an Unreleased stub, the release notes live on GitHub releases.

## Findings that change our designs

1. **MCP connection sharing across chats exists and is off.** 0.166.0 "Share eligible local stdio MCP
   connections across chats" (#57211) and "Isolate MCP inputs and timeouts for callers sharing a connection"
   (#57196). Gate: `[features] mcp_connection_sharing` (codex-rs/features/src/lib.rs: `Stage::UnderDevelopment`,
   `default_enabled: false`) and the server negotiating MCP protocol `2026-07-28` (`mcp_2026_07_28`, also under
   development, default false). The integration test
   `app-server/tests/suite/v2/mcp_connection_sharing.rs` shows a server negotiating `2025-06-18` stays private
   while a `2026-07-28` server is pooled. `config.schema.json` has NO per-server opt-out key (RawMcpServerConfig
   keys: args, auth, command, cwd, enabled, enabled_tools, env, env_vars, startup_timeout_*, tool_timeout_sec,
   tools, url, ...). Tool calls from different chats carry no per-chat identifier to the server in the visible
   diff; only input (elicitation) ids are globally unique. On this machine: `codex features list` shows
   `mcp_2026_07_28 under development false`; `mcp_connection_sharing` is not listed at all (hidden under
   development flag). Room sets neither `CODEX_MCP_PROTOCOL_VERSION` nor either feature.
   **Implication:** Room's one-MCP-per-conversation assumption (packages/room-mcp/src/session.ts:244,
   `admitCodexThread`) holds today by default and would break the day a user enables both flags. Decision 6 of
   the plan ("loud check") therefore becomes concrete: Room's server must keep negotiating the protocol version
   its SDK offers today and must refuse, not merely log, a tool call from a second Codex thread id, naming the
   flags. Per-call session selection is the eventual answer only if Codex starts passing a per-chat id in
   `_meta`.
2. **Hooks.** Stable (`hooks stable true`). Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
   PermissionRequest, PostToolUse, PreCompact, PostCompact, Stop, PreModelRequest, PostModelRequest,
   SubagentStart, SubagentStop, Interrupt. Common input: `session_id`, `transcript_path`, `cwd`,
   `hook_event_name`, `model`; turn hooks add `turn_id`; PreToolUse/PostToolUse add `tool_name`, `tool_use_id`,
   `tool_input` (Bash/apply_patch command at `tool_input.command`). 0.166.0 now reports the local command cwd in
   PreToolUse (#57198) and preserves it in permission/post hooks (#57203). Output: `hookSpecificOutput.additionalContext`;
   plain stdout is ignored for PreToolUse. Trust is recorded against the hook's hash; changed hooks are skipped
   until trusted (confirms the frozen `hooks.json` rule); `--dangerously-bypass-hook-trust` exists for automation.
   Default timeout 600 s; `async: true` background hooks (up to eight). Subagent hooks use the parent `session_id`.
3. **`codex exec --worktree`** runs a session in a Codex-managed Git worktree (not combinable with resume,
   `--ephemeral`, `--ignore-user-config`); `--thread-source` labels new threads; `codex exec fork <id>`;
   `codex queue --thread <id|name> --message --resume` (needs the daemon); `codex agents` browses daemon
   sessions. Room keeps its own worktrees (it owns branch, base, carry and collect); `--worktree` is not a
   replacement but a sign Codex expects worker-style use.
4. **Daemon:** `daemon_auto_start stable true`. The app-server daemon is the default path; `--no-daemon` only on
   the base command. 0.166.0 fixed slow daemon startup detection and PID probe locks.
5. **SQLite in Codex itself:** Codex keeps SQLite databases and in 0.166.0 forces DELETE journaling on NFS
   (#56552, #57225, #57226) with a `codex migrate-nfs-db` command. **Implication for the SQLite spec:** WAL is
   unsafe on network filesystems; Room must detect a network filesystem under the clone's git common dir and
   use DELETE journaling there (or refuse), and must say so in the preflight.
6. **Models:** 0.166.0 adds GPT-6.1 Terra to the catalog alongside GPT-6.1 Sol and GPT-6 Astra (config.toml on
   this machine lists `gpt-6-astra` and `gpt-6.1-sol`). `codex model list` is not a command on 0.166; use the
   TUI model picker or `codex debug models` (experimental).
7. **Plugins:** `codex plugin add|list|remove|marketplace add|list|remove|upgrade`, all stable; the plugin page
   says start a new session after installing before using bundled tools (matches the reconnect note in the
   roadmap).

## Not found

- No per-chat identifier for shared MCP servers (no `_meta` field named in #57211/#57196 descriptions).
- No documented MCP server config key for cwd/env-based pooling exclusion.
- `codex-exec-server` was added then removed from release artifacts within 0.166.0; ignore.

Sources: learn.chatgpt.com/docs/hooks, /docs/plugins, /docs/developer-commands?surface=cli;
github.com/openai/codex releases rust-v0.166.0; PRs #57211, #57196, #57210; codex-rs/features/src/lib.rs;
codex-rs/core/config.schema.json; app-server/tests/suite/v2/mcp_connection_sharing.rs; `codex --help`,
`codex exec --help`, `codex features list` on this machine.
