# Independent implementation review: worker checkout ownership

Reviewed 2026-11-11 by `astra-ownership`. **Verdict on c7c2620c: not ready to land.** The replacement of capture with retention in place fixes important cases and keeps ordinary collection usable, but the recovery-pin protocol can still lose a commit, discard restart can deadlock, and several cleanup paths do not meet the stated rule.

Target: **c7c2620c205a910ed5ffec3ecd2b90e69b6290f7**, merged into this review worktree as c9dd4e92. Source line numbers below refer to that target, not the author's subsequent fixes. `D` means `docs/superpowers/2026-11-11-worker-checkout-ownership.md`. The previous design review remains unchanged beside this file. I made no production changes. The ordinary failing regression tests are committed in **32684867**, `packages/room-mcp/test/astra-ownership-review.test.ts` (hereafter `T`); an additional passing operation-admission reproduction accompanies this report. They deliberately are not `it.fails` tests.

The lead clarified during review that abandoned, reflog-only history is an existing history-retention limitation; the promised preservation is the operation's current direct branch tip and its reachable ancestry. The recovery-pin race is in scope. Dependency rollback losses are in scope for the inventory, but their presence in v0.17.47 must be distinguished from new regressions. I applied those rulings, rather than silently expanding the requirements.

## Validation and what passed

Environment: macOS, Git **2.45.2**, Node **22.23.4**, Vitest **5.0.0**. Tests use temporary real Git repositories; lifecycle process probes use the repository's synthetic fixtures. No real worker processes were killed. Commands were foreground, with at most two Vitest workers. This is not Windows, cross-volume, power-loss or a full release-suite result.

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER ./node_modules/.bin/vitest run \
  packages/room-mcp/test/worker-ownership.test.ts \
  packages/room-mcp/test/spawn-cleanup-limitations.test.ts \
  packages/room-mcp/test/spawn-stale-registration.test.ts \
  packages/room-mcp/test/worker-preparation.test.ts \
  packages/room-mcp/test/worker-deps.test.ts --maxWorkers=2
```

Result: **5 files passed; 77 ordinary passes, 2 expected failures, 1 skip; 133.49 s**. Of the original seven sequences, six are ordinary passing tests and only sequence 4 remains expected-failing. The other expected failure is the separately approved empty-directory mkdir/first-stat boundary.

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER ./node_modules/.bin/vitest run \
  packages/room-mcp/test/astra-ownership-review.test.ts --maxWorkers=1
```

Result on the final test file: **14 failed, 13 passed, 27 total; 35.54 s**. All failures are reproduced assertions described below, including three bounded five-second restart failures. An earlier fixture-only mock error and scratch-path canonicalization error were corrected and rerun; neither is counted as a product finding. Whitespace checks passed. Production was unchanged, so I did not rerun the full build/release suite.

Passing evidence includes:

- Real-tool committed-worker collect, discard, keep then plain collect: branch gone, tag immediately reusable, no retained-item warning (`worker-ownership.test.ts:190,242,341`). These use the real cleanup implementation, not the lifecycle fixture's default cleanup stub.
- Initial symbolic branch refusal; exact-name non-dereferencing deletion preserving the symbolic target; later different-tip movement retaining the new branch; failed recovery-ref write retaining the branch.
- Existing conflicting direct or non-dangling symbolic recovery refs retained; same-tip packed recovery ref reusable; a pin changed immediately after its write detected before branch deletion (`T`).
- Stable recovery pin surviving GC injected immediately before branch deletion and GC again afterward. This proves reachability at the tested command boundary, not arbitrary concurrent `gc --prune=now` against an unrelated actor deleting the branch before the operation can pin it.
- Marker validation after `git worktree move`, raw rename followed by `git worktree repair`, and a case-equivalent path on this host's filesystem. Those operations preserve the root/admin identities. This does **not** claim the registry automatically updates its recorded worker path after an external move; the existing canonical worker-path rule still applies.
- v0.17.47-shaped established markerless records collect and discard successfully, including commits, branch deletion and immediate tag reuse. These are compatibility fixtures, not an installed-old-plugin end-to-end run.
- Separate retained diagnostics remain visible after the worker record/session disappears.

