# Rehearsal fixes — review round 8, 2026-09-30

Reviewed `5797855..471ca41` at HEAD `471ca411e323b0bb7a6cd5ecb5f2e9b4d3b309f3`, plus a brief cumulative source read over `0aef465..471ca41`. Read round 7 and the dated rehearsal rerun. Report only; no source/test edits, commits, or pushes.

**Verdict: not ready to sign off. Findings: 1 must-fix, 2 should-fix, 0 nits.** All four original round-7 scripts now recover. The archive-specific false pass and silent rerun are fixed, and the stable sweep queue reaches the formerly starved slot. However, complete-tree equivalence still fails for sparse checkouts and changed worktree configuration. U4 is only partly fixed: generations abandoned indirectly in other clones are not queued for owner cleanup.

## U1–U4 reruns

Copied `/tmp/astra-review-r7/new-probes.mts` into `/tmp/astra-review-r8/`, adapting its source import to this worktree and its scratch directory prefix. Ran `archive`, `retry`, `fairness`, and `generations` with `node --import tsx`. Original scripts were not changed. Logs are `/tmp/astra-review-r8-<mode>.log`.

| Item | Result at 471ca41 |
| --- | --- |
| U1: archive attributes omit/rewrite tracked files | **Original defect resolved.** Both normal and forced-fallback checks discover the failing `export-ignore` test and return `passed: false`, exit 1. The repository regression also checks unchanged `export-subst` contents. The general same-tree claim still needs V1 and V3 below. |
| U2: cleanup failure reruns the check and replaces its first result | **Resolved.** The external invocation marker is `1`, the first `1 failed` result is retained, and the reply includes the cache-abandonment warning. The injected 250 ms cleanup delay makes the full call 353 ms; reported setup/check times remain phase times (57/25 ms), not total call latency. There is no hidden second execution. |
| U3: coupled cursors permanently skip half a key | **Resolved in the original ordering.** Forty sweeps probe all 24 injected owners, including `600015`; `targetProbed: true`, `targetExists: false`. The candidate queue is drained before new source slices are gathered. |
| U4: six transiently abandoned generations cannot be reclaimed by the live owner | **Original single-clone case resolved; multi-clone case remains (V2).** Six final-validation faults preserve six passing check results, and subsequent maintenance leaves zero directories and zero locked registrations for that clone. The healthy other-clone ordering below still accumulates six generations. |

Faults and liveness in these scripts are explicitly injected as in round 7. Git operations and filesystem contents after those injected boundaries are real; the scripts print observations rather than presenting reproduced defects as passing assertions.

## Findings

### V1 — must-fix: the cached path still inherits sparse checkout and can skip failing tracked tests

**Location:** `packages/room-mcp/src/tools/files.ts:1039`, `:1015`, and `:1173–1174`.

`worktree add` inherits the caller's sparse-checkout setup; `reset --hard` retains that sparse selection. The new private index is populated from the full committed tree, so `checkout-index -a` materializes paths that the cache omitted. Thus the two paths still run against different tracked inventories for the same ancestor and merged map. The cached sparse behavior predates this individual commit but belongs to the cumulative rehearsal cache change; the new fresh implementation does not eliminate this equivalence gap.

**Concrete sequence:** `/tmp/astra-review-r8/sparse-verdict.mts`, log `/tmp/astra-review-r8-sparse-verdict.log`:

1. Commit `tests/ok.test` containing `PASS`, `regression/bad.test` containing `FAIL`, and unrelated `x`.
2. Run `git sparse-checkout init --cone` and `git sparse-checkout set tests` in the caller.
3. Preview the ancestor plus a merged edit to `x`. The command recursively discovers `*.test` and exits nonzero if any contains `FAIL`.
4. The cache discovers only `tests/ok.test`: **`passed: true`, exit 0, `1 passed`**.
5. Force the safe fresh fallback by replacing that cache's `.git` leaf with a symlink. Keep the ancestor, merged edit, and command identical.
6. Fresh checkout discovers both tracked tests: **`passed: false`, exit 1, `1 failed`**.

This also occurs naturally when an overlapping request chooses fresh scratch; cache damage is only a convenient deterministic trigger. A separate plain `update-index --skip-worktree z/out` probe, without sparse configuration, does **not** reproduce the omission: both trees contain that file and the caller's skip flag remains unchanged.

**Suggested change:** enforce a full checkout in each Room-owned cached worktree, including reused/adopted slots, with worktree-local sparse settings disabled and skip-worktree state expanded. Do not change the source checkout's sparse settings or shared repository configuration. Verify the materialized tracked inventory before accepting a whole-tree check, or conservatively refuse unsupported sparse setup. Add a cached-versus-fresh sparse fixture containing a failing test outside the caller's sparse cone.

**Impact:** **incorrect check results, including false passes and potentially passing-preview evidence**. No source checkout or unrelated index mutation was observed. This is not a disk-only issue.

### V2 — should-fix: a failure in one clone still strands healthy generations in other clones

