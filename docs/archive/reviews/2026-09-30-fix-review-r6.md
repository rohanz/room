# Rehearsal fixes — review round 6, 2026-09-30

Reviewed `5e93065..742e176` at HEAD `742e176`, with a brief final source pass over `0aef465..742e176`. Read round 5 and the dated rehearsal rerun. Report only; no source/test changes, commits, or pushes.

**Verdict: not ready to sign off. Findings: 1 must-fix, 3 should-fix, 0 nits.**

## Round-5 S1–S5 disposition

Adapted the round-5 scratch scripts to import this worktree and await `waitForPreviewSweepForTests()` after asynchronous maintenance requests. Current evidence is under `/tmp/astra-review-r6b/`, with logs `/tmp/astra-review-r6b-*.log`. Some round-6 scratch adaptations were already present from the earlier `astra6` session; I inspected them, changed their imports/child cwd to `astra6b`, and independently reran them. The original round-5 scripts remain unchanged.

| Item | Result at 742e176 |
| --- | --- |
| S1: competing sweepers delete a reused unrelated registration | **Resolved in the original and adapted ordering.** The old interrupted trash is now deliberately left alone, so the old repair latch cannot fire. In the adapted `trash-race.mts`, pause the first process immediately before its real targeted `worktree remove`; a second process cannot acquire its claim and leaves the slot/registration intact. Release the first, create and lock an unrelated checkout that actually reuses the freed admin name, then run both cleaners again. `reused: true`, `adminSurvived: true`, status remains ` M x`, and `NEW LIVE EDIT` survives. No direct admin-directory deletion or global prune remains in preview cleanup. Old trash now costs disk space/manual cleanup. |
| S2: copied `.git` pointer authorizes deletion of a live checkout | **Original reproduction resolved; ownership boundary still incomplete (T1).** `broken-slots.mts` copies the live checkout's regular `.git` file into the dead slot. Cleanup refuses it, retains a claim, and preserves the live checkout's registration, lock, and uncommitted file. Making that metadata file a symlink instead defeats the new reciprocal check and allows adoption to reset the live checkout's index. |
| S3: partial dead slot permanently blocks adoption | **Resolved.** Both original `partial` previews run and pass, the second reuses the new cache, and the malformed dead directory is swept. It is skipped before locking. Different current-process recovery failures remain in T2/T3. |
| S4: missing `.git` loses the locked registration during deletion | **Resolved in the original reproduction.** `broken-slots.mts` removes `.git` from a real locked dead slot, requests cleanup twice, and prunes. Both the slot and admin directory are gone (`deadExists: false`, `adminExists: false`). Keeping the original path permits authenticated `.git` reconstruction and targeted Git removal. |
| S5: unbounded probes, overlapping sweeps, synchronous metadata-path checks | **Substantially resolved, fairness incomplete (T4).** The adapted original 20-live-slot probe makes 8 owner probes in one pass (345 ms with injected 40 ms latency). Four sequential previews produce 15 measured live-owner probes and a maximum of 1 concurrent probe. The unrelated metadata sentinel stays `KEEP`, all 20 live slots survive, and metadata existence checks are asynchronous. Cleanup queues maintenance without awaiting that pass. However, a key with 65 live slots permanently prevents later keys from being scanned. |

Also reran `repair-race.mts`: cleanup during the rename/repair gap preserves the adopting registration's lock, the adopter's ignored marker, and both the first and warm check. `slot-maintenance.mts` retains the permitted spare and deletes it on explicit cleanup. Its old trash-rename interruption hook is now unreachable; the separate adapted S1 test verifies that existing legacy trash is preserved rather than treating the absent hook as proof of crash recovery.

## Findings

### T1 — must-fix: a symlinked `.git` passes reciprocal validation and resets another checkout's index

**Location:** `packages/room-mcp/src/tools/files.ts:685–706`, `:943–960`, `:995–997`.