## Findings with failing tests

### 1. Pin verification and branch deletion are separate transactions

**New, release-blocking content loss.** `worker-refs.ts:100-106` reads the recovery ref, then independently invokes branch CAS at `:43`. Change the recovery ref to another commit after that read but before `update-ref -d`. The branch still equals the operation OID, so deletion succeeds. Expire reflogs and run GC: the preserved operation commit is gone.

`T`: **“a recovery pin changed after verification cannot authorize erasing its last branch”**. The injected command is `git update-ref refs/room/recovery/review/<tip> <base> <tip>` immediately before Room's branch delete; then `git reflog expire --expire=now --all`, `git gc --prune=now`, `git cat-file -e <tip>^{commit}`. The last command fails. The test asserts that injection actually ran and understands both a direct `-d` command and a future `--stdin` transaction.

D:80-84 therefore overstates the proof. The accepted operation-time read policy is reasonable **only if pin protection and branch deletion are one non-dereferencing ref transaction**. On this Git, the author reports that transaction `verify` can still follow symbolic refs; do not substitute an untested verify-only transaction. A conditional direct pin update plus branch deletion in the same transaction can ensure the tip remains rooted at the deletion point. Test direct, symbolic and dangling replacements at the transaction boundary, including the referenced target remaining unchanged. Changes to the pin *after* a successful atomic deletion are a later actor's action, not this race.

### 2. A dangling symbolic recovery ref is overwritten

**New protocol violation.** `worker-refs.ts:79-83` uses `for-each-ref`, which omits dangling symbolic refs, to decide a recovery name is absent. `update-ref --no-deref <pin> <tip> <zero>` then replaces the dangling symbolic ref. The branch-side fallback checks `symbolic-ref` at `:71`; the recovery side lacks it.

`T`: **“an existing dangling symbolic recovery name is a conflict, not an absent name”**. Create `git symbolic-ref <pin> refs/heads/not-created`, call `preserveWorkerBranch`, and require refusal plus the same symbolic target. Actual receipt has no refusal and the symbolic name becomes direct. This contradicts D:75-76. It does not itself erase a reachable target commit; it is distinct from finding 1.

### 3. Borrower inheritance still overwrites a foreign target pin

**Incomplete repair of a pre-existing route.** Removing missing-source target deletion was correct, but `inheritWorkerRefs` at `worker-git.ts:209-215` now calls `writeWorkerRef` without an expected old value whenever a source exists. `worker-refs.ts:22-26` permits unguarded private-ref overwrites, then records the overwrite as authority for later deletion.

`T`: **“a borrower does not overwrite an existing target pin when its source is present”**. Seed `refs/room/carry/owner=<base>` and `refs/room/carry/retry=<unique-tip>`; inherit; retry is overwritten with base. The old `v0.17.47:worker-git.ts:135-140` also overwrote existing targets, so this is not a newly introduced loss. The revised design's generalized receipt claim is nevertheless incomplete. Audit the same helper's carry and collection callers (`worker-git.ts:389,561`, `tools/collect.ts:769-770`): passing through one helper is not a proof when that helper allows unconditional writes. Use create-only writes for new names and conditional writes from an independently recorded expectation for replacements; retain conflicts.

### 4. Dependency rollback retains a child, then deletes its parent recursively

**Confirmed pre-existing data loss, inaccurately claimed fixed.** `worker-deps.ts:245-250` skips a replaced child, but subsequently recursively removes an unchanged parent it created. The retained child's foreign bytes disappear anyway. A newly added child under the owned `.bin` directory also disappears without triggering the replacement check. D:54-55 is false for both cases.

`T`: **“dependency rollback preserves replaced-child/new-child inside an unchanged parent”** (two failures). During linking, replace the first created `@fx/a` symlink with a directory containing `precious.txt`, or add `precious.txt` under `.bin`; throw on the subsequent `@fx/b` link. The resulting rollback says it failed, but the file is gone. Parent inode preservation does not authorize recursively deleting arbitrary descendants.

