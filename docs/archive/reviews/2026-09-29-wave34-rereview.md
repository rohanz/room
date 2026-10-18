# Wave 3–4 fix-round re-review — 2026-09-29

Reviewed `git diff e2aaf2d b040347` with this worktree pinned to **b040347b354274885873e805adea7d7c8f8ee8c9**. The wave-5 server merge (`994dc61`, `packages/server`) is excluded. Later source overlays are not part of this assessment. The lead’s newly appended **“Rerun on b040347”** rehearsal section was read through `room_read` after merge preview surfaced it; the lead confirmed it is supplemental input. Binding references are `redesign-plan.md` and the ledger, manifest, registry, reporooms and hub specs dated 2026-09-28.

**Original reviews: 23 RESOLVED, 11 PARTIAL, 0 NOT RESOLVED (34 items).** Including ten separately enumerated rehearsal observations below: **28 RESOLVED, 12 PARTIAL, 4 NOT RESOLVED (44 dispositions).** The rehearsal observations overlap the review findings; these totals are disposition counts, not distinct bug counts. **New: 2 must-fix, 4 should-fix**, including the rerun findings the lead requested as new items. Finding A is excluded by the lead’s explicit ruling that the local carried-base read is acceptable. Existing partial findings remain actionable at their original severity; they are not repeated as new findings.

This report is the only retained change. No source files were edited, committed or pushed.

## Validation and evidence

- Ran two focused Vitest batches with polling and at most two workers against this worktree's sources: 283 tests (272 passing initially) and 279 tests (265 passing). Four isolated hook tests then passed, including the two output assertions that failed after preceding socket failures. Across the 562 distinct checked-in tests: **539 passed, 21 blocked by prohibited socket listeners, 2 blocked by unavailable process-ancestry identity**. The latter are the SessionStart ancestor-chain assertions, not evidence of a production regression. No socket-only failure is counted as a finding.
- Covered conflict slots, bridge/projection, graph publication, worker recovery/retirement, lead routing, hook snapshots, epoch manifests, web reads/panels, Runner delivery, join/names, presence, preview, registry, resume, wake audit, nested lead and tools. Passing tests establish their asserted cases, not every lifecycle path described by the specs.
- Additional temporary probes used real production classes, in-memory hub transports and temporary Git repositories. They reproduced the remaining graph publication race, projection failure/retirement race, carried symlink disclosure, owner-side non-publisher omission, stale holder notice, retirement completion loss, no-path partial-ledger omission, unchanged contract-slot fence, publisher-withdrawal omission and both new findings. Supplemental probes also reproduced the carried-only possible conflict and addressed-holder relay, while an unchanged intent pair correctly skipped evaluation before its retry deadline. These probes were outside the repository; no source/test changes are retained. Probes asserting the observed broken behavior passing are reproduction evidence, not regression-test coverage.
- This reviewer attempted no live socket/host-model rehearsal, full build or deployment. The lead’s supplemental rehearsal independently reports four passing live scenarios and remaining findings C/D; those observations are attributed to that rehearsal, not this reviewer’s execution. Host rebinding is assessed from the production wiring and offline watcher tests, not an invented live Claude `/clear` run.

## Wave 3 dispositions

### M1 — Held source in the replicated graph — PARTIAL; owner: readers

**Fix/evidence:** `18bddd2` separates the local graph/cache from `publishedGraph`/`publishedCache` and derives public text through `versionOf`; it observes own publication-policy changes and withdraws narrowed content. `packages/room-mcp/test/graph-index-events.test.ts:34`, “keeps held own contracts out of the replicated graph and withdraws them when sharing narrows,” passed. The original stable hashless-held disclosure is closed.

**Remaining:** `packages/room-mcp/src/graph-index.ts:314` obtains authorized `publicText`, then awaits the base read before updating public facts. Its later publication check at `:438` compares generation, graph revisions and `ownPublicationKey`, but a holder-only transition is absent from that key and is not observed as a publication change. My probe replaced the holder epoch during the awaited base read without changing the head: the old writer still published the `secret_customer` signature detail. Revalidate the accepted source snapshot and current writing authority after the final await; observe holder changes as well as head-policy changes. This is the requested completion-check portion of M1, still missing.

### M2 — Projection completion checks — PARTIAL; owner: project

**Fix/evidence:** `18bddd2`, `packages/room-mcp/src/bridge.ts:277`, checks registry phase/ID, policy, lead base/fence and source snapshot after successful composition; sharing tools await projection refresh. `bridge.test.ts:225`, “M2 abandons a projection when the lead narrows sharing during composition,” passed.

