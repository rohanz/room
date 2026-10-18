# Final fix-round re-review, round 3 — registry, names and cutover/config

**Range:** `git diff 0b64667 7a3a882`; reviewed endpoint `7a3a88297b3bfe1561995cea1cd0673490afb489`.

**Counts: 1 RESOLVED / 3 PARTIAL / 0 NOT RESOLVED; 0 new must-fix / 4 new should-fix.** Each assigned commit group is counted once. The relay disposition is based on source and offline hub evidence; its socket test could not run successfully in this sandbox.

Read-only review against the redesign plan, repository-room spec (§B1/§B2 and naming/cutover requirements), naming map, and rehearsal F1–F3. Bundle bytes and other review areas are excluded. The five confirmed human rulings remain accepted. “New” below means newly reported gaps in the requested path/completeness audit, not that every affected line was introduced in this range. Rohanz explicitly confirmed N1 and N2 are in scope and should-fix. Only this report is retained; no source changes, commit or push.

| Assigned item | Disposition | Evidence and remaining gap |
|---|---|---|
| **F1 / `365eac7`: aliases and destination precedence** | **PARTIAL** | `config.ts:43` now resolves all four aliases through `ROOM_SERVER`, then `ROOM_URL`'s server, then hosted. Checked-in config/choice/open-confirm tests and disposable caller probes pass for the main F1 scenario. Explicit server URLs win; explicit local joins stay local; a remembered `team` does not defeat `ROOM_SERVER`; absent configuration still gives hosted for a team request. Missing paths are **N1** (create ignores a remembered URL) and **N2** (login/logout retains the startup server after moving). |
| **F3 / `dd91a2c`: Codex environment forwarding** | **PARTIAL** | All five added entries are valid, distinct environment-variable names. They forward boolean/numeric tuning settings, not literal credentials or new secret-bearing variables. Both checked-in allow-list tests pass. A worker-environment probe proves the concrete lead server survives worker launch plus the Codex filter. One documented setting is still omitted: **N3**, `ROOM_WAKE` for Claude workers launched by a Codex lead. |
| **`1b2a742`: relay two-racers timeout** | **RESOLVED, live validation limited** | The only change is the outer timeout from the configured **20 seconds** (`vitest.config.ts:3`) to **30 seconds**, plus its comment. One-owner, same-port/discovery, successful lease/post, and stray-relay refusal assertions all remain. `SETTLE_MS` is 5,000 (`hub-core/src/protocol.ts:19`), and acquire returns `starting` during it (`hub.ts:375`). The offline restart/settle contract passes. The real socket case fails before relay startup with `listen EPERM` at the squatter listener and then reaches the outer deadline; this is not evidence of a relay hang. |
| **F2 / `d9b84dd`: Codex launch instructions** | **PARTIAL** | Installed `codex --version` reports **codex-cli 0.158.0**; its help lists `--no-daemon` and describes bypassing the shared background server. Changed README examples and AGENTS instructions use the valid flag, consistent with the rehearsal's observed environment loss under the shared daemon. The demo still prints the old recipes: **N4**. No claim is made about the first version introducing the flag. |

## New must-fix

None established under this review's scope and the lead's explicit severity rulings for N1/N2. No new naming/schema invariant violation, data loss, duplicated state, leak, or production hang was established. The socket execution limitation remains explicit above.

## New should-fix

### N1 — `room_create` bypasses a remembered self-hosted destination

**Location:** `packages/room-mcp/src/tools/join.ts:145` (especially line 147).

**Scenario:** A clone has successfully remembered `ws://remembered.test:4403`, and a later process has neither `ROOM_SERVER` nor `ROOM_URL`. `room_join`, `room_login`, and unjoined `room_close` use that destination. `room_create({confirm:true})` injects the higher-priority argument `where='team'`, so the same clone instead targets `wss://room-rohanz.fly.dev`. The remembered destination is never consulted for creation. This predates the alias patch, but leaves its requested precedence audit incomplete.

**Disposable probe:** In an isolated Git clone, write the choice through `writeChoice`, capture the join boundary, and stub HTTP responses. Join captured `ws://remembered.test:4403`; login named that server; close requested its `/rooms`; create captured `wss://room-rohanz.fly.dev`. No actual room was created or closed. Probe passed as a characterization of the defect and was deleted.

**Fix direction:** Resolve arguments/environment/remembered choice first. For create, use a resolved team destination and apply the hosted fallback only when that resolution would be local/default; preserve explicit URL precedence. Rohanz confirmed: “explicit arg > ROOM_SERVER/ROOM_URL > a remembered team URL for this clone > hosted default; never local,” and classified this remembered-choice case should-fix. The normal documented self-hosting case with `ROOM_SERVER` is fixed and passes.

### N2 — login/logout keeps the startup server after an explicit room move

**Location:** `packages/room-mcp/src/tools/join.ts:100` and `packages/room-mcp/src/tools/join.ts:332`.

**Scenario:** Start on server A, then successfully `room_join(where=<server B>)`. The join remembers B, but does not refresh `ctx.config.server`. `configureLogin` computes fresh configuration, then overwrites it with the stale `ctx.config`; `serverOf` also ignores the joined session. A subsequent bare `room_login` or `room_login(action='logout')` addresses A. When startup was local it instead says no server is configured, despite the current team session. An explicit `server=B` works.

**Disposable probes:** Capture startup configuration for the hosted server, change the remembered choice to a custom URL, and call login through `createTools`: it still names hosted while `resolveConfig` names custom. Separately supply the actual login handler a current session on the custom server and the stale startup configuration: both login and logout still name hosted, while an explicit URL names custom. Fetches and credentials were isolated; no real account was revoked. The probes were deleted.

