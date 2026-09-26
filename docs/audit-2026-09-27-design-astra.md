Audited HEAD `982515ce6cec30ffbfd37cb74f5787ec8fdcaaec`. No edits, builds, network access, or filesystem-writing tests. I checked imports with the installed TypeScript parser and reproduced the snapshot deletion problem entirely in memory.

The recurring problem is unclear ownership: replicated observations also serve as authorization, process control records, delivery acknowledgements, and recovery state.

## Findings, ranked by consequence

### 1. Collection has rollback, but no recoverable transaction

**Severity:** design-P1 · **Before the trial**

**Where:** [collect.ts:354](../packages/room-mcp/src/tools/collect.ts:354), [collect.ts:373](../packages/room-mcp/src/tools/collect.ts:373), [files.ts:313](../packages/room-mcp/src/tools/files.ts:313)

Original file contents exist only in the MCP process’s memory while collection overwrites the lead’s checkout. Writes truncate destination files directly, and rollback requires that same process and filesystem to remain operational.

**Failure:** The host kills MCP halfway through collection, leaving a partially applied merge. Disk exhaustion can also interrupt a write and prevent its rollback; copy mode has no equivalent rollback.

**Smallest change:** Give collection a durable journal containing original bytes, modes, expected hashes, and operation phase before writing anything. Use temporary files and rename for each replacement; recover unfinished transactions before permitting another collection.

### 2. Replicated worker records authorize local operations

**Severity:** design-P1 · **Before the trial**

**Where:** [registry.ts:365](../packages/room-mcp/src/registry.ts:365), [registry.ts:412](../packages/room-mcp/src/registry.ts:412), [context.ts:158](../packages/room-mcp/src/tools/context.ts:158), [worker-launch.ts:78](../packages/room-mcp/src/worker-launch.ts:78)

Worker directory, host session, identity, and lifecycle information come from the shared document. Resume uses those fields to launch a process, while disconnected-worker reads accept the document’s directory as their containment root; the launch itself precedes recording its result.

**Failure:** An altered worker record can redirect a later read or resume. Independently, killing MCP after process creation but before recording it leaves a detached worker without a reliable recovery record.

**Smallest change:** Maintain a durable, local worker registry that authorizes directories and host sessions and records launch intent before spawning. Publish a status projection into the CRDT; shared records must not create local capabilities.

### 3. Scope combines authorization, coordination, and publication state

**Severity:** design-P1 · **Before the trial**

**Where:** [bridge.ts:39](../packages/room-mcp/src/bridge.ts:39), [bridge.ts:108](../packages/room-mcp/src/bridge.ts:108), [bridge.ts:193](../packages/room-mcp/src/bridge.ts:193), [state.ts:91](../packages/room-mcp/src/tools/state.ts:91), [publisher.ts:86](../packages/roomd/src/publisher.ts:86)

The bridge overwrites the lead’s scope with a worker union, preserving the actual sharing authorization only in memory and an overridden daemon method. Readers independently infer availability from awareness and current scope, although the publisher deliberately retains completed changes outside that scope.

**Failure:** After an unclean restart, the daemon can encounter the persisted union before join cleanup and bridge reconstruction. Conversely, `room_done` can leave a file correctly published while `room_read` rejects it as outside the now-cleared scope.

**Smallest change:** Separate three records: the owner’s sharing authorization, the derived coordination scope, and the manifest of published paths. Readers should use the manifest; the bridge should never overwrite sharing authorization.

### 4. Local snapshots discard causality but reconnect old replicas

**Severity:** design-P1 · **Before the trial**

**Where:** [shared/memory.ts:23](../packages/shared/src/memory.ts:23), [relay/memory.ts:57](../packages/relay/src/memory.ts:57)

Persistence copies current values into fresh Yjs structures, discarding deletion history and original identities. Surviving replicas subsequently merge their old structures into that new document; recovery deduplicates two arrays but does not reconcile map deletions.

**Failure:** A disconnected replica restores a removed scope or worker after relay restart. The in-memory check reproduced a deleted worker becoming present again; later retirement repair cannot provide a general solution for all maps.

