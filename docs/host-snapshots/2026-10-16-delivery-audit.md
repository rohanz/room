# Room delivery and ordinary-use audit - 2026-10-16

Status: researched implementation plan, not shipped changes. Runtime and the frozen v9 benchmark were not modified by this audit.

## Scope and evidence

Paths under `/tmp/room-host-audit-2026-10-16/` are raw evidence on the maintainer's machine at the time of the audit, not files in this repository.

Inspected the main checkout and the uncommitted candidate in `.room/workers/coupled-benchmark-lead`, especially wake routing, host bindings, worker launch/preamble, hooks, message priorities, ledger receipts, doctor output and skills. Local hosts: Codex CLI 0.162.1 and Claude Code 2.1.300. Generated the installed Codex protocol schema rather than assuming the web documentation describes every installed capability.

Existing candidate delivery suites: `wake-turn`, `socket-wake`, `codex-app-server`, `wake-note`: **66 passed**, four files, 4.14 seconds, two test workers. Evidence and generated schema: `/tmp/room-host-audit-2026-10-16/`. These are transport/policy tests with fixtures; they are not a live test of every host/mode/platform.

The earlier Fable guidance report assessed six scenarios against instruction text. It was useful review, but is not evidence of six independent live agent executions. Earlier status updates calling those fresh-agent checks were too strong.

## What already works

- Room persists coordination messages and separately records handoff receipts. A successful wake is deliberately not a receipt. `ledger.ts` and `wake-reconciler.ts` implement this distinction.
- Claude receives content-free wake pointers through its own authenticated inbox socket, with admitted MCP channels as fallback. Tool replies and edit hooks deliver pending Room content.
- Codex active daemon sessions receive eligible pointers through `turn/start.toolOutput`; idle sessions use `codex queue`. Peer content is subsequently fetched from Room rather than supplied as a human instruction.
- Questions, conflicts, affected callers, worker completion, retained worker resumption, peer previews and collection already exist. No new generic message bus is needed.
- The candidate skills already describe independent work, direct peer coordination, focused intermediate checks and handling new host input. The remaining problems include inconsistent runtime instructions and policy, not merely missing paragraphs in skills.

## Current host capabilities

| Host surface | Verified capability | Consequence for Room |
| --- | --- | --- |
| Claude cross-session inbox | Active sessions receive messages between tool calls; idle sessions can start a turn. Available from 2.1.224 on macOS/Linux, 2.1.234 native Windows. Explicit inbound settings may hold/refuse messages. | Keep this primary path. Do not call socket availability proof of delivery or bypass inbound policy. |
| Claude local idle subscription | `SendMessage.notify_when_idle`, 2.1.236+, supplies a one-shot idle/exit notice. | Useful for non-Room local sessions; redundant for normal Room-owned worker lifecycle monitoring. |
| Claude Mods | Introduced in 2.1.287. `session.send/receive` expose delivery outcomes/events; `prompt.submit` waits for idle; status UI can run without model turns. | Prototype as an optional adapter/diagnostic UI. It is not an instant-steering replacement and should not become mandatory yet. |
| Claude hooks | `asyncRewake` can wake on hook failure; ordinary async output waits for another turn. | Useful for appropriate background checks, not an extra permanent watcher per worker. Do not signal ordinary successful messages as failures. |
| Codex app-server | Installed schema supports `thread/read`, `thread/status/changed`, `turn/start.toolOutput`, `turn/steer`, `turn/interrupt`. | Prefer host status over interpreting private rollout files where supported. Preserve message authority. |

