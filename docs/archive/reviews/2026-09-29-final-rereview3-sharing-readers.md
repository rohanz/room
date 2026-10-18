# Final re-review, round 3 — sharing and readers

**Range:** `git diff 0b64667 7a3a882`; reviewed HEAD `7a3a88297b3bfe1561995cea1cd0673490afb489`. In-area fixes: `8dada1b` (`conflict-set.ts`) and `6bf1267` (`tools/files.ts`), with their tests. Generated bundles and other areas excluded.

**Counts: 0 RESOLVED / 3 PARTIAL / 0 NOT RESOLVED; 1 new must-fix / 1 new should-fix.** The item count includes the two assigned round-2 items and rehearsal F4. The must-fix is a remaining scenario of round-2 N1, also preventing M3 closure; it is counted once.

| Assigned item | Disposition | Evidence and remaining scenario |
|---|---|---|
| Round-2 N1 — unchanged conflict across temporary graph provenance lag | **PARTIAL** | `markContractsUnknown` preserves `settled`, `factId` and `epoch` while replacing the freshness input. The checked-in direct/restart test (`packages/room-mcp/test/conflict-set.test.ts:493`) and real GraphIndex README-edit test (`:534`) both pass: exactly the accepted epoch-1 ID, including after Yjs synchronization into a fresh RoomDoc and a new ConflictSet. **Remaining N1 below:** a clean, reverted contract path in the same provider's slot set makes `slots.every(...)` fail and redacts the unchanged active path too. Proven both directly and through a running GraphIndex. |
| Round-2 M3 — contract pipeline end to end | **PARTIAL** | The single-active-contract pipeline now survives README-only provenance catch-up. Existing changed-signature, clean-revert, subset restoration, fresh-reader redaction and graph-withdrawal tests still pass. Four additional controls establish synchronous slot redaction when a freshness gap becomes held, excluded, declared-out-of-area or wrong-fenced. No new restricted-content digest leak was established. **Remaining N1** still produces a second logical notice for an unchanged, continuously authorized contract. |
| Rehearsal F4 / `6bf1267` — name included commit anchors in preview output and notes | **PARTIAL** | The checked-in real-push fixture passes for both complete and partial previews. Anchors come from `baseFor` only when equal to an accepted participant git record's `base`; the new code hashes no file content. Ahead, updating-record, local-session, shared and held controls pass. Existing `merge preview with`, `partial preview with` and `no conflicts across N path(s)` phrases remain. **Remaining N2 below:** the label is captured outside the combined-tree retry, so a successful preview can name a different commit from the one actually tested. |

## New must-fix

### N1 — A clean reverted path makes a harmless freshness gap duplicate another active contract

**Locations:** `packages/room-mcp/src/conflict-set.ts:240–249`, particularly the provider-wide `slots.every(...)` and `entry?.state === 'shared'` requirement at `:244`; provider-wide redaction at `:81–99` and restoration at `:103–114` explain the resulting epoch increment. **Fix under review:** `8dada1b`; this is incomplete resolution of round-2 N1, not a claim that this scenario first appeared in this range.

**Scenario:** A consumes B's `api.py:call` and `aux.py:other`. Both signatures change and generate their initial notices. B reverts `aux.py` to base; its manifest entry disappears and reconciliation settles that contract clean. `api.py:call` remains changed, shared at `full`, and continuously readable. On a later README-only revision, the graph briefly has the preceding provenance. The clean `aux.py` slot still belongs to B's contract set, but has no manifest entry. Consequently `stillReadable` is false for the entire provider, and `redactContracts` replaces **both** paths' identities with wildcards. Catch-up restores the unchanged `api.py` fact as a new episode.

**Disposable proof:** two production-code probes, removed afterwards:

- Direct reconciler: real temporary Git repository, two observed provider signatures and a consuming file; reconcile both conflicts, remove `aux.py`'s manifest/overlay entries, publish a current graph without its observation, and reconcile its clean settlement. Start the ConflictSet observer, advance the head revision, then restore identical `api.py` graph provenance.
- Running pipeline: the same sequence with an actual `GraphIndex`, real provider file edits/revert, and README publication; no graph snapshot was injected into this pipeline. GraphIndex remained running throughout; the ConflictSet observer was started after establishing the clean sibling, before the README edit.

Both required accepted IDs for the active symbol to be `[cf:4ff957…:1]`; both produced `[cf:4ff957…:1, cf:4ff957…:2]` through a deduplicating post adapter. The only intervening change to the active contract was graph freshness. This directly violates reporooms §B5's **conflict → unknown → same conflict is silent** invariant.

**Fix direction:** decide preservation/redaction per path or slot, so a reverted, held or otherwise unavailable sibling cannot erase a still-authorized active path's episode identity. A clean slot whose path genuinely equals readable base must not force all other paths through privacy withdrawal. Preserve path-level monotonic history where actual withdrawal requires deleting symbol identity. Add this mixed clean/active scenario to the direct, running-graph and restart regressions; do not weaken the existing D1 checks or restore replicated hashes of restricted signatures.

## New should-fix

### N2 — Preview anchor text is captured before the snapshot that actually succeeds

**Locations:** `packages/room-mcp/src/tools/files.ts:215–228`, consumed after `buildCombinedTree` at `:240`, `:254` and `:285`. **Introduced by:** `6bf1267`.

