# Wave 2 review, Fable pass (2026-09-28)

Scope: `git diff a269f85 bd95790` (wave 2: `policy`, `writes`, `ledger`, lead fixes 2a25bd5 and 62c7f0c),
read against the ledger, registry, manifest, hub and reporooms specs and the redesign plan. Read-only; the
only file written is this one. An Astra pass runs in parallel on the same scope, so this pass looks at
design-level mismatches, user-visible behaviour and host integration.

How findings were checked:
- **Probe** means a script run against this tree (`/tmp/review2f-probes/probe1.mts`, `probe2.mts`, run with
  `npx tsx`, nothing in the repo changed). The output is quoted.
- **Docs** means the current Claude Code hooks reference, fetched 2026-09-28 from
  `https://code.claude.com/docs/en/hooks.md`. The host here is Claude Code 2.1.283.
- **Read** means the conclusion comes from reading the code only; nothing was run.

Tests run on this tree: `hooks`, `transport`, `worker-write-paths`, `policy-store`, `post` (room-mcp) and
`policy-publication` (roomd): 6 files, 132 tests, all pass. The full suite was not run.

Counts: 5 must-fix, 6 should-fix.

## Must-fix

### F-M1. After a quiet minute the before-edit hook says nothing: no claims, no "claim before editing", no inbox

- `plugins/room/hooks/before-edit.mjs:51-56`: `company` and `pending` both require `state.json` to be
  younger than 60 s; otherwise the hook exits before it contacts the MCP.
- `packages/room-mcp/src/hooks-bridge.ts:87-90,117-125`: `state.json` is rewritten only on a doc `update`
  or an awareness `change`. There is no timer.
- y-protocols re-sends an unchanged presence as `update`, not `change`, so a peer's heartbeat does not
  rewrite the file.

**Probe** (company present, peer heartbeats every 5 s, no edits):
`A state.at rewritten during 22001 ms of quiet with peer heartbeats: false`.

**Failure.** Kieran holds a claim on `api/tax.py` and thinks for 90 s. My agent also reads and plans for 90 s,
then edits `api/tax.py`. `state.json` is 90 s old, so the hook exits at line 56: no claim warning, no inbox,
no company line. The edit itself produces a doc update, so the *second* edit is warned; the first is not.
0.16.33 applied freshness only to pending notices and read claims from the file at any age
(`a269f85:plugins/room/hooks/before-edit.mjs:32-33`), so this is a regression.

The same gate hides the company line at SessionStart (`session-start.mjs:35-36`) after `/clear` or a resume in
a quiet room.

**Fix.** Either rewrite `state.json` on a timer while fenced and attached (every 20 s is enough), or make
the age gate apply only to the content-free "N messages pending" fallback: when `mcp.json` exists, ask the
endpoint whatever the file's age, and let the MCP answer with claims and company too. Add a test that lets
61 s pass with no doc update and expects the claim line.

### F-M2. A hook output over 10,000 characters is receipted but not shown

- `packages/room-mcp/src/tools/index.ts:133-143`: `hookSelect` selects everything owed, in both rooms, with
  no size limit (the owed set can hold 200 messages and 256 KiB).
- `plugins/room/hooks/before-edit.mjs:115-119` and `session-start.mjs:52-54`: the hook prints one
  `additionalContext` and confirms when the write succeeds.

**Docs** (hooks.md, "JSON output"): "A hook's `additionalContext`, `systemMessage`, and `initialUserMessage`
strings, and its plain stdout, are capped at 10,000 characters … Over the limit: Claude Code saves the output
to a file in the session directory and replaces it with the file path and a preview of up to the first 2,000
characters … Claude Code doesn't ask Claude to read the file."

Seen live in this review session (2.1.283): a before-edit output of 10.4 KB, made of near lines only, arrived
as `Output too large (10.4KB) … Preview (first 2KB)`.

**Failure.** Pat returns after a day with 30 owed messages, or has 3 owed messages in a busy room where the
"Claim before editing" line alone is 10 KB. The hook prints, stdout accepts the bytes, the hook confirms, and
the MCP writes `via: 'hook'` receipts for every item. The model sees the first 2,000 characters. Everything
after that is receipted and never offered again. This breaks R2a (loss is never acceptable) on a normal path.

**Fix.**
1. Give `hookSelect` a character budget (about 6,000 for items and notices): select in priority order until
   the budget is reached, leave the rest owed, and add "N more: call room_state".
