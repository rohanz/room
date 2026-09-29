# Final re-review, round 4 — sharing and readers

**Range:** `git diff b66b9e3 9fb9581`; reviewed HEAD `9fb95817d44413a6b87ad4c0351f49bc6af7ff7e`. In-area fixes: `e58e831` (per-path contract redaction) and `9515d38` (accepted-attempt preview labels). Generated bundles and other areas excluded.

**Counts: 2 RESOLVED / 1 PARTIAL / 0 NOT RESOLVED; 2 new must-fix / 0 new should-fix.** The new findings are remaining contract-pipeline holes, not claims that the faulty lines first appeared in this range.

| Assigned item | Disposition | Evidence |
|---|---|---|
| Round-3 N1 — a clean sibling duplicates a continuously readable active contract across provenance lag | **RESOLVED** | The new path partition preserves the active symbol's fact and epoch independently of its clean sibling. Checked-in direct/restart and running GraphIndex regressions pass against HEAD. Both establish two changed provider files, revert one, then advance provenance without changing the active signature; the active notice remains exactly epoch 1. The restart copies the actual replicated slots into a fresh RoomDoc. Four additional partial-withdrawal controls preserve the readable sibling's identity, and an offline-post/reconnect control delivers that sibling's owed epoch-1 notice exactly once. |
| Round-3 N2 — preview names the anchor from a rejected attempt | **RESOLVED** | The real combined-tree retry tests pass for a changed base and newly included live edits. The accepted base, copied accepted git record and included shared-path flag now come from the successful attempt. A disposable reverse-direction test removes the only live edit during retry, verifies the final scratch tree contains base text, and confirms both reply and note omit `+ live changes`. Public-record controls also pass; see audit below. |
| M3 — contract pipeline end to end | **PARTIAL** | Mixed-path provenance lag, restart, changed signatures, clean reverts, subset restoration, graph withdrawal and an owed readable-sibling notice pass. **N1 below** leaves withdrawn signature details/digests in replicated slots when the observer receives already-current graph provenance. **N2 below** generates a fresh wildcard conflict notice during partial withdrawal even though the slot is unknown. These prevent closure of D1 and §B5. |

## New must-fix

### N1 — Current graph provenance bypasses per-path privacy withdrawal

**Locations:** `packages/room-mcp/src/conflict-set.ts:231–233` gates the new per-path predicate at `:250–258`; `:564–574` subsequently settles the unredacted symbol clean. The gate checks held entries and exclusions, but omits the text grant and entry fence that the predicate itself correctly checks.

**Scenario:** A has accepted contract slots for B's `api.py:call` and `aux.py:other`. B narrows its declared text prefixes to `api.py`. An old shared entry for `aux.py` is still present. B's graph has already caught up and excludes that path. A receives the manifest and ready graph together, as can happen when Yjs updates are coalesced during catch-up. Neither `stale` nor `hidden` is true, so `unknownOrRedactContracts` never runs. The analogous current-graph case with a wrong-fenced entry also bypasses redaction. The readable sibling is unchanged throughout.

**Disposable proof:** three failing cases, removed afterwards:

- Direct current-graph controls for a narrowed declared prefix and a wrong-fenced entry publish the new head and current graph in one Yjs transaction. Immediately afterwards the restricted symbol key still holds its signature text in `why`, signature-derived `factId`, and observation-derived `inputs`.
- A production GraphIndex probe starts from real committed Python definitions and real changed provider files. A separate reader RoomDoc derives both contract slots. The provider then changes only the head's text grant, deliberately leaving the old shared entry to test the head restriction independently. The actual running GraphIndex removes `aux.py` observations and reaches `ready` at the new revision. Only then is `Y.encodeStateAsUpdate(provider, readerStateVector)` applied to the reader, with its ConflictSet observer running. **No graph snapshot is injected into this probe.** The reader immediately retains `subject: 'other'`, `why: 'was \`def other(a):\` now \`def other(a, b):\`'` and the old signature digest. After explicit reconciliation it becomes a symbol-keyed clean slot rather than a path wildcard. A fresh synchronized reader still receives `subject: 'other'` and `inputs = SHA256('clean' + NUL + symbol-bearing-key)`.

Thus this is not only a debounce delay: reconciliation removes the raw signature but leaves a derived symbol digest and symbol identity outside the current grant. It violates D1, which covers derived digests as well as raw text. The probe intentionally tests the same head-only restriction boundary as the previous review's controls; those previous controls also made provenance stale, which concealed this gate omission.

**Fix direction:** apply the complete per-path authorization predicate on every relevant observer event, independently of graph freshness. Restrict “mark readable paths unknown” to freshness failures, while always redacting paths that have lost authorization. Enforce that same authorization before clean settlement so an old shared entry cannot recreate or retain a restricted symbol key. Add current-provenance and coalesced-update controls, including a fresh-reader assertion after reconciliation; retain the passing held/excluded and mixed clean/active cases.

### N2 — Replaying a redaction wildcard invents an additional conflict notice

**Locations:** `packages/room-mcp/src/conflict-set.ts:93–95` replaces the symbol key with a wildcard while preserving `settled: 'conflict'`; `:135–144` replays that wildcard using a different deterministic notice ID. `:154` formats it as a contract change despite its unknown status.

**Scenario:** Both provider paths have already generated their epoch-1 contract notices. B makes `aux.py` hashless held while `api.py` remains readable. Per-path redaction correctly removes `aux.py:other` and creates `aux.py:*`. The next reconcile replays the wildcard because it retains settled conflict state. Hashing the wildcard key gives a new ID, so hub deduplication cannot identify it as the previously delivered contract episode.