**Scenario:** B's accepted base is C1 when `anchors` is constructed. While the combined-tree engine awaits Git work, B publishes C2. The engine correctly rejects its old snapshot and retries against C2. The returned tree and tests now cover C2, but both the reply and successful bus note still use the precomputed C1 label. The same capture also applies to `pushed to` and `+ live changes`.

**Disposable proof:** a real temporary Git repository contained distinct C1 and C2 file contents. A controlled `baseFor` seam published C2 on the participant's third base read, during path enumeration after asynchronous Git work, after the first combined-tree snapshot had been captured. This exercised the actual snapshot recheck/retry; the engine was not mocked. A scratch command requiring C2's `newest` contents passed, and `lastPreview` was `{ complete: true, testsPassed: true }`. The note nevertheless read:

```text
merge preview with ben: no conflicts across 1 path(s); included ben at 21bed2f9b6 (pushed to origin/r17-b); … passed
```

The tested accepted anchor was `823e54ef67`. The assertion that the note name that anchor failed. The disposable test was removed.

**Why should-fix:** the combined code and tests are correct, but the new audit wording attributes their result to the wrong version, undermining F4's purpose. No tree corruption, new content disclosure or false test success was established.

**Fix direction:** return the accepted git record/base and included-change metadata from the successful combined-tree attempt, and format the reply and ledger note from that same immutable result. Do not reread current records after tests: they may already describe a newer version. Cover a retry with a changed base and a retry that changes whether live edits were included.

## Test-expectation audit

All in-area changed test hunks were inspected. **No existing assertion was removed or weakened.**

| Changed test file | Assessment |
|---|---|
| `packages/room-mcp/test/conflict-set.test.ts` | Additive and spec-correct. The fixture optionally commits source files so the real indexer can derive the change. The new restart case preserves the replicated slot and accepted ID across a fresh RoomDoc/ConflictSet; the running case uses an actual README edit and waits for current graph provenance. Both correctly require exactly epoch 1. Both have only one active provider contract path, so neither covers the clean sibling that defeats the provider-wide readability predicate. |
| `packages/room-mcp/test/manifest-preview.test.ts` | Additive and spec-correct. It creates a bare origin, actually pushes the commit, checks the tracking ref, and asserts anchor text in complete and partial output/notes. Its anchor stays fixed during each preview. It does not test a snapshot retry, `ahead > 0`, rejected git fences, or local worker disk/manifest lag. |

**D1 and the new unknown state.** At `conflict-set.ts:73`, `inputs = SHA256(key + NUL + why)`: the key includes the symbol, so this is derived symbol information, not inherently safe path-only metadata. The spread also retains the prior signature-derived `factId`. It is safe only while the corresponding path remains authorized. The new gate requires a valid manifest fence, complete/all coverage, matching record base, a same-fence shared entry with a hash, `full` or a containing declared text prefix, and no exclusion. Four disposable controls first established an epoch-1 conflict, advanced provenance to get the retained unknown slot, then narrowed one condition. Each checked a freshly synchronized reader immediately, without awaiting reconciliation: the original symbol key, signature fact digest and key-derived unknown-input digest were absent, replaced by the path wildcard with empty `factId`. In the declared-prefix and exclusion controls, an old shared entry was deliberately left in place to verify that it could not override the head's restriction. Existing GraphIndex tests independently passed synchronous graph withdrawal, holder changes, and head-only exclusion under both zero and default publication throttles. These checks support privacy preservation; N1 concerns overly broad erasure and duplicate episodes.

**Preview provenance and wording.** `files.ts:221` omits a label for an updating/rejected record or a base mismatch; every emitted SHA is a prefix of an already accepted public participant git-record base, never a new digest of held text. `:222` requires upstream, zero ahead and `head === base` before saying `pushed to`; an unpushed-head fixture instead reports the branch. The string is an observation of the published git record, not proof of who performed a push. Local base resolution does not invent a remote upstream, and local workers keep their accepted carried base. The new code does not read worker disk content for anchor generation. Six existing carried-work preview cases passed, including preview from each side and competition with carried edits; accepted local carried reads were not reclassified as a defect. `+ live changes` is currently driven by shared manifest entries, not a computed list of contributions to the successful tree: shared/held static controls pass, but it shares N2's stale-capture problem, and these tests do not certify exact annotation of unpublished local-worker disk edits or deletion-only changes.

**Verification:** 72 checked-in tests passed: all 66 tests in `conflict-set.test.ts`, `graph-index-events.test.ts` and `manifest-preview.test.ts`, plus the six preview-matching cases in `carry-wip.test.ts` (18 nonmatching cases skipped). The round-2 unchanged-fact, README pipeline and MCP-restart probes are now checked-in regressions and were rerun unchanged. Twelve distinct disposable probe cases added nine passing controls and three failing cases: two reproductions of N1 and one N2 reproduction. Repeated runs of the N2 case are not counted again. The direct privacy controls inspect replicated conflict slots; the checked-in graph tests supply graph-withdrawal coverage. No live host session, listening-socket suite, full build or deployment was exercised.

Jobs ran sequentially with one Vitest worker and worktree-specific aliases generated from the actual workspace package exports, preventing tests from resolving the lead checkout's source. `nice -n 10` was attempted; the sandbox denied `setpriority`. The disposable test files and configuration were deleted. No production source file was changed, and no commit or push was made. All five confirmed human rulings were respected.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against `7a3a88297b`; the lead's delivery/hub review and this report occupied separate paths. No combined-source test was necessary for the report-only contribution. `git diff --check` passed; final status contains only this new report.
