# Wave 4 review — 2026-09-29

Reviewed **`git diff 51fa373 30e1f05`** (108 files, +3583/−702), with this worktree pinned to **30e1f05511ae14b8451b247c042a1f0be3df5544**. Binding references: the 2026-09-28 redesign plan (R1a, R1b, R3b, D4, D5, R-H1–R-H7), ledger, manifest, registry, reporooms and hub specs; also the wave-3 review and `docs/superpowers/rehearsals/2026-09-29-wave3.md`. **14 Must-fix, 3 Should-fix.** Later workers' overlays and fixes are outside this pinned review. This report is the only retained change; no source file was edited and no commit was made.

## Must-fix

- **M1 — Conflict slots still use session-ID fences, and their writer has no local lease gate. Owner: integration.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:133`, `:172–180`, `:66`.
  The wave-3 conflict writer captures `holder.sessionId` once, including for projected owners. Wave 4 changes the authority to the hub epoch but leaves this writer behind. It also continues reconciling while the local lease is paused: an accepted readable snapshot is not permission to write, since offline facts intentionally remain readable. This violates R1a and hub §7 independently of the previously reported asynchronous snapshot race.

  **Probe:** with actual numeric holder/manifest epochs 101 and 102, the real `ConflictSet` evaluated conflicting changes in a temporary Git repository and wrote `{"owner":"A","status":"conflict","fence":"sid-A"}`. The required fence was `"101"`. Obtain the current local lease/projector epoch at evaluation, revalidate it before slot mutations and notices, and stop mutations when coordination is paused. Do not capture a session ID in the constructor as permanent authority.

- **M2 — Losing the name does not relinquish the worktree publisher. Owner: names.**
  **Locations:** `packages/room-mcp/src/session.ts:522`, `:535–554`; `packages/room-mcp/src/publisher-lease.ts:157–173`; `packages/room-mcp/src/tools/join.ts:140–155`.
  `ParticipantLease` is constructed without its transition callback; publisher detachment happens only when the daemon stops. A still-alive MCP whose name lease lapses or is superseded therefore retains the publisher file. Other attached sessions cannot recover publication because publisher takeover requires death or release. Registry §§15–16 explicitly require withdrawal and detachment on name loss. The advertised terminal-loss recovery is also blocked: bare `room_join`, and joining the same room explicitly, return the current session without checking its failed lease.

  **Probe:** started two production `startAutoTaggedRoomd` instances in one checkout using an in-memory hub transport, closed A's hub client and checked its lease, then waited through the publisher reconciliation tick. A was `lapsed` with no fence, but remained `publisher:true`; B remained `publisher:false`, and the publisher file still attached the room as A. Connect lease transitions to ordered withdrawal/detachment and reattachment after a fresh grant. Let a taken/superseded session actually rejoin instead of taking the same-room fast path.

- **M3 — Old-incarnation overlay text survives replacement and withdrawal. Owner: names.**
  **Locations:** `packages/roomd/src/manifest-publish.ts:73–79`; `packages/roomd/src/publisher.ts:178–197`.
  Publishing a new numeric incarnation removes older manifest maps, but not their overlay maps. Narrowing or losing publisher status clears only the current incarnation's overlay. Thus text no longer authorized for sharing remains present under an older live Y.Doc key, contrary to the manifest incarnation cleanup and withdrawal rules. Reader fence rejection does not remove disclosed content from the replicated document.

  **Probe:** published `secret-old-epoch\n` through the real daemon, obtained a fresh same-session hub grant, updated the probe's lease object to that grant, and ran the daemon's HEAD reconciliation. After `setPublisher(false)`, the old manifest was absent but `overlayText(oldIncarnation, 'x')` still returned the secret. Delete older owned overlay keys together with older manifests at first publication, and ensure subsequent withdrawal/cleanup covers leftover old incarnations without deleting a successor's keys. This concerns current live keys, not erasure of historical CRDT updates.

- **M4 — The production daemon adapter throws away the `pushed` acknowledgement. Owner: integration.**
  **Locations:** `packages/room-mcp/src/session.ts:542`; `packages/roomd/src/index.ts:791–800`.
  The daemon's post adapter invokes `void post(...)` and returns `undefined`. `postPushedPending` awaits that result and clears its durable pending range only after hub acceptance, so successful production posts can never settle. The daemon retries an already-accepted push indefinitely; the durable pending state also survives restarts. Hub de-duplication masks the immediate duplicate, but is not a replacement for acknowledging the pending operation (D5/reporooms B4).

  **Probe:** on the production join helper, installed a legitimate pending commit range and invoked the real `postPushedPending`. The hub accepted one `pushed` into the bus, yet `git.pushedPending` remained set. Return the `Post` result/promise through the adapter, retaining pending state only on an unaccepted result. Add a production-helper acknowledgement test rather than testing only a directly injected daemon post callback.

- **M5 — H1 claim release authorizes by session ID instead of the current epoch. Owner: integration.**
  **Locations:** `packages/room-mcp/src/presence-end.ts:24–31`; `packages/room-mcp/src/worker-registry.ts:384–397`.
  The presence loop requires only that a lease object exists. The registry's supposedly guarded ownership check compares `holder.sessionId`, not the epoch or local instance token. Same-session MCP replacement deliberately preserves the session ID while changing both authorities, so an old paused/superseded MCP can clear the replacement's scope and claims. This directly contradicts R1a, MF12 and registry §18's successor protection.

  **Probe:** called real `releaseIdleHeld` with a local registry, a holder at epoch 22, and an old same-session lease whose `fence()` returned `undefined`. It returned true and removed the scope and claim. Capture and validate the live local lease/epoch, repeat that check after guard acquisition, and bind replay ownership to the correct incarnation. A matching host session ID alone must never authorize this mutation.

- **M6 — H1 marks its journal done even when the release notice never reaches the hub. Owner: names.**
  **Locations:** `packages/room-mcp/src/presence-end.ts:31`; `packages/room-mcp/src/worker-registry.ts:415–416`.
  The callback discards the asynchronous post result, and `reconcileIdleClaims` immediately writes `state:'done'`. A hub outage after claim removal permanently loses the required notice: the deterministic ID cannot help if no accepted post is retried. Registry §18 requires pending-journal replay through successful notice publication.

  **Probe:** made the real `releaseIdleHeld` poster resolve `{ok:false, text:'not sent: hub unreachable'}`. Two calls produced `first:true`, `second:false`, zero claims, no scope, one post attempt and a journal marked `done`. Await hub acceptance before marking done, and reconcile pending journals on reconnect/restart even after their removals mean the session no longer holds anything. Preserve the same notice ID on retries.

- **M7 — Presence expiry considers and detaches only the primary room. Owner: names.**
  **Locations:** `packages/room-mcp/src/index.ts:112–118`; `packages/room-mcp/src/tools/state.ts:163–166`, `:192–196`.
  Registry §18 defines held work across every joined room and non-terminal workers through the durable registry. The new loop checks only the primary session's claims/scope, and treats raw replicated `workerViews` with `status === 'running'` as the worker test. Its idle leave drops only that session. A lead with a team room plus a workers room can expire while holding work in the second room, leaving the second provider, name lease and publisher attachment active. Once dropping primary clears the current session, the shutdown early return also bypasses that remaining room. Starting or unresolved non-terminal worker records are not covered by the raw `running` test.

  **Evidence:** static inspection of the production callbacks and `Rooms`/drop lifecycle; no real socket expiry rehearsal was possible. Inventory all joined sessions for held work and teardown, use registry `projectable(me).write`/the corresponding durable decision for workers, and end presence in every room before declaring the idle leave complete. Publish idle state consistently across those rooms.

- **M8 — Host-session termination deletes coordination facts that must remain offline. Owner: names.**
  **Locations:** `packages/room-mcp/src/index.ts:115`, `:174`; `packages/room-mcp/src/tools/state.ts:187–190`, `:194`.
  The new host-PID termination path calls ordinary shutdown, which invokes `cleanupMine` and removes the session's claims and scope. Registry §18 explicitly says ending presence deletes nothing from the document: records, claims, scope and owed mail remain for offline coordination. Explicit `room_leave`/`room_done` and H1 are separate release operations; observed host death does not authorize that cleanup.

  **Probe:** constructed real `createTools` state with a temporary Git repository, one own scope and claim, no workers, and only transport leave stubbed. Calling `tools.shutdown()` left zero claims and no scope. Separate presence termination from explicit coordination release; stop providers/daemons and release name/publisher leases while preserving offline document facts. Keep H1's specifically journaled release distinct.

- **M9 — roomagent can consume and receipt another session's mail without a lease. Owner: resume.**
  **Locations:** `packages/agent/src/runner.ts:125`, `:222–249`; `packages/agent/src/cli.ts:96–110`.
  The ledger conversion selects owed mail and writes receipts without checking name authority. The CLI's lease acquisition is lazy on outgoing posts and is not a precondition for Runner delivery; the Runner does not receive a lease gate. A second roomagent under an already-held name can therefore mark messages seen for the legitimate holder. This violates the ledger's fenced-handoff invariant and R1a even though the backend acceptance callback correctly delays ordinary receipts until delivery.

  **Probe:** set P's real holder to `other-session`, epoch 55, appended an addressed question through `hubAppend`, and ran the actual Runner with a fake accepting backend and `sessionId:'stale-session'`. It ran one turn and wrote `{s:'stale-session', via:'agent'}` into P's receipt map. Acquire authority before delivery; use the same live lease at selection and acceptance, reject stale callbacks, and stop delivery on lapse. Publish the matching session identity in roomagent presence as well.

- **M10 — Default preview omits neighbours whose overlap is in committed changes. Owner: near.**
  **Location:** `packages/room-mcp/src/tools/files.ts:166–181`.
  The new default overlap filter examines manifest paths and caller scope, but never includes the committed `merge-base..base` paths in B5/B7's definition of `changed(participant)`. Empty dirty manifests do not mean empty branch changes. A present neighbour with an overlapping committed edit is silently excluded before preview can merge it or report a gap.

  **Probe:** created real Git commits with B changing `x` from A's ancestor base. Both participants were present, with valid numeric epochs and complete/all empty dirty manifests; A scoped `x`. Actual `room_preview_merge({})` returned **“no present participants to merge”**, while the real Git diff between bases named `x`. Use the shared changed-path definition, combining pairwise committed changes with manifest changes, for default neighbour selection. Unavailable commit enumeration must become an explicit skipped/gap reason, not an empty change set; preserve the required running-worker inclusion.

- **M11 — The web reader validates asynchronous completion against an old presence view. Owner: web.**
  **Location:** `packages/web/src/manifest-reader.ts:30–38`.
  Both snapshot attempts and `snapshotStillCurrent` use the same caller-supplied `ParticipantView[]`. Projected manifest validity depends on the lead's live holder, so a holder/awareness transition during browser hashing is invisible to the completion check when the projected head itself does not change. This violates the manifest snapshot rule and accepts a stale projector's text after its authority moved.

  **Probe:** read W's shared projected text under A's epoch 101, changing A's actual holder to epoch 201 inside the awaited browser digest operation. W's head stayed fixed. `readWebVersion` returned **`text`** under the obsolete fence. Rebuild the relevant participant/awareness view for completion validation and retries, or pass a getter that does so. A captured view cannot establish current authority after an await.

- **M12 — The hook bridge suppresses the paused state it is meant to publish. Owner: names.**
  **Locations:** `packages/room-mcp/src/hooks-bridge.ts:88`, `:97–100`; `packages/room-mcp/src/tools/state.ts:44–46`.
  The bridge returns when its lease-backed `fenced()` becomes false, before evaluating/writing the new `paused` field. Hub §7 requires hook `state.json` to carry paused status so before-edit can explain that coordination stopped. Instead the last healthy state is left behind until it ages out, without the required warning.

  **Probe:** wrote a healthy state using the real `HooksBridge`, switched its authority to unfenced with a nonempty paused reason, then called `write()` again. The resulting file still had its previous healthy fields and no `paused`. Provide a safe minimal health-state update on lease loss, without writing coordination/receipt data and without letting an obsolete local instance overwrite a successor's state endpoint.

- **M13 — Host-session rebinding leaves the name lease and daemon attached to the old session ID. Owner: names.**
  **Locations:** `packages/room-mcp/src/session.ts:490–497`, `:522`, `:541`, `:566–575`; `packages/room-mcp/src/binding.ts:38–51`; `packages/room-mcp/src/tools/state.ts:126`.
  Binding rechecks can correctly find a new same-chain `session.json`, but the join helper captures its session ID, local token, hub holder and daemon presence ID once. Its record watcher refreshes runtime fields/activity only. The ledger subsequently obtains the new ID from the dynamic binding while the name lease still represents the old host session. Registry §17 explicitly requires the same MCP instance to rewrite its name lease on a same-chain Claude `/clear` rebind.

  **Evidence:** static trace of the rebinding and join paths; no live Claude feature assumption or host invocation was used. After a binding change, receipt metadata can identify the new session while holder/presence still identify the old one. Make binding changes an explicit lease transition covering local name ownership, hub authority, daemon presence, ledger handoffs and wakes. Pause handoff during that transition and reject callbacks captured under the previous identity.

- **M14 — Correctly non-publishing sessions are classified as perpetually updating. Owner: integration.**
  **Locations:** `packages/shared/src/manifest.ts:112–115`; `packages/web/src/manifest-reader.ts:58–59`.
  Wave 4 correctly stops non-publishers writing `git`, but the common resolver requires a matching `git` record before it reaches the `coverage:none/not-publisher` branch. A healthy non-publisher can therefore never produce the manifest §5.7 answer identifying its publisher; web coverage adds a misleading updating gap too. This is an integration mismatch between the new writer and existing common reader.

  **Probe:** joined a second production daemon in a checkout with A already publishing. Its head was complete, correctly epoch-fenced, `coverage:{kind:'none',reason:'not-publisher'}`, and `publisher:'A'`; it correctly had no `git` record. `versionOf` returned `unknown/updating` with “manifest is updating.” After validating holder/head authority, handle non-publisher coverage before publisher-only Git coherence checks and preserve the publisher name in the user-facing explanation. Do not restore forbidden non-publisher base writes to satisfy the reader.

## Should-fix

- **S1 — Epoch migration leaves important reader/conflict tests on impossible fixtures. Owner: integration.**
  **Locations:** `packages/web/src/test-manifest.ts:6–10`; `packages/web/src/manifest-reader.test.ts:9`; `packages/room-mcp/test/conflict-set.test.ts:92–102`.
  The fixture holders still use session-ID fences without numeric epochs, so the new authority checks reject their supposedly valid publications. The focused polling-mode run produced **17 failures**: seven conflict-set, five manifest-reader and five panels tests. These prevent the suite from distinguishing real regressions from invalid setup. Update shared fixtures to the hub epoch contract, remove obsolete holder fields, and keep a production-join integration case so authority is not only supplied by test setup. Do not weaken the reader checks to make old fixtures pass.

- **S2 — The advertised unknown-holder takeover cannot be requested through `room_join`. Owner: names.**
  **Locations:** `packages/room-mcp/src/names.ts:143`; `packages/room-mcp/src/tools/join.ts:27–28`, `:133`; `packages/room-mcp/src/session.ts:645`, `:713`.
  The name-selection error tells the caller to use `room_join takeover=true`, as registry §15 specifies, but the tool schema/handler and public join options do not route that flag to `startAutoTaggedRoomd`. An explicit tag held by an `unknown` local process has no working advertised recovery. Static finding: expose and validate the flag end to end, keeping the override limited to unknown holders; a known-alive different session must remain protected.

- **S3 — Bound hook contact does not reset the presence idle clock. Owner: names.**
  **Locations:** `packages/room-mcp/src/index.ts:97`, `:123`; `packages/room-mcp/src/session.ts:572–575`.
  Registry §18 counts a bound arbitration-hook contact as activity. Only the Room tool-call wrapper invokes `presence.activity()`; arbitration selects directly, and the hook-activity record watcher only calls daemon `touch()`. Active hook-driven work can therefore continue showing a growing idle duration. Route successful contact for the bound session into the same monotonic activity tracker; do not count passive polling or another session's hook. This is a static wiring finding, not a claim that today's unbound app-server path has a working hook binding.

## Validation and rollout assessment

- The wave-3 rehearsal's two initial production blockers are closed in the join helper: real hub acquisition through `startAutoTaggedRoomd` wrote a holder with a numeric epoch, the daemon manifest used that epoch, and awareness carried the matching `sessionId`; `participantsView` reported it fresh. The probe used the existing in-memory hub transport and real lease/publisher/daemon implementation, without fixture-inserting holders. Both local/team production join callers route through that helper. This does not claim a socket or remote-host end-to-end rehearsal.
- Focused names/publisher/presence/neighbours/resume/worker-stream/migration/web/runner tests initially ran **94 tests: 79 passed, 15 failed**. Eight failures required prohibited sockets and two were watcher resource failures. A second run using polling, covering auto-tag, conflict-set, web panels/readers and shared manifest/neighbours, ran **79 tests: 62 passed, 17 failed**; the remaining failures are the stale-fixture group in S1. Socket-only failures are excluded from findings.
- Separate temporary probes exercised real conflict evaluation, web async reads, Runner acceptance, idle-release journaling, default preview, shutdown, hook-state writes and the production join helper. They reproduced the observations above; temporary scripts, repositories and dependency links were removed after review. No host-model call, external send, commit or push was needed.
- D4 stream-json/resume-evidence and local-migration paths were inspected and their focused offline suites passed. That does not repair the independent unfenced roomagent consumption in M9. The old production auto-name reservation, publisher election helpers and 90-second name grace were removed; this review does not count unrelated later-wave deletions or repeat the other outstanding wave-3 findings.