I independently loaded the exact `git show v0.17.47:packages/room-mcp/src/worker-deps.ts` implementation in a throwaway module, using the same real workspace fixture and injections. Both cases also returned `linked:false` with `preciousSurvives:false`. Historical `:241` used recursive rollback with no identity checks. Fix by remembering created leaves, unlinking only verified leaves and using nonrecursive `rmdir` for parents; a retained or new child must prevent parent removal.

### 5. Restarted discard can wait on its own registry initialization

**Release-blocking recovery failure; mixed old/new paths.** `registryForDir` caches a pending `WorkerRegistry.open` (`worker-registry.ts:49-57`). `FileWorkerStore.open` awaits `reconcile` (`worker-file-store.ts:205-208`), which awaits discard replay (`:1339-1343`). Replay calls cleanup/prune (`:1128-1133`); those call `registryForDir` on that same pending initialization (`worker-git.ts:626-628` or newly `:242-243`). Neither can finish.

`T`: **“durable discard receipt survives restart at receipt/checkout-removed/branch-deleted”** (three failures). A real worker commits, exits, acquires a discard operation and durably enters discard. Simulate each disk boundary, mark the operation holder definitively dead, close the registry, and reopen. Reopening does not settle within five seconds. Tests remove the pending cache entry on failure so teardown does not hang; no background process or timer is abandoned. The pin-only crash case passes.

The present-root `cleanupWorker -> registryForDir` cycle is already visible in v0.17.47 source (`worker-git.ts:470-480`, `worker-file-store.ts:1183,1397`); I did not run that entire old startup stack. The missing-root helper's registry re-entry is added by this change. Pass the already-opening store/reader into internal replay cleanup rather than reopening it. The durable receipt alone does not establish restart correctness.

### 6. Resolved diagnostics and ref-write receipts accumulate indefinitely

**New unbounded metadata growth and stale reports.** `worker-retained.ts:36-46` reads every retained JSON file and filters absent targets only in memory. It never retires those diagnostic files. `worker-refs.ts:27` writes one receipt per ref name; successful deletion does not remove it. `local-state-gc.ts:76-78` leaves both new directories to their owner, which has no GC implementation.

`T`: **“resolved retained-item diagnostics are eventually reclaimed by local GC”**, **“authorized ref receipts do not accumulate after their refs are deleted”**, and **“a resolved retained path is not reported against a later healthy generation”** (three failures). Eighty resolved items/receipts remain after GC at simulated +90 days. A path observed absent, followed by GC and reuse, resurrects the old generation's warning.

Separate durable diagnostics correctly survive worker-record removal. Keep that property, but give confirmed-absent metadata a writer-owned reclamation route and bound/paginate scanning and display. Do not expire retained content or permanent recovery refs as a side effect. Simply limiting output while scanning/parsing every file would leave the work unbounded. A retained item's presence must not be confused with a later generation forever.

### 7. Tag-sidecar deletion and artifact replacement bypass creation evidence

**Pre-existing omissions from the claimed coverage.** `cleanupWorkerLogs` at `worker-git.ts:739` removes `.room/workers/<tag>` sidecars by tag after record/tag checks, with no file creation receipt. `worker-artifacts.ts:36` removes an existing artifact before writing it with `wx`. A worker-record guard establishes which worker is being cleaned; it does not establish who created the current file.

`T`: **“an unowned replacement log is not erased merely by its worker tag”** and **“artifact regeneration does not overwrite a foreign replacement file”** (two failures). Both erase/replace the injected foreign bytes. The same operations are present at `v0.17.47:worker-git.ts:605` and `worker-artifacts.ts:36`. These are not the documented checkout verification/use race: the contents can be replaced long before cleanup starts. Either close them or explicitly list them as pre-existing file-level exceptions; do not claim every worker-path deletion follows one rule.

### 8. Repeated scratch saving recursively erases added foreign children