**Smallest change:** Preserve causal checkpoints for recovery. If compact value snapshots remain necessary, introduce an explicit document epoch and rebuild reconnecting clients from that epoch instead of merging old CRDT state into it.

### 5. The activity feed doubles as an unreliable mailbox

**Severity:** design-P1 · **Before the trial**

**Where:** [join.ts:90](../packages/room-mcp/src/tools/join.ts:90), [messaging.ts:304](../packages/room-mcp/src/tools/messaging.ts:304), [hooks-bridge.ts:327](../packages/room-mcp/src/hooks-bridge.ts:327), [doc.ts:455](../packages/shared/src/doc.ts:455)

Joining suppresses existing messages except a narrow worker-briefing case, while delivery paths mark messages seen before the recipient demonstrably receives them. Feed trimming preserves unanswered questions but can remove unread answers, interrupts, and completion messages without consulting receipts.

**Failure:** An offline participant receives a question, returns, and never sees it in its inbox—even though the sender was promised delivery on return. A killed tool response or queued-but-unconsumed wake can produce the same loss.

**Smallest change:** Separate pending delivery from bounded history. Keep addressed messages until recipient acknowledgement, distinguish queued from delivered, and reconcile pending deliveries at join and reconnect.

### 6. Hook state is checkout-scoped while delivery is session-scoped

**Severity:** design-P1 · **Before the trial**

**Where:** [session-start.mjs:18](../plugins/room/hooks/session-start.mjs:18), [common.mjs:34](../plugins/room/hooks/common.mjs:34), [hooks-bridge.ts:237](../packages/room-mcp/src/hooks-bridge.ts:237), [hooks-bridge.ts:293](../packages/room-mcp/src/hooks-bridge.ts:293)

Multiple sessions in one checkout overwrite the same session and hook-state files. Each bridge rereads the latest session identity and can label its own participant’s inbox with another session’s identity.

**Failure:** Session B starts after A; A subsequently queues its addressed message into B’s thread and marks it seen for A. The state-file lock serializes writes but does not establish which session owns them.

**Smallest change:** Key hook state, activity, receipts, and notices by immutable host session ID. Bind each MCP connection to that ID explicitly; retain checkout identity only for shared disk publication.

### 7. Worker coordination locks have a smaller scope than their resources

**Severity:** design-P1 · **Before the trial**

**Where:** [doc.ts:101](../packages/shared/src/doc.ts:101), [workers.ts:109](../packages/room-mcp/src/tools/workers.ts:109), [registry.ts:282](../packages/room-mcp/src/registry.ts:282), [collect.ts:423](../packages/room-mcp/src/tools/collect.ts:423)

Worker records are room-global entries keyed by bare tag, while reservations belong to one MCP process and incorporate the lead identity. Collection similarly serializes a checkout only within one process.

**Failure:** Two leads concurrently spawn `tests`; both pass their local checks and launch, then one shared record wins. Two MCP sessions can also collect separate workers into the same checkout concurrently despite both reporting serialized collection.

**Smallest change:** Key workers by immutable globally unique IDs, with lead-scoped tag aliases. Protect checkout mutations and worker operations through a cross-process ownership mechanism, such as a checkout supervisor or filesystem leases with recovery.

### 8. HEAD tracking records success before reconciliation succeeds

**Severity:** design-P1 · **Before the trial**

**Where:** [roomd/index.ts:721](../packages/roomd/src/index.ts:721), [roomd/index.ts:728](../packages/roomd/src/index.ts:728)

`pollHead` advances its remembered HEAD before refreshing tracked files, publishing the new baseline, reconciling overlays, and reanchoring claims. A subsequent poll sees the same HEAD and skips that transition even when part of it failed.

**Failure:** A transient Git failure after a commit leaves old overlays or claim anchors associated with a partially advanced baseline. Readers can also observe the new base before the corresponding overlay reconciliation finishes.

**Smallest change:** Track desired HEAD separately from successfully applied HEAD. Retry the complete transition until successful, and publish a revision boundary that lets consumers distinguish complete baseline/overlay state from an update in progress.

### 9. Publication still requires observing every relevant filesystem event

**Severity:** design-P1 · **Before the trial**

