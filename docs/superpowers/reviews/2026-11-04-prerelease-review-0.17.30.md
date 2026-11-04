# Prerelease review: 0.17.30 — 2026-11-04

Reviewed candidate `30ba09c882` against `v0.17.29`: five commits, 96 files, +4252/-1312. **No blocker identified; four should-fix-before-release findings and two later items. Six of the eleven Unreleased changes are judged sound at source-review depth.** This is not a runtime certification or evidence that every new regression test fails on the old tag.

Read `CLAUDE.md`, the Unreleased notes and all three motivating cleanliness reviews, plus relevant README/reference, roadmap/decision context, source changes, changed tests and callers. Generated bundle changes were checked against relevant source implementations and inventoried; I did not rebuild or certify byte-for-byte asset freshness. No tests, benchmarks, fault injections or host experiments were run. `nice -n 10 npm run typecheck` passed, exit 0, with no TypeScript diagnostics; the sandbox refused the priority adjustment (`setpriority: Operation not permitted`). Only this report is an intended repository change. Nothing was committed or pushed.

## Should fix before release

### S1. The checkout gate removes legitimate non-publisher claim checks

**Locations:** `packages/room-mcp/src/tools/state.ts:61`, `packages/room-mcp/src/conflict-set.ts:716`, `packages/room-mcp/src/conflict-set.ts:1090`.

The gate now prevents the entire primary `ConflictSet` from starting for a session that does not hold the publisher lease. That checker was not exclusively duplicate checkout work: its existing `ownNonPublisher` branch borrows the publisher's snapshot, checks the non-publisher's claims, and deliberately skips merge-pair checking. `claims()` selects own claims by `this.owner`; the publisher's checker does not assume ownership of every other session's claim pairs.

Concrete missing case: one publishing session and two other live sessions in the same checkout; the latter two claim overlapping ranges while the publisher has no claim there. Both non-publisher checkers are now absent, and the publisher does not compare those two claim sets as an owner. Those agents lose their claim-conflict notices. This contradicts the reference's retained promise that explicit claims coordinate separate agents in a shared checkout. The lead confirmed this loss was unintended in answer `m_mw270puqvcdtx7`.

**Smallest fix:** retain each live primary session's lightweight non-publisher reconciliation; gate only the expensive publisher work, keeping existing lease/fence checks. Keep graph deduplication separate. Add a three-session regression proving overlapping claims between the two non-publishers are reported, plus takeover/stale-name coverage. `checkout-lead.test.ts` currently asserts the missing checker is absent and tests takeover, not preservation of these claim semantics.

The second session also intentionally loses `room_impact` (`tools/files.ts:220`) rather than querying another process's graph. That loss is explicitly diagnosed and tested; it is not evidence that graph queries have been delegated. A legitimate session can remain a non-publisher for the other session's lifetime.

### S2. A failed process-table command releases the orphan-protection lock early

**Location:** `packages/room-mcp/src/preview-cache.ts:71` (also shipped at `plugins/room/server/room-mcp.mjs:37416`).

The shell lock helper pipes `ps` into `awk` and interprets no matching rows as a dead process group. If `ps` is unavailable or exits unsuccessfully, its stderr is discarded and `awk` sees empty input. The helper exits and releases the lock although a tracked orphan check can still be running in that cached tree. A later preview/eviction may then mutate or remove the tree beneath the check.

The TypeScript `processGroupAlive` has a signal-probe fallback, but the independently executing shell helper does not. The new fallback unit test exercises only TypeScript, so it cannot catch this failure. The lead also confirmed this gap in `m_mw270puqvcdtx7`.

**Smallest fix:** capture the process-table command's success separately from row matching; on failure retain the lock while `kill -0` says the group exists. Keep uncertainty conservative, including permission errors. Add a real lock-helper regression with a failing `ps` and a live tracked group, then prove the lock becomes available after the group exits. Preserve the zombie-only case.

### S3. Logout can acknowledge a token that startup recovery later resurrects

**Locations:** `packages/server/src/auth.ts:329`, `packages/server/src/auth.ts:363`, `packages/server/src/index.ts:580`.

After the initial sessions-file load fails, `ready` resolves with `loaded=false` and an empty in-memory map. A client can submit an existing stored token to logout during this interval. `logout` returns `{}` because neither map contains the token, without attempting a durable deletion or recording a tombstone. The endpoint answers HTTP 200 `{ok:false}`. The MCP logout code treats any 2xx as confirmation, removes its saved token, and emits no unconfirmed warning. Once storage recovers, reconciliation calls `adopt` and restores the supposedly logged-out token without even requiring a restart.

