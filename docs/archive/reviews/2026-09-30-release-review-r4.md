# Release-readiness review, round 4 — 2026-09-30

Reviewed `7c34cb7..54c4ffd`, including all release briefs, the three preceding reports, the lead's rulings, fix `8156402`, and its rebuilt plugin bundle. Report only; no source, test, other documentation, or plugin edits.

**Findings: 0 MUST-FIX, 0 SHOULD-FIX, 0 NIT.** No new actionable issue found in the fix or the remaining batch.

## Round-3 verification

| Finding | Result |
|---|---|
| T1: native-Windows check loses its deadline | **Resolved under the explicitly accepted pre-batch Windows behavior.** `packages/room-mcp/src/tools/files.ts:1087` selects `execFile` before the POSIX runner, retaining its five-minute timeout and 4 MiB output limit. `tryPreviewLock` offers no Windows lock, so this remains a temporary-tree path. It performs no leftover-process stopping and reports no such stopping, as directed by the lead. `/tmp/room-review-r4-windows.mjs` extracts and transpiles the actual check-dispatch block, supplies `platform: 'win32'`, and drives success, numeric failure, deadline, buffer overflow, and missing-shell callbacks. Every case uses `execFile`, preserves the timeout/buffer/cwd options, resolves with the expected exit code, and returns `stopped: false`; entering the POSIX runner would fail the probe. This is a dispatch/callback simulation on macOS, not a native-Windows process-lifecycle test. |
| T2: Boolean reported as a process count | **Resolved.** `files.ts:631` now represents the fact as a Boolean, and `files.ts:1100` says `stopped leftover processes from the check`. The independent two-helper reproduction, adapted to this worktree in `/tmp/room-review-r4-count.mts`, observes both helpers' SIGTERM markers (`stopped helper count: 2`) and the new nonnumeric reply. All three process-lifetime regressions pass, including SIGTERM resistance and cache-disabled checks. |

The corresponding Windows dispatch and nonnumeric reply are present in the committed bundle (`plugins/room/server/room-mcp.mjs:40201`). The type change does not alter the POSIX termination/drain sequence or the Git setup consumer. No additional regression found in `8156402`.

## Earlier findings and batch re-check

- **R1 / S1 remain resolved on POSIX.** The crash regression confirms the cache lock survives an MCP crash while its check still uses the tree; contention falls back and eviction skips the held entry. Foreground-exit regressions confirm remaining group members stop before reset/removal. Stopping these leftovers remains intentional.
- **R2 / S2 / R8 remain resolved under the lead's startup contract.** Doctor dispatch bypasses ordinary runtime initialization for a first deferred request, and bypasses join/settle/sync for an existing runtime. The real-entry tests cover first diagnostic, eager listener failure, and invalid configuration; active-session diagnosis uses its checkout/destination. Eager launch startup and keeping the MCP alive after startup failure are accepted behavior.
- **R3 / R4 remain resolved.** Frozen known hook hashes are compared exactly; unknown hashes warn and absent hashes fail. Health requests use manual redirect handling, with injected-fetch coverage. The diagnosis does not print token values. The previously accepted Room credential-presence lookup is retained; host-default probes read only public settings.
- **R5 / R6 / R7 / R9 / S3 / S4 remain resolved.** Legacy migration excludes sidecars and requires directories; wake-off precedes either host's sending path; manual cache cleanup unlocks before removal; `ROOM_TAG` replaces the nonexistent join argument; the wake-documentation link exists; destination precedence includes the remembered team server.
- Rechecked shared-cache keys and checkout fingerprints, immediate contention fallback, reciprocal Git registration, cap-zero behavior, held-entry eviction and migration; collection's batched Git-operation checks and timing; owner fallback and ambiguity; worker model/effort precedence, omitted override flags and host-default labels; and the old-server error text. No further finding.
- Read README through onboarding as a newcomer, then checked reference, upgrading, contributor instructions and the 0.17 changelog against the relevant code. Installation, expected state output, diagnostics, team setup, sharing choices, worker preview and collection are discoverable. Checked installed Claude/Codex plugin help and the lead's dated host snapshots; Codex `marketplace upgrade`, install commands and ref options match the local CLI. The instant-interrupt conclusion continues to rely on the lead's documented 0.159.2 live check; no model session was rerun.
- Rechecked tool/skill routing and task-based splitting, including shared-file and dependent-change eval cases. Required routing phrases remain. Tool names, descriptions and schemas total **9,482 / 9,500 characters**; the eval tool mock exactly equals the corresponding DEFS projection. Both frozen hook-definition diffs against `7c34cb7` are empty.

## Validation and limits

- `npm run typecheck`: passed. `nice -n 10` was attempted, but the sandbox refused the priority change; typechecking still completed. Heavy jobs were staggered and Vitest used one worker.
- Doctor/cache/routing: **11 files, 74 tests passed**, in three completed runs: `doctor-entry`, `doctor`, `release-readiness`, `tool-budget`; `preview-check-lifetime`, `preview-cache-crash`, `preview-lru`; `preview-cache-config`, `preview-cache-races`, `preview-cache-slots`, `preview-run-cache`. Commands ran from `packages/room-mcp` with `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER`, `--config ../../vitest.config.ts --root ../.. --maxWorkers=1`. An initial combined run was interrupted before any completed file result and is not counted; every selected file subsequently completed in the smaller runs above.
- Collection/worker/sharing/timing/wake: **5 files, 179 tests passed** (`collect`, `spawn-safety`, `consent`, `timing`, `wake-turn`), with the same environment/configuration. Across completed runs: **16 files, 253 passing tests, no failures**. An independent injected-sender probe also confirms `ROOM_WAKE=off` calls neither host's sender.
- `npx --no-install knip --no-progress`: passed. `sh -n plugins/room/bin/room-doctor`: passed; its executable bit is committed. A scratch wrapper probe preserved `doctor`, `--dir`, and a checkout path with spaces when the plugin path also contained spaces.
- No live network probes, socket-listening suites, native-Windows run, plugin install/rebuild, model-backed eval, deployment, commit, or push. Socket suites and native-host behavior need the lead's unrestricted validation; this report does not claim those were rerun. Scratch probes and fixtures are under `/tmp`.
- Final `room_preview_merge(person="rohanz")`: no conflicts and no additional lead changes over `54c4ffd`; only this report differs. Ignored typecheck build output was excluded. No tests were run on the combined tree.
- `git diff --check`: clean. Git status contains only this untracked report.

**Verdict: ready to sign off — 0 MUST-FIX, 0 SHOULD-FIX, 0 NIT.**