**Pre-existing overwrite policy not fixed by the new root receipt.** `worker-git.ts:812-820` verifies the `.room/scratch/<tag>` root then recursively deletes everything beneath it. A different process need not replace the root or forge the receipt; it can add a file after the first save.

`T`: **“repeated scratch saving preserves foreign children of its unchanged owned root”**. Save `output.log`, add `precious.txt` in the saved folder, save again. The added file disappears. The test canonicalizes its source root to avoid this host's `/var` alias being rejected by path containment. Prefer a fresh save generation or refusal of an existing folder; root ownership is not descendant ownership. The old implementation already replaced this folder recursively; this is an incomplete coverage claim, not a new regression.

## Original findings and the seven documented sequences

Old design finding 1 is closed within the expressly accepted empty mkdir/first-stat boundary: `worker-git.ts:472-476` performs exclusive mkdir, records root identity before add, and compares it after add. A pre-existing empty directory is refused. Nonempty replacement before add preserves the foreign files. Old finding 2 is closed for the reproduced different-name symbolic-target deletion: mutations use `--no-deref`, and the target-preservation tests pass.

Old finding 3 is **not closed under the old provenance contract** by recording a newly observed foreign tip. The lead has now explicitly changed the established-worker policy to content preservation: such a branch name may be deleted if its observed commit remains pinned. Preparation rollback still uses creation/carry expectations and passes the different-tip refusal test. The passing `T` case **“a different tip installed before operation admission is preserved before its branch is removed”** reruns the old remove/recreate reproduction on a real established worker: discard removes the branch, its replacement commit remains under the recovery ref, and survives reflog expiry plus GC. D:82-83 should describe this changed contract accurately, rather than suggesting the original review only objected to unreachable objects. Under the accepted new contract the stable-pin case works, but finding 1 prevents declaring the complete fix sound.

| Original sequence | Result at c7c2620c | Exact barrier or remaining boundary |
|---|---|---|
| 1. Discard markerless intent | Ordinary pass | Unfinished origin is retained through phase change; `verifyWorkerCheckout` requires new evidence rather than legacy fallback. |
| 2. Discard markerless preparing | Ordinary pass | Same evidence requirement; replay does not fabricate a missing creation marker. Restart liveness is separately broken by finding 5. |
| 3. Late markerless replacement promoted at prepare-finish | Ordinary pass | Finish/promotion revalidates original root and marker instead of granting authority solely from phase/path. |
| 4. Replacement after final verification, before removal | **Expected failure** | Synchronous adjacent check does not atomically bind Git's pathname removal. D:138-140 explicitly admits checkout/admin replacement. |
| 5. Different-tip branch replacement after checkout removal | Ordinary pass | Recorded preparation/operation OID is used for exact-name CAS; different value cannot be deleted. Recovery-pin race is a separate missing case. |
| 6. Foreign detached stale registration | Ordinary pass | Spawn requires a verified Room marker and ended/absent owner before targeted admin deletion; no spawn global prune. |
| 7. Root reappears during stale-registration cleanup (clean/ignored) | Ordinary pass | Marker/root checks refuse reappeared root before admin removal. Tests actually execute their injected recreation and assert it happened. |

The four stated boundaries are explicit in D:142-151. The legacy shorthand there must be read with D:120-125's **all recorded facts match**, including an existing marker; it is not blanket permission for any same-path/same-branch legacy replacement. The post-add exception starts after successful add and is restricted to Room's own branch. The mkdir/stat exception is expressly empty; pre-existing mkdir targets refuse and nonempty replacements are not deleted. No native helper is introduced. The last-check/use exception includes the raw admin `rm` at `worker-preparation.ts:118`, not merely the Git executable's removal: describe it as checkout/admin removal consistently.

## Removal and ref inventory

I searched all `packages/room-mcp/src` for worktree remove/prune, branch deletion, `update-ref`, `rm`, `rmSync`, `rmdirSync`, and followed indirect cleanup callers. Merely finding a call to the centralized helper is insufficient: findings 1–4 show why.

