# Room document history: compaction with a document generation (0.17.0)

Status: design, 2026-10-02, reviewed (Astra, must-fix rounds to zero; §10). Not implemented yet: §9 says
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
duplicate every value. So clients state their generation before syncing:
- A stale replica is served the previous generation, which the server keeps.
- Its unsynced writes are translated into the new generation by value.
- The client then replaces the stale replica with a fresh one.

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

### 5.1 Generations and the generation frame

`meta.generation` is a random 128-bit hex string written only by compaction. A document without one
(every rc and migrated 0.16 document today) is generation `0`.

**The server announces the generation before any document data.**
- A client that sends a `gen` URL parameter gets one generation frame: message type 8
  (`MSG_GENERATION`), JSON `{ g, current }`.
  - `g` is the generation this connection serves.
  - `current` is the room's current generation.
  - They differ only on a straggler connection (§5.5).
- The server sends the frame in the upgrade callback, before `setupWSConnection` sends sync step 1. TCP
  keeps order, so the frame precedes every byte of document state the connection carries, sync and
  broadcast updates alike.

**Pinning.**
- Each `Y.Doc` pins `g` from the first frame any of its providers receives. Until then it is `fresh`:
  it holds no server state, and whatever it wrote locally names no server item, so it merges into any
  generation.
- A replica that received any server data has therefore always pinned the generation that data came
  from, even if it disconnected before `sync` completed.
- Pins belong to documents, not sessions. room-mcp's probe and roomd's daemon have separate documents,
  each with its own pin and handler. The probe's document is destroyed after the name is chosen.

**Reconnects.** Every Room websocket URL carries `gen=<pin or fresh>` beside `schema=2`. The provider's
`params` object gets an enumerable getter, so every reconnect sends the current value.

**BroadcastChannel is off on every Room provider** (`disableBc: true`).
- y-websocket otherwise exchanges full state between providers of the same room name in one process (Node)
  or one browser, regardless of `gen`.
- Every Room client syncs through its socket; no Room feature uses cross-provider sharing.

### 5.2 The gate (server, at upgrade)

It runs after the room's document has loaded under the repo lock, at the start of `handleUpgrade`'s
callback. It runs before the hub, identity and read-only wrappers and before `setupWSConnection`, so the
server has sent no sync step and read nothing the client sent.

The current generation is `G`. `P` is the previous generation, if the server still keeps it (§5.4).

| `gen` param | result |
|---|---|
| `fresh` or `G` | serve the room's document; frame `{ g: G, current: G }` |
| `P` | serve the previous generation as a **straggler** (§5.5); frame `{ g: P, current: G }` |
| any other value | close **4409** "room document compacted twice since this replica synced; join again" (§5.6) |
| absent (rc client), `G` is `0` | serve the room's document, no frame (rc clients are unaffected until the first compaction) |
| absent, `G` is not `0` | close **4403** "update Room to 0.17.0 or later: this room's document was compacted" |

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

**At load (the only compaction routine).**
- `ServerHubs.persistence().bindState` reads the stored document. If it is over the trigger, it:
  1. builds `compactDoc(stored, newGeneration)`;
  2. stores the uncompacted state as the room's **previous generation**, under its own key (§5.4);
  3. writes the copy with `provider.replace`, atomically (one LevelDB batch, or the memory map);
  4. applies the copy to the live `WSSharedDoc`.
- A server restart or an idle room's next load therefore compacts before any client syncs.
- A provider without `replace`, or a failed write, leaves the room uncompacted. That is logged, and the
  next load tries again.

**Live: drain and unload.** `ServerHubs.tick` measures each loaded room every 60 s. Over the trigger,
the server recycles the room under the repo lock, so upgrades queue behind it:
1. **Anchor the document.** Put a placeholder connection (open, sends nothing) into `doc.conns`.
   Stock y-websocket unloads a document when `conns` empties. It also drops a socket from `conns` the
   first time it broadcasts to that socket while it is `CLOSING`. Without the anchor, one client's late
   update could unload the document under the others' in-flight updates.
2. **Flush the hub's leases.** Then close every room socket with **1012** ("service restart"),
   reconnectable: clients come back on their own.
3. **Drain.** Wait for every socket's `close` event, bounded at 5 s, after which the rest are
   terminated.
   - A socket keeps delivering messages until the client's close frame, and stock y-websocket applies
     them. Hub frames are answered by the hub.
   - A client's unacknowledged post is retried by its own `HubClient` after the reconnect, and answered
     by id (`duplicate`) if it was accepted.
4. **Unload.** Remove the anchor and `docs` entry, write the final state through the same persistence
   `writeState` (which waits out storage failures), then destroy the document, which stops its hub.
5. **Reset per-document state.** Drop the room's identity-guard shadow, size meter, awareness owners and
   budget, as `stopDoc` does. Then release the lock.

The clients' reconnects load the room through the load-time path, which compacts, and then meet the gate
with their old generation: they become stragglers (§5.5). If the compaction failed, the generation is
unchanged and they simply resume. Nothing was discarded.

### 5.4 What `compactDoc` copies, and the previous generation