2. In the hooks, cap the coordination lines (near, claims) so the total stays under 10,000, with the inbox
   first. If the total would still exceed the cap, print without the inbox and do not confirm.
3. Test: 40 owed messages of 500 characters produce an output under 10,000 characters, and the unselected
   ones are still owed afterwards.

Tool replies have the same shape of risk (Claude Code truncates large MCP results), so the reply inbox should
share the budget.

### F-M3. Hook calls made inside a subagent take the main session's inbox

- `plugins/room/hooks/before-edit.mjs:61`: every PreToolUse call selects, whoever made the tool call.

**Docs** (hooks.md): "Hooks from settings files, managed policy settings, and plugins also run inside
subagents … the input carries the `agent_id` and `agent_type` common input fields", and `agent_id` is
"Present only when the hook fires inside a subagent call". `session_id` is the main session's, so the MCP's
`bound.id === req.sessionId` check passes.

**Failure.** The lead's Claude session starts an Explore or general-purpose subagent. The subagent runs
`Bash`. The hook selects the addressed question from Kieran, prints it into the *subagent's* context and
confirms. The main conversation, which is the participant, never sees the question; the subagent returns a
summary about something else. The receipt exists, so nothing offers the question again.

0.16 delivered to subagents too, but it had no receipt contract; the ledger now records this as delivered.

**Fix.** When `ev.agent_id` is set, do not select: print claims and near lines only, plus the content-free
"N messages pending" line from `state.json`. Add a hook test with `agent_id` in the event.

### F-M4. An abandoned or retired record with the same tag hides the live worker

- `packages/room-mcp/src/worker-registry.ts:398`: `trusted()` takes the first record in `list()` whose tag or
  name matches, then returns `undefined` at `:400-401` if that record is `abandoned`, `retiring` or
  `retired`. `list()` is in file-name order, so the oldest record wins.
- `packages/room-mcp/src/registry.ts:280-281`: `resumeWorker` does the same with `find(record => record.tag
  === w.tag …)` and answers "was collected or discarded; it cannot resume".
- Registry §1 says the opposite order: "resolves through the lead's own tag reservation, then the record".

**Probe:**
```
B first record phase: abandoned
B trusted(tests) after re-spawn -> undefined (no capability)
B list order: w_01:abandoned, w_02:active
B control (abandoned record removed) -> w_02
```

**Failure.** `room_spawn tag=tests` fails once (a worktree error, a cancelled call, a missing host binary), so
`w_01` is `abandoned`. The lead spawns `tests` again and it runs as `w_02`. From then on `room_collect
tag=tests`, `discard=true`, a stop at shutdown and `room_send` to the finished worker all answer "no local
worker capability" or "cannot resume". The worker's output cannot be collected through Room, and the worker
cannot be stopped.

**Fix.** Resolve the tag through `tags/<tag>.json` to an id and read that record; match by name only among
records whose reservation points at them. Same for `resumeWorker`'s `known` and for `missingCapability` and
`holdingWorker` in `tools/collect.ts:77,85`. Test: abandon, re-spawn, then collect.

### F-M5. `room_spawn dir=…` whose launch fails leaves a record that holds a capacity slot and its tag for good

- `packages/room-mcp/src/worker-registry.ts:778-781`: `rollbackPreparation` derives the lead checkout as three
  levels above `record.dir` and throws `unsafe preparation path` when the directory is not
  `.room/workers/<tag>`. A supplied `dir` never is.
- `:811-816`: `abandonPreparation` calls it for phase `prepared` before writing `abandoned`, so the throw
  leaves the phase unchanged.
- `packages/room-mcp/src/tools/workers.ts:227-229`: the not-launched path calls `abandonPreparation`; its
  throw reaches the outer `catch` at `:262-264`, which calls it again, logs, and returns the *rollback* error.

**Probe:**
`C abandonPreparation threw: unsafe preparation path for w_03 | phase stays prepared | status starting | occupancy 2`

**Failure.** `room_spawn tag=ext dir=/work/other allowOutside=true host=codex` on a machine where `codex` is
not on PATH.
- The reply is `error: unsafe preparation path for w_…`, not "could not start codex".
- The record stays `prepared` with no launch: `starting` while the lead lives, `ambiguous` after it exits.
  Both count in `occupancy()` (`:445`), so each such failure removes one worker slot permanently.
