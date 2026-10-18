# Release-readiness review, round 3 — 2026-09-30

Reviewed `7c34cb7..4207ed5`, including every release brief, the round-1 and round-2 reports, `fix2.md`, fixes `3cc9761`, `4a1f290`, `e838391`, and the rebuilt bundle. Report only; no source, test, other documentation, or plugin edits.

**Findings: 0 MUST-FIX, 1 SHOULD-FIX, 1 NIT. Not ready to sign off.**

## SHOULD-FIX

### T1 — The new temporary-preview runner cannot enforce its deadline on native Windows

- **Location:** `packages/room-mcp/src/tools/files.ts:582-608,628-641,1086`.
- **Scenario:** Native Windows always uses a temporary preview tree. Before `e838391`, that check used `execFile` with a timeout. It now unconditionally uses `runTrackedProcess`, whose only termination attempts are `process.kill(-child.pid, ...)`. Node does not support this process-group operation on Windows. Both attempts throw and are swallowed; the deadline only records an error, and the promise settles only after the child exits/closes. A stuck check therefore keeps the tool pending indefinitely after the five-minute deadline. The output-limit path has the same problem. If the foreground shell exits while a redirected helper remains, `previewGroupAlive` also treats the unsupported operation as “gone,” so cleanup can remove its tree without stopping the helper.
- **Evidence:** `node /tmp/room-review-r3-windows.mjs` extracts and transpiles the current runner unchanged, injects the documented Windows behavior for negative-PID signals, and drives child events and timers directly. After firing the deadline and SIGKILL grace callbacks, it reports **`settledAfterDeadlineAndGrace: false`**; the only signals attempted target `-1234`. A normal foreground exit reports **`stopped: 0`** despite the simulated surviving helper. The local Node API documentation in `node_modules/@types/node/process.d.ts:1429` explicitly states that Windows throws for process-group kills. This is an event-driven Windows-semantics probe on macOS, **not a native Windows run**. The new lifetime tests explicitly skip Windows.
- **Fix:** Add a platform-aware termination path for temporary checks. On Windows, use a supported child/process-tree termination mechanism and a bounded error path; do not infer “processes gone” from an unsupported group probe or remove the tree while known children remain. Cover timeout, buffer overflow, and a foreground exit with a surviving helper; verify on native Windows before claiming that platform works.

## NIT

### T2 — The leftover-process count is a Boolean, not the number stopped

- **Location:** `packages/room-mcp/src/tools/files.ts:631,1093`.
- **Scenario:** A check leaves two or more background helpers in its process group. Room stops the whole group correctly on macOS, but `stopped` is always either zero or one, so the reply undercounts the terminated processes.
- **Reproduction:** `node --import tsx /tmp/room-review-r3-count.mts` starts two redirected Node helpers, each recording receipt of SIGTERM. Both stop, but the reply says **`stopped 1 leftover process(es) from the check`**; the probe observes **`stopped helper count: 2`**.
- **Fix:** Either count the processes actually targeted, or use an accurate nonnumeric message such as “stopped leftover processes from the check.” No cleanup failure was observed in this reproduction.

## Round-2 verification

| Finding | Result |
|---|---|
| S1: reset before surviving check children exit; unbounded reply | **Resolved on the POSIX path reviewed in round 2.** The runner reacts to foreground `exit`, stops the group before waiting for stdio closure, escalates SIGTERM to SIGKILL, and drains before reset/removal. All three new lifetime tests pass. Independent `/tmp/room-review-r3-background.mts` probes cover cached, SIGTERM-resistant, and cache-disabled checks: every helper reads `MERGED` in its termination handler and is gone when the reply arrives. The crash regression still passes. T1 is the newly expanded runner's native-Windows gap; T2 concerns the new reply text. |
| S2: first diagnostic initializes Room and auto-join | **Resolved under the lead's stated startup contract.** The entry-point branch precedes `binding.run`; it uses an initialized matching runtime without settling/rebinding, otherwise runs the standalone doctor. The three new real-entry tests pass. Independent `/tmp/room-review-r3-mcp.mjs` tests the rebuilt bundle with isolated host/config fixtures: the first deferred check records only `https://fixture.invalid/health` and no arbitration attempt. After eager listener failure, doctor still returns a report; after eager invalid `ROOM_URL`, it returns `FAIL Room config`. In both cases ordinary `room_state` and `room_send` return `isError: true` with “Room could not start …” and the specific cause. Eager launch-time startup remains intentional; its traffic is not attributed to doctor. |
| S3: broken join-skill wake link | **Resolved.** The skill now links `docs/reference.md#wake-paths`, and that section exists. |
| S4: remembered team destination omitted | **Resolved.** The reference now includes the previously used team server before the hosted default, matching `resolveConfig`. |