| Site at target | Assessment |
|---|---|
| `worker-preparation.ts:98-102` | Verified preparation removal plus recorded branch CAS; admitted check/use race remains. |
| `worker-preparation.ts:105-118` | Targeted missing-root admin deletion with marker/admin/common/backlink/lock checks. Uses recursive admin `rm`, not a Git identity-selector command. |
| `worker-git.ts:430-448,472-479,587`, preparation rollback/fallback | Exclusive root and marker policy; stale admin is targeted, no forced attachment or spawn global prune. |
| `worker-git.ts:703-705` | Established checkout final verification followed by removal; pin/branch race and private-ref issues remain as above. |
| `worker-file-store.ts:1128-1134,1181-1212` | Discard and preparation replay route through these helpers. Restart cycle prevents discard replay completing. Patch temporaries `:1009,1030` and metadata `:938-948,1268-1269,1393` have their own lifecycle ownership, not checkout authority. |
| `retire.ts:108,149,186,294,324,380` and `tools/collect.ts:200,356,362,479,505,564` | Reach shared checkout/prune helpers, but the vanished-retirement route at `retire.ts:293-298` does **not** acquire an operation lease first. `pruneMissingWorkerWorktree:244` can take a fresh fallback observation. D:67's universal lease-acquisition claim is not established for this route; sent to owner. No additional content-loss reproduction is claimed for this source-level discrepancy. |
| `worker-git.ts:209-222`, `worker-refs.ts:22-52`, `tools/collect.ts:769-770` | Missing-source inheritance deletion removed; present-source overwrites remain. CAS deletion/restore is non-dereferencing, but private writes are not all conditional. |
| `worker-deps.ts:243-250` | Recursive ancestor rollback defeats child preservation (finding 4). |
| `worker-git.ts:739`, `worker-artifacts.ts:36` | Sidecar/artifact omissions (finding 7). Retirement/collect callers inherit these weaknesses. |
| `worker-git.ts:778,820` | Discard verification scratch envelope kept when verified checkout cleanup fails; repeated saved-scratch replacement still loses foreign descendants (finding 8). |
| `worker-git.ts:391,500`, `worker-refresh.ts:96`, `tools/collect.ts:182,674`, `merge.ts:81`, `preview-evidence.ts:48,209` | Private temporary index/patch/merge/staging cleanup, not public worker worktree removal. No capture layout or new Git registration is authorized by these temp paths. Their root privacy is not a general proof about another actor's descendant writes. |
| `local-state-gc.ts:94` | Existing metadata GC, no general worker-worktree remover. New receipt/diagnostic namespaces have no reclaim policy (finding 6). |
| `tools/files.ts:1021-1026` plus preview setup/reset/eviction callers; `preview-cache.ts:224` | Explicitly excluded preview lifecycle. It still removes by path and globally prunes, including through worker cleanup's `removePreviewCache`. The exclusion is clearly documented at D:166-176; no repository-wide guarantee follows. |

Other searched deletions concern coordination files (arbitration, policy, choices, hook receipts, watchdog profiles), not worker checkout/registration/branch ownership. I found no additional direct worker branch `-D` execution outside the new ref helpers; `worker-git.ts:89` is advice text, not an executed command.

## Crash, restart, GC and compatibility

There is **no capture/private checkout destination** in this revision. No cross-filesystem rename, rebinding of `commondir`, quarantine recovery or capture-capacity reservation is necessary. Ordinary roots stay at their recorded path. This removes the old capture design's stranding and downgrade failure modes.