- The tag stays reserved, and `trusted()` refuses the record (not an owned worktree), so `room_collect
  discard=true` cannot clear it.

**Fix.** Roll back only what the journal says this spawn created: when `prep.created !== true`,
`prep.branchCreated !== true` and there are no `previousCarryRefs`, skip the path check and write
`abandoned`. Return the launch error, not the cleanup error. Test: supplied directory, spawner that throws.

## Should-fix

### F-S1. `declared` → `full` → `declared` drops the declared area while the scope is still shown

- `packages/room-mcp/src/policy-store.ts:111-113`: leaving `declared` replaces the whole grant with
  `emptyGrant()`, `active` included. Manifest §5.1 says that write "clears `ending` and `retained`".
- `packages/room-mcp/src/tools/share.ts:41`: the "nothing is shared until room_scope" warning is printed only
  when there is no scope. Here the scope still exists.
- `packages/room-mcp/test/policy-fixture.ts:29` copies the same behaviour, so tests agree with it.

**Probe:** `D declared prefixes: declared [ 'src/' ]`, then
`D after full -> declared: declared []`.

**Failure.** A person says "share everything", later "only my declared files". The reply is "changed sharing
full -> only files in your declared area", `room_state` shows the scope on `src/`, and no file text is
shared: every entry is `held: 'scope'`. Teammates' previews turn PARTIAL with no explanation on either side.
The same happens through `intent`.

**Fix.** Keep `active` on a level change (clear `ending` and `retained` only), or rebuild `active` from
`scopes[me]` when the level returns to `declared`. Fix the fixture too.

### F-S2. A discard refused after its plan was written is retried automatically

