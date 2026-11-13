# Retired conflict subjects and carried ancestors — 2026-11-13

## Final decision after review

The original investigation found hundreds of pending notices mentioning retired
workers without surviving publications. Independent review found that rejected
worker bindings could become destructive retirement evidence, text attribution
was ambiguous, and a lead's deletion of carried untracked work was never compared.

The first revision added subject-derived IDs and early cleanup of old notices.
The second review reproduced duplicate delivery of unchanged facts, including
facts already receipted, and loss of a saved merge notice after a real
`memorySnapshot` restore. That format retains mail but omits conflict slots and
ordinary publications, so the claimed independent display did not exist after
restore. Both mechanisms were removed, rather than repaired.

Notice IDs are exactly their pre-`05affc2f` form: no subject digest. Existing
managed registration still uses its original worker suffix, and unchanged facts
retain their original deduplication, epochs, receipts and clearing behavior.
Old notice bodies are not retroactively annotated when a duplicate ID is posted.

Subject retirement does not end notices written before this change early.
The stale-subject symptom fades within 14 days as those notices reach ordinary expiry.

## The retirement rule that remains

A notice whose exact worker subject the hub accepted is ended when that worker
retires; every other notice is left to ordinary expiry. Existing recipient-mail
retirement still ends messages addressed to retired workers, and normal ledger
caps and receipts are unchanged.

The managed registration proposal records only its exact worker subjects and
stores them only through hub acceptance. Every rejected, unavailable or
capability-absent fallback has no subject binding. Name-only fallback metadata
and its registry-based ending were removed: once baseline IDs are restored,
ending that fallback can suppress an identical same-tag successor conflict after
slots are deleted. Retaining the baseline fallback avoids writing the terminal
outcome that caused suppression. Historical name-only fields remain readable but
are not retirement evidence.

The shared matcher filters delivery and document cleanup by recorded exact
worker IDs, without parsing message text. Publication/root cleanup, exact-ID
notice cleanup and recipient retirement still share `retireWorkerState`.
Registry completeness, successor ownership guards and the existing retention
cadence remain; no new timer, stored identity index or compatibility stub exists.

## Carried work and eligible peers

Ancestor reads use the full selected baseline: its tracked tree and carried
untracked blobs. Lead-side enumeration includes that baseline's untracked paths,
so deleting an ordinary untracked file is compared against a worker modification
even when Git and the lead's manifest have no deletion entry. Current versions
still determine the merge result. Both-delete is clean; 1,999 carried paths plus
the worker edit remain comparable; 2,000 plus that edit yields explicit bounded
unknown. Missing and oversized ancestor blobs also remain unknown.

Every participant, online or offline, and every unretired worker remains eligible,
including finished workers retained for follow-up; an offline participant's claims and
published work still stand. Only a retired worker cannot create new conflicts. (An
earlier revision also excluded absent standalone participants; a full run showed that
dropped real claim conflicts, and it was reverted.) Pairwise byte equality still means a clean merge;
equality with a third participant does not establish provenance or adoption.

## Provenance follow-up before 0.17.49

The benchmark used main `94b243a3`. Evidence root:
`/tmp/room-coupled-benchmark-2026-11-13-t3/control/evidence/room/`.
The audit searched every worker transcript and `mirror/room-mcp/room-mcp.log`
for `[notify] CONFLICT on`. There are eight distinct directed notices (four
reciprocal episodes) and ten observed deliveries. The log contains three of
those deliveries; hook-delivered notices supply the others. Hook success,
hook context and later API-request copies of the same delivery are counted
once. Repeated hook deliveries are listed explicitly below. All times are UTC
on 2026-11-12; participants below have prefix `benchmark+`.

