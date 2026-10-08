# 2026-10-08 — Mid-turn delivery to a busy Claude consumer (Room-level probe)

Independent verification probe run by worker `claude-e2e` for `rohanz+midturn-lead`. No source changes.
Question: does Room's **current** Claude Code wake path (the plugin bundle committed in this worktree,
`plugins/room`, release 0.17.11, built from f9fffae1) deliver a relevant teammate change to a Claude consumer
that is **busy inside a 45 s tool call**, before that consumer's turn ends?

## Verdict

| Question | Answer (clean run 3, reproduced by run 2) |
|---|---|
| Delivered mid-turn? | **Yes.** The pointer was injected into the consumer's running turn 7 ms after the busy tool returned, and the consumer acted on it before its planned `second-done` step. |
| Busy tool interrupted? | **No.** `python3 … time.sleep(45)` ran 45.5 s end to end; the tool result carries `"interrupted":false`. |
| Latency send → pointer on the socket | 21 ms (run 3), 40 ms (run 2), 29 ms (run 1). |
| Latency send → model's first reaction (`room_state`) | 18.8 s in run 3, of which 15.3 s was the remaining sleep and 3.4 s was Haiku thinking. 25.5 s in run 2 (10.3 s of Haiku thinking). |
| Did the consumer adjust its code? | Yes: it changed its call to `Order.from_payload(payload, source="api")` after reading the note, in the same turn, before `echo second-done`. |
| Control (`ROOM_WAKE=off` in the consumer) | Nothing reached the model. Log: `wake: this claude session has no wake path; messages wait for its next turn`. The consumer edited with the old signature and reported `pointer_arrived=no`. |
| Which notice arrived? | Only the producer's **addressed note**. The automatic changed-definition notice did **not** fire (see Limits: both `room_claim` calls were declined as unnecessary, so the signature plan was never registered). |

Idle path, as a bonus from run 1: when Haiku backgrounded the sleep and the consumer's turn ended early, the same
pointer started a **new** turn in the still-running headless session within ~30 ms of the send, and the consumer
fixed its call 14 s later.

## Setup (verbatim)

- Host: Claude Code 2.1.293 (`claude --version`), macOS (Darwin 25.5.0). Model for both agents: `claude-haiku-4-5-20251001`.
- Plugin: `--plugin-dir <this worktree>/plugins/room` (committed bundle, manifest version 0.17.11). The user-installed
  `room@room` 0.17.11 was disabled for these sessions with `--settings '{"enabledPlugins":{"room@room":false}}'` so only one
  Room MCP loaded; tools appeared as `mcp__plugin_room_room__*`. The `system.init` event listed
  `{"name":"room","path":".../claude-e2e/plugins/room","source":"room@inline","version":"0.17.11"}`.
- Throwaway repo, outside this repo: `examples/demo-repo` copied to `/tmp/midturn-e2e/consumer`, `git init -b main`, one
  commit (`f02a18c`), then `git worktree add /tmp/midturn-e2e/producer -b producer`. Both checkouts share the git common
  dir, so both sessions join the same local room `local/consumer` (relay on 127.0.0.1:44212) and never Rohan's room.
  `/tmp/midturn-e2e/consumer/.git/room` was deleted before each run from run 3 on (see Limits, run 2 contamination).
- Both agents headless, run in the foreground by a driver script (`/tmp/midturn-e2e/run.sh`), each line of stream-json
  stamped on arrival with `perl -MTime::HiRes` (the `ISO` prefix on every quoted event below). Common flags:

```
claude -p "<prompt>" --name <consumer|producer> --plugin-dir <worktree>/plugins/room \
  --output-format stream-json --verbose --permission-mode acceptEdits \
  --allowedTools 'mcp__room__*,mcp__plugin_room_room__*,Edit,Write,Read,Bash,Glob,Grep' \
  --settings '{"crossSessionInbound":"accept","enabledPlugins":{"room@room":false,"hosho@hosho":false}}' \
  --no-session-persistence --max-turns 12 --model claude-haiku-4-5-20251001
```

  Inherited `CLAUDE_*` variables (session id, messaging socket/token, plugin root, …) and every `ROOM_*` variable were
  unset for the children; `ROOM_TAG=consumer` / `ROOM_TAG=producer` named the participants `rohanz+consumer` /
  `rohanz+producer`. Timeouts: `perl -e 'alarm shift; exec @ARGV' 210` (consumer) / `170` (producer); none fired.