Round-1 fixes remain intact: crash-held cache and held-entry eviction, exact frozen hook hashes, manual-only redirects, repeated legacy migration without `.lock.lock`, both-host wake-off, unlock-before-manual-cache-removal documentation, active-session doctor selection, and the supported `ROOM_TAG` wording. Existing regression tests and the corresponding code/documentation were rechecked; no earlier finding is reopened beyond T1's separate platform regression.

## Validation and remaining coverage

- `npm run typecheck`: passed. `nice -n 10` was attempted; the sandbox refused the priority change, and typechecking still succeeded. Heavy runs were staggered and Vitest used one worker.
- Doctor/cache/routing: **11 files, 74 tests passed**, covering `doctor-entry`, `doctor`, `release-readiness`, `tool-budget`, `preview-check-lifetime`, `preview-cache-crash`, `preview-run-cache`, `preview-lru`, `preview-cache-config`, `preview-cache-races`, and `preview-cache-slots`. Invoked from `packages/room-mcp` with `--config ../../vitest.config.ts --root ../.. --maxWorkers=1`. An initial combined run was interrupted before a completed file result; every selected file was subsequently completed in the three smaller runs counted here. An earlier invocation rejected an unsupported `--minWorkers` flag before running tests.
- Additional collection/worker/consent/timing/wake/workspace run: **333 passed, 2 failed; 5 files passed and the socket-wake file had 17 passes and 2 failures**. Both failures are sandbox `listen EPERM` in “Claude: writes auth then user JSON lines to the inbox socket” and “falls back when a previously bound inbox refuses connections.” The lead must run those two outside the sandbox. The wake-off regression passed. Across completed runs: **17 files, 407 passing tests, 2 socket-listening failures**. The broader run completed in about 260 seconds; a redundant follow-on invocation was stopped and is not counted.
- `npx --no-install knip --no-progress`: passed. Frozen `hooks.json` and `hooks/claude.json` diffs against `7c34cb7` are empty. The tool budget is **9,482 / 9,500 characters**, routing phrases remain covered, and the eval mock equals DEFS projected to name/annotations/description/inputSchema.
- `sh -n plugins/room/bin/room-doctor`: passed. A scratch installation under a path containing spaces preserved the arguments `doctor`, `--dir`, and `/tmp/checkout with spaces` correctly.
- Re-reviewed cache keys and checkout-policy fingerprints, immediate contention fallback, LRU/cap-zero eviction, reciprocal Git registrations, legacy migration, collection's batched operation checks and phase timing, owner addressing/ambiguity, worker model/effort precedence and omitted override flags, public host-default settings probes, sharing disclosure, tool/skill routing, and task-based split guidance/eval fixtures. No additional findings from these paths.
- Read the README as a newcomer and followed it into onboarding, reference and upgrading; checked changed contributor instructions and the 0.17 changelog. Installation, success strings, diagnostic entry points, team setup, and worker/preview/collection progression are discoverable. Checked installed Codex/Claude plugin and marketplace help plus the lead's dated host snapshots. The instant-interrupt statement relies on the lead's documented 0.159.2 live check; no model session was rerun.
- No live network probes, native-Windows run, plugin install/rebuild, model-backed eval, deployment, commit, or push. MCP network probes used injected fetch; scratch scripts and fixtures are under `/tmp`.
- `room_preview_merge(person="rohanz")`: no conflicts; no additional lead changes beyond the reviewed `4207ed5` base. No tests were run on the combined tree. `git diff --check` is clean; Git status contains only this untracked report.

**Verdict: not ready to sign off — 0 MUST-FIX, 1 SHOULD-FIX, 1 NIT.**
