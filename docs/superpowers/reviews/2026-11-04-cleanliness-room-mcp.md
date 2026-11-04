# Room MCP cleanliness review — 2026-11-04

Scope: `packages/room-mcp/src`, especially tools, sessions, worker lifecycle, registry, binding, conflict checks, graph indexing and wake delivery. This is a source-reading review, not a reproduced-bug audit. Locations refer to this worktree's 0.17.29 sources. Findings below distinguish directly visible behavior from conditional failure paths; suggested fixes are deliberately local.

Read against `CLAUDE.md`/`AGENTS.md`, README, `docs/reference.md`, roadmap, relevant decisions and CHANGELOG 0.17.25–0.17.29. The priorities are preserving files and identity, reliable recovery, bounded work and useful diagnostics. No source changes, tests, benchmarks, host experiments or builds were performed. `npm run typecheck` passed (exit 0). The command was prefixed with `nice -n 10`; the sandbox refused that priority adjustment, but npm/TypeScript ran and passed. Only this report is intended for collection.

## Top ten, ordered by user and maintenance cost

### 1. Credential read errors become an empty database and can destroy other saved logins

**Locations:** `packages/room-mcp/src/credentials.ts:37`, `:41`, `:50`.

`loadCredentials` catches every filesystem/JSON error and returns `{}`. A corrupt or temporarily unreadable existing file therefore looks like a fresh install; the next `setCredential` or `setPending` writes a replacement containing only that entry. `save` also writes directly to the destination, so interruption can create exactly the corrupt-file case. This costs all other server credentials/pending logins and hides the original cause.

**Small fix:** return empty only for an absent file; report parse/read errors and preserve the existing bytes. Save through a private temporary file and atomic rename, using the repository's existing atomic-write machinery. This does not require changing the credential format.

### 2. The clean-exit/no-report path still publishes raw log tails

**Locations:** `packages/room-mcp/src/worker-registry.ts:183`, `:189`, `:589`, `:866`; `packages/room-mcp/src/worker-process.ts:153`.

`unreportedExit` puts `workerLogTail(...)` into `status.summary`. That reader accepts plain non-JSON stderr lines. `postObservedFailure` now safely constructs its *note* from structured evidence and a log path, but passes the existing summary through to `completionMessage`; when status is `done`, the shared helper emits that summary as a done message (`packages/shared/src/worker-messages.ts:16`). Consequently a fresh worker exiting successfully without `room_done` can still put arbitrary last-command output into room messages and worker views. This is the adjacent case left behind by 0.17.28's killed-worker fix, not a claim that its signal-handling fix is absent.

**Small fix:** make the no-report summary say that the run ended without a report and name the log path. Preserve structured background-task counts. Read raw logs only through an explicit inspection operation; do not use their tail as an implicit completion report.

### 3. A process-global credential path can change underneath an outstanding login

**Locations:** `packages/room-mcp/src/credentials.ts:10`, `:29`; `packages/room-mcp/src/tools/join.ts:104`; `packages/room-mcp/src/session.ts:398`, `:410`, `:780`.

`configureCredentials` changes module-global `configuredPath`. `pollLogin` awaits network requests and later calls `setCredential`, which reads whichever path is globally configured at that later moment. Another concurrent `room_login(credentials=...)` or join can change it while the first login is pending. Room serializes moves against worker operations, but this does not serialize logins. The result can be an approved identity saved into the wrong credential store. This is a conditional interleaving established from the call structure, not a run performed here.

**Small fix:** capture a credential-store object/path at login or join entry and pass it through polling/auth operations. At minimum, make reads and writes take an explicit captured path. Keep shared default-path resolution, not mutable selection, at module scope.

### 4. Failure to remember or forget a destination is concealed

**Locations:** `packages/room-mcp/src/tools/join.ts:253`, `:307`.

After a successful join, `writeChoice` errors are discarded with a comment suggesting the directory might not be a repository, although join has already established a usable repository. `room_leave(forget=true)` converts every `clearChoice` error into `false` and reports “nothing was remembered”. A permission/I/O failure can therefore leave a remembered team destination intact while the reply implies no saved choice remains. The next session can follow that team choice, contrary to the user's requested sharing boundary and the reference's forget contract.

