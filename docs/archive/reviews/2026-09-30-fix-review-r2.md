# Rehearsal fixes — review round 2, 2026-09-30

Reviewed `9870168..249d77b`, then rechecked the source changes across `0aef465..249d77b`, at worktree HEAD `249d77b5fdf367c0afe021ea2bfc37bdfa1a03c8`. Read the round-1 report and adapted its surviving reproductions to this worktree. Only this report was written in the repository; reproduction files are under `/tmp/astra-review-r2/`.

**Verdict: not ready to sign off. Findings: 1 must-fix, 4 should-fix, 0 nits.**

## R1–R6 disposition

| Round-1 finding | Result at 249d77b |
| --- | --- |
| R1: concurrent stale-lock recovery / removal | Original interleaving fixed: contenders read their own merged contents, and removal now takes the lock. The repository's warmed-cache contention and removal-race tests pass. Recovery still has the gate-expiry and incomplete-lock failures below (N2/N3). |
| R2: owner collection removes a running borrower's checkout | Original reproduction now passes. Owner collection and deferred retirement preserve a running borrower; normal borrower collection and discard can subsequently clean the retained owner. Spawn/resume exclusion tests pass. A new last-borrower cleanup path loses ignored output (N1). |
| R3: skipped rollout turn boundaries | Fixed in the exercised cases. Adapted cold/warm large-append probes now report busy for `task_started`. The terminal transition, partial-line, and scan-budget regressions pass. An idle rollout with a completion followed by more than 8 MiB of ordinary records resolves to idle on the second poll; I did not reproduce busy-forever on a stable readable idle rollout. |
| R4: claim release uses a stale worker/claim snapshot | Fixed for the reported races. The adapted reproduction retains the claim and emits zero release notes. The nine repository cases cover resume, run/worker identity, holder replacement, reanchoring, anchor changes, added/removed claims, and an operation starting during reads. The default revalidation adds synchronous registry scans to reconciliation (N5). |
| R5: stale dependency links in cached previews | Fixed. The adapted workspace-link probe changes from `one` to `two` on the warm preview. Added/removed/retargeted dependency tests pass, including preservation of an unrelated ignored build cache. |
| R6: refused/no-peer preview retains earlier passing evidence | Fixed sequentially, including the original refusal reproduction and own-only/invalid-input regressions. Concurrent requests remain unordered: an older success can restore evidence after a newer refusal (N4). |

## Findings

### N1 — must-fix: collecting the last borrower silently deletes uncopied ignored output

**Location:** `packages/room-mcp/src/tools/collect.ts:152`, with the borrower fast path at `:643` and ordinary ignored-output protection at `:666`.

Collect owner `port-fix` while `port-bools` is running in its checkout. The owner is correctly retired with a retained shared checkout. The borrower then creates an ignored `artifact.bin`, finishes, and is collected normally. The borrower fast path skips `ignoredWorkerArtifacts`; `finishOne` calls `cleanRetiredSharedOwner`, which invokes `cleanupWorker(..., collected=true)` directly. That force-removes the entire checkout without checking the artifact or making a recovery copy.

**Reproduction:** `/tmp/astra-review-r2/ignored-probe.test.ts`, test `REVIEW last borrower collection preserves ignored output created after owner collection`. The file-exists assertion fails. Tool output is only:

```text
Changes from port-bools: already present. Nothing committed or staged.
detached port-bools; the worktree belongs to port-fix
```

The shared checkout and `artifact.bin` are gone. This is ordinary collection, without `discard` or `force`. The existing last-borrower tests have no late ignored artifact and therefore pass.

**Suggested fix:** apply the normal ignored-artifact and remaining-work checks to the retained owner's current checkout while holding its operation lane, before automatic cleanup. Keep its worktree/archive reason and report uncopied files when any remain. Prefer putting the preservation rule at the common cleanup boundary so deferred/manual paths cannot bypass it. Add this late-artifact collection regression and a last-borrower discard case that verifies owner output is not implicitly authorized for deletion.

