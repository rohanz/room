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

## Sleep trims (real timers; from the full audit)
| file:line | wait | recommendation |
|---|---|---|
| room-mcp/test/publisher-join.test.ts:74 | setTimeout 4_000, waitFors to 15 s, 90 s timeout | daemon poll is 3 s: 3.2 s suffices, or inject the interval |
| room-mcp/test/workers.test.ts:852 (slice 3 file) | setTimeout 2000 before exit | poll is 250 ms; 600 ms suffices |
| room-mcp/test/hooks.test.ts:212 (settle 250 ms x8) + raw 250/250/200 ms at :466/:515/:668 | ~2.7 s | reuse hook-fixes.test.ts:52 settle(...needles) which polls state.json |
| room-mcp/test/wake-turn.test.ts (17 real 80-140 ms negative waits) | ~1.6 s | :97/:118 already use fake timers; convert the rest |
| room-mcp/test/wakes-audit.test.ts:298 (100 ms x5), :396 (250 ms) | ~0.75 s | fake timers |
| room-mcp/test/runtime-presence.test.ts:57,68,72,95 (700 ms x4) | 2.8 s | negative asserts; 300 ms with the watcher debounce injected |
| server/test/archive-export.test.ts:159,238 (3200 x2), credentials.test.ts:103 (2100), pending-admission.test.ts:50 (1100) | 9.6 s | real server TTLs; make injectable or accept |
| room-mcp/test/compaction-rejoin.test.ts:127, roomd/test/ignored-tree.test.ts:109 (1000 each), solo-quiet.test.ts:65 (500) | 2.5 s | negative waits; halve |
| room-mcp/test/hook-port.test.ts:36 (80 it.each rows, one node before-edit.mjs spawn each) + :121-162 (~30) and hooks.test.ts:371/385/396 (26 spawns) | ~110 spawns | drive the classifier in-process via pathsOf from common.mjs (hooks.test.ts:320/402 already do); keep <=5 end-to-end spawns |
False positives: conflict-set.test.ts:655 (70 s) and hooks.test.ts:694 (1 s) run under vi.useFakeTimers().

## Consolidations (same behaviour; keep the stronger test)
| file:line | merge into | note |
|---|---|---|
| tools.test.ts:209 | tools.test.ts:184 | add two waitConsumesMessage calls |
| tools.test.ts:1263 | tools.test.ts:1132 | add conflicts.length===1 |
| tools.test.ts:1227 | tools.test.ts:1304 | add "notified Kieran's agent" + length===2 |
| tools.test.ts:1013 | tools.test.ts:1024 | add the room_scope reply wording |
| tools.test.ts:1219-1224 (claim half of :1210) | tools.test.ts:1678 | fuller claim-refusal message there |
| tools.test.ts:2004 | tools.test.ts:1296 | add languageLoadAttemptsForTest('python')===0 asserts |
| tools.test.ts:611-614 | tools.test.ts:1627/:1653 | exit-1 -> room_done-negative half |
| hooks.test.ts:440 | wakes-audit.test.ts:381 | same live-MCP + before-edit flow |
| worker-refresh.test.ts:342,:362,:383,:460 (slice 3 file) | keep all, refactor | use expectKeptRefreshRefused (~:150) instead of hand-copied snapshot blocks |
| carry-cleanliness.test.ts:102 | carry-wip.test.ts:258 | same failing branch -D fake; VERIFY the 4th positional cleanupWorker flag does not select another branch |
| conflicts.test.ts:394 | combined-kept-preview.test.ts permutations | probable duplicate; confirm fixture includes a post-keep sibling edit of a delivered line |
| hooks.test.ts:371 (x6) | keep, spawn the hook once | regex matcher is pure; "announces once" already shown at :744 |

## Incidental-text pins worth loosening (not deleting)
collect.test.ts:313 (gitPathCalls shape; slice 3), carry-wip.test.ts:337 (verbatim prompt paragraph: keep "Carried paths:" list and the ask-the-lead clause), wake-turn.test.ts:489/:564 (internal log wording: assert outcome + call count), collect.test.ts:1395 sleep cadence (slice 3), hooks.test.ts:1038 (AGENT_INSTRUCTIONS phrase), console.log profiling output in conflict-set.test.ts:696/746/751/772 and tools.test.ts:1206 (drop or gate).