**Location:** `packages/room-mcp/src/tools/files.ts:629`, `:664–668`, `:817–836`, `:1086–1087`, and `:1135–1136`.

The generation number is process-wide, but `abandonedOwnSlots` records only the slot whose setup/reset failed. Advancing the number also makes every older slot for every other clone key unreachable by future previews in this MCP process. Those healthy slots never enter the owner cleanup map, and ordinary sweeps still regard them as owned by a live process.

**Concrete sequence:** `/tmp/astra-review-r8/multi-generation.mts`, log `/tmp/astra-review-r8-multigen.log`:

1. In one process, create two ordinary repositories (`healthy` and `faulty`), representing the multiple clone/session keys this process can serve.
2. For each of six iterations, run a successful preview in `healthy`; then preview `faulty`, injecting one transient EBUSY on its `.git` final-validation read.
3. Wait for owner maintenance after each iteration. Restore ordinary reads, and request/await ten explicit sweeps for both repositories.
4. `faulty` correctly has **zero slots / zero locked registrations**. `healthy` still has **six slots / six locked registrations**, generations `-0` through `-5`. The process's current generation is now `6`, so none is a reusable current slot.

There are no uncertain registrations, foreign symlinks, or persistent faults in the healthy repository. This is the cross-clone consequence already described in U4, rather than a new authority failure in deletion.

**Suggested change:** make generation advancement local to the canonical clone key, or track all slots belonging to the process and queue every superseded inactive slot when a global generation advances. Slots with active turns must be queued only after their turn releases. Preserve the current reciprocal-registration checks and other-process liveness protection.

**Impact:** **unused disk and locked-registration retention only** in this reproduction. Warm compiler caches can make each stranded generation large. No wrong check result or other-checkout mutation was observed.

### V3 — should-fix: reused caches retain old worktree configuration while fresh checkout uses current configuration

**Location:** `packages/room-mcp/src/tools/files.ts:1025–1044`, `:1015`, and `:1166–1174`.

A cached Git worktree has its own copied `config.worktree`. Reuse validates its registration and resets the ancestor but does not refresh or invalidate checkout-affecting configuration. Fresh `checkout-index`, in contrast, runs against the source worktree's current configuration. This matters even when sparse checkout is disabled and every tracked path exists.

**Concrete sequence:** `/tmp/astra-review-r8/config-drift.mts`, log `/tmp/astra-review-r8-config-drift.log`:

1. Enable `extensions.worktreeConfig`, set source `core.autocrlf=false` with `git config --worktree`, and commit `x` as `base\n`.
2. Run one preview to create the cache. Change only the source's worktree setting to `core.autocrlf=true`.
3. Run a check that fails on CRLF bytes. The reused cache still reports `core.autocrlf=false`, reads `"base\\n"`, and returns **`passed: true`**.
4. Force fresh fallback without changing the ancestor, command, or settings again. It reads `"base\\r\\n"` and returns **`passed: false`**. Source configuration is `true` throughout both compared checks.

Copied-cache configuration staleness existed before this commit. Using checkout conversion in the new fresh path now exposes that stale cache versus current source distinction; the former archive path did not use the current CRLF setting either. This is separate from V1's missing tracked paths.

**Suggested change:** define the checkout configuration used by a preview and apply it consistently to both materializers. Invalidate/recreate the cache when the effective relevant configuration or attributes change, or materialize both paths with an explicit identical conversion policy. Merely copying a new setting into a warm cache is insufficient if unchanged tracked bytes are not re-checked out. Add a regression that changes a worktree-local conversion setting after warming the cache.

**Impact:** **check results can differ, including a stale-cache pass when the current fresh conversion fails**. No other checkout was modified. This is not unused disk space.

## Additional checkout, cleanup, and responsiveness checks

Scratch source: `/tmp/astra-review-r8/checkout-edges.mts`; logs: `/tmp/astra-review-r8-edge-<mode>.log`.

