# Shadow comparator validation

The initial record below predates the three authorized implementation commits ending at `ba849535`. Two independent-review follow-ups are recorded below; earlier measurements and counts remain historical evidence. The second follow-up supersedes the first follow-up's timestamp-based slot eligibility rule.

Base: `e2a602418623365c6696a296d0c5311b686a9032`. Source-only worker changes; no commit, push, plugin bundle, hook manifest or CHANGELOG changes. Runtime: macOS arm64, Node 22.23.4, Git 2.45.2, Vitest 5.0.0. All test commands used `--maxWorkers=1`; concurrent commands remained within the supplied three-thread budget.

## Implementation size and entry points

The three new production modules contain 638 physical lines (including comments/blanks): `conflict-shadow.ts` 385, `shadow-graph.ts` 154, `shadow-snapshot.ts` 99. Existing production files add 29 lines and remove four: 667 added / four removed overall, across eight production files.

- `packages/room-mcp/src/conflict-shadow.ts`: gated enqueue, read-only registry, serial/coalesced observation, lifecycle graph, coverage/freshness gates, disagreement journal and cleanup.
- `packages/room-mcp/src/shadow-graph.ts`: disposable bare repository, read-only alternate, private indexes/CAS refs, unique event commits, structured merge parsing and cached-answer object checks.
- `packages/room-mcp/src/shadow-snapshot.ts`: roomd disk/publication policy, stable raw-byte witnesses, coverage gaps and unsupported configuration checks.
- Hooks: `tools/workers.ts:298` (prepared spawn), `tools/collect.ts:870` (successful apply), `tools/messaging.ts:267` (recorded refresh), `tools/collect.ts:658` (partial copy), `registry.ts:129/152` (session start/stop). These enqueue; no lifecycle path awaits shadow work.
- `packages/roomd/src/git.ts:48`: an async-local deadline/cancellation context used only for shadow reads. Outside it the existing Git defaults remain unchanged.

## Completed checks

Completed evidence is the union of the final relevant runs below; repeated development runs are not added together as extra coverage.

| Check | Result |
| --- | --- |
| All 51 study scenarios, repository-root invocation | 51 passed |
| All 51 study scenarios, package-cwd invocation | 51 passed |
| Final shadow/lifecycle + graph suites, repository root | 32 passed plus two focused historical-coverage/unmodelled-lead cases |
| Final shadow/lifecycle + graph suites, package cwd | 32 passed plus the same two focused cases |
| Growth/pass measurement, root and package | Passed; 100 covered entries and zero gaps asserted on every snapshot |
| Actual coordinator measurement, root and package | Passed; three complete 21-pair passes, six workers plus lead |
| Read deadline/cancellation suite, root and roomd package cwd | Two passed in each location |
| Existing conflict/collect/refresh/spawn/registry/host/release/budget/Git suites | 24 files: 523 passed and one existing expected failure |
| Registry follow-up after the initial isolation work | Three files, 69 passed |
| `npm run typecheck` | Passed |
| `npx knip` | Passed, no findings |
| `git diff --check` | Passed |

There are 89 distinct new test cases across six files. The 51 study rows assert the supported event graph, or the real production HEAD validator's rejection of committed/adopted/reset worker starting points. Hard and mixed reset back to precisely the prepared HEAD remain modelled and match the same edits without the detour, as directed by the owner. The scratch/partial-delivery counterexample passes with the accepted-path mask; no new `it.fails` was introduced.

The pre-existing expected failure is `spawn-cleanup-limitations.test.ts:74`, “does not remove a foreign replacement between witness verification and Git removal.” Its expectation was not changed.

New regressions were observed failing before their fixes: reuse of a cached result after loss of an alternate object, and accidental shared commit identity for independent identical same-second observations. Unique event nonces and cached-result reachability checks repair those cases. An initial zero-command counter included ordinary synthetic session startup; its final isolated gate test keeps the zero-command expectation, while a separate real-spawn test counts zero shadow commands for unset/explicitly off flags. Both nonempty and empty worker markers disable the shadow. A root-started package-config invocation that discovered no tests was excluded; the actual package-cwd runs above supplied the package evidence.

Reproduce the new suites:

```sh
npx vitest run packages/room-mcp/test/conflict-shadow.test.ts packages/room-mcp/test/shadow-graph.test.ts packages/room-mcp/test/shadow-scenarios.test.ts packages/room-mcp/test/shadow-measure.test.ts packages/room-mcp/test/shadow-coordinator-measure.test.ts packages/roomd/test/git-read-deadline.test.ts --maxWorkers=1
cd packages/room-mcp
npx vitest run test/conflict-shadow.test.ts test/shadow-graph.test.ts test/shadow-scenarios.test.ts test/shadow-measure.test.ts test/shadow-coordinator-measure.test.ts --maxWorkers=1
```

Run the deadline suite from `packages/roomd` with `npx vitest run test/git-read-deadline.test.ts --maxWorkers=1`.

