# Final re-review 12 — area sharing and readers

**Range:** `git diff 45fd7ff a22296c`; reviewed HEAD `a22296cc57d0a25041e44b6f83b86eb17830e439`. Review restricted to `cb77509`'s changes to `conflict-set.ts`, `graph-index.ts`, their regression tests, and the manifest/hub/reporooms contract and graph rules. Bundle bytes and other areas excluded.

**Counts: 0 new must-fix / 0 new should-fix. Round-11 items: 2 RESOLVED / 0 PARTIAL / 0 NOT RESOLVED.** Checked-in regressions: **104/104 pass**. Independent disposable probes: **31/31 pass**, including all **14/14 withdrawal transitions**.

| Assigned item | Verdict | Evidence |
|---|---|---|
| Round-11 N1 — re-entry notice ID collision loses the newly authorized conflict | **RESOLVED** | `packages/room-mcp/src/conflict-set.ts:94` creates and persists a fresh contract episode UUID when no slot survives; `:114` includes it in the notice ID. Running-graph tests with an ID-deduplicating post adapter accept both the original and the re-entry notice for unchanged and changed signatures. Independent probes also cover consumer-side withdrawal/re-entry. Withdrawal remains synchronous and silent. |
| Round-11 N2 — an unrelated peer's outside-area held path degrades the full provider's graph | **RESOLVED** | `packages/room-mcp/src/graph-index.ts:379` and `:511` check the participant supplying the held entry, including its grant, exclusion and entry fence. Both intent and outside-area declared peers leave B's full graph ready and allow A's authorized contract notice. `:119`, `:143`, `:188`, `:212` and `:225` revisit manifest/degraded paths on grant changes; narrowing, widening, exclusion and removal controls clear and restore degradation as expected. |

## New must-fix

None established in the assigned range and area.

The discriminator contains no content-derived digest or outside-area detail: it is `randomUUID()`, stored as `ConflictSlot.episode`, not a signature/hash/manifest-derived token. The existing slot-key hash remains in the ID; the added component does not encode content. The slot is written before posting. `markContractsUnknown` preserves the episode through its slot spread (`conflict-set.ts:75`), `settle` preserves an existing episode (`:94`), and replay uses that persisted episode (`:105`, `:114`). A pre-existing slot without the optional field retains its prior ID form instead of acquiring a new ID merely through re-evaluation.

Independent process-boundary probes reconstruct only serialized Yjs state and session inputs in a new Node process, with no parent module cache. At both full and declared sharing, an authorized provenance gap retains the symbol, consumer list, fact identity, settled conflict, epoch 1 and episode. Catch-up and repeated replay accept no new ID when the original was already accepted. Starting the child with the persisted slot but no accepted notice repairs the owed delivery exactly once using that same ID.

The UUID changes on tested re-establishment after withdrawal, including identical-signature re-entry, while ordinary authorized signature changes advance the numerical epoch inside the same episode. Genuine clean transitions append `:clean` to that episode's current notice ID and are accepted once. Removing a slot does not retain its UUID or fact identity in current derived state.

For coverage, the unrelated private path is absent from B's published graph while B's authorized signature observation and A's contract remain present. Fresh synchronized readers see the ready graph and valid contract. The controls retain conservative degradation when the held path becomes authorized, then recover without changing the API signature when the grant narrows or the held path disappears. Thus the fix removes the outside-area source of global degradation without simply disabling coverage failures.

## New should-fix

None established. No style nits or previously accepted product rulings counted.

## Test-expectation audit

| Coverage or changed expectation | Assessment |
|---|---|
| New same/changed-signature re-entry tests (`conflict-set.test.ts:499`) | Non-vacuous: establish the original conflict and one accepted notice, assert immediate withdrawal and no new accepted notice, wait for current graph provenance, then require a second distinct accepted ID. The changed-signature case checks the newly delivered text. This catches the round-11 failure that raw post-call counts missed. |
| Episode-aware ID expectations and changed-signature epoch test (`:432`, `:441`) | Appropriate: the persisted episode now participates in identity. The second authorized signature still requires epoch 2, a different notice ID, and the same episode suffix. Independent probes also assert UUID shape, changed episode on re-entry, and stability through clean/reconflict. |
| Unrelated intent peer regression (`:551`) | Establishes ready provider graph, surviving API observation, omitted private path, actual contract slot and notice, and replicated state. Independent coverage adds the outside-area declared peer case. |
| Grant narrowing/widening regression (`:592`) | Checks error→ready→error→ready as indexer and peer grants change. Independent coverage additionally checks `degradedPaths`, peer exclusions, removal of the held manifest path, and preservation of the already authorized API episode through the coverage gap. |
| Provenance/restart and active/clean sibling expectations (`:660`, `:829`, `:887`) | Still require an unchanged authorized episode and no newly accepted ID. Fresh-process probes strengthen the checked-in fresh-RoomDoc restart test; running-graph subset probes verify clean-once and independent sibling epochs at full and declared sharing. |
| Former outside-area identity/wildcard/epoch-retention expectations | Remain obsolete under the cut. The 14-transition matrix requires immediate silent removal, no restricted graph facts or contract slots, and no newly accepted withdrawal notice. No old redaction/wildcard assertions were restored. |
| Authorized deletion, consumer-reference removal, private disk, preview and reader controls | Kept intact in the checked-in suites. The authorized whole-file deletion still notifies, actual reference removal clears, and private local indexing does not imply permission to publish derived evidence. |

