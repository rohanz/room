# Final re-review, round 5 — sharing and readers

**Range:** `git diff c6f6c07 9932fbd`; reviewed HEAD `9932fbde29f16e8531d57824e5e60095d615cf14`. In-area fix: `70803c3`, `packages/room-mcp/src/conflict-set.ts` and its tests. Generated bundles and other areas excluded. The new graph finding is a remaining sharing/reader pipeline defect discovered by the assigned running-GraphIndex probe, not a claim that `70803c3` introduced it.

**Counts: 2 RESOLVED / 1 PARTIAL / 0 NOT RESOLVED; 1 new must-fix / 1 new should-fix.**

| Assigned item | Disposition | Evidence |
|---|---|---|
| Round-4 N1 — current graph provenance bypasses per-path privacy withdrawal; clean settlement retains a symbol key/digest | **RESOLVED** | Authorization now runs independently of provenance freshness (`conflict-set.ts:234`), before contract evaluation (`:486`), on observed changes (`:531`), and before clean settlement (`:566–568`). Current/coalesced narrowed-grant and wrong-fenced cases redact the restricted contract slot immediately. Fresh synchronized readers before and after reconciliation have the path wildcard, empty `factId`, and none of the old symbol, signature fact, observation input, symbol-key-derived unknown input, or symbol-key-derived clean input. Real GraphIndex variants also pass these **slot** assertions, including when the graph itself incorrectly republishes the path (new N1 below). |
| Round-4 N2 — redaction wildcard replays under a new notice ID | **RESOLVED** | `ConflictSlots.replay` and `postNotice` both exclude contract wildcards (`:139`, `:145`). A deduplicating adapter verifies exact accepted ID sets before withdrawal, while unknown, after a Yjs-copy/restarted reconciler, and after restoration. Controls cover no outage, an initially failed readable-sibling post, and an initially failed withdrawn-path post. No wildcard ID is attempted or accepted; the readable sibling's owed epoch-1 notice remains replayable. See the exact sets below. |
| M3 — contract pipeline end to end | **PARTIAL** | Provenance lag, mixed clean/active paths, restart, subset restoration and changed signatures pass. The round-4 contract-slot defects are fixed. However, new N1 shows the running GraphIndex publishing a private local definition's dependency edge after narrowing plus an entry-fence mismatch. A fresh reader receives that symbol-bearing edge even though ConflictSet correctly redacts its own slots. D1 therefore remains unclosed across the pipeline. |

## New must-fix

### N1 — A wrong-fenced entry makes GraphIndex republish private disk-derived symbols after narrowing

**Locations:** `packages/room-mcp/src/graph-index.ts:265–270` chooses local disk text from the raw entry; `:284–295`, especially the unconditional fallback at `:295`, promotes that text to the published graph when the filtered snapshot has no entry. `packages/shared/src/manifest.ts:77–79` correctly filters the wrong-fenced entry out of that snapshot. The synchronous withdrawal at `graph-index.ts:304–329` is undone by the subsequent refresh/publication (`:424–433`, `:501–503`, `:535–536`).

**Scenario:** B has published changed `api.py:call` and `aux.py:other`; A consumes both. B narrows its declared prefixes from both paths to only `api.py`, while an `aux.py` entry with a mismatching fence remains in the current manifest map. This is the same wrong-entry-fence boundary required by the assigned probes, combined with a narrowed grant. The local `aux.py` now defines `private_only`, a definition absent from both the committed base and the shared overlay. A's shared consumer references that name, but the graph previously had no definition/edge resolving it to `aux.py`.

`withdrawRestricted` initially removes the path. During refresh, however, `textFor` sees the **raw** wrong-fenced entry and reads local disk. `publicationTextFor` sees no entry in the **filtered** snapshot, bypasses the text-grant check inside `mine.entries.has(path)`, and returns that disk fallback. The resulting ready graph has current provenance and contains:

```json
{"source":"aux.py","target":"consumer.py","symbols":["private_only"]}
```

