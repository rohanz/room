# Local daemon spec review

Date: 2026-11-05. Reviewed `docs/superpowers/specs/2026-11-05-local-daemon.md` against the current checkout, `CLAUDE.md` Engineering priorities, CHANGELOG 0.17.25–0.17.32, the 0.17.31 review and verification, and `deploy/self-hosting.md`. Historical review line numbers describe their intermediate trees, not current defects. This is a static design/code review; no implementation, host-lifetime experiment or release validation was run.

## Verdict

**Needs revision.** Specify recovery without discarding surviving replicas and a way out of storage backpressure before implementation. These affect correctness and user control, not just diagnostics. The remaining items below require explicit contracts or narrower claims; they do not justify adding a database, supervisor or general host-adapter framework to this change.

## Must-fix

### 1. Storage backpressure can prevent the operation needed to recover

The memory section says to reject new coordination writes and pause document publication on storage failure. The failure table includes an over-ceiling snapshot in that state. It provides reads and retries, but no permitted recovery mutation.

**Concrete scenario:** protected memory roots grow beyond the 64 MiB snapshot ceiling. `memorySnapshot` deliberately retains mail, outcomes and other protected roots even above the target (`packages/shared/src/memory.ts:47`); `writeMemory` refuses a snapshot over the ceiling (`packages/relay/src/memory.ts:87`). The daemon enters storage failure, rejects coordination and pauses publication. A client cannot deliver the deletions or acknowledgements needed to reduce retained state. Retrying the unchanged snapshot cannot succeed; idle stop cannot finish. An otherwise usable clone remains blocked until the user forgets history or kills the only current replica.

Current local size-cap handling explicitly permits non-growing sync and deletions so the room can shrink (`packages/relay/src/index.ts:240`, `docs/reference.md:43`). Wiring every snapshot failure into the hub's `unavailable` callback changes that recovery property: the callback is an admission/timing mechanism, not a repair policy.

**Required revision:** distinguish capacity failure from transient I/O failure and define allowed repair operations, their acknowledgement semantics and client behavior. Preserve an authenticated, bounded route to shrink/export retained state without forgetting the room. Test a genuinely over-ceiling protected snapshot, rejection of growth, successful reduction, retry and eventual orderly stop. The smaller design is existing non-growing capacity admission plus retry/status for I/O failures; do not add blanket write suspension unless its recovery contract is fully specified.

### 2. Endpoint rediscovery must preserve the surviving replica across session replacement

Crash recovery removes the startup seed and relies on normal Yjs resync. The fallback-port case says clients must rediscover and rebuild their session URL, but does not specify ownership of the old Y.Doc across that operation. The existing leave/rejoin mechanism cannot be reused unchanged for this.

**Concrete scenario:** a post reached the daemon and one client, but not the delayed snapshot. The daemon crashes; another listener occupies its recorded port, so its replacement uses a fallback. The surviving client rebuilds its session through leave/rejoin. `leaveSession` stops roomd (`packages/room-mcp/src/session.ts:1198`), and roomd destroys both its provider and document (`packages/roomd/src/index.ts:707`). The replacement session starts from the old disk snapshot. The only surviving copy of the acknowledged post was voluntarily discarded during recovery, although the spec's stated loss exception assumes no surviving replica.

The same risk applies when a bounded reconnect attempt disposes a session before a replacement can sync. Keeping logical post IDs only prevents retry duplication; it does not preserve already acknowledged history.

**Required revision:** define transport rebinding that retains the Y.Doc, or explicitly capture and carry the replica into the replacement connection until successful resync. Separate explicit user leave from involuntary connection recovery, including cancellation and retry exhaustion. No special daemon startup-seed API is necessary. Test a forced fallback port with a post absent from disk and only one surviving client; prove the fact survives the actual session recovery path, not just two standalone providers syncing on an unchanged URL.

## Should-fix

1. **Define snapshot-load failure as a state, including unreadable rather than corrupt files.** `loadMemory` catches every non-ENOENT error, attempts a rename, ignores rename failure and returns an empty document (`packages/relay/src/memory.ts:58`). The spec requires retained corrupt evidence and a degraded warning, but does not say whether failed reads block subsequent snapshot replacement. A transient read failure followed by a successful write can replace history that was never loaded. CHANGELOG 0.17.30's credential/session/registry fixes identify precisely this failure pattern. Distinguish absent, unreadable, invalid and successfully loaded snapshots; retry unreadable files without overwriting them. Define when an operator may accept an empty recovery. Similarly, implementing the proposed fail-closed lease recovery requires changing `Hub.start`, which currently catches lease-read errors and continues with no adopted leases (`packages/hub-core/src/hub.ts:267`). This is additional behavior work, not merely reusing the loader.

