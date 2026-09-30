# Rehearsal fixes — review round 4, 2026-09-30

Reviewed `8c3b5f4..a4280e1`, with a final source pass over `0aef465..a4280e1`, at HEAD `a4280e1d2b2f96ecb985b161389f48ef17fdaebe`. Read rounds 1–3 and the dated rehearsal evidence. Adapted the round-3 reproductions under `/tmp/astra-review-r4/`; all fixture mutations stayed under `/tmp`. This report is the only repository change.

**Verdict: not ready to sign off. Findings: 2 must-fix, 2 should-fix, 0 nits.**

## P1–P4 disposition

| Round-3 finding | Result at a4280e1 |
| --- | --- |
| P1: stale recovery steals a live gate / admits two cache owners | **Fixed for new-format slots; migration still unsafe (Q2).** The old gate no longer exists in the new acquisition protocol. Adapted its delayed-reclaimer ordering to three actual Node processes: R pauses before renaming a dead slot, A adopts it and starts its check, B starts another check, then R resumes its stale rename. All three checks assert and read their own contents. A uses the cached tree; B and R create separate trees. After all exit, removal clears all three slots and registrations. No replacement live slot is moved by the stale new-format rename. Same-process overlap also passes the repository test. |
| P2: retained-owner cleanup misses newly committed output | **Original reproduction fixed.** Both adapted `REVIEW late output survives cleanup (committed=%s)` cases pass. The committed case keeps the checkout and names `late.txt` and its post-collection commit; the lead does not have that file. The exact captured HEAD is now persisted. Ordinary unmerged worker tips get named recovery refs. However, publishing the new refs introduces a lead-edit overwrite race (Q1). |
| P3: synchronous process probing during import/contention | **Fixed.** The adapted synchronous-command interception records zero `ps`/`sysctl` calls at import and during preview. A further adapted slot-contention probe injects 120 ms asynchronous process probes, including failure, and observes a maximum 1 ms timer interval of about **1.9 ms**. This is injected latency, not a production benchmark. |
| P4: resumed run accepted as done during trusted lookup | **Fixed in the reproduced and supplied cases.** The adapted lookup returns trusted run `1:first`, sequence 1, after publishing live run `2:second`, sequence 3. Production freshness returns the second run's durable facts; the claim remains and no release note is posted. The trusted run/sequence comparison and holder capture before the lookup cover this gap. The repository tests cover lookup-boundary run/sequence/holder changes and the earlier file-read races. |

Evidence: `/tmp/astra-review-r4/slot-race.mts`, `claim-resume.mts`, `sync-probe.mts`, `probe-identity.mts`, and `ignored-probe.test.ts`; logs `/tmp/astra-review-r4-{slots,claim,sync,identity,committed,scratch}.log`.

## Findings

### Q1 — must-fix: publishing collection refs after the final preflight lets collection overwrite a new lead edit

**Location:** `packages/room-mcp/src/tools/collect.ts:619–632`, especially the new awaited Git calls at `:625–626`.

The destination identity check used to be immediately followed by the synchronous apply loop. The new collection-head/base writes insert two awaited Git subprocesses per selected worker between that check and the writes. A user/editor can change a destination during those awaits. Collection then installs its previously computed bytes over the new edit and reports success, without another identity check or a recovery copy of that edit.

**Reproduction:** `/tmp/astra-review-r4/ignored-probe.test.ts`, `REVIEW protects lead edit during collection ref publication`; log `/tmp/astra-review-r4-preflight.log`. The fixture starts with `file.txt = base`, and the worker changes it to `worker edit`. A wrapper awaits the real `git update-ref refs/room/collect-head/...`, then performs an ordinary write of `new human edit` to the lead before that awaited call returns to the handler. No Git result or identity check is forged. Result:

```text
fired: true
reply: Changes from test: file.txt. Nothing committed or staged.
       cleaned up test: temporary files, branch and logs
leadText: worker edit
```

The assertion that `new human edit` survives fails. The worker operation lease does not exclude a human's filesystem write.

**Suggested fix:** publish the recovery metadata before the final destination preflight, or repeat that entire preflight after the last awaited metadata write. Keep the checked-identity-to-apply segment free of awaits. Add this regression beside the existing collection destination-change tests, including a multi-worker case.

### Q2 — must-fix: legacy migration/removal can rename a checkout after a legacy process reacquires it

**Location:** `packages/room-mcp/src/tools/files.ts:749–752`; the same check/rename gap exists in removal at `:732–734`. Owner checks are at `:648–682`.

Treating a live legacy PID as alive fixes the identity-format mismatch but does not make the checked legacy lock stable. Unlike the new immutable owner-specific slot name, the legacy key remains reusable by any old process. Its lock and recovery gate can change between `legacyIsDead()` and `rename(key, ...)`.