**Small fix:** distinguish absent settings from failed persistence. Keep the successful join/leave, but explicitly say the choice could not be saved/cleared and identify the actionable error; never claim an unsuccessful forget was unnecessary.

### 5. Preview's process-group cleanup has no final deadline

**Locations:** `packages/room-mcp/src/tools/files.ts:657`, especially `:704`–`:712`.

After the child exits, `runTrackedProcess` loops until `previewGroupAlive` is false, repeatedly sending KILL after two seconds, and then awaits `closed`. There is no final bound or cancellation in this cleanup phase. A surviving/unreaped group member or inherited pipe can keep the preview and its cache lock outstanding even after the advertised check timeout. The normal timeout sets an error and signals the group; it does not terminate this wait.

**Small fix:** give termination/group-and-pipe cleanup an explicit bounded grace deadline. On uncertainty, return an incomplete result and retain process/lock ownership evidence so a later reclaimer cannot reuse a possibly active cache. Do not simply unlock a still-live tree. Thread tool cancellation into the same termination path.

### 6. Read-only tool metadata covers arbitrary command execution and file writes

**Locations:** `packages/room-mcp/src/tools/files.ts:36`, `:1251`; `packages/room-mcp/src/tools/join.ts:39`; `packages/room-mcp/src/prs.ts:116`; `packages/room-mcp/src/tools/context.ts:162`.

`room_preview_merge` uses the shared read-only annotation even when `run` executes a caller-supplied shell command with inherited credentials/environment and linked dependencies. `room_export` is also read-only although it creates directories and overwrites a selected output path. These are advisory hints, not enforcement, but this repository explicitly says hosts use them for approval decisions. The shared comment that tools “only touch the shared room doc, never the user's files” is false for these operations and for collection.

**Small fix:** give these tool definitions conservative per-tool metadata reflecting execution/file output, and correct the comment. If preserving read-only preview approvals matters, separate the command-running operation rather than describing both modes as read-only. No change to the merge engine is necessary.

### 7. Ordinary worker status queries can synchronously rescan an entire run log

**Locations:** `packages/room-mcp/src/worker-process.ts:49`, `:108`; `packages/room-mcp/src/worker-registry.ts:585`, `:597`; `packages/room-mcp/src/worker-projector.ts:44`, `:90`.

`hostEvents` reads from the run's starting offset through its full current size using synchronous reads and JSON parsing. Its pending-line cap bounds one buffer, not total bytes or time. `followUpAnswer`, `resumeAccepted` and `missingClaudeSession` each scan independently. Terminal resumed-worker status and repeated projections can therefore reread large tool-output logs long after the process exits, blocking the MCP event loop. The bounded incremental activity tracker already demonstrates the appropriate local pattern.

**Small fix:** cache derived terminal-run facts by worker/run plus log size/mtime, and compute acceptance/final-answer/missing-session facts in one incremental scan with bounded chunks and event-loop yields. Preserve full-run semantics; blindly tailing can lose acceptance evidence. Invalidate on append or replacement.

### 8. PR refreshes outlive their owner and are not single-flight

**Locations:** `packages/room-mcp/src/tools/prs.ts:49`, `:64`, `:67`, `:74`–`:83`.

The interval starts fire-and-forget refreshes, while `stopPrSync` only clears the interval. Each refresh may issue up to twenty parallel HTTP requests, and explicit tool calls can start another pass. An in-flight pass has no generation/owner check after `stopPrSync`, so it can still call `syncPrs` on the old session if its old awareness/branch checks remain true. Requests have individual timeouts, but cancellation and ownership of the aggregate task are missing.

**Small fix:** retain one in-flight refresh per session, with a dirty bit for a requested follow-up. Increment a generation on stop/replacement and verify session, generation and current fence before publishing; pass an abort signal to fetches so stop can end unnecessary work. Keep the two-minute schedule and existing election.

### 9. Registry/projector failures disappear at the lifecycle boundary

**Locations:** `packages/room-mcp/src/registry.ts:113`–`:120`; `packages/room-mcp/src/worker-projector.ts:104`, `:109`.

