# Room document history: compaction at server start, with a document generation (0.17.0)

Status: implemented, 2026-10-02, on `compaction`: a room is compacted when the server loads it after a start
(§5). The online design that compacts live rooms was reviewed but not built; §9 keeps it for later. Input: the
[12-hour soak of rc5](../rehearsals/2026-10-02-soak-12h.md), finding 1.

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
it too or leaves history growing. Built in its smallest form: only at server start (§5).

## 5. Design (implemented): compaction at server start

**Decision (Rohan, 2026-10-02): the small version.** A room is compacted only when the server loads it after
a start. There is no online compaction, no recycle or drain, and no stale-connection machinery; §9 keeps
that design for later. Room has a couple of users, and the 0.17 cutover already starts every room fresh, so
compaction only has to keep rooms bounded across deploys.

**The rule:** for a client, a generation change is a restart of its replica. Room already depends on restarts
being safe: every MCP process restart, leave-and-rejoin and relay takeover discards a replica and joins afresh
under the same name, and the soak's at-least-once accounting covers them. A compacting start is a server
restart, which disconnects every client anyway; what it adds is that each client then rejoins with a fresh
replica instead of resyncing the old one.

### 5.1 When the server compacts

- **When:** at a room's **first load in a server process**, in `ServerHubs.persistence().bindState`
  (`packages/server/src/hub.ts`), on the stored document, before it is applied to the live `WSSharedDoc` and
  before the upgrade that loaded it completes. So no client syncs before the decision. A room that unloads and
  loads again in the same process is not compacted again; the next process start decides again.
- **Threshold:** `deleted ≥ ROOM_COMPACT_MIN_DELETED` (default **10,000**; `0` or `off` disables), counted by
  `historyOf` in one pass over the struct store.
  - At ~305 B of heap per tombstone, 10,000 is ~3 MB per room: below it a compaction saves too little to be
    worth a fresh replica for every client.
  - At the soak's rate a room passes it in about 2 hours; at a tenth of that, in about a day of activity. A
    weekly deploy therefore compacts every busy room.
  - It is a single number on purpose: a start-time compaction costs every client only a fresh replica on top
    of the reconnect the restart already costs it (§5.6), so no ratio to live structs is needed.
- **The routine (`compactAtLoad`):**
  1. Read the stored document (as every load does).
  2. Under the threshold: serve it as it is.
  3. Over it: `compactDoc(stored, newGeneration)` with a random 128-bit `meta.generation`, then **one atomic
     write**, `provider.replace` (LevelDB: one batch that deletes the old update records and puts the snapshot
     and its state vector; memory: one map entry). Then serve the copy.
  4. A copy that throws (XML types, subdocuments) or a provider without `replace` leaves the room
     uncompacted for this process, logged. A failed or interrupted write leaves the stored document **and its
     generation** intact, and the room's next load retries.
- **A crash during compaction** happens before the batch (nothing written) or after it (the copy stored); a
  LevelDB batch is never half applied. The old document is kept either way. `ServerHubs` takes a
  `beforeReplace` hook, which the crash test uses to hold the window open and kill the process inside it.
- **Logged:** `room <name>: compacting at load: N structs (D deleted)`, then `compacted at load: N structs (D
  deleted) -> M structs, generation G`.

### 5.2 Generations, and what a client states

- `meta.generation` is written only by compaction. A document without one (every rc and migrated 0.16
  document) is generation `0`. `compactDoc` does not copy the old generation, so the copy holds no tombstone.
- **Every Room websocket URL carries `gen`** beside `schema=2`, read again at every (re)connect: Room's
  providers get `roomConnection(doc)` (`packages/shared/src/compact.ts`), whose `params` has an enumerable
  getter (y-websocket encodes `params` into each URL).
- **The value is derived from the replica, not pinned by a frame:**
  - `fresh` while the replica holds no server data: no non-local transaction has run on it since it was
    watched (every remote `applyUpdate` runs one, even when its structs can only be kept pending), and its state
    vector names no other client. Whatever it wrote itself names no server item, so it merges into any
    generation. `roomConnection` starts the watch before the provider connects.
  - otherwise the generation its data came from: `meta.generation`, or `0` when absent.
  - Data received before the full sync (a broadcast whose structs cannot integrate yet, a deletion alone)
    counts as server data. If it arrived without `meta.generation`, the replica states `0`: at worst a
    needless refusal and rejoin, never a merge.
  - Only a server start changes a room's generation, and the server refuses (§5.3) every replica of an earlier
    one, so a replica only ever holds data of one generation.
- **BroadcastChannel is off on every Room provider** (`disableBc: true`): y-websocket would otherwise
  exchange full state between providers of one room in one process or browser, whatever their generation. No
  Room feature uses cross-provider sharing.