**Remaining:** the `!facts` branch at `bridge.ts:275` skips those checks and continues to publish a starting head. In a probe, `composeFacts` retired the worker and then threw; `bridge.sync()` nevertheless recreated its projected manifest. Also, the second asynchronous boundary (`ignoredTrackedPaths`) checks source `semRev`, but does not repeat the complete source holder/fence validity test. Put one final, common validation immediately before publication, including failed composition and all exclusion reads. A failed Git operation must not bypass retirement or authority validation.

### M3 — Complete projection exclusions — PARTIAL; owner: project

**Fix/evidence:** `18bddd2` applies lead default ignores, `.roomignore`, Git ignores, per-file cap and budget across source and carried candidates. `bridge.test.ts:243` and `:254` (“M3 applies the lead ignore and size rules…” / “…Git ignore and total budget…”) passed.

**Remaining:** `packages/room-mcp/src/bridge.ts:302`, `:408`, `:502` never retain/check carried Git-tree mode. `blobsAt` discards it, so symlinks are treated as ordinary blobs. A real carried commit containing `link.py` (mode 120000, target `private-target`) projected a named `held:worker` entry with hash and size 14, rather than an exclusion digest. Preserve file shape/mode and apply the same shape exclusions as the lead's own publisher before emitting names/content facts. Size and ignore fixes alone do not satisfy the complete exclusion invariant.

### M4 — Fresh projected-worker text for conflicts — RESOLVED; owner: conflicts/project

**Fix/evidence:** `bb5bf60`, `packages/room-mcp/src/conflict-set.ts:200`, resolves an authorized projected owner's expected hash from its authoritative workers-room snapshot, then a validated local fallback, instead of requiring an already-stored Git blob. The conflict-set test “reads a fresh projected held worker edit from its workers room without a stored Git blob” passed with an actual `held:worker` team entry and fresh source overlay. It asserts the resulting conflict and worker notice. No remaining instance of the original fresh-blob failure was found.

### M5 — Holder notice destination and perspective — RESOLVED; owner: conflicts/project

**Fix/evidence:** `bb5bf60`, `conflict-set.ts:94`, provides separate owner and holder posters and renders the holder copy with the actual editing actor. The fresh projected-worker regression above and ConflictSlots routing/replay tests passed: worker notification goes to the workers room; the team claim holder's copy goes to the team room. M8 below concerns freshness during those posts, not the repaired destination.

### M6 — Exclusion falsely clears a conflict — RESOLVED; owner: conflicts

**Fix/evidence:** `bb5bf60`, `conflict-set.ts:295`, `:312`, treats failed enumeration as unknown and resolves both versions before certifying an existing path clean. The conflict-set exclusion regression passed: removing B's name and publishing its digest leaves `unknown` with prior settled conflict evidence, rather than a cleared-conflict notice. Failed enumeration also follows an explicit unknown branch.

### M7 — Non-publisher claims — PARTIAL; owner: conflicts

**Fix/evidence:** `bb5bf60`, `conflict-set.ts:256`, redirects the **other** participant's non-publisher snapshot to its publisher and evaluates claims before skipping its merge pair. The checked-in non-publisher regression passed for that orientation.

**Remaining:** the evaluator's **own** non-publisher still returns at `packages/room-mcp/src/conflict-set.ts:232` because `acceptedGit(owner)` is unavailable (correctly, non-publishers do not write Git records). In my reversed probe, B was the non-publisher, A its publisher, and both had overlapping claims; `ConflictSet(B)` created zero slots/notices. The corrected A-side evaluation does not supply B's owner-side claims notification. Resolve the owner's claim-mapping version through its publisher too; separate merge eligibility from claim evaluation on both sides.

### M8 — Conflict snapshot checks across awaits — PARTIAL; owner: conflicts

**Fix/evidence:** `bb5bf60` adds source/claim/graph guards, checks before settling and dropping slots, and retries a moved pass once. The regression that narrows B during `budget()` passed without committing the obsolete conflict.

**Remaining:** `packages/room-mcp/src/conflict-set.ts:94` posts the owner copy, awaits it, then posts the holder copy at `:111` without revalidating; replay at `:81` also lacks per-await validation. A probe removed B's claim inside the awaited owner post. B still received “A edited … inside your claim”; the next pass could not undo that delivered notice. Validate the captured evaluation and live lease before each recipient/replay post, not only before entering `ConflictSlots.settle`. The same boundary can cross a lease loss.

### M9 — Caller-coordinate hook claims — RESOLVED; owner: conflicts/wake

**Fix/evidence:** `bb5bf60`, `packages/room-mcp/src/hooks-bridge.ts`, resolves owner text/hash or base, maps into the caller's disk text, and produces an approximate whole-file warning when resolution is unavailable. The isolated hooks test “maps a foreign…” passed: B's line 1 maps to A's line 2 after an insertion, and unavailable text becomes approximate. The writer observes relevant document/awareness changes. This path is synchronous, so the original mapping is not separated from its write by an unguarded asynchronous read.

