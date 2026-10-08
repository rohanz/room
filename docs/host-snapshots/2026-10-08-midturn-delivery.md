# Host snapshots for mid-turn delivery (2026-10-08)

Concise, dated extracts of the official host documentation and the locally installed tooling that the
mid-turn delivery work relies on. Written for networkless Codex workers; verify against the live pages
before relying on them later. Installed: codex-cli 0.160.1 (shared app-server daemon package 0.161.0),
Claude Code 2.1.293, Node 22.14.

## Codex app-server (https://learn.chatgpt.com/docs/app-server, read 2026-10-08)

Verbatim passages:

- "Begin a turn: Call `turn/start` with the target threadId and user input."
- "Steer an active turn: Call `turn/steer` to append user input to the currently in-flight turn without
  creating a new turn."
- "To start a turn with output from a tool your client ran, pass `toolOutput` with a nonempty `name`, an
  optional `namespace`, and an `output` string or array of content items. Set `input` to an empty array;
  you can't combine `toolOutput` with nonempty user input."
- "The output remains tool output in the conversation and appears as a `functionCallOutput` item in
  notifications and persisted history. If a regular turn is already active, Codex queues the output for
  that turn."
- "`functionCallOutput` - `{id, name, namespace, output}` for standalone tool output supplied through
  `turn/start.toolOutput`. `namespace` can be null."
- `turn/steer`: "Include `expectedTurnId`; it must match the active turn id. The request fails if there is
  no active turn on the thread. `turn/steer` doesn't emit a new `turn/started` notification."
- `turn/interrupt`: "request cancellation of an in-flight turn; success is `{}` and the turn ends with
  `status: "interrupted"`."
- "Clients must send a single `initialize` request per transport connection before invoking any other
  method on that connection, then acknowledge with an `initialized` notification."
- The page documents stdio and WebSocket transports; `codex app-server --help` labels the whole command
  `[experimental]`.

Generated schema (`codex app-server generate-json-schema --out <dir>`, v2 bundle, 0.160.1):

- `TurnStartParams`: required `threadId`, `input: UserInput[]`; optional `toolOutput: TurnToolOutput |
  null` where `TurnToolOutput = { name: string, namespace?: string | null, output: string |
  FunctionCallOutputContentItem[] }`.
- `TurnStartResponse = { turn: Turn }`, `Turn.status ∈ completed | interrupted | failed | inProgress`.
- `ThreadStatus` is one of `notLoaded`, `idle`, `systemError`, `active { activeFlags: (waitingOnApproval
  | waitingOnUserInput)[] }`; `thread/read { threadId, includeTurns?: false }` returns it, and the
  server emits `thread/status/changed { threadId, status }` to every connection.
- `thread/loaded/list` returns the ids of threads currently loaded in the daemon.
- Queue methods present in the binary and schema: `thread/queue/list|update|delete|reorder|start`
  (`QueuedSubmission { id, clientUserMessageId, input: UserInput[] }`, user authority) plus the
  `ThreadQueueAdd` request variant used by `codex queue`.

Local daemon facts (observed 2026-10-08, not documented on the page):

- The shared daemon listens on a Unix socket: `$CODEX_HOME/app-server-control/app-server-control.sock`
  (a symlink into `/private/tmp/codex-daemon-<uid>/<hash>`). The socket speaks **WebSocket**, not
  newline JSON: `codex app-server proxy` copies raw bytes to it, so a client must do the HTTP upgrade
  itself (Node `ws` with `ws+unix://<path>:/` works). `codex app-server daemon version` prints
  `socketPath`, `cliVersion` and `appServerVersion`.
- An interactive `codex` TUI is a client of that daemon: its thread appears in `thread/loaded/list`,
  its MCP servers run as children of the daemon, and it renders turns that another client starts.
- A thread unloads when its last client disconnects; `turn/start` for an unloaded or unknown thread
  returns `-32600 thread not found` and changes nothing.

## Claude Code cross-session messaging (https://code.claude.com/docs/en/cross-session-messaging, read 2026-10-08)

- "Cross-session messaging requires Claude Code v2.1.224 or later on macOS and Linux … On native
  Windows, it requires Claude Code v2.1.234 or later."
- "The receiving Claude reads the message between tool calls during an active turn, so a running tool is
  never interrupted. When the receiving session is idle, Claude Code starts a new turn with the message."
- "Claude Code binds an inbox socket for each session with cross-session messaging enabled … Claude Code
  exports it to hooks and Bash commands as the `CLAUDE_CODE_MESSAGING_SOCKET` environment variable."
- "A script posting to its own session's socket can send `{"type":"auth","token":"<token>"}` as the
  first line of its connection … macOS and Linux: the line is optional … Native Windows: the line is
  required."
- Inbound controls `crossSessionInbound`: `accept` delivers, `hold` shows a notice and keeps the message,
  `refuse` drops it. With no value set, delivery depends on the two sessions' permission-mode classes.
- Limits: "rate-limits repeated messages per sender, drops identical repeats arriving within a short
  window, and queues at most 50 accepted messages"; a connection with no complete line in 30 s is closed.
- `claude -p` sessions bind an inbox; `--bare` does not. Unattended `-p` workers need
  `crossSessionInbound: accept` in `--settings`.
