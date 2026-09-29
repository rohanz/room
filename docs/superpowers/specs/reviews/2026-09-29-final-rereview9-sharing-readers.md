# Final re-review, round 9 — sharing and readers

**Range:** `git diff 8b27aa1 c984d83`; reviewed HEAD `c984d8317667cda9f9e67c26b34eac86ba68ac1b`. In-area fix: `9222e63`, `packages/room-mcp/src/conflict-set.ts` and its contract tests. Generated bundle bytes and other areas excluded.

**Counts: 1 RESOLVED / 1 PARTIAL / 0 NOT RESOLVED; 1 new must-fix / 0 new should-fix.** Round-8 N1's false-clean/duplicate-epoch failure is fixed. A separate recovery deadlock introduced by the local evidence guard remains; M3 does not count it again.

| Assigned item | Disposition | Evidence |
|---|---|---|
| Round-8 N1 — excluded or wrong-fenced consumers falsely clear a contract and restore it at epoch 2 | **RESOLVED** | All six original rows pass: deletion/signature × exclusion without claim, wrong fence without claim, and wrong fence with claim. Both exclusion-with-claim controls and both held-consumer controls pass. With the provider GraphIndex running on its original document and the withdrawal delivered only to the consumer reader, the prior contract becomes unknown, retains settled conflict, fact identity and epoch 1, accepts no clean notice, and returns to the same conflict/notice on identical restoration. Genuine readable reference removal still clears. A fresh process also avoids false clean and duplicate epochs, but fails to recover as described in new N1. |
| M3 — contract and graph pipeline end to end | **PARTIAL** | All **107/107** checked-in contract/graph tests pass, including the earlier privacy, authorization, provenance, redaction, replay, carried-baseline and graph-throttle regressions. All **12** same-process disposable recovery cases pass. All **12** separate-process recovery cases remain unknown after readable restoration, including genuine removal of the last reference; see new N1. |

## New must-fix

### N1 — A fresh MCP process permanently blocks existing contract slots on missing local consumer evidence

**Locations:** `packages/room-mcp/src/conflict-set.ts:50–56` stores evidence only in a module-level map keyed by room salt; `:358–364` rejects an existing settled slot when that map lacks its key; `:584–586` skips current dependency evaluation on that rejection; the only normal evidence population is downstream at `:612`; cleanup repeats the same rejection at `:624–626`.

**Scenario:** B's actual running GraphIndex observes deletion of committed `api.py:call(a)` or its change to `call(a, b)`. A's shared added `consumer.py` imports and calls `call`. A receives B's graph in a separate RoomDoc, starts its ConflictSet, and establishes the real epoch-1 contract. Only A's document then receives an exclusion, a wrong-fenced raw consumer entry, or a hashless held consumer publication. The provider's ready graph still matches its unchanged provider revision and fence. The fix correctly changes the contract to unknown without resolving it.

Stop A's evaluator, serialize the Y.Doc, and construct the evaluator in a **separate Node process**. The replicated contract survives; `contractConsumers` does not. In that process, restore complete, full, correctly fenced sharing and either:

1. Publish the identical consumer text, which should restore the original conflict at epoch 1; or
2. Publish readable `print("done")` text after the consumer dropped its final reference while unreadable, which should settle clean and accept the deterministic epoch-1 `:clean` notice.

Both remain unknown. Three further reconciliations, each with the evaluation clock advanced ten minutes to cross retry deadlines, also remain unknown:

```text
initial:                 conflict / settled conflict / epoch 1 / fact F
withdrawn:               unknown  / settled conflict / epoch 1 / fact F
fresh process withdrawn: unknown  / settled conflict / epoch 1 / fact F
readable restored:       unknown  / settled conflict / epoch 1 / fact F
later retries:           unknown  / settled conflict / epoch 1 / fact F
accepted IDs:            only cf:<key-hash>:1
```

For identical restoration, the expected final state is conflict with the same fact and epoch. For actual reference removal, it is clean with the additional `cf:<key-hash>:1:clean`. Neither transition occurs. The guard runs before examining current readable consumers and before its own evidence-population point; retries cannot recreate the missing map entry. The same circular dependency applies when a process starts with an already-readable existing slot, without a preceding withdrawal.

**Disposable proof:** `packages/room-mcp/test/r9B-disposable.test.ts`, with `.r9B-restart-child.ts` and an esbuild-generated child executable, all deleted after execution. The fixture used real temporary Git repositories, actual Python parsing, a running provider GraphIndex, a separately synchronized consumer document, and a deduplicating post adapter. The child bundled this worktree's unchanged implementation and reconstructed only replicated state, session identity and Git directory; it inherited no evaluator memory. It checked uncertainty first, then readability restoration and retries. The parent controls used the identical publications without replacing the process. The final matrix was **12 passes / 12 failures across 24 cases**: deletion/signature × excluded/wrong-fenced/held × identical/reference-removed × same-process/fresh-process. Every failure belongs to this finding. All initial-conflict, withdrawal safety and fresh-reader slot-privacy assertions passed.

