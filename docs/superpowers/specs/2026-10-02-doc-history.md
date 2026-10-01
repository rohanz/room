# Room document history: compaction with a document generation (0.17.0)

Status: design, 2026-10-02, reviewed (Astra, must-fix rounds; §10). Not implemented yet: §9 says
why. Input: the [12-hour soak of rc5](../rehearsals/2026-10-02-soak-12h.md), finding 1.

## 1. Problem

A room document keeps its whole Yjs history. Every post, receipt, claim, overlay edit and hub mirror write
leaves structs that no trim removes: about 16 per post in the soak, 11,200 an hour. RSS grew 7 MB/hour at
~700 posts/hour, and a restart reloads the same history. CPU grew by +0.20 points of a core per hour, because
Y.Map iteration visits every key ever set and the hub's minute `trim()` walks `mail`, `archive` and
`outcomes`. At a tenth of that load the drift is still ~17 MB/day, unbounded. Prod rooms live for months.

## 2. Why Yjs keeps it (measured)

`gc` is on everywhere. The server binds `setupWSConnection(…, { gc: true })`. Every `new Y.Doc()` in
server, relay and clients uses the default `gc: true`. No `gc: false` exists outside tests. With gc on, a
deleted item's *content* is dropped, but the item itself stays as a tombstone whenever its parent is live.
Concurrent edits may name it as their origin, so a root map or array keeps one struct per deleted item.

Yjs merges adjacent tombstones only when one client wrote them with consecutive clocks. A micro-benchmark,
10,000 operations each (`structs` = structs in the store):

| Pattern | structs | encoded |
|---|---|---|
| one key overwritten 10,000 times, nothing else written | 2 | 39 B |
| array push + delete from the front (keep 100), nothing else written | 2 | 0.8 KB |
| text append + delete from the front | 2 | 1.0 KB |
| bus push + `meta.hubSeq` overwrite in one transaction (the hub's `append`) | **20,000** | 241 KB |
| distinct key per entry, keep the newest 100 (`archive`, `mail`, `seen:*`, `claims`) | **10,000** | 117 KB |
| fixed 100 slots, overwritten round-robin ("key reuse") | **10,000** | 88 KB |

So Room's growth comes from two shapes: interleaved single-key overwrites (each `append` writes the bus
*and* `hubSeq`, so neither run is contiguous) and per-message keys. Fixed slots don't help with the structs,
because interleaved overwrites of different slots never merge. They only fix iteration cost: Y.Map
iteration over 100 slots stays at 100 keys (0.26 ms per 100 passes, against 8.4 ms for 10,000 dead keys).

## 3. Offline reproduction

`scripts/doc-history.mts` reproduces the growth without a server. It runs a hub-core hub over one
`RoomDoc`, with a member replica synced by updates and the soak's mix:
- 8 participants, one post every 5.1 s of fake time (700/hour);
- half the posts are addressed questions; the recipient receipts them and answers half;
- a claim every ~6 posts, at most 6 open;
- `pruneSeen` every 500 posts, lease renewals, and the hub's 1 s tick with its 60 s maintenance trim.

Baseline (rc10 code), 50,000 posts:

| posts | structs | deleted | encoded | heap | `archive` keys (live) | trim |
|---|---|---|---|---|---|---|
| 5,000 | 21,787 | 12,197 | 976 KB | 49 MB | 4,230 (4,230) | 22 ms |
| 20,000 | 59,047 | 49,626 | 1,546 KB | 75 MB | 12,794 (5,000) | 23 ms |
| 35,000 | 91,693 | 82,276 | 2,031 KB | 110 MB | 20,349 (5,000) | 22 ms |
| 50,000 | 124,292 | 114,872 | 2,516 KB | 128 MB | 27,870 (5,000) | 23 ms |

That is ~2.2 structs and ~32 KB encoded per 1,000 posts, linear, and a reload brings every struct back.
The minute trim's cost stays at ~22 ms here: its live work (sizing 2,000 bus messages and 5,000 archive
entries) dominates, and its key walks over 28k dead archive keys add little at this scale.

The soak's CPU slope (+0.2 points/hour) therefore isn't explained by the trim alone. The heap growth (GC
work over a growing old generation) and per-update work over a larger store are the other candidates.
§8 reports the CPU line with compaction.

The `archive` keys grow without bound while its live entries stay at the 5,000 cap; its
dead keys make up most of what the trim walks. Struct origin after 10,000 posts:

