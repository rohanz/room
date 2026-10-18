# Final re-review, round 8 — sharing and readers

**Range:** `git diff 736f87a 5af4656`; reviewed HEAD `5af46563a6577f5453ab727af84322be7b4f8147`. In-area fix: `0817816`, the one-line change in `packages/room-mcp/src/conflict-set.ts` and the changes in `test/conflict-set.test.ts` and `test/graph-index-events.test.ts`. Generated bundles and other areas excluded.

**Counts: 2 RESOLVED / 1 PARTIAL / 0 NOT RESOLVED; 1 new must-fix / 0 new should-fix.** The new finding groups the exclusion and invalid-entry-fence variants of the same false-clean/duplicate-episode failure; M3 does not count it again.

| Assigned item | Disposition | Evidence |
|---|---|---|
| Round-7 N1 — unreadable held consumer falsely clears a deletion contract | **RESOLVED** | `conflict-set.ts:544` distinguishes unreadable text from legitimate empty/deleted text before scanning references. Both the checked-in regression and disposable two-document probe establish a real deletion conflict, deliver the consumer's held publication only to its own reader while the provider GraphIndex remains running, and require `unknown`, `settled: conflict`, unchanged `factId` and epoch 1, no `:clean`, then the identical conflict and only the original accepted notice ID after restoration. The signature-change control and genuinely removed-reference clean control pass. Exclusion and wrong-fence variants still fail separately below. |
| Round-7 N2 — out-of-area deletion fixture uses `held` | **RESOLVED** | `graph-index-events.test.ts:144–178` now establishes a real dependency before deleting, leaves the out-of-area D entry `shared`, explicitly checks that it has no hash, advances the head, and waits for the actual current-revision graph. A fresh reader has neither the former edge nor the provider symbol. The invalid-entry-fence control also passes. This exercises the manifest §4.1/§4.5 deletion representation and authorization boundary. |
| M3 — contract and graph pipeline end to end | **PARTIAL** | All 99 checked-in contract/graph regressions pass. Four additional real-index/private-disk/fresh-reader pipeline cases pass, including the normal publication throttle. The original held-consumer defect is fixed, but a sole consumer disappearing from accepted manifest paths through exclusion or an invalid entry fence can still falsely settle clean and create a second episode for the identical fact. This occurs for both deletion and signature changes; see new N1. |

## New must-fix

### N1 — Exclusion or an invalid consumer entry fence still falsely clears the contract and duplicates its episode

**Locations:** `packages/room-mcp/src/conflict-set.ts:405` constructs consumer candidates only from accepted manifest entries and open claims; `:541–544` and `:550–554` read only the surviving candidates; `:559` and `:566–582` subsequently settle the absent contract clean after checking only the provider. Related boundary: `packages/shared/src/manifest.ts:78–79` removes wrong-fenced entries from the snapshot, and `:131–134` resolves an absent, non-excluded path at base.

**Scenario:** B's running GraphIndex observes deletion of committed `api.py:call(a)`. A has a shared added `consumer.py` importing and calling it. A's separately synchronized RoomDoc starts a ConflictSet and accepts the real epoch-1 contract notice. Only A's document then receives either:

- A legitimate exclusion publication: remove `consumer.py` from manifest and overlay, put its salted path digest in `head.excluded`, and advance `rev`/`semRev` while retaining complete coverage; or
- An entry-fence mismatch: retain the consumer entry and text, change its entry fence to `wrong`, and advance the head revisions without changing the head/holder fence.

B has not received A's update yet. Its ready graph still correctly matches B's unchanged provider fence and revision. This is the same two-document delivery order required by round 7; no graph snapshot is fabricated.

Without an open claim, neither consumer remains in `mine.entries`, so `myPaths` is empty. The new unreadable-text guard is never reached. `uses` is empty; cleanup reads the authorized deleted provider as empty text and marks the existing contract clean. Restoring A's original shared consumer creates a new epoch for the identical provider fact:

```text
initial:    status=conflict, settled=conflict, epoch=1, factId=F
withdrawn:  status=clean,    settled=clean,    epoch=1, factId=""
restored:   status=conflict, settled=conflict, epoch=2, factId=F
accepted:   cf:<key-hash>:1, cf:<key-hash>:1:clean, cf:<key-hash>:2
```

An authorized **signature change** reproduces both failures too: its edge filter excludes the vanished consumer through `myPaths.has(edge.target)`, before its own unreadable-text check.

**Claim controls isolate the two gaps.** Keeping an open claim on an excluded consumer retains its candidate path; `versionOf` returns `excluded`, so both deletion and signature cases correctly remain unknown and restore epoch 1. Keeping an open claim on a **wrong-fenced** consumer does not fix that variant: the filtered snapshot has no accepted entry and the version reader substitutes base. Because the consumer was an added file, this returns absent base text, which the contract scan accepts as empty. It again clears and restores at epoch 2. Thus retaining candidate paths alone is insufficient; an explicitly invalid raw entry must not certify a base version.

**Disposable proof:** `packages/room-mcp/test/r8B-disposable.test.ts`, deleted after execution, used real temporary Git repositories, actual Python parsing, a running provider GraphIndex, a separate consumer RoomDoc and a started ConflictSet. Every row first asserted the original dependency and epoch-1 conflict. Soft assertions checked both the intermediate unresolved state and the subsequent restoration/accepted-ID set, so a false clean could not prevent observing the duplicate episode. Six distinct rows failed: deletion/signature × exclusion without claim, wrong fence without claim, and wrong fence with claim. Repeated posts of an identical ID were deduplicated by the adapter and were not counted as duplicate notices.