**Concrete ordering:** a legacy cache has a dead owner token. New-format caller N decides it is dead and pauses immediately before renaming the key. Legacy caller O acquires that cache through the actual old protocol, writes `legacy`, and starts its check. N resumes, moves O's active checkout into N's slot, repairs it, resets it and writes `modern`. O's already-running command reads `modern` from its current working directory. The new check succeeds; the old invocation ultimately throws because cleanup's original worktree path disappeared. The removal variant can delete the same active checkout instead of adopting it.

**Evidence:** `/tmp/astra-review-r4/legacy-race.mts`, log `/tmp/astra-review-r4-legacy.log`. `old-files.ts` is the files-tool source extracted from `8c3b5f4`, with import paths redirected to this checkout; the legacy acquisition code itself is unchanged. The two implementations run side by side in one Node process with their separate acquisition protocols, modeling the mixed-version interleaving without launching host agents. Delays only order the real rename/check boundaries. Output includes `legacyObserved: "modern\n"`, a passing modern check, and `worktree ... no longer exists` from the old invocation. An initial harness waited too early, before the old check started; the final reproduction explicitly waits for its shell-start marker.

**Suggested fix:** do not automatically rename/delete the reusable legacy key based solely on an observed dead token. Use an exclusion mechanism compatible with active old clients, held through migration, or conservatively leave legacy trees in place and use sidecar slots until old clients are known to be quiescent. A second token read followed by an awaited rename still leaves the race. Test reacquisition between the last liveness check and rename for both adoption and deletion.

### Q3 — should-fix: another slot's cleanup can prune an adoption's Git registration before repair

**Location:** `packages/room-mcp/src/tools/files.ts:759–760` and `:714`; destructive recovery at `:781–784`.

The filesystem rename and Git registration repair are separate operations. During that interval, the registration still points at the missing old path. Every successful slot deletion then runs repository-wide `git worktree prune`, including registrations unrelated to the deleted slot.

**Reproduction:** `/tmp/astra-review-r4/repair-race.mts`, log `/tmp/astra-review-r4-repair.log`. Create two dead slots, each with ignored `target/marker` output. Pause A immediately after it renames the first slot into its own live slot but before `worktree repair`. B removes the second dead slot; B correctly preserves A's live slot directory, but its global prune removes A's old registration. A resumes and gets:

```text
git worktree repair ... failed: error: unable to locate repository;
.git file does not reference a repository ...; check was not run
```

The next preview treats the directory as broken and recursively deletes it, losing the warm ignored marker and rebuilding the base. A marker-preservation check then fails. This is reproducible using two calls in one process: the preview-slot mutex is not a repository-wide registration lock. Separate clone keys sharing the Git common directory can encounter the same problem.

**Suggested fix:** protect the moved registration from pruning throughout rename/repair, for example with Git's worktree lock plus crash recovery, or serialize all Room registration relocation/pruning under a common-directory protocol. Prefer targeted registration cleanup instead of unconditional global prune where possible. Ensure the solution also covers other Room `worktree prune` callers, and add this adoption-versus-deletion ordering.

### Q4 — should-fix: slot retention has no bounded sweep, and interrupted deletion creates permanently ignored trash

**Location:** `packages/room-mcp/src/tools/files.ts:720–729`, `:747`, `:757–761`; trash names at `:728/:733`. Worker cleanup invokes this at `packages/room-mcp/src/worker-git.ts:372`.

Normal acquisition adopts at most one dead slot, and an existing own slot returns before scanning any others. There is no slot-count/byte budget, common-directory sweep, idle eviction, or process-exit cleanup. Removal visits only one requested clone key and skips every live process's slot, including the idle slot owned by the caller. Once that worker is collected and the host later exits, its orphaned clone key may never be visited again. Repeated worker lifecycles or bursts of concurrent hosts can therefore leave many full cached checkouts and GB-scale ignored build trees. Sequential adoption does not reduce an already accumulated surplus.

Deletion also first moves a dead slot outside the scanned roots to `<key>.trash-<uuid>`. A crash after this rename, or an interrupted/failed delete, leaves a directory that neither subsequent acquisition nor `removePreviewCache()` enumerates. Its name contains no reclaimer identity to support safe recovery while another remover might still be active.

**Evidence:** `/tmp/astra-review-r4/slot-maintenance.mts`, log `/tmp/astra-review-r4-maintenance.log`. With two dead slots, one is adopted and the second remains across repeated successful warm calls. Then the fixture performs the real removal rename and injects an interruption immediately afterward, modeling termination at that boundary. Retrying removal and preview leaves `trash after retry/preview true`, with its ignored output still present and its old registration prunable. The existing worker-preview-cache tests also explicitly expect a caller-owned cache to survive worker cleanup. No large files were allocated for this review; the unbounded disk consequence follows from preserving arbitrary ignored build output.

