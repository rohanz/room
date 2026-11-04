# Test, script and plugin cleanliness review — 2026-11-04

Read-only source review. Only this report was written; no tests, builds, benchmarks, formatters or other validation commands were run. Findings are source-derived risks, not reproduced failures. Locations refer to this worktree's review baseline. Generated bundles/grammars were inventoried rather than manually audited byte by byte.

Read the current Running and testing instructions, README, reference, roadmap, relevant changelog entries and coordination skills. Reviewed test/config patterns across the packages, then traced the concrete candidates below through their fixtures and relevant implementation. The 0.17.26 fixes already replace several particularly expensive/flaky patterns; this report does not count those repaired cases as outstanding defects. `collect-fixture.ts:61` already drains background preview maintenance before asynchronous removal.

## Top ten, ranked by expected maintainer time lost per week

Ranking favors repeated full-suite reruns and misleading evidence over local tidiness. These are qualitative estimates of recurrence × investigation/rerun cost; weekly minutes were not measured. The supplied roughly ten-minute suite duration describes the task context, not a measurement made here.

### 1. Background preview maintenance still outlives other fixtures' directory teardown

**Locations:** `packages/room-mcp/test/carry-wip.test.ts:62`, `:73`, `:78`, `:253`; `packages/room-mcp/test/preview-run-cache.test.ts:32`.

Carry teardown closes registries and removes the root, but does not drain the preview maintenance queued by its real `cleanupWorker`/default-collect cases. The preview-cache suite likewise removes its repository immediately after its checks. `worker-git.ts:149` calls `removePreviewCache`, whose returned promise only schedules work (`tools/files.ts:1079`); `runInMergedTree` also queues maintenance at `tools/files.ts:1310`. Registry closure is not the documented completion signal for these tasks. This leaves filesystem work racing removal, the same class of problem recently fixed in `collect-fixture.ts`, and can produce platform/load-dependent cleanup warnings or failures.

**Concrete fix:** stop fixture producers, close registries, await `waitForPreviewSweepForTests()`, then `await fs.promises.rm(...)` in every fixture that invokes these operations. Put this ownership sequence in one reusable fixture disposer so the next background task is accounted for once. Do not indiscriminately add waits to pure keep-only fixtures without establishing that they start maintenance.

**Cost:** high; intermittent teardown errors send maintainers back through a large suite and often point away from the initiating test.

Coordination: the MCP reviewer independently confirmed that registry closure does not drain the migration/eviction task sets; its report covers the related production lifecycle gap. This is supporting source review, not runtime validation.

### 2. CI still suppresses test evidence when an independent hygiene step fails

**Location:** `.github/workflows/ci.yml:90` (also `:87` and `:101`).

Knip precedes tests in the same success-dependent job. The exact 0.17.28 failure described by CHANGELOG 0.17.29 can therefore recur: an unused export means no test result, followed by another CI cycle after a trivial fix. Docker image failure also suppresses the independent plugin build/asset comparison.

**Concrete fix:** make hygiene an independently required job; separate independent build checks where practical, or use explicit conditions that preserve their failure status while still running eligible checks after unrelated failures. Keep install failures gating dependent work. Do not make knip optional. Upload useful test/build diagnostics on failure.

**Cost:** high; predictable extra feedback cycles on routine cleanup/release changes.

### 3. One default graph test spends 20.15 seconds asleep inside a 25-second budget

**Location:** `packages/room-mcp/test/graph-index-events.test.ts:231`, especially `:249` and `:253`.

The default-throttle parameter sleeps 20,150 ms after setup and parsing, leaving under five seconds for all other work. It verifies a negative publication property by waiting for real time to pass. This both adds guaranteed latency and makes ordinary load consume the remaining margin.

**Concrete fix:** expose/inject the publication scheduler or use controlled timers after real parser/Git startup has settled; explicitly advance through the throttle deadline and await publication processing before checking that excluded text remains absent. Keep one real-timer integration smoke only if needed, with a meaningful completion signal and independent budget.

**Cost:** high; recurring wasted time plus a narrowly budgeted default test.

### 4. Live worker-log test can miss the behavior it is waiting to observe