### M10 — Completion replay after outages — PARTIAL; owner: project

**Fix/evidence:** `18bddd2` adds projector replay; `993fee6` waits for terminal exit evidence. `worker-projector.test.ts:52`, `:67`, `:84` passed for an unposted witnessed failure, an unposted done report, and a successful post before retirement.

**Remaining:** `packages/room-mcp/src/worker-projector.ts:78` catches a failed completion post, but `:81` still retires the room and marks cleanup done. Subsequent `projectable(lead, room)` no longer selects that record. My retiring-worker probe failed the first post, ran two projector passes, and ended with room cleanup `done` and no `wk:<id>:1` message. Persist/drain pending completion independently of projection cleanup, or keep the cleanup pending until the required delivery is accepted. A comment promising “next pass retries” is false after the last room is cleaned. N1 is a separate resumed-status regression.

### M11 — Retired-owner conflict cleanup — RESOLVED; owner: project/conflicts

**Fix/evidence:** `bb5bf60`, `packages/shared/src/doc.ts:231`, removes owner conflict slots inside the worker-ID-checked retirement transaction. Shared retirement tests and projector retirement/tag-reuse tests passed, including preserving the newer worker incarnation. The old owner no longer leaves reusable settled slots behind.

### M12 — Accepted replicated worker views — RESOLVED; owner: project

**Fix/evidence:** `18bddd2` adds `acceptedWorkerViewOf`/`acceptedWorkerViews`, checking the lead's current non-ended holder epoch, and routes remote messaging/classification/listing through them while retaining the trusted local registry path. `packages/room-mcp/test/notices.test.ts`, the M12 stale-view regression, passed: an obsolete done view is stale/updating and cannot terminate a question/wait as authoritatively done. Shared/web consumer suites also passed.

### M13 — Lead reads its worker through the source room — RESOLVED; owner: readers/project

**Fix/evidence:** `18bddd2`, `packages/room-mcp/src/registry.ts:178`, prefers the registry-owned source session before team projection membership. `lead-bridge.test.ts:87`, “M13 reads and previews the owned local worktree after its team projection appears,” passed through actual lead tools: read returns the worker's local content and preview identifies the trusted local worktree. This exercises the capability routing, not just `Rooms.holding` in isolation.

### S1 — Unknown-conflict retry budget — RESOLVED; owner: conflicts

**Fix/evidence:** `bb5bf60` consults `retryAt` for unchanged unknown merge inputs and retains the projected reconciler/budget across passes. The conflict-set retry-deadline test passed: unrelated ticks do not repeat the expensive attempt; relevant input changes invalidate the delay. No remote fetch was required to establish that gate.

### S2 — Partial-preview ledger entry — PARTIAL; owner: readers

**Fix/evidence:** `18bddd2`, `packages/room-mcp/src/tools/files.ts:249`, posts a partial verdict with gaps, command and result on the main combined-tree path. `manifest-preview.test.ts:48`, “keeps a hashless held file out of the combined tree and records a partial passing run,” passed, including the partial ledger assertion and absence of a passing verification flag.

**Remaining:** the no-mergeable-path/no-command return at `files.ts:211` bypasses that post, as does the earlier unavailable/no-people exit. My actual tool probe with an intent-only peer returned a named PARTIAL explanation and left the ledger empty. Centralize partial recording for all partial outcomes; the checked-in no-path test at `manifest-preview.test.ts:70` checks reply gaps but misses this ledger requirement.

### S3 — Projection display heartbeat — RESOLVED; owner: project

**Fix/evidence:** `18bddd2`, `bridge.ts:328`, copies newer `at`/`scannedAt` on a semantic no-op while retaining `rev`/`semRev`. `bridge.test.ts:269`, “S3 refreshes at and scannedAt without changing semantic revisions,” passed for an at-only source change and another unchanged scan.

### S4 — Large-file claim approximation — RESOLVED; owner: conflicts

**Fix/evidence:** `bb5bf60`, `packages/shared/src/claims.ts`, marks the over-one-million-line-pair whole-file fallback approximate. The shared claims-across-bases and conflict-set large-file regressions passed: the 1,001-line/inserted-line case is approximate and its conservative overlap produces possible rather than certified conflict.

## Wave 4 dispositions

### M1 — Epoch-fenced conflict writer — PARTIAL; owner: integration

**Fix/evidence:** `ef41dc0` obtains the current numeric owner/projector epoch, requires the local lease, and rechecks authority. `conflict-set.test.ts:133`, “writes the current owner epoch into slots and stops while its local lease is paused,” passed using distinct epochs 101/102 and an invalid local grant.

