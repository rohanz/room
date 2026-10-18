# Whole-redesign review — delivery + hub — 2026-09-29

**Diff:** `git diff 8097a8b c449f3e`; worktree pinned to `c449f3ec5d42d030109a5145da0d00a192eb59a8`.
**Counts:** **2 Must-fix, 2 Should-fix**. All four have socket-free reproduction probes. No source files changed; no commit.

Reviewed the delivery ledger, hub engine and adapters, lease/sequence boundaries, post and inbox paths, hooks/arbitration, wakes, resume receipts and roomagent against the binding redesign plan, ledger and hub specs. Prior review dispositions were checked; the findings below are additional end-to-end gaps, not repetitions of findings marked resolved.

## Must-fix

- **M1 — Resume receipts messages whose content was never put in the prompt. Owner area: delivery/resume.**
  **Locations:** `packages/room-mcp/src/tools/messaging.ts:185`, `:188`; `packages/room-mcp/src/registry.ts:289`, `:300`; `packages/room-mcp/src/worker-launch.ts:81`; `packages/room-mcp/src/ledger.ts:154`; `packages/room-mcp/src/worker-projector.ts:40`.

  A retained worker has an unread question from a teammate. Its lead sends a new follow-up. The messaging handler saves **every** owed addressed message ID in `promptMsgIds`, but passes only the new follow-up's raw `text` to `resumeWorker`. The launch path sends that string, optionally followed by a port notice; it never renders the other selected messages. The worker's ledger suppresses all these IDs from ordinary delivery, then receipts them all on its first Room action. The no-call projector does the same on matching host acceptance evidence. Thus the old question disappears from owed delivery without any handoff of its content, violating R2/R2a and the ledger's resume contract. Correct D4 acceptance evidence does not establish that omitted content was delivered.

  **Probe:** used the actual messaging handler, registry, launch command construction and ledger, with an existing retained-worker fixture, a fake spawned host and a stubbed port reservation. Seeded `OLD_SECRET_QUESTION`, then sent `NEW_FOLLOW_UP`. Both IDs entered `promptMsgIds`; the captured launch arguments contained the new text and lacked the old text. Calling the admitted worker's actual `acceptPrompt` wrote a prompt receipt for the unseen old question. The probe passed by asserting this failure.

  **Fix direction:** construct one explicit delivery payload containing the exact messages selected for the resume, including IDs, sender and reply metadata, and persist only the IDs represented in that payload. Pass that payload through the launch boundary. If prompt size excludes a message, leave its ID out of the prompt reservation so ordinary delivery can still show it. Test backlog plus follow-up through both worker-MCP and no-call projector acceptance, and retain the rejected-resume no-receipt tests.

- **M2 — roomagent abandons an unaccepted turn until unrelated activity arrives. Owner area: delivery/roomagent.**
  **Locations:** `packages/agent/src/runner.ts:193`, `:267`, `:283`; retry selection at `:179`.

  An addressed question wakes an idle runner. `nextBatch` removes it from the queue, then the backend rejects before `turn.started`, for example during a temporary backend failure. No receipt is written, correctly, but `finally` removes the queued ID and schedules a retry only if the name epoch changed. With a healthy, unchanged lease the runner becomes idle indefinitely. The existing bus item is not inserted again, so recovery of the backend alone cannot deliver it. Another human message, bus event, reconnect or restart must rescue the owed question. This leaves the end-to-end at-least-once path incomplete despite the correct receipt boundary.

  **Probe:** drove the actual Runner with a valid authority and a backend that throws before invoking the acceptance callback. After the initial turn drained and ten seconds of fake time, the backend had exactly one call, the queue was idle and the question remained owed. No transport or host process was required.

  **Fix direction:** track whether the turn's message payload reached the acceptance boundary; on an unaccepted failure, rederive/requeue still-owed messages and retry with bounded backoff while respecting explicit pause/stop. Retry selection should cover still-eligible broadcasts as well as addressed mail. Avoid retrying already-receipted content merely because execution failed after acceptance. Add a reject-once/accept-next test requiring eventual delivery without any new room event.

## Should-fix

