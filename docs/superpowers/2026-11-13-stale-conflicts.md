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
