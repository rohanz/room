# Final re-review 11 — area sharing and readers

**Range:** `git diff a336310 340a29c`; reviewed HEAD `340a29ce93e4323e01885b49041b1f5de8b8547d`. Net effect of `5d8503e` and the subsequent scope cut, restricted to `conflict-set.ts`, `graph-index.ts`, their tests, and the manifest/hub/reporooms specs. Bundle bytes and other areas excluded.

**Counts: 2 must-fix / 0 should-fix.** Checked-in regressions: **100/100 pass**. Disposable matrix: **22 pass / 3 fail across 25 cases**; the three failing cases establish the two findings below.

## Findings table

| ID | Severity | Location | Finding |
|---|---|---|---|
| N1 | Must-fix | `packages/room-mcp/src/conflict-set.ts:86`, `:110`, `:195` | Deleting a withdrawn slot resets its next epoch to 1, reusing an accepted notice ID and losing the re-entry notice, including for a different signature. |
| N2 | Must-fix | `packages/room-mcp/src/graph-index.ts:496`, `:560`, `:589`; `packages/room-mcp/src/conflict-set.ts:473` | An unrelated peer's outside-area held file still degrades a full provider's entire graph and suppresses its authorized contract notices. |

## Must-fix

### N1 — Fresh authorized episodes collide with historical notice IDs

**Scenario:** B's running GraphIndex observes `api.py:call(a)` changing to `call(a,b)`. A's authorized `consumer.py` calls it. A's ConflictSet establishes the contract and the deduplicating post adapter accepts `cf:<slot-key-hash>:1`. B narrows to declared sharing with no authorized prefix, publishes the held entry and clears its overlay in the same transaction. The contract and graph facts disappear synchronously, and no clean notice is posted, as required.

B subsequently authorizes `api.py` again. Both tested variants fail:

1. The original `call(a,b)` signature returns.
2. B changed the signature to `call(a,b,c)` while outside the area, and that different signature becomes authorized.

The graph catches up to the new manifest revision and the contract evaluates to `conflict`, but deletion erased `prev`, so `settle` starts at epoch 1 again (`conflict-set.ts:78–95`). `postNotice` still derives its ID solely from the stable slot key and epoch (`:107–110`). The adapter returns the previously accepted message instead of delivering the current episode. Both rows have **one accepted contract message, where two are required**. For the changed signature, the only delivered message describes the obsolete signature.

This is a lost in-area notice, not an objection to dropping outside-area identity or to issuing a fresh notice on re-entry. The lead explicitly confirmed that a newly authorized current conflict must deliver a fresh notice, including when the signature is unchanged; suppression through a reused ID is a defect.

**Disposable proof:** the two `re-entry delivers fresh … signature episode` cases in `packages/room-mcp/test/r11B-disposable.test.ts`, deleted after execution. Real temporary Git repository, actual Python parsing, running provider GraphIndex, started ConflictSet, synchronous withdrawal assertion, current-provenance wait, and a post adapter deduplicating by the same deterministic IDs as the hub. Assertions establish the original conflict and its removal before checking delivery on re-entry.

**Fix direction:** create a fresh authorized-episode discriminator when a contract is re-established after withdrawal, and include it in its notice identity. Preserve it while that authorized episode survives provenance lag, restart and replay. It must not require retaining the withdrawn symbol/signature identity or a content digest. Keep ordinary in-area fact changes and clean transitions advancing their existing episode correctly. Add same-signature and changed-signature re-entry tests with accepted-ID deduplication; raw post-call counts miss this failure.

### N2 — Outside-area peer work still blocks unrelated authorized contracts

**Scenario:** B shares at `full`, changes committed `api.py:call(a)` to `call(a,b)`, and A's fully shared consumer calls it. An unrelated C shares at `intent` and has a hashless held `private.py` entry. C contributes no text, signatures or graph facts for that path.

