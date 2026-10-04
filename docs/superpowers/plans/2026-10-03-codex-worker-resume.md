# Codex worker resume: diagnosis and fix plan

Status: implemented and validated locally on 2026-10-04. The completed Werkzeug rehearsal used installed 0.17.3. This fix is not released or installed. See [validation evidence](../rehearsals/2026-10-04-codex-worker-resume.md).

## Observed failure

Eight Codex workers ran real issues. Integration required follow-ups to finished workers `issue6` and `issue9`. Room refused to resume them because no Codex session ID was recorded. Their code remained intact; the lead started replacements in the existing worktrees.

For `issue6`, both its JSON log (`thread.started`) and `.git/room/sessions/*/session.json` contain the same Codex thread ID. The session record also identifies the expected worker and checkout. Its worker registry record and admitted run report omit `hostSessionId`. The `issue9` registry and report also omit it. Thus a real host session exists but is not durably associated with the resumable worker. Raw evidence is local under `/tmp/room-0173-werkzeug-run/`; do not publish capability URLs or raw logs.

## Code path

- `worker-registry.ts: admitWorkerEnvironment` supplies only `CLAUDE_CODE_SESSION_ID ?? CODEX_THREAD_ID` to `registry.admit`.
- `session.ts: joinSession` calls admission before establishing/reusing the bound session; it does not pass `opts.sessionId` or the validated binding.
- `binding.ts: createSessionBinding` can discover a host session later from session records.
- `index.ts: rebindHost` rejoins with `sessionId: nextId`, but admission still ignores that value.
- Registry reconciliation can persist `report.hostSessionId`, but cannot recover an ID absent from the report. The resume gate correctly refuses an unknown host session.

Likely cause: the worker MCP environment lacks a usable host ID at admission, and late binding never updates the worker report. The observed durable records establish the missing propagation; confirm the startup environment path in a regression without dumping credentials or all environment variables.

## Proposed change

1. Accept a validated host binding when admitting a worker, retaining environment IDs as the existing supported path. Do not persist a synthetic `mcp:*` receipt ID as a resumable host session.
2. When the binding becomes available after initial admission, persist it for the matching worker/run before resumption can be attempted. Reuse the registry's nonce, checkout, operation-lease and run-number guards. Preserve completion reports and existing IDs; reject mismatched/stale runs rather than replacing another run's session.
3. Cover late binding/rebinding explicitly. Avoid depending solely on a best-effort shutdown hook, which may never run. Avoid broad log scans or trusting a session record merely because it is in the same Git common directory.
4. Consider run-scoped log recovery only as a separate, guarded fallback if binding is genuinely unavailable; do not make it the first fix when a validated binding already exists.

## Verification

- Regression: admit without host-ID environment variables, then discover a matching Codex session through the binding; registry/report gain its ID without losing `done` or other run facts.
- Negative cases: synthetic ID, wrong checkout/worker/nonce/run, stale hook record, and conflicting existing session ID cannot become resumable authority.
- Early-bound and Claude paths retain behavior; delayed admission during an operation lease is reconciled safely.
- Integration: start a fresh Codex Room worker, complete it, send a follow-up, verify the same worker/thread resumes and answers without creating a replacement. Repeat after restarting the lead to exercise persistence.
- Run affected registry/binding/lifecycle tests, then full tests and plugin build before release.

## Separate findings to investigate

Sibling previews sometimes report completed workers as `not-publisher`, while the lead can preview the trusted local worktrees. Do not conflate this availability problem with resume IDs without evidence. Genuine merge conflicts were also observed and collection correctly refused them without writing; those are not automatically Room bugs.
