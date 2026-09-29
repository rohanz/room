# Rehearsal fixes — review round 3, 2026-09-30

Reviewed `b9618ce..6fc22bc`, with a final source pass over `0aef465..6fc22bc`, at HEAD `6fc22bccdc4f64d860f97533b1d8d4e94b64d753`. Read both preceding reports and the dated rehearsal rerun. Adapted the surviving round-2 reproductions into `/tmp/astra-review-r3/`. Only this report was written in the repository; no source or repository test files were changed.

**Verdict: not ready to sign off. Findings: 2 must-fix, 2 should-fix, 0 nits.**

## N1–N5 disposition

| Round-2 finding | Result at 6fc22bc |
| --- | --- |
| N1: last borrower collection deletes ignored output | **Original reproduction fixed.** Late ignored output survives, its path/reason is reported and archived, and explicit owner discard requires `force` for ignored artifacts. Last-borrower discard now retains the owner rather than authorizing its cleanup. The new remaining-work check misses committed output added after the collection snapshot; see P2. |
| N2: old live recovery gate revoked, acquired handle lost | **Original reproduction fixed; protocol still unsafe.** The adapted two-caller age test now gives the first caller the cache, the second a fresh tree, leaves no lock, and permits cache removal. Gate-release failure coverage passes. A delayed dead-gate recoverer can still move a replacement live gate away and admit two owners; see P1. |
| N3: crash between exclusive open and token write leaves empty lock | **Fixed in exercised cases.** New tokens are fully written before exclusive link publication. The adapted day-old empty-lock case is reclaimed and cache removal succeeds. Repository tests also reclaim aged empty-file and legacy-directory gates. |
| N4: older preview overwrites newer evidence | **Fixed.** The adapted older-success-after-newer-refusal case passes, as do both repository overlap directions. All `lastPreview` assignments in this handler go through the generation guard, and the successful preview note is guarded. Generations belong to the Session object, so recreating handlers does not reset them. |
| N5: extra synchronous whole-registry scans | **Original scan regression fixed; correctness gap remains.** Re-running the 1,000-record counting fixture using the trusted ID gives **2 worker-record reads**, about **0.82 ms**, versus round 2's 2,006 reads. Running/untrusted workers avoid the extra lookup. The new `freshness` status calculation assumes processes are dead; a resume during the initial trusted lookup can evade the fence (P4). |

## Findings

### P1 — must-fix: dead-gate recovery temporarily steals a live gate, admitting two cache owners and resurrecting a released gate

**Location:** `packages/room-mcp/src/tools/files.ts:657`, `:662–668`, and `:698–699`.

Tombstone verification happens **after** renaming the canonical gate. Discovering that the moved inode belonged to a live rival cannot undo the interval when the gate name was absent. The gate-token read before replacing the lock is also separated from that replacement by an await.

A concrete interleaving, reproduced using the actual `runInMergedTree` implementation:

1. R reads dead gate D and pauses immediately before renaming it.
2. A recovers D, publishes live gate A, validates the dead cache lock and its gate token, then pauses immediately before replacing the cache lock.
3. R resumes its old rename, moving **A's live gate** into R's tombstone. R pauses before checking/restoring the moved inode.
4. B sees no gate, acquires gate B, replaces the still-dead cache lock, and starts checking its `second` tree.
5. A resumes after its already-completed gate check, replaces B's live cache lock, resets the same checkout and writes `first`.
6. B reads `first`, then its cleanup resets the checkout. A reads `base`. Both report cached-tree execution.
7. After A has attempted to release its now-absent gate, R restores gate A from its tombstone. That gate names a live process but has no remaining release handle. Later cache removal refuses it; the cache stays unavailable until the process dies or someone intervenes.

**Evidence:** `/tmp/astra-review-r3/gate-race.mts`, output `/tmp/astra-review-r3-gate.log`. A and B both return `passed: true` with `(cached base)`; their diagnostic reads are `base` and `first`, respectively. The script deliberately prints a synthetic `1 passed` summary to demonstrate that the API can endorse checks on the wrong tree; these are not real passing application tests. The final directory listing contains `.lock.recover`, and `removePreviewCache` throws `preview cache is in use or its lock is uncertain`.

The injected delays only order real filesystem calls; they do not replace tokens or forge ownership results. The repository's two-dead-gate test pauses **after** the first rename and therefore misses a delayed rename acting on a replacement gate.