| root | structs | writer |
|---|---|---|
| `bus` | 9,815 | hub |
| `meta.hubSeq` | 9,815 | hub |
| `archive` | 7,815 | hub (trim) |
| `mail` | 3,159 | hub (trim) |
| `seen:*` | 4,959 | members |
| `claims` | 1,741 | members |

This message-only load puts 82% of the growth on hub-owned roots (3.3 structs/post). The real soak
measured 16 structs/post, with overlays, manifests, participant `git` records, worker views and graphs
on top. So **about 79% of the real growth is member-written**. §8 confirms this with a per-root breakdown
from the local soak.

## 4. Options

### (a) Compaction with a document generation

The server rebuilds the room from its current values into a fresh `Y.Doc` (`compactDoc`) and stamps it
with a new random `meta.generation`. A replica of an older generation must never be merged into it. Its
structs carry IDs the new document doesn't have, so a merge would bring back the whole history and
duplicate every value. So clients state their generation before syncing, and a stale replica is
replaced the way a process restart replaces it: discarded, then joined afresh under the same name.

Measured in the harness (compact when the store passes 20,000 structs; the member replica resyncs from
scratch), 50,000 posts:

| posts | structs | deleted | encoded | heap | `archive` keys (live) | trim |
|---|---|---|---|---|---|---|
| 5,000 | 7,509 | 516 | 780 KB | 35 MB | 3,828 (3,828) | 20 ms |
| 20,000 | 11,239 | 2,527 | 942 KB | 36 MB | 5,132 (5,000) | 23 ms |
| 35,000 | 10,597 | 2,506 | 915 KB | 35 MB | 5,101 (5,000) | 22 ms |
| 50,000 | 8,220 | 659 | 866 KB | 53 MB | 5,029 (5,000) | 22 ms |

Seven compactions of 4–8 ms each, a sawtooth between ~8k and the threshold, with no upward trend in any
column.

A compaction of a soak-sized room takes single-digit milliseconds (copying values is linear in the live
state). It bounds **every** source of history at once: hub roots, member roots, overlays, and roots that
don't exist yet.

### (b) Hub-owned data out of the CRDT

This moves `bus`, `mail`, `archive`, `outcomes` and the `meta` mirrors into hub storage, served over the
hub connection. Against it:
- **It doesn't bound the document.** Member-written history keeps growing (§3: ~79% of the real growth,
  0.67 structs/post even in the message-only harness). Prod rooms would still need (a).
- **It reverses a ruling.** Hub spec ruling R-H7 (`2026-09-28-hub.md` §2.3, `redesign-plan.md` ruling
  R-H7) keeps delivery in the CRDT: "Accepted messages reach clients through the CRDT `bus`, as today:
  the hub is the sole appender, sync is the replay… a second delivery channel would bring back the
  parallel paths Fable 2 removed."
- **It costs offline reads.** A paused client reads its replica "as of <age>" (`hub.md` §9). The web
  view reads `room.messages()` over a read-only socket that sends no hub frames (B10).
- **It needs a durable journal.** Delivery durability is "what the doc gives" (R-H5, no journal). (b)
  needs a message store with its own persistence, replay protocol, a web-view feed and migration.

That is the most protocol and code of any option, and it doesn't solve the problem.

### (c) Hybrid: (b) for the bus and counters, plus (a) as a rare safety net

This needs all of (a)'s machinery, since the generation and client resync aren't optional for a safety
net that runs at all. It adds all of (b) on top, and (a) would run only about 4.8× less often (the harness's
hub share), still roughly daily at the soak's rate. Strictly more machinery than (a) for a frequency
change.

### Cheap partial steps, measured and rejected as the fix

- **Single-writer lanes.** The hub could write `bus` and the `meta` mirrors under dedicated Yjs client
  IDs so their runs stay contiguous and merge (the 2-struct rows above). That removes about half of the
  harness's hub growth. But per-message keys (`archive`, `mail`, `outcomes`, receipts, claims) don't
  merge, and member writes interleave by nature. It also depends on Yjs's merge rules as an invariant
  and switches `doc.clientID` mid-life. Rejected.
- **Fewer `hubSeq` writes.** This removes one struct per post (~25% of hub growth) and nothing else.
  It isn't needed once (a) bounds the document.
- **Fixed slots** for archive/mail. This flattens iteration but not structs (above), and it's a schema
  change for every reader. Rejected.