`slotRegistration` reads through the slot's `.git` link, then compares `realpath(admin/gitdir contents)` with `realpath(slot/.git)`. If the latter is a symlink to another checkout's `.git`, both resolve to the other checkout's file. This is not proof that the registration belongs to the slot. `lockPreviewSlot` also accepts the other registration's existing lock after Git refuses to lock the purported slot.

**Concrete sequence, independently rerun:** `/tmp/astra-review-r6b/edge-probes.mts symlink`, log `/tmp/astra-review-r6b-symlink.log`:

1. Create and lock an ordinary live worktree. Stage `STAGED USER EDIT`, then leave different `LIVE USER EDIT` bytes in its working file.
2. Create a dead-slot-shaped directory; make its `.git` a symlink to the live worktree's `.git`.
3. Run a merged preview. The dead slot is authenticated, adopted, repaired, and reset through the live worktree's Git admin state.
4. The preview reports **passed**, but `git show :x` in the unrelated live checkout changes from `STAGED USER EDIT` to **`base`**. Its working file still says `LIVE USER EDIT`; the staged version has been overwritten.

This is a local damaged/mislinked-cache boundary, not a remote overlay attack. **Impact: modifies another checkout's index and can compromise Git-based preview/test results; not merely disk leakage.** No injected Git result, process-liveness result, or timing fault was used in this reproduction.

**Suggested change:** reject a symlinked/non-regular slot `.git` before reading it. Canonicalize the slot directory and compare the backlink to the expected `.git` path under that directory without following a leaf link out of it. Validate the same ownership before every reset/reuse, including an already-existing own slot; `rev-parse --show-toplevel` alone does not authenticate the admin state. Keep the existing admin-parent restriction and add the staged-index/symlink regression, alongside the regular copied-pointer test.

### T2 — should-fix: one transient cleanup failure leaves a claim that blocks every later preview in that process

**Location:** `packages/room-mcp/src/tools/files.ts:665–674`, `:788–796`, `:986–988`.

Cleanup releases its claim only after complete success. That is conservative for ambiguous dead slots, but `preparePreviewCache` uses the same function to recover the process's own fixed cache path. A failed operation leaves a claim which even its original process will never reacquire or release.

**Concrete sequence:** `/tmp/astra-review-r6b/claim-restart.mts claim`, log `/tmp/astra-review-r6b-claim-restart.log`:

1. Put an incomplete directory at the actual current process's `previewCachePath`.
2. Inject a single `EBUSY` rejection at `fs.promises.rm(ownSlot)`, modeling a transient removal failure. All other operations are real.
3. First preview fails cleanup and leaves `<ownSlot>.claim`.
4. Restore the real filesystem function. The second preview still fails with `preview cache is malformed and could not be safely removed; check was not run`, solely because the retained claim returns `EEXIST`. Maintenance skips this live owner.
5. A separate new process preview succeeds with a fresh slot; the stuck old slot/claim remains.

**Impact: prevents checks in the existing MCP process until restart/manual repair, rather than only retaining unused disk space. No unrelated checkout corruption was observed.** The injected first failure is explicit; the retry failure is production behavior without injection.

**Suggested change:** preserve enough ownership/outcome information to retry a claim still owned by this process, or abandon the failed cache generation and run the check in a fresh scratch tree. Do not broadly steal another process's claim or release an ambiguous in-flight deletion. Cover a one-shot cleanup failure followed by a successful same-process retry.

### T3 — should-fix: failed repair after adoption leaves the current slot permanently unusable

**Location:** `packages/room-mcp/src/tools/files.ts:931`, `:954–965`, `:980–997`.

Adoption renames the old checkout before repairing its backlink. If repair fails, the destination exists but its registration still points to the old name. Later setup sees the destination and skips adoption; `rev-parse --show-toplevel` succeeds at the new path, so it does not enter malformed-cache recovery. Locking the new path fails, and no later attempt retries the interrupted repair.