**Suggested fix:** use a protocol in which a stale recovery attempt cannot remove a replacement live owner's exclusion primitive. A read/rename/verify/restore sequence does not provide that property, and another pre-rename read would leave the same race. Prefer a proven OS-backed lock, or immutable per-owner cache generations so recovery never mutates a tree another owner may use. Conservatively falling back to a fresh tree on uncertain residue is safer than stealing the gate. Test the three-owner ordering above and restoration after the displaced owner has already released.

### P2 — must-fix: remaining-work preservation ignores newly committed, uncopied output

**Location:** `packages/room-mcp/src/worker-git.ts:39–43`, invoked at `:370`; final removal at `:377–378`.

`uncollectedWorkerPaths` enumerates changes against the worker's **current HEAD**, plus untracked files. A file committed after collection's final source snapshot is in neither set, even if it is absent from the lead. The common cleanup boundary then force-removes the retained owner checkout and deletes its branch without a recovery patch.

**Concrete scenario:** collect owner `port-fix` while `port-bools` runs. Finish and collect the borrower. After its output has been applied, but during the awaited borrower retirement/projector step, another local process creates and commits `late.txt` in the retained owner checkout. The subsequent owner cleanup sees a clean HEAD and deletes the uncopied file and checkout. Room's operation lane excludes Room spawn/resume operations, not ordinary Git or editor activity in the checkout.

**Evidence:** the two `REVIEW late output survives cleanup (committed=%s)` cases in `/tmp/astra-review-r3/ignored-probe.test.ts`, output `/tmp/astra-review-r3-committed.log`. The projector seam schedules the local write at that actual awaited boundary. Identical uncommitted output is preserved and reported as `uncollected work: late.txt`; committing it produces `leadHas: false, workerHas: false`. The committed assertion fails. The tool only reports:

```text
Changes from port-bools: already present. Nothing committed or staged.
detached port-bools; the worktree belongs to port-fix
```

Git objects may remain recoverable by SHA/fsck until pruning, but the checkout and its branch are removed without telling the user or supplying a recovery handle.

**Suggested fix:** include changes from the collection's captured worker HEAD/baseline through the current HEAD, and revalidate that captured HEAD before destructive cleanup. Compare the resulting current paths with the lead, or retain the checkout/recovery ref whenever new commits appeared after the checked snapshot. Add the committed variant beside the late-untracked/ignored tests. Do not equate a clean worktree with collected output.

### P3 — should-fix: preview lock identity checks introduce synchronous subprocesses into startup and contention

**Location:** `packages/room-mcp/src/tools/files.ts:594`, `:612`; implementation in `packages/relay/src/process.ts:22–24,55–61`.

`probeProcess` is synchronous. On macOS it calls `execFileSync` for `ps lstart`, `sysctl kern.boottime`, and `ps comm`, each with a 3-second timeout. The first invocation now occurs while importing the files tool module. Live-lock/gate contention and stale recovery invoke it again on the MCP event loop. Linux instead performs synchronous `/proc` reads. A slow probe therefore delays unrelated tools, receipts and timers even when the contender will fall back to a fresh tree.

This is **not** a claim that every uncontended acquisition probes: the free-lock link path does not. It affects module initialization and paths through `deadPreviewOwner`, potentially several times during recovery.

**Evidence:** `/tmp/astra-review-r3/sync-probe.mts`, output `/tmp/astra-review-r3-sync-probe.log`. A deterministic process-command fixture delays each probe command by 60 ms and returns valid identity text. Import performs all three synchronous commands. A live-lock contention attempt performs all three again and produces a **194 ms maximum gap** in a 1 ms interval before using a fresh tree. These are injected latency measurements, not a claim about normal host command latency.

**Suggested fix:** initialize process identity asynchronously and cache it; make owner probing asynchronous and bounded, preserving an unknown/live result on uncertainty. Avoid collecting executable identity when the preview token only needs the birth marker. Add a slow-probe responsiveness test for import/contended acquisition, not only slow Git/cache removal.

### P4 — should-fix: the fast worker snapshot can accept a resumed live run as done during the initial trusted lookup

**Location:** `packages/room-mcp/src/worker-registry.ts:571`; `packages/room-mcp/src/conflict-set.ts:566–576`. Relevant prior lookup awaits: `packages/room-mcp/src/worker-registry.ts:539–559`.

`freshness` calls `statusOf` with `() => 'dead'`. Its `done` result is therefore not evidence that the current host exited: a run that has reported `room_done` but whose host is still alive is normally `running` (`worker-status.ts:89–98`). The initial trusted lookup captures status before awaited worktree ownership checks. A lead suspended there can return an old `done` result after a new run has started, joined and reported while its host remains live.