### 5.3 The gate (server, at upgrade)

It runs in the upgrade, under the repo lock, after the room has loaded (so after §5.1), and before
`setupWSConnection`: the server has sent no sync step and read nothing the client sent. The room's current
generation is `G` (`0` if none).

| `gen` param | result |
|---|---|
| `fresh` or `G` | normal connection |
| any other value | close **4409** "this room's document was compacted when the server restarted; rejoin with a fresh copy" |
| absent (an rc client), `G` is `0` | normal connection (rc clients are unaffected until the room's first compaction) |
| absent, `G` is not `0` | close **4403** "update Room to 0.17.0 or later (browser: reload the page): this room's document was compacted" |

- Both codes are in y-websocket's 44xx range, so **no provider reconnects by itself**: a refused replica
  cannot loop or merge.
- **rc clients fail safe.** rc room-mcp's `watchClosed` treats 4403 as final and stops reconnecting; the rc
  web view shows the reason and stops. New clients always send `gen`, so they never get 4403 from the gate.
- **Read-only (view) connections** pass the same gate.
- A member who overwrites `meta.generation` only makes replicas state a value the room no longer has, which
  costs refusals and fresh rejoins, never a merge.

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
  - The hub starts as on any server restart, which the soak verified: leases adopted, a new incarnation, no
    counter reuse.
  - Seqs and epochs in the copied `bus`, `mail` and `meta` mirrors are values, so `highestSeq`, duplicate
    detection by id and the ledger cursor (`cursor.json` frontier) are unaffected.

### 5.5 Clients: replacing a refused replica

Each client does what it does when its own process restarts: it discards the replica and joins afresh under
the same name.

**room-mcp** (`packages/room-mcp/src/compacted.ts`, wired in `index.ts`):
- `watchClosed` turns a 4409 close into `session.stale` (startup closes are captured as the size cap's are).
  A stale session is not "joined", so the **auto-join** (the startup join, single-flight, with its retries,
  backoff, deadline and failure reporting) runs at once, and every tool call already waits for it.
- Its attempt is the **host-rebind path**, through `StaleReplacement`:
  1. drop every joined session (the workers room first, then the primary);
  2. join the same room under the same name with the **same session id**, so the hub grants the name again
     at once (same holder) with a new, higher epoch;
  3. remove this participant's persisted bridge mirrors (`by` = its name, `mirrorOf` set) from the fresh
     replica: the dropped bridge's map from local claims to mirrors was in memory only, and its removals went
     into the refused replica, while the new bridge mirrors every local claim again;
  4. adopt the session **without** `clearStale`, as a host rebind does: the participant's claims and scope
     are in the compacted room under its name and stay;
  5. rejoin and re-attach the workers room (`attachWorkersRoom`), which starts a new bridge. If that fails, it
     is logged, and the workers room is joined again when a worker needs it.
- Transient failures are retried by the auto-join; permanent ones (`NotLoggedIn`, `NoRoom`) end it with its
  usual one-line failure, and `room_login` / `room_join` work as at startup.
- **roomd** runs inside the session and is replaced with it.

**Web view.** A 4409 close reloads the page: a view has no writes to keep, and the reload trades its link
credential (kept in `sessionStorage`) for a new ticket. A 4401/4403 close shows the reason, as before.

**roomagent.** A 4409 close settles the runner and exits with code 75 and "restart roomagent to rejoin with a
fresh copy"; 4401/4403 exit 1 with the reason. Its supervisor or its human restarts it, which is what a
restart already does. Any other close reconnects as before.

**Scripts** (`say.mts`, `wake-e2e.mts`, `soak.mts`) state a generation too; the soak's participants use the
same `StaleReplacement`, and its observer takes a fresh replica.

### 5.6 What a compacting restart loses

What a replacement loses is what a restart of the client at that moment loses: document writes that never
reached the server. A connected client loses only what it wrote between the server stopping and the 4409
(the restart window, a few seconds); a client disconnected when the server restarted loses its offline writes
(its lease fence stops background writers 45 s into a disconnection).

| Write | After the replacement |
|---|---|
| Receipts (`seen:<me>`) written in that window | Not carried. The messages are delivered again: duplicates, within at-least-once, as after a restart |
| Overlays, manifest, `basetextFlat` | Republished by roomd at start |
| `participants` `id`/`proj`/`git` | Rewritten at start |
| Worker views, graphs, colours, coordination | Rebuilt by the projector and the new bridge |
| Claims, scope, release by a tool in that window | Not carried: tools refuse to run unsynced ("room not synced yet, retry"), but one already writing when the server stopped loses its write, as in a crash |
| Worker retirement written by the projector in that window | Not retried: the worker's view, claims and names linger until the room's stale expiry, as after a client restart today (roadmap below) |
| Claim re-anchoring by roomd on a HEAD transition | The claim shows its last synced lines until roomd's next transition |
| `pushedPending` (a `pushed` notice a HEAD transition owes) | The notice is not sent |
| roomagent chat lines | Not carried |
| The name lease | Kept by name: the same session id takes it again at once, at a new, higher epoch |

Posts are not in this table: they go through the hub, which answers each one. A post the client sends after
the restart is retried with its id until accepted, and a duplicate id returns its original seq.

**Retirement re-verification** (§5.6 of the online design: re-run `retireWorker` on every sync for records
retired recently but missing from `retiredWorkers`) is **not built**. A restart does not need it any more
than a process restart does; it closes the same gap for both. It is on the roadmap.

### 5.7 Local relay rooms

The relay is unchanged, and ignores `gen`:
- **It already restarts from a value copy.** A relay's documents are saved as value copies
  (`memorySnapshot`, `relay/src/memory.ts`), so a relay restart already loads a compacted document: history
  stays bounded across restarts without this change.
- **Known gap, unchanged.** A survivor reconnecting with pre-snapshot identities is the relay's existing,
  documented gap (deduped by id). A relay takeover seeds the successor from a live replica, keeping its IDs.
- **Later:** the same gate (a generation stamped at each snapshot load) would close that gap. It is a
  follow-up with its own tests.

## 6. Costs

- **Protocol.** One URL parameter (`gen`); one close code (4409) and a new 4403 reason; one `meta` key
  (`generation`); `disableBc` on every provider. Hub protocol unchanged (`HUB_PROTO` 1); schema unchanged.
- **Server.** `compactAtLoad` in the persistence's `bindState`, the gate in the upgrade, one env variable.
- **Clients.** `roomConnection`; room-mcp's `StaleReplacement` inside the auto-join; web reload; roomagent exit.
- **Migration.** rc and migrated 0.16 documents are generation `0` and compact at their first load over the
  threshold after a deploy. rc clients work until their room's first compaction, then get 4403 and must
  update. 0.16 clients are already refused (`schema=2`).
- **Availability.** A compacting start costs each client one extra join (a few seconds) after the reconnect.
- **Memory.** A compaction holds the stored document and its copy for a few milliseconds per room.

## 7. Tests (failing first)

- **Shared** (`packages/shared/src/compact.test.ts`): `compactDoc` copies every root kind, nested types and
  claim anchors, refuses XML, and leaves no tombstone of an old generation; `historyOf`; the stated generation
  is `fresh` with only local writes, pinned by any server data (pending structs and deletions included), `0`
  or `G`; `params.gen` follows the replica; `roomConnection` turns BroadcastChannel off; every gate row.
- **Server** (`packages/server/test/compaction.test.ts`):
  - a room over the threshold compacts at its first load, is stored as the copy, is not compacted again in
    the same process, and is compacted again (new generation) by the next process;
  - under the threshold nothing changes; a failing `replace` keeps the stored document and generation, and
    the next process compacts;
  - **bounded across six restarts under the harness's mix** (posts, receipts, answers, claims, renewals, ticks
    against a real hub): tombstones at every load stay under the threshold, while the same run without
    compaction ends over 5× it; `seq` rises strictly across every compacting restart;
  - on a real server over LevelDB: a stale replica is closed with 4409 before any sync and its offline write
    never arrives; a fresh replica has the generation, no tombstones and no duplicated values; the lease
    renews at its epoch after the compacting restart; seq rises and a same-id post returns its original seq;
    an rc client gets 4403 with the update text; a view connection passes the same gate; the next restart,
    with nothing to compact, keeps the generation and accepts the current replica;
  - **crash:** the server is killed (SIGKILL) inside the compaction window; the stored document is intact
    with no generation, and the next start compacts it.
- **room-mcp** (`packages/room-mcp/test/compaction-rejoin.test.ts`): a real room-mcp process in a team room,
  a second participant, a compacting restart: the refused session rejoins under the same name and session id,
  keeps its claim once and its scope, a persisted mirror is removed, an owed note is delivered once (and not
  again), the lease is held by the same session at an equal or higher epoch, and coordination is not paused.
  Without the wiring in `index.ts` the test fails (no rejoin).
- **Web** (`conn.test.ts`): `gen` and `disableBc` on the provider; a 4409 close reloads and never reconnects.
- **roomagent** (`connection.test.ts`): 4409 exits 75 with the restart line; 4401/4403 exit 1; other closes
  reconnect.

## 8. Soak

`scripts/soak.mts` in local mode (`SOAK_LOCAL=1`) against a local server for ≥60 minutes at the 12 h soak's
rate, with restarts partway through, sampling each room's structs on the observer's replica.

[Local soak, 2026-10-02](../rehearsals/2026-10-02-soak-compaction-local.md): 65 minutes, 8 participants,
restarts at minutes 20 and 40, `ROOM_COMPACT_MIN_DELETED=500` (the default would not trigger within an hour at
this rate).
- **Both rooms compacted at both restarts**, before any client synced: alpha 3,182 → 356 and 5,920 → 798
  structs, beta 1,329 → 194 and 2,394 → 338, in 25–81 ms each.
- **RSS fell back** at each restart: 163.7 → 118.6 MB and 170.9 → 119.2 MB. A rejoin burst follows: eight fresh
  replicas republishing overlays bring it to 180–192 MB within 2 minutes.
- **16/16 refused replicas replaced under the same name**, in 0.7–1.3 s each, at higher epochs.
- **Leases, delivery and counters pass:** no connected client lost its lease; 660 addressed messages, 0 lost,
  2 duplicates, both at-least-once; no seq reused across either restart.
- **Where the history comes from** (alpha, 25 minutes after restart 2): `conflicts` 30% of structs, then
  `seen:*`, `basetextFlat`, `meta`, `bus`, `manifestHead` and `graphs`; mostly member-written, as §3 predicted.

The soak's RSS line fit does not apply to one hour with restarts every 20 minutes (the buses were still
filling). A multi-hour run on staging remains the check of the server's long-term slope.

