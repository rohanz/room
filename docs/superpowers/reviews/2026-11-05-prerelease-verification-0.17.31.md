# Room 0.17.31 pre-release verification

Verified the uncommitted tree against HEAD, including untracked implementation and test files, after reading `2026-11-05-prerelease-review-0.17.31.md`. References below are to this working tree. This is a focused verification, not release certification. Only this report was written; no commit or bundle rebuild was performed.

## Must-fix 1 — Non-leads starting the relay: closed

`packages/relay/src/index.ts:633` derives the effective role from both `joinOnly` and `lead`; line 687 rejects a non-lead before taking authority or starting a listener. The takeover path also refuses non-leads at line 746. `packages/room-mcp/src/session.ts:935` detects Room worker worktrees independently of worker environment variables; lines 957–959 pass that role and translate `NoLocalRelay` into the waiting-for-lead error.

The discovery reader retains `lead` (`packages/relay/src/index.ts:364`), the writer publishes it (line 646), and the older-Room warning still reads it (lines 680–682). Coverage includes non-lead creation/takeover and older-owner compatibility in `packages/relay/test/relay-owner.test.ts:47` and `:61`, and a worker worktree without worker variables in `packages/room-mcp/test/local.test.ts:161`.

No new regression identified in these paths. Initial absence returns an error requiring a later join attempt; it does not secretly create a relay.

## Must-fix 2 — Losing the only replica after failed save: partly closed

The handover endpoint, `yieldToLead`, reclaim machinery and `HANDOVER_*` timers are absent from current TypeScript implementation and callers. A new lead no longer causes that handover. Remaining unrelated uses of “handover” in shared/hub tests are not endpoint references.

**Remaining must-fix:** ordinary graceful shutdown still releases authority without successful persistence or transfer. `packages/relay/src/memory.ts:143` ignores the result of `saveMemory`; `close()` at line 162 calls that void flush and detaches. `packages/relay/src/index.ts:586` calls memory close, terminates clients at line 587, destroys documents at line 589, and releases the authority lock at line 591 regardless of save failure. This is reachable through local `stop()` at line 795 and `leaveSession()` in `packages/room-mcp/src/session.ts:1196` (including stopping the local daemon before the relay).

Consequently, after the last writer disconnects, a graceful stop during ENOSPC can still destroy the relay's only current replica and allow the next lead to load the older snapshot. Removing handover closes the original trigger but not the requested ownership-release invariant. This is a remaining failure mode, not a newly introduced shutdown regression. Propagate save failure and retain a recoverable replica/authority, or confirm state transfer before completing a voluntary close. Abrupt process death is a separate limitation.

## Must-fix 3 — Pending collection ignores keep: closed

`packages/room-mcp/src/tools/collect.ts:800` excludes `keep=true` from the pending-cleanup shortcut. The keep path reserves the operation at lines 531–535, inspects the checkout again under that lease (line 540), and holds it through baseline/record update at line 854; the outer finally releases it at line 949. `packages/room-mcp/src/retire.ts:94` uses the same operation lease and rechecks `collectPending` and phase after acquisition at line 98. A sweep that acquires the lease first may finish cleanup first; an already-held keep lease cannot be overtaken by the sweep.

Pending cleanup is cleared only after successful application, in the kept-baseline update at line 854. A refused plan returns earlier at line 828. `packages/room-mcp/test/collect.test.ts:1106` covers pending-to-keep, preservation and later ordinary cleanup; line 1142 covers a conflicting keep leaving the record pending. No new regression identified by this control-flow review.

## Must-fix 4 — Audit rotation reports missing history as complete: closed

`packages/server/src/store.ts:294` now opens a generation through a common helper. It captures marker/current inode before opening, opens current and listed segments, then reads the marker and current inode again at line 315. A change retries, up to three attempts (lines 282, 318); descriptors are closed on each attempt at line 323. Missing listed segments are recorded at line 302.

There is an asynchronous window between the final open/stat and marker read, but it no longer silently loses history: rotation in that window changes the checked generation, and already-open descriptors retain deleted segment data. The final marker and inode checks are synchronous, with no event-loop yield between them. Retention writes the marker before deleting segments (lines 409–410). This establishes the intended protection against this server's rotation, not a transactional snapshot against arbitrary external file replacement.

Exhausted retries return no entries, `complete: false`, and `rotated` (`store.ts:420`). `readAllAudit` shares the helper and refuses rotated/pruned/vanished sets at line 434. The HTTP endpoint is actually in `packages/server/src/index.ts:605`, not `http.ts`; lines 606–608 expose completeness and gaps in headers while retaining the array body. `packages/server/src/migrate.ts:91` refuses incomplete evidence. Rotation tests at `packages/server/test/audit-tail.test.ts:135`, `:146`, `:154`, and `:166` passed. No remaining silent-completeness regression identified.

## Must-fix 5 — Rewritten logs retain stale facts: closed, with documented sampling limit

Both async and sync paths call `current()` (`packages/room-mcp/src/run-log-facts.ts:150` and `:171`). For a grown same-inode file it validates the consumed head/tail via `prefixIntact` (lines 113–124); a mismatch builds fresh facts. `step()` maintains those byte samples at lines 134–135. The longer in-place rewrite test at `packages/room-mcp/test/run-log-facts.test.ts:72` passed along with the other log tests.

