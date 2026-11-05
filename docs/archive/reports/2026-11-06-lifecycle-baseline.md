# Lifecycle file-store baseline, 2026-11-06

Command: `node --import tsx scripts/measure-lifecycle.mts` (defaults: 50 and 500 workers, five samples each).
Source commit: `37e510ad3f13083c85e63967a6d71220c7e49c5a`; the measurement harness was uncommitted and no lifecycle production source was changed. These measurements precede the slice 1 async facade refactor. Raw per-sample counts, times and environment are in [the JSONL evidence](2026-11-06-lifecycle-baseline.jsonl).

Hardware: Apple M2 Max, arm64, 12 logical CPUs, 34,359,738,368 bytes physical RAM. OS: Darwin 25.5.0; Node v22.14.0 at `/usr/local/bin/node`. Fixtures lived in the system temporary directory; `statfs` reported filesystem type 26 and 4,096-byte blocks. This was a shared development machine, without CPU or disk isolation.

Every sample manufactures a fresh private Git directory containing N prepared worker records and N matching tag reservations, one fresh run per worker, and completed migration metadata. No worker host runs. Liveness is injected as alive; migration and watching are disabled. Each sample starts a fresh Node process; OS page caches and tsx transform caches are not evicted. Fixture manufacture is outside the measured interval.

| Workers | Phase | p50 ms | p95 ms | JS fs calls per sample |
| ---: | --- | ---: | ---: | ---: |
| 50 | Startup | 166.627 | 212.095 | 583 |
| 50 | Registry status | 8.441 | 9.111 | 302 |
| 50 | Spawn admission | 91.427 | 113.376 | 590 |
| 500 | Startup | 255.403 | 338.834 | 5,533 |
| 500 | Registry status | 84.891 | 92.459 | 3,002 |
| 500 | Spawn admission | 160.204 | 223.623 | 3,290 |

Startup measures module import plus registry open/reconcile, excluding Node/tsx process bootstrap. Status lists the registry and queries every worker's status. Spawn admission calls `writeIntent` with capacity N+1, admitting the last available slot; it excludes Git checkout preparation, host startup and model/API latency.

Instrumentation counts JavaScript `fs` and `fs/promises` API invocations, including failed calls. It does not count kernel syscalls or Git subprocess filesystem activity. Counts were identical across all five samples at each size. Five samples give coarse percentiles: p95 and p99 both select the maximum. All ten measured samples succeeded. An earlier `npx tsx` launcher attempt failed because its IPC listener was forbidden by the sandbox; the recorded command avoids that listener.

Hooks, real-host launch, event-loop/queue delay, SQLite contention and WAL behavior are unmeasured. These are synthetic file-store baseline observations, not production or cross-platform qualification. Acceptance tolerances must be agreed from baseline evidence before accepting candidate measurements; this report establishes no tolerance or performance improvement claim.

## After slice 1 (async facade), same harness and machine

`node --import tsx scripts/measure-lifecycle.mts`, five samples, sqlite-slice1 after the status fix:

| Workers | Phase | p50 ms | JS fs calls |
|---|---|---|---|
| 50 | startup | 92.2 | 583 |
| 50 | status | 5.6 | 303 |
| 50 | admission | 78.1 | 590 |
| 500 | startup | 138.9 | 5533 |
| 500 | status | 49.0 | 3003 |
| 500 | admission | 115.3 | 3290 |

A first slice-1 build regressed status to 3,116 / 31,016 calls by building full facts per worker; status now reads record-only snapshots with precomputed liveness, and a regression test bounds its call count.
