# Rehearsal fixes — review round 1, 2026-09-30

Reviewed `0aef465..9870168` on `redesign`, including the five commit messages, the Findings sections of the Werkzeug/httpx/Flask/Codex rehearsals, and the stated manifest/hub contracts. Source and repository test files were not changed. Scratch reproductions live under `/tmp/astra-review-r1/`.

**Verdict: not ready to sign off.** Findings: **4 must-fix, 2 should-fix, 0 nits**.

## Findings

### R1 — must-fix: stale-lock recovery admits two cache owners

**Location:** `packages/room-mcp/src/tools/files.ts:586–591`, also `:582` and `:552–574`.

Two previews can both read the same dead PID. A removes the stale lock and successfully creates its own lock; B then executes its already-planned `rm(file)` and deletes A's live lock. B's next `open('wx')` succeeds too. Both now reset, write, test and clean the same checkout. The unconditional release callback can subsequently delete another owner's lock as well. `removePreviewCache` similarly checks a lock without acquiring it, so a preview can start between the check and worktree removal.

**Concrete reproduction:** `/tmp/astra-review-r1/probe.mts` delays only the filesystem operations needed to force this valid interleaving. It starts two `runInMergedTree` calls with `x = first` and `x = second` after leaving a dead-PID lock. Both use the cache. The first check reads **second**; after the first cleanup, the second reads **base**. Both return `passed: true` with the diagnostic command's passing summary. This is a wrong-tree execution proof; the summary is deliberately synthetic, not a real test-suite claim. Real checks can likewise pass on the wrong combined code.

**Suggested fix:** use a lock protocol with atomic ownership across acquisition, stale recovery, release and deletion. An uncertain/stale lock can safely force a fresh checkout rather than being unlinked unsafely. Cache removal must hold the same exclusion mechanism. Add deterministic tests for two stale-lock recoverers and removal racing a preview; the existing concurrency test only covers a live, uncontested lock.

### R2 — must-fix: collecting a shared-worktree owner deletes a running borrower's checkout

**Location:** `packages/room-mcp/src/tools/workers.ts:183–197` (new borrowing support), `packages/room-mcp/src/tools/collect.ts:413–415,611`, and `packages/room-mcp/src/worker-git.ts:301–319`.

The new same-directory borrower guard exists in the **discard** branch. Ordinary collection still stops processes in the owner's directory and ultimately calls `cleanupWorker`, which neither checks `sharedWith` users nor preserves a checkout used by another running worker. The borrower is a sibling, so the descendants check does not catch it. Delayed retirement cleanup has the same common cleanup boundary.

**Concrete reproduction:** a scratch copy of the existing `collect.test.ts` fixture creates finished `port-fix` and running `port-bools`, both using `port-fix`'s worktree, with `sharedWith` recorded. Calling `room_collect({tag:'port-fix'})` returns:

```text
Changes from port-fix: new.txt. Nothing committed or staged.
cleaned up port-fix: temporary files, branch and logs
```

The assertion that the running borrower's directory survives fails: the directory is gone. No real worker was killed in this fixture. In production the same path can stop the sibling's processes and remove edits written after the collection snapshot.

**Suggested fix:** enforce shared-checkout ownership and liveness before any cwd-wide process termination or cleanup, for collection, discard and deferred retirement. Serialize that decision against borrower spawn/resume; checking only once before an awaited operation leaves another race. Retain/refuse while a borrower runs and coordinate finished borrowers before removing the owner. Add normal-collection and deferred-cleanup tests, not just discard tests.

### R3 — must-fix: the rollout tail shortcut can classify an active turn as idle

**Location:** `packages/room-mcp/src/codex-turn.ts:71–88`.

When unread data exceeds 1 MiB, the probe skips directly to the last 64 KiB and advances its cursor past the skipped bytes. A `task_started` in those bytes is lost permanently. On first contact with a large active rollout, `lastEvent` is undefined and the 10-second contact fallback eventually permits a wake. With a warm cursor whose last event was `task_complete`, it keeps that stale terminal event and reports idle immediately, even if contact was recent. The reverse case can also retain `task_started` after skipping completion and suppress legitimate wakes indefinitely.

**Concrete reproduction:** `probe.mts` writes `task_started` followed by 1,300 ordinary response-item lines of about 1 KiB each. A cold probe with contact age 20 seconds returns `false`. A probe that first observed `task_complete` also returns `false` after appending `task_started` plus those lines. Both rollouts explicitly say the current turn is active. The existing large-append test starts with an already-observed `task_started`, so it misses both failures.

**Suggested fix:** never carry a prior event across unread bytes as authoritative. Consume incrementally in bounded chunks with yields, or scan backward until the most recent turn boundary is actually found. If a work budget is exhausted, retain an unknown/busy result and continue later. Test cold large rollouts and both terminal-to-active and active-to-terminal transitions hidden in a large append.

### R4 — must-fix: automatic claim release does not revalidate the worker or claim snapshot

**Location:** `packages/room-mcp/src/conflict-set.ts:554–573`.

