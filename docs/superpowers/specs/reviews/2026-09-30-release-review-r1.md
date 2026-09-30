# Release-readiness review, round 1 — 2026-09-30

Reviewed `7c34cb7..21ff82e`, including every release brief and the added defaults/task-splitting contracts. Report only; no source, test, plugin, or other documentation edits. No earlier release-review round exists.

**Findings: 2 MUST-FIX, 6 SHOULD-FIX, 1 NIT. Not ready to sign off.**

## MUST-FIX

### R1 — A crashed MCP releases the shared cache while its check still uses it

- **Location:** `packages/room-mcp/src/preview-cache.ts:28-44`; `packages/room-mcp/src/tools/files.ts:966-975,1001-1005`.
- **Scenario:** Kill the MCP during `room_preview_merge(run=...)`. The lock-helper's stdin closes and releases the OS lock, but the independently launched check process survives. Another MCP can reset and reuse the same shared worktree while the first check is still reading or writing it. Eviction can also acquire that lock and remove the tree under the surviving check.
- **Reproduction:** `node --import tsx /tmp/room-review-r1-probes.mts`. The first preview applies `FIRST` to `app.txt` and starts a checker gated on a file outside the cache. After its MCP receives SIGKILL, the second preview applies `SECOND` and opens the gate. Observed `first check uses shared cache: true`, second preview `cached base`, and **`orphaned first check read: SECOND`**. This reproduced repeatedly on macOS; no sockets or host credentials were involved.
- **Fix:** Tie the lock lifetime to all processes using the cached tree, including the check and checkout commands, rather than solely to the MCP's pipe. A supervisor that holds the lock while running/reaping the command is one option. Add an integration test killing the parent during an active check and proving a subsequent preview cannot change or evict its tree.

### R2 — The diagnostic tool still goes through auto-join and normal sync gating

- **Location:** `packages/room-mcp/src/tools/index.ts:117-144`; `packages/room-mcp/src/index.ts:159-166`.
- **Scenario:** The new special case skips only repository preflight. `room_state({check:true})` still invokes `autoJoin.ensure()`, while the MCP wrapper first waits for `autoJoin.settle()`. A broken configured server can therefore delay the diagnostic behind the normal 120-second join deadline and cause admission/sync network traffic beyond `/health`. An existing never-synced session can return `error: room not synced yet, retry` before the doctor runs. This defeats the diagnostic when setup is actually broken.
- **Reproduction:** The scratch probe attaches an auto-join stub whose `ensure()` throws `AUTO_JOIN_TOUCHED`, then calls `room_state({check:true})`; that exception is reached instead of the doctor. The current doctor test supplies no auto-join, so it misses the production path. The sync gate is directly visible at `tools/index.ts:143`.
- **Fix:** Dispatch the diagnostic before auto-join, rebinding/settling, ordinary sync checks, and room-reply side effects. Keep its independent bounded probes available without a joined/synced room. Test with an in-progress join, a failing join, and a never-synced session.

## SHOULD-FIX

### R3 — Doctor reports obsolete hook hashes as trusted

- **Location:** `packages/room-mcp/src/doctor.ts:39-43,62`.
- **Scenario:** A user has previously trusted Room, but the stored hash no longer matches the hook definition Codex will execute. Doctor checks only whether both keys contain any syntactically valid SHA-256 string, so it reports `PASS ... Room hooks trusted` even though Codex requires renewed trust. A matching script version stamp does not establish trust in the hook definitions.
- **Reproduction:** `/tmp/room-review-r1-probes.mts` supplies both expected TOML sections with `sha256:` followed by 64 zeroes; `codexRoomHooksTrusted` returns `true`. The existing test likewise accepts arbitrary `a...` and `b...` hashes without comparing them to the marketplace hooks.
- **Fix:** Verify the stored values against the active host hook definitions using the host's actual hash/trust rules or a supported host status surface. If trust cannot be established, report WARN/unknown rather than PASS. Test an old but well-formed hash as well as an absent hash.