| Delivery time | Recipient / peer | File | Verdict and evidence at that moment |
| --- | --- | --- | --- |
| 22:40:40.714 | flows / lua-core | `src/commands/includes/cancelFlowHelpers.lua` | True text conflict, add/add at line 2. lua-core wrote its explicit stub at 22:40:37.619; flows wrote its real implementation at 22:40:38.602. The stub returned any parent key; the implementation handled parent flags and reactions. Log line 212; flows transcript line 118. |
| 22:40:44.599 | lua-core / flows | same | Same true add/add conflict, delivered by hook (lua-core transcript line 167). lua-core's next command removed its stub; both sides subsequently received clear notices (22:40:48.572 and 22:40:52.782). |
| 22:42:16.144 | lua-core / finish | `src/classes/redis-queue-backend.ts` | True claim conflict, not a text-merge verdict. finish's 1129–2468 claim enclosed lua-core's 1480–1507 `cancelJob` region. lua-core had added that method at 22:42:10.192 and immediately asked finish to leave it alone. Log line 372; lua-core transcript line 310. |
| 22:42:16.347 | finish / lua-core | same | Reciprocal claim notice. finish narrowed its claims at 22:42:16–19 and released the broad claim at 22:42:25.547; it received the clear at 22:42:56.944. Log line 373; finish transcript line 299. |
| 22:43:01.106 | finish / deadline | `src/classes/redis-queue-backend.ts` | True claim conflict: finish held 2130–2172 for `moveJobFromActiveToWait`; deadline held 2090–2128 and added its new cancellation helpers after the stalled methods at 22:42:50.286, shifting the mapped ranges. These were independent backend edits requiring coordination, not evidence of two incompatible versions of the same hunk. finish transcript line 359. |
| 22:43:05.685 | deadline / finish | same | Reciprocal claim notice, delivered alongside an overlap-clear notice. finish's later claim-clear delivery is at 22:50:34.816. deadline transcript line 301. |
| 22:43:28.812; repeated 22:43:51.715 | api / finish | `src/classes/job.ts` | True claim conflict between the published/moved claims for API additions and finish handling. API's edits included imports, properties, serialization and new methods; finish claimed imports and finish/delay bodies at 22:43:03–05. The advertised notice says “concurrent overlapping claims”, not “versions conflict”. api transcript lines 495 and 541. |
| 22:43:31.160; repeated 22:43:37.297 | finish / api | same | Reciprocal claim notice; finish received its clear at 22:47:25.087. finish transcript lines 386 and 404. |

Transcript line references use the main worker session JSONL under
`transcripts/*workers-<tag>/`. This confirms the observed stub/implementation
conflict and real claim overlaps. Under the narrower definition “two different
texts for overlapping lines”, only the Lua episode establishes a text conflict;
the other three are claim conflicts and must not be reported as demonstrated
text-merge conflicts. Nothing in these deliveries demonstrates a false
provenance conflict, and later clearance does not make the original claim or
text conflict false. Two redeliveries were observed, not additional facts.

### Reproductions on current main

`packages/room-mcp/test/conflict-provenance.test.ts` uses actual Git worktrees,
`room_collect(keep=true)`, the registry lookup used by `ConflictSet`, and
`refreshWorkerBase` with its resulting registry update. Publications are taken
from each checkout and its recorded baseline. Every pair is checked in both
directions.

| Requested case | Before the fix | Explanation |
| --- | --- | --- |
| Keep A, carry its collected output into B, B edits a different region | Clean; regression retained | A's kept snapshot and B's independently created carry commit prove the same inherited file through recorded baseline blobs. |
| Keep A, resume B without refresh while lead holds A's output | Clean; regression retained | B's original baseline merges the independent hunks. The tests also compare B directly with the lead holding A's collected text. |
| Both workers merge the same commit, then edit different regions | **False CONFLICT in both directions** | Publications remain pinned to spawn baseline H. Both branches adopt C; A refines C's line 2, B edits line 6. Comparing to H falsely treats B's inherited line 2 as a competing edit against A's refinement. |
| Refresh B onto a lead commit containing A's collected output | Clean; regression retained | The refreshed baseline and A's kept baseline already establish the shared inherited file. |

The fix uses the common ancestor of the two accepted, fenced Git HEAD facts
when it descends from both recorded worker baselines. This is explicit adoption
through commit history, not equality with the lead or another publisher. The
per-pass input guard already includes both Git facts and registry revisions;
changing either invalidates the result before publication. Missing history
supplies no new proof. Private kept snapshots that are not ancestors of the
branch tips keep their existing baseline rules, as do carried-untracked blobs.
No stored identity index, equality heuristic, registry field or ref was added.

Controls retain true conflicts when both workers change the same inherited
line and when the lead happens to hold equal bytes without an adoption fact.
The shared-merge regression uses distinct worker commits and merge commits,
so it checks a real common ancestor rather than only identical HEADs.

The four requested workflows are covered. Arbitrary copying between publishers
without a recorded carry, collection, refresh or shared Git ancestor remains
unattributable: equal third-party bytes cannot establish who adopted whom.
That uncertainty is intentional; this change does not hide conflicting edits
based on an inferred identity.

Provenance validation is separate from the historical validation below. On
unchanged source, the six carry/keep/refresh directions passed and the two
shared-merge directions failed with `conflict` instead of `clean`. An initial
fixture attempt produced eight missing-slot failures because it omitted the
room salt and retained projected-publication metadata; fixing the fixture to
publish joined-worker facts exposed the actual comparator result. Those setup
failures were not product reproductions. The sandbox refused `nice` priority
adjustment, but still executed the test command. No existing test expectation
was changed and no product behavior was removed.