**Remaining:** `packages/room-mcp/src/conflict-set.ts:63` and `:64` return an unchanged prior slot without comparing its `fence`. Contract input identity does not include the owner epoch. My probe created a contract conflict at A epoch 1, moved A to epoch 2 with a new valid head and increased `semRev`, then reconciled the unchanged contract: the slot still carried fence `1`. Refresh/re-fence an unchanged slot under a new valid incarnation, while preserving conflict semantic epoch/deduplicated notice identity as appropriate. Also close the per-post lease race described in W3-M8. A new numeric slot test alone does not cover re-entry with existing slots.

### M2 — Publisher detach and terminal-name recovery — PARTIAL; owner: names

**Fix/evidence:** `ef49eb6`/`e509387` wire lease changes to publisher detachment and let a terminally lost same-room session rejoin instead of returning through the healthy fast path. `wave4-names.test.ts:22`, “M2 detaches a lapsed name holder so another live session can publish the checkout,” and the join regressions passed: B takes publication from lapsed A.

**Remaining:** detachment does not perform the required withdrawal. The callback changes publisher policy after `lease.fence()` has disappeared; `packages/roomd/src/publisher.ts:80` then returns from `applyInputs`, leaving A's old manifest/overlay in the live document. I repeated the two-production-helper in-memory-hub case with dirty shared text: after A became `publisher:false` and B became `publisher:true`, A still had complete/all coverage and the old text overlay. Registry §16 requires withdraw-before-detach; §18's ordinary offline-preservation rule does not authorize duplicate publication through this successor handoff. Arrange a fenced withdrawal/transition that cannot delete a successor's facts. This is live-key cleanup, not historical CRDT erasure.

### M3 — Old-incarnation overlays — RESOLVED; owner: names

**Fix/evidence:** `ef49eb6`, `packages/roomd/src/manifest-publish.ts:79`, independently removes older numeric owned overlay incarnations as well as older manifests, retaining newer/successor epochs. `packages/roomd/test/wave4-names.test.ts:5`, “M3 removes older owned overlay incarnations when publishing a new grant,” passed. The remaining current-incarnation withdrawal failure is W4-M2, not a failure of this older-incarnation cleanup.

### M4 — Production pushed acknowledgement — RESOLVED; owner: integration

**Fix/evidence:** `ef41dc0`, `packages/room-mcp/src/session.ts:579`, returns the post promise/result to the daemon. `auto-tag.test.ts:39`, “production join passes hub pushed acceptance back to the daemon,” passed through a real join helper/in-memory hub: the accepted range clears its durable pending marker and appears once in the bus. This is stronger than a directly injected daemon-only callback test.

### M5 — H1 epoch authorization — RESOLVED; owner: integration

**Fix/evidence:** `ef41dc0` captures the live lease fence in `releaseIdleHeld` and repeats session/epoch/local-ownership checks in the registry guard before mutation/replay. `presence-end.test.ts:30`, “H1 refuses a lapsed or old epoch of the same host session,” passed. The old same-session incarnation can no longer clear the successor's claims by matching only a session ID.

### M6 — H1 acceptance and journal replay — PARTIAL; owner: names

**Fix/evidence:** `ef49eb6` awaits the post result, leaves the journal pending on rejection, and can replay matching older idle-epoch records. `wave4-names.test.ts:40` and `:60` passed: rejected notice retries with the same ID; a paused lease cannot let the idle leave complete while that invoked reconciliation is pending.

**Remaining (static production trace):** pending replay is only invoked through `PresenceEnd.run`, `packages/room-mcp/src/presence-end.ts:156`, after the *current process's* fresh eight-hour idle interval. Construction resets `last`; the only production caller of `releaseIdleHeld` is `index.ts:124`. If the process dies after removals but before notice acceptance, its replacement has no held claims, no startup/reconnect journal drain, and leaves at 30 minutes without ever invoking replay. A new activity epoch after an outage can similarly postpone it. Schedule pending-journal recovery separately from eligibility to create a new H1 release; do not require eight more idle hours. Directly calling the registry twice in a test does not establish restart scheduling.

### M7 — All joined rooms in presence decisions — RESOLVED; owner: names

**Fix/evidence:** `ef49eb6` inventories all joined sessions, uses registry `projectable(...).write` for unfinished workers, publishes idle across them and drops every joined session. The no-primary shutdown path also closes the workers room. `wave4-names.test.ts:91` and `:101` passed for secondary-room holdings/durable workers and termination across two joined sessions. W4-M8 separately covers preservation during that teardown.

### M8 — Preserve offline coordination on host end — PARTIAL; owner: names

