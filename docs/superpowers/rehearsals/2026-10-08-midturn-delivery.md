# 2026-10-08 — Mid-turn delivery: capability proof and limits

Lead: `rohanz+midturn-lead` (Claude Fable 5.1, Room worker of Rohan's session). Goal: relevant Room messages
reach a busy agent in the middle of its turn, routine updates stay quiet, no running tool is killed. Hosts:
Claude Code 2.1.293; codex-cli 0.160.1 with the shared app-server daemon package 0.161.0; macOS. All probes
used disposable sessions in `/tmp/midturn`; no user session was steered. Dated doc extracts the design relies
on: [host snapshots](../../host-snapshots/2026-10-08-midturn-delivery.md). Companion Room-level Claude probe:
[2026-10-08-midturn-claude-e2e.md](2026-10-08-midturn-claude-e2e.md).

## Summary

| Host | Transport | Busy session, mid-turn? | Running tool interrupted? | Authority of the delivered text |
|---|---|---|---|---|
| Claude Code 2.1.293 | existing inbox socket (`wake-path.ts`) | Yes: read between tool calls, acted on before the next step | No | peer message, framed by the host as from another session |
| Codex 0.160.1, shared daemon | **new**: `turn/start {input: [], toolOutput}` on the daemon control socket | Yes: joins the active turn, lands right after the running tool | No | tool output (`functionCallOutput`), below user and developer instructions |
| Codex, idle thread | existing `codex queue` (unchanged) | n/a (starts the next turn) | n/a | user input |
| Codex `--no-daemon` / `codex exec` | queue fallback (thread not in the daemon) | No: waits for the turn boundary, as before | No | user input |

## Claude Code: no transport change needed

Raw host probe (`/tmp/midturn/probe/claude-raw.mjs`, haiku, `claude -p --output-format stream-json`): the
session ran `sleep 25`; a message was posted to its `CLAUDE_CODE_MESSAGING_SOCKET` at +12.2 s; the Bash task
completed at +32.1 s (uninterrupted); the next tool call at +33.6 s; the model's final line: “Message arrived:
"PROBE-MESSAGE-7731 …" — it came before the second command ran.”

Room-level probe with two disposable agents in their own local room (worker `claude-e2e`, details in the
companion file): the producer's addressed note was on the consumer's inbox socket 21 ms after `room_send`; the
busy 45 s tool finished with `interrupted: false`; the consumer called `room_state` 7 ms of model time after
the tool result and changed its call to the new signature before its planned next step. With `ROOM_WAKE=off`
nothing reached the model until the turn ended. The automatic changed-definition notice did not fire in that
run because the producer's claims were declined as unnecessary; the addressed note carried the change.

## Codex: what the shared daemon supports

Protocol access. `codex app-server proxy` forwards raw bytes to the daemon's Unix control socket, which is a
WebSocket endpoint (`codex app-server daemon version` prints the path). Plain JSON lines get no reply. A Node
`ws` client (`ws+unix://<path>:/`) completes the handshake; `initialize` then `initialized` per connection.

Owned-thread probe (`codex-owned.mjs`, two connections A and B, thread `01a11971-f27e-…`, gpt-6.1-sol, low):

| UTC (+ms from start) | Connection | Event |
|---|---|---|
| 02:57:40.933 (+471) | A | `turn/start` user prompt → turn `01a11971-f43d-…` inProgress |
| 02:57:46.440 (+5978) | A | `item/started commandExecution` `sleep 20 && echo first-done` |
| 02:57:49.441 (+8979) | B | `turn/start {threadId, input: [], toolOutput: {name: "room_notify", namespace: "room", output: "PROBE-CODEX-4411 …"}}` |
| 02:57:49.442 (+8980) | B | response `{turn: {id: "01a11971-f43d-…", status: "inProgress"}}` — the **active** turn id, no new turn |
| 02:58:06.318 (+25856) | A | `item/completed commandExecution` exit 0 (the sleep ran its full 20 s) |
| 02:58:06.320 (+25858) | A | `item/started` + `item/completed functionCallOutput room_notify` |
| 02:58:08.578 (+28116) | A | `item/started commandExecution` `echo second-done` |
| 02:58:11.031 (+30569) | A | agentMessage: “Yes: “PROBE-CODEX-4411 …” arrived before step 2 started.” |
| 02:58:11.200 (+30738) | A, B | `turn/completed` status completed; `thread/status/changed idle` on both connections |

Persisted history (`thread/read includeTurns`) shows the same order: userMessage, agentMessage,
commandExecution (sleep), functionCallOutput, commandExecution (echo), agentMessage.

Interactive TUI probe (`tui.exp` driving `codex --cd /tmp/midturn/sandbox` under expect; `post.mjs` as the
peer). The TUI's thread appears in `thread/loaded/list` while the TUI runs, so the TUI is a client of the
same daemon Room's MCP runs under. Results on three TUI threads:

- Idle TUI thread + `toolOutput` → a new turn starts, the TUI renders it (“Working”), the model answers
  (“No task is active. I'm ready for your next instruction.”). Status `idle → active → idle` in 2–6 s.
- Active TUI thread + `toolOutput` (thread `01a1198e-…`, 03:31:15Z, `thread/read` status active) → the
  response carries the **same** active turn id; history shows the second `functionCallOutput` inside that
  turn, followed by the model reading the Room etiquette skill before answering.
- Not reproduced on the TUI: the TUI mid-way through its **own** long tool. The expect harness could type
  into the composer but Enter did not submit under the pseudo-terminal (the prompt never became a turn), so
  the “tool completes uninterrupted, output lands before the next step” ordering is proven on the
  daemon-owned thread above, and on the TUI only as idle→new turn and active→join. The daemon logic is per
  thread, not per client kind, but this remains an observed gap, not a proof.

Safety probes:

- Unknown thread id → `-32600 thread not found`, nothing happens.
- Real but unloaded thread (owner disconnected; `thread/read` status `notLoaded`) → the same error; the
  thread stays unloaded. Threads unload when their last client disconnects, so only sessions with a live
  daemon client can receive mid-turn output. `codex exec` workers and `codex --no-daemon` sessions are
  not loaded in the daemon.
- `turn/steer` was not used: it carries user authority and requires `expectedTurnId`; `turn/interrupt`
  cancels the turn. Room's interrupt priority means “replan”, not “cancel”, so neither fits.

Side effect undone: answering the TUI's trust prompt for `/tmp/midturn/sandbox` wrote one
`[projects."/private/tmp/midturn/sandbox"] trust_level = "trusted"` entry into `~/.codex/config.toml`; it was
removed by exact-match replacement (atomic rename, mode 0600, one occurrence) with no other change.

## Design that follows

- Codex only; Claude's socket path is unchanged.
- The reconciler already probes the Codex turn before queueing. When the turn is busy and a wakeable
  message is `notify` or `interrupt` priority, the recipient's own Room MCP posts the usual content-free
  pointer as `turn/start {input: [], toolOutput: {name: "room_notify", namespace: "room"}}` after
  `thread/read` reports the thread active. `fyi` messages (worker `done`, fyi notes; base notices never wake) wait for
  the idle queue as before.
- Outcomes: joined (recorded in `wakes.json` as `via: "turn"`, so the later idle queue pointer names only
  what is still unwoken); idle (no post; the existing queue path handles it); unavailable (no socket,
  thread not loaded, timeout, error → the busy poll continues, the message stays owed, no duplicate side
  effects after a later success). A wake is still never a receipt.
- Known race: the thread can go idle between `thread/read` and `turn/start`; the post then starts a new
  tool-output turn instead of the queue's user-input turn. The TUI renders such a turn; the text is the
  same pointer.
- `ROOM_WAKE=off` still disables every wake.

## Binding gap found by the Room-level Codex rehearsal

Two daemon-hosted rehearsals (`codex-room-e2e.mjs`: a consumer thread sleeping 45 s, a second Codex thread
as producer that sent an addressed note and stayed present for 80 s) produced **no wake at all** in the
consumer's `room-mcp.log`, neither mid-turn nor the idle queue, with the installed 0.17.11 plugin and with
the rebuilt bundle. Cause: `boundSession()` returns undefined when the MCP's parent command line is
`codex app-server …`, because the hook-written process chain is the shared daemon and cannot tell threads
apart (registry spec, open question 1). With no bound session the wake reconciler, hook arbitration
(`reason: 'unbound'`) and the mid-turn path never run. The same holds for the user's own daemon TUI
sessions: the production room log has no `wake: woke codex` line in the daemon era.

Answer to the open question (probe MCP server `meta-mcp.mjs` inside a disposable daemon thread,
`meta-calls.jsonl`): every tool call's `_meta` carries `x-codex-turn-metadata` with `thread_id`,
`session_id` (the same id, equal to the hooks' `session_id`), `turn_id`, `model`, `sandbox_mode` and
`codex_version: "0.161.0"`, plus top-level `threadId`, `sessionId`, `callId` and `windowId`. `workspaces`
was absent in that call. Each daemon thread spawns its own MCP server processes, so the first call's
thread id identifies the process's thread for its lifetime. Binding on it is the precondition for any
Codex wake under the daemon; it is implemented in this batch (worker `sol-binding`).

## Implementation evidence

Code (Sol workers `sol-transport` and `sol-binding`, reviewed and collected by the lead; uncommitted):

- `packages/room-mcp/src/codex-app-server.ts`: one WebSocket connection per post to the daemon control
  socket; `initialize` → `initialized` → `thread/read` → `turn/start {input: [], toolOutput}` only when the
  status is `active`; `idle`/`notLoaded`/`systemError` → no post; errors, missing socket and a 3 s timeout
  → `unavailable` with the reason; the socket is always terminated.
- `wake-path.ts`: `WakeVia` gains `'turn'`; `createMidTurnSender` (Codex only, `ROOM_WAKE=off` honoured,
  one log line per distinct failure reason per thread).
- `wake-reconciler.ts`: while the Codex turn probe says busy, messages whose priority is `notify` or
  `interrupt` go mid-turn through the sender and are recorded in `wakes.json` as `via: 'turn'`; `fyi`
  messages wait for the idle queue; a failed or unavailable post keeps the busy poll; the coalescing
  window and the stale-binding re-check apply to both paths; the ledger is untouched.
- `session.ts` / `binding.ts` / `workspace.ts` / `index.ts`: `codexThreadFromMeta` reads
  `_meta["x-codex-turn-metadata"].thread_id` (no other fallback); `admitCodexThread` keeps the
  first valid id for the process; `boundSession` returns it for an app-server parent; the binding cache
  refreshes when the admitted id changes. `codex --no-daemon`, Room workers and Claude are unchanged.
- Docs and skills: README, `docs/reference.md`, `docs/onboarding.md`, `docs/roadmap.md`, the
  `room-etiquette` and `room-workers` skills; dated host snapshots in `docs/host-snapshots/`.
- `packages/room-mcp/package.json` declares `ws` (already bundled through y-websocket); lockfile updated.

Checks run by the lead outside the sandbox (2026-10-08): `npm run typecheck` clean after every collection;
focused suites (`codex-app-server`, `wake-turn`, `socket-wake`, `solo-quiet`, `binding`, `session-binding`,
`workspace`, `doctor-entry`, `hooks`) 201 tests pass after the review fixes; the full
`env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test` passed after the transport change (329 files,
3607 tests) and after the binding change (330 files, 3611 tests); after the review fixes one run that
overlapped a daemon rehearsal failed a single unrelated worker-dismissal timing test
(`workers.test.ts` "room_leave refuses while workers run…", `t2.killed` empty after shutdown), which
passed twice in isolation; the suite rerun alone afterwards passed completely (330 files, 3619 tests).
That test exercises worker process dismissal on `room_leave`/shutdown, which this batch does not touch
(`git diff f9fffae1 --stat` lists no worker-launch or registry file), and the same test passed in the two
earlier full runs that already contained the transport change, so the failure is a load-timing effect of
the concurrent daemon rehearsal, not a regression.
`npm run build -w @room/web` and the full `npm run build:plugin` succeeded; `plugins/room/hooks.json` is
byte-identical. The rebuilt bundle is committed-asset output, not a release; no version bump.

Room-level Codex rehearsal with the rebuilt bundle (`codex-room-e2e.mjs`, `e2e-after3.log`): consumer
thread `01a119d3-0ae2-…` (gpt-6.1-sol) running the dev bundle as its Room MCP in a throwaway clone;
producer thread `01a119d3-6e5a-…` with the installed 0.17.11 plugin, present for 80 s.

| UTC | Event |
|---|---|
| 04:44:05.159 | consumer: `sleep 45 && echo first-done` starts |
| 04:44:23.398 | producer: `room_send` note to `rohanz's agent` completes |
| 04:44:23.422 | consumer's Room MCP: `wake: delivered mid-turn to codex session 01a119d3-0ae2-… via turn for note m_muz1y0v40w22np` (24 ms after the send) |
| 04:44:39.859 | daemon: `item/started` + `item/completed functionCallOutput room_notify` with the content-free pointer (the notification can precede the tool's completion; the tool keeps running) |
| 04:44:50.041 | consumer: sleep completed, exit 0, 44.9 s after it started (not interrupted) |
| 04:44:52.593 | consumer: `room_state` (room_dev), reads the note |
| 04:44:57–04:45:01 | consumer edits `api/orders.py` as the note asked |
| 04:45:04.940 | consumer: `echo second-done` |
| 04:45:07.889 | consumer's reply: the notice reached it, it edited the file, before step 5 |

The earlier run with the same code and a consumer told not to act (`e2e-after2.log`) showed the same
26 ms send-to-post latency and the pointer inside the turn. Before the binding change, the same scenario
produced no wake at all (see above). The Claude side needs no code change (companion file).

Independent review (worker `fable-review`, Claude Fable 5.1, read-only, full diff against `f9fffae1`):
no blockers; required fixes were the idle queue follow-up after a mid-turn pointer (a message the model
ignored stayed owed with no further wake) and the docs claims, which this rerun now backs; should-fix
items on binding order when the parent is a shim or `ps` is unreadable, per-id conflict logging, logging
the joined turn id, the handshake version, dropping the top-level `threadId` fallback, and test gaps
(turn/start errors, non-inProgress turns, admitted id with and without a daemon parent, Claude host
unchanged). Applied by worker `sol-fixes`; see its tests. Accepted as documented behaviour rather than
changed: a session started eagerly under the daemon with `ROOM_DIR` set joins under the synthetic id and
rebinds on its first tool call through the existing host-rebind path; the first admitted thread id is
pinned for the MCP process (one MCP process per daemon thread was observed: distinct pids per
`thread/start`, `mcpServer/startupStatus` per thread), so a host that reused a process for a new thread
would keep the old binding, which is logged; a `turn/start` whose reply arrives after the 3 s timeout is
re-posted on the next busy poll, so the pointer can appear twice (content-free, harmless).

Remaining limits: the TUI mid-way through its own long tool is still proven only indirectly (daemon-owned
and dev-bundle threads, plus TUI idle/active acceptance); `codex exec` workers and `--no-daemon` sessions
keep the queue fallback and, without a daemon thread, no mid-turn path; the idle race between
`thread/read` and `turn/start` starts a tool-output turn; the app-server is labelled experimental by
OpenAI, so the control socket location and protocol can change.
