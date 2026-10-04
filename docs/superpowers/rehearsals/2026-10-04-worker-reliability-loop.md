# Worker reliability loop — 2026-10-04

Follow-up to the [resume rerun](2026-10-04-werkzeug-resume-rerun.md), using the fixes and acceptance criteria in the [reliability plan](../plans/2026-10-04-worker-reliability-loop.md). These are local development rehearsals, not a released version or a statistical success-rate estimate.

Historical record: the local/unreleased status below describes each rehearsal at the time. Subsequent Flask findings, the final candidate and publication/deployment status are tracked in the [0.17.4 release record](2026-10-04-0174-release.md). The Werkzeug/HTTPX results here apply to their recorded candidate, not the later Flask fixes.

## First candidate

The frozen MCP bundle SHA-256 is `78c743c5483b3e3d4137a300f11190a37d6b27f5efd3e477ab884973cf733e0c`. Room's full suite passed **3,508 tests across 321 files**; typecheck and the full plugin build passed. Two Codex Astra reviewers checked the lifecycle/cache and cleanup/resume changes, including follow-up reviews. Their blocking findings were fixed before freezing the candidate.

Every live batch uses one Codex lead and eight Codex Room workers, GPT-6.1 Sol at medium effort, with one thread per worker and no replacement workers or helper agents. Host-ID environment variables are removed from worker MCP processes to exercise hook-record binding. Installed plugins and trusted hook content are unchanged. Leads and workers use history-free checkouts and task cards, without reading upstream solutions or previous runs. Temporary `caffeinate -i` wrappers prevent machine suspension during execution.

## Werkzeug: clean

The fresh checkout is `/tmp/room-werkzeug-clean-r1`; raw evidence is `/tmp/room-werkzeug-clean-r1-run`. Baseline tree `930015924131fb57263912a351ee1afc8df9686d` matches the preceding two rehearsals. Baseline: **984 passed**.

- All eight original workers finished and exited cleanly. Genuine overlapping parser, ETag and changelog edits were resolved through the original workers using Room messages, reads and previews.
- Before restart, a resumed worker read changed files from two finished siblings and previewed all seven siblings with `includeOffline=true`. All seven supplied shared publications; no missing-manifest, not-publisher or updating exclusions remained.
- The controller verified that the relay process had exited. Its saved snapshot contained eight completed publications, eight revision markers and zero live manifest heads, in 3,263,234 bytes.
- After the cold restart, issue11's third run used its original worker ID and Codex thread. It read finished issues5/9 and previewed all seven siblings through shared publications, with **158 routing tests passing**. Astra independently checked the saved tool results; this did not rely on the lead's trusted-local-worktree preview shortcut.
- The lead's complete all-eight preview passed **1,128 tests** without conflicts. The first normal no-tag `room_collect` collected every worker and automatically removed all eight owned worktrees, including generated `.venv` directories. No forced discard was used.
- The integrated checkout passed **1,128 tests in 11.91 seconds** and `git diff --check`. Source changes remain uncommitted and unstaged. Astra reviewed the integrated changes against all eight cards and found no blocking unmet requirement or regression.

Development-time test failures caught a wrong empty-header expectation, an accidental import edit and a new query-encoding expectation; workers corrected these and reran tests. The lead's first checkout test command could not open the existing uv cache inside its sandbox; the authorized retry passed. These are recorded interventions, not omitted failures. No Room acceptance failure remained.

All times are UTC on 2026-10-04. The eight workers launched at 02:05:58–02:06:07; all initial runs finished by 02:13:27. Extra follow-ups and the planned checkpoint continued until the lead restarted at 02:23:15. The full preview finished at 02:25:58, normal collection at 02:26:42 and checkout validation at 02:27:43. That is about 21m 45s from first dispatch to final validation, including deliberate follow-ups, restart and evidence capture; it is not directly comparable with a single uninterrupted implementation batch.

The earlier run's finished-sibling preview and generated-environment cleanup findings are resolved by this candidate in the tested workflow. Preview-cache worktrees are separate from owned worker worktrees and retain their existing cache lifecycle. Different generated test counts across runs do not establish relative test quality.

## HTTPX: first candidate clean

This batch used `/tmp/room-httpx-clean-r1` and `/tmp/room-httpx-clean-r1-run`, with the same frozen candidate. It contains three historical issue cards plus five complementary implementation, integration-test and documentation tasks. It is not eight historical upstream issues.

Baseline tree `13b65805db11935d4e401d0eb12f9fa4c9121489`: **822 passed, one existing Python-version skip**, using Python 3.11 and Click 8.1.3 for compatibility with this historical checkout's warning-as-error tests. That environment pin applies consistently to previews and checkout validation; no source assertion is suppressed.

All eight original workers exited cleanly. The retained URL API worker read two finished siblings and previewed all seven, including after a cold lead/relay restart. Its three runs used the original Codex thread. The saved cold snapshot contained eight completed publications, eight revision markers and zero live heads, in 368,434 bytes.

The pre-restart full preview passed **1,056 tests, one skipped**. Additional post-restart cases brought the complete preview and collected checkout to **1,065 passed, one skipped**. Normal no-tag collection succeeded and removed all eight worker worktrees without forced discard. Diff check passed; source is uncommitted and unstaged. Astra reviewed the integrated runtime, docs and five new regression modules against the task cards and found no blocking issue.

The full preview caught an existing fixture using invalid port `123456` to provoke a transport error. The original port worker resumed to use an OS-assigned valid loopback port, closed immediately before the request, retaining the `ConnectError` assertion. Holding a bound socket open instead produced `ConnectTimeout` on macOS. The final fixture has a small possible port-reassignment race; review treated this as a nonblocking test-flake limitation. Other early partial previews and a corrected new client-merging expectation remain recorded in raw evidence rather than counted as complete validation.