**Fix/evidence:** `ef49eb6` removes ordinary own-fact cleanup from host shutdown and passes `preserveFacts` when closing the workers room. `wave4-names.test.ts:101` and the updated `tools.test.ts` shutdown regression passed for ordinary own scopes/claims. The lead's `3f7842f` expectation change is spec-correct; see the audit below.

**Remaining (static call chain, confirmed stop behavior):** `tools/state.ts:187` calls `closeWorkersRoom(true)`; removing the session stops its attachment (`tools/state.ts:64`), which unconditionally calls `Bridge.stop()`. `packages/room-mcp/src/bridge.ts:149` then removes mirrored claims and deletes `coordination[lead]`. The existing `bridge.test.ts:212`, “stop() removes the mirrored claims and stops relaying,” passes and demonstrates the destructive behavior; the two-plain-session preservation fixture does not install this bridge. Split stopping observers/transports from explicit release, and preserve mirrored worker claims/coordination on host termination as well as the lead's direct facts. Registry §18's “ending presence deletes nothing” applies here too.

### M9 — roomagent delivery authority — RESOLVED; owner: resume

**Fix/evidence:** `ef41dc0` gives Runner a live authority gate, acquires before selection/delivery, and validates the same epoch in delayed acceptance/output callbacks; CLI presence carries the matching session identity. `packages/agent/test/runner.test.ts:32` and `:50` passed for denied authority and a delayed acceptance after lapse. Existing turn-start acceptance/rejection tests also passed. No message is receipted merely because a backend was asked to run.

### M10 — Committed overlap in default preview — RESOLVED; owner: near

**Fix/evidence:** `ef41dc0`, `tools/files.ts`, includes `merge-base..base` changed paths in the default neighbour decision and names unavailable enumeration as a gap rather than silently treating it as empty; required running-worker inclusion remains. `manifest-preview.test.ts:83`, “default preview includes a present neighbour whose only overlapping change is committed,” passed with real Git commits and empty dirty manifests.

### M11 — Fresh web presence on async completion — RESOLVED; owner: web

**Fix/evidence:** `ef41dc0` changes the browser reader to a participant-view getter, called again for validation/retry; production panels supply that getter. `packages/web/src/manifest-reader.test.ts` passed the regression that moves the lead holder during the awaited digest. The obsolete projected text is rejected rather than accepted against the captured old view. Panels tests passed too.

### M12 — Safe paused hook state — RESOLVED; owner: names

**Fix/evidence:** `ef49eb6` writes a minimal paused health snapshot on lease loss and uses local writer ownership to avoid overwriting a successor endpoint. `wave4-names.test.ts:73` and the isolated hooks tests passed, including the hook's visible paused explanation. No stale coordination/receipt payload is newly written by this paused path.

### M13 — Host-session rebind transition — RESOLVED; owner: names

**Fix/evidence:** `ef49eb6`/`e509387` detect a changed bound identity, gate the old session through `hostCurrent`, notify the tool-state lifecycle and rejoin the joined rooms with the new identity. Arbitration/handoff is paused during rebinding and delayed confirmations must still match. `runtime-presence.test.ts:100`, “M13 pauses the old grant and reports a same-chain host session rebind,” passed. Inspection of the callback through `index.ts`/state/session closes the previously absent transition. The test mocks daemon/transport boundaries; this disposition does not claim a live host `/clear` rehearsal.

### M14 — Non-publisher common/web reads — RESOLVED; owner: integration

**Fix/evidence:** `ef41dc0` validates holder/head authority, then handles `none/not-publisher` before requiring publisher-only Git coherence. Shared manifest and web reader/panel non-publisher regressions passed without inserting a forbidden Git record. The common answer identifies the publisher. This reader repair is separate from W3-M7's owner-side conflict evaluator early return.

### S1 — Epoch-correct fixtures — RESOLVED; owner: integration

**Fix/evidence:** `30140be`, `993fee6`, `3d5f950`, `ef41dc0`, `ee4ebec` and `3f7842f` migrate the affected fixtures to numeric holder epochs, live local leases and current session/provider shapes. Conflict-set, shared manifest and web reader/panel suites now pass. The epoch writer test rejects an invalid lease, and the auto-tag production-helper test obtains a real in-memory-hub grant; validity is not established solely by fixture assertions. No production reader check was weakened to accept the old session-string publication shape.

### S2 — Exposed unknown-holder takeover — RESOLVED; owner: names

**Fix/evidence:** `ef49eb6` wires the boolean through the tool schema/handler and public join options. `join.test.ts:146` passed the end-to-end argument routing; the offline `names.test.ts:58` case passed, allowing an unknown holder only with `takeover:true` and refusing a known-live holder. Socket arbitration cases remain environment-blocked, not counted as passing.