### R4 — The `/health` probe can follow redirects outside its allowed destination

- **Location:** `packages/room-mcp/src/doctor.ts:96-97`.
- **Scenario:** The configured server or a proxy responds to `/health` with a redirect. Fetch follows redirects by default, so doctor can request another path or another server despite the explicit `/health`-only network contract. A redirected login page returning 200 also becomes a misleading healthy-server PASS.
- **Evidence:** The scratch doctor probe records `https://fixture.invalid/health` with `redirect: (fetch default: follow)`. This is a request-options/static-code reproduction; a live redirect server was not started in this socket-restricted sandbox.
- **Fix:** Set `redirect: 'error'` or handle redirects manually without following them, then report a useful WARN. Test a 302 without making the redirected request.

### R5 — Legacy migration treats persistent Linux lock files as more legacy slots

- **Location:** `packages/room-mcp/src/tools/files.ts:855-863`; `packages/room-mcp/src/preview-cache.ts:23-29`.
- **Scenario:** Linux `flock` leaves its lock file behind after a dead legacy slot is removed. The next migration accepts `<pid>-<start>.lock` through `slotOwner`, creates `.lock.lock`, and tries to remove the ordinary lock file as a worktree. Each later pass creates another suffix and warning. Migration runs on cached preview setup, so this accumulates files and unnecessary probes indefinitely.
- **Reproduction:** `node --import tsx /tmp/room-review-r1-migration.mts`. On macOS this selects the Linux branch with a small `flock` shim implemented by `lockf -k`, preserving Linux's persistent-lock-file behavior. After three real migration passes, the directory contains `.lock`, `.lock.lock`, and `.lock.lock.lock`, with “registration is foreign; manual inspection required” warnings. This is a Linux-semantics simulation, not a native Linux run.
- **Fix:** Before PID/liveness/claim probing, require each legacy candidate to be a real directory and exclude sidecar files. Preserve stable lock files as needed, but never scan them as cache entries. Add repeated-migration coverage with persistent locks.

### R6 — The advertised wake-off switch does not turn off Codex wakes

- **Location:** `README.md:54`; `docs/reference.md:49`; implementation at `packages/room-mcp/src/wake-path.ts:109-113`.
- **Scenario:** A Codex user follows the new defaults table and sets `ROOM_WAKE=off` to stop process wakes. The Codex branch invokes the queue before checking the mode, so that choice has no effect.
- **Reproduction:** The scratch probe constructs `createWakeSender({env:{ROOM_WAKE:'off'}, queue: ...})` and targets Codex; it returns `queue` and calls the injected queue once. This confirms an existing behavior newly misdocumented by this batch.
- **Fix:** Either honor `off` before branching by host, or clearly scope this switch to Claude in the table/reference and state the actual Codex control/limitation. Keep the user-facing default and its override consistent.

### R7 — The documented manual cache cleanup command fails on every normal cache entry

- **Location:** `docs/reference.md:57`; `packages/room-mcp/src/tools/files.ts:782-789`.
- **Scenario:** A user stops Room and follows `git worktree remove --force <entry>`. Cached worktrees retain their Git worktree lock; stopping Room releases the OS use-lock but does not remove that Git lock. A single `--force` cannot remove them.
- **Reproduction:** `/tmp/room-review-r1-migration.mts` creates a normal preview entry and runs the documented removal command. Git fails with `cannot remove a locked working tree, lock reason: room preview cache` and advises `remove -f -f` or unlocking first.
- **Fix:** After the existing stop-sessions instruction, document `git worktree unlock <entry>` followed by `git worktree remove --force <entry>` (or the correctly explained double-force command), then prune.

### R8 — Doctor checks the original cwd instead of the currently selected checkout