**Why must-fix:** this is a persistent contract-evaluation deadlock, not merely conservative uncertainty during a coverage gap. Current readable evidence can no longer restore the slot or produce its legitimate resolution; §B5's retry/re-evaluation and transition behavior cannot progress. It violates the requested recovery condition even though the immediate post-restart safety requirement—no false clean or new epoch for the same fact—is satisfied.

**Fix direction:** make prior evidence recoverable locally across process lifetimes, or introduce a conservative reconstruction path that can establish fresh readable dependency evidence without first requiring the missing cache. Distinguish proof of a currently present reference from proof that all prior references are gone: lack of cached evidence alone must never certify clean. When historical paths are unknown and coverage remains incomplete, retaining unknown is appropriate; once sufficient current evidence is available, evaluation must be able to progress. Preserve the original fact/epoch for an unchanged conflict, the clean notice for genuine resolution, and the passing exclusion/fence guards. Do not solve this by replicating consumer-content digests or restricted path details. Add a real process-boundary regression.

## New should-fix

None established separately from new N1. The restart-test gap below is supporting evidence for that production defect, not an additional counted finding.

## Test-expectation audit

The in-area test diff only adds the eight exclusion/wrong-fence cases; no existing assertion was weakened or removed. These tests establish the initial dependency and conflict, preserve the two-document delivery order, and deduplicate accepted notice IDs. They correctly cover all six round-8 failing rows plus exclusion-with-claim controls.

**Evidence storage and D1:** the new prior-consumer evidence is a JavaScript `Map<roomSalt, Map<slotKey, paths[]>>`, not a Yjs field. Provider redaction unions those local path lists into a local wildcard-key entry. No new consumer-content digest or consumer-path field is added to a replicated slot. In every disposable case, a fresh Yjs copy's unresolved slot retained only the existing slot field set and contained neither the consumer path nor its Git-blob/SHA-256 content digests. This checks the new bookkeeping, not an assertion that a deliberately stale provider graph has already forgotten previously authorized edges. Process-local storage meets the privacy requirement; its missing recovery path causes N1.

**Restart expectations:** the existing tests named “MCP restart” or “including after restart” construct a new RoomDoc/ConflictSet in the same loaded module. Because the new map is keyed by stable room salt, those copies retain the old local evidence. Their passing results do not test an MCP process restart. The disposable subprocess probe exposes this distinction without modifying production code.

| Probe / regression | Result |
|---|---|
| Round-8 six rows: deletion/signature × sole excluded consumer without claim, wrong-fenced consumer without claim, wrong-fenced consumer with claim | **6 pass.** Unknown retains settled conflict, fact and epoch; identical restoration accepts only the original notice ID. |
| Exclusion with an open claim; deletion/signature | **2 pass.** Same episode on recovery. |
| Held consumer; deletion/signature | **2 pass.** Same episode on recovery. |
| Genuine last-reference removal from readable text | **Pass.** Checked-in deletion control becomes clean at epoch 1 and posts `:clean`. |
| Same-process withdrawal/recovery: deletion/signature × excluded/wrong-fenced/held × identical/reference-removed | **12 pass.** Six unchanged conflicts recover at epoch 1; six legitimately removed references clear, including changes made while unreadable. No permanent unknown while the cache survives. |
| Fresh-process versions of the preceding recovery matrix | **12 fail**, all new N1. Initial uncertainty is safe, but readable restoration and retries never recover conflict or clean. No duplicate accepted ID or false clean occurs. |
| Earlier contract regressions | **Pass.** Provenance lag and same-module Yjs-copy recovery; README-only graph catch-up; active/clean siblings; authorization withdrawal and coalesced updates; redaction identity privacy; wildcard replay suppression and owed readable notices; clean/subset epoch retention; second signature changes; current consumer reference checks; carried-baseline and degraded-coverage controls. |
| Earlier graph regressions | **Pass.** Full/declared authorized deletion; out-of-area shared D with no hash; wrong-fence withdrawal; own/peer holder and Git-fence changes; head-only grant/completeness recovery; default publication throttle; exclusions; base-read race; body-only/non-source revision catch-up; four private-disk-to-fresh-reader publication cases. |

**Verification:** complete `conflict-set.test.ts`, `graph-index-events.test.ts` and `graph-index.test.ts`: **107/107 pass** (65.55 s). Final disposable matrix: **12 pass / 12 fail** (8.98 s); preliminary runs are not counted again. Temporary Vitest configuration explicitly mapped workspace package exports to this worktree and used the normal identity-clearing setup, one worker and no file parallelism. Jobs were staggered. `nice -n 10` was attempted; the sandbox denied `setpriority`.

No host-feature assumptions, live host sessions, sockets, full build or deployment were involved. The confirmed 0.16 transition window, private claim hashes outside the area, claims surviving host exit, done-after-follow-up and local carried reads were not treated as defects. No tracked source file was changed and no commit or push was made. All disposable probes, child executable, configuration and logs were removed; this report is the sole retained output.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `c984d83176`, with only this report changed. No combined-source tests were needed for a report-only contribution. Whitespace checks passed; final Git status contains only this new report.
