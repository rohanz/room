# Local soak: compaction at server start, 2026-10-02

This run checks the start-only compaction ([spec](../specs/2026-10-02-doc-history.md) §5) under the
[12-hour soak's](2026-10-02-soak-12h.md) load. The server is restarted twice, and each restart should compact
both rooms, bring their history and the server's memory back down, and replace every client's replica, while
leases, delivery and counters still pass.

**Answer: yes.** At both restarts, both rooms were compacted before any client synced; struct counts and RSS
fell back; all 16 refused replicas were replaced under the same name in at most 1.3 s; leases, delivery and
counters passed.

## Setup

- **Server.** Branch `compaction`, run from source by the soak itself (`SOAK_LOCAL=1`: `node --import tsx
  packages/server/src/index.ts` on 127.0.0.1:1251, fake GitHub issuer, LevelDB under `SOAK_DIR/data`) on a
  MacBook. Restarted with SIGTERM and a respawn at minutes 20 and 40.
- **Threshold.** `ROOM_COMPACT_MIN_DELETED=500`. At this load a room gains about 1,000–4,000 tombstones per
  20 minutes, so the 10,000 default would not trigger within an hour; 500 makes every restart compact both
  rooms.
- **Load.** The 12 h soak's harness and rate: 8 participants (`soak-a` … `soak-h`) in `github.com/soak/alpha`
  (5) and `github.com/soak/beta` (3), a message every 30–90 s each (half of them addressed questions), claims on
  shared files, edits including 100–500 KB files, a disconnect every 10–20 min, and one leave-and-rejoin each.
- **Timing.** 65 minutes from 13:03:31 (+08), then 6 minutes of idle samples. Samples every 2 minutes.
- **Command.** `SOAK_LOCAL=1 SOAK_DIR=/tmp/room-soak-local SOAK_SAMPLE_MIN=2 SOAK_COMPACT_MIN_DELETED=500
  SOAK_FIT_FROM_MIN=10 npx tsx scripts/soak.mts run --minutes 65 --restart-at 20,40 --participants 8 --post-idle 3`.
- **Measurement.** Structs are counted on the soak observer's replica of each room (a read-only client that,
  like every client, takes a fresh replica when refused). It holds what the server holds, history included.
  RSS and CPU come from `ps` on the server process; RSS includes the tsx loader.

Activity: 768 posts accepted (660 addressed), 1,128 ledger deliveries, 134 claims taken, 107 releases, 60
large edits, 29 disconnects, 8 leave-and-rejoins, 55 same-id resends.

## Structs and memory around each restart

The server's own log line gives the stored document compacted at load. The observer's first sample after the
restart (20 s or more after `/health`, by which time all 8 clients had rejoined and republished their overlays)
gives the room as clients saw it.

| restart | room | before (structs, deleted) | compacted at load | first sample after | RSS before | RSS after restart |
|---|---|---|---|---|---|---|
| 1 (min 20) | alpha | 3,182 (2,070) | → 356 | 716 (206) | 163.7 MB | 118.6 MB |
| 1 (min 20) | beta | 1,329 (963) | → 194 | 392 (126) | | |
| 2 (min 40) | alpha | 5,928 (4,241) | → 798 | 1,290 (366) | 170.9 MB | 119.2 MB |
| 2 (min 40) | beta | 2,413 (1,670) | → 338 | 557 (159) | | |

- **Each compaction took 25–81 ms** (log line to log line, the write included), and each room got a new
  generation. The stored document the server compacted differs slightly from the observer's last sample (5,920
  against 5,928 structs at restart 2): writes in the last seconds before the stop were not stored.
- **The sawtooth.** Alpha grew from 716 to 5,928 structs in the 20 minutes after restart 1, and from 1,290 to
  6,513 by the end. Without compaction every restart reloads the whole history since the room opened, so each
  reload would be larger than the last.
- **RSS rises right after a restart.** It went from 118–119 MB to 180–192 MB within 2 minutes of each restart,
  as eight clients join with fresh replicas and republish their overlays (including the 100–500 KB files).
  Between restarts it ranged 129–234 MB. Idle after the stop: 165–171 MB.
- **What the history is** (the final alpha room, 25 minutes after restart 2, read with `soak.mts structs` on
  the stopped soak's data with compaction off): 5,525 structs, 3,473 deleted. Roots: `conflicts` 1,658,
  `seen:*` 803, `basetextFlat` 774, (gc) 492, `meta` 480, `bus` 449, `manifestHead` 406, `graphs` 319. Most of
  it is member-written, as the spec's §3 predicted.

## Replacements

At each restart, every connected client stated the old generation and was refused with 4409 before any sync
(12 `refused a replica of an earlier generation` lines, plus the observer's 4). Each participant was replaced
through `StaleReplacement`, the code room-mcp's auto-join runs:

- **16/16 replaced under the same name**, in 0.7–1.3 s, each at a new, higher epoch (the same session id
  takes the name again at once). No replacement failed, and no loop errors or unhandled rejections occurred.
- **Back after `/health`:** 2.3 s for the slowest participant at restart 1. At restart 2, 2.3 s for all but
  `soak-e`, which first saw the drop 16 s late and was back at 17.2 s. Two participants per restart were
  already inside a planned disconnect, and are counted when they reconnected.

## Pass criteria

| Criterion | Result | Evidence |
|---|---|---|
| Structs drop back at each restart | **PASS** | Both rooms compacted at both restarts: alpha 3,182 → 356 and 5,928 → 798, beta 1,329 → 194 and 2,413 → 338 (table above) |
| RSS drops back at each restart | **PASS** | 163.7 → 118.6 MB and 170.9 → 119.2 MB |
| Leases | **PASS** | 0 connected clients lost their lease; name drift none; rejoins under the same name 8/8, replacements under the same name 16/16; 14 hub expiries, all of real disconnects, 31–44 s after them; nothing still live after the stop |
| Delivery | **PASS** | 660 addressed messages: 0 lost, 0 owed at the stop. 2 duplicate deliveries (both `soak-f`), both at-least-once: the receipt was written offline and its replica discarded before it reconnected. 55/55 same-id resends returned the original seq |
| Counters | **PASS** | No seq named two ids; epochs rose per name; both restarts took new incarnations with every later seq higher (restart 1: highest before 3755826059673718, lowest after 3755828561575939) |
| Health | **PASS** | 394 probes, 0 failures outside the restart windows |
| Memory slope | not applicable | The report's line fit (97 MB/hour over 19 samples) does not apply to one hour with a restart every 20 minutes. The buses were still filling (382 → 1,509 entries, cap 2,000); the 12 h soak's criterion likewise left out the fill hours |

## Findings

1. **Compaction at start bounds history across restarts as designed.** Every restart reloaded a few hundred
   structs instead of everything since the room opened.
2. **A replacement costs about a second per client**, on top of the reconnect a restart already costs, and in
   this run it lost nothing beyond at-least-once duplicates.
3. **A rejoin burst follows every compacting restart.** Fresh replicas and republished overlays add a few
   hundred structs and about 60 MB of transient RSS. That is the price of restart semantics. At real rates and
   the 10,000 default, a room compacts at most at each deploy.
4. **`conflicts` is the largest single source of history** under this load (30% of alpha's structs). Compaction
   bounds it like every other root; making those records reuse keys would slow the growth between restarts.
