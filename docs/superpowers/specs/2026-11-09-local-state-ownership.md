# Local state ownership: one writer per file, one collector

Status: implemented 2026-11-09 (0.17.46), follows the storage comparison (2026-11-09) and the
decision to keep local state in files.

## Problem

`<git common dir>/room/` holds about forty file kinds. Four independent mechanisms
remove some of them (`pruneRetired`, `PolicyStore.retire`, hooks' `pruneHookReceipts`,
the 0.17.45 hourly sweep); a dozen kinds are never removed at all (`names/` leases of
dead processes, `sharing/` records of leads, `browser/*.html`, `registry/quarantine/`,
`compat/`, `storage-gate*` from the paused SQLite branch, `sessions/idle-episode.json`).
Three incidents this week (stale publisher leases, stale conflict slots, lingering
session cursors) were each "nobody owned deletion". A live clone carries 14 MB of
`registry/`, 9 MB of `relay/` (two abandoned snapshot temporaries from October), 600 KB
of a storage gate no shipped code reads.

## Rules

1. **One writer per path.** Every path pattern has one owning role (daemon, lead MCP,
   worker MCP, hooks). Another role may read it. If a second role must change it, the
   change goes through the owner (an HTTP call to the daemon, a room message, a
   request field the owner applies), not a second write.
2. **Atomic writes.** Every write is temp-then-rename (`writeAtomic`) or
   create-exclusive. No plain `writeFile` to a live path.
3. **One collector.** `localStateGc(commonDir)` knows every file kind and its lifetime
   and is the only code that deletes by age. Owners still delete their own files at the
   natural end (leave, retire, release); the collector catches what they missed.
   Runs hourly in every MCP process, as the sweep did. (Not at daemon start: the daemon
   package cannot depend on room-mcp, and every clone with a daemon has an MCP process.)
   The worker registry keeps its own 7-day retention under its locks (`pruneRetired`);
   the table names it as the owner's rule rather than re-implementing the locking.
4. **Unknown is reported, not deleted.** A path the table does not name is listed by
   `room doctor`; the collector never removes it. (`storage-gate*`, `preflight/` get an
   explicit "foreign, remove" row rather than falling under this.)
5. **The table is the contract.** `docs/reference.md` carries the table; a test builds
   the collector's rule list from the same source and fails when a file kind appears in
   code without a row.

## Table

| Path | Owner | Natural end | Collector rule |
|---|---|---|---|
| `relay.json`, `hub/incarnation.json` | daemon | never (identity) | keep |
| `relay/<room>.ydoc`, `relay/migrated-*.json` | daemon | room forgotten (`DELETE /memory`) | keep |
| `relay/*.tmp`, `hub-leases/*.tmp`, any `*.roomtmp-*.tmp` | its writer | writer's `finally` | 1 h |
| `hub/authority.lock`, `*.guard`, `*.op`, `registry/collect/*` | lease holder | release / recover | holder dead → remove |
| `hub-leases/<room>.json` | daemon | never today | keep (TODO: forget with the room) |
| `daemon.log*` | daemon | rotation | keep |
| `daemon-cutover*.json` | MCP (operator) | never | keep |
| `names/<hash>.json` | the MCP session holding the name | release on leave | holder dead and idle 1 h → remove |
| `publishers/<hash>.json` | the MCP session holding the worktree | release | holder dead and idle 1 h → remove |
| `sessions/<sid16>/*` (hook files, mcp.json, state.json, cursor, notices) | hooks for `hook*.json`, `session.json`, `runtime.json`; MCP for the rest | session ends | newest mtime 7 d → remove dir |
| `sessions/<raw sid>/idle-claims/` | MCP presence loop | claims released | same as above (TODO: move under sid16) |
| `sessions/idle-episode.json` | MCP presence loop | episode ends | 7 d |
| `hook-receipts/*` | hooks | consumed by MCP | 7 d (receipts), 1 h (tmp); moved from hooks into the collector |
| `sharing/<hash>.json` | the participant's MCP | retire (lead removes workers' today) | its worktree gone and 7 d → remove |
| `sharing/legacy-baseline.json` | MCP | never | keep |
| `compat/<hash>.json` | MCP | never | 30 d |
| `browser/*.html` | MCP (`room_open`) | opened once | 1 h |
| `profiles/*.cpuprofile` | MCP watchdog | newest 5 kept | 7 d |
| `registry/workers/<id>.json`, `tags/`, `adoptions/`, `runs/<id>/`, `patches/` | lead MCP (worker MCP writes its own run report; see TODO) | `pruneRetired` (7 d retired) | owner's rule, under the registry's locks |
| `registry/quarantine/*` | whoever quarantined | operator reviews | 30 d |
| `registry/migration.json` | MCP | never | keep |
| `storage-gate.json`, `storage-gate/`, `preflight/` | nothing in HEAD | n/a | foreign: remove |

TODOs (second writers to retire, each its own small change): `hook.json` written by
both hooks and `local-migration.ts`; `registry/workers/<id>.json` written by the worker's
`admit`; `sharing/` written by the worker, deleted by the lead; `publishers/` `requested`
written by a non-holder; `relay/` temporaries swept by MCP rather than the daemon.

## Validation

- Unit test per rule (fixture directory, fake clock, fake process probe).
- `local-state-gc.test.ts`: one fixture holding an aged and a fresh example of every row,
  asserting exactly the aged ones go; a dry-run test; a test that every rule has a row in
  docs/reference.md with the same owner and lifetime. A tool-driven "nothing grows" run
  (200 join/claim/edit/leave/spawn/collect cycles) is still to do; the soak's growth table
  covers it from the outside meanwhile.
- The soak's growth table already reports per-directory byte and file slopes.

## Not doing

SQLite; a daemon-owned sweep (the daemon is not always running in every clone);
deleting unknown files.