- **Location:** `packages/room-mcp/src/tools/scope.ts:106`; `packages/room-mcp/src/doctor.ts:124`.
- **Scenario:** `room_join(dir=...)` switches to a different checkout, but the setup check always uses `ctx.cwd`. It can diagnose the wrong repository and resolve the wrong remembered server, while ordinary `room_state` describes the newly selected room. Session-specific configuration is also discarded by resolving only directory/environment again.
- **Reproduction:** The scratch probe calls the scope handler with a valid committed repository as the current session's `dir`, but an invalid original `ctx.cwd`. Doctor reports **`FAIL repository: not a Git checkout with a commit`**. All host commands are stubbed and fetch is injected.
- **Fix:** Prefer the active session's directory and effective destination/configuration, with the context cwd/config as the no-session fallback. Test diagnosis after moving to another checkout and after an argument-selected destination overrides the environment.

## NIT

### R9 — The defaults table advertises a nonexistent join argument

- **Location:** `README.md:57`; `packages/room-mcp/src/tools/join.ts:35-36,155`.
- **Scenario:** “Pass `tag` when joining” does not work through the public tool: `room_join` advertises no `tag` property and does not forward `a.tag` into configuration resolution.
- **Fix:** Document the supported `ROOM_TAG` launch setting only, or intentionally add and test a tool-level override in a later code change.

## Validation and coverage

- `npm run typecheck`: passed. Attempting `nice -n 10` printed a sandbox priority warning; the command still ran successfully. Test concurrency was capped at one or two workers.
- Targeted room-mcp run: **8 files, 62 tests passed** (`doctor`, `release-readiness`, `tool-budget`, `preview-lru`, `preview-cache-config`, `preview-cache-races`, `preview-cache-slots`, `preview-run-cache`). This run was launched from the package directory.
- Collection/spawn/consent/timing validation: **4 files, 167 tests passed**, launched from the package directory with the root Vitest config/setup explicitly selected (`--config ../../vitest.config.ts --root ../..`, `--maxWorkers=1`). Combined completed targeted runs: **12 files, 229 tests passed**.
- Both frozen hook-definition diffs are empty. Tool names/descriptions/schemas total **9,466 characters**, under the 9,500 cap; required routing phrases remain. `evals/mocks/room/_tools.json` exactly matches current DEFS when projected to name/annotations/description/inputSchema.
- Reviewed model/effort precedence and no-override launch flags, owner fallback and ambiguity, the collect Git-operation probe change, first-team disclosure and state sharing text, CLI wrapper quoting (`sh -n` passed), changed skill guidance, and the new same-file/negative/interrupt eval cases. Task splitting explicitly permits shared files and retains sequencing for the same lines/dependencies.
- Read the lead's dated host snapshots and checked installed CLI help. `codex plugin marketplace upgrade` matches the actual CLI despite the older brief saying `update`. The instant-interrupt decision has explicit lead live-test evidence in the committed finding/commit message; this review did not rerun a model session.
- The lead clarified by Room answer that reading Room's own credential store for login presence is allowed; host credential files and printing token values are forbidden. No host credential files were read by the probes, and no token values were printed. The CLI diagnostic probe uses fake host executables/config roots and injected fetch.
- No network-dependent `claude plugin eval`, plugin installation, plugin rebuild, commit, or push was performed. A broad initial test invocation including `join.test.ts` was interrupted without a completed result; socket-dependent join behavior needs the lead's environment. No live redirect-server test was attempted.
- Newcomer read: the install/first-session/success/failure progression is clear. The actionable documentation failures found are R6, R7, and R9; the table otherwise states the requested core defaults and how to change them.
- `room_preview_merge(person="rohanz")`: no conflicts. The lead has three additional live changes (worker tool text, eval tool mock, bundled server) beyond reviewed HEAD; no combined-code tests were run. Final Git status contains only this untracked report; `git diff --check` is clean.

**Verdict: not ready to sign off — 2 MUST-FIX, 6 SHOULD-FIX, 1 NIT.**
