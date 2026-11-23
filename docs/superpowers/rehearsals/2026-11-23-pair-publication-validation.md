# Whole-pair publication validation — 2026-11-23

The reviewed implementation treats individual read/merge failures as completed unknown file
results. Only an unfinished current-input evaluation retains the preceding pair. See the
review follow-up and current validation results at the end; earlier counts are historical.

## Behavior and decisions

The real reconciler buffers file evaluations, prepares the existing ordered slot transitions
on a private map (yielding every 32 entries), refreshes backing storage and checks the current
input guard, then publishes all changed slots in one Yjs transaction. Notice decisions run
after publication using the existing IDs, epochs, urgency, projected bindings and replay rules.
Peer-removal cleanup also batches all removed slots per peer, with the same effects and no notices.
No shared schema, hub, relay, room_state labels or plugin bundle changed.

An interrupted pair keeps its previous completed file slots exactly. The existing `*`
diagnostic and retry backoff remain; the retry key uses the captured pair inputs so completing
a manifest invalidates the backoff. `room_state` still shows the last published conflicts and
lines, with no new stale/pending label, just as its existing settled-result reader does.
A possible-conflict replay now retains its last completed unreadable-file reason instead of
substituting a manifest-updating reason. The lead explicitly approved that text difference;
`replays the last completed possible-conflict reason while a manifest is arriving` covers it.

The lead required keeping main's invalidation of unbound legacy projected slots. These lack
a valid previously published pair result. `diagnosePair` invalidates all such slots together
with the existing `*` diagnostic in one transaction, while leaving bound slots untouched.
The legacy migration test remains unchanged.

Changed existing tests:

- `conflict-set.test.ts`: the due-retry failure test previously expected `*` to disappear
  before evaluation finished; it now expects the existing diagnostic to remain until success.
- `conflict-set.test.ts`: the yield test previously spied on per-file `settle` calls;
  it now spies on file reads, keeping the same event-loop-yield assertion before publication.
- `projected-notice-binding.test.ts`: the two retirement/restart cases previously expected
  the retained bound possible slot's status to become unknown; they now expect its original
  possible status. Binding, message ID, retirement and owed-message assertions are unchanged.

## Baseline reproduction

Ran the new real-reconciler observer tests against main's `conflict-set.ts` through a Vite
load override, leaving the checkout unchanged. Both fail on main:

- Moving a conflict from file a to b exposes `[[], ['b']]` to the map observer.
- Hash-only, binary and readable siblings expose three successively larger partial states.
- Peer removal exposes one surviving file before the empty result; its new observer test also fails on main.

The implementation exposes only the final pair state, locally and through replicated Yjs
updates. Additional regressions cover thrown reads, moving inputs, incomplete manifests,
uncheckable siblings, atomic peer removal, retained possible-replay wording, and a guard failure during private
slot preparation.

## Transaction measurement

macOS arm64, Node v22.23.4, installed workspace dependencies, five trials per size. Other
worker/test processes were active; this is a local measurement, not a platform latency guarantee.
Each trial used a fresh RoomDoc and ConflictSlots, a no-op post, deferred peer notices, a map
observer and an `update` listener (forcing Yjs update encoding). It measured initial conflict
publication, changed conflict hunks and complete clearance. Transaction time spans
`beforeTransaction` through `afterAllTransactions`; preparation and publication wall time
is measured around `await slots.settlePair(...)`. Every transition produced one map update.

| Entries | Transaction incl. encoding, all transitions | Preparation + publication, open/changed |
| --- | --- | --- |
| 1,000 | 2.03–7.89 ms | 54.07–106.28 ms |
| 2,000 | 3.95–4.76 ms | 209.83–260.46 ms |

2,000 slots deliberately stress the publication API; the reconciler's 2,000 total changed-path
budget normally permits at most 1,000 simultaneous shared candidates, though existing slots
can also be revisited. An earlier implementation computed slot transitions inside the atomic
transaction and measured up to 313 ms for 2,000 entries; this motivated private preparation.
Initial measurements without an update listener omitted encoding and were under 2 ms; those
are superseded by the inclusive figures above. Network transport and downstream consumers
are outside this measurement.

Reproduction (from repository root, save as a temporary `.mts` file inside this repository):