The new release path captures `status === 'done'`, then awaits directory enumeration and file reads. Immediately before deletion it checks only the **lead's** lease fence and whether each claim ID still exists. A worker can resume under a new holder epoch, or its daemon can reanchor an existing claim, during those awaits. The old claim IDs still exist, so this pass deletes the resumed/reanchored claims and announces that the changes landed. The normal conflict snapshot guard is installed only after this method returns and cannot protect the deletion.

**Concrete reproduction:** `probe.mts` uses the new injectable worker lookup to return a captured done record while the worker becomes running, its holder epoch advances, and the same claim ID moves to another line. Lead and worker files compare equal. `releaseLandedWorkerClaims` removes the updated claim and posts one release note: `running false 1` for status / claim retained / notes.

**Suggested fix:** capture and revalidate the trusted worker ID and run/generation, worker holder epoch, complete relevant claim values (including anchors), and the lead fence before deleting. Coordinate against resume using the registry's operation mechanism; retry if any input changes. A newly added claim must also invalidate the assertion that all of this worker's claimed work landed. Add races for resume, holder replacement and same-ID reanchoring.

### R5 — should-fix: cached dependency mirrors keep obsolete workspace links

**Location:** `packages/room-mcp/src/tools/files.ts:599–600,659`, interacting with `:417`.

Cache reset intentionally preserves ignored `node_modules`, but `linkSharedDirs` skips any destination that already exists. Thus its mirror is built only once. An `npm install`/workspace relink in the lead can add, remove or retarget dependencies without updating the cached mirror. Previously every preview created a fresh mirror. New packages can be missing; a workspace import can resolve to an obsolete package and check the wrong code.

**Concrete reproduction:** `/tmp/astra-review-r1/deps-probe.mts` previews with `node_modules/a -> ../packages/one`, then changes the lead's link to `../packages/two` and previews again. Both packages are committed in the ancestor. The warm preview still prints **one**, while the lead now resolves **two**. The setup reports `cached base`.

**Suggested fix:** refresh the Room-owned dependency-link mirror each preview, or invalidate it using a sufficiently complete dependency/link fingerprint. Preserve expensive build output separately. Test added/removed packages and a workspace link whose target changes between two previews.

### R6 — should-fix: refused/no-peer previews retain earlier passing evidence

**Location:** `packages/room-mcp/src/tools/files.ts:268–271,290–295`; consumer: `packages/room-mcp/src/tools/workers.ts:106–108`.

The new unknown/ambiguous-name early return does not invalidate `caller.lastPreview`. A successful earlier combined check therefore remains `complete: true, testsPassed: true` after a later requested preview is refused. Dropping an own-name-only list has the same problem when no skipped/unavailable peers exist. `room_done` can subsequently append “The combined preview passed …” in response to a summary mentioning failed local tests, using evidence from the earlier operation.

**Concrete reproduction:** the scratch `preview-probe.test.ts` first passes a preview with `ben`, then requests `people:['ben','ghost']`. The second call correctly refuses `ghost`, but `lastPreview.testsPassed` remains `true`, with the previous command. The regression assertion fails. The existing unknown-name test only starts with no prior preview.

**Suggested fix:** invalidate current preview evidence at the start of each requested preview and only install success after the final currentness check. Clear it on own-only/no-peer paths and all errors. If history is desirable, store it separately from the evidence consumed by `room_done`.

## Validation and remaining limits

The following repository tests passed, with at most two Vitest workers:

- Preview names, manifest preview, preview cache, wake turn, conflict set, tool budget and hub: **123 tests / 7 files**.
- Collection, worker preview-cache cleanup, worker lifecycle, lifecycle cleanup, presence shutdown, base branch, base resolution, areas and base message: **162 tests / 9 files**.

Total: **285 existing tests passed**. The two additional scratch Vitest assertions fail as described in R2/R6; standalone scratch probes confirm R1/R3/R4/R5. Scratch harness import issues were corrected before these results. All fixture repositories and reproduction mutations were under `/tmp`.

The normal cache path is derived from the real common Git directory and a hashed clone path; a leaf symlink is refused and an existing checkout's top-level path is checked. I did not reproduce a normal-path `reset --hard`/`clean` reaching a user's main clone. That does not establish safety under arbitrary cache-path replacement; destructive cleanup should retain ownership/path validation. The demonstrated user-worktree deletion is R2, outside the cache itself.

The fresh-hub optimization is guarded by both the server's fresh-room marker and absence of prior hub incarnation/epoch/sequence; the existing loaded/restart cases retain the settle window. I found no separate defect there. The cache removes the old synchronous recursive deletion; its supplied responsiveness tests pass. Name normalization/partial-tree gating and tool-budget tests also pass, subject to the findings above.

No source/test changes, commits, pushes, plugin rebuilds, live host routing evals or live Codex/Claude wake tests were performed. Socket-dependent integration suites were not used as evidence; this sandbox is documented to reject loopback listeners with `EPERM`. Host behavior beyond the supplied dated rehearsal/survey evidence remains a live-validation item.

The required `room_preview_merge` with rohanz's current work completed with no conflicts (three lead-only paths plus this report). No tests were requested in that preview; the review findings remain scoped to `9870168`, not the lead's subsequent live changes.

**Final verdict: not ready to sign off.**