## Additional preview fix and final-candidate reruns

After both first-candidate runs passed, the supervising installed Room session's preview exposed a separate `git merge-file` failure when its inherited process working directory had disappeared. An isolated-child regression reproduced the exact error. Git now runs from the merge helper's existing private temporary directory. Two Astra reviewers accepted the one-line runtime change, its regression and scope; 12 merge tests and typecheck passed. The origin of the deleted inherited directory was not established, and installed sessions were not restarted or modified.

Final candidate MCP bundle SHA-256: `207437b0f923885048b11f1f74b8a5c86a00466a9aab8a132da49c2a913be642`. Fresh history-free reruns completed at `/tmp/room-werkzeug-clean-r2` and `/tmp/room-httpx-clean-r2` with identical baseline trees and corresponding `-run` evidence directories. Final full-suite confirmation passed 3,509 tests across 321 files in 387.82 seconds; final live results follow below.

Validation before final acceptance also caught an outdated skill wording assertion, which now checks lead-only resume in both worker and etiquette skills. A concurrent full run then passed 3,508 tests but exceeded the global 20-second watchdog in the 2,050-file publication stress case. The unchanged case passed alone in 1.60 seconds and its whole 14-test file passed in 4.30 seconds. Review found no failed behavior assertion; only that multi-scan test now has a local 60-second timeout, retaining all 2,050 files and all privacy/deletion assertions. These test-only changes do not change the frozen runtime hash. The subsequent full confirmation ran without a competing live batch and passed all 3,509 tests.

### Final-candidate Werkzeug

All eight original workers completed. The first resumed issue11 run read two finished siblings and previewed all seven, passing 161 routing tests; the lead's all-eight relevant preview passed 750 tests. A genuine cold snapshot contained eight completed publications, eight revision markers, zero live heads and 3,655,476 bytes.

After restart, the same worker's third run again read the two siblings and included every shared publication, but introduced two new assertions expecting query `/` to be encoded as `%2F`. The full preview recorded **1,177 passed, two failed**. The lead preserved this evidence and stopped before collection. Controller continuation resumed the same lead and original worker for run4. Review of this checkout's existing `_urlencode` safe set confirmed `/` is preserved; only the mistaken new expectations changed, retaining every case and all other assertions. No runtime encoding changed, worker was replaced, or peer source was copied manually.

The fourth run's complete shared-sibling preview and lead's full all-eight preview each passed **1,179 tests**. All four worker runs used the same original thread, including across the additional lead restart. A fresh Astra reviewer independently verified the two shared reads, seven full offline publications and absence of text omissions. Normal no-tag collection removed all eight worktrees automatically, including seven generated `.venv` directories. The actual collected checkout passed **1,179 tests**, with a clean diff check and zero open claims. Source remains uncommitted and unstaged. After lead exit, the saved snapshot had zero completed publications and eight retained revision markers (170,269 bytes), independently confirming retirement removed cached file payloads. The fresh Astra source/test review found no concrete unmet card requirement or regression. The full Room confirmation and final HTTPX rerun also passed.

### Final-candidate HTTPX

All eight original workers completed their first runs. Retained follow-ups removed generated lockfiles and corrected the old invalid-port fixture while preserving its transport-error checks. The selected URL API worker's second run read two finished siblings and previewed all seven; that complete shared preview and the lead's all-eight preview each passed **987 tests, one existing skip**, with no exclusions or source conflicts.

Before phase2, the controller verified that the relay was gone and its saved state contained eight completed publications, eight revision markers and zero live heads, in 363,966 bytes. After restart, the original URL API worker's third run retained the same Codex thread, read two finished siblings and previewed all seven complete shared publications with no omissions or exclusions. It added eight chained query/fragment regression cases. Its shared preview, the lead's all-eight preview and the actual collected checkout each passed **995 tests, one existing skip**. The existing skip covers netrc behavior on Python 3.11; the Click compatibility pin remained unchanged.

One normal no-tag collection removed all eight original worktrees automatically, with no replacement workers or forced discard. All 12 worker runs ended cleanly. Diff check passed; source remains uncommitted and unstaged. After the lead exited successfully, the saved snapshot contained zero completed publications, eight revision markers and zero live heads (126,809 bytes), confirming retirement removed cached file payloads. A fresh Astra reviewer independently checked runtime, documentation, regression tests, original-thread identity, sibling reads, complete previews and cleanup evidence; no concrete unmet card requirement or regression remained. The lead completed at 03:46:11 UTC.

## Final acceptance

| Validation | Result |
| --- | --- |
| Room full suite | 3,509 passed across 321 files |
| Final Werkzeug collected checkout | 1,179 passed |
| Final HTTPX collected checkout | 995 passed, one existing skip |
| Typecheck and full plugin build | Passed |
| Independent Codex Astra reviews | No remaining blocking findings in reviewed scope |
| Both eight-worker cold-restart rehearsals | Original-thread resume, complete shared previews and normal cleanup passed |

The final frozen candidate satisfies this loop's acceptance criteria. These checks establish the tested behavior, not a claim that all possible bugs are absent. The changes and rebuilt plugin assets remain local, uncommitted and unreleased; installed plugins and production were not changed. Raw evidence remains in the corresponding local `/tmp/room-*-clean-r2-run` directories and full-suite log `/tmp/room-worker-fixes-full-tests-final-green.log`.

Raw local logs can contain viewer capabilities and are not copied into this document.
