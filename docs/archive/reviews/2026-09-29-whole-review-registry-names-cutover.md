# Whole-redesign review: registry, names and cutover — 2026-09-29

Reviewed **`git diff 8097a8b c449f3e`**, pinned to **c449f3e**. **8 Must-fix, 1 Should-fix.** Owner areas: registry, names/presence and cutover. Binding references: redesign R1/R1a/R1b, R5, R6/R6a, D2/D3/D5; registry; reporooms B1/B2/B11–B14 and Migration; the naming map; prior reviews; wave-4 rehearsal. This document is the only retained change. No source edits, commits or pushes.

The lead's transition ruling is applied: 0.16 clients may continue in **unmigrated** branch rooms until the first schema-2 migration. That admission is not a defect. Previously resolved findings are not repeated; the findings below identify remaining paths or new failures in their fixes.

## Must-fix

### M1 — Refusing a follow-up leaves the worker's operation lease held indefinitely

**Locations:** `packages/room-mcp/src/registry.ts:280`, `:285`, `:293`. **Owner: registry.**

`registry.resume()` acquires the operation lease and writes run n+1. The subsequent `beforeLaunch` post and prompt-ID write happen outside the `try/finally` that releases it. A normal hub refusal returns at line 285 without `finishOperation`; a thrown post or prompt-ID write has the same missing cleanup. The same live MCP then cannot resume, collect or discard this worker because another call supposedly holds its operation lease. Reconcile cannot recover a live holder.

**Probe:** real temporary Git repository, owned worker worktree and durable done/exit facts; called the real `Rooms.resumeWorker` with a refusing post callback. First result: `error: hub full`. Retrying: `error: worker operation lease held by another call: w_…`; the `.op` file remained. No worker was launched.

**Fix direction:** enclose every operation after successful run reservation in the release `finally`, including posting and prompt metadata persistence. Preserve the `never` outcome when delivery was refused and leave the message owed. Test refusal, a throwing callback, and successful retry in the same MCP.

### M2 — Launch-handoff recovery records the worker MCP as the host process

**Locations:** `packages/room-mcp/src/worker-registry.ts:113`, `:1055`, `:1066`, `:1070`. **Owner: registry.**

Admission writes the report chain as MCP first, parent host second. Both absent-launch and ambiguous-launch recovery select `report.chain[0]` as `launch.process`. If the original lead died in the launch handoff window and that worker's MCP subsequently exits/restarts while its Codex/Claude host keeps working, reconcile records an unwitnessed worker exit. Status becomes failed (or earlier-done for a resume), capacity is released, and later resume checks inspect the dead MCP rather than the live retained host. This can permit a second run while the original host still edits the worktree. It is a different path from the earlier, fixed discard-chain selection finding.

**Probe:** actual registry reconciliation with injected process liveness and an admitted `[MCP, host]` chain. The recovered launch PID was the MCP's. Marking only the MCP dead produced an unwitnessed exit and `failed: stopped while no session of yours was running`, while the admitted host remained alive.

**Fix direction:** persist explicit host identity during admission/handoff, or retain a distinct recovered-chain state whose exit/resume checks account for the live host. Do not promote the first chain member to a host identity. Add the real two-member admission shape to the handoff tests, including MCP replacement before host exit.

### M3 — The normal join path immediately deletes successfully migrated claims and scope

**Locations:** `packages/room-mcp/src/session.ts:584`, `:595`; `packages/room-mcp/src/tools/join.ts:196`; `packages/room-mcp/src/index.ts:104`; `packages/room-mcp/src/tools/state.ts:164`. **Owner: cutover + names.**

Session startup reclaims a legacy identity and validates/reanchors its migrated claims. After it returns, explicit `room_join` calls `cleanupMine`, and automatic startup's `adopt` calls `tools.clearStale`. Both unconditionally remove the current participant's non-human claims and scope through `releaseClaimsOnDone`. Consequently, a valid claim kept by Migration's hash validation and a restored scope disappear before the joining agent can use them. This affects unique names and reclaimed ambiguous names; it is not the intended release of a claim whose hash no longer matches.

**Probe:** passed a migrated claim carrying `origin: local/repo/main` and its restored scope through the actual `createJoin().cleanupMine` used by both paths. Result: one removed claim, zero claims, no scope. Static call-chain inspection places this cleanup after `validateMigratedClaims` on ordinary startup.

**Fix direction:** distinguish migration/startup restoration from explicit coordination release. Preserve validated migrated facts through both automatic adoption and `room_join`; limit stale cleanup to facts the binding rules actually invalidate. Add an end-to-end join assertion after migration, rather than ending the test at the validator or unresolved-map watcher.

### M4 — The mixed-install check rejects valid 0.17 room names

**Location:** `packages/room-mcp/src/worker-registry.ts:103`. **Owner: cutover + registry.**

`admitWorkerEnvironment` guesses whether a room is legacy by segment count: more than two segments for `local/`, or four for `git/`. B1 preserves explicit names, and the naming spec explicitly supports `local/x/special` and nested non-GitHub repository paths. A 0.17 lead can join either and launch a worker with a valid registry ID/run/nonce, but the worker refuses before reading that record and falsely reports that its lead runs an old version. Workers in these otherwise supported rooms cannot join or report completion.

