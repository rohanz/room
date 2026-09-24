# Audit of 0.16.1, by Codex (gpt-6-astra, medium), 2026-09-25

Reviewed main at 7de5b1b. The lead session verified finding 1 in the code (tools/workers.ts dismissWorker calls terminateWorktreeProcesses(w.dir) with no worktree-ownership check) before the fix batch. Finding 0 was supplied by the lead.

Reviewed `9d0e06f..7de5b1b`. **10 findings: 6 fix before the trial, 2 tidy, 2 leave.** Finding 0 is supplied; seven findings have in-memory reproductions, two are inferred. Known roadmap gaps are excluded.

No files were edited, no commits made, and no plugin build run. Final working tree is clean. Verification limitations are recorded below.

## Fix before the trial

### 0. Medium — Human and agent names are indistinguishable

**Location:** `packages/shared/src/identity.ts:28`.

**Problem:** As supplied: the first joiner’s agent now displays as bare `rohanz`, exactly like the human.

**Consequence:** Readers cannot reliably attribute instructions and decisions to the human versus their agent.

**Smallest clean change:** Retain a visible agent marker consistently in message and participant rendering, without changing routing identifiers.

**Inferred — supplied finding; not re-derived.**

### 1. High — Stop and leave kill processes without establishing worktree ownership

**Locations:** `packages/room-mcp/src/tools/workers.ts:130`, `:257`; `packages/room-mcp/src/tools/collect.ts:27`.

**Problem:** `dismissWorker` invokes `terminateWorktreeProcesses(w.dir)` before checking the worker PID’s ownership, without collect’s separate-worktree, common-directory or branch guards. An explicitly supplied spawn directory can be the lead checkout or another existing checkout.

**Consequence:** Stop, forced leave or shutdown can terminate unrelated editors, servers and other agents beneath that directory—even while reporting that the worker itself is not ours to signal.

**Smallest clean change:** Share one worktree-ownership check across lifecycle paths. Allow directory-wide cleanup only for verified Room worktrees; explicit existing directories should receive only independently verified worker-process termination.

**Reproduced:** Ran the actual dismissal and cwd-selection code with mocked signals, `w.dir === s.dir`, no owned handle and a rejected worker PID. It still selected and signalled the unrelated process.

### 2. High — Retirement sweeps delete a newer session’s shared work

**Locations:** `packages/shared/src/doc.ts:121`, `:149`; `packages/room-mcp/src/tools/context.ts:252`.

**Problem:** An archived worker name protects a later standalone participant only while that name appears in awareness. After disconnection, with no current worker record, `sweepRetiredWorkers` attributes the newer overlays and scope to the old retirement.

**Consequence:** A participant reusing a name such as `lead+codex` loses their published edits, claims, scope and base when they disconnect. Disk files remain, but teammates lose the coordination state precisely when offline work should remain visible.

**Smallest clean change:** Require matching generation evidence before sweeping. Conservatively leave state alone when an archive exists but no corresponding current worker record establishes ownership.

**Reproduced:** Using the actual `RoomDoc`, newer `new.ts` work survived an online sweep, then disappeared when the same name was absent from the supplied presence set.

### 3. High — Equal checkout paths can hide different teammates

**Locations:** `packages/room-mcp/src/company.ts:14`, `:30`; `packages/room-mcp/src/tools/claims.ts:30`; `packages/roomd/src/index.ts:259`.

**Problem:** The new same-checkout filters compare `watchedDirectory`, which hashes only the absolute path. Two machines with a checkout at the same path therefore count as one physical checkout.

**Consequence:** On the hosted server, a real teammate can disappear from company and overlap checks. `room_claim` can say nobody else is near a file despite that teammate’s scope or claim.

**Smallest clean change:** Include a machine-local identity in the checkout identifier. Separately, suppress duplicate publication without suppressing distinct live sessions’ explicit claims and scopes.

**Reproduced:** Two fresh, differently named awareness participants with equal checkout identifiers produced `{ company: false, others: [] }`. The cross-machine collision follows directly from the path-only hash.

### 4. Medium — Cancelled waits consume answers that are never returned

**Locations:** `packages/room-mcp/src/tools/messaging.ts:184`, `:195`, `:224`; `packages/room-mcp/src/tools/index.ts:88`.

**Problem:** Cancellation reaches the tool wrapper, but `room_wait` does not subscribe to it. Its wake-suppression predicate and bus observer remain active. A subsequent answer ends that abandoned wait and is marked seen; the wrapper then substitutes “tool call cancelled” for the answer.

**Consequence:** A teammate answers, but the asker receives neither a wake nor an unread inbox entry. Explicitly waiting again for the same question can recover it, but normal delivery is lost.

**Smallest clean change:** Expose the request signal to waits. On abort, immediately remove observers, timers and suppression predicates without marking any message received.

**Reproduced:** Started the real wait under `withToolSignal`, aborted it, then posted an answer. Wake suppression remained true and the answer became seen.

### 5. Medium — Process-enumeration failure prevents stopping an owned worker

**Locations:** `packages/room-mcp/src/workers.ts:654`; `packages/room-mcp/src/tools/workers.ts:262`; `packages/room-mcp/src/tools/context.ts:407`.