**Decision: (a), alone.** It is the only option that bounds the document. Everything else either needs
it too or leaves history growing.

## 5. Design

**The rule:** for a client, a generation change is a restart of its replica. Room already depends on
restarts being safe: every MCP process restart, leave-and-rejoin and relay takeover discards a replica and
joins afresh under the same name, and the soak's at-least-once accounting covers them. Compaction adds
no new client semantics. It adds three guarantees around the replacement so it loses less than a crash:
- everything a connected client sent before the close is kept (§5.3);
- posts in flight settle over the stale connection (§5.5);
- a tool call that spans the replacement reports that instead of success (§5.5).

### 5.1 Generations and the generation frame

`meta.generation` is a random 128-bit hex string written only by compaction. A document without one
(every rc and migrated 0.16 document today) is generation `0`.

**The server announces the generation before any document data.**
- A client that sends a `gen` URL parameter gets one generation frame: message type 8
  (`MSG_GENERATION`), JSON `{ g, current }`.
  - `g` is the generation the connection's document data comes from: `current` on a normal
    connection, none on a stale one (§5.2).
  - `current` is the room's current generation.
- The server sends the frame in the upgrade callback, before `setupWSConnection` sends sync step 1. TCP
  keeps order, so the frame precedes every byte of document state the connection carries, sync and
  broadcast updates alike.

**Pinning.**
- Each `Y.Doc` pins `g` from the first frame that carries one. Until then it is `fresh`: it holds no
  server state, and whatever it wrote locally names no server item, so it merges into any generation.
- A replica that received any server data has therefore always pinned the generation that data came
  from, even if it disconnected before `sync` completed.
- Pins belong to documents. room-mcp's probe and roomd's daemon have separate documents, each with its
  own pin and handler.

**Reconnects.** Every Room websocket URL carries `gen=<pin or fresh>` beside `schema=2`. The provider's
`params` object gets an enumerable getter, so every reconnect sends the current value.

**BroadcastChannel is off on every Room provider** (`disableBc: true`).
- y-websocket otherwise exchanges full state between providers of the same room name in one process (Node)
  or one browser, regardless of `gen`.
- Every Room client syncs through its socket; no Room feature uses cross-provider sharing.

### 5.2 The gate (server, at upgrade)

It runs after the room's document has loaded under the repo lock, at the start of `handleUpgrade`'s
callback, before the hub, identity and read-only wrappers and before `setupWSConnection`. The server has
sent no sync step and read nothing the client sent.

The room's current generation is `G`.

| `gen` param | result |
|---|---|
| `fresh` or `G` | normal connection; frame `{ g: G, current: G }` |
| any other value | **stale connection**: frame `{ current: G }`, hub frames only (below) |
| absent (rc client), `G` is `0` | normal connection, no frame (rc clients are unaffected until the first compaction) |
| absent, `G` is not `0` | close **4403** "update Room to 0.17.0 or later: this room's document was compacted" |

**A stale connection** gets the frame and `bindHub`, and nothing else:
- no `setupWSConnection`, so no sync, no broadcast and no awareness;
- every non-hub message it sends is dropped unread. Its replica can never merge into the room.
- **Its hub frames reach the room's hub.**
  - The server starts that hub itself (`hubs.ensure` on the loaded document), because after a recycle
    every first connection is stale and none would otherwise start it.
  - While any stale connection is open, it keeps the room's document loaded with the same placeholder
    anchor in `doc.conns` as the recycle, so the hub isn't stopped under it. The anchor is never sent
    anything.
  - When the last stale connection closes, the anchor is removed. If no normal connection remains, the
    document unloads as stock y-websocket unloads it: `writeState`, then destroy.
  - So the old session's leases renew and its pending posts settle (§5.5).
- It is closed when the client drops the session, and it counts against the connection limits like any
  other.

**Why 4403 for rc clients.** Every rc client already treats it as final:
- rc room-mcp's `watchClosed` stops reconnecting;
- the rc web view shows the reason and stops. For any other code it reconnects in a loop.
- New clients always send `gen`, so they never get it.

**Read-only (view) connections** pass the same gate.

### 5.3 When the server compacts

**Trigger.**
- The decision reads `historyOf(doc)`: total and deleted structs, in one pass over the struct store (about
  1 ms per 100k structs).
- A room compacts when `deleted > max(ROOM_COMPACT_MIN_TOMBSTONES (default 20,000), live structs)`, so
  only once tombstones outnumber live structs. At ~305 B of heap per tombstone, 20,000 is ~6 MB per room.
