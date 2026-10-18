# Rehearsal fixes — review round 5, 2026-09-30

Reviewed `ac4a734..46acc09`, with a final source pass over `0aef465..46acc09`, at HEAD `46acc0970d4fe9133e2f78a825838fa7a1e000c5`. Read rounds 1–4 and the dated rehearsal evidence. Adapted round-4 reproductions under `/tmp/astra-review-r5/`; all fixtures and scratch code are under `/tmp`. This report is the only repository change.

**Verdict: not ready to sign off. Findings: 2 must-fix, 3 should-fix, 0 nits.**

## Q1–Q4 disposition

| Round-4 finding | Result at 46acc09 |
| --- | --- |
| Q1: lead edit overwritten during collection ref publication | **Fixed.** The adapted original assertion passes: the edit made after the real `update-ref` survives and collection aborts before writing. The worker stays active with its output intact; the early HEAD ref exists, but does not mark the worker collected. A subsequent successful retry copies the output. Both new repository regressions, including the two-worker case, pass. The final identity gate through the apply loop has no await. |
| Q2: legacy reacquisition races migration/removal | **Fixed.** The old and new implementations run side by side, using the actual legacy protocol extracted in round 4. An old invocation reacquires the dead-token legacy tree and stays in its check while a modern preview and removal run. It reads `legacy`, the modern check reads `modern`, both pass, and there are **zero renames of the legacy key**. Modern slots use the sidecar. The former pre-rename pause cannot be reached because migration has been removed. |
| Q3: unrelated cleanup prunes an adopting registration | **Fixed in the original reproduction.** Pause the adopter after its successful rename and before repair; remove a different dead slot. The adopter's registration remains locked, the original check and next warm check both pass, and the ignored marker survives. The repository regression also invokes an explicit global `git worktree prune` during the pause and passes. Cleanup has separate registration-ownership problems below, but the original global-prune race is fixed. |
| Q4: no maintenance / interrupted trash ignored forever | **Partially fixed: original reproductions pass; recovery and bounded-work gaps remain below.** The original two-slot fixture now retains the one dead spare allowed by policy; the supplied three-dead-slot test reduces the surplus to the newest one. Interrupting immediately after the actual trash rename, then retrying removal/preview, removes that trash and its registration. Vanished-clone and four-deletions-per-pass tests pass. However, missing `.git` residue still leaves permanently locked registrations (S4), and the pass bounds deletions rather than scanning/probing or concurrent sweeps (S5). |

Evidence: `ignored-probe.test.ts`, `legacy-race.mts`, `repair-race.mts`, and `slot-maintenance.mts` in `/tmp/astra-review-r5/`; logs `/tmp/astra-review-r5-{preflight,scratch,legacy,repair,maintenance}.log`. The scratch import symlink was corrected before the successful legacy run; no production logic was substituted.

## Findings

### S1 — must-fix: two sweepers can delete a newly reused, unrelated Git registration

**Location:** `packages/room-mcp/src/tools/files.ts:758–762`, `:704–711`.

Trash recovery calls `deleteClaimedSlot` without claiming the trash. Two passes can act on the same path, including an automatic pass overlapping explicit cleanup. Each captures an admin-directory **pathname**, then awaits Git operations, and the fallback recursively removes that pathname without checking that it still denotes the captured registration.

**Concrete reproduction:** `/tmp/astra-review-r5/trash-race.mts`, log `/tmp/astra-review-r5-trash.log`:

1. Leave a locked dead slot renamed to interrupted trash.
2. Sweeper A reads its `.git` and captures the admin path; pause immediately before its real `git worktree repair` executes.
3. Sweeper B recovers/removes the same trash and its registration.
4. Create a normal unrelated Git worktree whose basename is the freed admin name. Git legitimately reuses that admin directory. Lock the new worktree and edit its file.
5. Resume A. Repair of the now-missing trash fails. A's fallback removes its stale captured admin pathname, which now belongs to the new worktree.

Observed `reused: true`, `adminSurvived: false`, `replacementExists: true`. `git status` in the replacement fails with `fatal: not a git repository: .../.git/worktrees/999999999-dead`; the worktree disappears from `git worktree list`. Its ordinary file survives, but its index/HEAD/registration have been deleted. No forged Git result or owner liveness was used. The delayed operation is a real command run after release. The new unrelated worktree is created by ordinary Git, not by Room's slot adoption.

**Suggested fix:** make trash recovery exclusive across processes and background/explicit passes, with crash-recoverable ownership. Preserve and validate the exact registration identity through deletion; never recursively remove a reused pathname on the strength of a pre-await lookup. Prefer quarantining the verified registration under an exclusive generation before asynchronous teardown. A second unprotected pathname check still leaves a check/delete race. Add the two-sweeper/reused-registration ordering.

### S2 — must-fix: a cache's `.git` pointer can redirect cleanup to a live worktree

**Location:** `packages/room-mcp/src/tools/files.ts:677–680`, `:703–711`; the same helper is used by broken-cache recovery at `:820–824`.