| Interruption point | Durable state and required behavior | Evidence/limit |
|---|---|---|
| Before/after exclusive root mkdir, before root journal | At most an empty unreceipted root; no guessed deletion. | Root must be retained/reported. Missing identity cannot be called legacy. |
| After root receipt, during Git add, before marker | Root/partial registration or branch may exist. Root receipt alone does not prove successful owned Git attachment. | Retain on doubt; restart never fabricates a marker. |
| After marker, before preparation record update | Admin marker and root identity exist; record may still describe partial preparation. | Safe to leave resources if durable facts are insufficient; no lost “cleanup intent” authorizes public-path reconstruction. |
| After operation branch read, before recovery write | Branch remains; no cleanup yet. | If a different actor first removes all roots to that commit, an aggressive GC may defeat pinning; failed pin must retain, never grant deletion authority. Not a universal guarantee against the other actor's own deletion. |
| After recovery write, before operation/phase receipt | Pin can be orphaned; current worker still active. | Pin-only restart test passes. An orphan recovery ref is retained indefinitely. A later fresh operation may take a new read because no cleanup was durably begun. |
| After durable discard receipt, before checkout removal | Record retains original OID/pin; retry should revalidate marker/root and use original OID. | Receipt-stage restart deadlocks (finding 5), so this claim is not validated by the happy path. |
| After checkout removal, before branch deletion | Pin and branch remain; marker/admin may already be gone. | Must not infer authority from a newly observed tip. Checkout-removed restart deadlocks. No destructive restoration of the public path. |
| After branch deletion, before record step update | Recovery pin remains; branch absent. | Branch-deleted restart deadlocks. Correct replay must treat absence idempotently and retain any later different-value branch. |
| Collect interruption | Existing reconciliation marks collecting active/interrupted, since partial apply may remain. | This is not automatic replay of the collect transaction; keep original preservation evidence while requiring user retry. |
| Lock/I/O failure during verification/removal | Worktree/admin/root can be left wholly or partially present. | Report/retain; no double-force override or restoration into public path. Windows open-handle behavior was not run. |

Recovery writes that return successfully but have already been changed are detected by the later check in the tested case. The gap between that later check and branch deletion is finding 1. Same-tip packed refs work. Non-dangling symbolic recovery names are rejected, dangling names are not. Non-dereferencing branch CAS protects a different symbolic target, and same-name/same-OID ABA remains explicitly accepted.

The passing **“operation pin preserves the current tip, not abandoned worktree-only reflog history”** test creates a worker commit, resets the worker to base, expires only the branch reflog, and runs GC. The abandoned commit survives through the worktree's `logs/HEAD`. Remove the worktree, preserve/delete only its current branch tip, and GC again: the abandoned commit is gone. This matches the lead's accepted existing history-retention limitation. State that limited promise clearly instead of saying “nothing becomes unreachable.”

Upgrade has no v2 migration: optional evidence stays in v1 records. The two old-shaped established-worker compatibility tests pass. New identity-required records must never use legacy fallback. On downgrade, v0.17.47 can read v1 records but does not enforce these new checks or show new retained diagnostics; unknown optional fields/markers are not a safety interlock. Old cleanup/prune behavior returns. There are no new quarantined checkout payloads to strand or have old GC age away, unlike the rejected capture design. Do not advertise downgrade as preserving the new guarantee. Supported storage must supply the required stable observable identity; inode generation reuse and power-loss/storage guarantees remain explicitly unproven, not tested successes.

## Reporting, growth and size of the change

Retaining replies and `room_state`/`check=true` identify paths and reasons via independent registry diagnostics. That persistence is necessary when a worker record disappears, and the test passes. It also needs the metadata reclamation and bounded reading in finding 6. Content retention itself cannot have an automatic deletion deadline under the requirement; use visibility and an explicit user cleanup decision, not time-based disposal of uncertain bytes.

Permanent recovery refs now arise at **operation acquisition**, including successful keep, an operation later refused/failed, and tips already reachable from the lead. Previously cleanup pinned selected unmerged output later. “No expiry” is unchanged, but creation frequency and reachability cost are not: one ref per `(tag, OID)` can accumulate without bound, pinning that commit's entire reachable history. An operation-time read can intentionally pin a different actor's current branch tip under the newly approved content contract. A failed operation can leave a ref with no completed worker cleanup. The extra ref-write receipt persists too. The lead must accept this increased retention or choose an explicit, conservative reclamation policy; the review does not authorize expiry.