### S3 — Bound hook contact resets idle — RESOLVED; owner: names

**Fix/evidence:** `ef49eb6` routes successful arbitration contact and newly observed bound hook activity into the monotonic presence tracker. `runtime-presence.test.ts:80`, “S3 counts only a bound hook contact as monotonic presence activity,” passed; passive polling and foreign-session activity do not reset it. Socket-based live arbitration was unavailable, so the positive evidence is the offline callback/watcher path plus production wiring.

## Rehearsal “Other findings” cross-check

The original observations and the lead's supplemental b040347 rerun are covered together. **Finding A is omitted from the counts:** the lead explicitly ruled that reading the carried base through a worker in the same local clone is acceptable. No source change is claimed for it.

- **R1 — Missing production holder and awareness session ID — RESOLVED.** Wave-4 names (`422efce`, subsequently fixed by `ef41dc0`/`ef49eb6`) routes local/team joins through `startAutoTaggedRoomd`, publishes the real hub epoch and matching presence identity. The passing auto-tag production-helper test and W4-M1/M4 evidence exercise the in-memory-hub path. The lead's rerun additionally reports matching production holders/presence in all four real scenarios with no emulated holders.
- **R2 — Finding B: noncanonical registry path rejects a worker — RESOLVED.** `18bddd2`, `packages/room-mcp/src/worker-registry.ts:105`, compares canonical registry roots. `worker-registry.test.ts:19`, “admits a worker when ROOM_REGISTRY uses a symlink to the same registry root,” passed with a real symlink. The lead's rerun independently confirms successful admission from both lexical paths.
- **R3 — Possible-conflict text blames the readable side — RESOLVED.** `bb5bf60` records which side is held and renders that reason, instead of always blaming `slot.other`. The conflict-set held-owner regression passed; the rerun reports both orientations now naming ann, the held side.
- **R4 — Possible notice is labelled CONFLICT — RESOLVED for the initial notice.** `bb5bf60`, `packages/shared/src/messages.ts:35`, renders possible merge notices distinctly at fyi. Shared message tests passed, and the lead's rerun confirms “POSSIBLE conflict.” The separate clearing transition is R7/N4.
- **R5 — Empty constructor-captured slot fence — PARTIAL.** `ef41dc0` removes the fixed constructor fence; the fresh numeric-slot regression and live rerun show populated epochs. Existing slots can nevertheless retain an obsolete epoch on unchanged evaluations (W4-M1, independently probed with a valid changed head).
- **R6 — Finding C: the lead's carried edit counts as the worker's independent conflict — NOT RESOLVED; owner: conflicts (N3).** The rerun reports a possible README conflict even though W has made no independent README edit. I reproduced this with real B/C commits, a held lead entry and W's empty dirty manifest plus carried-baseline adapter: the production evaluator settles `possible`. The passing carried-contract test addresses only contracts, not this merge-candidate branch.
- **R7 — Finding C: clearing a possible slot says CONFLICT cleared — NOT RESOLVED; owner: conflicts/messages (N4).** The rerun supplies the live transition. The new `conflictLabel` explicitly chooses “CONFLICT cleared” for every fyi text ending in “cleared”; the posted message carries no prior settled severity. The passing initial-possible formatting test does not exercise clearing a never-certified slot.
- **R8 — Finding D: the holder's addressed notice is relayed back to W — NOT RESOLVED; owner: project/conflicts (N5).** The rerun reports the worker's correct direct interrupt plus a second interrupt containing the holder's “inside your claim” copy. My in-memory bridge probe confirms a conflict addressed to Kieran is relayed to a scoped W with interrupt priority. Existing relay tests cover path matching and broadcast deduplication, not this addressed-holder case.
- **R9 — A running projected worker is labelled offline — NOT RESOLVED; owner: readers/project (N6).** The rerun reports “offline … running” for a valid projection. Static inspection confirms `personLine` infers offline from absent room-local awareness, although projected workers intentionally have none. No passing test establishes the correct combined projected/runtime display.
- **R10 — Intent observer has an unknown slot and is visited on each periodic tick — RESOLVED for the backoff requirement; owner: conflicts.** An incomplete/intent side requires an unknown slot under reporooms §B5, and a periodic reconciliation callback does not prove repeated expensive evaluation. `bb5bf60` records `retrySource`/`retryAt` and gates the pair before contracts/Git comparison. Beyond the checked-in deadline test, my spy on the actual contract stage shows one call across two reconciliations before the deadline, with unchanged intent inputs. I could not reproduce a backoff violation. New input revisions legitimately trigger another pass.

