# Final re-review, round 7 — sharing and readers

**Range:** `git diff 65c36ca 5e4434f`; reviewed HEAD `5e4434fd4d1689982030715089bc670118518b4d`. In-area fix: `435358e`, `packages/room-mcp/src/graph-index.ts`, `src/conflict-set.ts`, and their tests. Generated bundles and other areas excluded.

**Counts: 3 RESOLVED / 1 PARTIAL / 0 NOT RESOLVED; 1 new must-fix / 1 new should-fix.**

| Assigned item | Disposition | Evidence |
|---|---|---|
| Round-6 N1 — authorized whole-file deletion loses observed contract facts | **RESOLVED** | `graph-index.ts:549–553` records separately fenced deletion provenance; `:618–620` publishes authorized deletion observations without putting the deleted file back in live definitions. `conflict-set.ts:533–544` finds consumers without requiring the deleted provider's former live edge. Independent full and in-area declared probes establish the original edge, delete the actual file, synchronize a new reader, and obtain both the deletion observation and an automatic epoch-1 consumer notice. Legitimate out-of-area **shared D** and invalid-entry-fence controls disclose no symbol detail or contract notice. |
| Round-6 N2 — peer holder-only replacement leaves old symbols published | **RESOLVED** | `graph-index.ts:186–191` now observes peers' holder and Git fields. The authorization key and synchronous withdrawal at `:122–137` invalidate the old source before returning from the event. Checked-in and independent probes drain the initial timer, replace only the peer holder, and synchronize a fresh reader immediately: the stale edge is absent. The corresponding Git-fence-only case also passes, and neither edge reappears after idle work. |
| Round-6 N3 — peer head-only withdrawal/restoration strands the graph | **RESOLVED** | `graph-index.ts:133–144` queues affected paths after the transaction, including restoration from the manifest after the cached source was removed. `:428–429` invalidates both deduplication records after direct withdrawal. Independent grant and incomplete/complete cycles restore identical text and a ready graph without moving the graph owner's revision; fresh readers receive the legitimate edge. Initial timers are drained, withdrawal is also allowed to settle before restoration, and a default-throttle grant cycle recovers as well. |
| M3 — contract and graph pipeline end to end | **PARTIAL** | All three assigned production repros are fixed. Earlier private-disk, provenance, mixed clean/active, redaction, wildcard and holder regressions pass. The newly reachable deletion consumer-scan branch can nevertheless treat an unreadable consumer as a clean evaluation, then emit a new epoch for the same conflict after restoration (new N1 below). |

## New must-fix

### N1 — An unreadable consumer falsely clears a deletion contract, then re-notifies the same fact

**Locations:** `packages/room-mcp/src/conflict-set.ts:539–544`, `:558`, `:565–581`.

**Scenario:** B deletes committed `api.py`, whose `call(a)` is used by A's shared `consumer.py`. B's running GraphIndex publishes the deletion; A's synchronized reader starts a ConflictSet and establishes the real epoch-1 deletion conflict. A then narrows sharing so `consumer.py` becomes a hashless `held: 'scope'` entry, without changing its references. A sees its own publication before that update reaches B. B's graph is still ready and correctly matches B's unchanged head revision and fence. This is ordinary cross-document delivery order, not a fabricated or injected graph.

The new `deleted` branch scans A's paths, but `if (text && ...)` silently skips the unreadable consumer. It leaves `uses` empty and never puts the existing contract in `live`. Cleanup accepts the provider's exact deletion as empty text and settles that contract **clean**, sending its `:clean` notice. Restoring the identical consumer then re-establishes the identical `factId` at **epoch 2**, with a new notice ID. The sibling signature-change branch already checks `text === undefined` at `:553` and preserves unknown; the deletion branch needs the same uncertainty handling.

**Disposable proof:** a real temporary Git repository, Python parsing, a running provider GraphIndex, a freshly synchronized consumer RoomDoc, and a started ConflictSet. After the initial real deletion notice, only A's consumer document receives A's held publication; B remains running on its last received state. Assertions require `unknown` while held and restoration of the same fact at epoch 1. Both fail:

```text
before:   status=conflict, settled=conflict, epoch=1
held:     status=clean,    settled=clean,    epoch=1, factId=""
restored: status=conflict, settled=conflict, epoch=2, original factId
```

The identical two-document probe using an authorized **signature change** passes: `unknown` with “consumer version is not readable,” followed by the original conflict at epoch 1. A separate deletion control that actually removes the consumer's last reference also passes, correctly settling clean. If the provider receives the held consumer first, its graph becomes degraded and masks this defect; that ordering is insufficient regression coverage. Repeated posts with the **same** ID are not counted as duplicates here—the defect is the false clean transition and subsequently new epoch/ID.

**Why must-fix:** reporooms invariant 7 and §B5 require a clean evaluation at current inputs before clearing a conflict. A hashless held version is a gap, not proof that the dependency disappeared. This loses an unresolved conflict and creates a second episode for an unchanged fact.

