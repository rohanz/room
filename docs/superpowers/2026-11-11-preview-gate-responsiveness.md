# Preview and collection gate responsiveness — 2026-11-11

## Current design: size-limited synchronous equivalence

This replaces the yielding gate and ledger-only epoch in `7f041479`. Independent
review in `08db0e22` proved that audit incomplete: six real in-process writers could
change already-checked files, lock loss and final-await cancellation could still
certify, and a 1M-path normalization blocked the event loop for about 1,006 ms.
The complete original inventory and reproductions are preserved unchanged in
`REVIEW-ASTRA-GATE.txt`. Passing the lead's 5,597-test suite did not establish this
writer exclusion.

The lead chose a smaller change instead of a new filesystem facade across roughly
35–45 source files and 200 mutation/open/handle call sites. That unfinished facade
was dropped before any writer call sites were converted. The ledger instrumentation
and `tree-writes.ts` epoch were removed entirely. Ownership acquisition/release
logic is unchanged; the existing destination lease gains only the assertion context
described below.

`MAX_EQUIVALENCE_FILES = 2_000` limits included paths, including missing tracked paths.
Repositories currently using Room have 99–1,368 tracked files, so the lead chose
2,000 rather than disabling equivalence for Room's own repository at 1,000.

- Eligibility scans at most N+1 distinct Git paths, stopping before an unbounded
  Set, sort or serialization. Over-limit trees skip byte fingerprinting and gates.
- Every preview still runs its command and reports its ordinary command result.
  Over-limit evidence stores `tree:null`, `passed:false`, `equivalence:"too-large"`,
  plus `equivalence was not established because the tree has more than 2,000 files`.
  Successful commands remain successful; file equivalence is not certified.
- Collection checks eligibility before fingerprinting or reading a large evidence
  record. Its exact over-limit reply is
  `tree too large to compare cheaply (more than 2,000 files); validate it`.
- At/below the cap, asynchronous listings establish eligibility and feed hashing.
  The final included-path listing is still synchronous, followed by one synchronous
  lstat/realpath pass comparing both pre- and post-command observations. No await
  occurs between this pass and the launch/report decision. It checks every ancestor
  separately, including absent-file observations and rewrites back to old bytes.
- The uncapped listing API uses cooperative merge sorting and deduplication. Record
  serialization is incremental and refuses over 8 MiB before a whole-record copy.
  Hash manifests remain deterministic and compatible with existing records.
- The helper records close/error/release and exposes a synchronous ownership check.
  Tracked commands subscribe to observed loss and stop. Launch, final certification
  and conditional publication all recheck authority/cancellation. A lost helper or
  abort before publication downgrades the reply and leaves no passing evidence.
  Cleanup asserts ownership before reset/removal and leaves a lost slot alone.
- Under the actual destination lease, a small AsyncLocalStorage context carries its
  existing holder assertion into collection diagnostics. It rechecks the bounded
  lease record after the final await and before a passing decision. Missing or
  changed ownership produces an unavailable diagnostic without changing collection
  acquisition/release or turning already-applied files into a failed collection.

The synchronous path listing is essential. A real-Git reproduction returned
`observed.txt`, then a same-process callback created `already-empty/new.txt` before
resolving that listing promise. A metadata-only pass over retained observations
succeeded while a fresh listing found both paths. The lead explicitly retained
final synchronous enumeration rather than weakening path-membership semantics.

## What the bound means

This is a file-count bound on metadata work, not a wall-time guarantee. Deep paths,
a slow filesystem and Git traversing ignored/untracked directories can still stall
longer even with at most 2,000 included files. The existing bounded Git timeout
fails equivalence closed; it is not a 200 ms Git traversal deadline. Normalization
and large rejected serialization yield, but kernel calls and host scheduling do
not have a real-time guarantee. Existing 8 MiB evidence reads are byte-bounded.

The gate excludes new JavaScript tasks from this MCP process during its final
stretch. As before, it is not an atomic filesystem snapshot against other processes
or already-running filesystem operations; those writers must be quiescent. The
existing Git-state, environment, ignored-file and external-writer caveats remain.
A newer failed/pending evidence publication cannot be hidden by cached pre-await
history: collection still opens one latest immutable record after its final await.

## Measurements

Local Node v22.23.4, macOS arm64, APFS temporary fixtures, 100 files per nested source
directory. Seven warm samples per row; the metadata comparison checks both original
and post-command observations using one lstat and one realpath per file. These are
samples, not a latency distribution or a guarantee for CI/Windows/network filesystems.

| Files | Metadata-only median | Metadata-only longest | Assumed 3× longest |
| --- | ---: | ---: | ---: |
| 1,000 | 20.84 ms | 25.06 ms | 75.18 ms |
| 2,000 | 42.09 ms | 44.42 ms | 133.26 ms |
| 5,000 | 101.39 ms | 112.70 ms | 338.09 ms |
| 10,000 | 212.85 ms | 242.86 ms | 728.59 ms |