Sources: [Claude cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging), [Claude changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md), [Mods API](https://code.claude.com/docs/en/plugins/mods/api), [hooks](https://code.claude.com/docs/en/hooks), [Codex app-server](https://learn.chatgpt.com/docs/app-server). The exact introduction release of Codex tool-output/status methods was not established; they are verified in installed 0.162.1 and documented today. Do not invent a minimum version from that observation.

## Findings and recommended order

### P0: Remove contradictory worker instructions

Both main and candidate `worker-config.ts:workerPrompt` still direct a worker to ask the lead when unsure and wait again up to three times. That undermines the candidate skills' direct-peer and independent-work guidance. It can turn a peer dependency into lead-mediated serial work.

Replace that text, rather than append another layer:

> Ask the peer responsible for a dependency directly; ask your lead for scope decisions or unresolved ownership. Continue independent work while an answer is pending. If blocked, wait for that specific answer. Test the affected interfaces in a combined preview and send failures to their owner.

Keep completion/resumption and foreground-test lifetime instructions. A permission question remains a human decision; timing out is not permission. Align the preamble, skills, tool replies and fallback wake wording. The no-wake fallback should say when to wait rather than tell a lead to block immediately after dispatch.

### P0: Deliver completion during active Codex work

`shared/wake.ts` permits an addressed `done` to wake its lead, but `wake-reconciler.ts:163` removes all `fyi` events from mid-turn delivery. `done` defaults to `fyi`. `wake-turn.test.ts` explicitly tests that completion stays out of a busy turn. This is an intentional policy with an undesirable consequence: finished work can be available while the lead remains unaware until a Room tool/hook or turn boundary.

Make addressed completion of the lead's own worker eligible for a coalesced mid-turn pointer. Keep routine progress quiet. Reuse existing receipt, debounce and deduplication machinery. No force-interruption of running tools, no new turn per worker, no elevation of peer text to user instructions.

This is a code-proven policy gap, not proof that it caused a specific Claude benchmark delay.

### P1: Prefer host-state APIs and expose delivery health

`CodexTurnProbe` scans private JSONL rollouts for task-start/task-complete events before attempting mid-turn delivery. The app-server adapter already reads thread status, but only after that probe. Prefer the bound host's supported status API, and status events where subscription semantics are verified; retain a bounded legacy fallback. Unknown/disconnected state must remain unknown, not silently become idle. Cover unloaded sessions, reconnects, app vs CLI, `exec`, `--no-daemon`, approval waits and Windows separately.

Doctor currently checks Claude version and presence of a socket/channel; it does not prove acceptance or expose equivalent detailed Codex delivery health. Add bounded, content-free diagnostics to normal state changes and `room_state(check=true)`:

- selected transport and supported mode;
- message recorded, wake attempted/accepted, content handed to host, explicit answer received;
- failure/fallback reason and age of pending addressed work.

Do not label a successful socket write as "read" or "acted on". Claude's raw own-socket interface has no delivery receipt here; `hold`/`refuse` can leave the message unread. Never override user or managed settings to repair that. Add one visible degraded-delivery notice and bounded retries only where justified; avoid duplicate queued turns or endless reminders.

### P1: Make external updates event-driven at their source

The benchmark wrote requirement files but did not notify the host. First-change acknowledgement took 61 seconds; second took 285.6 seconds. The second delay included repeated Room waits, collection and build/lint before the lead checked its file mailbox. These were not delayed Room messages.

Keep immutable revision files as evidence, but have the controller submit a host-native notification/input when writing one. Use the same semantics for every comparison arm, log submission and consumption separately, and disclose this protocol change. Use native user input/steering for a controller acting on behalf of the benchmark's human, not peer-message impersonation. Verify headless input support before choosing stream input or a session inbox. Do not change a running or completed measured arm.

For ordinary Room usage, the human already talks to the lead through its host. The lead should propagate the relevant change to affected workers with addressed Room messages. A short instruction is appropriate; automatically broadcasting every human prompt or watching arbitrary project files is not. A future external-event adapter should have explicit task-scoped registration, source identity and bounded payloads.

### P1: Make the evidence for reusing a preview explicit

The run showed repeated previews and a broad test run started on revision 1 after revision 2 had already been read, then killed and rerun. Some repeated checks caught real errors; not every repeat was waste.

Keep focused peer checks. Surface the tested snapshot, command, completeness and environment together so the lead can identify a genuinely unchanged tested result. A successful preview is reusable only when the collected tree, inputs and relevant environment match and the preview was complete. Never turn a partial merge or output-limited run into a full validation claim. Defer a new validation cache until timing evidence shows the smaller reporting/guidance change is insufficient.

### P2: Optional host adapters, not a wholesale rewrite

Prototype a Claude Mod that shows Room delivery/worker status without extra model turns and observes delivery outcomes. Version-gate it and preserve the current MCP/socket path for older hosts and installations where Mods are unavailable. `prompt.submit` queues until idle; it does not solve busy-turn notification by itself. `session.send` reports host queueing, not model comprehension.

For Codex headless workers, prototype app-server ownership only if real tests demonstrate that current tool/hook fallback misses necessary messages. It offers explicit state and input control but introduces process, approval and session-lifetime responsibilities. Do not migrate every worker merely because the API exists.

Permission relay is optional human UX, not a coordination optimization. Room peers must never approve another session's pending actions. Preserve frozen Codex hooks.json; do not make installation require retrusting it for these changes.

## Acceptance tests for normal usage

Use ordinary prompts such as "Implement this using local Room agents". Do not add benchmark-only coordination coaching. Test real Claude and Codex sessions, with deterministic fixture tests underneath them:

1. A worker finishes while the lead is busy with unrelated work: one timely completion pointer, no tool cancellation, no duplicate processing.
2. A worker asks its peer a question while its lead runs a test: peer receives and answers without a manual lead relay.
3. The human changes a requirement mid-task: the lead receives it through the host, forwards relevant changes, and workers revise only affected work.
4. Idle lead, unavailable wake path, explicitly disabled wakes, held/refused inbound policy, host restart and disconnect: correct fallback and visible limitations, no silent "delivered" claim.
5. Worker exits without `room_done`, retained worker resumes, all workers finish together: bounded notices and accurate lifecycle state.
6. Message bursts and a long-running tool: coalescing, no dropped ledger items, no claim that delivery interrupts running tools.
7. Same revisions collected after a complete preview versus changed/incomplete snapshots: reuse evidence only in the first case.

Measure event-to-host-handoff and event-to-agent-response separately, plus useful work, idle time, test duplication and process startup. Do not promise zero latency or speedup for every task. The intended default is automatic transport selection and ordinary peer coordination, without users specifying transport, polling loops or worker scheduling.

## Implementation batches

1. Small worker-preamble/fallback correction and Codex completion policy; unit tests, fresh live behavior tests, review, rebuild.
2. Host-state detection and delivery diagnostics, including compatibility/failure tests. Add schema/version evidence for supported modes.
3. Separate benchmark notification adapter with an explicit protocol delta; then rerun affected conditions fairly.
4. Optional Mod/app-server prototypes only after a measured need. Keep the existing reliable paths.

No runtime code, hook manifests, installed plugin, host settings or frozen benchmark files were changed for this audit. Only this report was added to the checkout.

## Implementation started (2026-10-16)

Work is underway in the existing candidate checkout, not the frozen v9 benchmark plugin. `delivery-core` (Astra high) owns completion delivery, host state and diagnostics; `guidance-flow` (Astra high) owns concise worker/skill guidance and preview evidence. A Fable medium reviewer is independently checking the completed v9 result. Integration, final build and live Room acceptance remain pending; focused passing worker tests are not release validation.

Isolated host prototypes and results: `/tmp/room-host-audit-2026-10-16/prototype-results.md`. Claude 2.1.300 native streaming input was tested with Opus medium both between turns and during a running Bash sleep: the update queued in 24 ms, was surfaced after the tool finished, and the response used the new requirement. The optional status Mod validates and its command loads in a session-local invocation; hook passthrough/rejection fixtures pass. Neither prototype is installed, shipped or connected to a new timed benchmark. The Mod only observes Room-style pointers, which are not authenticated by their text prefix and are not read receipts.

## Supervised validation (2026-10-17)

The candidate remains uncommitted in `.room/workers/coupled-benchmark-lead`; this section records evidence, not a release. The final full regression passed **4,078 tests**, with 3 skipped (351 passing files, 2 skipped), in 497.50 seconds. Type checking, plugin build, generated eval mocks and `git diff --check` passed. The previous eleven failures were resolved by explicitly providing an idle host in four routing/receipt test helpers and updating one stale preamble assertion; no runtime behavior or assertions were weakened to make them pass. Fable medium independently verified those changes.

The rebuilt server bundle's SHA256 is `16aab1f79bf867d44aebf66e5b74bdef69179da9975bcf81c2885d0fa3c0f711`, identical to the frozen live-test candidate. On Claude Code 2.1.300 and Codex app-server 0.163.0, actual model sessions received owned-worker completions while busy and after becoming idle, and exchanged a direct peer question and addressed answer. The idle responses required no new human input. Codex received one tool-output pointer in the active turn while unified exec yielded; the underlying command completed normally. This is active-turn delivery evidence, not interruption of a synchronous tool. Separate wake-disabled controls produced no autonomous recipient turn during the short observation window; an explicit tool call then handed over the pending message. Fable checked the raw event order and model acknowledgements independently.

Limits: Codex collection was blocked by the probe's `never` approval policy, and the tiny seed's default preview test lacked vitest; these runs do not prove collection or successful application tests. They also do not establish Windows behavior, held/refused Claude inbound policy, restart/disconnect, bursts, installed Codex hook integration, Codex exec-worker propagation or any speedup. The disabled control used an eight-second observation delay (about eleven seconds from question to manual input), not a long-idle test. Unknown-state retries remain fixture coverage.

Two low-severity diagnostic wording issues remain: the retained wake-record count can read like a cumulative send count even though records are pruned after handoff; explicitly disabled Claude wakes can be described as unavailable. Existing bridge-projection fixture log noise also deserves separate cleanup. There are no remaining high/medium findings in the delivery review, but this is not a claim that the whole candidate is bug-free.

Local evidence: `/tmp/room-host-audit-2026-10-16/final-full-regression.log`, `delivery-fable-review.md` (Follow-up 3), and `live-delivery/root-assessment.md`. The plugin routing evaluation completed all 27 cases with passing routing graders (Opus medium, one run per case, no ablation, mocked tools; USD 4.11). One collection run exceeded its ten-turn limit despite calling the required tool; this is not a clean task-completion result. A focused diagnostic rerun completed normally; its retained trace shows the agent checking a static mock that reports collection done without changing files or worker status, and correctly refusing to claim the fix landed. This explains why this fixture can provoke extra verification; the original failed trace was not retained, so its exact cause is not proven. These scores measure routing, not coordination correctness or speed. No commit, push or installation was performed.

## Integration and follow-up (2026-10-17)

D10 and D11 are resolved: health output now labels retained wake records and their pruning after handoff; intentionally disabled Claude wakes report disabled with tool/hook fallback and no repair suggestion. The existing doctor suite passes 25 tests, including the disabled-path assertion. Fable's integration addendum confirms the fixes and that the main audit preserves the earlier candidate report.

The candidate was integrated uncommitted and unstaged into main, with a recovery copy and per-file hashes in `/tmp/room-host-audit-2026-10-16/integration/`. README and CHANGELOG were three-way merged to preserve the separate documentation cleanup. Main type checking, plugin build, eval mocks and diff checks pass; its full suite is running. The new bundle SHA256 is `f49a49d8a63eaab8d52403a633296f56cc5584dd2e9cb2e3c0953f669caf4289`. It differs from the live-test bundle in diagnostic text and generated dependency-path labels; do not describe it as the identical live-tested artifact. Frozen live evidence is unchanged.

The next complex-task run will use a new protocol: controller-authored requirement updates delivered as native user input with an immutable payload file, instead of relying on the agent to discover a file mailbox. This adapter was probed separately and is being wired into a new controller copy. Prior file-only run timings remain historical evidence, not matched speed comparisons. Task, model, effort, schedule, plugin hashes and raw delivery events must be recorded before the timed arm starts. No global installation or publication was performed.

### Integrated checkout validation (2026-10-17)

- Typecheck, plugin/web build, eval mock generation and `git diff --check` passed. Frozen bundle SHA256: `f49a49d8a63eaab8d52403a633296f56cc5584dd2e9cb2e3c0953f669caf4289`.
- Full suite: 4,077 passed, 3 skipped, one failed timing assertion; 350 files passed, two skipped, one failed (594.82s). The graph-retention rebuild took 1,388.7ms against the unchanged 1,000ms limit while harness validation also ran. Correctness and linear-scan assertions passed. Evidence: `/tmp/room-host-audit-2026-10-16/integrated-tests.log`.
- Once competing validation jobs finished, the entire graph-retention file passed 12/12. Recorded rebuild 131.56ms, one claim scan; threshold unchanged. Evidence: `integrated-graph-isolated.json` and `.log` in the same evidence directory. This supports contention as the timing-failure explanation; the initial full run is retained as a failure, not relabelled green.
- New benchmark controller's pinned Opus-medium live input smoke checks passed while idle and busy. Both recorded exactly one revision submission and echo; raw lifecycle events distinguish queueing, execution and semantic acknowledgement. Benchmark launch remains gated on Fable's controller review and preflight.
- Fable's benchmark-controller review found and verified fixes for deliberate-stop classification, validation after the lead cap, init retry, and duplicate revision input on scheduled resume. Final focused fixtures passed 39/39; Fable's full harness run passed 91/91. Review: `/tmp/room-host-audit-2026-10-16/native-input-fable-review.md`.
- Root executed the frozen-plugin teardown smoke: local Room state called, READY result, normal exit0, no input error or forced stop, no residual processes (14.504s total). Evidence: `/tmp/room-coupled-benchmark-2026-10-17-native-input-room/control/setup-evidence/live-room-teardown/`. This does not exercise retained workers during teardown. Preparation/preflight authorized; root retains timed launch control.

### New native-input benchmark result (2026-10-17)

The isolated Room arm finished automated validation at **3,096.4s (51m36s)**: build/lint passed, 1,080 tests passed with three skipped, and acceptance 91/91. **Manual review rejected the result**: a separate reproduction on the preserved final build showed an active job with `removeOnCancel: true` and a durable custom-reason cancellation emits the default reason after its hash is removed, and reports `attemptsMade: 2` instead of 1. Evidence: `/tmp/room-host-audit-2026-10-16/cancel-metadata-repro.{cjs,json}`. Target source SHA256 `a1cd68b65abe1ea1e2ddaa31e9057f28574a9f9f2cb7ffbfded11c03c7515af6`. This is a target implementation defect, not a confirmed Room runtime failure. The target and raw evidence remain unchanged.

Coordination did run in parallel: five initial Opus-medium workers launched at T+178–218s; each spawn took roughly one second. They negotiated shared-file regions and backend interfaces directly and ran 38 combined-preview calls across the six workers (including the later revision worker). Completion delivery was sub-second in the observed tool timestamps. The lead's 100s Room waits delayed unrelated host input/task completion; first revision queued600.018s, consumed637.947s, acknowledged649.5s; second queued1200.874s, consumed1202.754s, acknowledged1215.8s. These observations support actual parallel execution, not a speedup claim.

The run also exposed benchmark infrastructure defects: Vitest 4.1.11 misresolved bare `stream` for a particular validation-root length, and process cleanup matched an external reviewer solely because its prompt mentioned the checkout path. A recorded, reversible relocation of mutable validation output fixed the import error without changing frozen inputs, assertions, target code or shared dependencies; round0 and its contaminated repair prompt remain preserved. The reviewer was resumed after cleanup. This run is **not a clean matched timing comparison**, both because of those interventions and because earlier controls use a different input protocol. Separate successor-harness fixes and Fable review are in progress; the frozen harness is not patched retrospectively.

Evidence root: `/tmp/room-coupled-benchmark-2026-10-17-native-input-room/control/evidence/room/` (`result.json`, `manual-review.json`, raw lead/worker traces and validation logs). Root supervision notes, exact tool timing and infrastructure diagnoses: `/tmp/room-host-audit-2026-10-16/native-run-supervision.md`, `native-run-tool-timing.json`, `validation-copy-diagnosis.md`, `validation-copy-fable-check.md`, `validation-relocation-intervention.jsonl`.

Fable medium's completed static correctness audit agrees with the reproduced blocker: Redis state and QueueEvents retain the cancellation metadata, but the in-process Worker event and Job fields can lose it after retention deletes the hash. The audit records five non-blocking observations and its coverage limits in `/tmp/room-host-audit-2026-10-16/native-run-correctness-fable.md`. It is not an exhaustive correctness proof.

The worker skill now explicitly says to use the host's own command completion when only the agent's own command remains. Existing Room-dependency and single-wait guidance is retained; skills and tool-budget checks pass 11/11. No automatic no-workers early return was added: independent peers can legitimately send new messages without a running local worker or an already-open question. Fable endorsed this approach. This wording change has not been benchmarked; the frozen benchmark plugin remains unchanged.

The isolated successor harness fixes are complete and reviewed: validation checks canonical destination compatibility with the pinned Vitest resolver before writes; cleanup uses recorded descendant identity or canonical checkout containment rather than prompt text. Astra recorded failing regressions before the fix, then 47 focused and 20 input/containment checks passing. Fable independently passed 64 focused checks and found no blockers. Existing PID selection/signalling races and unrecorded detached children outside the checkout remain limitations. Reports and exact diff: `/tmp/room-host-audit-2026-10-16/harness-followup/{report.md,fable-review.md,exact-harness.diff}`. No successor benchmark was launched.

Final overlapping-work preview was partial (large bundle and binary exclusions) and reported inherited candidate conflicts in documentation and the revised skill paragraph. Those retained worker snapshots are not being collected again: main already contains the integrated candidate plus the reviewed diagnostic/documentation updates, and the skill difference was inspected directly. Main validation above remains the evidence for the integrated code. Nothing was committed, pushed or installed globally.

### Efficiency follow-up launched (2026-10-17)

The user authorized a fresh attempt at `/tmp/room-coupled-benchmark-2026-10-17-efficiency/control`. Fable reviewed preparation without blockers. Original requirements, ordinary actor prompts, Opus-medium models and native T+600/T+1200 revisions are unchanged. One new independent acceptance case reproduces the previous cancellation-metadata/attempt-count defect on preserved prior output; grading is now 92 cases, so this is not an identical-gate timing comparison. Existing 91 cases are unchanged. The reviewed harness fixes are included.

Concise guidance changes dispatch independent work early, let peers agree required interfaces directly, explicitly support coordination without a lead, and share check evidence under the existing exact-input reuse rule. Final integrated validation remains required. Skills/tool-budget checks pass 11/11; plugin build and eval mock generation pass. Frozen bundle SHA256: `50ee5c07bd7bb10024208a18d0ac8d815db4285f3efa2c222be96e59a9afcd4e`; the bundle change is instruction text, with both skills separately inventoried. No cross-user performance claim follows from this local-worker run.

Root launched the Room arm at 05:32:58 UTC after input verification, successful preflight and stopping a stale v9 controller waiting at its review gate. Operator evidence is `operator/launch-room-g7jejh/`; Astra supervises read-only and Fable reviews the final result. No outcome is established by launch. Prior runs, grading and frozen evidence remain preserved; no push or global installation.

### Focused guidance follow-up (2026-10-17)

The larger efficiency run was stopped at the user's request in favor of isolated probes. These preserve original runs and distinguish host capability from an agent choosing to use it. On Claude Code 2.1.300, explicit native-background probes showed a headless main conversation and a production Room worker surviving an interim result with stdin closed, receiving completion, inspecting results and finishing cleanly. An independent peer received an answer during the main conversation's long command. These were coached capability checks, not evidence that every agent chooses background execution naturally; Codex background lifetime was not verified.

The guidance now asks for task-appropriate evidence: focused checks for changed behavior, combined previews for affected interfaces, and full relevant validation by whoever integrates. It retains exact-input evidence-reuse conditions, required CI checks and reruns for changed inputs, failures or incomplete evidence. Registered-worker resumption is distinguished from independent peers; no central lead is required. Background-command advice is limited to verified host behavior and documented timeouts. The arbitrary worker-count threshold for offering a background lead was removed. Runtime scheduling and generic-versus-explicit-Room delegation routing are unchanged.

One natural coding pilot used Opus 5.5 medium for the lead and two workers on connected pricing/receipt changes. The workers launched 5.3 seconds apart, used focused pricing and combined checkout checks, and the lead ran the full suite on the collected result once (18/18 passed). Independent frozen acceptance passed 5/5. Fable's raw-log audit confirmed 34.137 seconds of worker overlap with source writes by both, two real combined previews (11/11 then 14/14 as receipt tests changed), natural worker exits before collection, and no residual processes. The full suite included an unrelated, real 180-second cache-expiry test; its duration is not Room overhead. The lead did not wait on Room while only its own command remained. No speedup or causal instruction-effect claim follows from this single local pilot, and it did not exercise different user accounts or inject an interface bug. A two-worker resource cap and the harness's completion gate also limit generalization.

Evidence: `/tmp/room-host-audit-2026-10-16/focused-own-command-probe/`, `native-background-fable-review.md`, and `coupled-guidance-pilot/` under the same audit root. The coding pilot is `runs/guidance-coupled-2026-10-17T09-44-21-359Z`; frozen manifest SHA256 `ed8b588112c0fe285a66f62f51d32f88455749342d2c7a25f62ff4ae6f611beb`. Main integrated guidance passes 12 skills/tool-budget checks, typecheck, mock generation and the full plugin build. Fable reviewed the scoped patch and integration resolutions. A whole-worker preview still reports inherited differences and a large-bundle exclusion; only the reviewed five-file delta was integrated, with main's newer guidance preserved and generated assets rebuilt locally. Nothing committed, pushed or installed globally in this follow-up.

### Independent peers and a changed requirement (2026-10-17)

Two independent Opus 5.5 medium sessions in separate local worktrees implemented pricing and receipt changes concurrently, without a lead or worker relationship. After their first substantive source edit, only the pricing session received a human revision replacing integer `percentOff` with fractional-percent `discountBps`. The pricing agent sent the change directly to the receipt agent; both ran combined previews and detected stale receipt fixtures. Receipt correctly requested its own human's approval because its explicit brief still specified the old contract. Independent behavior acceptance passed 5/5, but the combined suite passed only 12/14. This is an incomplete integration, not a Room delivery failure or permission to override another user's instructions.

A separately recorded continuation resumed both original sessions. After receipt received human approval, it updated only its tests; both peers directly checked the combined result, passing 14/14. A mechanical curator merge independently passed 14/14 plus the same 5/5 acceptance checks. Both peer previews matched the final tested inputs; the second repeated an identical fast check, so this is not evidence of minimal testing. There was no central integration agent. Receipt's isolated checkout still lacked pricing's changes and failed its standalone suite, a disclosed dependency boundary rather than a failing combined result. No Room runtime or skill change was needed.

Fable independently audited the setup, raw messages, checks and restoration. Both runs ended with zero residual processes after controlled cleanup. The first result and its source snapshots remain preserved; the continuation is neither a replication nor a retroactive pass. Limits: one small fixture, simulated identities on one OS account rather than cross-user authentication, Opus medium only, a fixed early update trigger, retained stdin and a finite completion quiet window. No speedup claim. Evidence under `/tmp/room-host-audit-2026-10-16/`: `independent-peer-change-probe/REPORT.md`, `independent-peer-approval-followup/REPORT.md`, and `independent-peer-fable-review.md`.

### Release-suite fixture correction (2026-10-17)

The subsequent full suite passed 4,078 tests with three skipped but failed the bridge's 3,000-path projection test: expected 3,001 entries, observed zero. The isolated bridge file passed 30/30. A deterministic reproduction showed that its fake peer published awareness only once; after the receiver's presence metadata aged beyond 30 seconds, the production freshness guard correctly withdrew the projection. Forwarding an unchanged-state heartbeat restored it. The fixture now forwards awareness updates like a real provider and cleans up its bridge, awareness instances and documents. A new regression verifies stale withdrawal and heartbeat recovery; the original projection, yielding and atomic-read assertions and timeout are unchanged. Fable approved this test-only correction after red/green evidence (31/31 in the isolated corrected copy). Evidence: `/tmp/room-host-audit-2026-10-16/bridge-f5-diagnosis/`; original full-suite log `release-after-peer-probe-tests.log` in the audit root. Main corrected bridge validation passed 31/31. The subsequent full main suite exited zero: 4,080 passed, three skipped (351 files passed, two skipped), 526.39 seconds. Log: `release-after-peer-probe-fixed-tests.log` in the same audit root. Typecheck, skills/tool-budget checks, mock generation and plugin build had already passed for the integrated guidance; the later correction is test-only. No commit, push or global installation was performed.

### Matched Room-versus-solo rerun on 0.17.16 (2026-10-18)

Four timed arms ran overnight on one idle machine (other Claude and Codex sessions present but idle; load.jsonl max one-minute load 2.2 to 8.4), unattended, with Rohan's prior authorization: two trials, each a solo arm and a Room arm on the same BullMQ durable-cancellation task, Claude Code 2.1.300, Opus 5.5 medium for every actor, the reviewed 2026-10-17 efficiency harness with byte-identical prompts, spec, revisions and 92 acceptance cases, fixed revisions at T+600 and T+1200 seconds, and the Room plugin frozen from main at 61774576 (0.17.16, bundle `df99c129…`). Trial 1 ran solo then Room, trial 2 ran Room then solo (the protocol's randomized order in each trial). The native arm was dropped. The operator (Claude Fable 5.1, this session) graded each preserved tree statically against the requirements after the automated gates and wrote `manual-review.json`; the review wait is outside the scored clock. All four arms were accepted; no test was deleted, skipped or weakened in any arm.