Failure to open the registry while tracking a session is swallowed, so no projector is installed and there is no scheduled retry of that setup. Auto-retirement failures are also silently discarded each minute. Per-worker completion projection catches errors by marking the worker undelivered without logging a reason, and cleanup acknowledgement failures are discarded. Retaining records is safe, but leads can see stale workers or repeated retention without enough evidence to distinguish a network retry from corrupt local state.

**Small fix:** emit a bounded, deduplicated diagnostic with worker/session and operation (not log content), clear it on recovery, and retry failed projector setup through the existing owned timer/backoff. Preserve the current retry/retention behavior rather than turning recoverable failures into destructive cleanup.

### 10. The documented stale-expiry setting only changes MCP claim display

**Locations:** `packages/room-mcp/src/config.ts:140`; `packages/room-mcp/src/tools/scope.ts:321`, `:378`.

The only live MCP consumer of `staleDays` computes a display flag for offline claims. It does not pass this setting to the hub expiry owner. `docs/reference.md` explicitly describes `ROOM_STALE_DAYS` as a deletion threshold, not a display threshold. A caller changing it therefore receives no corresponding control over deletion. Peer `rohanz+clean-core` independently owns the core-side hard-coded seven-day expiry finding; the MCP-side issue is a setting accepted under the wrong contract.

**Small fix:** agree the expiry policy input with the hub owner and wire the resolved setting through its supported ownership boundary. Until such an input exists, stop advertising the client setting as deletion control; either name it as a display threshold or report that deletion follows the hub policy. Do not have MCP clients independently delete shared state to simulate a server policy.

## Additional findings, grouped by file

### `tools/collect.ts`

**Collection's main operation is too large to review its invariants locally.**

**Locations:** `packages/room-mcp/src/tools/collect.ts:296`–`:867`, especially the candidate inspection beginning at `:520`, write/rollback section and retirement/cleanup section.

The main async closure is about 572 lines, carrying candidate selection, exit waits, capability/operation locks, snapshots, conflict decisions, writes, rollback and retirement through the same scope. This is particularly expensive maintenance debt because it writes user files and must preserve existing hold, provenance and rollback rules. Counting the entire handler factory alone would overstate this; the operational closure itself is the problem.

**Small fix:** extract one phase at a time into typed helpers: inspect/reserve a candidate; prepare its apply plan; apply with rollback; finalize its registry cleanup. Return explicit phase results and keep the current outer lock/finally ownership. Do not replace the collection model or storage subsystem for this cleanup.

### `binding.ts`

- **`:55`–`:60`: transient parent-probe failure is cached as a permanent negative.** `parent === undefined` is the only retry condition; an unreadable first `probeProcessNow` becomes `null`, and failed parent-argument reads become `''` for the binding's lifetime. A process identity is stable, but an inability to read it is not. Inference from ancestry can remain unavailable after the OS recovers unless hook metadata supplies it independently. Retry unsuccessful observations at a bounded backoff; continue caching successful identity/arguments. The 0.17.25 common-directory retry is already present and should not be duplicated.

### `graph-index.ts`

- **`:89`: test-only retained-budget getter is part of the production class.** `retainedBudgetForTest` walks internal accounting and exposes process counters solely for tests. Prefer meaningful bounded diagnostic stats if this is a supported capability; otherwise inspect an internal adapter in the accounting tests. Do not move the process-wide symbol/byte counters onto sessions: the reference explicitly requires a process-wide analysis budget, so that module state is justified.
- **`:157`–`:159`: `ready` and `isReady` have different success meanings.** `ready` waits for a build to finish, including rebuild paths that record error/degradation without rejecting; `isReady` explicitly rejects those states. Existing comments help, but an await at a new call site easily reads as successful readiness. Rename the promise to `buildSettled`/`whenBuilt`, or return a status and require the caller to inspect it. Keep `whenIdle` and coverage reporting rather than inventing another readiness mechanism.

### `registry.ts` and `tools/workers.ts`