The whole synchronous stretch also includes Git. The following rows use the direct
checkout layout, not the deeper cached preview directory. These samples overlapped
two focused test processes; all synchronous calls in one row remain on one event loop:

| Tracked files | Ignored files | Listing median / max | Whole stretch median / max | Assumed 3× whole max |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 0 | 6.73 / 7.57 ms | 28.82 / 39.61 ms | 118.84 ms |
| 2,000 | 0 | 8.50 / 8.70 ms | 53.87 / 56.54 ms | 169.62 ms |
| 1,000 | 50,000 | 7.03 / 15.73 ms | 30.61 / 40.48 ms | 121.43 ms |

The ignored tree was `node_modules/`, with 500 directories holding 100 files each,
ignored by `node_modules/` in the root .gitignore. Git can prune that directory;
this does not establish a bound for ignore rules requiring traversal. No tested
ignored-tree case exceeded the unchanged 200 ms responsiveness limit.

An earlier direct-validator fixture measured **30.28 ms at 1,000 files** and
**54.94 ms at 2,000 files**. These are not cached-preview measurements. A final
cross-check passively wrapped the actual cached preview's synchronous listing and
validator, preserving all arguments/results and including both prelaunch and
post-command boundaries. Concurrent room load and deeper ancestry increased cost:

| Files | First actual cached sample | Final consolidated sample | Longest observed cached stretch |
| --- | ---: | ---: | ---: |
| 1,000 | 52.47 ms | 67.61 ms | 67.61 ms |
| 2,000 | 178.82 ms | 103.68 ms | 178.82 ms |
| 5,000 | gate skipped | gate skipped | zero final gates / fingerprints |
| 50,000 | gate skipped | gate skipped | zero final gates / fingerprints |

Every measured cached stretch passed the unchanged 200 ms assertion locally.
These actual cached samples **do not establish a 3× CI margin**. The selected 2,000
limit remains a file-count policy, not a time guarantee; the direct-layout 3×
estimates above must not be presented as cached-preview bounds. A contained
native-parent experiment did not improve the deeper-layout 2,000-file pass:
existing JavaScript realpath max 126.00 ms versus native max 131.87 ms in current
load. The original per-file resolver was retained unchanged.

At 5k/50k, the earlier asynchronous eligibility samples took 9.48 / 46.39 ms; no
bytes were fingerprinted and no final synchronous listing/metadata gate ran. The
final consolidated whole preview-plus-collect timer delays were **47.91 / 95.11 ms**
(earlier samples 73.04 / 93.52 ms). Commands still passed and collection returned
its explicit too-large message. The original responsiveness fixtures include one
.gitignore in addition to their nominal 5,000 / 50,000 text files; exact N/N+1
boundary fixtures contain exactly 2,000 / 2,001 included paths.

The first actual-layout measurement run repeated an additional 50k checkout and
passed all eight cases in 349.62 s under concurrent load. Duplicate large checkouts
were then consolidated into the existing responsiveness cases, which also assert
zero fingerprints and gates. The final two-file TEST_SCALE run passed all fourteen
cases in 97.34 s. Different load and coverage mean these wall times are not a
performance distribution or a claimed speedup.
For context, rejected `7f041479` measured a 190.7 / 1,874.7 ms old paired gate at
5k/50k versus 2.49 / 6.82 ms yielded metadata stretches. Those metadata-only numbers
were insufficient evidence of a whole-path bound or complete writer coverage; they
are not the current guarantee. The original required responsiveness reproduction
failed at 436.8 ms timer delay.

## Verification and changed test meaning

`preview-equivalence.test.ts` and `preview-parent-swap.test.ts` remain unchanged and
pass below the cap. New N/N+1 boundary tests check preview command status, stored
evidence and the collection diagnostic under the actual destination lease. Over-limit
fingerprinting refuses before reading any file. Both 5k/50k scale cases preserve
their command-result and 200 ms responsiveness assertions and now assert the
explicit too-large result plus zero fingerprints/gates. Actual cached measurements
cover 1k/2k; the same responsive runs establish that 5k/50k skip equivalence.

The six reviewer writer cases were intentionally adapted with lead authorization:
cleanup, artifacts, login pending/save/remove and spawn-log creation each queue a real
writer from an already-checked file. They now prove (1) the writer has not run when
the synchronous listing/gate/report returns its valid pre-write comparison, then
(2) the writer runs, and a fresh comparison refuses reuse after its removal,
replacement or new included path. The original assertions that a setImmediate writer
must run *inside* the gate are incompatible with this non-yielding exclusion.
The two late-abort cases, lock-helper-loss case and 1M-path bound case are unchanged.

Initial focused evidence on the capped implementation:

- Unchanged equivalence + parent tests and review lock/bound: 49 passed, one existing
  filesystem-permission capability skip; 1M normalization longest gap 7.7 ms.