- At the soak's rate that is every ~2–3 h; at real rates every day or two.
- A room compacts at most once per `ROOM_COMPACT_MIN_INTERVAL_MIN` (default 10).

**The routine, `compactStored(room)`.** It runs with the document unloaded and nothing connected:
1. Read the stored document.
2. If it is over the trigger, build `compactDoc(stored, newGeneration)` and write it with
   `provider.replace`. That is one atomic write: a LevelDB batch, or the memory map. Nothing else is
   stored, so a failed or interrupted write leaves the previous document, and its generation, intact.
3. A provider without `replace`, or a failed write, leaves the room uncompacted. That is logged, and the
   next attempt starts over.

**At load.** `ServerHubs.persistence().bindState` runs the routine's check on the document it reads,
before applying it to the live `WSSharedDoc`. A server restart or an idle room's next load therefore
compacts before any client syncs.

**Live: drain, unload, compact.** `ServerHubs.tick` measures each loaded room every 60 s. Over the
trigger, the server recycles the room under the repo lock, so upgrades queue behind the whole sequence:
1. **Anchor the document.** Put a placeholder connection (open, sends nothing) into `doc.conns`.
   - Stock y-websocket unloads a document when `conns` empties.
   - It also drops a socket from `conns` the first time it broadcasts to that socket while it is
     `CLOSING`.
   - Without the anchor, one client's late update could unload the document under the others'
     in-flight updates.
2. **Close every room socket** with **1012** ("service restart"). It is reconnectable, so clients come
   back on their own.
3. **Drain.** Wait for every socket's `close` event, bounded at 5 s, after which the rest are
   terminated.
   - A socket keeps delivering messages until the client's close frame, and stock y-websocket applies
     them. Hub frames are answered by the hub.
   - So everything a client sent before it saw the close reaches the document.
4. **Quiesce the hub.**
   - With no sockets left, no lease request can arrive.
   - Await the hub's final lease flush (`flushLeases`, which retries until the store accepts the last
     snapshot), then stop it.
5. **Unload.** Remove the anchor and `docs` entry, write the final state through the same persistence
   `writeState` (which waits out storage failures), then destroy the document.
6. **Run `compactStored(room)`.**
7. **Reset per-document state.** Drop the room's identity-guard shadow, size meter, awareness owners and
   budget, as `stopDoc` does. Then release the lock.

**After the lock is released**, the clients reconnect. They load the compacted room and meet the gate
with their old generation, which makes their connections stale (§5.5).

**If the compaction failed**, the generation is unchanged, and they resume as after any server restart.
A client's replica is only ever discarded once a new generation exists.

### 5.4 What `compactDoc` copies

- **Every root, by value, whatever its name.**
  - Maps, arrays and text, including roots that arrived by update and were never read: their kind is
    read from their items.
  - Nested `Y.Map`, `Y.Array` and `Y.Text`.
  - XML types and subdocuments make it throw, so the room stays uncompacted and the error is logged.
- **Text** is copied by delta.
- **Claim anchors are the only relative positions in the schema** (`types.ts`, `doc.ts`).
  - Each one is resolved to an index in the source and re-created at that index in the copy's text.
  - An anchor that no longer resolves is dropped, as `moveClaim` drops an obsolete one, and
    `claimRange` falls back to the stored lines.
- **Values are copied, never filtered.** Bounds stay the trim's and the hub's job.
- **Leases, the incarnation record and the lease store are outside the document and untouched.**
  - The hub restarts as on a server restart, which the soak verified: same epochs, no counter reuse,
    back in 2–5 s.
  - Seqs and epochs in the copied `bus`, `mail` and `meta` mirrors are values, so `highestSeq` and the
    ledger cursor (`cursor.json` frontier) are unaffected.

### 5.5 Clients: replacing a stale replica

**When.** A replica is stale when a generation frame's `current` differs from its pin. A `fresh` replica
is never stale.

**room-mcp: writes need a live connection.** This is the one change to tools.
- Every tool write to the room's document is now preceded by a synchronous check that the session's
  provider is connected and synced, and its replica not stale (`s.writable()`).
- It runs immediately before the write, after the tool's awaits. A `room_claim` or `room_scope` that
  was awaiting a file read when the connection dropped therefore returns `error: room not synced yet,
  retry` without writing, instead of writing into a replica that may be discarded.