**Suggested fix:** add a bounded, asynchronous common-directory sweep of provably dead slots, including keys for vanished/retired workers; limit retained dead-slot count/bytes or apply a documented retention policy. Give trash an owner/recovery protocol so interrupted deletions can be resumed safely. Do not age out a live or uncertain owner. Document the actual per-process slot behavior; README currently still says one reusable checkout per clone.

## Other requested checks and whole-range pass

- **New-format exclusivity:** the same-process `has`/`set` mutex segment has no await, and release follows final reset. The supplied overlapping-check test and the three-process delayed-renamer probe pass. New-format rename destinations use another process's stable birth identity; a stale contender still targets the dead source name rather than the adopted live name. No additional new-format two-owner checkout race was established.
- **PID reuse / failed probes:** `probe-identity.mts` verifies adoption when a recorded nonopaque start differs from the injected current birth marker, preservation of an exact live marker, preservation on a throwing probe, and preservation of an opaque marker despite an observed different start. Unknown is conservative. Actual PID wrap/reuse was not induced; macOS birth markers retain one-second resolution. An opaque slot can wait longer if its PID is reused, but becomes reclaimable when that PID is absent. This is separate from Q4's missing sweeps.
- **Legacy safety:** existing live-PID, live-recovery-gate, dead-token and aged-ownerless migration tests pass. They do not exercise reacquisition after the check (Q2). Old lock/gate files do not provide immutable ownership of the legacy key.
- **P2 carry exemption:** `/tmp/astra-review-r4/carry-probe.mts` tests both a worker commit on top of the carried base and a worker amendment of the carry commit, retaining Room's author/subject in the latter case. Both cleanups return a named recovery ref that resolves to the exact new tip and recovers `own`. Equality with the original carry/base hash does not exempt these own commits. Unchanged-carry and ordinary unmerged-tip repository tests pass. Log: `/tmp/astra-review-r4-carry.log`.
- **P4 completeness / synchronous work:** no further concrete run/holder/claim fencing defect was established. The adapted 1,000-record counting test still records **2** direct worker-record reads for the additional freshness checks (about **0.53 ms** here). Freshness reports durable facts instead of inventing dead process status. It still synchronously reads that worker's reports/exits and resolves paths; the pre-existing trusted lookup still scans/probes. P3's new preview process probing is lazy, asynchronous and bounded; this does not make every filesystem operation in the tool asynchronous.
- **Earlier fixes:** the adapted sequential/concurrent preview-evidence tests and collection-preservation assertions pass. The dependency-link probe again resolves `one` and then `two` on the warm preview. Rechecked fresh-room admission, push/history handling, own-commit wake suppression, bounded rollout scanning, names and partial-preview accounting, graph-ready shortcuts, conflict notices, shutdown ordering, plugin selection and shared-checkout lifecycle across `0aef465..a4280e1`. No additional concrete finding was established in that final pass.
- **Host limits:** host-feature conclusions remain limited to the supplied dated survey/rehearsal evidence. No new host API implementation, live wake/routing experiment, plugin rebuild or host eval was performed.

## Validation

Repository tests used one Vitest worker per batch, with heavy batches staggered:

- Cache races, slots, async import, preview run cache, worker cache cleanup, collection, conflict set and carry WIP: **226 tests / 8 files passed**. Log: `/tmp/astra-review-r4-tests.log`.
- Preview names, manifest preview, wake turn, lifecycle cleanup, worker lifecycle, presence shutdown, tool budget, tools, hub, base branch, base resolution, areas and base messages: **239 tests / 13 files passed**. Log: `/tmp/astra-review-r4-more.log`.
- Total: **465 existing tests / 21 files passed**. Adapted prior scratch assertions: **7 passed**; the committed/uncommitted P2 pair was also rerun separately to record its output. The new Q1 assertion has **1 intentional regression failure**. Standalone scripts establish Q2–Q4 and the additional checks above.
- Socket-dependent integration suites were not used as evidence: this sandbox rejects loopback listeners with `EPERM`. The requested `nice -n 10` was attempted and `setpriority` was denied; test concurrency stayed bounded. No source or repository test edits, commits or pushes were made.

The required `room_preview_merge(people:["rohanz"])` completed without conflicts at common ancestor `a4280e1d2b`; only this report differed. No tests were requested in that merge preview. The final working-tree check shows this report as the only changed path.

**Final verdict: not ready to sign off.**
