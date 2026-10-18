# Release-readiness review, round 2 — 2026-09-30

Reviewed `7c34cb7..930e839`, including the release briefs, round-1 report, `fix1.md`, and fixes `e909531`, `58c987a`, and `d97f649`. Report only; no source, test, other documentation, or plugin edits.

**Findings: 2 MUST-FIX, 0 SHOULD-FIX, 2 NIT. Not ready to sign off.**

## MUST-FIX

### S1 — Cache cleanup runs before surviving check children exit, and the reply can wait forever

- **Location:** `packages/room-mcp/src/tools/files.ts:603-606,1073-1089`; `packages/room-mcp/src/preview-cache.ts:33,49-51`.
- **Scenario:** A check starts a background helper with redirected stdio and its foreground shell exits. `runTrackedProcess` resolves on that shell's `close` and clears the five-minute timeout. The preview then resets/cleans the cached tree while the background helper still uses it. Only afterward does `release()` wait for the whole process group. A persistent helper therefore also prevents the tool reply indefinitely, without the check timeout still running. Holding the OS lock protects against other previews, but does not protect the helper from this preview's own cleanup.
- **Reproduction:** `node --import tsx /tmp/room-review-r2-background.mts`. In a scratch committed repository, apply `FIRST` to `app.txt`, start a background Node checker gated on an external file, and let the shell print `1 passed` and exit. The probe observed `cached: true`, **`tree reset while child alive: true`**, and **`background check read: BASE`** when its gate opened. The preview completed only after that child exited. No MCP crash is necessary. The gate is outside the cached tree and the child stays in the tracked process group; this is not a process escaping tracking by creating another session.
- **Fix:** Finish or terminate the tracked process group, under a bounded check deadline, before resetting/removing its tree. Keep protection across the drain and cleanup rather than releasing/reacquiring the lock. Add coverage for a foreground command that exits while a redirected background child remains, including a child that does not voluntarily exit. The original round-1 orphan-after-SIGKILL reproduction is fixed; this is an uncovered normal-completion path in the process-lifetime fix.

### S2 — The first diagnostic request still initializes Room and starts auto-join

- **Location:** `packages/room-mcp/src/index.ts:92-110,206-207,221-223`.
- **Scenario:** On a fresh shared-Codex MCP, `room_state({check:true})` goes through `binding.run` before reaching either new diagnostic shortcut. Initialization parses ordinary configuration, starts the arbitration listener, and invokes `autoJoin.ensure()`. Thus the check can fail before doctor runs when initialization is broken, and a first setup check still starts admission/auth network requests in addition to `/health`. The existing tests enter through `createTools`, after this outer initialization boundary.
- **Reproduction:** The scratch stdio MCP client `/tmp/room-review-r2-mcp.mjs` sends initialize and a real `tools/call` to the committed `plugins/room/server/room-mcp.mjs`, with workspace metadata and isolated fake host/config directories. In this sandbox it returns **`Room could not start ... listen EPERM: operation not permitted 127.0.0.1; try again.`**, not a diagnostic report. `/tmp/room-review-r2-mcp-config.mjs` independently uses an invalid legacy `ROOM_URL` and returns **`Room could not start ... ROOM_URL must use ws:// or wss://; try again.`** before the report.
- **Network evidence:** `/tmp/room-review-r2-mcp-network.mjs`, with `/tmp/room-review-r2-doctor-preload.mjs`, stubs the arbitration listener and fetch (no actual socket or network connection), supplies a GitHub origin and configured fixture server, and invokes the same real MCP tool. Recorded URLs are **`https://fixture.invalid/auth/config`** followed by **`https://fixture.invalid/health`**. The former comes from startup auto-join. No host credential files or real tokens are used.
- **Fix:** Route setup checks before initialization of the ordinary runtime. Resolve the request's workspace without joining/listening, reuse an already initialized active session when available, and otherwise run the standalone doctor path. Test the actual MCP entry point with the setup check as its first request, failed runtime initialization, and fetch recording that permits only `/health`. Round-1 R2 is only partially resolved: already initialized runtimes correctly bypass join/settle/sync and reply side effects, but the first-call boundary still violates the contract.

## NIT

### S3 — The join skill's wake documentation link no longer has a target section

- **Location:** `plugins/room/skills/room-join/SKILL.md:63`.
- **Scenario:** The rewritten README removed `#claude-code`, but the join skill still sends agents there for wake troubleshooting. The wake instructions now live in the reference document.
- **Fix:** Update the link to `../../../../docs/reference.md#wake-paths`.

### S4 — The explicit-team destination explanation omits the remembered server

- **Location:** `docs/reference.md:9`; implementation `packages/room-mcp/src/config.ts:103`.
- **Scenario:** The reference says `room_join(where="team")` uses `ROOM_SERVER`, then `ROOM_URL`, then the hosted default. With neither environment variable set, code first uses a remembered non-local server. This matters when explaining why a self-hosted clone returns to its earlier server. The join skill already describes this correctly.
- **Fix:** Include the remembered server before the hosted default in that sentence.