- Six adapted writer cases plus both unchanged cancellation cases: all eight pass.
- N/N+1 boundary and early fingerprint refusal: all three pass.
- TEST_SCALE=1 preview/cache and gate cases: all 15 pass, including both large trees.

Final evidence:

- Equivalence, parent-swap, snapshot, local-state GC, PR and adapted review-gate
  suites: **111 passed**, one existing permission capability skip. The required
  equivalence and parent-swap files have no diff from `7f041479`.
- Review gate/lock/bound, parent-swap, boundary/lease and check-lifetime/cleanup
  suites: **27 normal tests passed**; opt-in scale cases run separately.
- Final consolidated TEST_SCALE cache/gate run: **14 passed**. Original 200 ms
  responsiveness assertions remain; 1M uncapped normalization also passes below
  200 ms (observed 7.6–11.8 ms across focused/peer runs).
- Skills checks: **3 passed**. Typecheck, knip and whitespace checks pass.
- Current named preview with lead `rohanz` rev 237 and ownership rev 64 merged
  source cleanly and passed **17 controls**, input SHA
  `eb22edea80c4ae892016b91a3bda2ce460d8e32a510fc2f5ce11214adceffef4`.
  Coverage remains PARTIAL for excluded/oversized generated bundles; this is
  source integration evidence, not a complete integrated release check. A later
  rev 73 ownership snapshot also passed 17 controls (two scale skips), SHA
  `bb367f919a90e1ac0e58c3d8991773e5aea543d36253f4593de6219df590390c`;
  ownership scratch-cleanup source moved during it, so that result is interim.

The lead owns comprehensive release validation and plugin bundle rebuilding; the
worker brief prohibits editing committed generated bundles. No broad writer facade,
writer-by-writer epoch or new mutation allow-list is included: the lead explicitly
superseded that proposal with the capped non-yielding gate.

## Separate preview assembly observation (not changed in this work)

After the waits worker was collected with keep into the lead, a final named preview
of lead `rohanz` rev 230 plus kept `rohanz+waits` rev 13 failed before test discovery.
The worker had started with carried files that were untracked at spawn; the lead
has since committed those eleven notice files. The preview attributed their absence
to changes by the kept worker and materialized a tree missing them. An earlier
preview of lead rev 229 plus waits rev 7 and ownership rev 4 passed the focused
source tests. The lead confirmed waits had already been collected and requested a
final preview naming rohanz alone; fixing this assembly defect is separate work.

Exact relevant reply text from the failed preview:

```text
preview merge of your changes with rohanz's, rohanz+waits's (common ancestor 6d4b9fb55c; merge algorithm: git):
preview anchor: rohanz (published snapshot); contributors use canonical collection order
step 2: merge rohanz+waits into rohanz + rohanz+gate-stall (against rohanz+waits's base 56a0f5fae1)
only rohanz+waits changed these files since its start: docs/superpowers/2026-11-11-stale-conflict-notices-conformance-review.md (rohanz+waits only), docs/superpowers/2026-11-11-stale-conflict-notices-design.md (rohanz+waits only), docs/superpowers/2026-11-11-stale-conflict-notices-review.md (rohanz+waits only), packages/hub-core/src/notice-lifecycle.ts (rohanz+waits only), packages/hub-core/test/notice-authority.test.ts (rohanz+waits only), packages/hub-core/test/notice-fixture.ts (rohanz+waits only), packages/hub-core/test/notice-lifecycle.test.ts (rohanz+waits only), packages/room-mcp/src/notice-lifecycle.ts (rohanz+waits only), packages/room-mcp/test/notice-baseline-bytes.test.ts (rohanz+waits only), packages/room-mcp/test/notice-lifecycle.test.ts (rohanz+waits only), packages/room-mcp/test/notice-retirement-successor.test.ts (rohanz+waits only)
no conflicts
included rohanz at ebd49225ea + live changes, rohanz+waits at f04ff07cc8 + live changes
snapshot inputs: rohanz+gate-stall (local working tree, base 83a340c897), rohanz (rev 230, base ebd49225ea), rohanz+waits (rev 13, base f04ff07cc8)
preview coverage: PARTIAL; combined work not verified
snapshot inputs sha256: d2eedbc1d6d587a41ad03e94ceec20cc6278bf7a1438bc7d4ef355481412593c; command: "cd packages/room-mcp && npx vitest run test/preview-gate-scale.test.ts test/preview-parent-swap.test.ts --maxWorkers=1"
 FAIL  test/preview-gate-scale.test.ts [ test/preview-gate-scale.test.ts ]
 FAIL  test/preview-parent-swap.test.ts [ test/preview-parent-swap.test.ts ]
Error: Cannot find module './notice-lifecycle.js' imported from /Users/rohan/Documents/progwork/aitinkerhackathon/.git/room-preview/c4dbf7a9d54428a8b762/shared-034296f249cde1b5/packages/hub-core/src/hub.ts
 ❯ ../hub-core/src/hub.ts:15:1
```