B's running GraphIndex correctly publishes the `api.py` signature observation and omits `private.py` from its graph paths, but publishes **`status: 'error'`**. The new check at `graph-index.ts:496` asks whether **B** authorizes the path. Since B shares at full, this is true for C's private path. The following filter considers only C's held entry, without checking C's text grant. It adds that path to `degradedPaths` (`:560–562`), which changes the status of the entire published graph (`:589`). A's contract reader rejects the whole graph at `conflict-set.ts:473–476`.

Observed result: the real authorized provider observation is present, but A has **no contract slot and zero contract notices** for `api.py:call`. A newly synced RoomDoc also receives the errored graph. This persists while the unrelated held path remains; it is not ordinary provenance lag. The control removes only C's held manifest path and advances C's head: the graph becomes ready and the same authorized API dependency produces its epoch-1 conflict. No provider-signature or consumer-reference change is needed to unblock it.

The initial full-provider failure is sufficient for this finding. A follow-up also showed that narrowing B to `api.py` does not by itself immediately repair the degraded graph: the unparsed held path is absent from the cache paths refreshed by that grant change. This belongs to the same stale coverage bookkeeping, not a separate count.

**Disposable proof:** `an unrelated peer outside area cannot block an authorized full provider notice` in the same deleted probe. Soft assertions establish the errored graph, omitted private path, surviving authorized signature observation, missing slot and missing notice together. A fresh Yjs copy checks replicated state. A focused rerun verified the final removal/unblocking control; repeated runs are not counted as extra cases.

**Why must-fix:** the new rule removes outside-area graph/contract participation. This remaining coverage mechanism lets one participant's private work suppress another participant's valid in-area/full notifications. It violates the required preservation of authorized contract behavior. This is an incomplete scope cut, not a request to restore outside-area uncertainty notices.

**Fix direction:** determine coverage relevance against the participant supplying the held version and its current authorization, rather than only the indexing participant's grant. Outside-area paths must not poison global graph readiness or leave stale degraded-path bookkeeping after grant changes. Retain conservative degradation for genuine failures to evaluate authorized evidence, such as an unavailable authorized baseline.

## Should-fix

None established independently of the two must-fix findings. No style nits counted.

## Test-expectation audit

The deleted tests mostly encode superseded outside-area identity, wildcard and epoch-history requirements. Their old expectations should not be restored wholesale. Several also contained still-useful in-area controls:

| Deleted or changed coverage | Disposition under the new rule |
|---|---|
| Redaction epoch preservation, redacted identity privacy, wildcard replay, clean-after-redaction and absent-symbol history | Outside-area retention is obsolete. Their re-entry delivery checks remain useful when rewritten around a fresh authorized episode. Removing them without a deduplicating re-entry replacement left N1 undetected. |
| Held/excluded/wrong-fenced consumer tests, including deletion/signature variants | Their `unknown`/old-epoch expectations during withdrawal are obsolete. Replace with immediate silent slot removal and no restricted evidence; the disposable provider/consumer matrix verifies these transitions. |
| “redacts only a newly held sibling while an active contract remains readable” | The retained active sibling still matters. Existing mixed clean/active pipeline tests pass; disposable full/declared subset-restoration cases also preserve independent in-area epochs and the legitimate clean notice. |
| Current/coalesced graph withdrawal and running-graph catch-up before reader sync | The redaction wildcard expectation is obsolete; synchronous removal and fresh-reader privacy still matter. Running-index withdrawal and private-disk probes pass with fresh Yjs copies. |
| “never replays a redaction wildcard but delivers an owed readable sibling once” | Wildcard suppression is obsolete. Delivery/replay of an authorized episode remains required; checked-in replay tests and real process-boundary provenance recovery pass. |
| “marks held remote changes as contract coverage gaps” in `graph-index-events.test.ts` | Its outside-area error expectation is obsolete. The implementation still performs that degradation when the indexer has a full text grant: N2. A replacement should prove unrelated outside-area work cannot block an authorized notice. |
| Authorized deletion test's initial edge assertion changed to an initial provider-path assertion | Appropriate: a declared provider need not authorize the consumer path in its own graph. Deletion observations and consumer-side contract evaluation still work; the checked-in running-graph deletion notice and actual-reference-removal controls pass. |