- `packages/room-mcp/src/tools/collect.ts:201` (a nested worker could not be disposed of), `:212` ("could not
  discard") and `:224` (process could not be verified) return after `beginDiscard` at `:194` without
  `interruptDiscard`. The `finally` releases the op lease, and the phase stays `discarding`.
- `packages/room-mcp/src/worker-registry.ts:837-842`: reconcile (every 30 s) replays any `discarding` record
  with no live op lease, under the recorded `force`.
- Registry §10.4: a refusal after commit "sets `interrupted` and restores `active`. It is not retried
  automatically."

**Failure (read).** The lead runs `room_collect tag=api discard=true`; the reply is "could not verify api's
process (pid 4242); left running, not stopped". Thirty seconds later reconcile resumes the discard, signals
the process when it can verify it, saves the patch and deletes the worktree. The lead was told the worker was
left running. Until then the worker shows as `collecting`, and resume and collect refuse it.

**Fix.** Call `interruptDiscard` on those three returns (the `catch` at `:270-272` already does).

### F-S3. A worker's completion is never announced when its `room_done` post is refused

- `packages/room-mcp/src/tools/workers.ts:73-82`: `reportDone` is written and claims are released, then the
  post; a refusal returns "error: could not record worker report: not sent: hub unreachable".
- `packages/room-mcp/src/worker-registry.ts:603-614`: the lead's exit callback posts only for status
  `failed`. With a `done` report the status is `done` (row 10), so it posts nothing.
- Registry §7 gives this to the projector, which is wave 3.

**Failure (read).** The relay restarts while a worker calls `room_done`. The worker gets the error and, being
headless, ends its turn. The report says done, `posted` is absent, no `wk:<id>:1` message exists, and the
lead's `room_wait` runs to its timeout with "1 worker still running" or "nothing new".

**Fix.** In the exit callback, when the run has a `done` report and neither `report.posted` nor
`runs[n].posted`, post `completionMessage` and set `runs[n].posted`. The deterministic id makes a double post
harmless. Also word the worker's error so it retries: "report saved; your lead has not been told yet, call
room_done again".

### F-S4. A collected or discarded worker's tag cannot be used again in wave 2

- Nothing in this tree moves a record from `retiring` to `retired` or sets `cleanup[room] = 'done'`
  (`finishCollect` `worker-registry.ts:623-626`, discard `:740`, `collect.ts:171,268`). That step belongs to
  wave 3's projector.
- The tests assert the result: `packages/room-mcp/test/workers.test.ts:1234-1236` expects "tag in use: money"
  after a completed discard.

**Failure.** Spawn `tests`, collect it, spawn `tests` again: "tag in use: tests", in every later session of
the clone. 0.16 allowed this, and batch leads reuse tags such as `review` and `tests`.

**Fix.** Until the projector exists, let the session that ran `retireCollected` mark that room's cleanup done
and finish the retirement (release the tag by compare-and-release). If the lead prefers to wait for wave 3,
record it in the plan as a known state of the branch between waves, and make the message say why: "tests was
collected; its cleanup has not finished".

### F-S5. A follow-up to a finished worker is delivered before the room accepts the message

- `packages/room-mcp/src/tools/messaging.ts:164-179`: `resumeWorker` launches the host with the text, then
  `s.post` runs. On a refusal (`:177`) the reply is "not sent: hub unreachable" followed by "resumed X's
  retained conversation with your message".

**Failure (read).** With the hub unreachable the lead is told both things. The worker acts on the follow-up;
the room has no record of it, the question cannot be answered with `inReplyTo`, and a retry resumes the
worker a second time with the same text.

**Fix.** Refuse before launching when `s.hub.paused()` (after one `hello` attempt), or post first and resume
with the posted id in `promptMsgIds`, which wave 4 needs anyway.

### F-S6. The wave-2 rehearsal "Codex queue wake: no duplicate" cannot pass at this commit

- `packages/room-mcp/src/hooks-bridge.ts:180-188` still queues `formatMsg(m)`, the full text.
- The message stays owed, so the next tool reply or hook shows it again. That is the 2026-09-27 duplicate.
- The plan lists this rehearsal under wave 2; the content-free wake is wave 3 (`WakeReconciler`).

**Fix.** Move the rehearsal to wave 3 in `2026-09-28-redesign-plan.md`, or make the queue text a pointer now
("[room] 1 thing needs you: Kieran question. Call room_state; it shows it."), which is a two-line change.

## Notes

- **Hook output format, checked against the docs.** `hookSpecificOutput.additionalContext` is valid for both
  PreToolUse and SessionStart. The Claude matcher `Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell` has only
  letters and `|`, so it is an exact list. A PreToolUse command hook that reaches its 5 s timeout is
  cancelled, its output is discarded and the tool call continues; the hook then never confirms, so its batch
  expires and the items are offered again. `plugins/room/hooks.json` and `hooks/claude.json` are unchanged
  in this diff.
- **The fence is not active yet.** `Ledger.fenced` (`ledger.ts:69-72`) is true when no `holder` is recorded,
  and nothing writes `holder` before wave 4. Every "fenced" path in wave 2 is unfenced in practice. After
  wave 4, check `/clear`: the binding's id changes within 1 s, and the ledger stops delivering until the
  holder is re-acquired under the new session id.
- **`commitPrompt` is a lead-side, unfenced write to the worker's `seen` map** (`ledger.ts:133-135`), before
  host acceptance. The code says it is transitional; it should be on the wave-4 `resume` worker's list.
- **`busFrontier` holds every bus id** (`tools/workers.ts:166`, `registry.ts:304`), up to 2,000 ids in a
  record that is rewritten on every update, and only the last is read (`worker-mirror.ts:12`). With an empty
  bus at spawn, `at(-1)` is `undefined`, which `seedFrontier` (`ledger.ts:249-256`) reads as "the bus at first
  bind", not "nothing below the frontier": broadcasts posted between spawn and the worker's join are hidden
  from it. Wave 3's seq removes both.
- **`hook.json` is written before stdout** (`before-edit.mjs:114`, then `:117`). If the write fails, the
  company line and the claim lines are recorded as told and are not repeated. It is the same order the
  ledger spec rejects for messages (MF5); low impact, since claims repeat when their evidence changes.
- **`writeIntent` can leave a tag reserved with no record** (`worker-registry.ts:475-478`) when the op lease
  or record create fails after the tag was taken. The holder is alive, so the tag reads "being spawned" until
  that process exits.
- **The shell-write heuristic treats any `>` as a write** (`common.mjs:198`), so `2>&1` and `awk 'NR>=5'`
  count. This is older than wave 2, but it is what makes the near line large enough to reach F-M2's cap.
- **Not reviewed in depth:** `worker-git.ts`, `worker-config.ts`, `bridge.ts`, `conflicts.ts`, the roomd test
  changes and the hub client. `roomd/src/index.ts` was read for the HEAD transition and `applyInputs` only;
  nothing was found there.
