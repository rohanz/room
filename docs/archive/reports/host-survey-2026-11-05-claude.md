# Claude Code host snapshot, 2026-11-05

Taken for the batch-2 adapter slices (CLAUDE.md: read current host docs, not memory). Installed: Claude Code
2.1.318. Sources: code.claude.com/docs/en/cli-reference.md, hooks.md, cross-session-messaging.md,
worktrees.md, the repository CHANGELOG (newest 2.1.318), and `claude --help` on this machine. Codex's snapshot
of the same day is host-survey-2026-11-05-codex.md.

## Facts the adapters must preserve or now rely on

1. **Hook input fields (common):** `session_id`, `prompt_id` (UUID of the current user prompt), `transcript_path`
   (may lag), `cwd`, `scratchpad_dir` (2.1.257+), `permission_mode` (`default|plan|acceptEdits|auto|dontAsk|bypassPermissions`),
   `effort` (`{ level }`), `hook_event_name`. Subagent and teammate contexts add `agent_id` and `agent_type`
   (Room's before-edit uses `agent_id` to classify subagents). Tool events add `tool_name`, `tool_input`,
   `tool_use_id`. `SessionStart` may include `model` but not always; matchers `startup|resume|clear|compact|fork`.
   33 events exist, including `WorktreeCreate`/`WorktreeRemove`, `CwdChanged`, `SubagentStart/Stop`,
   `PreModelSwitch/PostModelSwitch` (`from_model`, `to_model`), `Elicitation`.
2. **Hook output:** `PreToolUse` → `hookSpecificOutput.{permissionDecision: allow|deny|ask|defer,
   permissionDecisionReason, updatedInput, additionalContext}`; `SessionStart` is context-only
   (`additionalContext`, `initialUserMessage`, `watchPaths`, `sessionTitle`, `reloadSkills`). Universal:
   `continue`, `stopReason`, `systemMessage`, `terminalSequence`. Exit 2 blocks where blocking is allowed. Stdout
   counts as JSON only when it is a single object. **Each hook's output is capped at 10,000 characters (2.1.317)**:
   Room's injected coordination context must stay under that or be truncated by the host.
3. **Hook timing:** default `timeout` 600 s for command hooks; `SessionEnd` shares a 1.5 s budget (raisable to
   60 s); a timed-out hook's output is discarded and does not block unless `onFailure: "block"` (2.1.295+);
   `async: true` background hooks (no timeout enforced), `asyncRewake`. Hooks matching Bash also run for the
   Monitor tool (2.1.314): they can block or ask, not approve or rewrite. PowerShell is matched by tool name;
   exit-2 blocking in PowerShell hooks was fixed in 2.1.316/2.1.309; on Windows PreToolUse hooks failed open
   without Git Bash before 2.1.310.
4. **Plugin hooks:** `hooks/hooks.json` in the plugin, merged with user and project hooks; `${CLAUDE_PLUGIN_ROOT}`
   and `${CLAUDE_PLUGIN_DATA}`; blocked under `allowManagedHooksOnly` unless force-enabled. The docs say nothing
   about hash trust (unlike Codex, which trusts by content hash): Claude reads `plugins/room/hooks/claude.json`
   on each start.
5. **Cross-session messaging (Room's wake path):** on by default from 2.1.224 (2.1.234 native Windows);
   per-session Unix socket (named pipe on Windows) in `/tmp/cc-socks-<uid>`; exported to hooks and Bash as
   `CLAUDE_CODE_MESSAGING_SOCKET` before any hook runs, plus `CLAUDE_CODE_MESSAGING_TOKEN`; a script sends
   `{"type":"auth","token":...}` as the first line (optional on macOS/Linux, required on Windows); a connection
   that sends no complete line within 30 s is closed. An idle receiver starts a new turn; a busy one reads
   between tool calls. Own-child messages (hooks, Bash posting back) are delivered without the permission-class
   hold when Claude Code can verify the child (process evidence on Linux; token on macOS after exit, in
   containers as pid 1, and on Windows). Inbound controls `crossSessionInbound: accept|hold|refuse` and the
   permission-class default (a bypass-permissions receiver holds messages from non-bypass senders); held
   messages expire after `dialogExpiry` (5 min default) in `-p` sessions unless `accept` is set in
   `--settings`. `--bare` sessions bind no socket. Bursts refused at the sender; loops throttled; 50 queued max;
   ~1 MB size cap. `notify_when_idle` (2.1.236+) gives one idle notice, same-machine only, 12 h limit.
6. **CLI flags Room uses or should know:** `-p`, `--resume <id|name|transcript path>` (searches every project
   from 2.1.223; resuming a running background session attaches), `--continue`, `--fork-session`,
   `--session-id <uuid>`, `--name/-n`, `--effort low|medium|high|xhigh|max|ultracode`, `--model`,
   `--max-budget-usd` (print mode; subagent spend counts; cap enforcement 2.1.217+), `--plugin-dir` (repeatable),
   `--permission-mode`, `--permission-prompts host|none` (2.1.259+), `--dangerously-skip-permissions`,
   `--allow-dangerously-skip-permissions`, `--bg` (background session; mode persists across supervisor
   restarts), `--bare` (skips hooks, settings, plugins; no inbox socket), `--restricted` (2.1.248+),
   `--worktree/-w <name|#PR|URL>` (worktree at `.claude/worktrees/<name>`, branch `worktree-<name>`),
   `--tools`, `--disallowedTools`, `--output-format stream-json`, `--include-hook-events`,
   `--forward-subagent-text`, `--settings <file|json>`, `--mcp-config` (with `-p` waits up to `MCP_TIMEOUT`
   30 s for servers), `--channels plugin:<name>@<marketplace>` (research preview), `--init`/`--init-only`.
7. **Worktrees:** `.claude/worktrees/<name>` on `worktree-<name>`; `worktree.baseRef` `fresh|head`; isolation
   checks block edits and git redirects into the main checkout; `${CLAUDE_PROJECT_DIR}` stays at the launch root
   while the hook `cwd` follows the worktree; `-p` runs leave their worktrees and locks for the sweep;
   subagent worktrees (`isolation: worktree`) are swept after `cleanupPeriodDays`. Room keeps its own worktrees
   (branch, base, carry, collect), and the adapter must not confuse a Room worker worktree with a Claude one.
8. **MCP servers:** a stdio server that exits in under 3 s on the version probe is pinned to the legacy
   handshake for 7 days (2.1.318); `/mcp reconnect <name>` reconnects one server (used today to pick up a
   rebuilt Room bundle without restarting). Subagents can use MCP tools from servers that connect after the
   subagent starts (2.1.311).
9. **Subagents:** `CLAUDE_CODE_SUBAGENT_EFFORT` (2.1.316); background subagents move a shell command to the
   background after 3 minutes (2.1.318); teammates inherit tool deny rules from the leader's command line.
10. **Windows:** 2.1.317 fixed every tool call being refused on some volumes and shortened temp paths (260-char
    limit); 2.1.316 fixed Git Bash alias loss.

## Not found

- No documented hash trust for Claude plugin hooks (Codex has it).
- No change to `--name`, `--max-budget-usd` or `--session-id` semantics in 2.1.309–2.1.318.