Retain in place is materially smaller and easier to reason about than capture. The old move journals, cross-volume placement, admin rebinding, v2 record migration and capture budget should stay removed. Further simplifications that preserve the guarantee:

- Refuse an existing saved-scratch folder, or use a fresh generation, instead of retaining an in-memory map to justify recursive overwrite. This also removes the map's 1024-entry behavior and finding 8.
- Skip dependency rollback of uncertain parents; nonrecursive cleanup is sufficient. No capture machinery is needed.
- Recovery refs are never automatically deleted, so their successful-write receipts need not be kept forever merely to authorize a deletion that never occurs. Keep only the evidence required by operation replay and other refs' conditional deletion; remove redundant resolved metadata safely.
- Pass the existing store into replay cleanup instead of adding another registry lifetime/cache mechanism. Require receipts at destructive call sites rather than treating fallback observations as a universal lease protocol.

The new failure surfaces are ref-transaction ordering, extra permanent refs/receipts, diagnostics on hot tool paths, and registry initialization re-entry. Marker/root checks add intentional refusal on unsupported or changed identity; tests on actual supported Windows/storage environments remain necessary before claiming healthy-worker portability.

There is no longer a five-stage capture rollout to approve. For the revised stages, install evidence and conservative retention first, cover **every** destructive adapter, then enable atomic pinned branch deletion; each intermediate stage must retain on unavailable authority. Do not enable branch deletion after merely adding a separate pin read/write helper. The committed failures must be ordinary passing tests before claiming their cases fixed. Keep only the two expressly approved expected-failure cases, and distinguish the original seven from newly discovered limitations.

## Integration evidence and remaining decisions

The first final-phase peer preview included **rohanz+ownership (rev 70)**, **rohanz+gate-stall (rev 42)** and **rohanz (rev 237)**. It was **partial and did not run tests**: seven production files conflicted because the review's authorized c7c2620c merge appears as a competing snapshot against the author's newer fixes. Generated bundles were excluded. Two later attempts with the same named peers were invalidated by their inputs changing during preview, including Git HEAD, sharing coverage, ownership tests and GC code; neither checked the combined code. I notified both owner and lead. This is not evidence against those unreviewed fixes, and not a passing combined-tree result. Collect the authored test/review commits onto the corrected implementation rather than restoring this pinned production snapshot. `rohanz+waits` and `rohanz+astra-gate` were not separately selected: their selector/gate review outputs do not modify this review's tests, and relevant live gate implementation was explicitly included. Offline unrelated peers were not included.

The author has acknowledged the pin, inheritance, dependency, restart and metadata issues and is changing the implementation. It also confirmed the vanished-retirement lease gap and will add operation admission there; historical direct-helper fallback is not intended to replace lifecycle admission. This report intentionally does not certify a moving branch. The owner needs to run the committed reproductions on its final code; the lead still owns the integrated/release checks.

Decisions reserved for lead/human:

1. **Pre-existing file/ref-loss routes:** fix findings 3, 4, 7 and 8 in this change, or explicitly track and document them outside its reduced guarantee. Recommendation: fix the small nonrecursive/create-only cases now; do not quietly call them the sole checkout check/use limitation.
2. **Permanent pin growth:** accept the greater rate and scope of indefinite recovery retention, or define user-controlled cleanup/visibility. Recommendation: expose refs and recovery instructions, reclaim only resolved metadata now, and decide expiry separately.
3. **Guarantee wording:** retain the lead-approved current-tip content contract and its reflog-history limitation, with the four boundaries and checkout/admin check/use gap stated narrowly. Recommendation: correct D:82-83 and add the exact pin atomicity requirement, rather than imply the old provenance objection disappeared without a contract change.
4. **Supported-platform release scope:** determine the required Windows/open-handle/storage validation before claiming platform-complete recovery. Recommendation: require that evidence or explicitly limit the claim; preserve uncertain data on failure. The retirement lease fix is an acknowledged implementation task, not a permission decision.

The new recovery-pin loss and broken restart are sufficient to reject the pinned implementation even if all pre-existing inventory findings are deferred by the lead. **Not ready to land.**