- A write that passes the check is sent at once on an open socket. It reaches the server before the
  client's close frame, so the drain keeps it (§5.3).
- Background writers (roomd, ledger, projectors) are not tools. What they write in that window is the
  §5.6 table.

**room-mcp: the replacement.** A stale primary starts it. It is the host-rebind path, run with the same
session id:
1. **Stop new work on the old session.** New tool calls wait for the replacement's first attempt, as they
   wait on a rebind.
2. **Let the old session's work settle**, bounded at 60 s.
   - Tool calls already running finish. Their writes fail the `writable()` check, so none reports a
     write that isn't in the room.
   - Its `HubClient`'s pending posts settle over the stale connection. Each is answered by the hub:
     accepted, `duplicate` if the drain had already accepted it, or refused. Each post's outcome is
     therefore true.
3. **Drop the old session.** Its leave releases the lease over the stale connection.
4. **Join and adopt a fresh session.**
   - `joinSession` takes a new, `fresh` replica.
   - It is adopted with `adopt(s, false)`, which skips `clearStale`, so the participant's own claims and
     scope (in the new generation) are not mistaken for an earlier session's.
5. **Re-attach secondary rooms.**
   - First, delete from the new primary the lead's bridge mirrors: claims with `mirrorOf` set and `by`
     the lead's name. The dropped bridge's mapping from local claims to mirrors was in memory only,
     and the new bridge re-mirrors every local claim at start, so keeping them would orphan them.
   - The lead's own claims (no `mirrorOf`) are untouched.
   - Then each secondary (the local workers room) is rejoined and re-attached (`attachWorkersRoom`),
     which rebuilds the workers bridge against the new primary.
6. **Failure.** The replacement keeps the intended room set and its progress.
   - **Transient failure** (a join timing out, a relay down): retried with backoff until every room is
     back.
   - **Permanent failure** (`NotLoggedIn`, `NoRoom`, a 4403 or 4001 close; the errors auto-join already
     treats as non-retryable) ends the replacement. The session is left closed with the reason, as
     auto-join leaves it.
   - Either way, after the first attempt tool calls stop waiting:
     - `room_state` reports the replacement;
     - `room_login`, `room_join`, `room_create` and `room_leave` run as usual, and `room_leave` cancels
       a pending replacement;
     - other tools return `error: rejoining the room after its document was compacted; retry` until it
       completes.
   - An idle agent is not left without its workers room while the retries run.

**roomd** runs inside the session and is replaced with it.

**Web view.** It sends `gen` and disables BroadcastChannel.
- A stale frame reloads the page: a read-only view has no writes. The reload trades its view key for a
  new ticket.
- On 4403 it shows the reason, as today.

**roomagent (`packages/agent`).** It sends `gen` and disables BroadcastChannel.
- On a stale frame it settles its pending posts as in step 2, then exits non-zero with the reason.
- On 4403 it exits.
- Its supervisor (or its human) restarts it with a fresh replica, which is what a restart already does.

### 5.6 Writes a replacement does not carry

What a replacement can lose is what a crash of the client at that moment loses. It is limited to
document writes that never reached the server:
- **A connected client** loses only what its background writers wrote between the server's close frame
  and the stale frame, typically under a second.
- **A client that was disconnected** when the room compacted loses its offline writes. Its lease fence
  stops writers 45 s into a disconnection, so these are at most 45 s of writes.

| Write | After the replacement |
|---|---|
| Receipts (`seen:<me>`) | Not carried. The messages are delivered again: duplicates, within at-least-once, as after a restart |
| Overlays, manifest, `basetextFlat` | Republished by roomd's `reconcile('all')` at start |
| `participants` `id`/`proj`/`git` | Rewritten at start |
| Worker views, graphs, colours, coordination | Rebuilt on `sync` |
| Claims, scope, release (tool calls) | Never written without a live, synced connection (`writable()`, §5.5) |
| Worker retirement (projector) | **Re-verified on every sync** (new, below) |
| Claim re-anchoring by roomd on a HEAD transition | The claim shows its last synced lines until roomd's next transition |
| `pushedPending` (a `pushed` notice a HEAD transition owes) | The notice is not sent |
| roomagent chat lines | Not carried |

**Retirement re-verification** is the one targeted change.
- Today a projector that retires a worker offline marks the room's cleanup `done` on disk. If its
  replica is then discarded, by a restart or now by a replacement, nothing retries the retirement, and
  the worker's view, claims and names linger until the room's stale expiry.
