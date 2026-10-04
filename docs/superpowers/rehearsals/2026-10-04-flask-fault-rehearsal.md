# Flask worker fault rehearsal — 2026-10-04

Status: complete — fixed-candidate rehearsal passed; independent Astra review accepted.

This is eight complementary regression tasks against Flask 3.1.2, not eight historical upstream bug claims. The history-free baseline comes from pallets/flask commit `2c1b30d0503cfb064f1cb252e6614a06915a362a`. Workers use Codex GPT-6.1 Sol at medium effort, one math thread each, with one Codex lead. No replacement workers or upstream solution reads.

The copied development plugin is frozen at SHA256 `207437b0f923885048b11f1f74b8a5c86a00466a9aab8a132da49c2a913be642`. Concurrent release preparation changes only its embedded version to 0.17.4; this rehearsal retains the earlier frozen bundle. Raw evidence is in `/tmp/room-flask-fault-r1-run`; source is `/tmp/room-flask-fault-r1`.

Baseline command, from canonical checkout cwd with relative test paths:

`uv run --isolated --python 3.11 --no-default-groups --group tests pytest -q -p no:cacheprovider`

Baseline: **488 passed, 2 skipped**. An earlier invocation using absolute /tmp test paths produced a macOS /private/tmp path-comparison failure; rerunning the unchanged source with relative test paths fixed that setup issue. No assertions were changed. Existing uv.lock pins dependencies.

Acceptance checkpoints:

- Interrupt an active original worker after partial edits and preserve those edits and its host thread.
- End and resume the lead with gated workers active; document whether shutdown stops them and resume original identities if so.
- Collect completed workers while other original workers are genuinely active, preserving their worktrees and edits.
- An independent sibling reads a synthetic canary before the publisher narrows sharing, then is denied afterward and following reconnect. This is current-policy restart evidence, not an unperformed stale-replica replay claim.
- Resolve overlapping shared-module tests without dropping either worker’s coverage.
- Observe a deliberately wrong assertion in an actual combined Room preview; have the same original worker correct it, then rerun the complete preview and actual checkout suite.
- Normal collection removes all eight owned worktrees; no forced cleanup hides a failure.

Independent Astra review evaluates the evidence and resulting changes before acceptance.

## First candidate: restart privacy failure (release blocker)

Phase 1 ran 04:19:59–04:31:48 UTC. Three original workers were gated and active when the lead ended; five had finished. A seven-visible-worker preview passed 505 tests with the two existing skips; privacy's seven config tests were intentionally unavailable while sharing intent. The active redirect worker received a priority interrupt and preserved its initial 1,384 test-file bytes exactly while extending the tests. This is message-driven replanning, not an injected OS process kill.

Controller OS evidence after lead exit showed privacy and observer still alive under parent PID 1; redirect had exited with SIGTERM while waiting. Phase 2 resumed the same lead and original redirect thread. The lead's own sandbox `ps` attempts were denied; authoritative targeted process snapshots were collected externally in `evidence/controller-process-monitor.jsonl`.

**At 04:33:57 UTC, the observer's actual post-reconnect Room read returned the synthetic canary again, and its peer preview exposed two paths.** The earlier intent setting therefore did not satisfy restart privacy acceptance. Reasserting intent afterward is a recovery action, not a passing result. Original logs, policies, registry, sessions and publisher evidence were preserved in `evidence/privacy-reconnect-failure-1791088469752`; earlier checkpoint artifacts retain pre-restart evidence. Root implementation/review agents traced this to launch-time full sharing overriding the saved intent policy on rejoin. The fix preserves the current canonical policy through reconnect and treats launch sharing only as the initial seed. This first candidate could not be released as clean.

### Diagnostic completion of the failed candidate

The original lead continued a third diagnostic phase without changing the frozen bundle. The deliberate bad missing-route assertion appeared in an actual combined preview, then the same original client worker restored the expected 404 and the preview passed. Partial no-tag collection integrated and removed five completed workers while preserving the three genuinely live gated workers; external OS monitoring and worker-reported before/after hashes confirmed that their partial work survived.

After gate release, the final combined preview and actual checkout suite both passed **512 tests, with 2 existing skips**. Seven files were integrated, including all independent error/lifecycle tests after a genuine shared-file conflict was resolved. A separate accidental invocation adding a literal `.` to pytest collected example projects and failed; the documented baseline command with no positional path passed. No assertions were weakened.

All eight original workers were retired through ordinary collection. Five worktrees were removed; three were conservatively retained because their launcher processes had died and their eventual exits could not be witnessed as exit zero. An ordinary no-tag retry found no remaining changes. This is not evidence of a generated-environment cleanup bug: the records contain unknown exit status, and no status was fabricated or forced cleanup used. The fresh rerun gives each remaining original worker a substantive follow-up launched by the final lead so its final exit can be witnessed before collection.

The first candidate remains **failed** because of the demonstrated sharing reset. The raw final lead report supersedes its earlier diagnostic checkpoint; historical raw logs and checkpoint snapshots remain preserved. The subsequent fresh fixed-candidate rerun is recorded below.

