# Vitest suite audit summary (2026-10-18, read-only)

Full run: 571 s wall, 355 files, 4089 tests: 4085 passed, 1 failed (flaky), 3 skipped (Windows-gated, run by Windows CI).
Flake: packages/room-mcp/test/tools.test.ts:1163 spies on ConflictSet.prototype.reconcile, so other instances' periodic reconciles are counted (got 6, expected 0). Fix: spy on the session's own instance.

Headline: the suite is not full of useless tests. ~60 confidently redundant tests (~600-700 lines, 1.2% of 56k), 6 mock-only wiring tests, 2 dead pins of removed wording (tools.test.ts:630/638 "Wake-ups"), ~110 unnecessary node hook spawns (hook-port.test.ts:36 it.each + hooks.test.ts:371/385/396), ~10-15 s fixed sleeps.

Wall time is set by one file: collect.test.ts (1919 lines, 153 tests, 570 s) runs alone from ~520 s to the end. Split it (borrowers :976-1265, copy :1471-1660, worker-preview :1666-1877), then worker-refresh.test.ts (437 s) and workers.test.ts (367 s). Expected 571 s -> 400-450 s. Tag ~10 scale tests (graph-responsiveness 79 s, preview-scale, preview-run-cache, manifest-preview S1, bridge F5, rejoin-responsiveness) behind an opt-in for a sub-5-minute default.

High-confidence prune rows (file:line): tools.test.ts:630,638,1949-2001,1404,1761,517; workers.test.ts:294,698,991,1219,1138,1521-1526; carry-wip.test.ts:355; collect.test.ts:797,1235,1081,119,144,227; worker-refresh.test.ts:420; resume.test.ts:560; hooks.test.ts:92,396,385(12->2),310,1045; wake-turn.test.ts:165,385,510; socket-wake.test.ts:28; conflict-set.test.ts:74,96,139,242; conflicts.test.ts:98(identical case),211; codex-app-server.test.ts:54-88 (8 real-UDS dupes, keep :44,:66); names.test.ts:111; misc-regressions.test.ts (delete file); join.test.ts:225,216; open-confirm.test.ts:127+136 -> it.each.

Contract tests: keep tool-budget, release-version, eval-mocks, ledger/worker-modules characterization. skills.test.ts: keep :8 and :21, collapse the other 9 prose/version-stamp pins into one table-driven test.

Not prunable yet: 0.16->0.17 migration tests (~650 lines / 45 s) until 0.16 support is formally dropped.

Misleading titles: workers.test.ts:343,991,655; worker-refresh.test.ts:420; retirement.test.ts:188; conflicts.test.ts:211.

Raw data: results.json, timing.txt, timing2.txt, neardup.txt, sleeps.txt, worker-titles.txt in this directory. Full report text is in the session transcript (agent hand-back, 2026-10-18 ~15:40 local).