2. **Complete first-start key and discovery ownership.** “The key is read from private discovery by the daemon” has no first-run case when `relay.json` does not exist. Current creation generates a key in `ensureLocalRelay` (`packages/relay/src/index.ts:700`). Assign generation to the authority-lock winner, then publish once readiness is possible. Specify missing versus unreadable discovery, no parent key writes, no silent rotation on parse/read failure, and a bounded failure result if publication fails. This needs no second lock or secret transport through argv.

3. **Fence already upgraded handshakes during drain.** Refusing new HTTP upgrades does not prevent an already upgraded secure handshake from completing. Current `attach` calls `attachReady` after decryption with no drain check (`packages/relay/src/index.ts:220`); pending handshakes are intentionally excluded from the proposed idle count. During an awaited lease flush one can authenticate and become a writer after the zero-client decision. Define whether that cancels draining or receives a retryable refusal, and apply the decision before document attachment. Test this exact interleaving, not only new upgrades racing the timer.

4. **Make the drained 0.17.x procedure version-specific and observable.** The spec acknowledges that pre-0.17.31 stop can lose state, but then gives one stop/restart procedure. For 0.17.25–0.17.30, state which evidence establishes a safe checkpoint before stopping and what to do when it cannot be established. An export is not necessarily a reloadable selective snapshot. Finish draining before restarting updated clients; enumerate old local clients, including bridge and nested sessions. Test old clients that reconnect after migration as well as old-owner takeover after a crash. “Unsupported mixed versions” must be a visible diagnosis, not a guarantee that new metadata can fence old code.

5. **Define compatibility and privacy checks at the consuming endpoints.** Discovery metadata alone does not gate an already connected provider or packaged viewer. State which authenticated exchange checks runtime/compatibility and what the viewer displays on mismatch. Specify the Windows ACL verification/remedy rather than relying on POSIX modes or unspecified inherited ACLs. Retain the private-checkout boundary in `deploy/self-hosting.md:249`; a shared readable key is not an independent-user authorization system. These are implementation acceptance gates, not evidence that native Windows detachment already works.

6. **Narrow two persistence/process claims and improve two citation targets.** Atomic rename preserves the prior file on failures before replacement, not every fsync failure: directory fsync runs after rename (`packages/relay/src/memory.ts:100`). The old file may already be replaced when that fsync throws; report durability uncertainty and retain memory, rather than promising the previous file remains. Windows cached identity queries are asynchronous, but own-identity initialization and definitive confirmation still use synchronous reads (`packages/relay/src/process.ts:198`, `:296`, `:305`). Cite those exceptions. For private lease restoration cite `packages/hub-core/src/hub.ts:251` and `packages/relay/src/hub.ts:50`, not only the incarnation-file helper at `:44`. For team admission use `deploy/self-hosting.md:39` and `:68`, rather than the client setup paragraph at `:35`.

## Notes

### Incident and component accounting