That definition's presence in the private file is newly disclosed. This is not merely a stale base edge: the probe first asserts that the edge is absent, then writes the new definition only to local disk; the base and old shared overlay do not define it. The narrowed graph omits `aux.py`'s observed signature, but its published dependency edge still carries private derived symbol information, violating D1's paths/state-only boundary.

**Disposable proof:** real temporary Git repository, real Python parsing, continuously running GraphIndex, separate consumer RoomDoc and ConflictSet, then a fresh synchronized reader. No graph snapshot was injected. The consumer first establishes both epoch-1 contract slots. After the combined withdrawal, the probe waits for the actual graph to become `ready` at revision 2, applies the coalesced provider update, verifies correct contract-slot redaction immediately and after reconciliation, then checks the fresh reader's graph. The assertion that the private edge is absent fails. It fails with both `minPublishMs: 0` and the default publication throttle; the default case republishes after approximately 20 seconds. Both disposable probes were deleted.

The narrower wrong-fence-only control also republishes the old signature observation and edge, while its contract slot remains redacted. The narrowed-grant-only control removes both graph detail and contract detail correctly. The combined case above supplies the direct privacy violation.

**Fix direction:** separate private indexing text from publication text at this fallback. A raw entry rejected by the active fence must not become permission to publish its disk text. Resolve publication from an authorized accepted version, or a genuinely certified base read, and reject a wrong-fenced raw entry rather than treating it as an ordinary absent entry. Apply the same per-path publication authorization through refresh and final publication that synchronous withdrawal uses. Add a running-graph regression combining grant narrowing and an entry-fence mismatch, with a new disk-only definition and a fresh-reader edge assertion after the default throttle expires. Preserve the passing contract-slot, declared-prefix and exclusion controls.

## New should-fix

### N2 — Two older regression fixtures no longer reach the transitions their assertions claim to test

**Locations:** `packages/room-mcp/test/conflict-set.test.ts:462–490` and `:960–969` (test starts at `:929`). This is a coverage regression exposed by the stricter authorization predicate, not evidence that those production transitions fail.

- The old “N1 removes signature-derived identities from a newly synced redacted slot” fixture starts B at `declared` with no `textPrefixes`. At `:476`, the new authorization check refuses to create the initial contract. All subsequent negative checks pass over an empty contract set. The test no longer proves deletion of a previously replicated identity.
- The “N2 advances an identical signature after redaction and a readable clean revert” fixture deletes the entry at `:961` but retains `declared` with empty prefixes at `:962`. Its supposedly “readable clean” reconciliation leaves the wildcard **unknown**, not clean. The later epoch assertion succeeds without exercising the intervening clean transition.

**Disposable proof:** copies of these tests with only missing precondition assertions added fail: the first expects an established epoch-1 conflict and receives `undefined`; the second expects the intermediate wildcard's status to be `clean` and receives `unknown`. Paired controls supply `full` at the intended readable phase, retain those assertions, and pass the original final checks. All four disposable cases were deleted.

**Fix direction:** make the intended grants explicit and assert the starting/intermediate states. Establish and inspect the original signature-bearing conflict before testing its redaction; restore authorization before claiming a readable clean revert, and assert clean before restoring the conflict. Keep the existing final digest/epoch checks. These are material test-coverage gaps, not additional production must-fixes; the new round-4 regression tests provide separate, non-vacuous evidence for the resolved items above.

## Test-expectation audit

All changed in-area test hunks were inspected. **No existing assertion was removed or weakened.** Existing fixture edits add actual grants where readability is intended, and the changed-signature/redaction test now explicitly withdraws and restores that grant. Those edits match the contract. New N2 identifies the remaining two fixtures whose named transition was not repaired.