- **Symlinks and executable bits:** the basic cached/fresh snapshots match, including a symlink's target and `0755` executable mode. With `core.symlinks=false`, both materializers consistently produce the tracked link as a plain file containing the target. These are Darwin observations, not a Windows execution claim.
- **Gitlinks/submodules:** a tracked `160000` entry produces an empty directory in both paths. Neither initializes submodule contents; this check establishes matching uninitialized behavior, not recursive submodule support.
- **Skip-worktree and sparse:** source index skip flags are not copied into the private index. The manual skip flag fixture matches; the cone sparse fixture differs as V1 describes.
- **Stable attributes/conversion:** cached and fresh bytes match for `text eol=crlf`, `ident`, and a configured deterministic uppercase smudge filter. A stable worktree-local `core.autocrlf=true` also matches. `core.splitIndex=true` leaves no extra files in the fresh destination. Archive-only attributes are covered by the original rerun and repository regressions.
- **Context-sensitive filters:** a smudge filter that embeds `pwd` produces different absolute paths, as expected for different checkout locations. Both filters run in their destination tree, not in the live source checkout. Arbitrary location-dependent filters, commands depending on `.git`, initialized submodules, and deliberately retained ignored build caches mean these execution environments are not universally byte-for-byte interchangeable. No separate defect is claimed merely for a path-embedding filter; V1/V3 demonstrate ordinary tracked inventory/configuration failures.
- **Private index cleanup:** successful materialization and missing-commit rejection remove the temporary index in the repository tests. The forced checkout timeout below also leaves no `.room-preview-index-*` file. `runInMergedTree` removes the whole fresh directory on setup failure, so a partial extraction or leftover lock is not handed to the check. Abrupt process death can still leave an unregistered `/tmp/room-merge-*` tree, as it could before; that is unused scratch disk, not an authenticated worktree cleanup capability.
- **Timeout:** `/tmp/astra-review-r8/filter-timeout.mts` uses a real two-second smudge filter and wraps only the checkout subprocess options to shorten the production ten-minute timeout to 100 ms. Git exits by SIGTERM at 122 ms, the callback runs at 122 ms, and the helper rejects at 123 ms with the temporary index gone. This probe does not reproduce an inherited-pipe hang. Production gives `cat-file`, `read-tree`, and `checkout-index` one shared setup deadline. A timed-out checkout returns setup failure; it does not run a check on the partial tree. This was an accelerated fault probe, not a ten-minute wall-clock test or a guarantee for arbitrary filter subprocess trees.
- **Owner cleanup versus next preview:** `/tmp/astra-review-r8/cleanup-race.mts` injects one final-validation failure, pauses only the old generation's real `git worktree remove` launch, and starts the next preview. It releases removal after the new merged file is installed while that check is still running. Both checks pass, the old slot disappears, the new slot survives/reset to base, and the source stays `base`. The monotonically advanced slot name and `previewSlotTurns` check protect the exercised ordering; no new mutation of another checkout was found.
- **Blocking calls:** the new checkout subprocesses, index removal, owner removal, and sweep filesystem operations are asynchronous. No new `execFileSync`, synchronous recursive deletion, or synchronous whole-tree materialization was introduced. Existing per-file writes/path validation and shallow dependency `readdirSync` calls remain; yielding between files does not bound an individual slow synchronous filesystem operation. The repository responsiveness tests pass. This is not a claim that every existing synchronous operation is eliminated.
- **Larger tree:** `/tmp/astra-review-r8/large-tree.mts`, log `/tmp/astra-review-r8-large.log`, materializes 20,000 small tracked files in 2,318 ms on this host. A 10 ms interval fires 199 times with maximum measured excess delay of 2 ms. First/last contents match, the source index is byte-for-byte unchanged, and no temporary index remains. The existing suite additionally exercises cached and overlapping fresh previews of a 5,000-file tree. These are small-file scale probes, not a multi-gigabyte/LFS benchmark.

## Cumulative read and validation

The brief final read covered fresh-room admission, push ancestry/history and catch-up status, wake-turn scans and receipts, preview names and partial/evidence handling, dependency relinking, graph-readiness shortcuts, conflict/landed-claim freshness, shutdown, plugin selection, and shared-checkout collection/retirement. Collection's final destination identity gate remains after async source-ref publication with no await through the write loop; retained-owner cleanup checks late work and commits. No additional concrete finding was established outside V1–V3.

The full rehearsal fix set is **not ready to ship** while a nominal whole-tree check can omit failing tracked tests. U1's archive-specific issue is repaired, but V1 blocks an unconditional correctness sign-off. V2 is disk-only; V3 also affects check results. Host-specific conclusions here rely on the supplied dated rehearsal evidence; this report does not claim another live host wake/routing run.

- Focused cache/materialization/import suite: **44 tests / 6 files passed**, log `/tmp/astra-review-r8-cache-tests.log`.
- Broader cumulative suite: **447 tests / 16 files passed**, log `/tmp/astra-review-r8-regression.log` (collection, conflicts, carried work, preview names/manifest, wake turns, lifecycle/worker cleanup, shutdown, tool budget/tools, hub admission, base branch/resolution, areas and base messages).
- Total: **491 tests / 22 files passed**. Both batches used `--maxWorkers=1` and unset `ROOM_TAG`, `ROOM_OWNER`, and `ROOM_SERVER`; the cache batch finished before the broader batch started. The sandbox denied the attempted `nice -n 10` adjustment (`setpriority: Operation not permitted`). No agents were spawned.
- Scratch probes ran on Darwin with Git **2.45.2**. Probe files and logs remain under `/tmp/astra-review-r8*`; temporary fixture repositories were removed.
- No local-network socket integration suite was attempted: this sandbox cannot bind the required listeners. No full CI, typecheck, plugin rebuild, host-model eval, or Windows/Linux execution claim is made.
- Required `room_preview_merge(people:["rohanz"])` completed **without conflicts**, common ancestor `471ca411e3`. Only this report differed; no tests were requested for the document-only combined tree.
- `git diff --check` passed. This report is the only changed repository path. No source/test edits, commits, or pushes.

**Final verdict: not ready to sign off.**