| Component or retained boundary | Incident or requirement | Smaller design / review consequence |
| --- | --- | --- |
| Separate per-common-directory transport process | 0.17.31 worker-owned relay and lagging owner; two leads losing transport when one leaves | A separate process running the existing relay is the relevant isolation boundary. A thread still shares host lifetime. No global service or new authority scheme follows from this incident. |
| Any bound client may launch it, including nested hosts | 0.17.31 lead-only containment strands workers; review finding 1 covers scrubbed nested hosts | Keep clone/run validation; remove only transport role restrictions. A permanent “lead authorized once” marker adds lifecycle state without solving event-loop isolation. |
| Absolute bundle, stable cwd, detached stdio, environment allowlist | Host/worker exit; removed worktrees; private credentials and path boundary | One launcher and self-contained bundle. Native host process-tree survival must be demonstrated; no claim here depends on an unverified host flag. |
| Existing authority lock, birth identity, discovery proof | Concurrent starts, crash recovery, PID reuse, unrelated listeners | Reuse one exclusion mechanism. No second PID registry, election or timeout-based takeover. Unknown liveness blocks. |
| Idle timer and authenticated socket count | Engineering priority 5: bound a process that outlives sessions | Five minutes is a policy choice, not derived from an incident. No parallel client heartbeat registry. A viewer can extend sharing lifetime; expose that fact. Account for pending handshakes. |
| Save-first drain, lease flush, retry/status | 0.17.31 review finding 2 and subsequent ordinary-stop failure | Reuse final-save machinery, add autonomous retry and observable failure. A failed save must retain authority. A maintenance stop endpoint is optional convenience; defer it if an authenticated CLI path can reuse the same drain routine. |
| Storage write suspension | Hosted storage behavior and bounded-growth priority; not required merely to separate lifetime | Larger behavior change than daemonization. Must-fix 1 applies. Retry/status alone addresses persistence visibility without changing every publisher's protocol. |
| Selective snapshots and private lease/incarnation files | Crash recovery and existing delivery contract | No WAL/SQLite requirement unless the maintainer strengthens acknowledged-post durability. Do not infer ownership from replicated holders. Unreadable-load policy remains necessary. |
| Same-port reconnect and fallback rediscovery | Daemon death and port collision | Preserve the replica while rebinding; a second startup state-transfer protocol is unnecessary. Must-fix 2 applies. |
| Checkout publisher arbitration remains in MCP | 0.17.30 duplicate graph rebuilds and ten-hour CPU incident | Transport isolation does not fix indexer CPU load. Do not centralize indexing or wake delivery in the daemon on this evidence. |
| Worker registry, collection, preview cleanup stay outside | 0.17.26–0.17.28 retention/cache incidents; 0.17.31 keep/cleanup issues; 0.17.32 Linux quarantine fix | No daemon component is justified by these incidents. Keep regression coverage; do not imply transport changes repair worktree retention or unwitnessed worker exits. |
| Hook identity and binding stay outside | 0.17.25 repository appearing after host startup; 0.17.28 Codex thread-ID race | Reuse existing binding and AutoJoin cancellation/policy behavior. A new daemon must not launch from unbound tool listing or polling. |
| Proofs, encrypted frames, read tickets, quotas and private files | Hostile localhost pages, unrelated OS users, bearer-link disclosure and resource exhaustion | Preserve existing security boundaries. Same-user clone-key holders are one trust domain; no invented lead privilege. Team credentials never enter daemon environment or logs. |
| Runtime/compatibility gate and drained upgrade | Roadmap's update-on-disk incident; legacy in-process takeover | A small explicit compatibility contract is sufficient. No general negotiation framework or live handover is required. |
| Bounded logs and separate daemon status | 0.17.30 unexplained CPU and Engineering priority 6 | Reuse bounded metadata logging. Set concrete rotation/count limits; avoid a new telemetry service. |
| Native Windows launch and storage tests | Windows identity ambiguity, file replacement and host termination risks | Same Node entry point, but POSIX tests do not establish ACL privacy or Windows survival. Treat lack of evidence as a release blocker, not grounds for a shell/service fallback. |

The 0.17.31 review's collection, audit-tail, run-log and escaped-child findings do not justify moving those subsystems into the daemon. The specification must preserve their current owners. The independent migration/read-failure lessons from 0.17.30 still apply to any state this new process loads.

### Citation audit

All **66 distinct file:line links** resolve relative to the spec to existing files and in-range lines in this checkout. The table accounts for every link. “Supported” means the cited function/section and its surrounding implementation support the claim, not that the single anchor line contains the whole assertion. Proposed behavior is not credited as already implemented.