`previewAdminDir` accepts any `.git` target whose lexical parent is the common directory's `worktrees` directory. It does not verify the registration's reciprocal `gitdir`, or prove that the registration belongs to this cache generation. `deleteClaimedSlot` then runs `git worktree repair` on that unchecked pointer. Repair can rewrite the other worktree's backlink; unlock/remove subsequently destroys its registration. Checking only before the fallback `rm` would therefore be insufficient.

**Concrete reproduction:** the `wrong-git` case in `/tmp/astra-review-r5/broken-slots.mts`, log `/tmp/astra-review-r5-broken.log`. Create an ordinary live locked worktree and a dead-slot-shaped cache directory. Copy the live worktree's `.git` file into the cache, modeling a malformed/copied cache pointer. Run `removePreviewCache`. The live worktree's registration is removed despite its lock; its next `git status` fails because its admin directory no longer exists. The local file still contains `LIVE UNCOMMITTED`.

This is a destructive recovery-boundary defect, not a claim that untrusted remote participants can write `.git` through a shared overlay. The reproduction explicitly corrupts local cache metadata. Cleanup must refuse ambiguous provenance rather than convert a bad cache pointer into authority over another checkout.

**Suggested fix:** validate reciprocal ownership against the original slot path or a durably recorded relocation before **any repair/unlock/remove**, including realpath/symlink and registration-identity checks. An admin backlink to an unrelated extant checkout must be preserved and reported. Retain the original source path across trash renaming so legitimate moved registrations can be distinguished from wrong pointers. Apply the same boundary to broken-cache recovery and add a wrong-pointer regression.

### S3 — should-fix: one partial dead slot prevents every later preview from running

**Location:** `packages/room-mcp/src/tools/files.ts:791–798`.

Adoption now requires `worktree lock` before moving a dead slot. If an interrupted first checkout leaves a directory that Git cannot recognize as a worktree, locking fails; because the directory exists, the error is rethrown. The caller never reaches `preparePreviewCache`'s existing partial-directory recovery. Automatic maintenance keeps the newest dead spare, so a single broken slot remains the first failed adoption candidate indefinitely.

**Concrete reproduction:** `broken-slots.mts`, `partial` case. Create one dead-owner slot directory with a partial file and no `.git`/registration. Two separate previews, with time for the background sweep between them, both return:

```text
merged-tree setup failed ... git worktree lock ... is not a working tree; check was not run
```

No command runs and the broken directory survives. This is a damaged-cache availability regression introduced by locking before adoption.

**Suggested fix:** distinguish “cannot protect a valid registration” from “incomplete/unregistered cache.” Safely quarantine/recover provably dead partial slots, or skip them and use a fresh slot/tree; do not make them a permanent prerequisite for all previews. Preserve the locked-registration guarantee for valid adoption. Add a dead-owner partial-initialization test, not only a partial directory already owned by the current process.

### S4 — should-fix: losing `.git` before trash rename leaves a locked registration that no later sweep can find

**Location:** `packages/room-mcp/src/tools/files.ts:682–689`, `:704`, `:750–752`.

The fallback registration search compares its `gitdir` with the **trash** path, but an interrupted/damaged checkout whose `.git` file is missing still has its backlink at the **original slot** path. Deletion has already renamed the directory before doing this search. No admin path is found; Git repair fails; filesystem removal succeeds, leaving the registration locked forever. Its only searchable slot/trash directory has now disappeared, so further sweeps cannot recover it, and global prune honors the lock.

**Concrete reproduction:** `broken-slots.mts`, `missing-git` case. Create a real Git worktree in a dead slot, lock it, remove its `.git` file, then invoke removal twice and `git worktree prune`. Output: `deadExists: false`, **`adminExists: true`**. `git worktree list --porcelain` still lists the missing old slot with `locked`.

**Suggested fix:** resolve and authenticate the registration before the move, durably retain the original path/registration identity in the trash record, and recover from that record after a crash. Alternatively add a conservative scan for locked Room registrations with missing paths and verified ownership. Do not drop the last recovery locator before the registration is removed. Cover missing `.git` plus interruption at the rename and unlock/remove boundaries.

### S5 — should-fix: the sweep's work and concurrency are unbounded even when it deletes nothing

**Location:** `packages/room-mcp/src/tools/files.ts:723–747`, `:765–767`, `:907–909`.

`PREVIEW_SWEEP_LIMIT` caps successful removals only. A pass enumerates every clone key and probes every slot until enough deletions succeed; with live/uncertain owners it scans the entire common-directory cache. Explicit `removePreviewCache`, called during collection, awaits that scan. Every cached preview schedules another pass with no single-flight/coalescing guard, so slow passes accumulate concurrently. The new scan also performs synchronous `existsSync(clone)` for each parsed metadata path on the MCP event loop, even when that path is unrelated to the current clone.

**Concrete reproduction:** `/tmp/astra-review-r5/sweep-budget.mts`, log `/tmp/astra-review-r5-budget.log`. Populate 20 cache keys with live-slot names; inject a 40 ms asynchronous owner probe. A single removal performs **20 probes**, deletes nothing, and takes **869 ms**. Four sequential fast previews launch **80 probes**, with **4 concurrent probes/passes** observed. These are injected latency measurements, not a host benchmark. At the production 3-second per-probe ceiling, uncertain live slots can make explicit cleanup wait much longer. Increasing keys/previews increases work/concurrency; there is no scan/time bound.