The two remaining copy observations are acknowledged but excluded from defect counts/new issues under the task's **no style nits** rule: the default preview correctly excludes non-overlapping ann while saying “no present participants,” and an owner-facing possible notice names ann in the third person. Neither changes inclusion, severity, routing or verification. The misleading certified-clear label and projected offline status above are semantic state claims and are included.

## Audit of changed test expectations

1. **green4 (`30140be`): valid setup, not a general permission to change expected behavior.** Numeric holders, matching presence IDs, provider/session/daemon stubs, `myWorkers`, and the settling required by asynchronous policy application model the new production contracts. `applySessionPolicy` is a real integration repair, not only a fixture edit. Local-room links conditional on neighbourhood state and compact worker lines follow the new view contract. In wake audit, changing seen=true to seen=false when a mocked launch never produces host acceptance is correct under ledger R2/D4; prompt IDs must be handed over, but launch alone cannot receipt them. The corresponding offline tests passed; socket-dependent ones were not represented as verified.
2. **green4b (`993fee6`, `3d5f950`): terminality, valid source inputs and retained history are correct.** Adding an exit fact to a completion-replay fixture matches registry §6 row 8/§7: a still-running host with an early done report is not yet projector-terminal. The production replay change enforces that. Supplying current holder/provider state, exact claim owner text and `scannedAt` rather than an obsolete overlay timestamp makes the fixture assert the real mapping/health boundary. Nested lead/projected-reader fixtures need the registry/source room and valid fences. Resume tests must distinguish the current run's completion ID from legitimate previous done history; comparing cancellation counts to the prior ledger length rather than zero is correct. An optional inbox prefix does not weaken the assertions against launches or bus writes. These changes do not cover the retirement-outage hole in W3-M10. Server token-access changes in the same commit are outside this review.
3. **fix4i (`ef41dc0`, `ee4ebec`): authority and live getter fixtures are necessary.** `epochPublication`, local `lease.fence`, Runner's authority stub and web `() => currentViews` match required production interfaces. They are supported by negative tests (wrong/lapsed lease, delayed acceptance, holder change during digest), so they do not simply grant everything and erase the new checks. The existing-slot transition missing from that suite is W4-M1.
4. **Lead `3f7842f`, tools shutdown: spec-correct expectation.** Registry §18 explicitly preserves claims/scope when the host session ends. Changing `tools.test.ts` from expecting deletion to expecting retention follows the production shutdown change in `ef49eb6`; it does not mask a requirement to delete those facts. Explicit `room_leave`/`room_done` and journaled H1 release remain separate operations. However, this test uses ordinary own facts and misses the bridged mirrored-claim deletion in W4-M8. Adding the lease `check` stub is likewise a fixture-interface repair.
5. **The unacceptable expectation change is `3b1b6d2`, worker status (N1).** This commit lies inside the requested diff although it precedes the named follow-up fix branches. It removes registry §6 row 12 and rewrites `worker-status.test.ts:71` to require a fresh done report for a witnessed successful follow-up. I asked the lead about the apparent plan/spec ambiguity. The lead confirmed that row 12 binds; “clean exit without a report is not done” means no earlier done report. This change masks a production regression rather than repairing a stale fixture.

## New must-fix issues

- **N1 — A successful resumed turn becomes failed despite the earlier done report. Owner: resume.**
  **Locations:** `packages/room-mcp/src/worker-status.ts:94`; `packages/room-mcp/test/worker-status.test.ts:71`; downstream completion replay in `packages/room-mcp/src/worker-projector.ts:70`.
  **Introduced by:** `3b1b6d2` in the requested range; unchanged by the fix rounds.
  **Scenario/evidence:** run 1 has a valid done report; run 2 is a launched resume with a witnessed exit 0 and no new `room_done`. The original registry §6 row 12 says done, carrying `followUpAnswer`. The deleted branch now falls through to failed/“exited without room_done.” A temporary registry/projector probe reproduced failed status and a failure completion instead of the prior task's successful follow-up semantics. The rewritten checked-in expectation would approve this regression. The spec explicitly says rows 12/15 preserve 0.16.31, and the lead confirmed that interpretation during this review.
  **Fix direction:** restore the earlier-done + witnessed-clean-resume row; preserve the no-earlier-report failure row. Keep prompt acceptance/receipts independent of completion status. Restore a positive status test and test deterministic successful follow-up completion recovery as well as the negative fresh-run case.