| | Solo t1 | Room t1 | Solo t2 | Room t2 |
|---|---:|---:|---:|---:|
| Lead first exit | 35:05 | 33:26 | 40:18 | 34:57 |
| Validation round 0 | pass, 92/92 | fail, 90/92 | pass, 92/92 | fail, 90/92 |
| Repair round | none | 9.5 min lead turn | none | 19.7 min lead turn |
| Scored end (last validation) | 41:44 | 56:22 | 46:56 | 68:04 |
| Reported cost (all sessions) | $10.00 | $22.58 | $9.59 | $24.12 |
| Workers | 0 | 5 | 0 | 5 |
| First worker started | | T+2:44 | | T+3:04 |
| Last worker `room_done` | | T+17:31 | | T+20:28 |
| Lead alone after the last worker, before its first exit | | 15:55 | | 14:29 |

Result: solo was faster in both trials (41:44 and 46:56 against 56:22 and 68:04) and cost less than half as much. Room's plugin did not fail: no Room tool error, no stuck wait, no residual process, zero protocol violations, and both Room leads reached their first exit at the same time as or earlier than solo (33:26 and 34:57 against 35:05 and 40:18). Room lost the comparison on correctness: both Room trees failed the same acceptance family at round 0 and spent a repair round on it. In both runs the lead split the work five ways (Lua cancel scripts, Lua finish paths, TypeScript API, worker, tests and docs) and the `moveJobFromActiveToWait` requeue path, used by `job.moveToWait` and the rate-limit path, fell between the "cancel" and "finish" Lua workers, so a cancel-marked job re-entered `waiting`. The 2026-10-17 efficiency Room run failed the same two checks. Trial 2 also lost the `removeOnCancel` event reason because the worker read the job hash after the finish script had deleted it. Both solo trees covered these paths without prompting. This is a split-boundary miss by the actors, repeated three times, not a Room runtime defect; the design seam between workers is where the bug lived each time.