The module comment at `packages/room-mcp/src/run-log-facts.ts:5` explicitly documents the limit: a rewrite preserving both sampled windows is undetectable. This is a bounded guard for append-only host logs, not whole-prefix identity verification. Unchanged size/mtime also remains a cache hit. No additional regression identified; closure here means the reported truncate-and-regrow case and the stated bounded validation, not a guarantee against all possible rewrites.

## Must-fix 6 — Escaped child can leave a reusable cache: partly closed

`packages/room-mcp/src/tools/files.ts:1360` writes quarantine before release. A failed marker write leaves `quarantined` false, so line 1406 retains the lock while this process lives. Acquisition at line 1287 falls back to a temporary tree if quarantine cannot clear. Shared-entry orphan/worker removal checks quarantine at line 1092, and eviction does so at line 1425. Setup/reset removal paths run on an entry already admitted under its lock; legacy-slot migration targets the older process-named layout. No separate shared-entry deletion bypass was identified.

**Remaining must-fix:** the real process probes do not fail closed on incomplete visibility. On Linux, `packages/room-mcp/src/preview-cache.ts:131` suppresses every `/proc/<pid>/cwd` read error without distinguishing an exited/other-user process from an unreadable live process of this user. On macOS, line 142 accepts any nonempty cwd output even when `lsof` failed, timed out or exceeded its buffer. `clearPreviewQuarantine` then removes the marker at line 158 if the partial list happens not to contain the tree.

A focused macOS probe replaced `execFile` with a callback returning `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` plus one unrelated cwd. After marking a temporary tree, `clearPreviewQuarantine` returned **true** and the marker was absent. Thus a failed partial scan can permit resetting or deleting a still-used tree. The test seam's `undefined` case (`packages/room-mcp/test/preview-cleanup-deadline.test.ts:140`) does not exercise these production error classifications. Reject partial/error lsof results, and distinguish safe Linux disappearance/foreign ownership from unknown same-user visibility before clearing quarantine. Count this under the original cache-safety finding, not as an extra independent item.

## Should-fix 1 — Bounded hook input silently loses coordination: closed

`plugins/room/hooks/common.mjs:66` returns prefix fields with a non-JSON symbol marker on cap/deadline failure. The parser tracks object/array frames (`:107`), consumes quoted strings as whole tokens, and captures only top-level and direct child-object values (`:135`); ordinary nested fields, arrays, or path-like text inside content do not become `tool_input.file_path`. The cut-at-every-position parser test at `packages/room-mcp/test/hook-port.test.ts:330` passed.

`plugins/room/hooks/before-edit.mjs:69` treats incomplete input as a subagent for inbox/receipt purposes; lines 109–113 either check recovered paths with an explicit partial-input notice or emit the coordination-unavailable notice. Missing session metadata has a separate visible fallback at line 18 when the repository has Room state. `plugins/room/hooks/session-start.mjs:11` still receives ordinary prefix properties; lines 29–36 record available identity/model/effort fields, and lines 16–18 safely exit when identity is unavailable. No host behavior changes were assumed here.

Large Write, oversized shell, slow-input and no-input tests passed in the hook run. Two unrelated socket-backed hook tests could not run successfully because listening on loopback was denied (see validation below). `git diff HEAD -- plugins/room/hooks.json` is empty: the frozen hook manifest is untouched. No new regression identified in the bounded-input fix.

## Should-fix 2 — Unbounded pending acknowledgement arrays: closed

`packages/server/src/store.ts:149` defines one promise per generation. Snapshot coalescing returns the existing pending generation's promise (`:168–172`); session coalescing returns the shared batch promise (`:203–209`). `Generation.run()` rejects that same promise on failure (`:155`), so every sharer observes rejection. It catches the write failure internally, allowing each drain loop to process the next pending generation (`:179`, `:216`). Thus a revocation queued behind a failed generation still runs; failure does not discard the later batch.

If the revocation's own batch fails, the queue rejects rather than claiming durability. `packages/server/src/auth.ts:382` retains the owed deletion, and lines 390–405 remove owed records only after successful persistence; reconciliation also retries them. Tests in `packages/server/test/persistence-queue.test.ts:27`, `:37`, `:77`, and `:84` passed. No new regression identified. Shared promises bound queue-owned acknowledgements; callers can still allocate their own promise reactions.

## Validation and remaining blockers

- Server focused run: `vitest run test/audit-tail.test.ts test/persistence-queue.test.ts` from `packages/server`: **22 passed**.
- Room MCP focused run: `vitest run test/run-log-facts.test.ts test/hook-port.test.ts` from `packages/room-mcp`: **135 passed, 2 failed**, with two `listen EPERM 127.0.0.1` errors and corresponding 20-second timeouts in socket-backed hook tests (`hook-port.test.ts:383`, `:411`). This is not a passing integration run.
- Narrowed non-socket log/prefix/stdin rerun: **8 passed, 129 skipped**. Initial root-directory invocations found no tests; corrected runs used package working directories.
- Standalone partial-lsof error probe reproduced premature quarantine clearing; temporary fixtures were removed. Relay shutdown and collection lease conclusions are static control-flow findings; no full suite, socket relay run or release checks were attempted.

Six findings are closed; two must-fix findings are partly closed. Remaining blockers are failed-save voluntary relay shutdown (must-fix 2) and quarantine clearing on incomplete process scans (must-fix 6). No additional independent must-fix is counted.

**Open or new must-fix count: 2.**