## 9. Future, if usage grows: online compaction

If rooms ever need compacting between deploys (busy rooms on a long-lived server), the reviewed online design
(fifth draft, 2026-10-02) adds, on top of what is built:
- **A live trigger:** `ServerHubs.tick` measures loaded rooms every 60 s and compacts one when
  `deleted > max(ROOM_COMPACT_MIN_TOMBSTONES, live structs)`, at most once per `ROOM_COMPACT_MIN_INTERVAL_MIN`.
- **A recycle under the repo lock:** anchor the document with a placeholder connection, close every socket
  with 1012, drain until each socket's close (bounded at 5 s), flush the final leases and stop the hub, unload,
  compact the stored document, reset per-document state.
- **A generation frame** (message type 8, `{ g, current }`) sent before any document data, because the
  generation could change while a replica is connected.
- **Stale, hub-only connections**, so a refused session's pending posts settle over its old connection and its
  leave releases its lease; they start and anchor the room's hub.
- **A `writable()` check** before every tool write, so a tool call spanning the replacement reports an error
  instead of success, and a settle step (60 s) before the old session is dropped.
- **Retirement re-verification** on every sync.

Its review log follows (§10, rounds 1–4).

## 10. Review log

### The online design (fourth and fifth drafts)

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

  The fourth draft removed the translator and the previous generation and adopted restart semantics.