The next `freshness` call sees the new run, forces its liveness to dead and returns `done`. `releaseLandedWorkerClaims` only matches the trusted result's **worker ID**, not the run/sequence that was trusted. It takes its initial holder snapshot after this gap, so a holder change during the gap does not invalidate the pass. If the captured claims still exist (for example their release has not replicated yet, or mirrored claims remain), equal file contents allow deletion and a landed-work announcement while that host is still running.

**Evidence:** `/tmp/astra-review-r3/claim-resume.mts`, output `/tmp/astra-review-r3-claim.log`. The trusted-worker seam returns the captured run-1 `done` result after publishing valid run-2 durable facts. The production, non-injected `workerState`/`freshness` implementation is used. For those same facts `statusOf` with live process identity returns `running`, while `freshness` returns `done`, `run: '2:second'`; the claim is removed and one release note is posted. This is a deterministic lookup-boundary reproduction, not a live-host rehearsal.

The existing nine R4 races during file reads still pass: resume, changed run/ID, holder replacement, same-ID reanchoring/anchor changes, added/removed claims and an operation starting. The `/tmp` versus `/private/tmp` realpath equivalence case also passes. They do not cover a resume **before the initial freshness snapshot**, inside the trusted lookup's awaits.

**Suggested fix:** carry the exact run/sequence whose finished status was trusted across that asynchronous lookup and require both later snapshots to match it. A cheap snapshot can compare durable facts without inventing process liveness. Capture/validate the relevant holder at that boundary too; reject and retry when the lookup crossed a resume. Preserve direct-by-ID reads and the current claim/operation checks.

## Remaining checks and whole-range pass

- N1 retention is conservative but has an explicit exit: last-borrower discard keeps the owner; explicit owner discard removes it, requiring force for ignored artifacts. Those repository tests pass. I did not reproduce a retained owner that cannot be explicitly cleaned. Automatic retirement can still leave an owner for explicit cleanup, as already noted in round 2.
- New link publication avoids a visible empty token. Aged empty files, old PID-only locks and legacy directory gates have recovery coverage; young uncertain residue falls back conservatively. The successful-acquisition/gate-release-failure test passes. These successes do not repair the replacement-gate race in P1.
- N4's synchronous increment and guarded evidence writes cover both completion orders and separate handler instances using the same Session. I found no additional evidence-generation defect. Historical partial-preview notes are separate from the guarded `lastPreview` slot.
- N5 removes whole-registry scans from the **additional** checks, not from the pre-existing trusted-worker lookup. It still synchronously reads this worker's run reports/exits and resolves paths; do not describe it as wholly asynchronous or constant work independent of run history.
- Rechecked the cumulative changes to fresh-hub admission, base/push history, own-commit wake suppression, bounded rollout scanning, participant names and partial-preview accounting, dependency relinking, graph-readiness shortcuts, claim notices, shutdown ordering, plugin selection and shared-checkout lifecycle. No additional concrete defect was established in that pass. The original cold/warm large-rollout and claim-reanchor probes remain fixed; the warm dependency probe resolves `one` then `two` after relinking.
- Host-feature conclusions remain limited to the supplied dated survey/rehearsal evidence. No new live Codex/Claude wake or routing exercise was performed.

## Validation

All repository tests ran with **one Vitest worker**, with heavy jobs staggered:

- Preview cache races, preview names, conflict set, collection and wake turn: **206 tests / 5 files passed**.
- Preview run cache, manifest preview, worker preview-cache cleanup, worker lifecycle, lifecycle cleanup, presence shutdown, tool budget, tools, hub, base branch, base resolution, areas and base messages: **228 tests / 13 files passed**.
- Total: **434 existing tests / 18 files passed**. Logs: `/tmp/astra-review-r3-tests.log`, `/tmp/astra-review-r3-more.log`.
- Adapted prior correctness/counting assertions: **5 passed**, log `/tmp/astra-review-r3-scratch.log`. The additional late-output pair has **1 pass / 1 intentional regression failure**. Standalone scripts confirm N2/N3's original fixes and P1/P3/P4, as described above. Scratch paths/imports and the N5 ID/count expectation were adapted to the current implementation.

Socket-dependent integration suites were not used as evidence: this sandbox rejects loopback listeners with `EPERM`. `nice -n 10` was attempted but `setpriority` was denied; concurrency stayed bounded. No source/test changes, commits, pushes, plugin rebuilds or host evals were performed.

The required `room_preview_merge(people:["rohanz"])` completed without conflicts at common ancestor `6fc22bccdc`; only this report differed. No tests were requested in that preview. The final working-tree check shows this report as the only changed path.

**Final verdict: not ready to sign off.**
