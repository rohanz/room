# Session event-loop stalls: preview publication and registry retention

Measured on the owner's Mac (`MacBook-Pro-4.local`, arm64, Darwin 25.5.0),
Node v22.23.4, from the `stalls` worktree. CPU model and process priority could not
be inspected in the sandbox (`sysctl`/`ps` denied); `nice -n 10` was also refused.
Vitest used one worker. Disk load from the other batch workers was uncontrolled.
These are instrumented observations, not production latency guarantees.

## Preview publisher

Method: `preview-publication-stalls.test.ts` initializes an empty Git repository,
starts an attempt, and completes it. A spy counts each `fsyncSync` and timestamps
the real call with `performance.now()`. Both operations use the real publisher
guard. The regression assertion failed on the original code (28 sync calls).
The count depends on the temporary directory's depth because the durable writer
also syncs every ancestor.

| Publisher pair | Synchronous fsyncs | Time inside synchronous fsyncs | Total elapsed |
| --- | ---: | ---: | ---: |
| Original | 28 | 39.0 ms | 59.0 ms |
| Async guard | 0 | 0 ms | 87–205 ms across observed runs |

Afterwards, a 10 ms interval measured 3.3–5.0 ms maximum excess delay in the
publication fixture. No wall-clock regression threshold was added to this unit
test. It asserts the absence of synchronous fsync instead.

The guard still publishes a fully written, file-synced token through an exclusive
hard link, syncs parent directories, checks process identity on recovery, and
removes only its own nonce. Dropping token fsync would permit a power failure to
leave an unreadable guard, which intentionally cannot be reclaimed as a dead
holder. Instead, `withGuardAsync` awaits equivalent filesystem operations. The
decision callback remains synchronous: final authority checking, reading the
latest attempt nonce and atomic evidence replacement cannot interleave with
another task in this process. Existing evidence bytes and their atomic, unsynced
replacement are unchanged. In the initial commit the existing synchronous
authority, name-lease and worker-registry primitives were unchanged. The follow-up
below intentionally adds acquisition-error cleanup to both guard paths.

Async waiting improves responsiveness, not necessarily elapsed publication time.
Directory policy checks and occasional process probes remain synchronous; this
change specifically removes synchronous durability waits from preview publication.

## Worker registry

Method: `registry-stalls.test.ts` writes 90 fresh records, each with a run, report,
exit and log. Sixty active `dir=` records have noncanonical checkouts and no
`sharedWith`; thirty records are recently retired. No record has expired. This
exercises inferred checkout ownership without copying the owner's private state.
The clock stays within the read cache's racy timestamp window so even slow CI
cannot hide duplicate reads through a warmed cache. A spy counts real JSON reads
under the registry root and times `retireWorkerMail` and `pruneRetired` separately.

| Operation | Original reads | New reads | Original elapsed | New elapsed across observed runs |
| --- | ---: | ---: | ---: | ---: |
| Mail | 270 | 180 | 46.6 ms | 38–78 ms |
| Prune | 16,470 | 180 | 608.7 ms | 14–19 ms |

The original prune reread individual records up to 122 times. Each new inventory
reads a worker record and its tag reservation once. Reservation validation uses
the records already decoded by that inventory. Borrower inference receives the
same inventory instead of recursively rescanning the registry for each worker.
No yield or guard release was introduced. Expired candidates still acquire their
operation lease and re-read the registry after that await before deciding to
delete; those correctness checks are intentionally retained. Existing retention
tests cover borrower creation, sequence changes and competing operation leases.

## Validation

- `npm run typecheck` and `npx knip`: passed.
- Thirteen focused room-mcp files: 78 passed, 3 scale cases skipped.
- Relay `private-state.test.ts`: 6 passed, 8 platform-specific cases skipped.
- No existing test expectation was weakened or removed. Added count regressions
  fail on the original implementation; added guard tests cover sync/async
  exclusion, nested dead-holder recovery, unreadable guards, callback failures,
  syncing before publication and failed-write cleanup.
- Existing `TEST_SCALE=1` preview responsiveness cases passed: maximum excess
  timer delay 5.9 ms at 5,000 files and 12.7 ms at 50,000 files (200 ms limit).
- A first combined preview with `fixes`, `legacy016` and `viewer` passed six
  focused files / 29 tests. A peer's broader preview caught a lost worker-ID
  diagnostic for quarantined records: reservation validation must fall back to
  the direct read when the inventory has no successfully decoded record. That
  fallback is retained; healthy records still read once. Existing corruption
  expectations remain unchanged. Final combined evidence is recorded below.

The seven-file combined run (including the full worker-registry corruption tests
and detached collection tests) passed all 59 tests at `fixes` revision 15,
`legacy016` revision 13 and `viewer` revision 9. Snapshot input hash:
`deea8e32e5aece411ceb2d46a855cb89196efc161165868ba67740ceb0ca2d71`.
Peers continued editing during that run, so this is evidence for those recorded
inputs; a short current preview is also required before finishing. Under that
combined load, publication timer delay was 19.6 ms and guarded mail took 51.6 ms;
the remaining synchronous registry guard can still dominate mail on a busy disk.

Windows ACL and sharing-error behavior were not exercised on this Mac. Full CI,
ordinary and scale passes and the bundle rebuild remain the integrating lead's
checks under the batch brief.

## Review follow-up

The cross-process exclusion test's child observed `fs.linkSync`, but preview
publication now calls `fs.promises.link`. Its hook now awaits that async call and
records the same `EEXIST` contention. All assertions remain unchanged: a contender
must try the guard, cannot publish while the holder runs, and must publish its
failure afterwards, superseding the older result.

The reviewer also reproduced an inherited failure in the original synchronous
guard: an I/O error after the exclusive link succeeds rejects acquisition before
`withGuard` can enter its release `finally`, stranding a live guard. Both paths now
use one `createGuardSafely` boundary around initial and retry publication. On
failure it calls the appropriate existing synchronous/asynchronous nonce-aware
release, then rejects. Ordinary durability and stale-holder recovery are retained.
Four new deterministic cases failed before this fix (sync/async crossed with
directory-sync/temp-cleanup EIO); two more cases verify a different nonce survives
failure cleanup. A persistent filesystem error that also prevents rollback can
still block cleanup; no unsafe unconditional unlink was added.

Native follow-up validation: from `packages/room-mcp`,
`npx vitest run test/preview-*.test.ts test/leases.test.ts --maxWorkers=1`
ran all 29 matching preview files and the full lease file. Result: 210 passed,
9 skipped; 29 files passed, 1 skipped, 250.9 s. This includes the repaired
cross-process contention test and all six new fault/nonce cases. `npm run
typecheck` and `npx knip` also passed. Combined and independent-review follow-up
results are reported in `room_done`.
