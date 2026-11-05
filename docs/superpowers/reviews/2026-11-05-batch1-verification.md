# Batch 1 fix verification — 2026-11-05

Reviewed the original batch-1 review first, then the working tree against HEAD, including the relevant untracked implementation, tests and compatibility scripts. This verifies the requested fixes, not release acceptance. No implementation files were changed and no commits were made.

## M1 — Closed

**Evidence:** `packages/roomd/src/ws-auth.ts:39` handles every rejected upgrade. Non-426 responses destroy the request with the status-bearing error (`:43`); both paths explicitly destroy the underlying socket (`:46`) and response (`:48`). The installed `node_modules/ws/lib/websocket.js:896` converts the request error into WebSocket error/close events. That restores the provider's unsuccessful-connection/backoff path rather than leaving CONNECTING indefinitely. HTTP 426 still calls `refuse` (`ws-auth.ts:42`, `:57`), and the session's refusal callback disables reconnect (`packages/room-mcp/src/session.ts:642`).

**Coverage and assertion review:** `packages/roomd/test/negotiation.test.ts:61` checks request destruction with the exact status error, independent socket destruction, response destruction, and absence of a compatibility refusal for 401/403/429/503. The 426 case at `:78` retains guidance and terminal-close assertions. The real 503 case at `:155` requires successful document sync, exactly two attempts, one status error, one abnormal close and reset reconnect count. The permanent 401 case at `:175` requires three errors/closes, increasing backoff, no sync, no terminal compatibility callback, and zero remaining server sockets before fixture cleanup (`:188`).

The fixture still sends an unfinished chunked body. Its `end` handler (`:124`) closes the server half only after the client ends its connection; it does not proactively rescue a connecting client. Together with the explicit client socket-destroy assertion, this is a sound fixture correction, not a weakened teardown assertion. This test file is untracked, so HEAD does not provide a prior revision of these new assertions for historical comparison.

**New issue:** None found. The eight socket-free tests passed. Both real-socket cases were blocked at `listen` by sandbox `EPERM`; their recovery and teardown behavior was inspected but not demonstrated by this run.

## M2 — Closed

**Evidence:** `packages/room-mcp/src/worker-registry.ts:65` defines the two-second window. Cache entries retain whether their read was racy (`:67`), and a matching stat is a hit only for a non-racy entry (`:79`). The calculation uses the newer of mtime/ctime, regardless of fractional precision, and treats future timestamps as racy (`:71`, `:82`). Merely waiting does not promote previously cached bytes: another load must occur before storing a non-racy entry (`:83`). Directory listings use the same cache policy (`:95`).

**Coverage:** `packages/room-mcp/test/registry-read-cache.test.ts:161` injects identical device/inode/size/timestamps while content changes. Cases at `:175`, `:212` and `:231` cover fractional and whole-second timestamps, future timestamps, directory additions/removals, and the final reread followed by a stable cache hit. These passed.

The existing conflict test's read-count adjustment (`packages/room-mcp/test/conflict-set.test.ts:1111`, `:1127`) explicitly moves Date beyond the racy window and checks the intended stable-cache behavior; its claim-release assertion remains. It does not replace the collision regressions.

**New issue:** None found. Recent records deliberately incur rereads; performance evidence for settled records should not be presented as the cost of freshly rewritten records. The policy assumes timestamp ticks no coarser than its two-second window and is not a general guarantee against arbitrary filesystem clock manipulation.

## M3 — Closed

**Evidence:** `packages/room-mcp/src/worker-registry.ts:1025` treats the initial scan as candidate selection only. Prune acquires the record's operation lease (`:1031`), rereads the record and rechecks expiry, ended phase, borrowers and kept-worktree existence (`:1033`; predicate at `:1016`). Deletion holds the same op-file guard used by `update`, verifies the prune lease's operation/holder and unchanged seq/phase, then removes the record (`:1038`). Tag removal occurs afterward and only if the reservation still names that record (`:1049`). The lease is released in `finally` (`:1056`).

This aligns with cross-instance update exclusion (`:805`), explicit borrower intent's owner lease (`:766`), and resume's inferred-or-explicit owner lease (`:858`). A same-instance record update that advances the sequence during guard contention makes the final deletion check fail. An aborted prune no longer releases a surviving record's tag.

**Coverage:** `packages/room-mcp/test/registry-retention.test.ts:111` forces another instance to take the owner's resume lease after candidate selection; `:130` introduces a kept worktree; `:152` introduces an inferred borrower; `:170` checks exclusion of another instance's update/borrower spawn while pruning and verifies record/tag/lease cleanup. All six retention tests passed, including migration gating and ordinary expiry.

**New issue:** None found in the supported lifecycle paths. A crash after record removal can leave an orphan reservation, as the code documents, rather than an unreserved surviving record; this is a recovery consideration, not the original unsafe ordering.

## M4 — Closed

**Evidence:** `packages/room-mcp/src/conflict-set.ts:493` captures a source token before the first memoized lookup for each participant. `current()` independently rereads tokens (`:503`); it does not compare memoized baseline values with themselves. Tokens cover both tag reservation and selected record (`packages/room-mcp/src/worker-registry.ts:630`). Registry replacement uses a newly written temporary inode and rename (`packages/relay/src/leases.ts:104`), so supported record rewrites invalidate the token even within one timestamp tick.

