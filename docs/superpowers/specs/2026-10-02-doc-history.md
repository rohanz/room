# Room document history: compaction with a document generation (0.17.0)

Status: design, 2026-10-02. Input: the [12-hour soak of rc5](../rehearsals/2026-10-02-soak-12h.md), finding 1.

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
replaced, not merged.

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

### 5.1 The generation

`meta.generation` is a random 128-bit hex string written only by compaction. A document without one
(every rc and migrated 0.16 document today) is generation `0`.

**The server announces it before any document data.**
- A client that sends a `gen` parameter gets one generation frame (message type 8, `MSG_GENERATION`: the
  room's generation as a string). The server sends it in the upgrade callback, before
  `setupWSConnection` sends sync step 1.
- TCP keeps order, so the frame precedes every byte of document state the connection carries: sync and
  broadcast updates alike.
- A replica's generation is pinned from the first frame it receives. Until then it is `fresh`: it holds
  no server state, and whatever it wrote locally names no server item, so it merges into any
  generation.
- A replica that received any server data has therefore always pinned the generation that data came
  from, even if it disconnected before `sync` completed. Reading `meta.generation` at `sync`, as the
  first draft did, would not guarantee that.

**`gen` on every reconnect.** Every room websocket URL carries `gen=<pinned or fresh>` beside `schema=2`.
The provider's `params` object gets an enumerable getter, so every reconnect sends the current value.
The pin belongs to the `Y.Doc`, not the provider: room-mcp's probe and roomd's long-lived provider share
one replica.

**BroadcastChannel is off on every Room provider** (`disableBc: true`).
- y-websocket otherwise exchanges full state between providers of the same room name in one process (Node)
  or one browser, regardless of `gen`.
- An old replica and its fresh replacement, or two tabs on different generations, would merge
  identities.
- Every Room client syncs through its socket anyway: roomd, the probe and the web view. No Room feature
  uses cross-provider sharing.

### 5.2 The gate (server, at upgrade)

It runs after the room's document has loaded under the repo lock, at the start of `handleUpgrade`'s
callback. It runs before the hub, identity and read-only wrappers are installed and before
`setupWSConnection`, so the server has sent no sync step and read nothing the client sent.

| `gen` param | room generation `G` (`0` if none) | result |
|---|---|---|
| `fresh` | any | send the generation frame, accept |
| equals `G` | — | send the generation frame, accept |
| present, ≠ `G` | — | close **4409** "room document compacted; join again with a fresh replica" |
| absent (rc client) | `0` | accept, no frame (no change for rc clients until the room's first compaction) |
| absent | ≠ `0` | close **4403** "update Room to 0.17.0 or later: this room's document was compacted" |

**Why close codes.** y-websocket can't read an HTTP refusal's status and would retry forever. A 44xx
close is terminal for y-websocket (`shouldReconnect`).

**Why 4403 for rc clients.** It is the code every rc client already treats as final:
- rc room-mcp's `watchClosed` stops reconnecting (its text says access was revoked);
- the rc web view shows the close reason and stops (`conn.ts`). For any other code it reconnects in a
  loop.
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
- `ServerHubs.persistence().bindState` reads the stored document. If it is over the trigger, it builds
  `compactDoc(stored, newGeneration)` and writes it with `provider.replace` (atomic: one LevelDB batch,
  or the memory map) *before* applying it to the live `WSSharedDoc`.
- A server restart or an idle room's next load therefore compacts before any client syncs.
- A provider without `replace`, or a failed replace, leaves the room uncompacted. That is logged, and the
  next load tries again.

**Live: unload with 4409.** `ServerHubs.tick` measures each loaded room every 60 s. Over the trigger,
the server recycles the room under the repo lock, so upgrades queue behind it:
1. **Anchor the document.** Put a placeholder connection (open, sends nothing) into `doc.conns`.
   Stock y-websocket unloads a document when `conns` empties. It also drops a socket from `conns` the
   first time it broadcasts to that socket while it is `CLOSING`. Without the anchor, one client's late
   update would unload the document under the others' in-flight updates. The anchor keeps the document,
   its hub and its persistence observer alive until every socket has finished.
2. **Flush the hub's leases.** Then close every room socket with 4409.
3. **Drain.** Wait for every socket's `close` event, bounded at 5 s, after which the rest are
   terminated.
   - A socket keeps delivering messages until the client's close frame, and stock y-websocket applies
     them, hub posts included. Everything a client sent before it learned of the recycle therefore
     reaches the document.
   - A post accepted during the drain whose reply is lost is retried by id after the rejoin and answered
     `duplicate`.
4. **Unload.** Remove the anchor and `docs` entry, then write the final state through the same
   persistence `writeState` (which waits out storage failures). Destroy the document, which stops its
   hub.
5. **Reset per-document state.** Drop the room's identity-guard shadow, size meter, awareness owners and
   budget, as `stopDoc` does. Then release the lock.

The next upgrade, typically the clients rejoining a moment later, loads through the load-time path,
which compacts.

**Why close with 4409 at once.**
- Every connected replica is about to be stale. Nothing depends on the compaction having finished: an
  upgrade waits on the repo lock, and a fresh replica is accepted in any generation.
- A compaction that fails leaves generation `G`. Its clients have replaced their replicas needlessly,
  which is harmless.

### 5.4 What `compactDoc` copies

- **Every root, by value, whatever its name.**
  - Maps, arrays and text, including roots that arrived by update and were never read: their kind is
    read from their items.
  - Nested `Y.Map`, `Y.Array` and `Y.Text`, so `overlays`' per-participant maps of texts and
    `manifest`'s maps.
  - XML types and subdocuments aren't used and make it throw, so the room stays uncompacted and the
    error is logged.
- **Text** is copied by delta, so attributes survive.
- **Claim anchors are the only relative positions in the schema** (`types.ts`, `doc.ts`).
  - Each one is resolved to an absolute index in the source and re-created at the same index in the
    copy's text, so a claim keeps tracking its lines.
  - An anchor that no longer resolves is dropped, as `moveClaim` drops an obsolete one.
  - `claimRange` already falls back to the stored line range in that case.
- **The copy records `meta.compactedFrom = { generation, sv }`.**
  - `generation` is the source's generation (`0` if none) and `sv` its state vector (base64).
  - §5.6 needs this. It is bounded by the clients that wrote during one generation, and omitted past 4,096
    entries; clients then skip replay.
  - Each compaction overwrites it.
- **Values are copied, never filtered.** Bounds stay the trim's and the hub's job, so compaction can't
  change what any reader sees.
- **Leases, the incarnation record and the lease store are outside the document and untouched.**
  - The hub restarts as on a server restart, which the soak verified: same epochs, no counter reuse,
    back in 2–5 s.
  - Seqs and epochs in the copied `bus`, `mail` and `meta` mirrors are values, so `highestSeq` and the
    on-disk ledger cursor (`cursor.json` frontier) are unaffected.

### 5.5 Clients

**room-mcp (the session).**
- On close 4409, `watchClosed` marks the session `stale`, and the process runs a **recovery**.
- Recovery is the host-rebind path (`rebindHost`), run with the same session id:
  1. Drop every joined session, workers room included, in reverse order.
  2. Rejoin the primary with `adopt(s, false)`. That path skips `clearStale`, so the participant's own
     claims and scope, which are in the new generation, are not mistaken for an earlier session's.
  3. Rejoin each secondary room and re-attach it (`attachWorkersRoom`), which rebuilds the
     workers-room bridge against the new primary.
- The lease is re-acquired under the same session id: superseded by its own holder, or re-granted after
  the TTL if the release couldn't be sent.
- Recovery runs at once, not at the next tool call, so an idle agent still wakes for addressed messages.
- A recovery in progress makes tool calls wait as a rebind does, and a second 4409 during one is folded
  into it.

**roomd.** Its provider is the session's long-lived connection over the probe's replica, so it reads the
same pinned generation.

**Web view.** It sends `gen` and disables BroadcastChannel.
- On 4409 it reloads the page. A read-only view has no local writes, and the reload trades its view key
  for a new ticket and starts a fresh replica.
- On 4403 it shows the reason, as today.

**roomagent (`packages/agent`).** It sends `gen` and disables BroadcastChannel. On 4409 or 4403 it exits
non-zero with the reason. Its supervisor (or its human) restarts it with a fresh replica, which is what
a restart already does.

### 5.6 Offline and in-flight writes: replay

Only writes a client made after the server stopped reading its socket are at stake. The drain (§5.3)
reads everything sent before the client saw the close.

**What is at stake.**
- A client already disconnected comes back with a stale replica and offline writes from at most its
  lease TTL (45 s): `fence()` stops roomd, the ledger and the projectors after that, and tools refuse
  while unsynced.
- A tool call in flight across a recovery can also write into the old replica after it.

**The replay.** On recovery the session keeps the old replica (a destroyed `Y.Doc` keeps its store and
still takes writes). Once the new primary has synced, it reads `meta.compactedFrom`:
- If it names the old replica's pinned generation, the session **replays its own unsynced writes**:
  structs in the old replica from its own client ID at or above `sv[clientID]`, which the server never
  had.
  - **A root-map entry** is replayed only when it is still the current item for its key in the old
    replica. A set becomes `set(key, value)`; a deleted current item becomes `delete(key)`.
  - **A root-array element** that is not deleted is pushed.
  - **A key the new session has already written itself** (current item from the new replica's own client
    ID) is skipped: the fresh value is newer.
  - **Nested types** (overlay texts, manifest maps) are skipped. Their owner republishes them:
    roomd's `reconcile('all')` at start.
- **Offline deletions of entries the server had** (receipt pruning, claim release, retirement cleanup)
  are found as root-map keys deleted in the old replica whose item the server had and whose value the
  new document still holds unchanged. Only this client wrote to its replica after the server's last
  update, so the deletion is its own, and it is replayed.
- **Late writes.** For 60 s after the replay, the session checks the old replica's own clock every
  second and replays anything new.
  - A tool call that resumed after the recovery and wrote into the old replica (a `room_claim` that was
    awaiting a file read) therefore still lands in the room. It needs no per-tool checks.
  - The tool's reply describes what it did, which is now true of the new generation.
- **Two compactions behind** (offline for longer than a compaction interval, so well past the lease TTL):
  the session logs and skips the replay. Its writes stopped at the fence anyway.

This covers everything a client writes at the root:
- receipts and receipt pruning;
- claims (set, moved, released) and scopes;
- `participants` records, including `pushedPending`;
- worker views and `retiredWorkers`, plus a retirement's deletions (the case the projector won't
  re-derive once its local cleanup marker says done);
- colours, coordination and chat.

Overlays, manifests and `basetextFlat` entries are republished by roomd.

## 6. Costs
## 6. Costs

**Protocol.**
- One URL parameter (`gen`) and one message type (8, the generation frame, sent only to clients that
  send `gen`).
- Two `meta` keys (`generation`, `compactedFrom`).
- One new close code (4409), plus 4403 with a new reason for rc clients.
- `disableBc` on every provider.
- Hub protocol unchanged (`HUB_PROTO` 1). Schema unchanged (`schema=2`).

**Migration.**
- **rc documents and migrated 0.16 documents** are generation `0`. Their first load or live trigger
  over the threshold compacts them. Nothing else changes: compaction copies every root, legacy ones
  included.
- **0.16 clients** are already refused (`schema=2`).
- **rc clients** keep working in a room until its first compaction. After it, they are closed with
  4403 and the update text, which every rc client treats as final (§5.2). An rc client must update to
  0.17.0. That is acceptable for release candidates, and the alternative is merging their history
  back.

**Offline.** Per §5.6: a client's own root-level writes are replayed exactly. Nested owner data is republished.

**Availability.**
- A live compaction disconnects every client of one room for about the time of a hub restart. The soak
  measured 2–5 s back after `/health`, plus the client's rejoin.
- It happens when tombstones exceed live structs and 20,000, at most every 10 min.

**Memory.**
- The compaction transiently holds the stored document plus its copy.
- It runs only at load, after the live document has been destroyed.

## 7. Tests (failing first)

- **Harness (`hub-core`):** 50,000 posts with trims under compaction.
  - Structs stay under a fixed bound (threshold + one interval's growth).
  - Encoded size stays under a bound.
  - The trim's cost is flat: last decile within 2× the first after warm-up.
  - The same run without compaction exceeds those bounds, so the test can fail.
- **`compactDoc`:**
  - Every root kind is copied, including never-read roots and nested types.
  - Values are equal (`toJSON` per root), the generation is set, and the copy holds no deleted structs.
  - Claim anchors resolve to the same lines.
  - XML types throw.
- **Server:**
  - **Load-time compaction:** a stored document over the threshold loads compacted and replaced in
    storage; the next load is not compacted again.
  - **Restart reloads compact.**
  - **Gate:** each row of §5.2.
  - **Live recycle:** a connected client is closed with 4409, rejoins `fresh` and syncs the compacted
    values, and the hub carries the lease over (same epoch, renew ok).
  - **Counters:** `seq` after compaction is above every earlier one, with no reuse.
- **Recycle drain:** updates sent by several clients after the server's close frame went out, but
  before theirs, are all persisted. This test fails without the anchor.
- **Gate:** a replica that received an update but no sync step 2 has pinned the generation, and gets
  4409 after a compaction.
- **Replay:**
  - Offline receipts, claims, releases (deletions) and array pushes reach the new generation.
  - Synced writes are not replayed.
  - A key the new session wrote is not overwritten.
  - A write into the old replica during the grace window is forwarded.
  - Two generations behind replays nothing.
- **Delivery:** an addressed message receipted offline before a 4409 is not redelivered after the
  rejoin. One posted during the recycle is delivered once.
- **Client:**
  - room-mcp recovers on 4409 with the same name, without clearing its own claims, with the workers
    room re-attached.
  - The gen getter sends `fresh`, then the announced value.
  - BroadcastChannel is off.

## 8. Soak

`scripts/soak.mts` against a local server at the 12 h soak's rate for ≥60 min, with `structs` samples
(per-root struct counts added). Compared with rc5: structs per room bounded (sawtooth below the
trigger) against rc5's 11,200/hour line, and the server's heap slope.

<!-- SOAK -->