- **Round 4** (Astra, 4 must-fix), fixed in the fifth draft:
  - Rebuilding the bridge duplicated persisted mirror claims: mirrors are now deleted before re-attach.
  - Writes between a disconnect and the stale frame went unreported: tool writes now require
    `writable()`.
  - Hub-only connections didn't start or keep a hub: they now start it and anchor the document.
  - Replacement retries blocked recovery tools: permanent failures end the replacement, and tools stop
    waiting after the first attempt.

What the built design keeps from these rounds: BroadcastChannel off (1), server data before a full sync pins
the replica (1), the participant's own claims kept on adoption (1), a failed secondary rejoin does not strand
the session (2), probe and roomd each state their own document's generation (2), a failed compaction keeps
the old generation (2, 3), and persisted mirrors removed before the bridge is rebuilt (4). The drain, the
anchor, the frame, hub-only connections, `writable()` and the settle step belong to the online design only.

### The implementation (start-only)

- **Round 1** (Astra, 1 must-fix): a session refused during its own join (4409 captured at startup) asked the
  auto-join for a replacement while that join was still in flight, and got it back instead: nothing replaced
  it. `rejoinWhenStale` now waits for the in-flight join to settle, then replaces the session if it is still
  current and stale; a regression test fails without it.
- **Round 2** (Astra, 1 must-fix): roomagent's shutdown guard was declared after the awaited first sync, so a
  4409 during that sync hit the temporal dead zone and rejected instead of exiting 75. Fixed, with a test that
  closes the socket during the first sync.
- **Round 3** (Astra): no must-fix.

Before the rounds, a cleanliness review (Rohan) moved the crash test's compaction window out of the server
(a test child process injects it through `beforeReplace`), put comments back on their declarations, replaced the
Yjs store internals in `replicaGeneration` with public signals (a non-local `afterTransaction`, the state
vector), and kept `params`' getter with a comment and a test against `WebsocketProvider.url`.
