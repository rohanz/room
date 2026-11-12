# Local daemon discovery hand-over

2026-11-13. Builds on the carried cutover retirement without restoring its gate.

Before: read predecessor discovery → authenticate successor → compare PID before readiness → reject.
After: authenticate → require ready and not draining → re-read discovery → require the probed endpoint and authenticated PID to agree.
Unchanged daemon order: acquire authority → listen fenced/not-ready → recover leases → publish discovery → become ready and admit clients.

The successor already delays readiness until after publication; changing its listen/publication order is unnecessary. Binding first records the actual fallback port, and lease recovery finishes before readiness or client admission. The launcher was ignoring that existing fence. A publication which changes port/key invalidates the probe; a newer PID publication which supersedes the response also needs a fresh probe. An unchanged publication with an authenticated PID mismatch still fails explicitly.

Publication can finish while a not-ready response is in flight, before the launcher's owner-liveness check. The existing startup wait now also serves a published live/unknown-liveness owner without spawning a child. This replaces the immediate live/unknown-owner error with a bounded wait, never permission to replace it. Phase-progress and hard startup caps remain unchanged. There is no new polling loop, delay, join retry, ownership record, or lock mechanism. Authentication, clone/runtime/contract checks and the authority lock remain authoritative. No subsystem or file was removed; roughly 15 launcher lines were replaced/rearranged.

## Regression expectations

- The reviewer's two socket-free tests fail with the original PID-mismatch error before the change and pass after it. Their assertions are unchanged.
- Added cases reject obsolete ready replies after PID, port or key publication changes; wait without replacement after an in-flight not-ready reply for alive/unknown owners; retain stable PID-mismatch refusal; and bound unauthenticated alive/unknown-owner waits without replacement.
- The carried restart-worker test retains every existing assertion. Its two record cases now each run with a free predecessor port and an occupied port. New assertions require exact port reuse in the former and fallback in the latter. The old comment deliberately isolating the startup race is replaced with the two-path intent. Worker capacity, ambiguous-launch, drain-file and join/spawn expectations are unchanged.

## Sandbox validation

macOS arm64, Node v22.23.4, one Vitest worker per run; no dependency changes.

- `npm run typecheck`: passed.
- `npx knip`: passed.
- `cd packages/relay && npx vitest run test/daemon-handover.test.ts test/daemon-launch.test.ts`: 23 passed.
- All eight `packages/relay/test/daemon-*.test.ts` files, `--maxWorkers=1`: 41 passed, 31 failed, 2 skipped (142.92 s). Four files passed, three failed, capacity file skipped by the scale-test configuration.
- `cd packages/room-mcp && npx vitest run test/daemon-restart-workers.test.ts --maxWorkers=1`: all four variants failed before daemon startup/readiness (47.23 s).

The failing authority/compaction/ordinary lifetime and all four MCP cases report `cannot establish daemon process birth identity` at unchanged `startLocalDaemon` line 96, before listening. The detached-launcher case includes the same error in its startup report and log. Direct diagnostics confirm `sysctl -n kern.boottime` returns `Operation not permitted`, and `ps` is also refused. The simultaneous-start lifetime case reports only one loser rather than a loser plus a ready winner; its winner must pass the same denied birth-identity probe. This last attribution is an inference from the fixture/control flow, not captured child stderr. Native validation remains necessary for these failures. No observed failure reached socket binding; socket-listen denial is not claimed as the cause of this run.

Exact failed relay expectations:

- `daemon-authority.test.ts` (6):
  - refuses daemon readiness on truncated lease evidence and leaves it unchanged
  - refuses daemon readiness on invalid-row lease evidence and leaves it unchanged
  - refuses daemon readiness on unreadable lease evidence and leaves it unchanged
  - publication failure after bind removes the unpublished listener, preserves discovery and releases authority
  - lease-flush failure refuses stop, retains authority and admission, then saves without a new update
  - maintenance refuses wrong instance identity and a concurrent drain without joining its success