**The copy.**
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

**The previous generation.**
- The uncompacted final state is kept as one record per room (`prevgen:<room>`: its generation and
  update), replaced by the next compaction and removed with the room.
- That costs one uncompacted document of disk per room (≤ the 64 MB cap) and no memory unless a
  straggler connects.
- It is the old generation exactly as last persisted, so a straggler's sync step 2 against it carries
  precisely what the server never had.

### 5.5 Straggler connections

A connection whose `gen` is `P` is served a **straggler document** `O`:
- `O` is loaded from `prevgen:<room>` on the first straggler, shared by all of them, and dropped when the
  last one disconnects.
- y-websocket syncs it normally, so the client's sync step 2 delivers every struct and deletion of its
  replica that the old generation lacks: offline writes, writes after the drain, late tool writes. Yjs
  computes this exactly; nothing is inferred.
- The hub frames of a straggler connection go to the room's hub (the live generation's), so leases,
  posts and retries work unchanged.
- The same read-only and identity wrappers apply. The identity guard keeps its own shadow of `O`.

**The translator.** It turns every remote transaction on `O` into value operations on the live
document. It works from the transaction's Yjs events, which still hold deleted values during the
transaction: `oldValue` for maps, the deleted items' content for arrays.

| Change on `O` | Applied to the live document |
|---|---|
| Map key set (JSON value) | set, unless the live value is already equal |
| Map key set (nested type) | the nested value copied as in `compactDoc` |
| Map key deleted | deleted, if the live value still deep-equals the event's `oldValue` (the value the client deleted) |
| Array insert | appended, unless an equal element is present (chat, `retiredWorkers`: elements carry ids) |
| Array delete | the first deep-equal live element deleted, so `retiredWorkers`' 200 cap carries over |
| Text delta (an overlay) | applied to the same path's live text, which only its owner (this straggler) writes. If the live text differs from `O`'s pre-transaction text, the whole text is replaced instead |
| Claim set with an anchor | its anchor re-created against the live text, as in `compactDoc` |

**Properties of the translator.**
- **Idempotent.** A straggler that reconnects after a server restart resends the same structs, and
  they change nothing twice.
- **One-way.** Live changes are not copied back to `O`, so `O` doesn't grow beyond its stragglers'
  writes. In exchange, a straggler reads the room as of the compaction until it replaces its replica
  (§5.6). Its posts still reach the live bus through the hub, and its receipts and claims through the
  translator.
- **Bounded size.** The size cap measures the live document, which the translated writes land in.

### 5.6 Clients: replacing a stale replica

**When.** A replica is stale when a generation frame's `current` differs from its pin. Its connection is
a straggler connection, and it keeps working.

**room-mcp.** A stale primary starts a **replacement**. It is the host-rebind path, run with the same
session id, and it runs to completion:
1. **Settle the old session's pending posts.** Its `HubClient` retries them over the straggler
   connection to the same hub until each is acknowledged (`duplicate` if already accepted) or fails as
   it would without compaction. Its tool calls in flight keep running; their writes reach the room
   through the translator.
2. **Join and adopt a fresh session.**
   - `joinSession` takes a new, `fresh` replica, which syncs the live generation. Its acquire
     supersedes the old session's lease, so the old session's roomd, ledger and projectors stop at
     their fence.
   - It is adopted with `adopt(s, false)`, which skips `clearStale`, so the participant's own claims and
     scope (live in the new generation) are not mistaken for an earlier session's.
   - New tool calls wait on the replacement, as on a rebind.
3. **Re-attach secondary rooms.** Each secondary (the local workers room) is rejoined and re-attached
   (`attachWorkersRoom`), which rebuilds the workers bridge against the new primary.
4. **Drop the old session once it is idle.** Wait until no tool call that started on it is still
   running. The old session stays connected as a straggler until then, so a late write still lands.
   Then it is dropped.
5. **Retry until done.** The replacement keeps the intended room set and its progress. A stage that
   fails (a join refused, a relay down) is retried with backoff until every room is back. An idle agent
   is not left without its workers room. Until the primary is adopted, the old session remains the
   session.

**roomd** runs inside the session and is replaced with it.

**Web view.** It sends `gen` and disables BroadcastChannel.
- A stale frame, or 4409, reloads the page: a read-only view has no writes to keep. The reload trades
  its view key for a new ticket.
- On 4403 it shows the reason, as today.

**roomagent (`packages/agent`).** It sends `gen` and disables BroadcastChannel.
- On a stale frame it finishes its current turn on the straggler connection, then exits non-zero with
  the reason.
- On 4409 or 4403 it exits.
- Its supervisor (or its human) restarts it with a fresh replica, which is what a restart already does.

**4409 (two compactions behind).** The replica predates the previous generation, which is gone: the
client has been away for at least one full compaction interval, far past its 45 s lease fence. Its
unsynced writes from that time are lost, as a leave or a process restart loses them today.
room-mcp then runs the same replacement without step 1.

### 5.7 Local relay rooms

Relay rooms are unchanged in 0.17.0, and the relay ignores `gen` and sends no frame:
- **Already value copies.** The relay's documents are value copies on disk (`memorySnapshot`), so
  restarts don't accumulate history.