The existing root run selected `conflict-set`, `conflicts`, `conflict-provenance`, `conflict-carried-untracked`, `collect`, `collect-copy`, `collect-keep-adversarial`, `collect-borrowers`, `worker-refresh`, `worker-refresh-safety`, `spawn-safety`, `spawn-creation-witness`, `spawn-cleanup-limitations`, `registry`, `worker-registry`, `registry-stalls`, `registry-snapshot-contention`, `registry-read-cache`, `hosts/host-branches`, `tool-budget` and `release-version` in room-mcp, plus roomd's `git-timeout`, `git-bounds` and `fixed-git-timeout`.

## Measurement and boundaries

The actual coordinator wrapper was also measured for seven participants over 103 base files, with six workers each adding/changing a 1,008-byte file. Three completed passes compared all 21 pairs each time and took 3,700 / 3,694 / 3,640 ms (median 3,694 ms), including scheduling/budget setup, read-only registry, seven captures, publication byte checks and disk/publication revalidation. Main object counts stayed unchanged. Hosts/publications were synthetic, checkouts/Git were real. See `shadow-coordinator-measurement.json` and `shadow-coordinator-measure.test.ts`; this is a small-fixture measurement, not a live-host or large-repository latency bound.

The final unique-event measurement is in `shadow-measurement.json`: 100 tracked 1 KiB files, six actual worker worktrees, 12 serial rounds/72 edits, five simulated seconds per round, six snapshots and 21 merges per round. Median: 1,399 ms. Growth: 156,258 logical bytes total, 107,856 object bytes over 60 simulated seconds; linear projections are 9,375,480 total bytes/hour and 6,471,360 object bytes/hour. Main object counts stayed unchanged. This is a short synthetic workload with warm caches on a shared machine, not a one-hour/live-host soak. See the report for the rejected empty-coverage measurement and workload limitations.

The lead sees replicated local sibling slots in either owner direction, including fence/status/settled/checkedAt and opaque input hashes. It cannot prove an evaluator completed an absent slot; the owner's approved 60-second stable-publication/observation heuristic is recorded separately as `none-after-60s`. Team projections do not expose those internal family slots.

Unknown/skipped histories include a worker's changed real HEAD; supplied/borrowed/outside/shared checkouts; nested leads; partial/copy collection; incomplete carry or non-full sharing; recovered workers lacking this session's spawn; attributes/filters/normalization/sparse/promisor configuration; lost objects/ref races/events; and terminal cleanup that outruns capture. Coverage omissions remain gaps, never deletion/clean evidence. Formerly covered paths becoming gaps invalidate history, and collection checks both participants before constructing private trees. A lost lifecycle event stops the family's comparisons, while retirement and leave cleanup remain available. Resource exhaustion yields no partial staged disagreement. No tool text, authoritative conflict slot, notice, user index/branch/HEAD or working file is changed by the comparator.

This is source/test evidence in the local macOS environment, not a plugin reinstall, release build, full scale suite or live six-host validation. The lead owns integration and any release checks.

## Independent-review follow-up (2026-11-17)

Parent: `ba8495355988190ce75d591780fa3cd2d4d9bd90`. The four supplied independent reproducers failed before the fixes and pass in `shadow-freshness.test.ts`, under that plain filename. No pre-existing suite or expectation was changed; the weak early-fault loop in the new shadow suite was replaced.

- Freshness uses local monotonic first sightings of exact publication identities, stable covered path versions/absence, current owner fences, strictly later slot `checkedAt`, and a final identity/path/slot recheck. It never uses file mtimes as evidence that a slot evaluated an input. An unchanged ordinary input key leaving `checkedAt` unchanged after a new publication revision yields no record. No ConflictSet or slot-schema change.
- Spawn state is the real pre-carry HEAD, carry mode, exact tracked tree and carried-untracked set, within one observed lead generation. Distinct housekeeping SHAs of the same state share an anchor; HEAD-only workers never inherit carried ancestry. The equal/different HEAD and changed/restored lead-state matrix passes.
- Worker HEAD is read before capture and after capture, compared with the capture's own stable HEAD and the prepared commit. Both race boundaries have regressions; unsupported workers reach no comparison.
- Private passes also bound unresolved promises, cancel owned subprocesses, close journal handles and stop the family at the deadline. Cleanup has a separate bounded, unreferenced timer. A failed journal close stops the family and retries its owned handle instead of allowing further handles to accumulate.

The failure matrix covers 26 reachable stages × synchronous throw / rejection / unresolved-promise hang, plus the collection closure with a missing HEAD and an unset-flag baseline per file: 82 cases across `shadow-failures.test.ts`, `shadow-failures-lifecycle.test.ts` and `shadow-journal-cleanup.test.ts`. Each cell runs real spawn → kept collection → refresh → final collection through the existing fixture. It compares working files, index/status, replies, launch counts and messages with the unset baseline, asserts lifecycle elapsed time is in the same class, and asserts its fault was actually reached. Hangs use a three-second test deadline, must cancel the family, and cannot add their unbounded duration to a lifecycle operation. Journal-close cases also assert that the actual owned FileHandle is closed. The two longer files preserve the existing 15-minute per-file watchdog. No stage is waived or marked expected-failure.