**Where:** [roomd/index.ts:434](../packages/roomd/src/index.ts:434), [roomd/index.ts:972](../packages/roomd/src/index.ts:972), [roomd/index.ts:1063](../packages/roomd/src/index.ts:1063), [publisher.ts:88](../packages/roomd/src/publisher.ts:88)

The initial scan precedes watcher establishment, and periodic tracked-file refresh checks membership rather than changed contents. Scope retention also considers only changes already known through overlays, queued events, or in-flight work.

**Failure:** An edit during startup or a missed watcher event remains unpublished indefinitely when HEAD and file membership stay unchanged. An edit immediately followed by scope completion can escape retention if its event has not arrived.

**Smallest change:** Treat watcher events as prompts for reconciliation, not evidence that the disk is fully observed. Reconcile Git changes after watcher readiness and periodically; preserve departing scope authorization until its final disk reconciliation completes.

### 10. Conflict detection evaluates events rather than maintaining current conflicts

**Severity:** design-P1 · **Before the trial**

**Where:** [conflicts.ts:115](../packages/room-mcp/src/conflicts.ts:115), [conflicts.ts:291](../packages/room-mcp/src/conflicts.ts:291), [conflicts.ts:368](../packages/room-mcp/src/conflicts.ts:368), [claims.ts:167](../packages/room-mcp/src/tools/claims.ts:167)

Merge checking is driven by overlay events, without an initial merge reconciliation or equivalent invalidation for every base, deletion, and presence change. Claim conflict observation likewise handles remote additions, while several reporting sets suppress previously reported combinations for the process lifetime.

**Failure:** Two conflicting overlays already exist when the watcher starts, or a participant returns without changing its overlay; no new merge warning is scheduled. A resolved and recurring overlap can also remain suppressed.

**Smallest change:** Maintain a derived conflict set keyed by participant, path, and input revisions. Reconcile it on startup, reconnect, and all relevant state changes; generate notifications from changes to that set.

### 11. The server cannot enforce document policy without compromising synchronization

**Severity:** design-P1 · **After a trusted three-person trial; before broader access**

**Where:** [server/index.ts:50](../packages/server/src/index.ts:50), [readonly.ts:234](../packages/server/src/readonly.ts:234), [readonly.ts:269](../packages/server/src/readonly.ts:269), [readonly.ts:310](../packages/server/src/readonly.ts:310), [readonly.ts:330](../packages/server/src/readonly.ts:330)

Admission and awareness identity are enforced, but member document ownership is audit-only by default because dropping updates can break causal synchronization. Experimental enforcement still permits foreign deletions and selected forged `room` messages; the size cap independently drops writes without an application-level rejection.

**Failure:** An admitted client can alter another participant’s coordination state. At the size cap, a client can remain connected and locally report successful actions that peers never receive.

**Smallest change:** Put policy-bearing mutations behind validated, authenticated operations applied by the server, or isolate independently authorized documents. Rejected writes need explicit failure and resynchronization semantics; enabling the current experimental guard is not a complete fix.

### 12. Any joining client can garbage-collect another participant’s work using its own clock

**Severity:** P2 · **After the trial**

**Where:** [join.ts:318](../packages/room-mcp/src/tools/join.ts:318), [doc.ts:265](../packages/shared/src/doc.ts:265), [roomd/index.ts:659](../packages/roomd/src/index.ts:659)

Staleness compares a writer-generated timestamp with the joining client’s clock and treats absent awareness as permission to delete overlays. The owner repairs mistaken deletions when live, creating a delete-and-republish protocol instead of a single garbage-collection authority.

**Failure:** A clock-skewed joiner sees a temporarily disconnected participant as old and removes its shared work. Until the owner reconnects and repairs it, everyone else sees incomplete coordination state.

**Smallest change:** Make stale hiding a local view decision. Reserve destructive expiry for one authority using its own observation times and an explicit retention policy, or for the owner’s retirement operation.

### 13. File splitting has left a broad service interface and two runtime cycles

**Severity:** P2 · **After the trial**

**Where:** [context.ts:62](../packages/room-mcp/src/tools/context.ts:62), [state.ts:135](../packages/room-mcp/src/tools/state.ts:135), [registry.ts:19](../packages/room-mcp/src/registry.ts:19), [worker-launch.ts:5](../packages/room-mcp/src/worker-launch.ts:5), [claims.ts:3](../packages/shared/src/claims.ts:3), [format.ts:1](../packages/shared/src/format.ts:1), [messages.ts:1](../packages/shared/src/messages.ts:1)