**Disposable proof:** real Git fixture, real ConflictSet observer/reconciler and a posting adapter that accepts each ID only once. Initial accepted contract IDs were `cf:4ff957…:1` (`api.py:call`) and `cf:2e9ae1…:1` (`aux.py:other`). After partial withdrawal and reconciliation, the adapter accepted a third ID, `cf:be0ec0…:1`, with this body:

```text
B changed * in aux.py (provider graph or manifest coverage is updating)
```

There was no new readable contract fact. The extra ID survives a Yjs-copy/restarted-ConflictSet replay; the restarted replay deduplicates this erroneous third notice rather than removing it. The assertion that withdrawal adds no accepted contract notice fails. The continuously readable sibling itself correctly stays at epoch 1.

This violates §B5's “unknown posts nothing” rule and duplicates the logical notification on a privacy transition. A separate passing outage control verifies that the owed notice for the still-readable sibling remains replayable, so suppressing all unknown-slot replay would be an incorrect fix.

**Fix direction:** distinguish a path-level redaction/history placeholder from a replayable settled fact. Do not post a newly synthesized wildcard ID merely because the placeholder preserves settled state and an epoch floor. Preserve replay for authorized symbol slots and their stable IDs, and keep withdrawn symbol/signature digests out of replicated metadata. Test exact accepted ID sets before withdrawal, while unknown, after restart, and after restoration, including a post that failed before the withdrawal.

## New should-fix

None established in this range and area.

## Test-expectation audit

All changed in-area test hunks were inspected. **No existing assertion was removed or weakened.**

| Changed test file | Assessment |
|---|---|
| `packages/room-mcp/test/conflict-set.test.ts` | The three additive tests correctly cover mixed clean/active provenance lag with restart, the running GraphIndex equivalent, and synchronous held-sibling redaction. The first two test the original round-3 N1 scenario and pass. The held-sibling test stops after inspecting the redacted slots; it does not reconcile/replay and therefore cannot detect new N2. Its head revision advances ahead of the graph, so it also cannot detect new N1's already-current graph gate. |
| `packages/room-mcp/test/manifest-preview.test.ts` | The two additive tests exercise the real combined-tree retry through a controlled `baseFor` publication seam. They require enough reads to establish retry, inspect the actual scratch contents through a command, require `lastPreview.testsPassed`, and assert both reply and note. One changes the base; one adds a shared path. The disposable reverse-direction control supplies the missing removal case. |

**D1 field audit.** When the predicate is reached, all four tested transitions—held, excluded, out-of-area and wrong-fenced—synchronously redact only the affected path while preserving its readable sibling. Each started with an established conflict, first introduced a provenance gap, then withdrew one permission condition, and immediately copied the Y.Doc into a fresh reader without awaiting reconciliation. The restricted record has exactly `owner`, `other`, `kind`, `path`, wildcard `subject`, `status`, `settled`, `epoch`, `fence`, `checkedAt`, `inputs`, empty `factId`, and `why`. Its new input digest depends only on owner, other, path and a generic reason; no original symbol key, signature digest, observation digest or symbol-key-derived unknown-input digest remains. No `lines`, `retrySource` or other spread-through field survives redaction. The retained readable record legitimately keeps its fact identity. **The failing boundary is invoking this predicate at all when provenance is current**, not the contents of the wildcard it writes.

**Notice audit.** Accepted IDs are compared through a deduplicating adapter, not raw post-call counts. The checked-in restart and mixed-path pipeline cases remain silent for the active fact. A disposable outage control rejects initial posts, withdraws the sibling, reconnects and catches up the graph; the active symbol's owed epoch-1 ID is accepted exactly once. New N2 is the distinct, unauthorized wildcard notice generated for the withdrawn path. These results do not certify that notices owed for a subsequently withdrawn symbol can be recovered safely; that case belongs in the fix's regression set.

**Preview provenance.** `tools/combined-tree.ts:31–36` captures an accepted git record with each attempt's snapshot, `:235–242` returns its included metadata, and `tools/files.ts:215–225` formats only a captured base equal to that record's base. The handler does not reread current git metadata to label the accepted tree. Six disposable cases pass: ahead-of-upstream uses the branch without claiming a push; a rejected git fence emits no included anchor; a base differing from the published record emits no included anchor; held-only edits omit the live suffix; included shared edits add it; and a successful retry removing the sole live path removes the suffix from reply and note. No tested label names the unpublished alternate base. Existing complete/partial real-push tests also pass. The six matching carried-work preview tests pass; accepted local carried reads were not reclassified as a defect.

**Verification:** 77 checked-in tests passed: 71 across `conflict-set.test.ts`, `graph-index-events.test.ts` and `manifest-preview.test.ts`, plus six preview-matching cases in `carry-wip.test.ts` (18 nonmatching cases skipped). Fifteen distinct disposable cases produced eleven passes and four failures: three manifestations of new N1 and one of new N2. Repeat executions are not counted again. Tests ran sequentially with one Vitest worker and aliases generated from this worktree's package exports, avoiding accidental imports of the lead checkout's source. `nice -n 10` was attempted but the sandbox denied `setpriority`; concurrency remained one. No live host, listening-socket suite, full build or deployment was exercised. All confirmed human rulings were respected.

The disposable test files and configuration were deleted. No source file was changed, and no commit or push was made.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `9fb95817d4`; the lead's registry/names/cutover review and this report occupy separate paths. No combined-source tests were run for the report-only contribution. `git diff --check` passed; final status contains only this new report.