This is an interaction introduced by the new delayed-startup adoption path. The tests cover startup recovery and failed logout persistence separately, leaving this combination uncovered.

**Smallest fix:** do not infer durable absence from an unloaded map. For an unknown supplied token while initial loading is unresolved, return retryable 503, or perform a durable delete and retain appropriate revocation evidence until it succeeds. Add a test that starts with unreadable storage, logs out a previously stored token, repairs storage, reconciles/restarts, and verifies the response and revocation agree. If deletion is deferred, do not acknowledge completion.

### S4. New PR file-coverage evidence is not consumed by the Room mirror

**Locations:** `packages/server/src/github.ts:140`, `packages/room-mcp/src/prs.ts:17`, `packages/room-mcp/src/prs.ts:59`, `packages/room-mcp/src/tools/prs.ts:88`.

The server correctly returns `coverage: partial/unavailable`, but the client `PrInfo` contract and mirror/display logic were not updated. A failed file read can still replace a previously known PR scope with an empty or shortened list, and the status line still prints `no files` for unavailable coverage. The raw property can survive JSON transport into the map, but nothing uses it to qualify the scope or status. The equality shortcut also ignores coverage-only changes, so even stored metadata can remain stale when the file list/title/date are unchanged.

This is an incomplete end-to-end fix, not a claim that the new server JSON field is missing. The existing user-visible false completeness remains after the proxy improvement.

**Smallest fix:** add coverage to the client contract, include it in mirror-change detection and render it explicitly. Preserve previously known paths conservatively on incomplete enumeration, labeled as stale/partial, or withhold scope replacement until enumeration succeeds; never label an unavailable list as known empty. Add proxy-to-mirror/display tests for full → unavailable → recovered, and a coverage-only transition with unchanged paths. The new tests currently stop at `GitHubProxy` output.

## Later

### L1. Process-group cleanup now synchronously spawns `ps` on the MCP event loop

**Locations:** `packages/room-mcp/src/preview-cache.ts:27`, `packages/room-mcp/src/tools/files.ts:718`.

Every tracked process exit invokes the whole-table synchronous read, normally at least twice (initial check and loop condition). A surviving child repeats it after each 25 ms sleep. Each read allows three seconds of synchronous blocking; slow process inspection therefore blocks tools, lease timers and cancellation, and successful ordinary Git setup commands also gain extra process launches. The external lock helper has an unbounded `ps` invocation too. This review did not measure the common-case overhead.

**Smallest fix:** use an owned asynchronous, deadline-bounded process-table read in the async cleanup path and reuse one result per iteration; preserve the conservative fallback and lock ownership on uncertainty. Bound the external helper's inspection too. The pre-existing cleanup loop still has no final group/pipe deadline: zombie handling solves one cause of indefinite retention, not all of them.

### L2. The CPU watchdog can attribute completed tool work to idle background CPU

**Locations:** `packages/room-mcp/src/cpu-watchdog.ts:113`, `packages/room-mcp/src/timing.ts:10`, `packages/room-mcp/src/timing.ts:210`.

The watchdog samples `busy` every 500 ms, but CPU deltas cover the entire interval. A tool call that starts and finishes between ticks is never observed as busy; repeated CPU-heavy short calls can cross the threshold and produce the claim “with no tool call in flight” for a window containing substantial tool work. A synchronous tool can also delay the timer until after its timing entry is removed. Cooldown and profile retention still bound the cost, so this is diagnostic attribution, not an uncontrolled profiler loop.

**Smallest fix:** expose a tool-activity generation/last-active marker from `ToolTimingTracker`, and reset the idle window whenever activity occurred since the previous sample, even if no call remains active. Test a complete call between two ticks rather than only a busy flag held across several ticks.

## Coverage and sound changes

The count is by the **eleven Unreleased bullets**, not by files or individual assertions. Six have no release finding from this review:

1. **Collect mode fix:** the 0664 lead / 0644 base / 0755 worker case now compares executable state and retains the lead's non-executable permission bits. Carried ownership checks remain before applying a mode. The added acceptance case verifies both executable application and retention of group-write. I found no changed ignored-artifact deletion mechanism in this range: `worker-git.ts` is unchanged from the tag. I read its retention path as requested; nonempty differing/missing ignored artifacts still retain the worktree, equal files and empty files follow the already-shipped 0.17.28 rule, and links are not followed by that comparison.
2. **Tests and CI:** disposer changes stop producers/close registries/drain preview maintenance before deletion in the affected fixtures. Cache mutation cases now own and warm their repositories; scale setups still run with `TEST_SCALE=1` in CI. The graph timer test retains the exclusion assertion and adds ready/provenance assertions. The live-log test retains both pre-exit activity observations and adds acknowledgements plus awaited exit. The zombie crash-test change is in cleanup, and correctly waits for execution to end rather than requiring an init process to reap it. I found no weakened functional assertion masquerading as a race fix.
3. **Symbol graph:** unchanged-base reuse is limited to immutable base symbols with matching path/blob identity; overlay publication and exclusion facts veto reuse, and current publication authority is checked again. A HEAD move rebuilds graph relationships from admitted symbol facts. Historical batching checks blob sizes first, skips values over 512 KiB, groups at 4 MiB of blob payload, uses immutable object IDs, preserves the prior UTF-8 decoding behavior, and falls back per path on batch failure. Read-ahead is bounded to 32 paths and consumed entries are released. No source correctness defect found in these changes.
4. **Sharing:** failed/unsafe/oversized `.roomignore` reads preserve previous rules; unknown startup rules authorize no file publication. Completeness is withdrawn and recovery republishes. Only ENOENT selects empty rules. Tracked refresh retries unreadable policy, and control reads enforce explicit byte limits plus descriptor checks; the pattern limit is enforced before compiling excess rules. The regression cases exercise startup, mid-run failure, deletion and recovery. These are byte/work bounds for regular files, not a general synchronous-I/O time guarantee.
5. **Credentials:** explicit paths propagate through login/poll, join, subsequent authenticated calls, doctor and agent CLI. Reads distinguish absence from errors and reject non-object JSON. The existing durable atomic writer preserves 0600 files and cleans failed replacements. The captured-store test exercises an awaited login while defaults change. No new credential-store regression found; S3 concerns server revocation recovery. The client now honestly warns on a non-2xx logout, although it still discards its local credential and cannot itself retry that token afterward.
6. **Honesty:** no-report summaries retain structured model text, background counts and log path, while plain stderr/arbitrary JSON and host errors are excluded. Changed log-tail tests reflect this intentional contract and retain run-offset, ANSI and length checks. Forget errors propagate; join-save failures are surfaced. Preview/export annotations and eval mocks now acknowledge execution/file writes.

The remaining five bullets are not counted wholly sound: preview cleanup (S2/L1), hosted persistence (S3), GitHub/admission (S4), server health (L2), duplicate leads (S1). Their sound portions are substantial: ordinary loaded-session logout awaits deletion and retries owed deletes; session read failures preserve current sessions; atomic file/hub writes clean up pre-rename failures; failed PR-list pages reject; incomplete comment searches refuse creation; unknown GitHub push permission returns 503 without becoming a denial. The gate has orderly attach/detach, grace and takeover logic. The profiler uses one capture at a time, hourly cooldown, private files and a five-file retention cap.

**CI gate specifically:** `.github/workflows/ci.yml:83` keeps `test` as an `always()` aggregator requiring both `checks` and `hygiene` to be `success`. Neither job uses `continue-on-error`. An install failure leaves its job failed even when dependent steps skip; a hygiene failure cannot pass the gate. Explicit non-cancelled conditions let independent typecheck/test/build steps finish after another check fails. Plugin build failure cannot silently pass through the skipped asset-drift step. Existing Windows jobs were separate before and remain separate; the old `test` gate did not subsume them either. Branch-protection settings were not queried.

**Evidence limits:** the new graph equivalence test compares readers that now share the batch implementation, and its small fixture does not cross a 4 MiB batch boundary. Its fresh-build comparison is useful for reuse, but neither establishes an independent old-reader oracle or the advertised benchmark numbers. The new tests generally target the stated fixes; source reading cannot establish “fails before” without running an adapted test on the pinned old revision. No such run was authorized here. Deferred findings in the three cleanliness reports are not implicitly fixed by this batch.

## Coordination

The report path had no competing owner; Room declined the explicit claim request as unnecessary. The lead confirmed S1/S2 and received S3/S4 before completion. Findings and source line numbers above remain pinned to `30ba09c882`; any concurrent lead fixes require their own validation and do not retroactively change this review's verdict.

Final named preview with `rohanz's agent` (resolved by Room to `rohanz`) was conflict-free over ancestor `30ba09c882`, including the lead's current ten changed paths and this report. No combined tests were requested or run. The preview establishes document integration only: the lead's in-progress fixes were not part of the committed candidate reviewed here. There were no other present peers to include. Final Git status contained only this untracked report; typecheck output was ignored build output.
