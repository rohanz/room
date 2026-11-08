# Local durable state: SQLite, a daemon-owned state file, or files as they are

Date: 2026-11-09. Status: comparison for the maintainer's decision; nothing here is built. Written after
the SQLite plan was paused on 2026-11-08 ([plan](../plans/2026-11-06-sqlite-state.md), [spec](2026-11-05-sqlite-state.md),
PR #15). Numbers are from this repository's clone (`.git/room`) on 2026-11-09 unless stated.

## The question

Worker lifecycle state (records, runs, reports, exits, operation and destination leases, review holds,
cleanup intent) lives in JSON files written by several processes: the lead's MCP, each worker's MCP and the
hooks. Three options were on the table:

- **A. SQLite** (`node:sqlite`, four slices; slice 1, the async facade, shipped in 0.17.36 with no storage change).
- **B. Daemon as sole writer**: the standalone local daemon (0.17.34+) owns one atomic state file; MCPs send
  it lifecycle commands.
- **C. Files as they are**, behind the slice-1 facade, with ownership rules tightened where incidents show.

## What the data says

| Measure | Value |
|---|---|
| Worker records in the registry this week | 113 (`registry/workers`), 109 tag files, 113 run directories |
| Registry on disk | 677 files, 14 MB; 6 records older than seven days (the 7-day retention works) |
| Quarantined or malformed records in this clone | **0** (`registry/quarantine` is empty) |
| Torn or half-written registry files recorded in CHANGELOG or decisions since 0.17.0 | **0**. The 0.17.36 "damaged record is never missing" rule was defensive design, not a response to an incident. |
| Registry-adjacent incidents this week | Ownership and lifecycle logic, not file atomicity: retired-worker tombstones kept alive by the hub (2026-11-09), stale conflict slots, a kept-worktree record lost on retry (0.17.26), collect leaving "clean exit not confirmed" worktrees (0.17.30). |
| Local-state files that nothing cleaned until 2026-11-09 | 21 dead publisher leases, 92 session cursor dirs older than 7 days, 6.8 MB of snapshot temporaries |
| Coordination call latency today | room_claim p50 93–129 ms, p95 147–217 ms in the 90-minute daemon soak; room_done ~160 ms in real processes |
| Paused SQLite slice 2 | +7.7k/−0.8k lines across 169 files on the simplified branch; last pushed commit fails CI on path canonicalization; slice 2 needs the official Node 22.22.3 distribution on both hosts' PATH, and hooks may never open the database |

## How each option scores

**Correctness of the thing that has actually failed.** Every failure this week was a rule about *who owns a
record and when it ends*, spread across the doc, the hub, the registry and the views. A, B and C all leave
that problem where it is unless the ownership rules are written down in one place. SQLite would make the
registry transactional, but the registry has not produced a torn write.

**Install and runtime risk.** A raises the minimum runtime to an exact official Node distribution for the
MCP (not for hooks), adds a preflight with a restart remedy, needs NFS detection for journaling mode, and
needs a per-clone migration owner. Both hosts launch whatever `node` is on PATH; qualification was left
open for all four launch contexts. B adds no runtime but makes the daemon a required dependency for every
lifecycle read: today the daemon stops after five minutes without an authenticated writer, so a doctor
check, a hook or a `room_state` in a quiet clone would first have to start it (about 1–2 s) or read a
cached file. C adds nothing.

**Concurrency.** The real writers of lifecycle state are the lead MCP (records, operations), the worker's
MCP (reports, exits, its own run writer) and hooks (session evidence). Conflicts are already serialized by
O_EXCL leases and seq checks; the slice-1 facade is the single code path. B would remove the leases by
construction. A would replace them with transactions. C keeps them; they have held.

**Size.** A: three remaining slices, each the size of PR #15 or larger, plus migration tooling and a
compatibility window; weeks. B: a daemon write API, MCP clients, an offline read path, and the same
migration; comparable. C: zero storage work; the time goes to the ownership module and the garbage
collection that this week's incidents actually needed.

**What would change the answer.** For A: a reproduced torn or lost registry write, or lifecycle reads that
measurably hurt coordination latency after the 100 ms ceiling question is settled. For B: observed
multi-writer races that the leases do not catch, or a decision to make the daemon the authority for *all*
local state (it already is for the room document). Neither has been observed.

## Recommendation

**C now.** Keep the slice-1 facade, close PR #15 and the WIP branch as "paused, superseded by evidence"
(keep the spec; it is good design if the evidence appears), and spend the storage budget on:

1. One module that states which `participants` keys and registry records each writer owns and when they
   end, with the hub, retirement, expiry and views reading from it (the 2026-11-09 decision began this).
2. The garbage-collection pass as a tested feature: a month-of-batches fixture that asserts bounded growth
   for the document, the registry, sessions, publishers and temporaries.
3. Re-measure after that. If coordination latency or a torn write shows up, reopen A with the spec as is.

Revisit this comparison when there is one more month of real use, or sooner on the first registry incident.