**Fix direction:** preserve unknown when any consumer needed to establish absence is unreadable. Distinguish `undefined` from legitimate empty/deleted text before `consumesSymbol`, and prevent cleanup from marking the affected contract clean on incomplete consumer evidence. Add the two-document ordering test plus the signature control and genuinely removed-reference clean control; verify no `:clean` or new epoch occurs across held→identical restoration.

## New should-fix

### N2 — The new out-of-area deletion regression uses a state the publisher never emits

**Location:** `packages/room-mcp/test/graph-index-events.test.ts:158`.

The “outside declared area” deletion test rewrites its D entry to `state: 'held', held: 'scope'`. Manifest §4.1 and §4.5 explicitly keep out-of-area deletions **shared**, without a content hash: deletion is the exact path-level fact. With the current fixture, the `myEntry.state === 'shared'` gate in GraphIndex rejects the entry before the test has to exercise the actual shared-deletion authorization boundary. It can therefore pass even if that boundary regresses.

**Disposable proof:** the independent out-of-area row preserves `{change: 'D', state: 'shared', fence: '1'}` under a declared head with no text prefixes, after first establishing the provider/consumer edge. The running GraphIndex and fresh-reader checks pass with no deletion symbol observation or consumer notice. This is a test-coverage defect, not an additional observed production leak.

**Fix direction:** leave the D entry shared and hashless, assert that shape, and narrow only the head's text grant. Keep the fresh-reader symbol assertion and preferably establish the pre-withdrawal edge first. The invalid-fence row is a separate valid negative control.

## Test-expectation audit

All changed in-area test hunks were inspected. **No existing assertion was removed or weakened.** The nine newly added cases bring the three checked-in suites to **96 passing tests**. The out-of-area fixture issue is N2 above; it is not hidden by weakening an expectation in this review.

| Coverage rerun | Result and scope |
|---|---|
| Full and in-area declared deletion | Checked-in publication cases and independent automatic-consumer pipeline pass. Fresh readers retain the authorized deletion observation while the deleted path stays out of live definitions. |
| Out-of-area and invalid-fence deletion | Independent actual shared-D and wrong-fence cases pass: no symbol detail or notice. The checked-in negative cases pass, with the fixture caveat above. |
| Peer holder/Git replacement; head grant/completeness recovery | Checked-in cases and five independent rows pass. All establish an initial edge and wait beyond the initial 100 ms publication timer. Fresh readers confirm immediate withdrawal; grant/completeness restoration recovers the same edge and ready status without an owner revision change. The fifth row uses the default 20-second throttle. |
| Round-5 private disk fallback and fresh-reader D1 | Four independent pipeline rows pass: narrowed grant + wrong fence at zero/default throttle, narrowing alone, and wrong fence alone. Each establishes the old epoch-1 contract, writes `private_only` only on local disk, proves the private graph indexes it, and checks that the published graph omits the withdrawn path, observations and private symbol. A separate synchronized ConflictSet redacts the old symbol slot; fresh readers before/after reconciliation contain no old signature, fact/input identity, or symbol-key-derived clean digest. |
| M2 own-holder withdrawal and head-only exclusion | Checked-in immediate fresh-reader holder test and base-read race pass; exclusion remains withdrawn beyond the default throttle. |
| Provenance catch-up, mixed clean/active, no wildcard replay | Complete conflict suite passes, including README-only revision catch-up, restart, real running-graph mixed sibling clean/active handling, subset restoration, and owed readable-notice delivery without replaying redaction wildcards. |
| Legitimately resolved deletion | Independent last-reference removal settles clean. This distinguishes new N1's unreadable consumer from a real resolution. |
| Per-participant observer storm/loop check | Two running GraphIndexes, zero throttle. Thirty peer revision/scan-time and same-fence holder metadata updates cause zero peer path refreshes and at most two graph writes in total. A single coalesced holder+Git+head+manifest replacement refreshes the tested peer path exactly once, with four graph writes across both publishers (withdrawals and terminal publications), then no further writes during a 450 ms quiet window. Graph writes are not themselves inputs to these GraphIndex observers; the transaction-key sets and semantic peer key also avoid the tested duplicate triggers. No self-sustaining publication loop found. |

**Verification:** `vitest run` with a temporary configuration mapping every workspace package export to this worktree, one Vitest worker, and the normal identity-clearing setup. The checked-in `conflict-set.test.ts`, `graph-index-events.test.ts`, and `graph-index.test.ts` suites pass **96/96**. The final independent probe matrix has **16 passes / 1 failure**; that single failing scenario has the two expected failures documented in new N1. Preliminary runs and controls refined during investigation are not added again to those counts. Probes use real Git and running indexes rather than injected graph snapshots. `nice -n 10` was attempted; the sandbox denied `setpriority`. Heavy runs were staggered, with one test worker throughout.

No host feature assumptions, live host sessions, sockets, full build or deployment were involved. The accepted 0.16 transition window, private claim hashes, claims surviving host exit, done-after-follow-up and local carried reads were not treated as defects.

All disposable probes, temporary configuration, generator and logs were deleted. No source file was changed and no commit or push was made. **Finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor `5e4434fd4d`; this report is the sole changed path. Combined-source tests were unnecessary for the report-only contribution. Final whitespace checks passed.
