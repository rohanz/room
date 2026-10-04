# Werkzeug eight-worker rerun — 2026-10-04

The same eight task cards and source tree as the first 0.17.3 rehearsal, run with the locally validated resume fix. All eight tasks integrated successfully. No production changes, commits, pushes or upstream PRs.

## Controls

- Original base `d713386db3592391e2336227b7135b607dbeb3ef`; retry base `0d1d424333aecaaaaac91d215825696b9159ac67`. Their tree IDs match: `930015924131fb57263912a351ee1afc8df9686d`.
- Fresh checkout `/tmp/room-werkzeug-retry`; unchanged baseline: **984 passed**.
- One Codex lead, eight Codex Room workers; GPT-6.1 Sol, medium, one thread each, no helpers. All eight launched before waiting. Peak: lead plus eight workers.
- Workers and lead were instructed not to read upstream solutions, prior rehearsal output or the Room development checkout. The supervising conversation had researched upstream PR history, so it did not supply implementation advice.
- Frozen development plugin bundle SHA-256: `c6d1c95765f2a1550c508e91011bde701ddd65f4e116c888e1cf3ee7cdb0ebe4`. Installed 0.17.3 files and hook trust were unchanged.
- A process-local launcher selected that bundle and removed both host-ID environment variables from MCP processes, explicitly exercising hook-record binding. Two initial lead attempts failed before dispatch because the shell wrapper reset the inherited working directory to the plugin directory. An explicit lead `ROOM_DIR` corrected the harness. Those attempts are excluded from dispatch timing.

## Results and timing

UTC timestamps below are 2026-10-03 (Singapore date 2026-10-04).

| Milestone | Time / result |
|---|---|
| Eight initial launches | 16:46:36.501–16:46:45.766 |
| All initial runs complete | 16:54:28.767 — 7m 52s after first dispatch |
| Issue11 follow-up complete | 16:56:28.803 — same worker and thread, run 2 |
| Lead restart | Same retained lead conversation; completed workers preserved |
| Issue11 post-restart follow-up complete | 17:02:31.689 — same worker and thread, run 3 |
| Issue9 post-restart conflict handoff complete | 17:02:55.775 — same worker and thread, run 2 |
| Complete eight-worker preview | 17:03:11–17:03:25; **1,166 passed**, no conflicts or exclusions |
| First normal collection | 17:03:35–17:03:44; successful |
| Actual checkout validation complete | 17:04:07; **1,166 passed in 12.06s**, diff check clean |
| Worker cleanup complete | 17:04:53; all eight retired through Room |

All three deliberate completed-worker follow-ups succeeded without replacement workers. Registry reports and `thread.started` events agree on the original thread across every run. Issue11 added mounted HTTPS/query and explicit scheme-override tests; issue9 removed only its redundant parser/chunk-reader changes so issue10 owned the final supersets, preserving its independent changes and tests.

There are 22 changed or new files (19 tracked modifications and three new test files), uncommitted and unstaged. No live workers or open claims remain. Raw artifacts are under `/tmp/room-werkzeug-retry-run/`, including both lead transcripts, checkpoint, worker logs, registry snapshots, Room history, preview, collection and test evidence. Raw viewer capabilities are not published here.

## Remaining findings

These were the findings at this run's end. The later [reliability loop](2026-10-04-worker-reliability-loop.md) verifies fixes for finished-sibling previews and generated-environment cleanup on the same baseline.

- Sibling previews still exclude finished peers as `not-publisher` or lacking a manifest, even with offline inclusion. The lead's trusted local previews included all eight correctly. Partial worker previews were not counted as complete validation.
- Six initial conflict files were genuine overlapping changes. ETag workers synchronized agreed final regions; the parser conflict was resolved through issue9's retained-session follow-up. No peer files were manually copied by the lead.
- Test-cache, dependency and scheduling restrictions required foreground recovery. No task worker died or needed replacing.
- Normal collection retained ignored `.venv` directories. Room discard cleaned the already-collected worktrees after evidence capture, retaining recovery patches. Preview-cache retention remains separate from worker cleanup.

The 17m 31s dispatch-to-validation duration includes added edge-case follow-ups, a checkpoint and a planned lead restart. It is not directly comparable with the first run's approximately 12 minutes. Different generated test counts (1,166 versus 1,186) do not establish relative test quality. This rerun validates the observed resume fix; it does not establish a general success rate or resolve the sibling-preview issue.
