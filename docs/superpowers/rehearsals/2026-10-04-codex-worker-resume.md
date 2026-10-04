# Codex worker resume validation — 2026-10-04

Local implementation on top of 0.17.3; not released or installed. Dates in this note use Singapore time.

## Change

Worker admission accepts the host session discovered by the existing binding resolver. Worker hook records must match the host, worker ID and checkout. The existing record watcher now announces a first binding discovered after startup, triggering admission through the normal rejoin path. Completion also rereads the binding without its one-second cache before writing `room_done`.

The registry rejects synthetic or conflicting session IDs, retains the existing nonce/run/checkout and writer checks, and persists the actual report ID. Late admission preserves completion facts. An operation lease may defer the worker-record update; reconciliation copies the durable report ID once the operation ends.

## Automated checks

- Full suite outside the sandbox: **3,466 tests, 320 files passed**, 391.85 seconds.
- Final focused suite after the completion-read refinement: **64 tests, four files passed**. Covers late discovery, completion preservation, operation-lease deferral, registry restart, conflicting/synthetic IDs, wrong nonce/run/checkout, and worker/host/checkout binding isolation.
- Typecheck, full plugin build (including web), and `git diff --check` passed. Frozen hook manifests unchanged.

## Live smoke

A disposable local repository and direct Room tool harness launched a Codex worker (GPT-6.1 Sol, medium). A process-local CLI override directed its Room MCP to the development bundle; installed plugin files and trusted hooks were unchanged. Wrapper load markers confirmed the development server ran. No production server was used.

The fresh worker completed, then `room_send` resumed its retained conversation. Both runs used the same worker ID and Codex thread ID. Its second completion recalled the phrase from the initial prompt. After closing the lead and starting a new lead process, another `room_send` resumed that same thread for run three and recalled the phrase again. In the final restart run, the test launcher explicitly removed both `CODEX_THREAD_ID` and `CLAUDE_CODE_SESSION_ID` before starting the MCP, exercising hook-record admission. Earlier development-bundle runs used a CLI environment override for the absent Codex ID.

The first harness attempt used the installed bundle and an invalid message type; it is excluded from fresh development-bundle evidence. Its retained worker was subsequently resumed and removed through Room. The final three-run worker was also discarded through Room after evidence capture. Both records are retired; no smoke-test workers remain running.

Raw evidence remains local under `/tmp/room-resume-smoke/`; test/build logs are `/tmp/room-resume-{full-tests,targeted,typecheck,build}.log`. Raw Room logs and tool replies can contain local viewer capabilities and are not committed.

This is a focused correctness check, not a measured general resume success rate. It does not repair records from already-collected or discarded workers. The Werkzeug sibling-preview and dependency-transfer findings remain separate investigations.