Pass and pair guards require current tokens (`conflict-set.ts:718`, `:730`, `:736`). Both publication and withdrawal check the guard and throw `StaleConflictInputs` (`:638`, `:643`); reconciliation retries/coalesces rather than accepting stale work (`:626`).

**Coverage:** `packages/room-mcp/test/conflict-set.test.ts:2101` schedules registry replacements during awaited comparison while leaving carried values and room metadata unchanged. It requires no conflict publication or notification during two stale passes, then requires successful publication when the same source stops changing. The test and the remainder of the focused conflict-set file passed.

**New issue:** None found. Freshness checks add stat work for the captured sources; the once-per-pass guarantee applies to carried-value materialization, not to all filesystem operations.

## S1 — Closed

**Evidence:** `scripts/compat-pins.mjs:24` allows a missing commit only for the manifest candidate whose tag does not yet exist. Existing tags, including the current manifest version, require a frozen commit; mismatches refuse. `scripts/compat-matrix.mts:107` validates local tags before listing/building, and `:130` validates fetched tag commits before pairs. `--only` cannot bypass pin validation. The CLI freeze operation refuses to overwrite an existing mismatched pin (`scripts/compat-pins.mjs:60`).

The release sequence explicitly requires `--pin-commit` and committing the frozen pin before publication (`AGENTS.md:130`; `scripts/bump-version.mjs:43`). Tests exercise the real bump/freeze commands, moved tags, the narrow pre-tag exception and an existing annotated candidate tag through the matrix CLI (`packages/room-mcp/test/compat-matrix.test.ts:38`, `:172`). They passed.

**New issue:** None found. Freezing is still an explicit release step, but omission now fails the matrix rather than silently accepting a movable release.

## S2 — Closed

**Evidence:** `scripts/compat-matrix.mts:35` reads the descriptor and compares its version, release, actual plugin bundle digest, complete advertisement and positive worker-record schema against the exercised implementation (`:49`). Descriptor absence is accepted only for the named pinned pre-descriptor releases with neither new exported contract (`:42`). Build invokes this validation before returning to pair execution (`:81`). `scripts/build-plugin.mjs:45` generates the descriptor from the contract/schema exports and the bundle digest.

Tests reject malformed JSON/structure and each mismatched field, and constrain the legacy exception (`packages/room-mcp/test/compat-matrix.test.ts:225`, `:238`, `:250`). Pair filtering is tested at `:92`. Relay trace validation requires every pre-success acquire reply to be `starting` with the advertised retry interval and bounds the count by the settle window (`scripts/compat-pair.mts:72`); tests establish five 1000-ms refusals and reject other reasons/intervals or a sixth refusal (`compat-matrix.test.ts:109`, `:131`). These focused tests passed.

**New issue:** None found. The matrix checks the freshly built descriptor: its build can overwrite a corrupt input descriptor. Detecting stale/corrupt committed generated assets additionally depends on the retained post-build working-tree check in `.github/workflows/ci.yml:161`. This distinction matters when interpreting a standalone matrix run. No actual process pairs were run in this verification.

## Discovery/legacy-path regression — Closed

**Evidence:** `packages/room-mcp/src/session.ts:587` has no TLS-only discovery gate. Unavailable health discovery falls back to absent health (`:607`), but the learned-floor check runs afterward (`:613`). An explicit `compat` field is parsed and rejected on malformed/no-overlap input before legacy fallback (`packages/room-mcp/src/client-compat.ts:11`); absent advertisement plus a learned floor refuses (`:23`). With neither advertisement nor floor, the fixed legacy profile is returned (`:24`), negotiation metadata is removed from HTTP admission (`session.ts:615`), and the probe/publisher receive no negotiation option (`:639`, `:737`). This preserves the legacy admission/socket branch; it does not imply the added health probe has zero latency.

Tests cover both ws/wss admission, missing/unavailable/malformed-JSON health responses, unchanged legacy admission refusal wording, learned-floor refusal and malformed explicit advertisements (`packages/room-mcp/test/client-compat.test.ts:14`, `:43`, `:47`, `:73`). They passed. `git diff HEAD -- packages/room-mcp/test/room-move.test.ts` is empty, and all 18 room-move tests passed with their existing expectations.

**New issue:** None found.

## Verification and remaining acceptance work

Ran only the seven focused files: roomd `negotiation.test.ts`; room-mcp `registry-read-cache.test.ts`, `registry-retention.test.ts`, `conflict-set.test.ts`, `client-compat.test.ts`, `room-move.test.ts`, and `compat-matrix.test.ts`, using `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run` with those paths.

Result: **204 passed, 2 failed; six files passed and one failed**, in 156.51 seconds. Both failures were `listen EPERM: operation not permitted 127.0.0.1` in M1's real-socket fixture before client behavior ran. They are unavailable execution evidence, not passing tests or reproduced implementation defects. No full suite, scale-mode run, build, process compatibility matrix or real-host acceptance was performed. Those release checks remain required; closure here does not replace them.

All six original findings and the requested discovery regression are closed on the evidence above. No new must-fix issue was identified.

Open or new must-fix count: **0**.