Final production size: **777 physical lines** in the three shadow modules (524 coordinator, 154 graph, 99 snapshot). The existing hooks add 14 lines; the existing Git helper adds 15 and removes four, unchanged by this review. Overall against `e2a60241`: 806 production additions / four removals. No plugin assets, hooks manifest or CHANGELOG changes; no push.

Completed evidence (one set per distinct case; repeated development runs are not extra coverage):

| Check | Result |
| --- | --- |
| Root invocation of all original/review shadow files and the deadline suite | 9 files, 171 passed |
| Final journal-close hardening, root invocation | 1 file, 4 passed |
| Package-cwd invocation of all original/review shadow files | 8 files, 169 passed |
| Final journal-close hardening, room-mcp package cwd | 1 file, 4 passed |
| Deadline suite, roomd package cwd | 1 file, 2 passed |
| Existing spawn/collect/refresh/registry/conflict/host/release/budget suites | 36 files, 705 passed + one unchanged expected failure |
| Typecheck, Knip, diff whitespace check | Passed |
| Named-peer preview with rohanz and rohanz+claude | 10 selected checks passed before final journal-close hardening; no peer changes or conflicts. The final journal-close preview has its own Room ledger entry. |

The root aggregate took 1,888 seconds, the package aggregate 1,524 seconds and the legacy aggregate 1,324 seconds on this shared machine. Commands used `--maxWorkers=1`, with at most three test workers active and heavy runs staggered. The host inherited nice 15; requesting a nice adjustment was denied. No RSS or host isolation claim is made. Earlier development attempts were rejected for a transient-message-ID normalization error and an unreached journal-injection prerequisite; those were repaired without weakening assertions. Interrupted overlapping/unsplit attempts are excluded from completed evidence. The last four-line journal-close hardening was checked separately on the final source in both working directories; prior successful checks for unchanged behavior are preserved.

Reproduce from the repository root:

```sh
npx vitest run packages/room-mcp/test/*shadow*.test.ts packages/roomd/test/git-read-deadline.test.ts --maxWorkers=1
(cd packages/room-mcp && npx vitest run test/*shadow*.test.ts --maxWorkers=1)
(cd packages/roomd && npx vitest run test/git-read-deadline.test.ts --maxWorkers=1)
npm run typecheck
npx knip
```

Both measurement checks passed again, including three complete 21-pair coordinator passes and unchanged main object counts. The repeated engine median was 2,261 ms from the root and 2,225 ms from the package cwd; over 60 simulated seconds the private object growth was 107,847 / 107,849 bytes, respectively. These overlapping validation runs are not a controlled performance comparison or a replacement for the saved pre-review measurements above. The original coordinator sample file is retained; current coordinator pass samples were not separately exported.


## Second independent-review follow-up (2026-11-17)

Parent: `07706ae4535928ba06dc768d513e649d102de180`. The supplied five regressions were observed failing from the repository root before correction. They are retained under plain names in `shadow-stability-order.test.ts` and roomd's `git-read-cancellation.test.ts`; the shared fixture was extracted without changing their behavioral assertions. The old exact journal-cap assertion now checks the specified concurrent-writer bound.

- Removed first-seen publication clocks and all `checkedAt` ordering logic. One function now applies the same 60-second stability rule to every disagreement class. Its key includes pair, path, today's status/absence, shadow status, both publication identities and both observation identities. Publication/slot callbacks invalidate changed episodes; unknown results, lost observations and agreement reset the wait. The final metadata guard is repeated after the awaited size check, immediately before append. Each persistent episode emits one line with `observation: "60-second-stable-heuristic"` and `stableForMs`, never a claim of evaluator provenance. A lagging evaluator that catches up within the window yields no line. A persistent lagging result yields exactly one labelled observation. An unrelated path's unknown slot cannot erase another path's stable episode.
- Hooks reserve constant-time in-memory ordering facts before the prepare-finish await, at synchronous collection materialization and before refresh mutation. Deferred payloads fill those reservations; the queue applies reservation order. Immutable lead-anchor references are retained by generation, with a 32-cut ceiling. Missing counters/generations and preparation overlapping a mutation are skipped rather than inferred. Refused/no-op operations release their reservation; abandoned reservations expire after ten seconds and invalidate dependent history. An unavailable registry also clears queued payloads and halts the family. The hook path copies no snapshot bytes or entry maps and awaits no diagnostic work.
- Read-deadline contexts now use `killSignal: 'SIGKILL'` for reused exec and stream Git children, with an actual hard kill on stream abort. Inspection and reproduction on installed Node 22.23.4 showed that `execFile` does not pass `killSignal` into its internal spawn AbortSignal handler; a deadline-only abort listener therefore also kills that exact owned child and unregisters on close. The option-equality test asserts the original `e2a60241` option objects outside the deadline context. Abort and deadline tests launch real children that ignore SIGTERM, then verify they have exited. Shadow private Git commands also hard-kill on their timeout. A subsequent tree/ref operation removes only its own stale private lock, after confirming no private child remains; the user index is unchanged.
- The journal cap remains lock-free and approximate by at most one bounded record per concurrent writer. Size is checked for each record, rather than once per staged batch. Both the source comment and reference document state the bound, and the concurrent-append reproducer asserts it.