**Concrete sequence:** `/tmp/astra-review-r6b/repair-failure.mts`, log `/tmp/astra-review-r6b-repair-failure.log`:

1. Create a valid dead worktree.
2. Let adoption claim, lock, and actually rename it; inject exactly one failed `git worktree repair <ownSlot>` command.
3. Restore normal Git behavior. Second and third previews both fail at `worktree lock ... is not a working tree`; neither runs its check.
4. The locked registration still names the old slot, the old claim remains, and the new directory exists. Running real `git worktree repair <ownSlot>` manually immediately restores successful previews.

The additional `adoption-interrupt.mts` probe stops after the actual rename and observes the same retry failure. A full process death gives the next process a different destination: it can skip the now-foreign dead cache and build fresh, but leaves the interrupted registration and claim behind.

**Impact: same-process check availability; after a process restart primarily unreclaimed disk/registration state. No other checkout modification demonstrated in this ordering.** This is distinct from T2: the retained claim is at the old source path, while the new destination is blocked by its stale registration.

**Suggested change:** keep a durable or process-owned adoption record with original path, destination, and authenticated registration identity, and retry/finish that known relocation before reuse. Alternatively abandon this generation and fall back to a fresh scratch preview. Do not infer repair authority from an arbitrary `.git` pointer (T1/S2). Test one-shot repair failure and actual restart at the rename boundary.

### T4 — should-fix: one large live key starves every later cache key indefinitely

**Location:** `packages/room-mcp/src/tools/files.ts:840–859`.

On a slot-budget interruption, `keyCursor` subtracts one so the next pass begins at the interrupted key. Although `entryCursor` rotates within it, each pass scans a full circular traversal until the same 64-slot budget is exhausted. A key with more than 64 enduring entries never completes, so the key cursor never advances.

**Concrete sequence:** `/tmp/astra-review-r6b/edge-probes.mts starvation`, log `/tmp/astra-review-r6b-starvation.log`: create sorted-first key `00000000000000000000` with 65 live slots and sorted-later key `ffffffffffffffffffff` with one dead partial slot and vanished-clone metadata. Inject deterministic owner responses (live for the first key, dead for the later slot). Request and await 12 separate sweeps. Output: `ownersSeen: 65`, **`laterProbed: false`**, **`laterExists: true`**. The code repeats the same pattern indefinitely while the first key is unchanged.

**Impact: unused disk space/locked registration retention in later keys; no wrong test result or modification of a live checkout established.** Explicit preferred requests do not solve it: they alter spare retention only after a key is reached, and the preferred set is cleared at pass start.

**Suggested change:** advance the key cursor after a bounded slice even when that key has entries remaining; resume its entry cursor on a later round-robin visit. Preserve unserved preferred requests, or handle their bounded slice first. Add a multi-key test with more than 64 persistent entries in one key and eventual cleanup in a later key.

## Git behavior, ordering, normalization, and main-thread work