- `daemon-compaction.test.ts` (13):
  - snapshot generation gate: fresh
  - snapshot generation gate: current
  - snapshot generation gate: stale
  - snapshot generation gate: absent
  - saves and stops over threshold, refuses the old replica, and serves a small fresh copy without looping
  - disables restart for the process if a loaded room is already over threshold
  - does not scan history with threshold off
  - does not scan history with threshold 0
  - skips compaction once per process if a snapshot would shed broadcasts
  - exits after planned save failure: second room rename
  - exits after planned save failure: directory fsync
  - exits after graceful save failure: second room rename
  - exits after graceful save failure: directory fsync
- `daemon-lifetime.test.ts` (12):
  - a separate process stops at five minutes of fake writer-idle time (short real timer seam)
  - the last writer leaves while a read-only viewer remains; viewers never reset the countdown
  - SIGTERM final save ends the generation, refuses a survivor, and syncs saved receipts to a fresh replica
  - crash with one surviving client replica resyncs an unsnapshotted fact after restart
  - a taken recorded port uses a fallback, preserves the key and the surviving replica
  - full-disk idle stop keeps serving and holding authority, then retries without another edit
  - the detached daemon outlives its launcher process and owns discovery and authority itself
  - the separate process also exits through a short real idle timeout
  - refuses discovery whose pid disagrees with authenticated listener metadata
  - simultaneous independent first starts publish exactly one key under one daemon authority
  - maintenance stop authenticates PID plus nonce and verifies save and actual child exit
  - maintenance shedding-snapshot save failure reports the cause, retains the live daemon, and permits an explicit retry

The four failed MCP cases are the product of `failed-preparation`/`unconfirmed-launch` and `occupiedPort=false`/`true`. The two free-port variants are the new native integration coverage; none of the four reached its join/spawn assertions in the sandbox.

## Native source-preview validation

Room ran these commands on macOS arm64 / Node v22.23.4, outside the worker's process-inspection sandbox, against the lead's rev 314 plus this source delta. All merged without conflicts. The excluded generated bundle and missing acknowledged post-baseline scan keep every preview PARTIAL; these are actual targeted test passes, not complete combined-tree/release verification.

- Launcher + hand-over: 23 passed (2.684 s check).
- Restart workers: all four variants passed (91.007 s check), including both same-port cases. Thus no newly added test remains unrun natively on macOS.
- Lifetime: 14 passed, 1 Windows-only test skipped (15.984 s check). This includes mismatched discovery PID refusal, simultaneous independent first starts, crash recovery, occupied-port fallback and authenticated maintenance stop.
- Authority + compaction: all 19 passed (48.176 s check). This covers lease recovery refusal, failed publication teardown, save failures and admission/authority retention. All 31 sandbox-failing relay cases therefore passed natively. The simultaneous-start attribution above is supported by its native pass with the same source.

## Coordination

The lead's rev 314 overlay merged cleanly and passed the 23 launcher tests. Room marked that preview PARTIAL because the generated bundle was excluded and its post-baseline scan was not acknowledged; this is targeted source evidence, not a verified complete combined release tree. Adding reviewer rev 3 produced conflicts in `docs/upgrading.md`, `daemon.ts` and the newly created restart-worker test: that older overlay duplicates the carried retirement and has only the supplied startup test as a fresh delta. Its edits were read and not copied over the fix. The lead was asked to refresh publication without rebasing. Addressed delivery was refused by the full message store (1600 KiB owed); broadcast notes succeeded. Broadcast questions are unsupported (`question requires to`).

The final preview named `rohanz`, `rohanz+mail2` and `rohanz+refs2` and ran the launcher, hand-over and restart-worker files together: 27 passed, no merge conflicts. The first run was a snapshot because mail2's publication authority/base changed during it; the refreshed run also passed all 27 and returned a current result. The same excluded-bundle/post-baseline-scan limitations still make the combined tree PARTIAL. The lead owns generated assets and final ordinary/scale release checks. No unresolved target-code failure remains; Windows execution was not available.