**Verification evidence:**

| Check | Result |
|---|---|
| Complete `conflict-set.test.ts`, `graph-index-events.test.ts`, `graph-index.test.ts`, `manifest-preview.test.ts`, `reader-manifest-guard.test.ts` | **100/100 pass**, 64.89 s. Includes authorized whole-file deletion and consumer notice, private-disk publication controls, own/peer holder and head withdrawal, body-only/README provenance catch-up, active/clean siblings, second signature epochs, and preview anchors. |
| Provider and consumer withdrawal, each through narrowing prefixes, held state, exclusion, wrong fence, full→declared, full→intent, and holder-only change | **14 pass.** Running indexes and started ConflictSet; fresh synchronized copies checked immediately and after refresh/reconciliation. Withdrawn graph paths, edges, observations and contract slots are absent; no new contract notices. |
| Authorized graph-provenance lag across an actual new Node process, full and declared | **2 pass.** Child reconstructs only serialized Yjs state and session inputs. Unknown retains fact identity, consumers and epoch 1; caught-up graph restores the same conflict without a newly accepted ID. No module-level evidence cache crosses the process boundary. |
| Authorized subset restoration, full and declared | **2 pass.** One symbol returns to baseline and then conflicts again at epoch 2, while its still-conflicting sibling stays at epoch 1. Exactly the expected conflict/clean/reconflict IDs are accepted. |
| Private disk → running GraphIndex → ConflictSet → fresh reader | **4 pass.** Narrowed grant plus wrong fence at zero/default throttle, narrowing alone, and wrong fence alone. The private graph demonstrably indexes disk-only `private_only`, while fresh replicated graph/contract state contains neither it, the withdrawn path, nor the old fact/input digests. No withdrawal clean notice; default throttle waits for actual new-revision publication. |
| Same/different signature on re-entry | **2 fail**, N1. |
| Unrelated intent peer with held private file and full authorized provider | **1 fail**, N2; removal of the unrelated held path unblocks the valid contract. |
| `npx knip` after deleting all disposable code/configuration | **Pass, exit 0.** No reported unused production files/exports/dependencies. The initial run reported only the temporary review config; the clean-tree rerun reports none. |

The disposable matrix totals **25 distinct cases: 22 passing and 3 failing**, all failures assigned above. Refinement runs are not added to the total. A separate exploratory nested-entry-only mutation left a stale slot, but did not follow the publisher's atomic head/entry protocol; no real writer producing that interleaving was established, so it is not counted as a defect.

**Spec consistency:** manifest §6 row 17 and its new paragraph (`2026-09-28-manifest.md:496–498`), hub §7 (`2026-09-28-hub.md:276`), and reporooms invariant 7/§B5 (`2026-09-28-reporooms.md:57`, `:356`, `:394–395`) consistently require both paths authorized, silent withdrawal without retained identity, and identity-preserving unknown for authorized provenance lag. The contract exception is explicit in invariant 7 and the deletion rule. No remaining substantive contradiction was established. The earlier generic non-text conflict rules are read subject to this explicit contract exception.

The lead clarified that previously authorized bus messages are legitimate append-only history: withdrawal need not retract them. Probes therefore check absence of **new or replayed accepted notices** while outside, and removal of current derived state. The confirmed 0.16 transition window, private claim hashes, claims surviving host exit, done-after-follow-up and local carried reads are not findings.

Tests used a temporary Vitest config mapping workspace exports to this worktree, normal identity-clearing setup, one worker and no file parallelism; heavy jobs were staggered. `nice -n 10` was attempted, but the sandbox denied `setpriority`. No source edits, commit or push; all disposable probes, child source/executable and config were deleted. This report is the only retained file.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `340a29ce93`, with only this report changed. No combined-source tests were needed for a report-only contribution. Final Git status contains only this new review file.
