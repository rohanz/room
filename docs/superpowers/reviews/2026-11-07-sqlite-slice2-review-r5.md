# SQLite slice 2 — Codex gpt-6-astra review, round 5

Reviewer: Codex gpt-6-astra (high effort, read-only). Scope: `4ae61b7b..750cfbeb` against round 4. Codex's session was read-only, so the lead recorded its returned text here.

**Verdict: DO NOT MERGE.** The count is 1 MUST-FIX, 0 SHOULD-FIX, 0 NIT.

I did not write `docs/superpowers/reviews/2026-11-07-sqlite-slice2-review-r5.md`. Codex's session was read-only on the filesystem, and I did not write it myself because the task said to forward only. The review text is below. The requested focused Vitest run could not start (Vite's temporary config write was denied with `EPERM`), so no tests ran.

| Round-4 finding | Status |
|---|---|
| MUST-FIX: retained helper ticket loses its release closure and leaks the outstanding count | The original leak is fixed: `files.ts:794` hands the closure to the poller. One new safety issue remains (below). |
| SHOULD-FIX: crash test bypasses production helper admission | Fixed by inspection. The fixture uses production admission and sends GO afterward. The helper-PID assertion at `storage-admission.test.ts:406–407` would fail if the ticket carried the MCP identity. |

**MUST-FIX — unknown group liveness can release admission prematurely.**
- **Where:** `packages/room-mcp/src/tools/files.ts:807–808` uses `processGroupAlive` to decide when retained tickets can be released. `packages/room-mcp/src/preview-cache.ts:65` returns `false` when both the process-table read and the signal probe fail, including on `EPERM`.
- **Failure scenario:** A cleanup-incomplete preview still has surviving group members, `ps` becomes unavailable, and the signal probe is permission-denied. The poller releases the ticket and decrements the outstanding count. The MCP can then unregister despite unresolved effects.
- **Rule violated:** the unknown-liveness retention requirement, and the whole-operation/unknown-holder barrier in the spec at `docs/superpowers/specs/2026-11-05-sqlite-state.md:146–152`.
- **Evidence:** Codex ran the extracted production function body with an injected table failure and `EPERM`, and it returned `false`. That verifies the error classification, not a native OS reproduction.
- **Fix:** only definitive absence should permit release. Retain or throw on other probe failures, and add a regression test for this case.

**Accounting audit.** Codex found no further leak or double-decrement in the paths it inspected.
- Admission increments before the RPC and rolls back on refusal.
- Detached reservations guard completion.
- Helper release sets its once flag before awaiting finish.
- If an operator `resolveDead`s the ticket first, the poller cannot double-decrement. External resolution does not touch the private count, and `gate.finish` tolerates an absent ticket.

**Regression test.** `preview-cleanup-deadline.test.ts:189` would fail without the closure handoff, because the retained ticket would not disappear at line 203. It also checks unregister after release. Its liveness seam bypasses the real probe, though, and it switches survivors off before waiting a polling cycle. So it does not cover retention across failed probes or operator-first resolution.

**Poller lifetime.** The poller's timers are unreferenced and its checks are serialized, so idle polling does not keep the MCP alive. The `ps` subprocess is referenced while its bounded probe runs, so "polling never extends process lifetime" is not fully established.

## Resolution (lead)

`6ccbd50a`: `signalProbeAlive` in `packages/room-mcp/src/preview-cache.ts` treats only `ESRCH` as proof of absence; `EPERM` and every other failure read as alive, for both `processAlive` and `processGroupAlive`. `process-group-alive.test.ts` covers an unreadable process table with an `EPERM` probe. Re-reviewed in round 6.
