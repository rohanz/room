# Cleanliness audit of 0.16.8, by Codex (gpt-6-astra, medium), 2026-09-26

Reviewed `bd656d6..27b058a`, covering the scoped package and hook changes, release notes, previous audit findings, roadmap, and local host-documentation snapshots.

**7 findings: 5 Fix now, 2 Tidy, 0 Leave.** The main remaining risk is discard treating lost process verification as proof that stopping succeeded.

Verification: the eight-file focused Vitest run failed before executing tests because Vite could not create its temporary `ssr` directory (`EPERM`). Five targeted in-memory probes exercised the findings below using source imports, synthetic process probes, and read-only Git commands. No edits, builds, commits, network access, or access to `~/.claude` or `~/.codex`. Git status remained clean.

## Fix now

### 1. Discard can forget a worker whose process became unverifiable — FIXED in 0.16.9

**Severity: P1 — correctness and work preservation.**

**Locations:** [collect.ts:177](/private/tmp/room-audit2/packages/room-mcp/src/tools/collect.ts:177), [collect.ts:186](/private/tmp/room-audit2/packages/room-mcp/src/tools/collect.ts:186), [collect.ts:218](/private/tmp/room-audit2/packages/room-mcp/src/tools/collect.ts:218), [workers.ts:239](/private/tmp/room-audit2/packages/room-mcp/src/tools/workers.ts:239).

**Problem:** Discard checks unverifiable liveness initially, but does not repeat that check after dismissal and exit waiting. Its dismissal-failure guard applies only to records still marked `running`. For a `done` worker, ownership becoming `unknown` makes `workerAlive()` false; discard then proceeds to cleanup and retirement.

**Consequence:** A live worker loses its record and coordination state, and the reply can falsely say “stopped.” For an owned checkout, the same path also reaches destructive cleanup without confirming the host stopped.

**Smallest clean change:** Repeat `unverifiedLive()` after dismissal/waiting and before cleanup or retirement, regardless of recorded status. Add an `ours → unknown` regression for a finished worker.

**Reproduced:** Using the actual discard and dismissal implementations with an injected changing probe, dismissal posted “left running, not stopped,” while discard returned “stopped w” and retired the record. Checkout deletion was not exercised.

### 2. Resumed follow-ups use prompt delivery and a receipted timeline copy — FIXED in 0.16.9

**Severity: P2 — duplicate instructions.**

**Locations:** [messaging.ts:121](/private/tmp/room-audit2/packages/room-mcp/src/tools/messaging.ts:121), [messaging.ts:142](/private/tmp/room-audit2/packages/room-mcp/src/tools/messaging.ts:142), [worker-launch.ts:62](/private/tmp/room-audit2/packages/room-mcp/src/worker-launch.ts:62), [resume.test.ts:216](/private/tmp/room-audit2/packages/room-mcp/test/resume.test.ts:216).

**Problem:** The follow-up text becomes the resumed host’s prompt and is subsequently posted as an unread addressed bus message. Nothing receipts the bus copy as already delivered through the prompt. The regression checks one bus entry, which does not detect this second delivery channel. This existing duplication survives the refactor.

**Consequence:** The resumed agent can receive the same instruction again through its inbox, potentially repeating work or interpreting it as another request.

**Fix:** Carry the follow-up text in the resume prompt. After a successful launch, post the bus copy for the timeline and record the resumed worker's per-name seen receipt in the same transaction, before any inbox or wake observer can handle it. A failed launch posts nothing. Regression tests cover the prompt, worker tools, hook snapshot and wake, lead timeline, and launch failure.

**Reproduced:** A handler probe captured the follow-up as the resume argument and found identical text in an unreceipted bus message. Duplicate action by a live host remains inferred.

### 3. Losing process verification during resume can monopolize the event loop — FIXED in 0.16.9

**Severity: P2 — responsiveness and cancellation.**

**Locations:** [registry.ts:306](/private/tmp/room-audit2/packages/room-mcp/src/registry.ts:306), [registry.ts:329](/private/tmp/room-audit2/packages/room-mcp/src/registry.ts:329).

**Problem:** `waitForPreviousExit()` continues waiting for `unknown`, but its inner shortcut immediately resolves whenever `pidIsOurWorker()` is false. An unknown process therefore repeatedly cancels the polling timer and resumes through microtasks.

**Consequence:** If an initially verified process becomes unreadable, the nominal 30-second wait can repeatedly probe without servicing timers or ordinary I/O. Cancellation arriving through those channels is delayed too.

**Smallest clean change:** End the wait explicitly on `unknown` and report failed verification, or retain the polling delay. Only confirmed absence should take the immediate exit shortcut.

**Reproduced:** With an always-unknown injected probe and a 40-ms deadline, the helper made 35,860 probes; a previously scheduled zero-delay timer did not run during the wait.

