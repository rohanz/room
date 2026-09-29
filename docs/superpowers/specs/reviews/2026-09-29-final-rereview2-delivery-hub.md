# Final fix-round re-review 2 — delivery + hub — 2026-09-29

**Range:** `git diff 0a5003d 0b64667`; checkout at `0b64667b6b4d696fb6c3aaecf2eb3482c53fd92f`.

**Counts: 1 RESOLVED / 0 PARTIAL / 0 NOT RESOLVED; 0 new must-fix / 1 new should-fix.**

Scope: round-1 delivery/hub S2's remaining projector receipt-retention paths, `454296a`, the delivery-module un-exports, and changed hub test expectations. Applied ledger invariants 1/5/6 and reference retention, registry §8/§13, and hub fencing against the supplied redesign specs and round-1 reports. The five confirmed human rulings are accepted. Source files were not changed; this report is the only retained output. No commit or push.

| Assigned item | Disposition | Fix and proving evidence |
|---|---|---|
| Round-1 S2 remaining — prune independently of acceptance, on reference deletion, with worker ownership and the projector fence | **RESOLVED** | `454296a`, `packages/room-mcp/src/worker-projector.ts:38–49`, keeps receipt creation behind matching resume acceptance but moves pruning outside that branch. Pruning requires an ended status and current worker-name ownership; its callback rechecks the captured lead fence and ownership inside `RoomDoc.pruneSeen` (`packages/shared/src/doc.ts:472`). The four checked-in **“S2: … prunes an older receipt after a later resume is rejected”** cases (`test/resume.test.ts:176`) cover an explicit pass and automatic bus/mail/outcome deletions; **“S2: a lapsed projector fence leaves an orphaned older receipt intact”** (`:234`) covers refusal without authority. The existing matching-Claude-evidence test still rejects startup/another-session evidence and accepts the matching assistant. Disposable probes additionally pass for a running resumed worker, replacement worker ownership, a fence lost immediately before pruning, cleanup after reacquisition, and atomic reference transfers. The observers at `worker-projector.ts:123–139` schedule after the Yjs transaction: real `trim` moving a receipted note from bus to mail preserves it; mail→outcome and outcome→bus transfers also preserve it; deleting the final reference prunes it. No premature deletion was reproduced. The observer queue amplification is recorded separately as new N1 below. |

**Knip un-exports: no behavior change found.** In `ledger.ts`, `REPLY_LEASE_MS` and `noticeId` retain their exact values/bodies and callers. In `inbox-budget.ts`, `inboxOrder` retains its exact ranking expression and sort caller. `SelectReply` in `arbitration.ts` and `PostLease` in `post.ts` are unchanged type declarations with only `export` removed. Repository-wide TypeScript searches found no external consumers of those five removed exports. Delivery, cursor, posting and inbox-budget regression tests cover the runtime paths; no transport/arbitration implementation changed. This confirmation is not an additional assigned finding in the count.

## New must-fix

None established in the assigned area and range. Receipt pruning does not modify bus/mail/outcomes, so it does not itself retrigger these observers; the final-reference probe settled without a self-sustaining loop. No data loss, duplicate delivery, leak or hang was established from the new observers.

## New should-fix

### N1 — Reference-deletion bursts queue an unbounded number of redundant full projection passes

**Owner area:** delivery / worker projector. **Locations:** `packages/room-mcp/src/worker-projector.ts:124`, `:127`, `:154–159`. Introduced by `454296a`'s three new observation paths feeding the existing non-coalescing promise chain.

Every bus deletion event, mail deletion event and outcome deletion event calls `project()`. A single transaction touching all three queues three passes. `project()` serializes them but does not merge pending requests: each appends another full `projectWorkers` call. While a pass awaits a completion post, deletion events from unrelated room traffic can therefore accumulate indefinitely. When it resumes, every queued pass rereads the whole projectable worker set, receipt references and relevant run/report/log facts even though they all see the same settled document. A busy bounded bus continues generating deletions as posts arrive, so this adds filesystem/CPU work and delays projection of subsequent worker changes.