The focused local run passed 164 tests across `conflict-set.test.ts`,
`conflict-provenance.test.ts` and `review-stale-carried.test.ts`; root typecheck,
knip and diff whitespace checks passed. The combined snapshot with `rohanz`,
`rohanz+kept`, `rohanz+small` and `rohanz+discard` also passed all 14 new
provenance tests, including a published third participant in the equality
control (fingerprint `d801b7f744dc53a16f21722a63799bf80f004fc3047683084383610586bece90`).
That pass is interim: kept's combined-tree source and discard's collection
source moved during the 126.66-second check. The first preview attempt had
already stopped before tests because kept's design note moved during capture.
Neither interrupted capture nor the interim pass certifies the latest combined
tree; final current focused preview evidence is reported in the worker's
completion. Full release, scale and bundle checks remain the lead's work.

## Carried-untracked claim follow-up

`conflict-carried-untracked.test.ts` creates the worker through actual
`room_spawn(carry=true)`, verifies its recorded untracked blob and copied bytes,
then publishes checkout-derived text and runs `ConflictSet` through its real
registry lookup. The carried file has 252 distinct lines. Both a 30-line append
and an interior replacement reproduce false lead-edit/worker-claim notices on
unchanged source, with and without a trailing newline. All four clean cases
failed solely on the claim slot and its reciprocal notices; all four competing
post-spawn lead-edit controls already passed. The text merge slots were clean
in both directions in the unchanged-lead cases.

The claim comparator read only `<mergeBase>:<path>`, where an untracked carried
file does not exist. It therefore treated the lead's entire inherited copy as
an earlier addition and mapped the worker's claim onto that supposed edit. This
is not an end-of-file special case. Claim mapping and its clean-merge annotation
now read the same bounded full baseline as text comparison, including the
existing carried-untracked record. The baseline blob is also a claim input.
Publisher-only and shared-checkout claim callers select that same lead/worker
baseline; the bounded path-enumeration fallback passes it too. Unavailable
baseline text stays unknown. No content-equality heuristic or stored state was
added, and no existing test expectation changed or product behavior was removed.

The final regression matrix also covers an unchanged sibling spawned with the
same carry, a claim spanning the old end-of-file line, and both non-publisher
claim callers with unchanged/competing lead text (14 tests). Real conflicts
remain reported for same-region lead edits after spawn.

The unchanged `rev3-carried-review.test.ts` adds five correctness controls and
a Git-read count regression. It reproduced two filtered reads of the same
carried blob in one warmed pass: text comparison and claim mapping each read
the ancestor. The pair now passes its already-read carried results to claim
mapping, including unavailable results, and reuses the unchanged-input check's
result too. This local map exists only within one pair's pass; tracked text
keeps its existing historical cache. All six review cases and the original
14 cases pass, with one filtered carried-ancestor read in the reviewed case.

The observed text notice is independently present in `.git/room-mcp.log` at
`2026-11-13T06:02:19.351Z` (line 2712 at investigation time): the worker's
carried documentation conflicts with the lead at line 254. The preceding
lead-side claim notice at `06:00:58.879Z` says the overlap merges cleanly; the
worker receives a plain claim conflict at `06:02:19.355Z`. These log lines do not
retain the comparator's baseline/publication inputs. The reported line-254 text
conflict was **not reproduced on current main** (`005246a8`); the clean text
cases remain regressions, and the text mechanism was not changed on a guess.

## Review tests and changed expectations

The reviewer's upgrade setup and assertions are preserved, including real
`Ledger.candidates` and already-read receipts. Calls to the deleted cleanup API
were replaced with actual `FileWorkerStore.retireWorkerMail` on temporary empty
registries at three sites in two files: the receipted upgrade and restored merge
cases in `review-stale2-lifecycle`, and the terminal-replacement control in
`review-stale2-retention`. The shared test resolves its downstream runtime only
while testing, keeping the shared TypeScript build independent of that project.
The reviewer supplied the missing `fromKind` on its synthetic old message.

The restored-merge test is restated as preservation through retention despite
no display after restore; its setup, real snapshot and pending assertion stay.
The additional successor reproduction now expects the old fallback to remain
pending after retirement/retention with no outcome, then still requires exactly
one deliverable notice for the identical successor fact and matching index
totals. The original intermediate expectation that retention ended the fallback
was changed because that mechanism was explicitly removed.

