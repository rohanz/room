# Slice 1 admission filesystem cost, 2026-11-06

Measured on the dirty `sqlite-slice1` worktree at HEAD `409cc07efa1a70cea954a8a5a83b5c85dd414d7f`, retaining the lead's inventory-boundary integration. No commit or plugin rebuild was made.

## Cause and change

`writeIntent` and `resume` both call the file adapter's occupancy check under the capacity guard. The integrated completeness boundary validates all record and tag evidence, including missing reserved records and quarantine evidence. Its per-worker status calls additionally reread each record and open the report and exit inventories, which each check quarantine. Prepared workers need none of those run facts to determine occupancy.

The occupancy check now builds a scoped inventory using the existing `recordStatus` rule and captured liveness. It reads full status only when a launched run needs reports/exits. Record, reservation, shared-owner and quarantine blockers remain authoritative; a record disappearing before full status is also a blocker. Both fresh spawn and resume use this path. The general inventory boundary is unchanged.

At N prepared workers the removed work is N record stats, N record reads and 4N directory reads. Admission changes from `12N + 293` to `6N + 293` JS fs calls. The original pre-facade baseline is `6N + 290`; the three additional calls are constant boundary overhead. The fs-budget regression test now checks admission at 50 and 500 workers with a bound of `6N + 300`, alongside the existing status bound of `6N + 10`.

## Five-sample measurement

Command: `node --import tsx scripts/measure-lifecycle.mts --samples=5`. [Raw samples and environment](2026-11-06-lifecycle-admission-cost.jsonl) include all ten successful samples; no sample failed. Counts were identical across the five samples at each size.

| Workers | Phase | p50 ms | p95 ms | JS fs calls per sample |
| ---: | --- | ---: | ---: | ---: |
| 50 | Startup | 104.243 | 175.096 | 1,388 |
| 50 | Registry status | 6.129 | 6.937 | 305 |
| 50 | Spawn admission | 176.937 | 222.555 | 593 |
| 500 | Startup | 257.258 | 269.402 | 13,538 |
| 500 | Registry status | 47.283 | 50.864 | 3,005 |
| 500 | Spawn admission | 220.270 | 297.961 | 3,293 |

An initial one-sample reproduction before this change returned admission counts of 893 and 6,293, status counts of 305 and 3,005, and startup counts of 1,388 and 13,538. Startup's increase from the historical baseline remains outside this admission fix.

This is the same synthetic fresh-process, fresh-file fixture described in the [baseline report](2026-11-06-lifecycle-baseline.md): prepared workers, matching tag reservations, synthetic alive liveness, no host launched, migration and watching disabled. It counts JavaScript fs API calls, including failed calls, rather than kernel syscalls or Git subprocess activity. Hardware is Apple M2 Max, arm64, 12 logical CPUs, 32 GiB physical RAM; Darwin 25.5.0 and Node v22.14.0. These samples overlapped the focused integration test run on the shared machine, so elapsed times are not an isolated latency comparison. Five samples give coarse percentiles; p95/p99 select the maximum. No SQLite, hook, live-host or cross-platform qualification is claimed.

## Validation and coordination

The characterization coverage includes spawn/resume refusal for undecodable, quarantined and missing reserved worker records, plus admission refusal for malformed report/exit evidence on launched workers. The fs-count regression checks the same fresh-process harness used above.

The final current-code run passed all **329 tests in seven files** (178.77 s): lifecycle characterization, worker registry, registry, registry read cache, workers, collect and the inventory-boundary guard.

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run \
  packages/room-mcp/test/{lifecycle-characterization,worker-registry,registry,registry-read-cache,workers,collect,worker-inventory-boundary}.test.ts \
  --maxWorkers=2
```

`npm run typecheck`, `npx knip` and `git diff --check` passed. This is focused validation, not a full release/plugin or live-host qualification run.

The first seven-file integration run had 325 passes and four failures in the newly added missing-payload cases. All four admissions correctly refused with `tags/worker.json: unavailable reserved record`; the new assertion incorrectly required the absent worker's ID in the error text. A focused reproduction confirmed that diagnostic mismatch. The assertion now checks structured blocked evidence and the appropriate reservation path. No production behavior was changed to satisfy it.

Room scope, claims, the addressed question to the lead and the final merge preview failed before joining: `local daemon cutover: drain required; 5 worktree(s); drain record not yet written`. No peer identity or overlap information was returned, and no combined peer result could be verified. No relay/drain state, other checkout, CHANGELOG or frozen hook manifest was changed.