### N2 — should-fix: gate expiry can revoke a live recoverer and strand its new lock

**Location:** `packages/room-mcp/src/tools/files.ts:615`, `:629`, and `:633`.

Age alone does not prove a recovery process died. A recoverer can be suspended after reading the dead lock under its gate. After 60 seconds another caller removes its gate, recovers the lock, and starts using the cache. The original recoverer resumes with its previously read dead token, removes the new live lock, creates its own lock, then throws from the unconditional gate `rmdir` because the second caller already removed that directory. Its newly acquired release callback never reaches `runInMergedTree`.

**Reproduction:** `/tmp/astra-review-r2/cache-recovery.mts` pauses exactly that read and ages the gate to model the suspension. The first preview fails with `ENOENT ... rmdir ...lock.recover`; the second passes. A lock naming the still-live first process remains afterward. The next preview uses a fresh tree and `removePreviewCache` refuses cleanup. This reproduction establishes lost ownership and a wedged cache, not a second wrong-tree passing result.

**Suggested fix:** give recovery gates an atomically published owner identity/token and recover only a demonstrably dead owner under a safe comparison protocol. Do not unlink a gate based only on mtime. Gate cleanup must check ownership, and failure to release a gate must not lose an already-acquired cache-lock release handle. Test a paused live recoverer, and two callers trying to recover the same stale gate.

### N3 — should-fix: a crash between exclusive open and token write leaves a permanent lock

**Location:** `packages/room-mcp/src/tools/files.ts:600`–`:601`, `:622`; cleanup refusal at `:569`.

The lock becomes visible at `open('wx')`, before it contains its PID/token. If the process dies before `writeFile`, the empty lock cannot be recognized as dead. No age or owner-independent recovery exists for it. Future previews fall back to full materialization indefinitely, and worker collection/discard cannot remove this preview cache because `removePreviewCache` refuses the uncertain lock. Write failure can leave the same residue. The gate-expiry fix does not cover this file.

**Reproduction:** the second case in `cache-recovery.mts` leaves an empty lock with a day-old mtime. A preview still reports `fresh base`; cache removal still throws `preview cache is in use or its lock is uncertain`. Restarting the former owner cannot make an empty PID identifiable.

**Suggested fix:** publish a complete owner token atomically, for example by writing a private token file and exclusively linking it into place, as the repository's lease utilities do. Provide a safe recovery path for already-existing incomplete locks without mistaking a live in-progress publication for abandonment. Include crash/failure injection between creation and publication.

### N4 — should-fix: preview evidence has no request generation

**Location:** `packages/room-mcp/src/tools/files.ts:227`, `:374`, and `:383`.

Clearing evidence when a request starts fixes sequential calls, but later assignments do not verify that the request still owns the evidence slot. Start preview A with a check blocked in the scratch tree, then request B with `people:['ghost']`. B refuses and invalidates evidence. Let A complete: it sets `lastPreview.testsPassed = true` again, despite the later requested preview having failed. Conversely, an older request's late stale-input/timeout assignment can clear evidence that a newer successful preview just installed.

**Reproduction:** `/tmp/astra-review-r2/preview-probe.test.ts`, test `REVIEW concurrent older success must not restore evidence after a newer refusal`. It waits for A's actual check command to start, refuses B, then releases A. The assertion fails with `complete: true, testsPassed: true` and A's old command. The sequential round-1 refusal test passes in the same file.

**Suggested fix:** increment a per-session request generation at entry. Every evidence write, including clears in early/late error paths, must belong to the current generation. Alternatively serialize preview requests. Test both older-success-after-newer-refusal and older-failure-after-newer-success; tree-input currentness alone does not establish request currentness.

### N5 — should-fix: worker revalidation adds unbounded synchronous scans to conflict reconciliation