- **Machine:** Darwin, `git version 2.45.2`. Scratch experiment `/tmp/astra-review-r6b/git-edges.mts`, log `/tmp/astra-review-r6b-git.log`, uses real Git under `/tmp`.
- **Locked checkout:** `worktree remove --force` refuses; explicit `unlock` followed by `remove --force` succeeds. This matches the new normal removal sequence.
- **Missing `.git`, directory still present:** `worktree repair <path>` returns nonzero with `unable to locate repository; .git file broken`, but in this experiment it nevertheless reconstructs the `.git` file during its broader repair pass. A second repair, unlock, and remove succeed and delete the registration. Thus nonzero repair is not proof of no filesystem mutation. Room's original S4 reproduction passes by reconstructing first.
- **Missing entire folder:** repair returns `not a valid path`; targeted unlock and remove still succeed and delete its registration. The sweeper enumerates existing slot directories, so a completely vanished directory's locked registration is not found by this pass. This leaves metadata for manual cleanup, not a live-checkout deletion or preview failure.
- **Moved locked folder:** repair at the destination succeeds and updates `gitdir`; targeted unlock/remove then succeeds. The successful ordering is covered by the adoption/removal race; the interrupted ordering is T3.
- **Claims/order:** the atomic hard-link publish avoids an empty published token, and another process cannot delete a claimed source while adoption/removal is in flight. A dead owner's leftover claim is deliberately never stolen and normally only prevents that old slot's reuse/cleanup. T2 identifies the separate case where the process remains alive and its fixed destination is blocked. Failures after publication can also leave private `.tmp` or old claims, which are conservative disk residue rather than independent destructive findings.
- **Path normalization:** `/tmp`, `/private/tmp`, and an additional symlink to the same clone produce exactly one cache path; all three previews pass, with the latter two reporting cached reuse. See `path-aliases.mts` and `/tmp/astra-review-r6b-path.log`. Missing-`.git` cleanup also passed with a `/tmp` input and canonical `/private/tmp` cache. Canonicalizing parent paths is useful; following the `.git` leaf is the T1 mistake.
- **Main thread/bounds:** new sweep filesystem probes use `fs.promises`; the former per-metadata `existsSync` is gone, and the slow-owner-probe responsiveness regression passes. Existing synchronous work remains in `canonicalPreviewClonePath` (`:555–559`), dependency directory enumeration/linking (`:415–458`), and merged-file writes (`:464–530`). These can block on a slow filesystem, but I did not establish a new measured main-thread stall from the round-6 cleanup rewrite. The 2-second sweep budget is cooperative: complete `readdir`/sorting, metadata reads, and a targeted Git teardown can outlast it; it is not a hard total-duration deadline. Foreground cleanup no longer awaits that maintenance. T4 is the reproduced progress defect.

## Cumulative pass and validation

The final source pass covered fresh-room admission, push ancestry/history and catch-up status, Codex turn scanning/wake receipts, preview names/partial evidence/generation handling, dependency relinking, claim graph readiness and conflict notices, landed-worker claim freshness, shutdown, plugin selection, and shared-checkout collection/retirement. In particular, collection still publishes source refs before the final destination identity gate and has no await through its write loop; shared-owner cleanup checks retirement/preservation state rather than treating those refs alone as proof of successful collection. No additional concrete finding was established outside T1–T4. No new live host wake/routing/API experiment, plugin rebuild, or model-based host eval was performed; host claims remain limited to the supplied dated evidence.

- Focused cache suite: **30 tests / 4 files passed** (preview cache races, cache slots, run cache, worker preview cache). Log: `/tmp/astra-review-r6-tests.log`.
- Broader cumulative suite: **447 tests / 16 files passed** (collection, conflicts, carried work, preview names/manifest, wake turns, lifecycle/worker cleanup, shutdown, tool budget/tools, hub admission, base branch/resolution, areas and base messages). Log: `/tmp/astra-review-r6b-regression.log`. The round-5 intermittent contract re-entry test passed in this batch.
- Total: **477 tests / 20 files passed**. Each Vitest batch used `--maxWorkers=1`; heavy batches were staggered. `nice -n 10` was attempted but `setpriority` was denied by the sandbox.
- Scratch scripts use real temporary Git repositories and current source. Fault injection and owner-probe latency/results are identified above; none of the destructive symlink observation was injected. Probes print observed outcomes, including failures, rather than presenting every script as a passing assertion suite.
- The `tsx` CLI initially failed with sandbox `listen EPERM` on its IPC pipe. Re-running via `node --import tsx` avoids that listener and completed the probes. Socket-dependent integration suites were not run as evidence; local listeners are unavailable in this sandbox.
- Required `room_preview_merge(people:["rohanz"])` completed without conflicts at common ancestor `742e176067`: only this report differed, and no tests were requested for that document-only merge preview.
- Final `git diff --check` passed; this report is the only changed repository path. No source/test edits, commits, or pushes.

**Final verdict: not ready to sign off.**
