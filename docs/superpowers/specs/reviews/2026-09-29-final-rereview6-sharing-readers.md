# Final re-review, round 6 — sharing and readers

**Range:** `git diff 8f948cd 70cd07a`; reviewed HEAD `70cd07a221af8f85c2ed117312358d1e4c85f953`. In-area fix: `ddacf41`, `packages/room-mcp/src/graph-index.ts`, `test/graph-index-events.test.ts`, and `test/conflict-set.test.ts`. Generated bundles and other areas excluded.

**Counts: 2 RESOLVED / 1 PARTIAL / 0 NOT RESOLVED; 3 new must-fix / 0 new should-fix.**

| Assigned item | Disposition | Evidence |
|---|---|---|
| Round-5 N1 — wrong-fenced entry republishes private disk-derived symbols after narrowing | **RESOLVED** | `graph-index.ts:288–322` resolves publication independently of private indexing, rejects a raw wrong-fenced entry, and reads accepted text or certified base text. Source authorization is rechecked at publication (`:340–356`, `:540`, `:584`). All four independent running-pipeline probes pass: combined narrowing/wrong fence with zero and default throttles, narrowing only, and wrong fence only. The private local graph still indexes the new disk-only definition, while fresh readers receive neither its edge nor the withdrawn path's observations. Contract-slot redaction also passes before and after reconciliation. |
| Round-5 N2 — two vacuous conflict-set fixtures | **RESOLVED** | The first fixture grants full sharing and asserts an actual epoch-1 conflict before withdrawal (`conflict-set.test.ts:466`, `:479`). The clean-revert fixture restores full sharing and asserts the intermediate wildcard is clean before restoring the conflict (`:968`, `:972`). Both pass with their original final digest/epoch assertions intact. |
| M3 — contract and graph pipeline end to end | **PARTIAL** | The assigned private-disk leak is closed, and checked-in provenance-lag, README catch-up, restart, mixed clean/active, subset-restoration and signature-change cases pass. However, the new publication filter drops authorized whole-file deletion observations (new N1), peer holder-only replacement leaves stale derived edges published (new N2), and peer head-only withdrawal/restoration can strand the replicated graph (new N3). The complete pipeline therefore remains unclosed. |

## New must-fix

### N1 — Authorized whole-file deletion loses its observed contract facts

**Locations:** `packages/room-mcp/src/graph-index.ts:301–302`, `:477`, `:488–499`, and especially `:563`.

**Scenario:** B has a committed `api.py` defining `call(a)`; A shares a consumer calling it. B deletes `api.py` with valid current fences, complete coverage and a text grant for the path. A deletion is a legitimate `change: 'D', state: 'shared'` entry without a current content hash. This occurs at both `full` and `declared` with `api.py` explicitly in the area.

`runRefresh` still computes the `delete` observation against the committed base at `:498`. However, `publicationTextFor` returns no text for a deleted version, so `:477` removes its publication source and cache entry. The new `allowedPaths` filter at `:563` then discards that observation because a deleted file cannot be in the live-text cache. The ready, current-revision graph reports `observed: []`; a fresh synchronized reader loses the deletion fact.

**Disposable proof:** two real-Git/real-GraphIndex probes first assert the published `api.py → consumer.py` edge, delete the file, wait for ready revision 2, then synchronize a fresh RoomDoc and require `{path: 'api.py', symbol: 'call', kind: 'delete'}`. Both fail with an empty observation list. Two controls using an isolated copy of `8f948cd`'s GraphIndex with the same current dependencies pass that exact publication assertion. This isolates the graph-observation regression to this range. The downstream ContractSet also produces no deletion notice in the HEAD probes; the control deliberately isolates graph publication and does **not** establish that the older complete deletion-notice pipeline worked.

**Why must-fix:** a legitimate, text-authorized contract fact is silently lost. Deletion is one of the supported observed contract kinds and feeds the contract workflow required by reporooms §B5. A deletion must remain absent from live definitions without losing its authorized change observation.