```typescript
import { performance } from 'node:perf_hooks'
import { RoomDoc } from '@room/shared'
import { ConflictSlots, slotKey, type Evaluation } from './packages/room-mcp/src/conflict-set.ts'
for (const count of [1000, 2000]) {
  for (let trial = 0; trial < 5; trial++) {
    const room = new RoomDoc()
    const slots = new ConflictSlots(room, async () => ({ ok: true, text: '' }) as never, '1')
    slots.deferPeerNotices = true
    const results = new Map<string, Evaluation>()
    for (let i = 0; i < count; i++) {
      const path = `file-${String(i).padStart(4, '0')}`
      results.set(slotKey('A','merge','B',path), { owner:'A',other:'B',kind:'merge',path,status:'conflict',inputs:'initial',factId:'initial',lines:[1] })
    }
    let begin = 0, duration = 0, updates = 0
    room.doc.on('beforeTransaction', () => { begin = performance.now() })
    room.doc.on('afterAllTransactions', () => { duration = performance.now()-begin })
    room.doc.getMap('conflicts').observe(() => updates++)
    room.doc.on('update', () => {}) // Include Yjs update encoding in the timed transaction.
    let started = performance.now()
    await slots.settlePair('A','B',results)
    const openTotalMs = performance.now() - started
    const openMs = duration
    for (const [key,r] of results) results.set(key,{...r, inputs:'changed',factId:'changed',lines:[2]})
    started = performance.now()
    await slots.settlePair('A','B',results)
    const changedTotalMs = performance.now() - started
    const changedMs=duration
    for (const [key,r] of results) results.set(key,{...r,inputs:'clean',factId:'',status:'clean',lines:[]})
    await slots.settlePair('A','B',results)
    console.log(JSON.stringify({count,trial,openMs,changedMs,cleanMs:duration,openTotalMs,changedTotalMs,updates}))
    room.doc.destroy()
  }
}
```

Run with `node --import tsx <file>.mts`.

## Coordination observation

At approximately 09:24 UTC, wakerec reported that reading my outgoing source returned
“not publisher; another session publishes this worktree” and that my overlay remained at rev7.
My previews explicitly use the current local working tree and are therefore current evidence;
peer previews of the frozen overlay are not. I did not change publisher ownership or apply a
workaround. `room_state(check=true)` at approximately 09:24 UTC reported healthy discovery,
relay health, matching 0.17.54 bundle/session, no delivery pending, local daemon PID 44941,
and a local-state warning about one unlisted `shadow` entry. It displayed no publisher or
rejected-publication warning. Full room_state listed my five current changed paths, while
path-state listed only wakerec's shared changes. A later peer preview reported my revision 17 without a snapshot-moved warning, so publication
appeared to advance again without a workaround. The lead will investigate this separately.

## Checks

Validation history: the first 38-file run had three expected interrupted-status failures
(661 passed). The second run had an actual redundant-refresh regression (27 registry snapshots
instead of the existing bound of 23); removing the pre-publication refresh restored 23 while
retaining the final post-preparation refresh. That run also loaded the newly added removal test
against the earlier transformed source because edits were still ongoing, so its result is not
final evidence. The final source was frozen before the complete rerun. Current focused bridge
and pair checks pass: 30 tests, 72.18 seconds, including the unchanged snapshot-bound test.

Frozen-source required selection: every room-mcp test filename containing `conflict`,
`notice`, `bridge`, `stale` or `lifecycle`, plus `tools.test.ts`, with `--maxWorkers=2`:
**36 files passed, 2 scale-only files skipped; 667 tests passed, 58 skipped, 1 todo**
(187.10 seconds). `npm run typecheck` and `git diff --check` pass.

Separate scale shadow/lifecycle pass:
`TEST_SCALE=1 npx vitest run packages/room-mcp/test/conflict-shadow.test.ts packages/room-mcp/test/shadow-failures-lifecycle.test.ts --maxWorkers=1`
passed **56 tests in 2 files** (333.94 seconds), including the two files skipped by the default run.

The remaining scale-only bridge/tools cases:
`TEST_SCALE=1 npx vitest run packages/room-mcp/test/bridge.test.ts packages/room-mcp/test/tools.test.ts --maxWorkers=1 -t 'F5 yields while preparing|profiles five warm claims'`
passed **2 tests** (6.84 seconds); the 160 other cases filtered by that command were covered
in the default run. Thus all **725 active tests** in the required 38 files were exercised
successfully across the default and scale passes; the existing todo remains.

The final named combined preview includes `rohanz+wakerec` and `rohanz+claude`, runs typecheck
and the pair-publication, wake-shadow and projected-notice-binding test files. Its final result
and snapshot identity are recorded in `room_done`; source remains frozen for that check.
No commits, plugin bundle edits or changes to the carried proposal were made.


## Review follow-up: file failures are completed unknown results

Independent review reproduced two delivery regressions in the initial atomic implementation:
a persistent merge-file ENOSPC suppressed a possible sibling notice, and withholding an
otherwise completed clearance prevented the later reopening from creating a fresh wake.
Two new tests first failed against that implementation through the real reconciler, in-process
hub and Ledger, then passed after the fix. The persistent failure test checks two failing
passes, complete per-pair map updates, a stored hub notice and its Ledger debt. The reopening
test receipts the first notification and verifies a fresh episode-2 notification is owed.

A file computation now returns an Evaluation before entering the pair-wide freshness guard.
Individual version-read and merge exceptions become `unknown` file results with the existing
retry backoff. Both parallel reads finish before that classification, so a remaining projected
read cannot extend the guard after publication. Failed reads during the carried no-change
optimization provide no proof of unchanged content; ordinary file evaluation still decides.
Input movement, incomplete/missing manifests and failed current-input guards still withhold
the entire candidate pair. A mixed read-failure/input-movement test checks that error handling
does not swallow that interruption.