### 4. Preview with a test command rejects shared workers with locally existing directories — FIXED in 0.16.9

**Severity: P2 — functional regression.**

**Locations:** [combined-tree.ts:22](/private/tmp/room-audit2/packages/room-mcp/src/tools/combined-tree.ts:22), [combined-tree.ts:35](/private/tmp/room-audit2/packages/room-mcp/src/tools/combined-tree.ts:35), [files.ts:173](/private/tmp/room-audit2/packages/room-mcp/src/tools/files.ts:173).

**Problem:** The combined-tree builder captures roots only for eligible disk participants. The later mode-selection pass independently treats every worker with an existing directory as disk-eligible, then requires its root to have been captured. A worker represented through shared overlays in a team session fails that lookup.

**Consequence:** `room_preview_merge(..., run=...)` throws `uncaptured preview root` before running the command, although the shared content was successfully combined.

**Smallest clean change:** Reuse the builder’s selected disk participants for mode collection. An overlay-only participant should not acquire a disk requirement in the second pass.

**Reproduced:** An in-memory team-session fixture with a shared worker overlay and an existing local directory reached the exact exception. No test command or scratch-tree creation occurred.

### 5. Spawn and resume still disagree about occupied worker slots — FIXED in 0.16.9

**Severity: P2 — resource-limit correctness.**

**Locations:** [workers.ts:257](/private/tmp/room-audit2/packages/room-mcp/src/tools/workers.ts:257), [registry.ts:284](/private/tmp/room-audit2/packages/room-mcp/src/registry.ts:284), [registry.ts:389](/private/tmp/room-audit2/packages/room-mcp/src/registry.ts:389).

**Problem:** Fresh spawn counts live recorded PIDs, including unverifiable finished workers. Resume’s separate `runningWorkerCount()` counts only running records, handles, or positively verified ownership.

**Consequence:** Resume can admit another worker beyond `ROOM_MAX_WORKERS` while an unverifiable finished worker remains alive. Fresh spawn would refuse under the same circumstances.

**Smallest clean change:** Use one occupied-slot predicate or candidate list for both launch paths, treating unknown live workers consistently.

**Reproduced:** For one finished worker with a live-but-unreadable probe, real state reported `unknown`, leave decided `stop`, and resume capacity counted **zero**.

## Tidy

### 6. Collection retains a duplicate Git-directory resolver — FIXED in 0.16.9

**Severity: P3 — incomplete unification.**

**Locations:** [collect.ts:278](/private/tmp/room-audit2/packages/room-mcp/src/tools/collect.ts:278), [git-dirs.ts:47](/private/tmp/room-audit2/packages/roomd/src/git-dirs.ts:47).

**Problem:** Collection still defines its own `rev-parse --git-common-dir → path.resolve → realpathSync` helper. That is precisely the policy implemented by `realGitCommonDir()`.

**Consequence:** Future resolution or error-policy changes can leave collection disagreeing with worker ownership and worktree reuse.

**Smallest clean change:** Import `realGitCommonDir()` and remove the local helper.

**Inferred:** Confirmed duplicate implementations by source inspection; no current behavioral difference demonstrated.

### 7. The resumed-start regression does not assert the promised behavior — FIXED in 0.16.9

**Severity: P3 — ineffective and host-dependent test.**

**Locations:** [resume.test.ts:219](/private/tmp/room-audit2/packages/room-mcp/test/resume.test.ts:219), [resume.test.ts:236](/private/tmp/room-audit2/packages/room-mcp/test/resume.test.ts:236), [resume.test.ts:211](/private/tmp/room-audit2/packages/room-mcp/test/resume.test.ts:211).

**Problem:** The test titled “records the resumed process start after a ten-second previous-exit wait” never asserts `startedAt`. Its identity assertion feeds `resumed.processStartTime` back into the probe and compares the result with that same field’s presence. Both a missing identity and any matching nonempty identity pass. This fixture also omits the injected process probe and uses the runner’s real PID. The neighboring slow-exit test waits 5.2 real seconds under an eight-second deadline.

**Consequence:** Incorrect timestamp recording or omitted identity capture can pass the purported regression; OS inspection and wall-clock scheduling add avoidable variability.

**Smallest clean change:** Inject a fixed process identity, assert its exact persisted value, and assert `startedAt` equals the advanced launch-time clock. Drive exit and timeout behavior with controlled callbacks/fake timers.

**Inferred:** Established from the assertions and fixture wiring; Vitest execution was blocked as noted above.

## Leave

No additional leave-category findings. No new actionable defect was established in `coordinationPaths`, daemon base-notice receipts, or graph generation readiness. Their integration tests remain unverified in this sandbox.
