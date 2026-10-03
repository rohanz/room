# Fresh snapshot migration rehearsal, 2026-10-03

The private rehearsal used a fresh production snapshot in a separate 512 MB machine
and volume inside the production Fly app. The machine had no public services and
was accessed through a localhost proxy. It ran the fix-0.17.1 image (f7787045;
code identical to 07b1cb6c), with production authentication and Rohan's GitHub
device login. Production itself remained on 0.16.40 and was not migrated.

## Candidate validation

The merge passed typecheck, knip, the web build, and the full plugin build; rebuilt
assets matched the committed assets. The final full suite ran outside the sandbox:
318 files, 3,435 tests passed in 371 seconds.

Two test-only reliability corrections were needed. The relocated parser packaging
smoke passed alone but its child failed under full-suite load with a 10-second
limit; its all-15-grammar child now has 30 seconds inside a 45-second test. The
watchdog test now sends non-terminating SIGCONT on its child timeout, avoiding the
race where SIGTERM could kill a starting shell before it installed its trap. Both
focused suites and the final full suite passed. Runtime code is unchanged by these
test corrections.

## Results

All eight repositories joined with a 0.17 client using empty local repositories,
their matching GitHub origins and intent-only sharing. Every registry entry ended
with `mode=repo`, `step=written`, and zero skipped source documents. Every joined
document reported schema 2. Health passed after the last migration.

| Repository | Join seconds | Scopes | Claims | Pending mail | Unresolved | Archived sources | Skipped records |
|---|---:|---:|---:|---:|---:|---:|---:|
| room-playground | 5.62 | 0 | 0 | 0 | 0 | 1 | 0 |
| room | 5.74 | 0 | 0 | 0 | 0 | 1 | 0 |
| room-playground-2 | 5.56 | 0 | 0 | 7 | 0 | 1 | 65 |
| werkzeug-rehearsal | 6.51 | 0 | 0 | 4 | 6 | 8 | 116 |
| click-rehearsal | 5.63 | 0 | 0 | 0 | 0 | 2 | 17 |
| httpx-rehearsal | 5.63 | 0 | 0 | 0 | 0 | 4 | 53 |
| flask-rehearsal | 5.69 | 0 | 0 | 0 | 2 | 3 | 74 |
| codex-rehearsal | 5.68 | 6 | 0 | 0 | 0 | 1 | 14 |

Skipped-record counts are the migration's reported totals, not evidence of missing
pending mail: the migration also counts records intentionally excluded by its
retention rules. This rehearsal did not inspect message bodies or independently
count every pre-migration record. The final totals were 11 pending messages, six
scopes, zero claims and eight unresolved entries. Archive exports were not rerun.

## Inventory and limits

The live admin inventory endpoint was used before and after; the offline inventory
script requires a stopped database and was not run against the live server.
Stored document count rose from 40 to 48: eight new canonical documents, 20 old
literal branch documents, 12 never-served encoded keys and eight unregistered keys.
The registry retained 21 legacy source names, including an empty source without a
stored document. No SST table exceeded the inventory's 32 MiB table threshold.

The current inventory deliberately reports conservative table-based bounds, not
exact per-document decoded sizes. Every document was flagged `over` by that bound;
`updates=0` means uncounted. Canonical keys overlapped approximately 2.05–2.50 MiB
of compressed SST data each, which cannot be attributed solely to those documents.
Do not compare these numbers directly with the exact update sizes from the rc3
rehearsal. The old enterprise key overlapped about 32.68 MiB of compressed SST data;
it remained quarantined and the Room repository migrated successfully. No RSS peak
was sampled, so this run establishes successful completion at 512 MB, not a measured
memory margin or restart/soak guarantee.

## Cleanup

The temporary session was logged out, its isolated local credential file removed,
and the proxy stopped. Fly confirmed destruction of the private machine and its
snapshot-copy volume. No production deploy or plugin reinstall was performed.