**Fix direction:** authorize deletion observations separately from membership in the live-text graph. Carry enough fenced provenance for an authorized deleted version and its certified baseline; do not require a current text hash for `D`. Preserve D1 by withholding symbol/signature detail for out-of-area deletions and invalid fences. Add full/in-area deletion publication and fresh-reader assertions, plus an actual consumer-notice regression for the full deletion pipeline.

### N2 — A peer's holder-only replacement leaves its old symbols in another publisher's graph

**Locations:** `packages/room-mcp/src/graph-index.ts:152–168` observes only this indexer's participant fields; `:304–314` permits peer-sourced publication; `:330–356` has the necessary peer-fence check but does not run on that peer's holder event.

**Scenario:** A's running GraphIndex publishes a dependency from B's shared, uncommitted `remote.py` to A's `consumer.py`:

```json
{"source":"remote.py","target":"consumer.py","symbols":["remote_only"]}
```

The definition is absent from the base. B's holder advances from epoch 1 to epoch 2, leaving its epoch-1 manifest pending replacement. A's holder, manifest and provenance remain unchanged. `onParticipant` ignores B's holder event, so A neither withdraws the peer-sourced edge nor schedules a refresh. A fresh reader still receives it in A's ready graph, which contains no public per-path peer-fence provenance that could identify the revoked source.

**Disposable proof:** establish the edge, drain the initial publication timer, replace only `B\0holder`, and synchronize a fresh RoomDoc immediately. The no-old-edge assertion fails. It still fails after `whenIdle()` plus 350 ms with `minPublishMs: 0`; this is not a throttle delay. An explicit `refresh('remote.py')` control removes the edge, confirming the predicate works when the missing event processing is supplied.

**Why must-fix:** a reader receives derived facts from a publisher incarnation that the manifest fence now rejects. This is the peer-sourced counterpart of M2, not the accepted rule that claims survive host exit. No host exit or claim retirement is involved. The own-holder M2 regression passes, but does not cover graphs that republish another participant's version. This is a remaining pipeline hole exposed while reviewing the new source authorization, rather than a claim that the old implementation correctly handled peer holders.

**Fix direction:** observe holder and relevant Git-fence changes for every participant supplying cached publication text. Synchronously withdraw affected published facts and schedule refresh/publication. Retain the current final authorization check, and add the peer-holder fresh-reader case beside the own-holder M2 test.

### N3 — Peer head-only withdrawal/restoration can leave the graph stuck without legitimate edges

**Locations:** `packages/room-mcp/src/graph-index.ts:133–134`, `:360–382`, and `:574–577`.

**Scenario:** begin with the same valid peer-sourced edge in A's ready graph and no pending publication timer. Change only B's head: either narrow its grant, or set `complete: false`. The new peer-head handler calls `withdrawRestricted`, which correctly removes the edge and writes A's graph as `indexing`, but immediately returns without queuing work. Restore B's full grant/complete coverage with a later revision and unchanged valid entry/text. Again, the handler only withdraws: it cannot reconstruct the removed cache/source. A remains `indexing`, without the now-authorized edge, indefinitely in an otherwise idle room.

There is also a restoration deduplication trap in this sequence. An explicit refresh reconstructs the internal published graph correctly, but the replicated graph can still remain stripped. `withdrawRestricted` wrote the changed graph directly without invalidating `lastPublished.key`. Restoring the original content with unchanged **A** provenance recreates the pre-withdrawal key, and `:574–577` returns without repairing the actual document.

**Disposable proof:** two cases cover head-only grant narrowing/restoration and incomplete/complete restoration. Each first asserts the edge, then waits 200 ms to drain the initial 100 ms timer. Both establish synchronous withdrawal; both fail the subsequent ready/edge assertions with zero throttle, including after restoration and `whenIdle()` plus 350 ms. An explicit path refresh successfully reconstructs the internal dependency but still fails the replicated edge/status assertions. Advancing only A's manifest revision then makes the graph ready with the expected edge; that final control passes, isolating the stale deduplication key as well as the missing automatic refresh.

**Why must-fix:** valid shared dependency data disappears and the published graph can remain permanently non-ready until unrelated work changes its owner's provenance. Consumers of that graph can lose contract coverage even after the source becomes readable again. This regresses legitimate publication/recovery, independently of whether the privacy withdrawal itself was correct.