- Consumer prompt (final form): room_scope on `api/handlers.py`; room_claim it; Bash
  `python3 -c "import time; time.sleep(45); print('first-done')"` in the foreground; Edit to add a comment above
  `order = Order.from_payload(payload)`; Bash `echo second-done`; if any `[room]` message arrives, call `room_state` and
  adjust the edit if needed; final one-line `REPORT:` including the verbatim pointer text.
- Producer prompt (started 10 s after the driver saw the consumer's sleep `tool_use`): room_state to find the consumer's
  name; room_scope on `api/models.py`; room_claim with plans
  `[{"kind":"signature","symbol":"Order.from_payload","detail":"from_payload(cls, payload: Payload, source: str) -> Order"}]`;
  Edit the signature to add `source: str`; `room_send` type `note` to `rohanz+consumer`; `room_done`.
- Raw artifacts (not committed): `/tmp/midturn-e2e/out/{run1,run2,run3,control}/` with `consumer.jsonl`,
  `producer.jsonl`, `room-mcp.log` (the clone's `<git common dir>/room-mcp.log` slice for that run), `consumer.diff`,
  `producer.diff`, `driver.log`.

## Run 3 (clean): the mid-turn result

Consumer session `81aeec06-c3e4-4665-a963-657c235c7521`, producer session `b7d78404-38e5-46ec-811a-e564be1290bb`.

Consumer stream-json, in order (prefix = arrival time; thinking/heartbeat/rate-limit events omitted):

```
2026-10-08T03:26:58.730Z TOOL_USE mcp__plugin_room_room__room_scope {"area": "api", "paths": ["api/handlers.py"], "summary": "annotate create_order"}
2026-10-08T03:26:58.821Z TOOL_RESULT scope set: api: annotate create_order (api/handlers.py) | areas: api/ (top-level dirs; no CODEOWNERS) | nobody else is in your areas | api ledger (0):
2026-10-08T03:26:58.999Z TOOL_USE mcp__plugin_room_room__room_claim {"path": "api/handlers.py", "intent": "add a comment above the Order.from_payload call"}
2026-10-08T03:26:59.005Z TOOL_RESULT api/handlers.py: no claim needed; nobody else is near this path
2026-10-08T03:27:01.545Z TOOL_USE Bash {"command": "python3 -c \"import time; time.sleep(45); print('first-done')\"", "description": "45-second test sleep"}
2026-10-08T03:27:05.049Z system task_started
2026-10-08T03:27:31.594Z tool_progress {"type":"tool_progress","tool_use_id":"toolu_01D7at1ANcGnD2V2e3pC4kPv-heartbeat-0","tool_name":"Bash", ...
2026-10-08T03:27:47.084Z system task_notification
2026-10-08T03:27:47.091Z TOOL_RESULT first-done
2026-10-08T03:27:47.098Z command_lifecycle {"type":"command_lifecycle","command_uuid":"9ac1caab-742d-45c8-889c-17a536fe94b3","state":"started", ...}
2026-10-08T03:27:50.464Z TEXT A message arrived from a teammate. Per step 6, I need to handle it now. Calling room_state:
2026-10-08T03:27:50.559Z TOOL_USE mcp__plugin_room_room__room_state {}
2026-10-08T03:27:50.568Z TOOL_RESULT [inbox 1] |   [m_muyz76hajbki3f] [notify] rohanz+producer → rohanz+consumer: I changed Order.from_payload in api/models.py: it now requires a second argument source: str. Your call in api/handlers.py must pass it, e.g. Order.from_payload(payload, source="api"). | ...
2026-10-08T03:27:54.941Z TOOL_USE Read {"file_path": "/private/tmp/midturn-e2e/consumer/api/handlers.py"}
2026-10-08T03:27:57.787Z TOOL_USE Edit {"replace_all": false, "file_path": "/private/tmp/midturn-e2e/consumer/api/handlers.py", "old_string": "    order = Order.from_payload(payload)", "new_string": "    # calls Order.from_payload(payload)\n    order = Order.from_payload(payload, source=\"api\")"}
2026-10-08T03:27:57.838Z TOOL_RESULT The file /private/tmp/midturn-e2e/consumer/api/handlers.py has been updated successfully.
2026-10-08T03:28:00.374Z TOOL_USE Bash {"command": "echo second-done", "description": "confirm second step done"}
2026-10-08T03:28:00.438Z TOOL_RESULT second-done
2026-10-08T03:28:07.553Z TEXT REPORT: pointer_arrived=yes; when=after step 3; what_i_did=called room_state to check the message, read the file, then adjusted the Edit to include source="api" in the Order.from_payload call; relative_to_second_done=before; pointer_text=[room] 1 thing may need you: rohanz+producer sent a note. Call room_state; if it shows nothing new, they were already delivered: do nothing further. (#1)
2026-10-08T03:28:07.638Z command_lifecycle {... "command_uuid":"9ac1caab-742d-45c8-889c-17a536fe94b3","state":"completed" ...}
2026-10-08T03:28:07.640Z RESULT success turns 9
```

The raw sleep tool_result line (proof the tool was not interrupted):

```
2026-10-08T03:27:47.091Z {"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01D7at1ANcGnD2V2e3pC4kPv","type":"tool_result","content":"first-done","is_error":false}]},"parent_tool_use_id":null,"session_id":"81aeec06-c3e4-4665-a963-657c235c7521","uuid":"fe4b345e-6237-4450-9e2f-093105d34adf","timestamp":"2026-10-08T03:27:47.090Z","tool_use_result":{"stdout":"first-done","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false}, ...
```

Producer stream-json (key events):

```
2026-10-08T03:27:20.381Z TOOL_USE mcp__plugin_room_room__room_state {}
2026-10-08T03:27:20.441Z TOOL_RESULT ... participants (2 active): |   - rohanz+consumer · agent of rohanz · consumer · claude: working on api: annotate create_order (api/handlers.py) · areas api/ · working |   - rohanz+producer ... (you) ...
2026-10-08T03:27:22.330Z TOOL_USE mcp__plugin_room_room__room_scope {"area": "api", "paths": ["api/models.py"], "summary": "change Order.from_payload signature"}
2026-10-08T03:27:24.595Z TOOL_USE mcp__plugin_room_room__room_claim {"path": "api/models.py", "symbol": "from_payload", "intent": "add a required source parameter to Order.from_payload", "plans": [{"kind": "signature", "symbol": "Order.from_payload", "detail": "from_payload(cls, payload: Payload, source: str) -> Order"}]}
2026-10-08T03:27:24.602Z TOOL_RESULT api/models.py: no claim needed; nobody else is near this path
2026-10-08T03:27:28.477Z TOOL_USE Edit {... "old_string": "    def from_payload(cls, payload: Payload) -> \"Order\":", "new_string": "    def from_payload(cls, payload: Payload, source: str) -> \"Order\":"}
2026-10-08T03:27:31.719Z TOOL_USE mcp__plugin_room_room__room_send {"type": "note", "to": "rohanz+consumer", "text": "I changed Order.from_payload in api/models.py: it now requires a second argument source: str. Your call in api/handlers.py must pass it, e.g. Order.from_payload(payload, source=\"api\")."}
2026-10-08T03:27:31.733Z TOOL_RESULT sent [m_muyz76hajbki3f] [notify] rohanz+producer → rohanz+consumer: I changed Order.from_payload in api/models.py: ...
2026-10-08T03:27:33.146Z TOOL_USE mcp__plugin_room_room__room_done {"summary": "changed Order.from_payload signature (added source: str); told the consumer"}
2026-10-08T03:27:33.296Z TOOL_RESULT marked done (api); released 0 claim(s), scope cleared. You remain in the room.
2026-10-08T03:27:34.419Z RESULT success turns 9
```

`room-mcp.log` of the clone (`/tmp/midturn-e2e/consumer/.git/room-mcp.log`), run 3 slice, the lines that matter:

```
2026-10-08T03:26:53.803Z pid 92556 consumer: local room local/consumer: hub: granted rohanz+consumer to 81aeec06-c3e4-4665-a963-657c235c7521 at epoch 3756901024137216
2026-10-08T03:26:54.078Z pid 92556 consumer: rohanz+consumer joined local/consumer (clone /tmp/midturn-e2e/consumer)
2026-10-08T03:27:12.755Z pid 1238 producer: local room local/consumer: joined relay on 127.0.0.1:44212 (pid 92556)
2026-10-08T03:27:13.034Z pid 1238 producer: rohanz+producer joined local/consumer (clone /tmp/midturn-e2e/producer)
2026-10-08T03:27:31.754Z pid 92556 consumer: wake: woke claude session 81aeec06-c3e4-4665-a963-657c235c7521 via socket for note m_muyz76hajbki3f
2026-10-08T03:27:34.423Z pid 92556 consumer: local room local/consumer: hub: lease 3756901024137217 on rohanz+producer released
2026-10-08T03:27:50.565Z pid 92556 consumer: inbox → rohanz+consumer: [notify] rohanz+producer → rohanz+consumer: I changed Order.from_payload in api/models.py: it now requires a second argument source: str. ...
```

Resulting consumer diff (`consumer.diff`):

```
-    order = Order.from_payload(payload)
+    # calls Order.from_payload(payload)
+    order = Order.from_payload(payload, source="api")
```

Timeline, run 3:

| Event | Time (UTC) | Δ from send |
|---|---|---|
| Consumer `Bash` sleep tool_use | 03:27:01.545 | −30.2 s |
| Producer `room_send` reply "sent" | 03:27:31.733 | 0 |
| Consumer's Room MCP: `wake: woke … via socket` | 03:27:31.754 | +21 ms |
| Sleep tool_result `first-done`, `interrupted:false` (45.5 s after start) | 03:27:47.091 | +15.36 s |
| `command_lifecycle started` (inbox message injected into the running turn) | 03:27:47.098 | +15.37 s |
| Model text "A message arrived from a teammate" | 03:27:50.464 | +18.7 s |
| `room_state` call | 03:27:50.559 | +18.8 s |
| Edit with `source="api"` | 03:27:57.787 | +26.1 s |
| `echo second-done` | 03:28:00.374 | +28.6 s |
| Turn ends (`RESULT`) | 03:28:07.640 | +35.9 s |

Note on what the stream shows: Claude Code's stream-json does **not** echo the injected inbox message as a `user`
event. Its arrival is visible only as the `command_lifecycle` `started` event immediately after the tool result, plus the
model's own quotation of the text in its REPORT line, which matches the pointer format in
`packages/room-mcp/src/wake-reconciler.ts` (`[room] 1 thing may need you: rohanz+producer sent a note. Call room_state; …
(#1)`). The producer had already left the room (lease released 03:27:34) when the consumer read the note; delivery did not
depend on the producer staying online.

## Run 2: same result, with a contamination caveat

Same scenario, before the per-run `.git/room` reset. The consumer's `room_scope` reply at 03:25:00.023 already carried a
stale addressed note from the aborted run-2 attempt (`m_muyz2zsevbqwv3`, sent while that consumer was offline); Haiku
ignored it and proceeded. The live sequence then repeated run 3:

```
2026-10-08T03:25:06.550Z TOOL_USE Bash {"command": "python3 -c \"import time; time.sleep(45); print('first-done')\"", ...}
(producer) 2026-10-08T03:25:36.867Z TOOL_RESULT sent [m_muyz4pujsyt23d] [notify] rohanz+producer → rohanz+consumer: ...
(log)      2026-10-08T03:25:36.907Z pid 31028 consumer: wake: woke claude session be2cfb5c-0129-415e-9690-d29208eb1487 via socket for note m_muyz4pujsyt23d
2026-10-08T03:25:52.005Z TOOL_RESULT first-done
2026-10-08T03:25:52.008Z command_lifecycle {... "state":"started" ...}
2026-10-08T03:26:02.342Z TEXT A [room] message arrived. Checking room state.
2026-10-08T03:26:02.342Z TOOL_USE mcp__plugin_room_room__room_state {}
2026-10-08T03:26:12.283Z TOOL_USE Edit {... "new_string": "    # calls Order.from_payload(payload)\n    order = Order.from_payload(payload, source=\"api\")"}
2026-10-08T03:26:14.564Z TOOL_USE Bash {"command": "echo second-done", ...}
2026-10-08T03:26:19.751Z TEXT REPORT: pointer_arrived=yes; when=after step 3; what_i_did=room_state, Edit api/handlers.py with source="api" adjustment; relative_to_second_done=before
```

Send → socket 40 ms; tool returned uninterrupted after 45.5 s; injection 3 ms after the tool result; `room_state` 10.3 s
after injection (Haiku thinking). Because the stale note could have primed the model, run 3 was repeated clean; the
timing and behaviour match.

## Run 1: the idle path (Haiku backgrounded the sleep)

In the first run Haiku ran the sleep with `run_in_background: true` (the host blocks a foreground `sleep`; see Limits), so
the consumer's turn finished at 03:22:16.828 with its edit done and `pointer_arrived=no`, while the headless process stayed
alive waiting on the background task. The producer's note then woke the idle session:

```
(producer) 2026-10-08T03:22:32.507Z TOOL_RESULT sent [m_muyz0rlir99lb3] [notify] rohanz+producer → rohanz+consumer: ...
2026-10-08T03:22:32.509Z command_lifecycle {... "state":"started" ...}
(log)      2026-10-08T03:22:32.536Z pid 49417 consumer: wake: woke claude session d33e780c-03c9-4f20-af11-e3c003b5c80e via socket for note m_muyz0rlir99lb3
2026-10-08T03:22:41.614Z TOOL_USE mcp__plugin_room_room__room_state {}
2026-10-08T03:22:46.893Z TOOL_USE Edit {... "old_string": "    # calls Order.from_payload(payload)\n    order = Order.from_payload(payload)", "new_string": "    # calls Order.from_payload(payload)\n    order = Order.from_payload(payload, source=\"api\")"}
2026-10-08T03:22:50.411Z TEXT REPORT: pointer_arrived=yes; when=after step 5; what_i_did=called room_state, read api/handlers.py, called Edit to update Order.from_payload(payload) to Order.from_payload(payload, source="api"); relative_to_second_done=after
```

A new turn started within ~30 ms of the send; the fix landed 14 s later. This is the documented idle behaviour
(cross-session messaging: an idle session starts a turn), confirmed at Room level.

## Control: `ROOM_WAKE=off` in the consumer's environment

Same scenario, consumer session `7fd0b80f-ec33-4e8c-95fe-6c9c5d89366b`, room state reset first.

```
2026-10-08T03:28:31.170Z TOOL_USE Bash {"command": "python3 -c \"import time; time.sleep(45); print('first-done')\"", ...}
(producer) 2026-10-08T03:29:02.707Z TOOL_RESULT sent [m_muyz94oecwnlxn] [notify] rohanz+producer → rohanz+consumer: ... | rohanz+consumer cannot be woken in this session; it will see this at its next turn
(log)      2026-10-08T03:29:02.705Z pid 28129 consumer: wake: this claude session has no wake path; messages wait for its next turn
(log)      2026-10-08T03:29:06.185Z pid 28129 consumer: wake: not waking for note m_muyz94oecwnlxn in local/consumer: alone here; it stays in room_state
2026-10-08T03:29:16.486Z TOOL_RESULT first-done
2026-10-08T03:29:20.534Z TOOL_USE Edit {... "new_string": "    # calls Order.from_payload(payload)\n    order = Order.from_payload(payload)"}
2026-10-08T03:29:22.076Z TOOL_USE Bash {"command": "echo second-done", ...}
(log)      2026-10-08T03:29:22.986Z pid 28129 consumer: wake: not waking for contract cf:ecfd9419d7859c3b9fe4b62654bfa5af9f11b88771fa3151978f21ec95d0fa4d:1:9306f212-d605-4a3c-a8d0-e5233bc3fe87 in local/consumer: alone here; it stays in room_state
2026-10-08T03:29:25.279Z TEXT REPORT: pointer_arrived=no; when=none; what_i_did=none; relative_to_second_done=none; pointer_text=none
```

No `command_lifecycle started` event appeared after the tool result; the consumer never called a Room tool after the
sleep, so the note stayed owed. The producer's `room_send` reply itself told it the recipient "cannot be woken in this
session" (the consumer's awareness advertises `wakeUnavailable`). The before-edit hook did run on the consumer's Edit
(hook receipt `.git/room/hook-receipts/17d55d27….json` = `{"sessionId":"7fd0b80f-…","at":1791430160574}`, i.e.
03:29:20.574 UTC), but no `inbox →` delivery line was logged and the model reported no message; by then the producer had
left (03:29:06) and the room was "alone here". Whether the hook's own stdout mentioned the note is not visible in
stream-json (PreToolUse hook output is not emitted as an event; only `SessionStart` hooks appear). The consumer's diff
kept the old call `Order.from_payload(payload)`. Control result: as expected, nothing arrived until a Room tool reply or
hook would have carried it, and neither did before the turn ended.

## Limits hit (honest list)

1. **`sleep` is blocked as a foreground Bash command on Claude Code 2.1.293.** Verbatim tool error from run 2's first
   attempt: `<tool_use_error>Blocked: sleep 45 followed by: echo first-done. To wait for a condition, use Monitor with an
   until-loop (e.g. \`until <check>; do sleep 2; done\`). To wait for a command you started, use run_in_background: true.
   Do not chain shorter sleeps to work around this block.</tool_use_error>`. That is why Haiku backgrounded the sleep in
   run 1 (turning the probe into an idle-path test) and why the busy step became `python3 -c "import time;
   time.sleep(45); …"`, which the blocker does not match. The lead's raw host probe should be read with this in mind.
2. **Haiku follows the script only when told explicitly** to stay in the foreground; after that it followed every step
   and quoted the pointer verbatim. No fallback to Sonnet was needed. Every session also had to spend one `ToolSearch`
   call loading the deferred `mcp__plugin_room_room__*` schemas.
3. **Automatic changed-definition notice did not fire.** In every run both `room_claim` calls returned
   `no claim needed; nobody else is near this path` (the consumer had declared scope on `api/handlers.py`, the producer
   on `api/models.py`; neither counts as "near" the other's file), so the producer's signature plan was never
   registered and no `changed`/`plan` message reached the consumer. The addressed note was the only wake-bearing
   message, exactly the fallback the task anticipated. (In the control, a `contract` message was generated at
   03:29:22.986, right after the consumer's Edit of the old call, but it was held as "alone here".)
4. **The injected inbox message is invisible in stream-json.** Only `command_lifecycle started/completed` brackets it;
   the content is known from the model's quotation and from the pointer format in the source.
5. **Run-to-run contamination through the local relay memory.** Owed messages persisted in `.git/room` across runs
   (run 2 saw a stale note in its `room_scope` reply). Fixed by deleting `.git/room` before each run from run 3 on.
6. Minor: the driver's first run-1 launch failed on a `set -u` empty-array bug before the consumer started; it was rerun.
   The `hosho-local`, `plugin:github` MCP servers failed to connect in every session (unrelated to Room).

## Conclusion

With the current bundle, a busy Claude Code 2.1.293 consumer receives Room's content-free pointer over its own
cross-session inbox socket within tens of milliseconds of a teammate's `room_send`, the host holds it until the running
tool returns (the tool is never interrupted), then injects it between tool calls in the same turn; the consumer called
`room_state`, read the note and corrected its call before continuing. With `ROOM_WAKE=off` nothing reaches the model
within the turn. What this probe does **not** show: an automatic changed-definition notice (no claim was registered), or
delivery to an interactive (non-`-p`) session, which the lead's host probe covered.