**Probe:** the actual admission function refused both `local/repo/special` and `git/gitlab.com/group/subgroup/repo` as legacy despite a `w_…` worker ID and current run credentials. The rejection precedes filesystem/registry validation, so it cannot consult the authoritative room.

**Fix direction:** identify a legacy worker from the launch protocol/local record and validate `ROOM_ROOM` against the admitted record's exact room. Use canonical server evidence where needed; do not infer a branch suffix from path depth. Keep genuinely legacy IDs and inconsistent launch environments refused.

### M5 — Catch-up mail remains addressed to an already reclaimed placeholder

**Locations:** `packages/relay/src/local-migrate.ts:84`, `:122`; `packages/room-mcp/src/session.ts:663`, `:673`. **Owner: cutover; cross-area delivery invariant.**

After an ambiguous identity is reclaimed, its unresolved entry is deleted and `aliases[placeholder]` names the current participant. A still-running legacy relay can then add another question. Catch-up translates it to the same placeholder but ignores the alias. Because the source's scope/claims were already imported, it creates no new unresolved entry; the watcher observes only `unresolved`, so it never rewrites this mail. The delivery ledger matches `to` exactly and does not read aliases. The real participant therefore never receives the new question, even though reclamation already established its destination. Initial ambiguous identities appearing only in messages also need an unresolved entry, which this local importer currently creates only through claims/scopes.

**Probe:** imported main/feature scopes for ambiguous ben, reclaimed main as `ben-new` using the real watcher, then added a main-branch question. Catch-up left `to: ?4e7a5b5dcaa0e041`, while `aliases` mapped that placeholder to `ben-new` and main's unresolved entry was absent.

**Fix direction:** make catch-up translation respect durable reclaimed identities, including both sender and recipient, and create reclaimable entries for mail-only ambiguous identities. Reconcile arrivals after reclamation without reopening old claims/scopes or re-delivering receipted IDs. Test two catch-ups with a real reclamation between them.

### M6 — Late ambiguity moves a newly authored scope into someone else's legacy identity

**Location:** `packages/relay/src/local-migrate.ts:103`. **Owner: cutover.**

The fix for expanding identity ambiguity identifies an imported scope only by `ledger.scopes.includes(source + NUL + person)`. That marker never proves the current scope is still the imported one. Import main/ben, let the active schema-2 ben declare a new scope, then discover feature/ben in a later snapshot: migration deletes the current scope and places its new contents under main's legacy placeholder. The active participant loses its declared work, and another worktree reclaiming main can receive that new scope. Claim migration checks source provenance; scope migration does not.

**Probe:** after the first catch-up, replaced ben's scope with `summary: authored in schema2`, `paths: [new.ts]`. Adding feature/ben and catching up removed ben's scope and stored exactly that new scope in main's unresolved entry.

**Fix direction:** retain an identity/revision or fingerprint of the imported scope and move it only while the target still matches that import. Preserve later schema-2 declarations. Add a changed-scope interleaving to the existing late-ambiguity regression; checking only an untouched imported scope misses this failure.

### M7 — An unreadable legacy snapshot is permanently marked migrated

**Locations:** `packages/relay/src/local-migrate.ts:65`, `:158`, `:59`. **Owner: cutover.**

A snapshot read/decode failure is logged and skipped, but if the old relay is gone the importer still writes `complete: true`. Every later catch-up returns immediately, including after a temporarily unreadable or damaged snapshot is restored. Claims, scopes and owed mail in that source are permanently omitted from the new room while it reports migration complete. The registry's separate legacy-worker importer already fails closed and retries unreadable snapshots; local room migration does not.

**Probe:** corrupted one source, ran catch-up with the old relay absent, restored the exact valid bytes, and retried. The ledger remained `complete: true` and the source scope was still missing.

**Fix direction:** completion requires successful enumeration/read/decode of every final source and a persisted target. Keep failed sources pending with visible diagnostics and retry after repair; do not freeze an incomplete archive. Include read failures, not only target-save and ledger-rename failures, in the recovery tests.

### M8 — H1 idle-release epochs repeat after an MCP restart

**Locations:** `packages/room-mcp/src/presence-end.ts:109`, `:131`; `packages/room-mcp/src/worker-registry.ts:394`, `:436`. **Owner: names/presence.**

`PresenceEnd` starts its activity counter at 1 on every process start and emits `idle-N`. The durable H1 journal and notice ID use the stable host session ID plus that counter; neither includes a process incarnation. Restarting the MCP in the same host session and making the same number of Room/hook calls can reuse a completed idle epoch. At eight hours, reconcile sees the old `done` journal and skips the new claims/scope forever, so those holdings also prevent the idle presence lease from ending. R1b/D5/H1's bounded cleanup is lost.

**Probe:** released claims under `(same-host, idle-1, holder epoch 22)`, advanced the holder to 23 as on MCP replacement, added another claim, and invoked H1 with the restarted counter. Result: `released:false`, the new claim remained, and only the first notice existed.