- The projector will now, on every `sync`, re-run `retireWorker` for records retired in the last 7 days
  whose entry is missing from the room's `retiredWorkers`. `retireWorker` is idempotent and guarded by
  `workerOwnsName`.
- This closes the gap for restarts too.

The last three rows are accepted, as they are for restarts today. Each costs a stale range or a notice,
never a coordination fact another participant relies on.

### 5.7 Local relay rooms

Relay rooms are unchanged in 0.17.0, and the relay ignores `gen` and sends no frame:
- **Already value copies.** The relay's documents are value copies on disk (`memorySnapshot`), so
  restarts don't accumulate history.
- **Known gap, unchanged.** A survivor reconnecting with pre-snapshot identities is the relay's
  existing, documented gap (`relay/src/memory.ts`, deduped by id).
- **The fix, later.** The same gate would close that gap there too. It is a follow-up with its own
  tests.

## 6. Costs

**Protocol.**
- One URL parameter (`gen`) and one message type (8, the generation frame, sent only to clients that
  send `gen`).
- One `meta` key (`generation`).
- 4403 with a new reason for rc clients, and 1012 for a recycle.
- `disableBc` on every provider.
- Hub protocol unchanged (`HUB_PROTO` 1). Schema unchanged (`schema=2`).

**Server.** The compaction routine, the gate with its stale (hub-only) connections, and the
drain-and-unload recycle.

**Clients.**
- The generation frame handler and `gen` getter.
- room-mcp's `writable()` check before tool writes.
- The replacement: an extension of the rebind path with a settle step, mirror cleanup and failure
  handling.
- The projector's re-verification.
- Reload in the web view and exit in roomagent.

**Migration.**
- **rc documents and migrated 0.16 documents** are generation `0`. Their first load or live trigger
  over the threshold compacts them. Compaction copies every root, legacy ones included.
- **0.16 clients** are already refused (`schema=2`).
- **rc clients** keep working in a room until its first compaction. After it, they are closed with
  4403 and the update text, which every rc client treats as final. An rc client must update to 0.17.0.

**Offline.** Per §5.6: a crash's losses at the moment of the replacement, minus what the drain, the
settle step and the re-verification keep.

**Availability.**
- A live recycle disconnects every client of one room for about the time of a hub restart. The soak
  measured 2–5 s back after `/health`.
- Replacements then run in each client, with tool calls waiting for at most the settle step plus a join.

**Memory.** The compaction transiently holds the stored document plus its copy, with the live document
already unloaded.

## 7. Tests (failing first)