- **S1 — A 100-second room_wait stops selecting messages after 60 seconds. Owner area: delivery/inbox.**
  **Locations:** `packages/room-mcp/src/ledger.ts:17`, `:80`, `:97`; `packages/room-mcp/src/tools/index.ts:172`; `packages/room-mcp/src/tools/messaging.ts:227`, `:299`.

  The wrapper opens a reply batch with a 60-second timer before running the handler, while `room_wait` supports 100 seconds. Expiry marks that batch settled; every later `available` call returns an empty array. An answer arriving at second 61 therefore cannot end the wait, and the timeout's inbox also cannot select it. The pending-wait predicate meanwhile tells the wake reconciler that this wait will consume the answer. The call can finish at second 100 saying “no answer” although the answer is already owed locally. Any other tool that takes longer than the batch lifetime also loses its reply's inbox opportunity.

  **Probe:** the actual messaging handler and Ledger, with their default 60-second batch and a 100-second wait, received the matching answer at second 61 under fake timers. At second 100 the result said “no answer”; ledger candidates still contained that answer. No receipt was lost, but the advertised wait and wake suppression were wrong.

  **Fix direction:** separate the lifetime of the response builder from the lease of an actual reservation. Start/renew the reservation deadline when content is selected, or replace an expired empty batch while the handler remains active. Ensure a pending wait suppresses wakes only while it can actually consume the message. Keep expiry/reclaim behavior for genuinely abandoned selections and late confirmed handoffs.

- **S2 — Live receipt maps never prune IDs whose retained messages have gone. Owner area: delivery/ledger.**
  **Locations:** `packages/room-mcp/src/ledger.ts:132`, `:156`; `packages/shared/src/doc.ts:478`; snapshot-only filtering at `packages/shared/src/memory.ts:66`.

  The binding ledger spec's “Receipt retention follows references” requires the fenced holder to prune its receipt map to IDs in `bus ∪ mail ∪ outcomes`. Live receipt writers only add entries; no production holder path performs that pruning. `memorySnapshot` filters a separate snapshot, which does not remove entries from the running Y.Doc or the hosted LevelDB document. A long-running room therefore accumulates receipts for every delivered message, even after its bounded history and archive have rotated away. This defeats the intended live retention boundary and contributes to eventual room-size rejection.

  **Probe:** delivered 2,100 broadcast messages through a real Ledger, trimmed the bus to zero and exercised selection/commit again. `bus` and `mail` were empty and no outcomes referenced the IDs, but all 2,100 receipts remained in `seen:reader`. A production-source search found receipt insertion and worker-retirement clearing, but no holder-owned reference pruning.

  **Fix direction:** prune unreferenced receipts under the current holder's fence after relevant trim/reference changes and on bind/reconciliation. Preserve receipts while bus, mail or outcomes still reference them; do not move receipt ownership to the hub. Cover steady-state live documents, not just value-copy snapshots.

## Verification and boundaries

- **135 existing tests passed**, covering hub contracts/counters/expiry, protocol, HubClient TTL/retries, shared delivery and snapshots, transport handoff, cursor persistence, resume log evidence, Runner authority, reply failure/budget handling, post refusals, server persistence draining and six wake-reconciler cases. Four additional disposable probes reproduced M1/M2/S1/S2. Runs were staggered with one Vitest worker; `nice -n 10` was requested but the sandbox refused the priority adjustment.
- One existing post integration test was **blocked by `listen EPERM`**; its real-relay socket path was not verified. Eleven other wake-path cases were deliberately excluded when selecting the six socket-free reconciler tests. No live host, authority-kill, socket arbitration or server restart rehearsal was claimed. Temporary probe scripts/configuration and their fixtures were removed.
- `git diff 8097a8b c449f3e -- plugins/room/hooks.json` is **empty**. Hook scripts obtain message content from live MCP arbitration, confirm after the stdout callback and leave failed/unconfirmed batches owed. Current hook/reply size guards and the error-reply discard path are present; the previously resolved failures were not re-reported.
- Hub inspection and the passing core/client tests support durable serialized incarnation allocation, counter rollover, fresh takeover TTL/settlement, late terminal-record handling, lease reassertion, per-send post fencing and content-free wakes. Relay authority checks remain before grants and ticks; generation-2 discovery is separate. Server startup awaits document load, and hub-origin writes retain the distinct path through `bindHub`. This is offline evidence, not a substitute for the unavailable process/socket rehearsals. No additional counter-repeat or dual-authority defect was established.
- The ledger/hub deletion lists were checked: old per-handler/local-hook message ledgers, `syncHookSeen`, pending-notice locks, old content-bearing wake router, client append, fold-ledger writer, trim-leader election and roomd trim timer are absent from active production paths. Legacy filenames remain in the explicit one-time migration reader, not as active receipt authorities. S2 concerns missing replacement retention behavior rather than resurrected legacy code.

**Room coordination:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `c449f3ec5d`. Only this review is retained from the task; no combined-source test was needed for the report-only output.
