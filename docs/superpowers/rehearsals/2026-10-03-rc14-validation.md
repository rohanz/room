# rc14 large-checkout fixes — validation, 2026-10-03

Rohan chose to fix N1–N5 from the [live rehearsal](2026-10-03-0171-live.md)
before cutover. This candidate builds on `v0.17.0-rc13`; production is unchanged.
The real-auth migration dry run and its private-machine cleanup are recorded in
[the rc13 migration report](2026-10-03-rc13-migration.md).

## Changes and evidence

| Finding | Change | Evidence |
| --- | --- | --- |
| N1/N4: macOS watch close/reopen stalls during host rebind and replica replacement | Transfer the checkout watch, suspend old callbacks, attach fresh callbacks, reconcile the gap. Keep new documents, leases and policy. | Real Chokidar test starts two successive daemons with one native watcher; the first daemon's stop performs zero native closes, final stop closes once. Gap edits, changed gitignore and newly eligible build-directory files are observed with periodic reconciliation disabled. |
| N2: repeated import normalization dominates graph publication | Index provider module paths and compile import facts when a file changes. | Synthetic 400-file graph, eight repeated definitions/references and eight imports per file: rc13 13,551 ms, candidate 16 ms for building facts and resolving all dependencies. Outputs and provider removal match. A separate 1,444-case import/path comparison matches rc13. |
| N3: completion during rejoin can lose the worker report | Bound and cancel reconnect waits, including host rebind and auto-join; save the worker summary locally if reconnect times out. | Tests cover successful reconnect, failed replacement with no current session, cancellation during pending auto-join, timeout, and terminal refusal. Offline completion preserves claims and sends no room post. The response explicitly says the lead has not yet been notified. |
| N5: unchanged base files are reparsed after rejoin | Transfer completed base symbol facts only; validate checkout, base, current changed/excluded paths and sharing policy again. | Same-base replacement performs no base file reads in the regression fixture. Different-base, changed peer content and changed publication policy are tested. |

The watch handoff is single-use, rejects another path alias or a replaced checkout
root, and expires after three minutes if abandoned. Replacement cleanup disposes
unused watches. Base facts carry no document replica, participant lease, private
overlay text or reusable authorization.

## Review

Two read-only Astra review rounds. Round one found two must-fix gaps: completion
waits before the deadline, and newly eligible build-directory watches. Both have
regressions. Round two returned **zero must-fix findings**.

## Release checks

All checks passed on the final source:

- `npm run typecheck`
- `npm run knip`
- `npm run build:plugin`, including the full web build and committed assets
- `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`, outside the sandbox:
  **320 files, 3,453 tests passed**, 381.17 seconds
- `git diff --check`; both frozen hook manifests unchanged

The review ran with a read-only sandbox, and reviews and suites ran in the
foreground with timeouts. Final process inspection found no leftover processes
from these review or test batches.

## Limits

These results establish targeted work reduction and correctness, not the full
large-Rust-repository live timings. The multi-worker host-rebind and compacting
restart rehearsal still needs to be repeated against rc14. A worker report saved
offline is durable local recovery state; it is not an acknowledgment from the
lead or the server. Real-login staging rehearsal and production cutover remain
separate steps; production cutover still needs Rohan's explicit approval.