The optional four-case 500-file cost measurement was not imported: it repeats expensive real lifecycle runs and was supplied as optional. The cheap reservation regression instead makes snapshot-map enumeration throw and asserts that reservation neither enumerates entries nor invokes Git. The reviewer's passing enqueue measurements remain external evidence, not a new latency bound claimed here.

Production size against `e2a60241`: **861 physical lines** in the three shadow modules (601 coordinator, 161 graph, 99 snapshot), plus 21 hook/registry additions and 37 Git-helper additions / nine existing-line removals: **919 production additions / nine removals** overall. This is slightly above the near-900 target; the lead was notified that bounded reservations/expiry and Node-specific cancellation require the extra lines. No authoritative detector/schema changes or expectation changes in the pre-existing detector/lifecycle suites; no plugin assets, hook manifest, dependencies or CHANGELOG changes; no push.

Completed checks cover **193 distinct shadow/read cases from each location**: the final room-mcp package-cwd aggregate passed 12 files / 186 cases, and the roomd package-cwd run passed three files / seven cases. Root evidence is composed of the 189-case aggregate and the final 12-case focused run (eight repeated cases plus four added cases), for the same 193 distinct cases. The aggregate began before the final queue-failure and append-guard hardening; the focused final-source checks cover those changes, and the package aggregate runs on the final source. The existing suites passed: 39 files, 717 passes and one unchanged expected failure, including the roomd Git bounds/timeout suites. Typecheck and Knip passed on the final source. Root aggregate duration: 1,420 seconds; final focused root run: 55 seconds; room-mcp package aggregate: 1,130 seconds; roomd package run: 11 seconds; existing aggregate: 1,030 seconds. Runs use `--maxWorkers=1`, with at most three test workers and heavy jobs staggered, on the same shared macOS/Node/Git environment described above. No controlled performance or memory claim is made.

Reproduce the final checks:

```sh
npx vitest run packages/room-mcp/test/*shadow*.test.ts packages/roomd/test/git-read-deadline.test.ts packages/roomd/test/git-read-cancellation.test.ts packages/roomd/test/git-default-options.test.ts --maxWorkers=1
(cd packages/room-mcp && npx vitest run test/*shadow*.test.ts --maxWorkers=1)
(cd packages/roomd && npx vitest run test/git-read-deadline.test.ts test/git-read-cancellation.test.ts test/git-default-options.test.ts --maxWorkers=1)
npm run typecheck
npx knip
```

The final named-peer preview selected `rohanz` and `rohanz+claude`, requesting the three stability/reservation regression files plus the three roomd read-deadline/cancellation/default-option files (19 cases). It returned **PARTIAL**, with no manifest record for either peer and unverifiable worker baseline/collection provenance. Zero paths were applied over `e2a60241`; the command exited 1 with no test files found. This is not passing combined-tree evidence. The publication/provenance failure was sent directly to the lead; its exact snapshot and command result remain in the Room ledger. The lead answered that its checkout is clean at the original base `e2a60241`, no other worker is running, and its session had just rejoined without a manifest; there is no overlapping work to combine. It explicitly directed completion using the own-worktree evidence and will run the full suite on the collected tree. The lead also accepted the deadline-only execFile abort listener/default-option test and the just-over-900-line production size.


## Third independent-review follow-up (2026-11-17)

Parent: `bd2c542a369c73656f5cc8675e8dce2e982a9db7`. Both supplied regressions failed before correction and are retained, under the plain name `shadow-participant-lifetime.test.ts`. Additional cases bring that file to 16 tests. The existing HEAD-race tests retain their original zero-comparison/disabled-object assertions while additionally checking that the actual actor map forgets the rejected worker.

One removal routine now releases the actor, all of its pair/path episodes, publication identities, owned later reservations, private ref/index/lock and comparison-cache entries. Registry retirement/discard notifications append removal to the generation queue, behind every earlier reservation. Late reservations for ended participants are discarded without building their payload. Stop and permanent rejection use the same removal routine. Worker-only expired/failed reservations remove only their participants; unknown or lost lead history seals the family and logs one plain reason. Scalar worker IDs and a deferred collection ID accessor preserve constant-time, no-copy/no-I/O hooks. Static module load is declarations/constants/weak-map initialization only, as stated in its opening comment.