- **`registry.ts:252`, `tools/workers.ts:278`–`:317`: fresh and resumed launch callbacks duplicate durable outcome logic.** Both construct launch/process-identity records, write exit witnesses, drop handles and post failure notices; both also recover delivered-but-failed launch outcomes. Differences in first-run versus last-run array updates obscure the common invariants. Extract small registry operations for recording a run's launch/identity and witnessed exit, parameterized by run number; keep fresh preparation and resume policy separate.
- **`registry.ts:252`: ten positional parameters make resume policy hard to use safely.** `spawner`, channel, worker cap, logger, clock, wait and pre-launch callback follow the first three conceptual inputs. Replace the optional tail with a named options object, keeping session, worker and follow-up explicit. This can be independent of the callback deduplication above.

### `session.ts`

- **`:341`–`:359`: successful auth-provider configuration is cached indefinitely.** 0.17.26 correctly stopped caching an offline fallback; it still caches a real response for the process lifetime. A server restart/deployment enabling or changing providers is invisible to later `room_login` calls until invalidation after a successful poll (which may be unreachable when the old config says no provider). Use a short TTL or force refresh at an explicit login/admission failure. This is a different stale value from the fixed initial-offline case.
- **`:515`, `:782`: logging ownership is process-global.** Joining a second room replaces `serverLog`; later server calls from the first room inherit that logger. A later join without a logger retains an earlier callback. This makes exported `joinSession` consumers couple unrelated sessions and can keep a callback alive after leave. Pass the existing optional `serverFetch` logger from a session/client context instead of setting a global default.
- **`:484`: `_refresh` is a dead parameter.** `serverShareMax` always fetches regardless of the fourth boolean; the reconnect caller at `:871` passes `true` as if it changes behavior. Remove the parameter and argument so future callers do not infer a cache bypass contract that does not exist.
- **`:558`–`:723`: startup combines several ownership boundaries.** The 166-line `startAutoTaggedRoomd` both acquires name/hub/publisher authority and installs runtime/hook polling by wrapping `daemon.stop`. Extract the runtime/hook watcher into a helper returning `stop`, `refresh` and listener registration; retain the existing outer failure cleanup and startup order. This is a local extraction, not a session rewrite.
- **`:759`: legacy-validation errors are silently lost.** `watchLegacyIdentity` starts `validate()` with an empty catch after mutating reclaimed identity facts. Keep the nonblocking callback but report a rate-limited validation failure through its owner; do not imply successful validation. Migration should remain retryable and nonblocking.
- **`:511`–`:519`: retry documentation is stale.** The server-fetch comment promises roughly 100 seconds while `SERVER_RETRY_MS` is 45 seconds (plus a current attempt's timeout). Describe the deadline rule and per-attempt timeout, preferably deriving displayed durations from constants. This matters when diagnosing a slow tool, unlike comments that merely restate an assignment.

### `tools/context.ts` and `tools/files.ts`

- **`context.ts:187`, `files.ts:60`: the same contained checkout read is implemented twice.** `workerText` and `ownDiskText` both validate the relative path, realpath the root, check containment, resolve contained links, call the same descriptor-bounded reader and convert ENOENT to null. Only error wording differs. Extract one contained-repository-text helper with an error-context option; keep both callers' safety checks through that helper.

### `tools/files.ts`

- **`:630`, `:733`: test setters mutate process-wide production policy.** `setPreviewCheckLimitsForTests` changes the actual command limits used by every preview, and `setPreviewProcessProbeForTests` changes the liveness probe used by cache reclamation. This is not a claim that MCP callers can invoke the exports, but it is unnecessary global coupling in code that owns timeouts and process safety. Put immutable limits and a probe on a preview-runner instance/options, passing test dependencies explicitly. Keep production defaults constant.
- **`:997`, `:1069`, `:1079`, `:1309`: preview maintenance tasks have bookkeeping but no queue bound/drain owner.** The sets record promises; each cleanup/preview starts another migration or eviction immediately. `removePreviewCache` returns before work ends, and the only drain API is named for tests. Under repeated calls work can overlap, and process exit can abandon final cleanup. Coalesce maintenance by canonical repository/clone, allow at most one pass with a dirty follow-up, and expose a bounded production drain for shutdown. Retain OS locks and later orphan reclamation.
- **`:1177`, `:1184`: preview entry points have seven positional parameters.** Defaults such as `modes`, observer hooks and `allowSlow` make calls easy to misread. Use an options object for these optional controls and give the observer type a shared name; do not split the underlying preview subsystem solely to satisfy a line count.

### `worker-git.ts`

- **`:282`, `:416`: prepare/cleanup have seven and nine positional parameters.** Cleanup in particular places `collected`, `discarded`, terminated-process output, process options, lead identity, workers and preservation policy in one signature. Existing callers need to supply empty arrays/objects just to reach later arguments. Move the optional tail into an object, with named mode/collection and preservation fields; preserve current capability and ownership checks.

### `worker-launch.ts`

- **`:78`: launch has an existing policy object but leaves three lifecycle callbacks positional.** Group `onLaunched`, `onSpawn` and `onExit` into a typed lifecycle object (or the existing host boundary). Names at call sites will make phase ordering and durable writes auditable without changing the mechanism.
- **`:52`: identity-probe timing comment contradicts current code/reference.** It says each Windows probe is bounded to three seconds; the imported definitive probe was changed to a ten-second limit in 0.17.23. Document that this helper uses the definitive shared probe and can make three attempts; avoid duplicating its numeric timeout in the comment. No host capability assumption or new probe is needed.

### `worker-process.ts`

- **`:60`–`:69`: streaming JSON decoding can corrupt split UTF-8 characters.** `hostEvents` converts each byte chunk independently with `chunk.toString('utf8')`; a multibyte code point split at a 64 KiB boundary becomes replacement characters in final answers/errors read from the log. Use `StringDecoder`, as `worker-activity.ts` already does, and flush at end-of-file when appropriate. This is a direct boundary defect visible from the reader, not a claim that a particular production answer was damaged.
- **`:377`, `:425`, `:461`: canonical-cwd handling is duplicated.** Three variants of realpath-with-resolve-fallback plus root/descendant comparison are maintained across worker-cwd checks and termination/quiescence. Extract the fallback normalization and containment predicate locally; retain separate process-list refreshes before signalling, since those are safety checks rather than redundant work.

## Deliberately not reported as defects

- 0.17.25's repository-appears-later binding/log lookup fixes and the “wake path configured” wording are present. 0.17.28's Codex exec binding wait, signal reasons and grouped conflict episodes are present.
- Process-wide parser ownership, graph budgets, bounded immutable historical-text/read-diff caches, the single host-thread binding and OS locks have explicit ownership/limits or documented purpose. Module state alone is not a reason to move these onto sessions.
- Conflict reconciliation and combined-tree construction are large (`conflict-set.ts:677` and `tools/combined-tree.ts:155`), but preserve complex causal/fence/provenance rules. The report does not recommend replacing either engine. Future extractions should isolate a named phase with its current inputs and postconditions, rather than promise a wholesale simplification.
- Dependency injection itself is useful. The test concern above is mutable process-global overrides and production-only test accessors, not clocks/probes/options supplied to an instance.
- No formatter nits or speculative dead-code list is included. The concrete obsolete `_refresh` argument and stale comments are identified above. A broader public-export/dead-code audit would need the production entrypoint configuration, not an assumption that a symbol absent from one module's callers is unused.

## Coordination and limits

This task edits only a new report; there are no changed source interfaces. Room scope/claim checks reported nobody near the report path. Answered `rohanz+clean-core` about bounded MCP Git readers and the live display-only `staleDays` consumer; answered `rohanz+clean-tests` that registry closure does not drain preview maintenance. Their reports own core-helper bounds/expiry and fixture teardown respectively.

The default final overlap preview found no overlapping present paths and explicitly skipped `rohanz`, `rohanz+clean-core`, `rohanz+clean-tests`, `rohanz+indexer` and `rohanz+watchdog`. A named preview with the two affected review peers, `rohanz+clean-core` and `rohanz+clean-tests`, merged their current reports with this report without conflicts (ancestor `5f39111209`). No combined tests were run, appropriate for independent document additions. The lead, indexer and watchdog have no interface dependency on this report and were not included. This is a document integration check, not evidence that any finding has been reproduced. Full validation and any regression tests belong to a later authorized implementation task.