**Why must-fix:** reporooms invariant 7 and §B5 forbid resolving an existing conflict merely because its path leaves the candidate set, and require current readable evidence before clean. Exclusion is an explicit coverage gap; an invalid fenced entry is not proof that a formerly changed file reverted to base. The current behavior loses an unresolved contract and posts a false resolution followed by a duplicate logical episode. This is a remaining pipeline defect, not a claim that the one-line fix introduced it.

**Fix direction:** retain enough prior consumer dependency evidence to revalidate an existing contract after its consumers leave accepted manifest paths, or conservatively keep that contract unknown when current coverage cannot establish their absence. Respect exclusion digests for those paths. Reject an explicitly wrong-fenced raw consumer entry as unknown instead of certifying its base substitute. Apply the evidence requirement to both deletion and signature branches and before clean cleanup. Do not replicate new consumer-content digests or private path details to implement that bookkeeping. Preserve the passing real-reference-removal control, and require restoration of identical readable inputs to keep the original fact, epoch and accepted notice ID.

## New should-fix

None established separately from new N1. The requested fixture repair is complete; the remaining missing cases above expose production behavior rather than a separate test-only finding.

## Test-expectation audit

All changed in-area test hunks were inspected. No behavioral expectation was weakened. The deletion privacy fixture replaces an impossible held-deletion shortcut with a real shared D entry and adds initial-edge, hashless-entry, current-provenance and fresh-reader assertions. The three new contract tests establish the initial conflict before checking uncertainty/restoration or a real resolution; their provider GraphIndex stays running and deliberately does not receive the consumer's narrower publication first.

| Probe / regression | Result |
|---|---|
| Two-document held consumer, deletion and signature | **2 pass.** Unknown retains settled conflict, fact and epoch 1; no clean notice; identical restoration accepts no new ID. |
| Sole excluded consumer, no claim, deletion and signature | **2 fail**, new N1: false clean and epoch 2. |
| Excluded consumer retained by an open claim, deletion and signature | **2 pass.** Explicit exclusion is read as uncertainty; same episode on restoration. |
| Sole wrong-fenced consumer, with and without an open claim, deletion and signature | **4 fail**, new N1: false clean and epoch 2. |
| Consumer head incomplete, or coverage `none/starting`, deletion and signature | **4 pass.** Pair uncertainty preserves the unresolved contract and original episode on recovery. |
| Two consumers, one held and one still referencing, unreadable consumer first and last in manifest iteration, deletion and signature | **4 pass.** Unknown preserves the original episode; iteration order does not clear or renotify. |
| Two consumers, one excluded or wrong-fenced and another still referencing, deletion and signature | **4 pass.** The remaining readable reference keeps the conflict and accepted epoch-1 ID. |
| Actual last-reference removal from readable consumer text | **1 pass.** Deletion contract becomes clean at epoch 1 and posts its deterministic `:clean` notice. |
| Earlier private-disk → running GraphIndex → consumer ConflictSet → fresh-reader pipeline | **4 pass:** narrowed grant + wrong fence at zero/default throttle, narrowing alone, wrong fence alone. Each establishes the old contract, proves the private graph actually indexes the new disk-only `private_only`, and verifies that fresh readers contain no withdrawn graph path, edge, observation, old symbol slot, signature fact/input or symbol-key-derived clean digest, before and after reconciliation. Default throttle waits for actual revision-2 publication. |
| Earlier checked-in contract regressions | Pass: provenance lag and Yjs-copy/restart, README-only catch-up, mixed clean/active sibling paths, current/coalesced authorization withdrawal, wildcard replay suppression and owed readable notice, clean/subset restoration epoch retention, changed signatures, stale consumer references and carried-baseline controls. |
| Earlier checked-in graph regressions | Pass: full and declared in-area deletion publication, out-of-area shared D and wrong-fence privacy, own/peer holder and Git-fence withdrawal, peer head-only grant/completeness recovery with identical text, default-throttle recovery, exclusion withdrawal, holder race during base read, body-only/non-source provenance catch-up, and private-disk publication controls. |

**Verification:** the complete `conflict-set.test.ts`, `graph-index-events.test.ts` and `graph-index.test.ts` suites pass **99/99**. The final disposable matrix has **21 passes / 6 failures across 27 cases**, with all failures belonging to new N1. Preliminary runs and repeated/refined rows are not counted again. Temporary Vitest configuration mapped workspace package exports explicitly to this worktree, used its normal identity-clearing setup and one test worker. Runs were staggered; `nice -n 10` was attempted, but the sandbox denied `setpriority`.

No host feature assumptions, live host sessions, sockets, full build or deployment were involved. The confirmed 0.16 transition window, private claim hashes outside the area, claims surviving host exit, done-after-follow-up and local carried reads were not treated as defects. No source file was changed and no commit or push was made. Disposable probes, configuration, generator and logs were removed; this report is the sole retained output.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `5af46563a6`, with only this report changed. No combined-source tests were needed for a report-only contribution. Whitespace checks passed; final Git status contains only this new report.