**Location:** `packages/room-mcp/test/worker-activity.test.ts:227`, particularly `:232`, `:243` and `:252`.

The child advances from Read to Edit after 400 ms while the parent polls every 50 ms. If the parent is descheduled across that interval, it sees only the latest Edit and can never satisfy its first Read assertion, regardless of its four-second deadline. Finally it sends SIGKILL without awaiting the exit/log-stream completion before the directory-level `afterAll` at line 10 removes files.

**Concrete fix:** use an IPC/stdin acknowledgement after each observed log record; let the child advance only after the parent has asserted the corresponding activity. Keep it alive on that explicit gate instead of a five-second sleep. Register exit completion before termination and await it before deleting the fixture.

**Cost:** high; a genuine missed-event flake whose symptoms look like a tracker regression.

### 5. Preview-cache tests rely on the cache left by previous tests

**Location:** `packages/room-mcp/test/preview-run-cache.test.ts:97` and `:145`; shared `repo`/`ancestor` at `:9`.

The ancestor-move case expects zero base materializations without warming a cache itself. The lost-gitfile case immediately unlinks the cached `.git` without creating it. Both rely on earlier tests. Running either in isolation can change the expected count or fail before exercising its behavior. Line 70 explicitly bootstraps another case, but that guarantee is local to that test. The ancestor-move case also commits into the repository shared with later tests.

**Concrete fix:** give each mutation case its own small repository/cache and explicitly warm it inside that case (or its scoped setup). Share immutable source data, not the cache lifecycle being asserted. Each case should pass by itself and with shuffled order.

**Cost:** high; focused reruns become misleading just when a maintainer is isolating a failure.

### 6. Shared worker fixture performs repeated serial Git teardown and does not own all resources

**Location:** `packages/room-mcp/test/workers-fixture.ts:102`, `:113`, `:146`, `:159`.

Every test lists worktrees, removes each separately, prunes, lists branches and deletes each separately through synchronous subprocesses. This repeats across importing suites and blocks the event loop inside the hook. The fixture also starts a real GraphIndex in every `fakeSession` and creates Awareness/Y documents without a fixture-owned disposal list; cleanup depends on callers remembering the relevant shutdown. For example, `workers.test.ts:229` creates multiple setups without a final shutdown. The shared repository created in `beforeAll` has no corresponding `afterAll` removal in this helper.

**Concrete fix:** register all created session resources with an unconditional disposer; stop graphs, destroy awareness/documents and shut down tools before closing storage. Prefer a per-test disposable repository when it removes the need to individually dismantle branches/worktrees; use async deletion and retain explicit Git removal assertions only in tests of that behavior. If sharing a repository remains necessary, batch ref cleanup and ensure a final repository removal.

**Cost:** medium-high; teardown grows with worker count, while leftover indexing can add load to subsequent cases.

### 7. Large synthetic fixtures remain in the default path for small functional assertions

**Locations:** `packages/room-mcp/test/preview-run-cache.test.ts:15`, `:21`, `:67`; `packages/room-mcp/test/graph-retention.test.ts:220`.

The preview-cache `beforeAll` always creates and commits 5,000 distinct files, even when its scale cases are skipped. Dirty-cache repair, executable modes and one ancestor movement need only a handful of files. Separately, graph-retention's 3,000-file CPU-budget case is unconditional, although other graph responsiveness/scale suites honor TEST_SCALE. Its scan-count assertion is useful, but the large disk fixture and machine CPU threshold sit in every default run.

**Concrete fix:** split the preview scale cases into their own TEST_SCALE-gated setup and use a tiny functional cache fixture elsewhere. Keep a small deterministic scan-count case by default and gate the 3,000-path CPU measurement behind TEST_SCALE, preserving required CI coverage. The 501-path withdrawal case at graph-retention line 198 also merits a separate small functional case and opt-in fanout case if 500 is not a required boundary.

**Cost:** medium-high; repeated disk/process work contributes load to unrelated near-timeout tests. No runtime savings were measured here.

### 8. Credential revocation race uses a sleep rather than proving admission reached its suspension point

**Location:** `packages/server/test/credentials.test.ts:85`; configured delay at `:28`, sleep at `:89`.