- **N2 — Paused projection is interpreted as an empty authoritative worker set. Owner: project/integration.**
  **Locations:** `packages/room-mcp/src/worker-projector.ts:29`; `packages/room-mcp/src/bridge.ts:220` (the `projectOnce` cleanup immediately after `projectWorkers`).
  **Introduced by:** `3b1b6d2`'s no-fence early return, combined with the existing bridge cleanup contract; still present after `18bddd2` and the integration fixes.
  **Scenario/evidence:** a team lead has an existing worker projection, then loses its local name lease. `projectWorkers` returns `[]` to mean “paused; cannot write.” `Bridge.projectOnce` treats that as “no workers remain,” computes an empty keep-set and deletes the projected participant/head/manifests. In a probe, one normal sync produced a valid projection; setting the lead daemon fence unavailable and syncing again deleted its head. This is a document mutation by a paused writer, violates hub §7 and the stale-offline-facts model, and can erase facts a new holder should reconcile. It is distinct from W3-M2's in-flight per-worker resurrection.
  **Fix direction:** distinguish “not authorized/no pass” from an authoritative empty set. Gate the entire bridge projection/cleanup pass on the current local lease and repeat the authority check after awaits before deletion or publication. Add a regression asserting that pause leaves existing facts untouched and that a later authorized retirement still removes them.

## New should-fix issues

These include the supplemental rerun findings the lead specifically asked to list as new. N3/N6 are newly reported remaining interactions; this review does not claim a fix commit originally introduced their underlying branches.

- **N3 — Carried-only changes produce a false independent-overlap warning. Owner: conflicts.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:291`, `:320`; compare the carried-baseline exception only in `:352`.
  **Scenario/evidence:** the worker's base C includes the lead's held README edit. W makes no further README change. The merge candidate set counts B..C as W's change and reports “lead changed README too” merely because the lead still holds the same carried work. Both the lead's rerun (finding C) and my real-Git ConflictSet probe reproduce it. This newly reported merge interaction survives the fixes; the contract-baseline test does not cover it.
  **Fix direction:** when comparing a trusted worker with its own lead, apply the carried starting-tree relationship to merge candidates/evaluation as the preview does. Do not infer independent worker edits from the carried B..C delta alone; preserve warnings for genuine post-spawn edits. Add carried-only, worker-modified and lead-reverted cases.

- **N4 — Clearing a possible conflict falsely implies there was a certified conflict. Owner: conflicts/messages.**
  **Locations:** `packages/shared/src/messages.ts:35`; `packages/room-mcp/src/conflict-set.ts:95`.
  **Introduced/exposed by:** `bb5bf60`'s new formatter distinguishes initial possible notices but its clearing branch loses that distinction.
  **Scenario/evidence:** a hashless-held slot is only ever possible; when a later readable evaluation is clean, its fyi notice renders “CONFLICT cleared.” The lead's rerun reproduces the transition. The formatter checks a text suffix rather than the previous settled state, so existing passing initial-format tests miss it.
  **Fix direction:** carry structured previous severity/resolution information or use a neutral cleared-possibility label that cannot assert prior certification. Test possible→clean separately from conflict→clean. This is a misleading state claim, not a capitalization nit.

- **N5 — A correctly routed holder notice becomes a second, misaddressed worker interrupt. Owner: project/conflicts.**
  **Locations:** `packages/room-mcp/src/bridge.ts:468`, `:479`, `:493`; holder emission in `conflict-set.ts:111`.
  **Introduced/exposed by:** `bb5bf60` correctly moves the holder copy to the team room, where the existing path-based bridge now relays it back down without considering its addressee.
  **Scenario/evidence:** W edits inside Kieran's claim. W gets its direct deterministic conflict interrupt, then another interrupt saying “W edited … inside your claim” although W is not that holder. The lead's rerun and my in-memory bridge probe both reproduce this. Broadcast relay tests do not cover directed conflict copies.
  **Fix direction:** distinguish deterministic owner/holder notices and honor their intended delivery route. Do not relay the holder-only copy to the already-notified owner or unrelated workers; preserve genuinely relevant team broadcasts. Add an integrated projection/bridge test asserting one W interrupt and one Kieran team notice with correct perspectives.

- **N6 — Projected worker presence is confused with runtime status. Owner: readers/project.**
  **Locations:** `packages/shared/src/views.ts:313`, `:321`; projected participant rendering in `packages/room-mcp/src/tools/scope.ts`.
  **Scenario/evidence:** W is running in its workers room and has a valid accepted team projection. W intentionally publishes no team-room awareness, so `personLine` says offline while the appended accepted worker view says running. The lead's b040347 rerun records exactly this line. The current per-reader tests do not assert this combined status.
  **Fix direction:** give projected workers an explicit projected/via-lead presence description and use the accepted worker view for runtime state; do not present absence of direct team awareness as worker death. Retain stale/updating when the projector fence is invalid. Test fresh projection/running, stale projector and actually ended worker separately.

Socket and process-inspection restrictions are validation limitations, not new defects.