After diagnostic collection and lead exit, the saved relay snapshot contained zero completed-publication payloads, eight revision markers and zero live heads (101,699 bytes). Retained worktrees were disk safety artifacts, not retained shared publication payloads.

## Fixed-candidate rerun protocol

The fresh history-free `/tmp/room-flask-fault-r2` baseline again passes 488 tests with two existing skips. It uses a copied 0.17.4 candidate with MCP SHA256 `38e31d28f9caddf302fb4c0044729f2b7e55c660cce396e1ddc418647776a141`. No prior worker solutions are supplied.

To distinguish automatic reconnect from new-process resume, a non-agent MCP test fixture owns the relay before the lead joins. At the privacy gate, the controller verifies its exact process identity and terminates only that fixture; the original privacy host and MCP must remain alive while a new relay takes over. A sibling must then read the canary as unavailable without any sharing-setting override. The privacy worker next finishes under intent and retains its unchanged synthetic canary. Following lead restart, the same privacy worker/thread resumes in a new host process; another unavailable sibling read must precede any sharing setter. Both checks are required.

The lead restarts while observer/redirect workers are active. Original-thread follow-ups launched by the final lead provide witnessed final exit codes for automatic cleanup. This preserves eight original identities while respecting the conservative retention of unknown-exit runs. The same partial collection, combined negative/positive preview, overlap, actual checkout and cleanup checks remain required. The rerun began after the Room full suite finished, avoiding unnecessary resource contention.

### Fixed-candidate results

The fresh eight-worker rerun passed the tested fault sequence. The initial lead started at 05:03:25 UTC and finished its first checkpoint at 05:14:41 UTC; the retained lead resumed for the second phase at 05:16 UTC. No worker was replaced.

| Checkpoint | Observed result |
| --- | --- |
| Active priority interrupt | Original redirect worker preserved its initial 1,284 bytes and added nested URL-default coverage on the same thread. |
| Same-process automatic reconnect | Dedicated fixture MCP/relay 54881 received SIGTERM at 05:10:11 UTC. Lead MCP 58443 took over the relay. Privacy host 69299 and MCP 69452 retained the same process/start identities. Query-only sharing remained intent; the sibling read was unavailable and its preview applied zero peer paths. |
| New-process retained resume | Privacy finished its first run under intent with its canary unchanged, then resumed the same worker/thread in host 32991/MCP 33071. Before any setter, query-only sharing remained intent and the sibling read/preview again exposed no canary. |
| Lead restart with active workers | Observer's first process stopped; redirect survived under PID 1. Their original identities and work were retained. Final-lead-owned original-thread follow-ups provided witnessed final exits. |
| Real overlapping edits | Errors/lifecycle workers resolved an actual shared-file conflict through Room and preserved all four independent tests. |
| Deliberate combined test failure | The combined preview observed the injected 404-versus-200 assertion: 1 failed, 499 passed, 2 skipped. The same original client worker restored 404; the same combined suite passed 500 tests with 2 skips. |
| Partial collection | Five finished workers were integrated and removed while privacy, observer and redirect were explicitly skipped as running. External process monitoring and post-collection hashes confirmed their ongoing work survived. |
| Final integration | Complete preview and actual collected checkout each passed **513 tests, with 2 existing skips**. Seven changed paths; dependencies and runtime source unchanged. |
| Normal cleanup | All eight original workers retired and all eight owned worktrees were automatically removed, with no forced discard or fabricated exit status. Canary absent; no open claims. |

The two privacy checks were independently accepted by Astra against the raw calls, sharing setters, process/start identities and probe hashes. Final source/evidence review was independently accepted by Astra with no remaining blocker. Raw final-run evidence is `/tmp/room-flask-fault-r2-run`, particularly `relay-fault/`, the two phase JSONL files, `evidence/controller-process-monitor.jsonl`, and `evidence/phase2/{combined-red,completed-green,partial-collect,final-preview,final-collect,final-suite}.json`.

These are bounded lifecycle/privacy/coordination checks, not a claim that all possible bugs have been disproved. In particular, conservative retention when a dead launcher cannot witness exit zero remains intentional; the failed first attempt records that limit rather than hiding it.

The final lead completed `room_done` and exited zero at **05:28:23 UTC**, 24m58s after the first lead launch including controller checkpoint/restart time. After exit, the saved relay snapshot contained **0 completed-publication payloads, 8 revision markers and 0 live heads** (90134 bytes).

Final exit evidence is explicit: preserved `boundary-prefinal/registry/runs/<worker-id>/*.exit.json` records witnessed exit zero for all eight latest runs (privacy, observer, redirect and client run 2; four others run 1). Only the earlier observer/redirect run 1 exit statuses remain unknown. The controller corrected an overly broad numeric-exit limitation in the external lead report and preserved its original text separately.

Final Astra review independently checked the integrated source additions, both privacy gates, actual combined red/green results, original-thread continuity, three live workers at partial collection, all eight latest witnessed exit-zero records, final automatic cleanup, unchanged lockfile, absent canary and zero claims. **No remaining blocker was found in this rehearsal.**