- **Known gap, unchanged.** A survivor reconnecting with pre-snapshot identities is the relay's
  existing, documented gap (`relay/src/memory.ts`, deduped by id).
- **The fix, later.** The generation gate and straggler path would close that gap there too. It is a
  follow-up with its own tests.

## 6. Costs

**Protocol.**
- One URL parameter (`gen`) and one message type (8, the generation frame, sent only to clients that
  send `gen`).
- One `meta` key (`generation`).
- A new close code (4409), plus 4403 with a new reason for rc clients and 1012 for a recycle.
- `disableBc` on every provider.
- Hub protocol unchanged (`HUB_PROTO` 1). Schema unchanged (`schema=2`).

**Server.**
- The compaction routine, the gate, the drain-and-unload recycle.
- The previous-generation record and the straggler document with its translator. The translator is
  the largest new piece, and it is pure value code, testable offline.

**Clients.**
- The generation frame handler and `gen` getter.
- room-mcp's replacement sequencing (an extension of the rebind path).
- Reload in the web view and exit in roomagent.

**Migration.**
- **rc documents and migrated 0.16 documents** are generation `0`. Their first load or live trigger
  over the threshold compacts them. Compaction copies every root, legacy ones included.
- **0.16 clients** are already refused (`schema=2`).
- **rc clients** keep working in a room until its first compaction. After it, they are closed with
  4403 and the update text, which every rc client treats as final. An rc client must update to 0.17.0.

**Offline.**
- Exact while the previous generation is kept: a straggler's unsynced writes, deletions included,
  reach the live document (§5.5).
- A replica two compactions old loses its unsynced writes (§5.6).

**Availability.**
- A live recycle disconnects every client of one room for about the time of a hub restart. The soak
  measured 2–5 s back after `/health`.
- Replacements then run in the background, with tool calls waiting only for the adopt step.

**Memory.**
- The compaction transiently holds the stored document plus its copy, at load only.
- A straggler document lives only while stragglers are connected.

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
  `fresh` replica merges into any generation. `params.gen` follows the pin.
- **Server:**
  - **Load-time compaction:** a stored document over the threshold loads compacted, the previous
    generation is stored, and the next load is not compacted again.
  - **Restart reloads compact.**
  - **Gate:** each row of §5.2.
  - **Recycle drain:** updates several clients sent after the server's close frame went out, but before
    theirs, are all persisted. This test fails without the anchor.
  - **Counters:** `seq` after compaction is above every earlier one, with no reuse.
  - **Leases:** a lease survives a recycle (same epoch, renew ok).
- **Translator:**
  - Each table row, including a deletion whose value only the event still holds, and an array delete
    keeping `retiredWorkers` at its cap.
  - Idempotence on resend after a restart.
  - A text delta against changed live text falls back to replacement.
- **Delivery:**
  - An addressed message receipted offline across a compaction is not redelivered.
  - A post accepted during the drain, whose reply was lost, is answered `duplicate` on retry, and
    delivered once.
- **Client (room-mcp):**
  - A stale frame starts a replacement that keeps the name, doesn't clear its own claims, re-attaches
    the workers room, and survives a failed secondary join by retrying.
  - A `room_claim` that resumes after the adopt still lands in the room.
  - BroadcastChannel is off.

## 8. Soak

`scripts/soak.mts` against a local server at the 12 h soak's rate for ≥60 min, with `structs` samples
(per-root struct counts added). Compared with rc5: structs per room bounded (sawtooth below the
trigger) against rc5's 11,200/hour line, and the server's heap slope.

<!-- SOAK -->

## 9. Why this is not implemented tonight

The two review rounds (§10) showed where the work is. Compaction itself is small: the spike, the
trigger and the load-time path. The hard part is giving a client's unsynced writes and in-flight
operations exact semantics across a generation change. Two client-side designs each failed review on a
real hole:
- replacing the replica outright: lost offline retirements and in-flight tool writes;
- replaying from the client: Yjs drops deleted values, deletions don't advance the clock, and pending
  posts die with the dropped session.

The straggler design closes those holes, but it adds a server translator, a previous-generation record
and a staged client replacement. Each needs failing-first tests across server, room-mcp, web and agent,
then review rounds, then a soak. Rushing that overnight would trade a known, slow memory drift for
silent data loss in coordination state, so it stops at the reviewed spec.

What exists on the `compaction` branch:
- the spike (`packages/shared/src/compact.ts`: `compactDoc`, used by the harness);
- the harness (`scripts/doc-history.mts`, §3);
- unit tests for the shared pieces, written failing-first.

**Implementation order for 0.17.0.**
1. Shared: generation frame, trigger, gate verdict, translator. All offline-testable.
2. Server: load-time compaction plus the previous-generation record, the gate, then the recycle with
   its drain test.
3. Clients: frame and `gen` on all four providers, `disableBc`, then room-mcp's replacement.
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

  The third draft replaces client replay with straggler connections and the server-side translator
  (§5.5), and staged, retried replacement (§5.6).