The lead clarified the collection policy: a final collection removes its ended workers and takes a fresh lead observation, with no delivery or removed-checkout capture for those workers. Continuing workers retain the existing delivery/capture/HEAD path. Collection waits privately for the actual registry completion; retirement notification order cannot reorder it. A final generation overtaken by a later lead mutation is not inferred. Tests use real final collection with completion delivered before/after retirement notification, plus one real batch whose ignored artifact keeps one worker live while its sibling ends.

Episode identity now contains exactly pair/path, today's aggregate status or absence, shadow status, both publication identities and both observations. Opaque slot inputs, fact IDs, checkedAt and other metadata are removed from that identity and do not reset its window or reopen a recorded episode. Slot status changes still invalidate episodes immediately, including transient unknown/agreement between comparison passes. The metadata observer groups relevant slots once, avoiding a scan of every room slot for every pending episode.

Production size: **951 physical lines** in the three shadow modules (682 coordinator, 170 graph, 99 snapshot); **1009 additions / nine removals** across production files against `e2a60241`, including the existing hooks and Git helper. The lead was notified of the increase required by the ordered-removal/scoped-expiry policy. No authoritative detector/schema, ordinary lifecycle result, existing expectation, dependency, plugin asset, hooks manifest or CHANGELOG change; no push.

The full final-source root run passed **16 files / 209 cases** in 1,423 seconds. The roomd package run passed **three files / seven cases** unchanged after two earlier attempts missed a fake-child PID-file setup deadline. Focused checks also passed, including all 16 new lifetime cases and eight existing ordering cases. All commands use `--maxWorkers=1` within the three-thread budget, with heavy runs staggered; environment and measurement limitations remain those above.

The first room-mcp package aggregate completed 193 passes / nine failures in 5,523 seconds. One 30-second test took 2,853 seconds to report its timeout. A six-file retry completed 44 passes / six failures in 1,944 seconds, with failures moving between cases, including a 1,268-second timeout and a subsequent fixture-root cleanup failure. Coordinator measurements stopped at their private budget (nine or ten of 21 comparisons), and the engine retry hit a private read-tree deadline. These stalled attempts are recorded as failures, not successful validation or performance evidence. Assertions and timeouts remain unchanged. Seven package files passed completely. The subsequent six-file rerun used a keep-awake tool; it is withdrawn as accepted validation evidence. **The owner manages sleep. Agents must never start a keep-awake tool, even scoped to one command.** Report stalls and rerun later. The plain replacement runs are recorded in the next follow-up. A contemporaneous host load sample was 7.20 / 10.59 / 16.05. The exact cause of every stall was not established.


The former summary of 209 passes from each working-directory path depended on that withdrawn package rerun and is superseded below. The root aggregate (16 files / 209 cases) and final roomd package run (seven cases) remain historical results. Repeated cases in failed attempts and focused development runs are not extra coverage. Typecheck, Knip and diff whitespace checks passed on this source. No assertion, timeout, test configuration or existing expectation was relaxed to obtain these results. The failed aggregate attempts above remain disclosed; a single wholly green 202-case room-mcp package aggregate is not claimed.

The current named-peer preview selected `rohanz` and `rohanz+claude`, requesting the new checkedAt-only and both final-collection ordering cases (three selected cases). It remained **PARTIAL**: neither peer had a manifest record, worker collection provenance was unavailable, and zero paths were applied over `e2a60241`. The command exited 1 without the requested tests; this is not combined-tree validation. The exact snapshot/result remain in the Room ledger and the failure was sent to the lead. Own-worktree validation above is complete; integration and full collected-tree validation remain the lead's responsibility, as previously agreed.


## Deterministic default-test follow-up (2026-11-17)

Parent: `84693f6112254c132f5070316b79a4868771dfd1`. No production code, runtime budget or Git default changed. No keep-awake tool is used for this follow-up; sleep remains under the owner's control.

Audit of every shadow test:

- `shadow-measure.test.ts` and `shadow-coordinator-measure.test.ts` now use `it.skipIf(process.env.TEST_SCALE !== '1')`. They retain real Git, clocks, production pass deadlines, comparison counts and timing measurements in the scale pass.
- The four real-child cancellation/deadline probes in roomd's `git-read-cancellation.test.ts` use the same gate: process startup, cancellation and termination genuinely depend on real time. The shared scale-file selector discovers all three tagged files; root `TEST_SCALE=1 npm test` coverage is recorded below.
- Default functional suites use `shadow-controlled-fixture.ts`: an injected monotonic clock, no elapsed private-pass deadline, controllable abort-driven budget, and injected private Git timing. Real Git still constructs and compares the trees and all original logical assertions remain. The fixture is deliberately absent from measurements, real subprocess timing probes and default-off tests. The heavy lifecycle matrix uses a 120-second per-case runner guard, as approved by the lead; the repository watchdog remains unchanged.
- `shadow-budget.test.ts` separately exercises the real budget implementation with fake timers: hung-pass expiry, cancellation and bounded cleanup. Roomd's integer/read-context timeout test now advances an injected performance clock instead of sleeping.
- The full stage × kind fault matrix moves behind `TEST_SCALE=1` after the original 40-case file passed without artificial CPU load in 318.82 seconds (shared host; brief probe/typecheck work overlapped), exceeding the lead's approximately 60-second threshold. Default registration retains 32 cases across three files: three baselines, every one of the 26 stages as a hang, throw/reject at initialization, and missing-head collection. Scale registration retains all 82 cases. The fault matrix removes every elapsed-time/latency-class comparison. For each hung stage, it holds the injected promise pending across the next real lifecycle operation, asserts that operation settled while the hang was still pending, then explicitly cancels/releases it and verifies the original state/reply/message/cleanup results. All 26 hang stages remain in the default suite. The staged-initialization test uses a reached barrier; filesystem cleanup checks await the owned work instead of polling a wall-clock window.
- `shadow-off.test.ts` contains the two unmocked default-off/worker-gate cases, including real disabled spawns. It asserts no shadow Git command/file/timer/listener. The separate ordinary-Git option equality test remains unmodified and real with respect to execution option construction.
- The lagging-evaluator fixture explicitly supplies the later evaluator timestamp, so its ordering assertion does not depend on host speed.

Each pipeline captures its own repository and base, owns its session and private shadow, restores its own spies, and closes/removes its resources in `finally`. A timed-out test aborts the pipeline; a test-finished hook waits for its owned cleanup before the next case. A failed baseline is rebuilt by the next case rather than reused. A deliberate baseline-failure probe reported exactly one failure and three subsequent passes (12 unrelated cases filtered out), confirming isolation and baseline recovery. Early development probes exposed missing `it.each` context and nested spies; `it.for` and per-pipeline spy restoration corrected both before accepted validation.

`verify-shadow-loaded.mjs` runs the entire default shadow selection three times sequentially from the repository root while one supervised CPU-heavy child computes hashes. It records each exit/result and checks that the load remains alive throughout. The child is stopped by its own PID, exits if its parent disappears, and does not request power assertions or change system settings. Both the load and all test commands must finish before reporting done.

The first two complete root runs under the supervised CPU load passed 206 cases each (six scale cases skipped), in 1264.29 and 1099.21 seconds. The combined supervisor's third attempt was externally killed (exit 137; no test result). A separately loaded replacement failed when its baseline exceeded the old 30-second runner guard (32.3 seconds), contaminating the other cases in that file; 166 cases passed and 40 failed. That failure prompted the isolation, 120-second guard and cost changes above. These failures/interruption remain disclosed and are not counted as passes. The lead accepted retaining the first two completed runs and running the final reduced selection once more under load; that final result follows below.

Before the isolation/cost changes, a plain package-cwd rerun of the six requested files passed 46 cases, with the two measurements skipped into scale (271.95 seconds). A root `TEST_SCALE=1 npm test` run passed the two measurements and four real-child probes (six cases, 61.57 seconds); the root selector also lists all three matrix files after gating. The final root `TEST_SCALE=1 npm test` selection passed **six files / 88 cases** in **750.32 seconds**, including all 82 matrix cases and all six real-timing cases. Summed matrix case durations were 340.387 seconds (40-case observation file), 308.829 seconds (38-case lifecycle file), and 33.912 seconds (four-case journal file); these are per-case sums, not isolated file wall times. The final root default selection under the supervised CPU load passed **15 files / 156 cases**, with **three files / six scale cases skipped**, in **891.87 seconds**. The load stayed alive for the run and exited 0; its CPU usage was 854.50 user seconds plus 5.69 system seconds over 892.81 wall seconds. Thus the three completed loaded passes are 206 / 206 / 156 passes; the last selection is smaller because the full matrix moved to scale at the lead's direction. The interrupted and failed attempts above are retained, not counted as completed passes. The final plain room-mcp package run passed **six active files / 74 cases**, with **two measurement files / two cases skipped**, in **457.72 seconds**. It includes the requested six files plus both reduced matrix files; there was no artificial CPU load or keep-awake tool. Default matrix case sums were 121.199 seconds (16 observation cases), 128.154 seconds (14 lifecycle cases), and 14.235 seconds (two journal cases); these are summed case durations, not isolated file wall times. All 44 default cases in the requested original six-file selection passed. Final typecheck, Knip and whitespace checks passed. The production delta remains unchanged: 951 physical lines in the three shadow modules, 1009 additions / nine removals against `e2a60241`. Typecheck and Knip passed; focused checks include all 26 controlled hangs plus three baselines and the fake-clock/real-off checks. No keep-awake rerun is accepted as evidence.

The final named-peer preview selected `rohanz` and `rohanz+claude` and completed successfully: five fake-budget/default-off checks passed, complete selected-participant coverage, no conflicts and no changes from either peer to apply. This is a passing own-tree check, not evidence for additional peer code. The exact snapshot and command remain in the Room ledger. Two unchanged `worker-refresh.test.ts` carry/refresh cases also passed after the world fixture began capturing its repository/base and exposing idempotent disposal.