**Location:** `packages/room-mcp/src/conflict-set.ts:228`–`:235`, called at `:567` and `:592`; `packages/room-mcp/src/worker-registry.ts:492`–`:495` and `:514`–`:518`.

`registrySnapshotForDir` creates a new durable reader. Resolving a claim's participant name, such as `lead+test`, goes through `reservedByTagOrName` and synchronously reads/parses every worker record, including historical ones. A landed worker incurs two such scans. The initial scan also happens before checking whether `localWorker` returned a finished trusted worker, so unrelated claimants incur it. `status()` additionally reads reports/exits synchronously and may run synchronous process probes. These operations run on the same event loop as Room tools, outside the conflict pass's yielding file budget.

**Reproduction:** the `REVIEW counts new synchronous registry scans on claim release` scratch test uses one real fixture worker plus 1,000 additional valid worker records. Calling the two production `workerState` checks causes **2,006 synchronous worker-record reads**, taking about **66 ms** in this run; results are in `/tmp/astra-review-r2/sync-count.json`. This isolates only the newly added checks, excluding the pre-existing trusted-worker lookup. Multiple claimed workers and a growing registry multiply the blocking work; slow disks/process probes make the pause larger.

**Suggested fix:** reject non-done/untrusted workers before doing the extra lookup, retain the already trusted worker ID, and revalidate that one record/run/operation directly. Move bulk lookup and process probing to an asynchronous bounded/cached path, keeping only a small final freshness check before deletion. Add a responsiveness regression with a populated registry, not only injected in-memory worker-state callbacks.

## Broader recheck and validation

Rechecked the remaining source changes: fresh-hub admission, base/push history and upstream status, own-commit wake suppression, name normalization, partial-preview reporting, graph-readiness shortcuts, conflict notices, shutdown ordering, plugin-version selection and borrowed-checkout lifecycle. No additional concrete defect was established outside the findings above. The new `room_state`/`room_send` graph shortcuts have passing tests with an unresolved graph-ready promise. Host integration conclusions remain limited to the supplied dated surveys/rehearsals; no live Codex/Claude routing or wake rehearsal was performed.

Operation lanes reject contention rather than waiting indefinitely. The owner-held recursive detach and borrower spawn/resume tests pass; I did not reproduce a lane deadlock or an ordinarily finished borrower that can never be explicitly detached. The preserved-owner cleanup is reachable, which is also why N1 matters. Automatic retirement does not itself run the last-borrower cleanup helper, so it can leave a retained owner for explicit cleanup; I did not treat that conservative retention as data loss or an uncleanable borrower.

Repository tests, at most two Vitest workers:

- Preview cache races, preview cache, preview names, wake turn, conflict set, collection: **201 tests / 6 files passed**.
- Manifest preview, worker preview-cache cleanup, worker lifecycle, lifecycle cleanup, presence shutdown, tool budget, tools, hub, base branch, base resolution, areas, base messages: **221 tests / 12 files passed**.
- Total: **422 existing tests / 18 files passed**.

Adapted round-1 scratch tests for R2/R6 pass; standalone probes confirm the changed R1/R3/R4/R5 behavior. The two new correctness assertions fail as described in N1/N4, the cache script confirms N2/N3, and the synchronous-read counting assertion passes. Early scratch harness import/interception errors were corrected before these results. Logs are `/tmp/astra-review-r2-{tests,more,scratch,probes,ignored,concurrent,cache-recovery,sync}.log`.

Socket suites were not used as evidence: this sandbox's loopback listeners fail with `EPERM`. `nice -n 10` was attempted but the sandbox rejected `setpriority`; the commands still ran with bounded Vitest concurrency. No source/test changes, commits, pushes, plugin rebuilds, or live host evals were performed.

The required `room_preview_merge(people:['rohanz'])` completed without conflicts at common ancestor `249d77b5fd`; only this report differed. No tests were requested in that merge preview. The final working-tree check shows this report as the only changed path.

**Final verdict: not ready to sign off.**