- **Harness (`hub-core`):** 50,000 posts with trims under compaction.
  - Structs stay under a fixed bound (threshold + one interval's growth).
  - Encoded size stays under a bound.
  - Map-iteration cost is flat.
  - The same run without compaction exceeds those bounds, so the test can fail.
- **`compactDoc`:**
  - Every root kind is copied, including never-read roots and nested types.
  - Values are equal per root, the generation is set, and the copy holds no deleted structs.
  - Claim anchors resolve to the same lines.
  - XML types throw.
- **Generation frame:** a replica that received an update, but no sync step 2, has pinned `g`. A
  `fresh` replica is never stale. `params.gen` follows the pin.
- **Server:**
  - **Load-time compaction:** a stored document over the threshold loads compacted; the next load is
    not compacted again; a failing `replace` leaves the old document and generation.
  - **Restart reloads compact.**
  - **Gate:** each row of §5.2. A stale connection's sync and update messages are dropped, and its hub
    frames are answered, by a hub the stale connection itself started after a recycle.
  - **Stale connections keep the room loaded** while they are open, and it unloads after the last one
    closes.
  - **Recycle drain:** updates several clients sent after the server's close frame went out, but before
    theirs, are all persisted. This test fails without the anchor.
  - **Lease release during the drain:** a release made during the drain is in the lease store the next
    hub adopts.
  - **Counters:** `seq` after compaction is above every earlier one, with no reuse.
  - **Leases:** a lease survives a recycle (same epoch, renew ok).
- **Delivery:** a post accepted during the drain, whose reply was lost, settles as `duplicate` over the
  stale connection and is delivered once.
- **Client (room-mcp):**
  - A stale frame starts a replacement that keeps the name, doesn't clear its own claims, re-attaches
    the workers room, and survives a failed secondary join by retrying.
  - A `room_claim` whose file read spans a disconnect returns `not synced` and writes nothing.
  - After a replacement with a worker's mirrored claim, the team room holds exactly one mirror, and
    releasing the local claim leaves none.
  - A replacement that meets `NotLoggedIn` ends, leaves the session closed, and lets `room_login` run.
  - A transient failure retries while tools return the rejoining error.
  - BroadcastChannel is off.
- **Projector:** a retirement whose replica was discarded is re-applied on the next sync, and an
  already-retired worker is not touched.

## 8. Soak

`scripts/soak.mts` against a local server at the 12 h soak's rate for ≥60 min, with `structs` samples
(per-root struct counts added). Compared with rc5: structs per room bounded (sawtooth below the
trigger) against rc5's 11,200/hour line, and the server's heap slope.

<!-- SOAK -->

## 9. Why this is not implemented tonight

The review rounds (§10) showed where the work is.
- **Compaction itself is small:** the spike, the trigger and the load-time path.
- **The hard part is the generation change on clients.** Two exact designs (client replay, then a
  server-side translator) each failed review on several real holes.
- **This draft gives up exactness for restart semantics**, which Room already relies on, plus three
  narrow guarantees. It is the smallest design that survived review.
- **It is still a cross-cutting change:** the server gate and recycle, room-mcp's replacement, the
  projector, web and agent. It needs failing-first tests in each, review rounds, the full suite and a
  ≥60 min soak.
- **Rushing that overnight** would trade a known, slow memory drift for regressions in leases and
  delivery, so it stops at the reviewed spec.

What exists on the `compaction` branch:
- the spike (`packages/shared/src/compact.ts`: `compactDoc`, with its unit tests, used by the harness);
- the harness (`scripts/doc-history.mts`, §3);
- a per-root breakdown in `soak.mts structs`.

**Implementation order for 0.17.0.**
1. Shared: generation frame, trigger, gate verdict. All offline-testable.
2. Server: `compactStored` at load, the gate with stale connections, then the recycle with its drain and
   lease tests.
3. Clients:
   - frame and `gen` on all four providers, plus `disableBc`;
   - the projector's re-verification;
   - room-mcp's replacement;
   - web reload and agent exit.
4. Review, the full suite, and a ≥60 min local soak in `structs` mode against rc5's line.

## 10. Review log

- **Round 1** (Astra, 8 must-fix), fixed in the second draft:
  - BroadcastChannel bypassed the gate.
  - A replica not yet synced was treated as fresh.
  - Stock unloading could run before the close drain.
  - Auto-join adoption cleared the participant's own claims.
  - A stranded workers bridge.
  - Lost offline retirements and in-flight tool writes.
  - rc browsers looped on the new close code.
- **Round 2** (Astra, 7 must-fix), against the client-replay draft:
  - Deleted values are gone from the replica.
  - Deletions don't advance the clock.
  - A replayed array append bypassed `retiredWorkers`' cap.
  - Recovery dropped pending posts.
  - An equal generation after a failed compaction lost writes.
  - A failed secondary rejoin stranded the bridge.
  - The probe and roomd don't share a document.
- **Round 3** (Astra, 9 must-fix), against the straggler-translator draft:
  - Reloading the old generation replays translated writes.
  - Deleted nested types expose no old value.
  - Re-anchored claims never match a deletion.
  - Array translation broke the cap.
  - No upload barrier before dropping an idle replica.
  - Posts after the lease is superseded.
  - The previous-generation record isn't atomic with the compaction.
  - No final lease flush after the drain.
  - The old-generation document was unbounded.

  The fourth draft removes the translator and the previous generation and adopts restart semantics. It
  keeps:
  - the anchored drain;
  - hub-only stale connections, so posts settle;
  - a final lease flush;
  - a gate that replaces a replica only once a new generation exists;
  - an error for spanning tool calls;
  - retirement re-verification.

  It states the remaining losses (§5.6).
- **Round 4** (Astra, 4 must-fix), fixed in the fifth draft:
  - Rebuilding the bridge duplicated persisted mirror claims: mirrors are now deleted before re-attach.
  - Writes between a disconnect and the stale frame went unreported: tool writes now require
    `writable()`.
  - Hub-only connections didn't start or keep a hub: they now start it and anchor the document.
  - Replacement retries blocked recovery tools: permanent failures end the replacement, and tools stop
    waiting after the first attempt.
