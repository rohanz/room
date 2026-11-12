# Retiring the local daemon cutover gate

2026-11-12; evidence below refers to baseline c694b2acce, before deletion.

The gate has no current ownership guarantee to preserve. Its sole additional protection is refusing to start a daemon while a pre-daemon session could still own a relay or unsaved replica. The owner confirms no such clients exist and old-client interoperation is unnecessary.

- `packages/room-mcp/src/daemon-cutover.ts:129` inventories linked worktrees; `:133` reads relay discovery and the authority lock; `:184` inventories session/MCP records; `:209` inventories workers. `:244` exempts clients while an authenticated daemon already owns the clone; `:245` blocks legacy/unknown client evidence. `:287` runs this check and `:294` writes only a drain fingerprint. It neither acquires authority nor saves room documents. `:372` is the operator attestation path.
- `packages/room-mcp/src/session.ts:993` invokes the inventory before joining, and `:1003` supplies it as the launch callback. `doctor.ts:219`, `tools/scope.ts:137` and `index.ts:373` supply diagnostics or operator resolution only. `local-state-gc.ts:62` keeps the two cutover JSON files indefinitely. None supplies current ownership.
- `packages/relay/src/daemon.ts:96` takes `AuthorityLock` before listening (`:160`), loading leases (`:167`) or publishing discovery (`:171`). A losing contender returns without a listener. Startup authenticates an existing listener, checks clone/PID/readiness (`:290`), and refuses live or unknown discovery birth identity (`:313`). These checks remain.
- `packages/relay/src/hub.ts:24` exclusively creates the authority lock and recovers only a dead holder. `packages/relay/src/leases.ts:99` publishes an exclusive file by hard link; `:210` serializes recovery under a guard and requires the same recorded owner to be dead. Liveness (`:18`) checks birth time and executable and confirms possible PID reuse. Lock release (`:200`) checks the nonce under a guard. Live/unknown owners cannot be replaced. These protections are independent of worker records and cutover drain files.

Existing 0.17.47/0.17.48 daemon discovery, snapshots, incarnation, leases and worker records remain readable. Old drain and resolution files become inert and age out after seven days; neither requires a manual operator step.

## Worker reader audit

A known preparation failure uses `worker-file-store.ts:1237` `abandonPreparation`, which rolls back owned preparation and sets phase `abandoned`; it supplies no child identity. `worker-status.ts:97` returns abandoned before probing a process. A recorded `launch.outcome: never` also has no child. `worker-status.ts:111` returns failed for a never-launched run before any liveness probe. `worker-file-store.ts:463` capacity counts only starting/running/unknown/ambiguous statuses. `worker-status.ts:160` maps failed to failed for tool views, while `:164` grants a signal PID only to a launched run with a full identity. These readers do not treat known failed preparations as running clients. Tool views map abandoned to dismissed; retention treats abandoned as ended. No worker lifecycle change is needed for this root cause.

An interrupted preparation with no launch outcome is distinct: `worker-status.ts:113` reports starting while its launcher may live, or ambiguous after launcher death. It conservatively consumes capacity because a crash could have interrupted persistence after launch. `worker-file-store.ts:925` retention prunes only ended records and preserves a retained checkout or a borrower. These are worker lifecycle/file-preservation decisions, not daemon ownership checks, and remain unchanged.

## Removed auxiliary state

The cutover-only `admittedWorker` cache and arbitration worker/host publication callback are removed with the gate, as is the `daemon-client` marker. Worker admission still persists the verified host process and session binding in the registry. Hook endpoint negotiation, process identity, privacy and binding publication remain intact. The rehearsal script was the root package's only SDK import, so its redundant devDependency is removed; the MCP workspace retains its own SDK dependency.

## Separate startup finding

On native macOS outside the sandbox, the original end-to-end regression repeatedly reached `packages/relay/src/daemon.ts:286` with an authenticated successor PID and the predecessor PID read from discovery. The successor can listen before it publishes discovery; the launcher checks PID mismatch before readiness and fails that join. This logic predates the removal (baseline `daemon.ts:295`). One failed-preparation case passed before this race occurred; subsequent unfenced same-port attempts hit it. This is not worker liveness or the cutover gate, so the authority mechanism is unchanged. The final cutover regression occupies the predecessor port with an unrelated HTTP listener after its verified idle exit, forcing the existing ephemeral-port fallback and isolating cutover behavior. It still uses real daemon processes, idle timeout, registry, join and spawn; only the worker host is synthetic. The same-port startup race remains a follow-up, not a passing guarantee.

## Changed expectations and validation

- Local-state GC now removes both obsolete cutover files after seven days instead of retaining the drain file forever. All other retention expectations stay intact.
- Room-move refusal still prevents websocket sync and returns to the original room, but now expects the retained launcher's runtime diagnostic rather than cutover inventory text. Its fixture supplies a matching authenticated PID to reach that check.
- Hook endpoint publication no longer expects a daemon-client marker; hook contract and private-directory assertions stay intact. The cutover-only worker/host endpoint-publication test is deleted.
- The worker-registry admission test no longer checks the removed in-memory cutover cache; discovered session ID, host mismatch refusal and exact admission-call count remain.
- The relay private-root test writes a neutral client-fixture filename instead of a drain record; idempotent root privacy assertions stay intact. The Windows lifetime test retains actual daemon launch/ACL verification and drops only the cutover-preflight permutation.
- Remaining ensureLocalDaemon call-site edits only remove the obsolete no-op admission callback. Cutover-module tests, resolve-CLI test, cutover-only local-naming/doctor tests and the old cutover inspection case in the 0.16 doctor suite are deleted with their behavior.

Typecheck and knip pass. Affected MCP files: 10 passed, 198 tests passed (including both real-daemon regression variants); affected relay files: 3 passed, 37 tests passed, one Windows-only test skipped on macOS. Native runs used process inspection and loopback access after the sandbox failed with sysctl Operation not permitted / cannot establish daemon process birth identity in daemon-restart-workers and room-move-real. Those sandbox failures occurred before sockets or the new assertions.

Combined preview with rohanz+refs-prune rev 8 and rohanz+pins-pg rev 10 merged cleanly: typecheck, knip and local-state-GC/hook-endpoint checks passed (11 tests). The lead owns plugin bundling and full ordinary/scale release checks. Room refused every addressed coordination question/note with message-store-full (roughly 1.6 MiB owed to others); narrow claims communicated boundaries and the combined preview verified them.

A later preview included reviewer rohanz+rev-pins (rev 1, inherited pins-pg changes, no new product edits) as well as the original owners. It passed knip and six GC tests, but reported a docs/upgrading.md conflict between the duplicate pins overlays. Its suggested ordered-superset resolution reintroduced the retired cutover section, so it was rejected and not copied. The direct cutover+refs-prune+pins-pg preview is clean. Integrate the original owners, preserving the cutover deletion and pins-pg's new upgrade intro; the reviewer has no additional product delta to collect.
