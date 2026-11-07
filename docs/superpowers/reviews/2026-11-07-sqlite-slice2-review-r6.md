# SQLite slice 2 — Codex gpt-6-astra review, round 6

Reviewer: Codex gpt-6-astra (high effort, read-only). Scope: through `b87f5884`, focusing on `6ccbd50a` and the plugin rebuild. The lead recorded the returned text here.

Verdict: DO NOT MERGE

**R5 finding: fixed at root.** `preview-cache.ts:55` treats only `ESRCH` as proof of absence, and both liveness functions use it. The rebuilt bundle includes the fix. A separate retained-helper lifetime defect remains (below).

## MUST-FIX

**An escaped descendant loses its storage barrier when the original process group disappears.**
Location: `packages/room-mcp/src/tools/files.ts:807`.

Failure scenario:
1. A preview launches a detached descendant that keeps its output pipe and working directory. `packages/room-mcp/test/preview-cleanup-deadline.test.ts:66` already builds this case.
2. The original process group exits. Cleanup overruns its grace period, retains the helper ticket and quarantines the tree (`tools/files.ts:725`, `:794`, `:1403`).
3. `releaseWhenGroupGone` sees the original group absent and calls `release()` at line 808, although the escaped descendant is still running.
4. That releases the ticket and decrements the outstanding count (`storage-admission.ts:293`, `:168`). Once other work finishes, the sweep can unregister the MCP. Gate progress looks at tickets and registration evidence, not preview quarantine (`packages/local-state/src/gate.ts:401`), so a drain can complete while the descendant keeps running.

The quarantine protects later reuse of the tree, but it does not keep storage admission held. This comes from reading the code; Codex did not reproduce it at runtime.

Rule violated: the M2 whole-operation barrier (`docs/superpowers/specs/2026-11-05-sqlite-state.md:146`) and the requirement that surviving preview children and unknown cwd or process evidence block conversion (`:167`).

Suggested fix: keep admission until the whole incomplete helper lifetime is resolved, escaped descendants included, or keep explicit recovery evidence that blocks the drain. Add a regression test that extends the escaped-descendant fixture and asserts the drain stays incomplete while the original MCP is alive, until safe completion or reconciliation.

## Audit results

- **Caller safety:**
  - `processAlive` has no production callers in `packages/room-mcp/src`.
  - `processGroupAlive` feeds only `previewGroupAlive` (`tools/files.ts:683`).
  - Foreground cleanup stays bounded by the grace timer.
  - Retained polling uses unreferenced timers and bounded process-table reads.
  - Unknown liveness keeps admission held without making the foreground wait unbounded.
- **Release condition:** the poller now releases only when the original group is definitively absent. That fixes the r5 probe-error case but is not enough for the escaped-descendant case above.
- **Admission accounting:**
  - `admitTracked` increments before admission and rolls the count back on rejection.
  - Completion decrements in `finally`.
  - The detached and helper release closures prevent a second completion.
  - The sweep and close paths consult outstanding counts (`storage-admission.ts:136`, `:182`).
  - Codex found no further leak or double decrement.
- **Validation:** both focused vitest attempts failed before running any test, because the read-only sandbox denied temporary-file creation. No tests passed in this review and no full suite ran.

Codex reviewed through `b87f5884`, focusing on `6ccbd50a` and the plugin rebuild. The r5 report file was not available, so Codex worked from the description you gave. It edited no files, made no commits and called no Room tools.

## Resolution (lead)

The retained helper ticket is now released only when the original process group is definitively gone **and** no process has its working directory inside the preview tree the attempt worked in (`releaseWhenHelperGone` in `packages/room-mcp/src/tools/files.ts`). The tree evidence is the same fail-closed probe the quarantine already used, now shared as `previewTreeInUse` in `preview-cache.ts`: an unreadable or partial process listing counts as in use. Each attempt records its tree and start time once the tree is chosen (cached slot or temporary tree), so setup git commands in the tree and the check both carry it. A descendant that leaves both its group and the tree is beyond this evidence, as it is for the quarantine; that limit is documented at both functions.

Regression: `preview-cleanup-deadline.test.ts` "keeps a cleanup-incomplete helper ticket while an escaped descendant works in the preview tree after its group is gone" reports every original group as gone, spawns a detached descendant in the cached tree, waits several release polls and asserts the helper ticket is still listed, then kills the descendant and asserts release and unregistration. It fails without the fix (`expected 0 to be greater than 0`) and passes with it.