The test opens a socket, waits 40 ms and logs out while the server has an artificial 150 ms upgrade delay. It never observes admission entering that delay. On a slow server it can revoke before admission; on a slow parent it can revoke after the upgrade. The former can pass without exercising the intended race; the latter can fail spuriously.

**Concrete fix:** add a test-only admission-entered signal and release gate to the child-server helper. Await entered, revoke the session, then release the upgrade and assert its rejection. Attach rejection handling when the pending operation is created so a deliberately delayed assertion cannot produce an unhandled rejection.

**Cost:** medium-high; either flaky failure or false confidence in a security-sensitive regression.

### 9. Persistence tests treat ten milliseconds as a storage completion signal

**Locations:** `packages/server/test/auth.test.ts:120`, `:166`; `packages/server/test/oidc.test.ts:209`.

Queued session writes are assumed complete after a 10 ms sleep before disk assertions, direct file replacement or restarting readers. Busy disk/process scheduling can invalidate that assumption. In the operator-deletion case, a delayed queued write can overwrite the test's replacement file, changing the race the test actually exercises.

**Concrete fix:** use a controllable Store implementation with explicit write-completed promises for unit cases; for FileStore persistence cases, await a store queue flush/completion seam before inspecting/replacing files or starting a second Auth. Own that store's completion in teardown too. Preserve real FileStore coverage rather than replacing every case with an in-memory mock.

**Cost:** medium; low-budget waits recur in multiple auth paths and can generate misleading persistence failures.

### 10. Responsiveness assertions mix scheduler delay with the work being tested

**Locations:** `packages/agent/test/runner.test.ts:266`; `packages/room-mcp/test/worker-shell-env.test.ts:248`; `packages/room-mcp/test/preview-run-cache.test.ts:120` and `:142`.

Runner stop must complete a 20 ms deadline in under 200 ms wall time. Version detection must return its promise in under 250 ms. Preview responsiveness must keep interval delay below 200 ms while also doing real Git/filesystem work. Pausing the test process can fail all of these without any change to implementation blocking. The shell fixture's 0.5-second sleep and preview overlap's `sleep 1` (`preview-run-cache:115`) also assume the parent progresses before a child deadline.

**Concrete fix:** use fake time for the runner's deadline and assert abort/queue/callback behavior independently. Hold the version-reader child behind a gate, assert a parent event-loop task runs while the operation is pending, then release it. Hold the first preview until the second has selected its fallback. For synchronous-removal regressions, assert the forbidden synchronous operation/call path directly; keep noisy end-to-end latency budgets in controlled opt-in performance runs.

**Cost:** medium; failures correlate with machine contention and invite timeout inflation instead of diagnosis.

## Remaining findings, grouped by file

### `.github/workflows/ci.yml`

- **Line 112:** stale generated assets produce only a generic error. Maintainers cannot tell whether the drift is bundle, grammar, manifest or web assets without rebuilding locally. Print scoped `git status --short`, `git diff --stat` and a bounded textual diff; upload the full diff when appropriate, avoiding binary dumps.
- **Lines 46–56:** the native Windows checks are sequential success-dependent steps. One failure prevents the remaining independent smoke evidence, although artifact upload correctly uses `always()`. Use an explicit eligible-after-install condition or independent jobs so one platform regression yields all relevant diagnostics in one run.

### `packages/agent/test/cli-close.test.ts`

- **Lines 39–41:** test-owned provider creation and exit are polled in 10 ms loops. Replace those with promises resolved by the injected provider/exit callbacks, with a diagnostic timeout only as a failure bound. This avoids duplicating deadline logic around events the fixture already controls.

### `packages/relay/test/hub.test.ts`

- **Line 202:** a 1.5-second sleep is asserted in a comment to mean both contenders have loaded. It does not establish that fact. Have `authority-child.ts` emit a ready record before waiting on the barrier, and await readiness from both children before releasing it. Keep the stalled-owner safety test's elapsed-time observation separate: its line 218 is intentionally observing a period with no takeover, not an interchangeable startup-readiness wait.

### `packages/room-mcp/test/combined-kept-preview-fixture.ts`