**Problem:** A failing or timed-out `lsof` throws before dismissal reaches the owned process handle. Shutdown catches that failure and continues.

**Consequence:** A stop can fail to stop the worker at all, leaving it editing or consuming resources after the lead exits.

**Smallest clean change:** Treat cwd enumeration as separately fallible cleanup. Report its failure, then still attempt termination through a verified spawn handle. Do not fall back to broad process-group signals.

**Reproduced:** Injected an enumeration failure into the actual dismissal path with an owned handle available. The handle’s kill function was never called.

## Tidy

### 6. Low — Build-output consolidation regresses disposable-cache cleanup

**Locations:** `packages/shared/src/build-output.ts:2`; `packages/room-mcp/src/workers.ts:30`; `packages/room-mcp/test/collect.test.ts:124`.

**Problem:** Replacing the old dependency/cache set drops entries including `.mypy_cache` and `.ruff_cache`. They now count as unrecoverable artifacts. The new test deliberately covers retaining `.venv`, but does not distinguish that policy choice from the dropped cache exemptions.

**Consequence:** Ordinary Python checks can again retain collected worktrees and provoke unnecessary forced-discard steps.

**Smallest clean change:** Restore the previously disposable cache entries in the shared policy, while keeping any deliberate virtual-environment retention decision explicit. Test a real cache separately from valuable ignored output.

**Reproduced:** The actual artifact classifier retained `.mypy_cache/` while discarding `dist/`.

### 7. Low — New test fixtures leave directories, timers and a child process behind

**Locations:** `packages/roomd/test/base-branch.test.ts:17`, `:34`; `packages/room-mcp/test/archive-signal.test.ts:43`, `:53`, `:73`.

**Problem:** Base-branch tests stop daemons but never remove their temporary repositories. Archive tests leave losing timeout promises armed; the inherited-stderr fixture starts `sleep 30` without retaining or terminating it.

**Consequence:** Repeated runs accumulate repositories and leave unnecessary process/timer activity around tests intended to diagnose hangs.

**Smallest clean change:** Track and remove fixture roots, clear deadline timers in `finally`, and explicitly terminate and reap the fixture descendant.

**Inferred:** Traced setup and cleanup; these suites could not execute in this sandbox.

## Leave

### 8. Medium — Automatic-name crash recovery still has an unlink race

**Locations:** `packages/room-mcp/src/session.ts:292`; `packages/room-mcp/src/choice.ts:80`.

**Problem:** Two processes can read the same dead lock owner. One replaces the stale lock successfully; the other then unlinks that new live reservation using its earlier observation. The subsequent exclusive create can succeed for both contenders in sequence.

**Consequence:** Concurrent recovery after a crash can defeat the new name reservation or writer lock, allowing duplicate identities or overlapping choice writes.

**Smallest clean change:** Serialize stale-lock recovery with a separate exclusive recovery guard, then re-read the owner before removal. A reread without serialization still leaves a race.

**Inferred.** Leave after the trial because it requires concurrent crash recovery; fresh-lock acquisition uses exclusive creation correctly.

### 9. Medium — Worker ports are unique only within one lead’s running-worker list

**Locations:** `packages/room-mcp/src/tools/workers.ts:164`, `:252`; `packages/room-mcp/src/workers.ts:111`.

**Problem:** Port allocation excludes the spawning worker’s own port and other leads’ workers. A nested worker can receive its parent’s `4400`.

**Consequence:** Nested batches or multiple local leads can still collide, despite the prompt promising each worker its own port.

**Smallest clean change:** Include the parent and other local live-worker reservations; use a machine-local reservation if uniqueness is promised across processes.

**Reproduced:** A parent recorded on port `4400` saw an empty allocation set when spawning its first child, which also received `4400`.

Leave for this three-user trial if each user runs on a separate machine without nested server-running workers.

## Verification

- **Requested `npm run typecheck`: blocked.** `tsc -b` attempted forbidden `dist` and `.tsbuildinfo` writes, followed by missing-output diagnostics.
- **Supplemental compiler check: passed.** Checked each of the seven package configurations through the TypeScript API with emission, incremental state and project-reference output redirection disabled: zero diagnostics.
- **Focused Vitest: 19 files attempted, zero tests executed.** Both invocations used all six requested environment removals. Every suite failed during temporary SSR-cache creation with `EPERM`.
  - Room MCP: lifecycle-cleanup, collect, combined-tree-lead-only, graph-index-events, auto-tag, wakes-audit, carry-wip, tools, workers, archive-signal, bundle-update, config, prs, skills.
  - Roomd: base-branch, skip-log.
  - Shared: retired-worker, messages, base-message.
- Socket integrations were not executed: notably `auto-join.test.ts`, socket delivery in `tools.test.ts`, and server/relay integrations. The attempted suites failed before reaching any socket operation.
- In-memory probes transpiled repository source without writing files. Process signals and external failures were mocked. Six additional shared wake/addressing assertions passed.
- Host conclusions used the dated snapshots only. The September 25 MCP snapshot confirms the default two-minute backgrounding threshold introduced in Claude Code **2.1.212**; Room’s 100-second wait cap is below it. No network or live-host validation was performed.