Reproduce this follow-up from the repository root (use a fresh output directory):

```sh
node docs/archive/reports/2026-11-17-git-native/verify-shadow-loaded.mjs /tmp/shadow-loaded-recheck 3
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER TEST_SCALE=1 npm test -- packages/room-mcp/test/shadow-measure.test.ts packages/room-mcp/test/shadow-coordinator-measure.test.ts packages/room-mcp/test/shadow-failures.test.ts packages/room-mcp/test/shadow-failures-lifecycle.test.ts packages/room-mcp/test/shadow-journal-cleanup.test.ts packages/roomd/test/git-read-cancellation.test.ts --maxWorkers=1
```

For the deliberate isolation check, set `SHADOW_ISOLATION_PROBE=baseline` and run `shadow-failures.test.ts` with `-t 'ordinary|initialization'`: the intended result is exit 1, exactly one deliberate baseline failure and three subsequent passes. It is a failure-injection check, not a green-suite result. The probe variable is never set for accepted default or scale runs.


## Fourth independent-review follow-up (2026-11-17)

Parent: `6b1c2c90b6bd01f8da8e9f23f0146fe9204881af`. The supplied two regressions both failed before correction and are retained as `shadow-event-loss.test.ts`. The mixed-event reproducer additionally asserts that the surviving worker becomes unmodelled and receives exactly one loss diagnostic.

Participant removal cancels only that participant's sole worker-local reservation; collection and unsupported lead-mutation reservations are retained. Shared reservations and collection facts remain whole: before application, any missing owner routes the entire ticket through the loss routine. Every still-modelled named participant gets a diagnostic; a lost collection invalidates the lead history and halts the family. Expired, failed and ambiguous tickets use the same route. A late payload whose reservation can no longer be applied now halts conservatively instead of only warning. Explicit release remains a known public no-op. Queue clearing happens only when the whole family is halted or closed; no surviving participant carries on after a dropped lead mutation.

Both journal-cap branches call the single `halt()` routine. That routine logs once and owns an awaitable private removal pass; diagnostics may await it, lifecycle hooks never do. `remove()` is the only deletion site for actors and publication identities. Redundant direct clearing/removal was removed from other paths. The halt tests cover lead history loss, repository ceiling, journal ceiling, failed reservation and late event, then retirement, checking all participant maps and indexes. A related audit regression first reproduced an old retirement deleting a newer worker that reused its name; removal now deletes the name/publication entry only when its worker ID matches, while still forgetting and reclaiming the old ID. The six halt/identity cases plus both supplied regressions passed together (eight cases, 16.78 seconds). The real journal-cap reproducer also performs an actual discard after the cap.

The full 51-row scenario matrix and all 82 stage × failure-kind cases remain in `TEST_SCALE=1`, along with the prior measurements and real-child deadline probes. The default suite keeps the requested eight mechanisms: a shared spawn anchor, keep with an untouched sibling, both edit after a keep, skipped scratch, accepted refresh, lead revert, unmodelled worker history and an untracked carried draft. It also keeps three real fault pipelines (throw at spawn closure, rejection at kept-collection closure, hang at refresh closure) plus an unset-variable baseline. A deferred gate proves an ordinary operation settles while each private fault is pending; all original ordinary results are compared afterward. The lead explicitly superseded the earlier all-stage default requirement with these three representatives.

The default coordinator check covers read-only registry initialization. The lifetime representative checks one stable episode across metadata-only writes, journal privacy and absence of notices; freshness retains a real HEAD/capture race. The ordering representative tests constant-time reservation without preparing workers. All other coordinator/freshness/lifetime/ordering cases and permutations still run in scale. Prepared source repositories are copied from one immutable template per file, preserving per-case mutable repositories. Immutable publication bases use one cached Git tree listing instead of one subprocess per path. The archived scenario fixture's second, unused Git graph is built only in scale; the default assertions still compare actual production trees/events.

Final default measurement: **41 passed / 140 skipped**, including three ordinary Git checks, from the repository root with `--maxWorkers=1`. `/usr/bin/time -p` measured **89.96 seconds** including CLI startup; Vitest's start-to-last-file interval was **89.61 seconds**. Shadow file durations total **83.57 seconds**. No other worker-started test, build or artificial CPU workload ran alongside this measurement. The shared host was not otherwise isolated; no keep-awake tool was used and the owner controls sleep. These are measurements, not timing assertions in the suite.