- **Lines 47–95:** every mutation/provenance case starts with three worktrees, registry reports and real keep collection, even cases concerned only with a holder or snapshot property. `combined-kept-collect.test.ts:42` is an example that checks a held/partially shared anchor. Add parameterized minimal fixtures (one worker for a single-worker provenance case), retaining the three-worker setup for collection-order, sibling ancestry and Git-oracle integration coverage. Do not replace the real-kept-baseline acceptance path wholesale with synthetic records.

### `packages/room-mcp/test/graph-retention.test.ts`

- **Lines 14–17, 46, 80, 104, 147 and 173:** a local three-second wall-clock polling helper waits on readiness/publication/restart outcomes. Prefer GraphIndex completion/publication events and a parser-restart signal; `whenIdle()` alone may not include a future restart, so first await that restart's scheduling/completion, then idle. Use fake/injected scheduling for the exhausted-restart negative assertion at line 57 instead of sleeping 100 ms. This is especially useful beside the already large fixture in this file.

### `packages/room-mcp/test/workers.test.ts` and fixture duplication

- **Lines 28–45** repeat the tool/session/fake-spawner setup already present in `workers-fixture.ts:169`. Both independently fan out exit callbacks without returning/awaiting their handling promises (`workers.test.ts:39`, helper line 180), making it easy to reintroduce the exit-settlement problem fixed elsewhere in 0.17.26. Consolidate the fake spawner as a helper with explicit awaited exit handling and shared resource disposal; retain per-test worktree/maxWorkers options.

### `packages/roomd/test/startup.test.ts`

- **Lines 19–28:** `dirtyRepo()` creates a Git repository for each case, but teardown only restores permissions; none of those directories is removed. Register roots immediately and asynchronously remove them after all startup/stop work is settled. Restore restrictive permissions before removal.
- **Lines 54–64:** seven real 350 ms delays are used to establish continued startup progress across a two-second deadline, with a ten-second test cap. Use an injected monotonic clock/deadline scheduler and a controlled per-write gate to demonstrate progress resetting the deadline. Retain native watcher behavior tests separately.

### `packages/server/test/auth.test.ts` and `packages/server/test/oidc.test.ts`

- **Auth line 95 / OIDC line 203:** the persistence cases allocate temp directories without corresponding removal in these cases. Add unconditional cleanup after draining pending writes. In auth, split the long persistence/TTL/sliding/logout case into separately named behaviors with their own resource ownership; a single failure currently prevents the later assertions from providing evidence.

### `packages/server/test/compaction.test.ts`

- **Line 264:** `within()` races every operation against a referenced timeout that is never cleared when the operation wins. Repeated successful operations leave needless timers active for ten seconds. Use a try/finally timeout wrapper that clears its timer on either outcome.
- **Line 293:** the 300 ms wait assumes document writes reached LevelDB. Observe a test-only persisted-update/flush acknowledgement before stopping the server so the restart case tests persisted data, rather than hoping a delay was sufficient.

### `plugins/room/hooks/common.mjs`

- **Lines 10–11 and 38–39:** stdin and JSON state reads load the entire input before parsing. Catching JSON errors does not bound memory or synchronous work. `readReceipt` already demonstrates a bounded descriptor read later in this same module. Introduce size-capped reads with limits appropriate to event/state formats; consume stdin asynchronously with a byte cap and deadline, and fail hooks softly when the limit is exceeded. Avoid limiting a valid large edit payload so severely that ordinary editing loses coordination without a diagnostic.
- **Lines 92–101:** the MCP reply buffer grows until newline with no byte cap. A malformed/stuck local endpoint can send unbounded bytes during the request window. Cap frame/buffer length, validate the selected reply shape before callers iterate its arrays, and close/settle requests on protocol failure. Preserve unconfirmed inbox items for a later handoff.
- **Lines 66–72:** `writeJsonAtomic` catches rename/write errors but leaves its uniquely named temp file behind. Unlike `writeHookReceipt`, it has no failure cleanup. Hoist the temp path and remove only that path in the catch; retain best-effort semantics.
- **Lines 552–561:** receipt pruning caps stats at 500 but still synchronously enumerates, filters and sorts the entire directory, and reads the entire cursor before slicing it to 255 characters. Stream a bounded directory batch with a persistent traversal strategy and read only bounded cursor bytes. Otherwise the apparent 500-file cap does not bound total work or memory.
- **Lines 248–255 / `before-edit.mjs:99`:** write-intent recording still reads and rewrites a per-session file although the roadmap explicitly says its consumer was removed in 0.17.17 (`docs/roadmap.md`, Post-0.17). Remove the unused recording and corresponding stale tests, or identify a supported consumer before keeping this hot-hook work. This is already tracked; included here because it is directly in this review's scope.