| Cited file | All cited lines | Result |
| --- | --- | --- |
| `CHANGELOG.md` | 9, 25, 31, 32 | Supported: relay incident, graph timings, CPU diagnostics and checkout arbitration. |
| `docs/reference.md` | 11, 43, 39, 200 | Supported: roles, admitted loss window, viewer security and relay bounds. Reference prose about retrying workers is narrowed correctly by the spec's AutoJoin paragraph. |
| `docs/superpowers/reviews/2026-11-05-prerelease-review-0.17.31.md` | 7, 9 | Supported as historical findings, not current code line locations. |
| `docs/superpowers/reviews/2026-11-05-prerelease-verification-0.17.31.md` | 15, 17, 66 | Supported: removed handover, then-unfixed ordinary stop, socket-denied verification limits. |
| `packages/relay/src/index.ts` | 585, 805, 590 | Supported: save-first close, retryable failure retaining ownership, session-local stop. Current close does not itself implement proposed daemon lease flushing. |
| `packages/room-mcp/src/session.ts` | 940, 953, 1196, 1186 | Supported: clone/worker checks, seed and startup teardown, stop ordering, graph arbitration. |
| `packages/relay/src/index.ts` | 643, 699, 732 | Supported: effective lead rule, absent-relay refusal, tolerant monitoring/takeover. |
| `packages/relay/src/index.ts` | 332, 370, 654, 708 | Supported: discovery shape, canonical port, private temporary publication, collision fallback. Publication errors currently log and continue, as the spec says. |
| `packages/relay/src/hub.ts` | 19, 44 | Lock claim supported; :44 implements incarnation storage, not private lease restoration. See should-fix 6. |
| `packages/relay/src/leases.ts` | 17 | Supported through liveness, guarded recovery and nonce-checked release in this module. |
| `packages/relay/src/index.ts` | 128 | Supported: retained room document, awareness, memory and hub construction. |
| `packages/hub-core/src/protocol.ts` | 9, 48 | Supported: type 7, timing constants and clone-key local principal. |
| `packages/hub-core/src/hub.ts` | 247, 278 | Supported: trusted incarnation checks and durable advancement; private lease adoption is in the intervening startup code. |
| `packages/relay/src/memory.ts` | 46, 119, 179, 58, 158 | Supported: paths/load, event reconciliation/scheduling, retry delays, empty-on-load-error behavior, forget suppression. |
| `packages/shared/src/memory.ts` | 12, 47 | Supported: selective roots, fresh CRDT copies and protected retention. Numeric limits are at :5 and :9 in the same file. |
| `packages/relay/src/memory.ts` | 82, 98 | Writable-handle fsync and atomic rename supported; blanket “failure preserves previous file” needs the post-rename fsync qualification. |
| `packages/room-mcp/src/auto-join.ts` | 42, 96, 136 | Supported: deadline/backoff/cooldown, single flight, policy and cancellation. No indefinite reconnect service. |
| `docs/decisions.md` | 210 | Supported as superseded history: keyless access and relay-served viewer. |
| `packages/relay/src/index.ts` | 194, 470, 560 | Supported: secure session/frames, request proof verification and loopback upgrade admission. |
| `docs/roadmap.md` | 36, 25 | Supported: separate proposed projects and update-on-disk incident; not shipped daemon/negotiation behavior. |
| `packages/hub-core/src/hub.ts` | 394 | Supported: unavailable callback and lease timing reset on recovery. Does not supply a local storage retry/repair protocol. |
| `packages/relay/src/index.ts` | 491, 255, 180 | Supported: ticket exchange, read-only document/awareness handling and hub refusal. |
| `packages/relay/src/process.ts` | 11, 62 | Unknown/pending semantics and PowerShell command supported. Blanket async-query wording omits definitive synchronous reads; see should-fix 6. |
| `packages/relay/src/index.ts` | 75, 437 | Supported: queue budgets and retained-room/socket limits; defaults also corroborated by reference :200. |
| `deploy/self-hosting.md` | 35, 41, 45, 174, 249 | Bearer links, capacity validation, private backups and path boundary supported. :35 is setup/destination guidance, not the substantive admission policy; use :39/:68. |

No new host feature is assumed by this review. Native detachment and host-termination behavior remain empirical acceptance requirements; the spec does not establish them by citing Node options. The current-document review therefore does not certify any particular Claude/Codex version's process-lifetime behavior.

## Three questions the maintainer must answer before implementation

1. **What recovery guarantee is required for an acknowledged post?** Is delayed snapshot durability acceptable after loss of every replica, while requiring preservation of a surviving replica during all reconnect paths? Which operations remain available to recover from capacity, unreadable storage and failed writes?
2. **What lifecycle and launch authority are being authorized?** May any verified worker/nested client create and restart the daemon, and may viewers keep it alive after all leads leave? Confirm the idle default, private-checkout boundary and native Windows survival/ACL acceptance criteria together.
3. **What exact migration/support window will ship?** Is a drained-only upgrade from 0.17.25–0.17.32 acceptable, how is successful preservation established before stopping older owners, and where are incompatible MCPs/viewers refused before publishing or showing an apparently empty room?

Must-fix count: **2**.