Other changed expectations and removals:

- Conflict-set exact ID helpers, both epoch/clear sequences, possible-overlap
  suffixes and contract/cleared IDs revert to their pre-digest expectations.
- Missing-holder and rejected-binding successor tests again derive the managed
  ID from the unchanged baseline. Actual document retirement remains tested for
  managed successors; the extra unmanaged case depending on digest IDs was
  removed with that mechanism and replaced by the retained-fallback regression.
- Three legacy-pending assertions in two retired-mail tests now preserve the old
  notice. Added exact-subject notices in those same tests still expire, including
  a worker dispatched by a departed lead; publication cleanup assertions stay.
- The first review's distinct-live-name merge no longer gains an early-expiry
  outcome. The two-held-endpoint legacy possible notice remains pending. Pair,
  ordinary-name, concurrency and delivery-total controls retain their assertions.
- The binding regression now covers managed and unmanaged stale replicas and
  requires no fallback subject field, while retaining its delivery assertions.
- Removed the five replay/migration cases, two early-expiry tests, carried-display
  assumption and registry-name-expiry case with the mechanisms they tested.
  Saved-copy instrumentation now counts retained legacy mail without classifying
  it for early ending. Existing carried correctness tests remain intact.

Removed roughly 45 product lines for digest IDs, legacy classification/ending,
and name-only registry authority, plus their test machinery; no files were
removed. Kept accepted registration, exact-ID retirement, publication/recipient
cleanup, bounded reads, successor ownership and index accounting because they
still enforce current guarantees. No bundles, frozen hooks, dependencies or
release files were changed.

## Fresh copied owner state

The opt-in saved-state test copied the current ydoc and entire registry into a
new temporary directory before loading either. Only the actual mail/state
retention phase ran using `openReader`; records still point to real worktrees,
so the destructive full sweep was deliberately not run on these copies.
The healing code never wrote the originals.

| Measurement | Final fresh copy |
| --- | ---: |
| Registry records | 105 |
| Pending messages before / after | 2,770 / 42 |
| Legacy conflict-family notices before / after | 669 / 40 |
| Legacy notices ended by recipient retirement | 629 |
| Legacy notices ended by subject retirement | 0 |
| Recorded exact-retired-subject notices before / after | 0 / 0 |
| Mail/state phase wall time | 72.74 ms |
| Synchronous retirement time | 21.74 ms |
| Largest observed 1 ms timer interval | 72.96 ms |

The remaining 42 are 32 legacy `conflict` notices, eight legacy `merge-conflict`
notices, one current note and one question. Recipients are `rohanz+claude` (36),
`rohanz` (3) and `rohanz+stale2` (3). The 40 legacy notices remain intentionally;
no participant is inferred from their text. Counts reflect this live room copy,
not earlier snapshots. The timer interval is one observed delay, not a percentile
or whole-sweep latency claim. Incremental pending IDs, recipient counts and bytes
equal a full DeliveryIndex rebuild.

## Validation

- Shared full suite: 328 passed, two process-inspection tests skipped locally.
- Hub-core full suite: 200 passed, nine files.
- Focused second-review lifecycle, retention, successor, carried and binding:
  14 passed, including actual snapshot restore and the carried scale boundary.
- Full requested MCP files plus the three new MCP review files: 223 passed,
  one saved-copy opt-in skipped in that ordinary run (11 files).
- Fresh copied-state opt-in: one passed separately, with the measurements above.
- Root typecheck, root knip and `git diff --check`: passed.
- Current named preview with `rohanz` rev 378: 31 passed across eight files,
  including both locally skipped watchdog process tests and all eight daemon
  retirement cases on the lead side. Check time 48.96 s, Node 22.23.4,
  darwin/arm64, two Vitest workers. Complete coverage for selected participants;
  the lead had no extra published edits, so this checked the worker's source
  tree. Fingerprint:
  `cf2f0220e3501a7e0a89b8e0bc553e61936545bccd8c53008b1783fc9d4db60e`.

The second reviewer's frozen original overlay is deliberately superseded by the
authorized imported/restated regressions, not merged over these removals. Its
independent review found no remaining blocker in exact retirement/carried scope;
the full final source checks above are this worker's evidence.

Intermediate failures were the reproduced review findings, a missing reviewer
fixture `fromKind`, a downstream test import that needed an absolute URL when
run from the shared package, and old expectations that legacy mail ended early.
Those are corrected or removed with their mechanism. No worker was spawned and
no unmanaged background job remains. Full collected-tree release/scale/build
validation remains the integrator's responsibility.