**Suggested fix:** coalesce sweeps by common directory, give each pass a scan/probe/time budget as well as a deletion budget, and keep a cursor so repeated bounded passes make fair progress. Bound foreground cleanup separately from opportunistic maintenance. Use asynchronous, validated metadata-path checks. Add a many-live/uncertain-slots test and an overlapping-preview single-flight test.

## Other requested checks and cumulative pass

- **Live/adopting slots:** the immutable owner-specific source name still protects the liveness-check/rename gap. If adoption wins, a stale sweep rename targets the vanished dead name rather than the new live name. The original rename/repair probe and repository live/uncertain-owner tests pass. I did not establish another ordinary live-slot deletion/reset race. S1 concerns shared trash and Git admin identity after its slot has already been won.
- **Lock/unlock failure:** a failed unlock can reach the fallback even for a locked worktree; the targeted fallback can remove the correct registration when its identity is valid. The concrete unresolved cases are wrong/stale identity (S1/S2) and failure to locate it after losing `.git` (S4), rather than a blanket claim that every unlock failure leaks.
- **`clone.json` trust:** `parsed.path` is used for an existence test, not as the recursive-delete target. In the budget probe, metadata points at both an unrelated sentinel directory and a nonexistent path; the sentinel stays `KEEP` and all 20 live slots remain. No arbitrary-directory deletion via `clone.json` alone was established. A forged/mistaken path can change whether the last *dead* spare is retained, and its synchronous existence check belongs in S5. Registration pointers have the stronger concrete problem in S2.
- **Early collection refs after abort:** the adapted Q1 test checks that refs remain but the worker is active and its output intact, then successfully retries. Source review confirms `abortCollect` and interrupted-collect reconciliation return the worker to active; `localWorkers` excludes retired workers from new collection; late shared-owner cleanup requires a retired record with a shared-checkout retention reason. Cleanup does not treat ref existence alone as success. No additional cleanup-authority defect from Q1's early publication was established. The exact captured HEAD, committed/uncommitted late-output preservation, and direct-by-ID freshness checks remain covered; the scratch counting case records **2 reads**, about **0.53 ms**.
- **Cumulative source pass:** rechecked fresh-room admission, push/history handling, own-commit wake suppression, bounded rollout scanning, names and partial-preview accounting, preview-evidence generations, dependency relinking, graph-ready shortcuts, claim fences/notices, shutdown ordering, plugin selection and shared-checkout lifecycle across `0aef465..46acc09`. No additional concrete finding was established outside S1–S5. Host-feature conclusions remain limited to supplied dated survey/rehearsal evidence; no new live host API/wake/routing experiment, plugin rebuild or host eval was performed.

## Validation

- Primary cache/collection/conflict/carry batch: **232 passed / 1 failed, 8 files (233 tests)**. The failure was `conflict-set.test.ts:891`, `delivers a fresh accepted contract notice after changed-signature re-entry`, whose expected conflict entry was undefined. A separate isolated rerun **passed**. This is recorded as an intermittent validation failure, not silently counted as an all-green batch or a proven new regression. Log: `/tmp/astra-review-r5-tests.log`; retry: `/tmp/astra-review-r5-conflict-retry.log`.
- Focused new cache tests rerun separately: **15 tests / 3 files passed**, including adoption versus prune/removal, live/uncertain slots, legacy sidecars, trash recovery, vanished clones, and the four-deletion cap. Log: `/tmp/astra-review-r5-cache-tests.log`.
- Adapted scratch assertions: **5 passed**, including Q1 plus active-state/successful-retry checks, both late-output variants, ignored-output retention, and the direct-read count. The original Q1 assertion was also run alone and passed. Log: `/tmp/astra-review-r5-scratch.log`.
- Standalone scripts above use real temporary Git repositories and actual source functions. Latches only order the stated boundaries; the budget script explicitly injects owner-probe latency. They print the observable failures rather than claiming those are passing tests.
- Remaining cumulative regression batch (preview names, manifest preview, wake turn, lifecycle cleanup, worker lifecycle, presence shutdown, tool budget, tools, hub, base branch/resolution, areas and base messages): **239 tests / 13 files passed**. Log: `/tmp/astra-review-r5-more.log`. Across the two main batches: **471 passed / 1 intermittent failure, 21 files (472 tests)**; the isolated retry and focused reruns are additional, not new unique tests.
- Each Vitest batch uses one worker; heavy batches were staggered. `nice -n 10` was attempted but `setpriority` was denied. Socket-dependent integration suites were not used as evidence because loopback listeners fail with `EPERM` in this sandbox. No source/test edits, commits or pushes were made.

The required `room_preview_merge(people:["rohanz"])` completed without conflicts at common ancestor `46acc0970d`. It included rohanz’s separate rehearsal-document update and this report; no tests were requested in that preview. The final working-tree check shows this report as the only changed path.

**Final verdict: not ready to sign off.**
