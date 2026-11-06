# SQLite slice 2: Codex gpt-6-astra reviews, rounds 7–15

Reviewer: Codex gpt-6-astra (high effort, read-only), run through `codex:codex-rescue` in the lead's foreground. Each
round reviewed the diff since the previous round in the context of `origin/main...HEAD`. Codex's session was read-only,
so the lead recorded each verdict and its resolution here. Every fix has a regression test that fails without it.

| Round | Reviewed | Verdict | Findings |
|---|---|---|---|
| 7 | `00d192ef` | DO NOT MERGE | 2 MUST-FIX |
| 8 | `1fa8ba60` | DO NOT MERGE | 2 MUST-FIX |
| 9 | `ca196df5` | DO NOT MERGE | 2 MUST-FIX |
| 10 | `edc06e3a` | DO NOT MERGE | 2 MUST-FIX |
| 11 | `1b8666b4` | DO NOT MERGE | 1 MUST-FIX |
| 12 | `179fa5eb` | DO NOT MERGE | 1 MUST-FIX |
| 13 | `cb805c4b` | DO NOT MERGE | 2 MUST-FIX |
| 14 | `5f4cabb5` | **MERGE** | 0 |
| 15 | `24e2e11f` | **MERGE** | 0 |

Rounds 7–13 all concern one class of defect: work started before or during MCP shutdown that registers, admits or opens a
worker registry after the process acknowledged its storage close. Rounds 7–12 closed individual producers. Round 13 led
to the convergent fix at the storage entry points.

## Round 7

1. **Production registry watchers survived shutdown.** Cached `WorkerRegistry` watchers and the 30 s poll could reconcile
   (register and admit) after storage admissions closed. Fix: `FileWorkerStore.shutdown()` stops watchers and the poll for
   good (`shut`; `watch()` becomes a no-op) and awaits the running pass. `shutdownWorkerRegistries()` runs inside the
   bounded shutdown settle.
2. **Unknown process ownership was treated as foreign.** `procCwds` skipped an EACCES/EPERM process whose owner `stat`
   failed for any reason, so a retained preview helper could be released while an escaped descendant ran. Fix:
   `ownerOf` returns `'gone'` only for ENOENT/ESRCH. Unknown ownership makes the listing incomplete, which fails closed.

## Round 8

1. **A `registryForDir` still resolving its Git directory could open after shutdown.**
2. **Evicted or closed registries escaped permanent shutdown** and could restart watchers via `ensureGeneration`.

Fix: one owned registry lifetime in `worker-registry.ts`. Calls are tracked from entry, and every opened registry
(cached, evicted or closed) is tracked until it is retired for good. Each tools instance holds a counted lease. A shutdown
epoch refuses calls made during shutdown and calls that began before it.

## Round 9

1. **An in-flight host rebind could adopt a session after shutdown.** Fix: rebinding is extracted into `HostRebind`
   (`host-rebind.ts`). Shutdown closes it first, and a join that completes later is left, never adopted.
2. **The Windows ACL repair walk treated access-denied as "gone"** (`Exists()` is false on access errors). Fix: the walk
   skips an entry only on a definitive not-found, using unwrapped `FileNotFoundException`/`DirectoryNotFoundException` or
   icacls exit codes 2/3. Anything else refuses. Windows test: a denied descendant is refused.

## Round 10

1. **A stale replacement's secondary join could attach after a signal shutdown.**
2. **An already-running `room_join` could add its session and re-arm auto-join after shutdown.**

Fix at the single attachment chokepoint: `tools.shutdown()` first calls `Rooms.close()`. After that, `Rooms.add` and
`Rooms.track` attach nothing and hand any late session to `doLeave`. `room_join` returns "not joined", the workers room
refuses, and `autoJoin.retarget` is skipped.

## Round 11

1. **A tool handler already running at shutdown** (`room_spawn` paused before a direct `registryForDir`) **could open a
   registry after shutdown.** Fix: `RegistryLease` gains an `AsyncLocalStorage` scope, and every `tools.call` runs in
   it. Shutdown fences the lease first, and `registryForDir` refuses opens from an ended lease's scope.

## Round 12

1. **A retirement pass queued by startup auto-join** (outside any call scope) **could re-run after shutdown.** Fix:
   `Rooms` takes a `scope` option. `add`/`track`, where every attachment, tracked open, retirement timer and projector
   is born, run in the lease's scope, and their timers inherit it. `autoRetire` stops re-queuing once Rooms is closed
   or the session is untracked.

## Round 13

1. **A conflict-set pass resumed from a Y.js/provider callback could call `registryForDir` after shutdown.**
2. **The presence tick could `withAdmission` after its Git lookup resumed after shutdown.**

Convergent fix: `process-lifecycle.ts`, a module with no imports. Each tools instance holds the process lifecycle. When
the last holder ends, the lifecycle stays ended: `registryForDir`, `storageRegistration` and `admitTracked` refuse,
whatever context the late work runs in. A new holder begins a new lifecycle. `vitest.setup.ts` imports the explicit
`resetProcessLifecycle()` and runs it before each test, since each test models a fresh process.

## Round 14: MERGE

0 findings. Codex enumerated every in-process path that can reach Room storage. Ordinary registration, admission and
registry opening all pass through `registryForDir`, `storageRegistration` or `admitTracked`. The other paths are
read-only validated reads, or `finish`/`unregister` of work admitted earlier. The intentional exceptions:

- the offline maintenance owner (`offline/entry.ts`, `offline/legacy-import.ts`), which owns `migration.lock` and
  registers as maintenance;
- file-only state outside lifecycle storage: session files, and the pre-existing idle-claims journal quarantine under
  `room/registry/quarantine`;
- preflight probe scratch.

Codex also confirmed the shutdown order in `index.ts`: host rebind closed, then auto-join settled, then
`tools.shutdown()` (Rooms closed, lease fenced, dismissals, bounded settle, lifecycle ended), then arbitration closed,
then `closeStorageAdmissions()`. Nothing in that sequence needs a new admission after the lifecycle ends.

## Windows defects found by the new `sqlite-state` CI matrix (fixed between rounds)

- `compat.json` v2 bundle digests failed on Git-for-Windows checkouts (`core.autocrlf`): `.gitattributes` marks
  `plugins/room/server/*.mjs -text`.
- The offline legacy inventory skipped every Room worktree on Windows, because Git prints forward-slash paths. Listed
  paths are now resolved.
- The ACL repair walk failed when another Room process removed an entry mid-walk. It now skips definitive not-found only.
- Drain hid a holder's registration evidence while its deleted ticket's name was still listed (delete-pending).
- `fsutil fsinfo volumeinfo` needs elevation, so NTFS classified `unknown` and refused the WAL journal. Classification
  now uses .NET `DriveInfo` (GetDriveType/GetVolumeInformation).

## Round 15: MERGE (final head)

Reviewed the only change after round 14. `tryPreviewLock`'s 1 s deadline now starts when GO is written, so it bounds
the non-blocking lockf/flock attempt and not the helper's storage admission before it. Under full-suite load that
admission could use up the window, and the check would silently skip the cache and run in a fresh tree: the round-14
intermittent failure, now reproduced deterministically by a test that delays the first helper admission. 0 findings.
Qualification recorded for slice 3: the gate worker RPC has no independent deadline, so a permanently stalled gate
worker thread could leave an admission pending.