Every handler receives a broad interface spanning messaging, workers, sharing, claims, Git, and lifecycle. Runtime cycles remain between registry and launcher, and between shared claims, formatting, and messages.

**Maintenance cost:** Moving a lifecycle or delivery rule still requires understanding the central assembly and unrelated capabilities. The launcher depends back on the registry simply to obtain cancellation state.

**Smallest change:** Pass each handler a narrow capability interface. Extract cancellation into an independent module, separate claim geometry from claim presentation, and leave registry responsible for session lookup rather than worker orchestration.

### 14. Tool replies reuse historical event wording as current status

**Severity:** P3 · **After the trial**

**Where:** [scope.ts:68](../packages/room-mcp/src/tools/scope.ts:68), [scope.ts:254](../packages/room-mcp/src/tools/scope.ts:254), [messages.ts:48](../packages/shared/src/messages.ts:48), [registry.ts:443](../packages/room-mcp/src/registry.ts:443)

A scope declaration posts an event and immediately returns a ledger containing that event and earlier declarations, all formatted as “is on.” Resume replies report restarting but omit the distinct fact that the retained host conversation is being resumed.

**Failure:** Later workers interpret a collected worker’s historical declaration as present activity, or treat their own echoed declaration as another notice. Leads cannot tell from the resume reply whether Room requested retained context.

**Smallest change:** Use separate historical and current-state renderers, omit the just-posted event from acknowledgement context, and include an explicit retained-conversation outcome in resume replies.

## The four live-check notes

1. **Collected worker’s stale “is on” notice: confirmed in historical context.** Retirement removes active scope but leaves bus history; a later same-area scope response includes that history. This is not evidence that the worker remains actively scoped. [doc.ts:138](../packages/shared/src/doc.ts:138), [ledger.ts:72](../packages/shared/src/ledger.ts:72)

2. **Worker receives its own status line: confirmed in tool-returned history, dismissed for normal inbox routing.** Scope replies and recent-bus output include self-authored events; `messageForMe` excludes the agent’s own messages. [scope.ts:180](../packages/room-mcp/src/tools/scope.ts:180), [messages.ts:76](../packages/shared/src/messages.ts:76)

3. **Carried untracked file claimed as scope: cannot confirm the observed incident from code.** Declared scope paths come from the tool arguments, while worker-change accounting explicitly excludes unchanged carried files. Those are separate mechanisms; the source does not establish which produced the reported line. [scope.ts:64](../packages/room-mcp/src/tools/scope.ts:64), [baseline.ts:172](../packages/roomd/src/baseline.ts:172)

4. **Resume reply omits whether context was kept: confirmed.** Both host commands explicitly resume the recorded session; there is no fresh-session fallback in this command builder. The reply should say “resumed the retained conversation,” without promising that the host has never compacted it. [worker-config.ts:104](../packages/room-mcp/src/worker-config.ts:104), [registry.ts:443](../packages/room-mcp/src/registry.ts:443)

## What is sound

- **Keep the one-way overlay model.** Shared edits should remain observations; explicit collection should remain the boundary that writes the lead’s working files.
- **Keep the common carried-work baseline.** Centralizing tracked and untracked carry accounting is the correct abstraction. [baseline.ts:44](../packages/roomd/src/baseline.ts:44)
- **Keep conservative process and worktree ownership checks.** Extend their coverage through trusted local records rather than weakening them. [worker-state.ts:22](../packages/room-mcp/src/worker-state.ts:22)
- **Keep centralized message policy and shared presentation functions.** Fix delivery state and distinguish historical rendering without duplicating routing rules.
- **Keep GitHub admission and server-enforced read-only viewers.** These are real enforcement boundaries. [admit.ts:66](../packages/server/src/admit.ts:66), [readonly.ts:43](../packages/server/src/readonly.ts:43)
- **Keep Yjs for replicated collaboration state.** The necessary changes concern authority, acknowledgements, and recovery boundaries—not replacing the replication engine.

