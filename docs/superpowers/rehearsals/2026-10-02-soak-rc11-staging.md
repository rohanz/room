# Staging soak: Room 0.17.0-rc11 (compaction at server start), 2026-10-02

This run confirms on staging the start-time compaction of [spec §5](../specs/2026-10-02-doc-history.md), at the
**default** threshold (`ROOM_COMPACT_MIN_DELETED` = 10,000), under the [12-hour soak's](2026-10-02-soak-12h.md)
load. The [local soak](2026-10-02-soak-compaction-local.md) tested the same design at a threshold of 500.

**Answers**

- **Compaction works as shipped.** Every restart that loaded a room past 10,000 deleted structs compacted it
  before any client synced: 3 room compactions over 2 compacting restarts, plus the migration of rc5's rooms.
  - Structs fell by 85–95%, and RSS fell from 217 to 129 MB.
  - All 13 refused replicas were replaced under the same name, in 1.1–3.1 s each, with no rejoin loops.
  - Leases, delivery and counters pass. A restart under the threshold left the room untouched, as specified.
- **Memory is now bounded across restarts, but only by them.** It is a sawtooth, not a plateau.
  - Each compacting restart brings RSS back to 109–129 MB, against rc5's 150–200 MB after a restart.
  - After the run the server idled at 131 MB, against rc5's 198 MB.
  - Between restarts RSS still drifts: 7.0 MB/hour without conflict detection (rc5: 7.07, unchanged, as
    expected), 13 MB/hour with it.
  - The drift is Yjs history: receipts, bus churn and, above all, conflict slots, which compaction resets at
    the next restart and nothing reclaims in between.
- **The previous soaks ran without conflict detection.** The harness never attached room-mcp's hooks, which
  start the conflict watcher, except after a stale-replica replacement. Fixed here. With conflict detection the
  history grows about 3× faster (alpha 16.5k deleted structs/hour against 5.1k), and so do CPU and memory. The
  rc4/rc5 slopes therefore understate a real deployment of this load.

## Setup

- **Server.** Staging machine `2879590f442648` (sin, shared-cpu-1x, 512 MB), image rc11 (`redesign` at
  `fb28550`, tag `v0.17.0-rc11`), deployed by the lead with `deploy/fly.staging.toml`. Defaults throughout:
  `ROOM_COMPACT_MIN_DELETED` unset (10,000), `MALLOC_ARENA_MAX=2`.
- **Load.** The 12 h soak's harness and rate: 8 fake-login participants in `github.com/soak/alpha` (5) and
  `github.com/soak/beta` (3), a message every 30–90 s each, claims on shared files, edits including 100–500 KB
  files, disconnects every 10–20 min, and one leave-and-rejoin each.
- **Harness changes** (`scripts/soak.mts`, committed with this write-up):
  - `SOAK_RESTART_WHEN_DELETED` restarts when a room's observed deleted structs reach a count, with
    `SOAK_RESTART_MAX` and `SOAK_RESTART_GAP_MIN`.
  - `tools.attachHooks` now runs on every join, as room-mcp does.
  - The default machine id is now this machine.
- **Timing.** Two phases on the same rooms, 270 minutes of load in total, plus a 19-minute false start (below).
  - **Phase 1** (07:58–11:00Z, 180 min) ran the harness as it stood: no conflict detection until a
    replacement attached it.
  - **Phase 2** (11:08–12:38Z, 90 min) ran with conflict detection from the start, with one restart at
    minute 60.
- **Why two phases.**
  - In phase 1 the harness ran without conflict detection, so alpha gained about 5,100 deleted structs per
    hour (server-side) and beta about 3,000.
  - At that rate, 180 minutes holds only one restart over the default for alpha, and none for beta. A second
    compacting restart needed phase 2.
  - The 19-minute false start was dropped because its trigger (11,000 observed) would have fired only once.

### Counting deleted structs: the observer is not the server

The trigger first used the soak observer's long-lived replica. It counts about 1.2× the server's deleted
structs: alpha's observer showed 9,518 at the first restart, and the server stayed under 10,000 and did not
compact. A fresh replica decodes exactly what the server holds: in the migration below, `soak.mts structs`
showed 8,074 structs against the server's 8,073. The second restart was therefore timed from fresh-replica
counts.

## Migration: rc5's rooms at their first rc11 load

Staging still held the 12 h soak's rooms (generation 0) when rc11 started. Each one compacted at its first load:

| Room | Stored (deleted) | After compaction | Generation |
|---|---|---|---|
| alpha | 83,670 (73,410) | 8,073 | `a53bfd75…` |
| beta | 44,834 (38,260) | 4,576 | `56828d03…` |

`/data` went from 4,424 KB to 3,228 KB. Both synthetic rooms were then closed (`DELETE /rooms`), so the soak
started from empty rooms.

## Restarts

| Restart | Trigger | Rooms compacted (structs, deleted → after) | Replicas refused / replaced | Back after `/health` | RSS before → after restart → +10 min |
|---|---|---|---|---|---|
| Phase 1, min 92 | alpha observed 9,518 deleted (server under 10,000) | none: alpha and beta stayed at generation 0, the control case | 0 / 0 | 1.3–2.9 s (2 others were in planned disconnects) | 134.3 → 146.6 → 152.3 MB |
| Phase 1, min 122 | timed (alpha 12,489 deleted server-side) | alpha 16,162 (12,489) → 1,247 | 5 / 5, same name, 1.7–2.3 s | 8.3–9.2 s alpha, 1.8–2.7 s beta | 127.8 → 109.0 → 162.5 MB |
| Phase 2, min 60 | scheduled from fresh counts | alpha 33,000 (25,559) → 4,710; beta 21,493 (17,990) → 1,523 | 8 / 8, same name, 1.1–3.1 s | 7.8–12.9 s | 217.4 → 128.5 → 176.8 MB |

- **Compaction time.** Each took about a second, log line to log line, including the write.
- **Replacement.** Every replica of the earlier generation was refused with 4409 before any sync
  (`refused a replica of an earlier generation`), and was replaced at a new, higher epoch on the first attempt.
  The soak observer's replica was replaced too.
- **"Back" after a compacting restart** includes the replacement, so it is about 7 s longer than after a plain
  restart.
- **The rejoin burst.** RSS rises about 50 MB within 10 minutes of a compacting restart, as the fresh replicas
  republish their overlays. This matches the local soak.
- **Persisted size.**
  - The server's log gives the compacted document's structs. The encoded size the observer receives barely
    moves (alpha 5,961 → 5,633 KB at phase 2), because it is dominated by live overlay text: the 100–500 KB
    files.
  - `/data` is not a clean measure, because LevelDB compacts its files later: 6,688 KB just before the
    phase-2 restart, 9,880 KB right after it (the new snapshot is written before the old records are cleared),
    then 2,580 KB ten minutes later.

## Memory and CPU between restarts

| Segment | Conflict detection | RSS slope | RSS mean | Server CPU |
|---|---|---|---|---|
| Phase 1, min 10–92 | off | 7.0 MB/hour | 140 MB | 1.4% of a core |
| Phase 1, min 133–180 (alpha after its compaction) | on in alpha only | 22.7 MB/hour (rejoin burst included) | 181 MB | 3.6% |
| Phase 2, min 10–60 | on | 13.1 MB/hour | 209 MB | 6.0% |
| Phase 2, min 70–90 (after compacting both) | on | 7.1 MB/hour (3 samples) | 176 MB | 6.9% |
| rc5, 12 h, hours 1–12 (for comparison) | off | 7.07 MB/hour | | 1.1% → 3.8% |

- **Idle levels after the load stopped.** Phase 1: 176–191 MB (beta never compacted, alpha had regrown).
  Phase 2: 130.5–131.7 MB, minutes after a compaction of both rooms and 30 minutes of load. rc5 after 12 h:
  198 MB.
- **What drives the drift.**
  - With conflict detection, each room keeps conflict slots (alpha had 427 after 10 minutes of phase 2).
    Merge conflicts on shared files are re-derived and rewritten as overlays change.
  - Add receipts (`seen:*`: alpha 2,059 keys at phase-2 minute 10), bus trims and the archive.
  - Server-side deleted structs grew by about 16,500/hour in alpha and 10,700/hour in beta, against 5,100 and
    3,000 without conflict detection.
  - CPU follows, since the hub's trim and the conflict reconcile walk those maps.
- **What would bound it between restarts.** Only online compaction (spec §9), or fewer rewrites at the source:
  conflict slots and receipts that reuse keys. At this load a room crosses the default threshold in about 40–60
  minutes. At real rates (about a tenth of this) that is roughly a working day, so a weekly deploy compacts every
  busy room, but its history and memory still drift for the rest of the week.

## Pass criteria

| Criterion | Result | Evidence |
|---|---|---|
| Each compacting restart drops structs and the persisted document | **PASS** | 3 room compactions over 2 compacting restarts, plus the 2-room migration: structs fell by 85–95% (table above). The persisted encoded size is dominated by live overlays and barely moves; `/data` dropped 4,424 → 3,228 KB at the migration. |
| Replicas replaced under the same name, no rejoin loops | **PASS** | 13/13 refused replicas replaced under the same name, on the first attempt, in 1.1–3.1 s; no `replace-failed`, loop errors or unhandled rejections. |
| No connected lease loss | **PASS** | 0 in both phases. 0 TTL-edge lapses; all 65 hub expiries followed real disconnects, at most 47 s later. No name drift, 16/16 leave-and-rejoins kept their names. |
| Delivery: 0 lost; duplicates within at-least-once | **PASS** | 2,751 addressed messages, 0 lost. 1 duplicate (phase 2, soak-e), at-least-once: its receipt was written offline and the replica was then discarded. 2 still owed at the stop (sent in the last minute). 187/187 same-id resends returned the original seq. |
| No counter reuse | **PASS** | No seq named two ids; epochs rose per name; all 3 restarts took new incarnations, and every later value was higher than every earlier one. |
| Health | **PASS** | 1,628 probes. One isolated probe timeout in phase 1 (minute 56), with Fly's own check passing. Fly's check and proxy errors occur only in the restart windows. |
| RSS slope and level vs rc5's 7 MB/hour | **Bounded across restarts, still drifting between them** | Without conflict detection the slope is unchanged (7.0 against 7.07 MB/hour), but each compacting restart returns RSS to 109–129 MB and idle to 131 MB (rc5: 198 MB idle). With conflict detection the drift between restarts is 13 MB/hour. |

## Findings

1. **Compaction at start does what the spec says on staging, at the shipped default.** It also migrates
   pre-compaction (rc) rooms at their first load.
2. **Memory is bounded only by restarts.** With realistic conflict detection, a busy room's history and the
   server's RSS grow 13 MB/hour between restarts at this load. Not release-blocking at real rates with weekly
   deploys, but online compaction (spec §9), or key-reusing conflict slots and receipts, is what would make it
   flat.
3. **Harness fix: the earlier soaks had no conflict detection** (`scripts/soak.mts` never called
   `tools.attachHooks` on a normal join). rc4 and rc5 load and slopes were therefore light. Fixed in this
   commit; the local compaction soak's `conflicts` share came from its replacements, which did attach hooks.
4. **Log noise: conflict notices.** Each participant's conflict watcher posts conflict and merge-conflict
   notices as the shared `room` identity. The server's observe-only identity check then logs every one
   (`hub: observed a post from "room" by soak-X; accepted`): 742 lines in phase 2's 90 minutes. Not a fault;
   worth exempting the `room` identity from that log line.
5. **The soak trigger needs server-equivalent counts.** The observer's long-lived replica over-counts deleted
   structs by about 1.2×. `soak.mts structs` (a fresh replica) matches the server.