Completed file results are published and announced before the independent claims phase.
A later claims error still propagates, as on main, but cannot hide completed file results;
a real-hub/Ledger regression covers this ordering. Normal file notices replay once, and the
remaining final replay handles the other notice kinds.

Failures without a file attribution remain pair-level: inability to enumerate the changed
paths, comparison/base unavailability and pair-size limits use the existing `*` diagnostic
and preserve prior current file results; thrown registry, baseline-discovery or earlier
contract-phase failures propagate before a complete file evaluation exists. Publication
freshness/storage errors also propagate and cannot be downgraded to a file result. No new
stale state or room_state label was introduced.

The accepted moving-input behavior is now explicit in docs/reference.md: a clear followed by
a reopen entirely inside an unfinished check is never published and remains one continuous
conflict, with no second wake. A real-hub/Ledger test starts from a receipted episode and checks
that the original ID remains the only stored notice and nothing new is owed.

Existing tests changed in this follow-up: the two merge-creation-error tests in conflict-set
now expect completed unknown file results and retry after their existing deadline; a successful
pair evaluation removes the old pair diagnostic even when one file is unknown. The prior
pair-publication test that expected a thrown read to retain all files now checks atomic readable
sibling publication and an owed notify instead. Historical validation counts above describe
the earlier implementation; current follow-up results are recorded below when complete.


Current follow-up checks: the required 38-file default selection passes **672 tests**
(36 files passed, two scale-only files skipped, 58 cases skipped, one existing todo;
183.75 seconds, maxWorkers=2). `npm run typecheck`, `git diff --check`, the focused
failure/phase-order regressions and the unchanged 23-snapshot bridge limit pass. A current
named combined preview with wakerec revision 20 and the lead passes 45 tests (13 file-pair,
20 recorder, 12 projected binding), with no merge conflicts. Scale passes are run separately
on the frozen follow-up source; their results and the final combined preview follow.


An additional boundary check first failed in all three cases (updating, no-record,
not-publisher): a rejected read must not mask its opposite endpoint's still-arriving result.
The implementation now prioritizes any interruption marker across both settled reads before
classifying an ordinary rejection as a file failure. All 16 file-pair regressions then pass.
The 672-test default pass above preceded this extra guard-priority correction; the complete
required selection is rerun on the final frozen source before handoff.


The first follow-up scale shadow/lifecycle run passed all 56 cases (430.12 seconds), while
the extra opposite-read interruption regression was being added. To avoid relying on mixed
source revisions, the complete default + scale sequence is rerun serially against frozen
final source. No test timeout or existing correctness assertion was weakened.


Final frozen-source default rerun: **675 passed**, 58 scale cases skipped, one existing todo;
36 files passed and two scale-only files skipped out of the same 38-file selection
(185.67 seconds, maxWorkers=2). Final standalone typecheck and diff check also pass.
The serial frozen-source scale checks are recorded next.


Final frozen-source scale results: the two shadow/lifecycle files pass **56 tests**
(323.96 seconds); the targeted bridge/tools scale cases pass **2 tests** (6.82 seconds).
Together with the default pass, all **733 active tests** in the required 38 files pass;
only the existing todo remains. The two reviewed notice-loss sequences were observed failing
before the fix and passing afterward through the real hub and Ledger. A completed clearance
now follows the normal fyi clearance path even when its sibling has an unknown result; the
later genuine reopening has a fresh notify and episode identity.

Production latency and a long real-session soak were not measured. The previous synthetic
transaction measurement remains applicable to the unchanged publication helper; this follow-up
changes evaluation failure classification and phase ordering. Pair-level preparation/storage
failure behavior remains as described above. Final named combined-preview outcome and exact
snapshot identity are reported in room_done. No source changed during the final default/scale
sequence, and no commit, CHANGELOG or plugin-bundle changes were made.


Final preview limitation: the last named preview was PARTIAL, with wakerec revision 24
reported stale (scanned 657 seconds earlier), the lead's manifest missing and its publishing
checkout unverified. Zero changed paths were applied; exit 0 only checked an incomplete tree
and is not combined integration evidence. Earlier complete preview 7f72c0ca958bd92050c0eacd009f89f2ffd2908e7f61c08ac0cbe69a22c0819e
passed typecheck and 49 focused tests against my final source (16 pair, 21 recorder,
12 projected-binding cases). Only this report changed afterward.

A health check at 13:29 UTC reported a healthy local relay, matching 0.17.54 host/bundle,
local daemon PID 20010, and Codex delivery `mid-turn-retry-limit` with one pending item.
No publication workaround was attempted. The lead explicitly confirmed it will collect both
workers and run the integrated checks from its publishing checkout; it requested finishing
without another preview. All local requested checks are complete and passing; the final
current combined tree remains for the lead to validate.