**Fix direction:** peer head changes must refresh affected paths and schedule a terminal publication, including restoration after cached sources were removed. Keep deduplication state consistent with synchronous document withdrawals, or compare against the actual currently published graph before suppressing a write. Regression tests must let the initial timer finish before changing the peer and must restore identical text without changing the graph owner's revision.

## New should-fix

None established separately from the three production findings above.

## Test-expectation audit

All in-area changed test hunks were inspected. **No existing assertion was removed or weakened.**

| Coverage | Assessment |
|---|---|
| Repaired identity-redaction fixture (`conflict-set.test.ts:462`) | Non-vacuous now: full grant, actual epoch-1 slot, then held/out-of-area withdrawal and original plaintext/digest checks on a fresh reader. |
| Repaired clean-revert fixture (`:935`) | The original epoch-1 notice is established; the intermediate clean wildcard is now explicitly asserted; restored conflict still requires epoch-2 acceptance. |
| Three added full grants for A (`:545`, `:654`, `:818`) | Correctly authorize the shared consumer text used by real GraphIndex tests. These are coherent fixture repairs, not weaker expectations. |
| Four new disk-only-definition rows (`graph-index-events.test.ts:197`) | Establish a real pre-withdrawal edge and absence of the private definition's edge, write the new definition only to disk, and check fresh-reader paths, edges and observations. The default-throttle row waits for actual new-revision publication. |
| Existing own-holder and head-only exclusion tests | Pass, including immediate fresh-reader withdrawal, a holder change during the base read, and exclusion checks beyond the normal 20-second throttle. New N2 is specifically a peer holder; these passing tests do not cover it. |
| Existing full sharing, declared in-area, base, body-only and provenance tests | Pass. This includes base dependency publication/revert, own signature publication, full and declared initial states in the independent probes, equal-symbol body edits, non-source revisions, incomplete-coverage recovery, and unchanged accepted notice identity across provenance lag/restart. New N1 and N3 are the uncovered legitimate-publication cases. |

**Independent round-5 probe matrix:** all four cases use real Git, actual Python parsing, a running provider GraphIndex, a separate synchronized consumer RoomDoc with a started ConflictSet, and a fresh reader. No graph snapshot is injected.

| Withdrawal | Throttle | Result |
|---|---|---|
| Narrowed grant + wrong entry fence | Zero | PASS |
| Narrowed grant + wrong entry fence | Default, actual publication after about 20 seconds | PASS |
| Narrowed grant only, retained shared entry | Zero | PASS |
| Wrong entry fence only, original grant retained | Zero | PASS |

Every case first establishes the restricted epoch-1 contract. The local graph subsequently contains the new disk-only `private_only` definition, proving the private indexing branch actually ran. Fresh readers before and after consumer reconciliation have no withdrawn `aux.py` graph path, edge endpoint, observation or private symbol edge. The old symbol slot is absent; its wildcard is unknown with empty `factId`; old fact/input/signature and symbol-key-derived clean digest checks pass. Thus the exact round-5 leak is closed rather than merely hidden by a fixture that stopped indexing.

**Verification:** 87 checked-in tests passed across the complete `conflict-set.test.ts`, `graph-index-events.test.ts` and `graph-index.test.ts` suites. Eleven distinct disposable cases comprised six passes (four pipeline cases and two pre-range graph-deletion controls) and five failures (two HEAD deletion cases and three peer-event cases). Repeated runs/refined assertions are not counted again. The failing peer cases include passing explicit-refresh or owner-revision recovery controls as described above.

Tests ran sequentially with one Vitest worker and aliases generated from this worktree's package export maps, preventing workspace imports from silently resolving to the lead checkout. `nice -n 10` was attempted, but the sandbox denied `setpriority`; concurrency remained one. No host-feature assumptions, live host sessions, socket suites, full build or deployment were involved. The five confirmed human rulings were respected.

All disposable probes, the isolated pre-range GraphIndex copy and temporary configuration were removed. No source file was changed, and no commit or push was made.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `70cd07a221`; this report was the sole changed path. No combined-source tests were needed for a report-only contribution. Whitespace checks passed, and final status contains only this new report.