| Shadow file | Default passed | Moved/skipped | File duration (s) |
|---|---:|---:|---:|
| `conflict-shadow.test.ts` | 1 | 17 | 0.092 |
| `shadow-budget.test.ts` | 3 | 0 | 0.005 |
| `shadow-coordinator-measure.test.ts` | 0 | 1 | 0.000 |
| `shadow-event-loss.test.ts` | 2 | 0 | 9.336 |
| `shadow-failures-lifecycle.test.ts` | 0 | 38 | 0.000 |
| `shadow-failures.test.ts` | 0 | 40 | 0.000 |
| `shadow-faults.test.ts` | 4 | 0 | 26.709 |
| `shadow-freshness.test.ts` | 1 | 10 | 3.379 |
| `shadow-graph.test.ts` | 8 | 0 | 1.315 |
| `shadow-halt.test.ts` | 6 | 0 | 0.224 |
| `shadow-journal-cleanup.test.ts` | 0 | 4 | 0.000 |
| `shadow-measure.test.ts` | 0 | 1 | 0.000 |
| `shadow-off.test.ts` | 2 | 0 | 3.067 |
| `shadow-participant-lifetime.test.ts` | 1 | 15 | 4.732 |
| `shadow-reservation-failures.test.ts` | 1 | 0 | 0.103 |
| `shadow-scenarios.test.ts` | 8 | 0 | 34.535 |
| `shadow-stability-order.test.ts` | 1 | 7 | 0.076 |
| `shadow-stable-window.test.ts` | 0 | 3 | 0.000 |

Durations come from Vitest's JSON file intervals; fully skipped files have no test duration. Whole-command time also includes collection, imports and fixture hooks. The three mandatory fault pipelines plus their baseline cost 26.71 seconds; the eight scenarios cost 34.53 seconds. Earlier cost iterations passed in 111.88, 89.06 and 97.20 seconds before the cached-publication fixture; the 40-case pre-ID-guard run then passed in 87.86 seconds. The final 41-case measurement above includes the guard and its new regression. One intermediate cache helper changed fixture import order and produced 38 passes / two failures; it was corrected to import only Node's child-process API, and that run is excluded from accepted evidence. The supplied regressions and the deliberately injected failures are not counted as green baseline results.

The room-mcp package invocation passed **14 files / 85 cases**, with six files / 136 cases skipped, in **200.89 seconds**: 37 shadow cases and the 48 cases in the two main refresh fixture suites. Two additional fixture-consumer files passed **10 cases / one scale case skipped** from the root in **48.38 seconds**, completing all 58 non-shadow consumers. The unchanged roomd package checks passed three cases, with the four real-child probes reserved for scale (0.60 seconds).

The root shadow scale selection passed **12 files / 195 cases** in **1165.80 seconds** (1166.17 seconds including CLI time): all 51 scenario rows, all 82 matrix cases, all moved permutations, both measurements and all four real-child probes. The run began before the final worker-ID guard; a focused eight-case root check covers that last guard and both supplied failures, and the final default and package checks cover it again. The earlier scale checks remain evidence for unchanged behavior; a second complete scale run on the guard-only change is not claimed. A brief focused identity/regression check overlapped the scale run; it is not a controlled performance comparison.

The final worker-ID guard and both supplied failures passed again from the room-mcp package cwd (eight cases, 11.31 seconds). Typecheck and Knip passed on that final source. The current named-peer preview selected `rohanz` and `rohanz+claude` and passed all ten event-loss, halt/identity and real default-off checks (three files). Coverage was complete for those participants, with no peer changes to combine and no conflicts; this is passing own-tree evidence. The exact snapshot and command remain in the Room ledger. Default plus scale cover 224 distinct file/test case instances, with 12 repeated between the two selections. All commands and their owned children have completed; no keep-awake tool or push was used.

Production size is **961 physical lines** in the three shadow modules (692 coordinator, 170 graph, 99 snapshot), **1019 additions / nine removals** against `e2a60241` across production files. No ordinary detector/schema, hook contract, dependency, plugin asset or CHANGELOG change; no push.


Changed code locations for this follow-up: `conflict-shadow.ts:124` (single halt/removal pass), `:143` (sole-owner cancellation), `:160` (whole-event loss), `:211` (late payload), `:262` (any missing owner), and `:667` / `:677` (journal caps); `shadow-event-loss.test.ts:13` (supplied regressions); `shadow-halt.test.ts:13` (stop reasons); `shadow-faults.test.ts:4` (three default failure kinds); `shadow-publication-fixture.ts:4` (immutable base cache). All paths are under `packages/room-mcp/src/` or `packages/room-mcp/test/` as appropriate. Root scale discovery lists every moved file; its actual execution result will be recorded below.


Reproduce the final default measurement from the repository root with no other worker-started workload:

```sh
/usr/bin/time -p env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER -u TEST_SCALE npx vitest run packages/room-mcp/test/*shadow*.test.ts packages/roomd/test/git-read-deadline.test.ts packages/roomd/test/git-read-cancellation.test.ts packages/roomd/test/git-default-options.test.ts --maxWorkers=1 --reporter=json --outputFile=/tmp/shadow-default.json
/usr/bin/time -p env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER TEST_SCALE=1 npm test -- packages/room-mcp/test/*shadow*.test.ts packages/roomd/test/git-read-cancellation.test.ts --maxWorkers=1
```