**Fix direction:** Explicit login server first; otherwise the current session's concrete server; otherwise freshly resolve the same destination precedence as join. Keep credential-file selection independent of destination selection. Rohanz explicitly confirmed this ordering and classified the gap should-fix.

### N3 — the Codex allow-list still drops the documented Claude-worker wake selector

**Location:** `plugins/room/codex-mcp.json:39`; consumer `packages/room-mcp/src/worker-launch.ts:87`; documented behavior `README.md:133`.

**Scenario:** Launch a Codex lead with `ROOM_WAKE=channels` and request a Claude worker. The lead's MCP cannot read this variable because it is absent from `env_vars`; consequently `workerCommand` does not receive `wakeChannels:true`, and the requested channels fallback is not added to the Claude invocation. This matters on the older hosts for which that fallback is documented. Modern Claude socket wake behavior is not evidence that the explicit fallback works. Codex's own queue path is outside this finding.

**Disposable probe:** Project `{ROOM_WAKE:'channels'}` through the checked-in allow-list and build the Claude worker command with the same condition used by `launchWorkerProcess`. The unfiltered command contains `--dangerously-load-development-channels`; the filtered command does not. Probe deleted.

**Fix direction:** Add `ROOM_WAKE` and assert the resulting Claude launch behavior, not just string membership. Other unmatched runtime reads were classified: `ROOM_MACHINE_ID` is a test identity override; `ROOM_WEB_DIST` and `ROOM_TREE_SITTER_WASM_DIR` are internal asset/development overrides with no documented end-user contract found. `ROOM_HOST` is deliberately supplied by the manifest's static `env`. These are not additional findings. Official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) confirms that `env_vars` forwards named environment variables; the new five names fit that existing contract.

### N4 — the demo still prints the shell-environment recipe fixed in the README

**Location:** `scripts/demo.sh:58` and `scripts/demo.sh:59`.

**Scenario:** Run the documented demo and copy its two printed `ROOM_SERVER=ws://localhost:$PORT codex` commands on CLI 0.158 with the shared daemon. These omit `--no-daemon`, so they retain F2's known environment-loss problem and do not reliably connect both agents to the demo server. The changed README and AGENTS now give different instructions from the script they describe.

**Disposable probe:** Extract the two actual printed recipes without executing the demo; both lack `--no-daemon`. Check installed CLI help for the flag. The extraction/help probe passed and was deleted. The demo itself was not launched, and no alternate-server write is claimed.

**Fix direction:** Add `--no-daemon` to both printed commands, keeping them aligned with README and AGENTS. This is an incomplete launch-instruction fix, not a request for an unrelated demo redesign.

## Test-expectation audit

No changed assertion in this area was removed or weakened.

| Test change | Judgment |
|---|---|
| `room-mcp/test/config.test.ts:30` | Correct four-alias matrix for custom `ROOM_SERVER`, `ROOM_URL` fallback, hosted fallback and explicit URL precedence. It tests the resolver, so it cannot detect the create caller overriding a remembered choice or the login caller retaining startup configuration. |
| `room-mcp/test/choice.test.ts:36` | Correct additions for explicit team plus custom environment and remembered team plus environment. Existing remembered-hosted and explicit-local behavior remains. Missing remembered **URL** through create is N1. |
| `room-mcp/test/open-confirm.test.ts:64` | Correct new join/create endpoint assertions and login alias cases. The fetch recording checks every requested host, and the custom-server no-room reply does not name hosted. Existing confirmation gating remains. No current-session login/logout transition case covers N2. |
| `room-mcp/test/codex-env.test.ts:20` | Correct five-knob membership check; existing worker-output coverage stays. Its fixed knob list misses the documented wake selector (N3), so passing is not an exhaustive runtime-environment audit. |
| `relay/test/hub.test.ts:75` | Finite timeout increase only. The lease polling deadline remains 10 seconds. `socketClient.send` itself has no per-request deadline, so the outer 30-second Vitest limit still catches a hung request; the change cannot turn a permanent hang into a pass. Five-second settling explains a lower bound, not by itself why a particular run exceeded the former 20-second limit. No successful live timing result is claimed here. |

**Verification:** **46 checked-in tests passed**: the config, choice and Codex environment suites (28 total), open-confirm (17), and the offline hub restart/settle contract (1). **10 distinct disposable probes passed**, covering alias caller matrices, actual-server worker inheritance and manifest validity, the remembered-create gap, stale login configuration/current-session behavior, omitted wake selection, and demo recipes. Endpoint sources came from a scratch archive with its own workspace package links and local Git metadata; third-party dependencies were reused. Initial archive tests lacked Git metadata and a probe initially lacked an isolated credential path; only scratch setup/probes were corrected before passing. No production source or expectation was changed to obtain a pass.

The real relay two-racers test could not get past its first listener: `listen EPERM: operation not permitted 127.0.0.1`, followed by its 30-second timeout. This sandbox cannot certify the two-process/network behavior. Tests used one worker and no file parallelism. `nice -n 10` was attempted, but sandbox `setpriority` was denied. No full build or live host rehearsal was run; the CLI version/help check was read-only.

`room_preview_merge(people=["rohanz"])` reported **no conflicts** against `7a3a88297b`; the other two review documents are independent of this report. Disposable probes and their scratch tree were removed. Final `git diff --check` passed; the only worktree change is this review document.