**Fix direction:** make new idle episodes unique across process restarts (persisted monotonic counter or instance-qualified episode ID). Keep pending journals discoverable independently so restart replay still uses their original deterministic notice IDs. Test restart after a completed release as well as restart with a pending release.

## Should-fix

### S1 — One local room's completed migration disables every other room's migration

**Locations:** `packages/relay/src/local-migrate.ts:13`, `:59`, `:169`. **Owner: cutover.**

The relay supports explicit local room names and scans sources per requested room, but all rooms share `<common>/room/relay/migrated.json`, including a single `complete` bit and identity/source state. Migrating one room after the old relay exits therefore suppresses another room's import. Closing one also deletes the other room's migration ledger, allowing its already-imported/released IDs to be reconsidered later.

**Probe:** two source sets, `local/one/main` and `local/two/main`, in one common directory. Catch-up into one followed by two produced scope counts `1` and `0`; the second returned at the shared completed marker.

**Fix direction:** namespace migration ledgers and completion by canonical target room, or store independent per-room records in the common ledger. Forget only the requested room's import state. Cover separate explicit rooms, including close/reopen while another room remains active.

## Test-expectation audit

Inspected `git log -p` for `packages/*/test` in the range, with focused patch review of green4 (`30140be`), green4b (`993fee6`, `3d5f950`), fix4i (`ef41dc0`, `ee4ebec`), green5 (`608d3c1`), client5 (`826ef53`), fix5c (`e7c02b6`) and the lead fixture commits (`3f7842f`, `9a601ea`, `c06347e`, `7795936`).

- **Registry §6 row 12:** `3b1b6d2` did mask a regression by changing successful witnessed follow-ups to require a fresh done report, as the earlier re-review found. **Resolved at this endpoint:** `303192e` restores the earlier-done case, the negative no-earlier-report case, and follow-up log extraction. The current worker-status suite passes; this is not a new finding.
- **`decideLeave` / `decideShutdown`:** `608d3c1` and `7795936` distinguish an exited done worker from a still-running host with an early done report. The durable adapter supplies an exit code from the selected run's exit facts, while status row 8 still outranks an early done report for a verified live process. Letting a witnessed exited done worker leave despite a stale retained handle is justified. The updated table covers both cases. No masked regression established here.
- **Busy-worker shutdown expectation:** green5's unconditional `dismissed` expectation was subsequently corrected by `9a601ea` to account for whether the synthetic launcher's identity is verifiably alive. That matches rows 8/11, and the test also asserts no exit fact before the callback. Deterministic injected liveness would give stronger coverage than adapting the expectation to the machine, but this is not evidence of a production regression.
- **Tools shutdown:** `3f7842f` correctly changes shutdown expectations to retained scope/claims under §18. The later bridge-preservation fix is present. The same test still deliberately clears facts on fresh join; it does **not** establish that migrated, validated claims may be cleared. That untested distinction is M3.
- **Other in-scope migrations:** numeric epoch/lease fixtures, current-run completion IDs, retained prior history, schema-2 consent version, exact declared-sharing wording, repository room names, generation-2 paths, initialized-empty Yjs roots, and removal of `followBranch` expectations follow their binding contracts. The new migration tests cover the earlier successful retry/reclamation fixes but miss M5–M7 and S1's interleavings. No additional expectation change was shown to mask an unresolved in-scope regression.

## Verification and limits

- Disposable probes exercised the actual registry, resume orchestrator, join cleanup, local migration, identity watcher and H1 journal, with real temporary Git/worktree fixtures where required. **Nine probes reproduced the reported behaviors**, including S1. Process liveness was injected for the handoff case; this was not a live host kill/restart rehearsal.
- **19 focused offline suites passed, 230 tests:** worker status/state/registry, worker write-failure regressions, worker stream parsing, presence end, wave-4 names, publisher leases, session binding, PRs, consent, connection rejection, local migration/memory, and server migration/names/repo lock/document size/store. The nine disposable probes are additional to those 230 tests.
- The prior row-12, shutdown preservation, lease/publisher, server scope-copy, in-memory migration hydration, archive export, PR epoch-check and rebuilt-runtime fixes were traced in the current source. Both manifests and the marketplace entry say **0.17.0**; the committed bundle also contains 0.17.0 and generation-2 relay code. Old discovery-name references inspected are migration readers.
- Server admission/lock/freeze/export/token/410/4413 paths were reviewed statically and via available offline tests. No listening sockets, real 0.16/0.17 network cutover, hosted deployment or actual Claude/Codex feature experiment was attempted. The wave-4 rehearsal's simulated hosts and real-time results were treated as historical evidence, not rerun evidence.
- Test package aliases pointed to this pinned worktree, with at most two test workers. `nice -n 10` was attempted but rejected by the sandbox. Scratch probes, configurations and fixtures were removed; only this report remains.
- `room_preview_merge(people=["rohanz"])` reported **no conflicts** against common ancestor c449f3e. The preview combined review documents only; no combined-code test run was needed.