**Disposable reproduction:** used the real `WorkerProjector`, real Y.Doc and temporary on-disk WorkerRegistry with one retained done worker. Held the first pass at `registry.postCompletion` with a deferred promise. While it waited, issued 100 transactions each deleting an existing bus item, mail entry and outcome. Released the promise and drained with one explicit `project()` call. A spy on the real `registry.projectable` observed **302 full passes: 1 initial + 300 event requests + 1 explicit drain**, rather than one reconciliation of the accumulated changes. Stopping the projector detached the observers; no further pass ran on a subsequent deletion. The probe asserts the observed amplification, not desired behavior. No wall-clock hang or infinite feedback loop is claimed, hence should-fix.

**Fix direction:** coalesce level-triggered requests with an in-flight pass and a dirty flag, allowing at most one pending follow-up that reads current state. Preserve the public promise's drain semantics and check the fence anew on every actual pass. Add a blocked-pass burst regression that asserts bounded pass count while still pruning the final orphan.

## Test-expectation audit

All changed delivery/hub test hunks in this range were inspected. **No existing behavioral assertion was removed or relaxed.**

| Changed test file | Judgment |
|---|---|
| `packages/room-mcp/test/resume.test.ts` | **Spec-correct additions.** Four parameterized S2 cases and the lapsed-fence case retain the existing strict acceptance assertions. The mail/outcome cases require the earlier receipt to survive another retained reference; automatic cases wait for final deletion without explicitly projecting afterward. Explicit drain calls occur before the final triggering deletion and do not replace that assertion. The fence test checks both explicit and queued paths. They omit live-worker/name-replacement and event-burst assertions; disposable probes cover those boundaries and expose N1. |
| `packages/relay/test/hub.test.ts` | **Spec-correct teardown change; no expectation change.** Child processes are continued/killed and awaited before their common directory is removed. Existing hub takeover/epoch assertions remain intact. Socket-backed execution was not used as evidence in this review. |
| `packages/server/test/hub.test.ts` | **Spec-correct harness change; no expectation change.** The server runs in the directly spawned Node process through `--import tsx`, and SIGKILL is awaited before restart and final teardown. Incarnation monotonicity, persistence and read-only assertions are unchanged. |
| `packages/server/test/server.test.ts` and `memory-server.test.ts` | **Spec-correct harness changes; no expectation weakening.** Both use the same direct-process helper and await teardown before removing persistence. The production fake-issuer test still requires exit code 1 and the same error text. In-memory migration/websocket assertions remain unchanged. |
| `packages/server/test/dev-server.ts` | New shared fixture, no assertions to weaken. Tracks every started child, awaits exit, escalates a normal stop to SIGKILL after one second, and handles already-exited children. This is a test-process lifecycle change, not a production hub behavior change. |

**Verification:** **75 checked-in tests passed**, plus **four disposable probe tests passed**. The checked-in selection covered `resume`, `worker-projector`, `ledger-characterization`, `ledger-cursor`, `delivery-fixes`, shared `delivery`, and `post`. Of 76 selected cases, the sole failure was `post`'s real relay-socket test: `listen EPERM` on `127.0.0.1`, the documented sandbox limitation, not a finding. All five new S2 cases passed. The four probes exercised production projector/registry/document code with the existing simulated host-launch fixture; the burst probe deferred one completion call to make queued work measurable. No live Claude/Codex host or external network operation was used.

Vitest ran with one worker, file parallelism disabled, the repository's environment-isolating setup, and explicit package-export aliases into this worktree so dependencies did not resolve to the lead's checkout. `nice -n 10` was attempted; the sandbox denied `setpriority`. Heavy jobs were serialized. No full build, typecheck or bundle regeneration was performed for this report-only review.

**Finish:** disposable probes, configuration and logs were removed; `git diff --check` passed and final status contains only this report. `room_preview_merge(people=["rohanz"])` found no conflicts against common ancestor `0b64667b6b`. The lead's rebuilt server bundle was previewed for compatibility only; this review remains pinned to the requested source range. No combined-code test was needed for the report-only contribution.