Where Room's minutes went (from `lead-*.jsonl` and the mirrored worker logs): about three minutes of lead reading and design before the first `room_spawn`; roughly 10 to 17 minutes of worker runtime with real overlap; then 14 to 16 minutes in which the lead alone collected, resolved overlap, ran the full target suite and wrote up, with 37 to 42 `room_wait` calls per Room arm. The repair rounds added 9.5 and 19.7 minutes of lead time plus a second validation. Workers spent little time testing (38 to 45 seconds of test commands in total per arm) and asked one to four questions each. Trial 2's initial Room lead left a host `Monitor` (a `tail -f` on its own test log) running after its final result, so the Claude process did not exit within the controller's 15-second close deadline and was terminated (exit 143, output intact); that is lead behaviour on a host feature, not Room, and the 15 seconds are counted against Room.

Limits: two trials per arm on one machine, the same task as every earlier run, operator and grader are the same session, correctness reviews are static readings plus the automated gates, and the task is small (solo finishes in about 40 minutes), so Room's fixed head and tail dominate. One minor finding in Room t2's tree is disclosed in its review: a `deadline` of `Infinity` combined with a valid `ttl` is accepted rather than rejected. Evidence: `/tmp/room-coupled-benchmark-2026-10-18-release-t1/` and `…-t2/` (each with `control/evidence/{solo,room}/`, `preparation/`, `RUN-PLAN.md`), built from the 2026-10-17 efficiency control by `preparation/make-attempt.mjs`; harness self-tests 103/103 on the relocated copies. Following this run the 0.17.16 release was pushed and installed; the benchmark result does not change the release, which is a hardening release, and a speedup claim is not made.