## Round-1 verification

| Finding | Result |
|---|---|
| R1: crash releases cache under an orphaned check | **Original reproduction resolved.** The new crash integration test passes: the second preview uses a fresh tree, cap-zero eviction leaves the orphan's cached tree intact, and the cache becomes reusable after the check exits. S1 covers the separate remaining normal-completion gap. |
| R2: doctor goes through auto-join/sync | **Partially resolved.** The failing/in-progress join and never-synced handler tests pass, and the runtime wrapper bypasses settling/rebinding. S2 reproduces the remaining outer initialization path. |
| R3: arbitrary hook hashes accepted | **Resolved.** Known frozen hashes pass; a well-formed different hash produces WARN; absent hashes produce FAIL. The fixture pins the frozen hook file's byte hash. Read the lead's Codex 0.158 hash implementation snapshot. |
| R4: health redirects followed | **Resolved.** The probe passes `redirect: 'manual'`; the injected 302 test confirms one fetch and a redirect WARN. No live HTTP listener was used. |
| R5: legacy `.lock.lock` accumulation | **Resolved.** Migration excludes sidecars and requires real directories before owner checks. The repeated-migration test preserves persistent sidecars without generating `.lock.lock`. |
| R6: wake-off ignored for Codex | **Resolved.** The mode check now precedes host routing. An independent injected-queue probe returned `undefined` with zero queue calls for Codex; the both-hosts regression also passes. |
| R7: manual cache removal fails on Git lock | **Resolved.** Ran the documented unlock, single-force removal, and prune against a real idle preview entry; removal succeeded. |
| R8: doctor checks original checkout | **Resolved for active sessions.** The handler uses the active directory and effective local/team server plus token; the never-synced selected-checkout regression verifies the call and no daemon touch. |
| R9: nonexistent join `tag` argument | **Resolved.** README now documents `ROOM_TAG`, matching the public tool. |

## Validation and remaining coverage

- `npm run typecheck`: passed. `nice -n 10` was attempted; the sandbox refused the priority change, and typechecking still succeeded. Heavy jobs were staggered and Vitest used one worker.
- Doctor/cache/routing targeted run: **9 files, 68 tests passed** (`doctor`, `release-readiness`, `tool-budget`, `preview-lru`, `preview-cache-config`, `preview-cache-races`, `preview-cache-slots`, `preview-run-cache`, `preview-cache-crash`). Invoked from `packages/room-mcp` with `--config ../../vitest.config.ts --root ../..` so the repository's isolation setup ran. An earlier package-directory invocation without that explicit root configuration was interrupted after no completed file result; it is not counted as a pass.
- Additional collection/spawn/consent/timing/wake run: **4 files passed; the socket-wake file had 17 passing and 2 sandbox-blocked tests**. Total for this run: **184 passed, 2 failed**. Both failures are `listen EPERM` in the socket-listening tests (`Claude: writes auth then user JSON lines to the inbox socket`, and `falls back when a previously bound inbox refuses connections`); the lead must run these outside the sandbox. The new `ROOM_WAKE=off` regression passed. Across both completed runs: **14 files, 252 passing tests, 2 socket-listening failures**.
- `npx --no-install knip --no-progress`: passed. `git diff --check`: clean.
- Frozen hook-definition diffs against `7c34cb7` are empty. Tool names/descriptions/schemas total **9,482 / 9,500 characters**; the routing budget test passes. The eval tool mock exactly matches DEFS projected to name/annotations/description/inputSchema.
- `sh -n plugins/room/bin/room-doctor`: passed. A scratch wrapper installed beneath a path containing spaces preserved `doctor --dir "/tmp/checkout with spaces"` as separate, correct arguments.
- Re-reviewed worker model/effort precedence and omission of override flags, host-default display probes, owner-name resolution/ambiguity, collection's batched Git-operation inspection and phase timing, sharing disclosure, skills/tool routing, task-based splitting and its eval fixtures, the changed server-version error, cache policy fingerprinting, LRU/held-entry behavior, and cap-zero behavior. No additional blocking findings from these paths.
- Read the README as a newcomer and followed its progression into onboarding: prerequisites, install, first-session success strings, diagnostics, team setup, workers, preview, and collection are discoverable. Read reference/upgrading/AGENTS and the 0.17 changelog against their corresponding code. The small documentation gaps found are S3/S4.
- Checked installed Codex/Claude plugin command help and the lead's dated host snapshots. Codex `marketplace upgrade`, Git refs, Claude marketplace update, and plugin update wording match the installed CLI. The instant-interrupt note relies on the lead's committed live-test evidence; this review did not rerun a model session.
- No plugin install/rebuild, model-backed eval, deploy, commit, or push. Only the review report is written in the worktree; probes and fixtures are under `/tmp`.
- `room_preview_merge(person="rohanz")`: no conflicts; no additional lead changes beyond the reviewed `930e839` base. No tests were run on the combined tree. Final Git status contains only this untracked report.

**Verdict: not ready to sign off — 2 MUST-FIX, 0 SHOULD-FIX, 2 NIT.**