**Withdrawal matrix:** every row starts with an actual epoch-1 contract and its accepted notice. Provider and consumer GraphIndexes are running and ConflictSet is started. Fresh Yjs copies are inspected immediately after withdrawal and again after refresh/reconciliation. The withdrawn path is absent from graph paths, edge endpoints and observations; the contract slot is absent; the old fact and episode are absent from current slots; the accepted contract-notice count stays unchanged.

| Transition | Provider path | Consumer path |
|---|---|---|
| Declared prefix narrowed away | Pass | Pass |
| Entry becomes hashless held, overlay withdrawn | Pass | Pass |
| Path excluded | Pass | Pass |
| Entry has the wrong fence | Pass | Pass |
| Full → declared with no authorized prefix | Pass | Pass |
| Full → intent | Pass | Pass |
| Holder-only replacement invalidates the existing publication | Pass | Pass |

**Verification evidence:**

| Check | Result |
|---|---|
| Complete `conflict-set.test.ts`, `graph-index-events.test.ts`, `graph-index.test.ts`, `manifest-preview.test.ts`, `reader-manifest-guard.test.ts` | **104/104 pass**, 98.83 s. Includes authorized deletion, real reference-removal clean, body-only/README provenance catch-up, active/clean siblings, second signature epochs, holder/head withdrawal and reader/preview controls. |
| Provider/consumer withdrawal matrix above | **14/14 pass.** |
| Same/changed-signature re-entry, withdrawing provider or consumer | **4/4 pass.** Exactly two accepted contract IDs after re-entry, with a new episode; replay adds none. |
| Unrelated intent/declared peer held path versus B's full contract | **2/2 pass.** Ready provider graph and accepted authorized contract, including replicated-state checks. |
| Grant/degraded-path sequence | **1/1 pass.** Own narrowing/widening, peer narrowing/widening, exclusion/restoration and held-path removal; active contract identity remains stable. |
| Actual new-process provenance recovery, full/declared × already-accepted/owed notice | **4/4 pass.** Persisted episode/fact/consumers survive lag and process restart; same ID deduplicates or repairs delivery once. |
| Authorized subset restoration and signature changes, full/declared | **2/2 pass.** Expected accepted sequence: two original conflicts, one sibling clean, sibling epoch 2, original symbol epoch 2. Each symbol keeps its episode. |
| Private disk → running GraphIndex → ConflictSet → fresh reader | **4/4 pass.** Narrowing alone, wrong fence alone, both at zero throttle, and both at the default 20-second throttle. Local cache demonstrably indexes `private_only`; current replicated graph/slots contain neither it, its signature parameter, withdrawn path, old fact nor old episode. The throttled case waits for an actual current-revision ready publication. |

The independent matrix totals **31 distinct passing cases**, executed in two disjoint selections: 21 cases in 9.26 s and the remaining 10 in 23.18 s. These used disposable `packages/room-mcp/test/r12B-disposable.test.ts`, a child executable built from this worktree's source, and a temporary Vitest configuration mapping workspace exports to this worktree. All disposable test/config/child files were deleted afterward. ID acceptance was exercised through a hub-style deduplicating adapter; no live hub or host wake-up claim is made.

The manifest §6 row 17/area paragraph, hub §7 and reporooms invariant 7/§B5 were the governing rules. Previously authorized append-only bus messages are history, so withdrawal checks concern current derived state and new accepted deliveries, not erasure of old messages. The confirmed 0.16 transition window, private claim hashes, claims kept on host exit, done-after-follow-up and local carried reads were not treated as defects.

Tests cleared inherited identity variables, used one Vitest worker with file parallelism disabled, and staggered heavy jobs. `nice -n 10` was attempted but the sandbox denied `setpriority`. No production source changes, commit or push; this report is the only retained worktree change.

**Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `a22296cc57`, with only this report changed. No combined-source tests were needed for this report-only contribution. Final Git status contains only the assigned new review file.