| Changed or relevant coverage | Assessment |
|---|---|
| New current/coalesced direct cases (`conflict-set.test.ts:748`) | Both establish an actual restricted symbol slot before withdrawal and inspect fresh readers before/after reconciliation. Correctly exercise the round-4 gate omission and clean-key digest leak. Disposable extensions also cover held and excluded entries with already-current graph provenance. All four pass. |
| New running GraphIndex case (`:808`) | Uses committed definitions, real provider disk edits and the real indexer, then coalesces updates into a separate reader. Its narrowed-grant case passes. It does not test a wrong-fenced raw entry through publication; the disposable extension exposed new N1. |
| New wildcard replay/owed-sibling case (`:867`) | Correct exact accepted-ID expectations, including restart and restoration. It fails the continuously readable sibling's initial post. Disposable extensions also cover no outage and failure of the subsequently withdrawn symbol's initial post. All three controls pass. |
| Earlier contract regressions | Unchanged graph-provenance lag and restart, README-only running pipeline, mixed clean/active direct/restart and running pipeline, subset restoration, and changed signature after redaction all pass against HEAD. The original redaction and “readable clean” tests need the precondition repairs in new N2; corrected disposable versions pass. |

**D1 slot-field audit.** The four direct current-provenance controls retain the authorized sibling's epoch-1 identity and replace only the withdrawn path with an unknown wildcard. Fresh readers have no old symbol-bearing key/subject, signature detail, signature-derived `factId`, observation-derived `inputs`, `SHA256(symbol-key + NUL + unknown-reason)`, or `SHA256('clean' + NUL + symbol-key)`. The wildcard construction is explicit rather than a spread of the old slot; it preserves path/episode state and computes its input from owner, other, path and a generic reason. The corresponding running-graph reader checks pass before and after reconciliation. These findings certify the repaired **slot** boundary; new N1 prevents extending that conclusion to all replicated graph fields.

**Exact accepted contract notice sets.** Define these complete deterministic IDs:

```text
A1 = cf:4ff957fed40bd10c836f056e4d8fbdcf9e4acbc15421afa06118cf8e13c75040:1
B1 = cf:2e9ae19c50a20d5e988a755d741d633f5c474598c667b1f3ec1ee70d868e584c:1
B2 = cf:2e9ae19c50a20d5e988a755d741d633f5c474598c667b1f3ec1ee70d868e584c:2
```

`A1` is the continuously readable `api.py:call`; `B1/B2` are `aux.py:other`, which is withdrawn and restored. The adapter records an acceptance only the first time an ID succeeds, and records attempted IDs separately.

| Initial post failure | Before withdrawal | While unknown, connection restored | After fresh-doc/reconciler restart | After text restoration |
|---|---|---|---|---|
| None | `{A1, B1}` | `{A1, B1}` | `{A1, B1}` | `{A1, B1, B2}` |
| Readable sibling's `A1` | `{B1}` | `{B1, A1}` | `{B1, A1}` | `{B1, A1, B2}` |
| Subsequently withdrawn `B1` | `{A1}` | `{A1}` | `{A1}` | `{A1, B2}` |

No case attempts the synthesized wildcard ID, invents a fresh ID for the unknown transition, or increments the readable sibling's epoch. In the last row, withdrawal removes the unsent symbol identity; it is not reconstructed or disclosed while private. Restoration produces the new authorized epoch-2 episode. The earlier changed-signature test separately reaches epoch 3 after two prior signature episodes and a redaction. These are accepted-ID checks, not raw post-call counts.

**Verification:** 64 checked-in tests passed across `conflict-set.test.ts` and `graph-index-events.test.ts`. Fifteen distinct disposable cases produced eleven passes and four failures: two throttle variants of the private graph-edge leak, plus the two missing-transition assertions in old test fixtures. Their two corrected-grant controls pass. Repeated runs and exploratory assertions are not counted again. Tests ran sequentially with one Vitest worker and worktree-specific aliases generated from workspace exports, preventing accidental imports from the lead checkout. `nice -n 10` was attempted, but the sandbox denied `setpriority`; concurrency stayed at one. No live host session, socket suite, full build or deployment was exercised. The five confirmed human rulings were respected.

The disposable tests and configuration were removed. No source file was changed, and no commit or push was made.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `9932fbde29`; this report was the only changed path in the preview. No combined-source tests were needed for this report-only contribution. `git diff --check` passed; final status contains only this new report.