### `plugins/room/skills/room-join/SKILL.md`

- **Line 29 and final wake paragraph:** the prescribed declared-sharing phrase says “paths of every changed file,” whereas `docs/reference.md:24` says paths of eligible changed files and explains digest-only exclusions. Reconcile the skill, returned disclosure and reference against the actual eligibility rules rather than freezing inconsistent phrases. The wake paragraph lists `socket|channels|off` but omits `auto`, which reference line 77 explicitly documents as the default; align the list to avoid sending users toward an override when they want normal selection. These are local documentation consistency findings, not a fresh verification of host version claims.

### `scripts/build-plugin.mjs`, `scripts/build-server.mjs`, `scripts/eval-mocks.mts`, `scripts/demo.sh`

- **Headers, line 1 in each:** build scripts explain purpose but omit invocation/required repository cwd; eval-mocks has neither purpose nor usage; demo omits a concrete invocation and prerequisites. Add short operational headers: `npm run build:plugin` (repo root; `--skip-web` is partial output and must not be committed), `npm run build:server`, `npm run eval:mocks` (overwrites `evals/mocks/room/_tools.json`), and `bash scripts/demo.sh` with Node/npm/Git/uv, PORT and WORK behavior. This saves discovery time and prevents invoking cwd-relative builders from the wrong directory; no formatting-only changes are proposed.

### `scripts/demo.sh`

- **Lines 10–14:** the cleanup guard accepts any path containing `room-demo`, and a lexical `/tmp/` prefix accepts paths such as `/tmp/../Users/...`. It then recursively deletes that path. Canonicalize the destination, refuse root/home/repository ancestors and traversal outside an explicitly owned demo directory, and require an ownership marker before deleting an existing nonempty tree. A fresh `mktemp -d` default is simpler. This is a low-frequency but high-consequence script reliability issue.
- **Lines 28–34:** the script records the `npx tsx` wrapper pid and only checks whether some process accepts TCP; after the loop it never explicitly fails readiness. A stale listener or failed child can lead to confusing login failures against the wrong server. Launch the server directly with `node --import tsx`, await a bounded `/health` response while checking child exit, and print the captured startup log on failure; stop and await the recorded server pid on exit. Do not kill processes by pattern.

## Coverage notes and non-findings

- All eight package Vitest configs reuse the shared setup. The root and package includes cover their intended src/test locations. No standalone config divergence was found by inspection.
- The skip search found explicit platform/privilege/TEST_SCALE guards and a missing-bundle skip with a reason (`parse-worker.test.ts:38`), rather than unexplained unconditional skips. Do not remove supported-platform guards just to reduce a skip count.
- Most sampled names state behavior; opaque historical prefixes such as N1/M1 are secondary to useful descriptions. No formatter/name-only churn is recommended.
- The committed plugin manifests inspected both declare 0.17.29. No build/freshness claim is made, since running the build was explicitly out of scope. `plugins/room/hooks.json` was not changed.
- The task identifies carry-wip, combined-kept-collect and graph-retention as near-timeout files. This review recommends shrinking/owning their work where established above; it does not infer new measured bottlenecks from that context or recommend blanket timeout increases.

## Suggested implementation sequence

First close the two proven fixture ownership gaps and decouple hygiene evidence in CI. Then replace the long throttle sleep and live-log observation window, make cache cases independently runnable, and consolidate worker lifecycle disposal. Reduce default scale work after preserving focused integration coverage. Handle hook bounds and script deletion/startup behavior as separate reviewed changes; leave the frozen hooks manifest untouched.
