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

- `meta.generation` is a random 128-bit hex string written only by compaction. A document without one
  (every rc and migrated 0.16 document today) is generation `0`.
- A client's replica has the generation of the first server state it synced. It is pinned at the first
  `sync` event: `docGeneration(doc) ?? '0'`. Before that the replica is `fresh`: whatever it wrote
  locally names no server item, so it merges into any generation.
- Every room websocket URL carries `gen=<pinned or fresh>`, beside `schema=2`. The provider's `params`
  object gets an enumerable getter, so every reconnect sends the current value.

### 5.2 The gate (server, at upgrade)

It runs after the room's document has loaded under the repo lock, before `handleUpgrade`'s callback
installs y-websocket. The server's sync step 1 has therefore not been sent, and nothing the client sent
has been read.

| `gen` param | room generation `G` (`0` if none) | result |
|---|---|---|
| `fresh` | any | accept |
| equals `G` | — | accept |
| present, ≠ `G` | — | upgrade, then close **4409** "room document compacted; join again with a fresh replica" |
| absent (rc client) | `0` | accept (no change for rc clients until the room's first compaction) |
| absent | ≠ `0` | upgrade, then close **4426** "update Room: this room needs 0.17.0 or later" |

- **Why close codes.** y-websocket can't read an HTTP refusal's status and would retry forever. A 44xx
  close is terminal for y-websocket (`shouldReconnect`), and room-mcp already dispatches on 44xx in
  `watchClosed`.
- **Read-only (view) connections** pass the same gate.

### 5.3 When the server compacts

**Trigger.**
- The decision reads `historyOf(doc)`: total and deleted structs, in one pass over the struct store (about
  1 ms per 100k structs).
- A room compacts when `deleted > max(ROOM_COMPACT_MIN_TOMBSTONES (default 20,000), live structs)`, so
  only once tombstones outnumber live structs. At ~305 B of heap per tombstone, 20,000 is ~6 MB per
  room.
- At the soak's rate that is every ~2–3 h; at real rates every day or two.
- A room compacts at most once per `ROOM_COMPACT_MIN_INTERVAL_MIN` (default 10).

**At load (one code path).**
- `ServerHubs.persistence().bindState` reads the stored document. If it is over the trigger, it builds
  `compactDoc(stored, newGeneration)` and writes it with `provider.replace` (atomic: one LevelDB batch,
  or the memory map) *before* applying it to the live `WSSharedDoc`.
- A server restart or an idle room's next load therefore compacts before any client syncs.
- If the replace fails, the load continues with the uncompacted document, and the next load tries again.

**Live.**
1. Every 60 s, `ServerHubs.tick` measures each loaded room. Over the trigger, it asks the server to
   recycle the room.
2. Under the repo lock, the server closes every connection of the room with 4409.
3. It waits for their `close` events, bounded at 5 s, then terminates the rest.
4. Stock y-websocket unloads the document: `writeState` drains through `waitForRecoveredWrite`, then the
   document is destroyed, which stops the hub.
5. The server drops the room's identity-guard shadow, its size meter and its awareness state, as
   `stopDoc` does, then releases the lock.

The next upgrade, typically the clients rejoining a second later, loads through the load-time path
above, which compacts. Live compaction is therefore "unload with 4409", and there is one compaction
routine.

**Why 4409 at once rather than a retryable close.**
- Every client connected at that moment holds a replica that's about to be stale. Telling it directly
  saves a round trip, and nothing about the outcome depends on the compaction having finished: an
  upgrade waits on the repo lock, and a fresh replica is accepted in any generation.
- A compaction that fails leaves generation `G` in place. The clients have replaced replicas they didn't
  need to; that is harmless.

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
- **Values are copied, never filtered.** Bounds stay the trim's and the hub's job, so compaction can't
  change what any reader sees.
- **Leases, the incarnation record and the lease store are outside the document and untouched.**
  - The hub restarts as on a server restart, and the soak verified that restart: same epochs, no counter
    reuse, back in 2–5 s.
  - Seqs and epochs in the copied `bus`, `mail` and `meta` mirrors are values, so `highestSeq` and the
    on-disk ledger cursor (`cursor.json` frontier) are unaffected.

### 5.5 Clients

**room-mcp (the session).**
- On close 4409 or 4426, `watchClosed` marks the session.
  - 4409 sets `s.stale = 'room document compacted'`, and the session asks the startup auto-join to
    replace it.
  - 4426 sets `s.closed`, with the update text.
- The replacement reuses the path for a relay taken over by another clone (`session.local.lost`): drop
  the session (stop graph, daemon and relay), then `joinSession` with the same options.
  - It is the path every MCP process restart and room move takes.
  - The lease is re-acquired under the same session id: superseded by its own holder, or re-granted
    after the TTL if the release couldn't be sent.
  - It runs at once, not at the next tool call, so an idle agent still wakes for addressed messages.
- **Receipts are salvaged before the drop:** the session's own `seen:<me>` entries. After the new
  replica syncs, each receipt for an id still in `bus`, `mail` or `outcomes`, and not already
  receipted, is written back with its original `{s, via, at}`.
  - Receipts are add-only facts, so this is exact.
  - It keeps at-least-once delivery from turning into a duplicate for anything handed over while the
    old replica was offline.
- **Secondary rooms are untouched.** The local workers room is a relay room, and relays don't compact.

**roomd.** Its provider is the session's long-lived connection. It sends `gen` from the pinned value,
so the probe connection (always fresh) and roomd's connection agree.

**Web view.** It sends `gen`. On 4409 it rebuilds its document and provider, the same as a page load,
because a read-only view has no local writes. On 4426 it shows the update text.

**roomagent (`packages/agent`).** It sends `gen`, and on 4409/4426 it exits with a clear message. Its
supervisor (or its human) restarts it with a fresh replica, which is what a restart already does.

### 5.6 Offline writes

Only writes a client made after its socket closed are at stake. Everything sent before the close is in
the compacted document: the server reads to the client's close frame before unloading, and TCP keeps
order. A connected client therefore loses nothing.

A client that was already disconnected comes back with a stale replica and offline writes from at most
its lease TTL (45 s): `fence()` stops roomd, the ledger and the projectors after that, and tools refuse
while unsynced. On 4409 these are handled as follows:

| Offline write | Outcome on 4409 |
|---|---|
| Receipts (`seen:<me>`) | Salvaged, as above |
| Overlays, manifest, `basetextFlat` | Republished: roomd's `reconcile('all')` at start |
| `participants` `id`/`proj`/`git` | Rewritten at start |
| Worker views, graphs, colours, coordination | Rebuilt on `sync` |
| Claim re-anchoring by roomd on a HEAD transition | Recomputed by roomd at the next transition. Until then the claim shows its last synced range |
| Retirement entries | Re-derived for records still retiring |
| `pushedPending` (a `pushed` notice a HEAD transition owes) | Lost |
| roomagent chat lines | Lost |

`pushedPending` and roomagent chat lines are the cost. Both are lost today when a replica is discarded
by a leave or a process restart, and the soak counted that path as at-least-once.

A replay that would cover these too needs the old generation's state vector. A client can then replay
its own structs above the server's clock for it: map and array entries only. That machinery isn't
justified by two notices. Noted as a follow-up.

### 5.7 Local relay rooms

Relay rooms are unchanged in 0.17.0, and the relay ignores `gen`:
- **Already value copies.** The relay's documents are value copies on disk (`memorySnapshot`), so
  restarts don't accumulate history.
- **Known gap, unchanged.** A survivor reconnecting with pre-snapshot identities is the relay's
  existing, documented gap (`relay/src/memory.ts`, deduped by id).
- **The fix, later.** Stamping a generation at relay load and gating the same way would close that
  gap. It is a follow-up with its own tests.

## 6. Costs

**Protocol.**
- One URL parameter (`gen`), one `meta` key (`generation`) and two close codes (4409, 4426).
- Hub protocol unchanged (`HUB_PROTO` 1). Schema unchanged (`schema=2`).

**Migration.**
- **rc documents and migrated 0.16 documents** are generation `0`. Their first load or live trigger
  over the threshold compacts them. Nothing else changes: compaction copies every root, legacy ones
  included.
- **0.16 clients** are already refused (`schema=2`).
- **rc clients** keep working in a room until its first compaction. After it, they are closed with
  4426, which they treat as a permanent close. An rc client must update to 0.17.0. That is acceptable
  for release candidates, and the alternative is merging their history back.

**Offline.** Per §5.6.

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
- **Delivery:** an addressed message receipted offline before a 4409 is not redelivered after the
  rejoin (salvage). One posted during the recycle is delivered once.
- **Client:** room-mcp replaces a session on 4409 with the same name, and the gen getter sends
  `fresh`, then the pinned value.

## 8. Soak

`scripts/soak.mts` against a local server at the 12 h soak's rate for ≥60 min, with `structs` samples
(per-root struct counts added). Compared with rc5: structs per room bounded (sawtooth below the
trigger) against rc5's 11,200/hour line, and the server's heap slope.

<!-- SOAK -->
