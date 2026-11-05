# Review: host adapters

Date: 2026-11-05. Target: `docs/superpowers/specs/2026-11-05-host-adapters.md` in the current working tree.

## Verdict

**Revise before implementation.** The proposed interface does not yet cover the startup ownership boundary or preserve all hook and activity evidence. The extraction also includes observable changes under a behavior-preserving label. These conflict with CLAUDE.md's correctness, simple-design, regression-verification and diagnostic priorities. A green suite is not an established outcome of this document review.

## Must-fix

### M1. Include workspace admission and pre-binding host classification in the boundary

The inventory omits `workspace.ts`, startup in `index.ts`, the second host resolver in `config.ts`, and classification in `presence-end.ts` (locations below). `BindingEvidence.cwd` assumes the checkout has already been selected; `toolSessionId` assumes host metadata has already been decoded. Neither the interface nor the extraction steps own decoding `x-codex-turn-metadata.workspaces`, startup deferral, or rejecting a later call for a different worktree. The proposed `Target.surface` only exists after binding, but presence/startup classification is needed before that.

**Scenario:** a shared Codex daemon starts an MCP from another clone, with inherited PWD pointing there. Moving only `boundSession` leaves the most consequential host-specific identity decision outside the adapter. Using generic cwd discovery in its place can join/share the wrong repository before exact metadata arrives. Conversely, waiting for a bound Target to classify startup introduces a circular dependency.

Specify a small pre-binding evidence decoder/classifier, with shared workspace admission and repository checks retained. Include unknown parent identity, Windows deferral, multiple workspaces, metadata without workspaces, mismatched worktrees, and process-global first-thread admission in its characterization tests. Map the omitted callers to extraction steps explicitly; this is not the roadmap's proposed new startup discovery.

### M2. Separate behavioral changes from extraction

Several instructions do not describe current behavior:

- `session.ts:261` selects Claude when either Room host variable says Claude; it does not reject contradictory evidence. `config.ts:148` instead prefers worker host, then Room host; `tools/workers.ts:178` prefers Room host before worker host and defaults to Claude. One unified selector cannot preserve all three rules without compatibility wrappers. **Scenario:** `ROOM_WORKER_HOST=codex`, `ROOM_HOST=claude` currently produces different results at these boundaries; making everything pending changes binding, naming or spawn behavior. Characterize the disagreement and split any fix from the move.
- The launch section says to replace newest-cache assumptions with active-install evidence, and step 3 reuses that evidence for warnings. `worker-config.ts:185` currently chooses the numerically newest Codex cache; doctor uses CLI listing evidence. **Scenario:** caches contain versions A and B, but the host lists A. Unifying on the listing changes the worker mismatch warning even with unchanged installations. Preserve the warning's existing reader during extraction or explicitly authorize/test the changed rule separately.
- Before-edit's unknown-host compatibility decoder is told to withhold ambiguous identity-dependent receipts. Today `before-edit.mjs:25` writes hook activity/receipt before loading `session.json`; at `:80` endpoint selection depends on session id and the subagent/incomplete guard, not on a known host record. **Scenario:** SessionStart's record is missing but the exact session has a live MCP endpoint. Requiring a known host can suppress delivery/confirmation that works today. Define which receipt is withheld, and preserve current behavior for complete input with exact endpoint ownership. Any additional rejection needs a separate change.
- The prose calls session records validated. `session.ts:160` checks matching id, and `:165` enumerates records with an id/directory check; neither is a full SessionRecord validator. Stricter validation may be warranted, but rejecting previously accepted legacy/partial records is a change. Specify accepted shapes before moving readers.

Keep these decisions outside a claim that every extraction step changes no user behavior. Add before/after fixtures rather than updating expectations silently.

### M3. Hook normalization drops evidence needed by shared analysis

`HookEvent.tool` has only `kind` and opaque `input`. Shared `common.mjs:591` calls `writeTargets(input, toolName === 'PowerShell', root)`. Collapsing Bash and PowerShell into `kind: 'shell'` loses the discriminator needed to preserve path analysis, while retaining raw tool names inside `unknown` merely hides the old coupling.

**Scenario:** a Claude PowerShell tool writes a claimed path with PowerShell syntax. If the shared analyzer treats the normalized shell as POSIX, Room can miss its write targets and omit the advisory claim/nearby context. This changes a supported Windows path during a purported codec-only extraction.

Add an explicit shell dialect and typed normalized commands/path inputs, or retain the original tool discriminator until an equivalent normalization is characterized. Also define the transcript-evidence seam: synchronous `decode(raw, argv)` cannot by itself perform the promised host-owned transcript/model interpretation while all I/O methods are asynchronous. `before-edit.mjs:42` uses a bounded tail, persisted stat cache, and initial SessionStart-model precedence. Pass that evidence into a pure reducer, or expose a bounded asynchronous facet; do not lose the first-read precedence during `/model` handling.

### M4. Log facts cannot preserve current activity age

`LogFact` reduces activity to `{ kind: 'activity'; text: string }`. `worker-activity.ts:115` extracts host timestamps; `:158` documents the separate event-time, last-write and previous-poll/run-start fallbacks. Neither the proposed decoder input context nor its output specifies this evidence. Activity labels also use the worker directory (`:86`, `:99`), which a zero-argument `createLogDecoder()` does not receive explicitly.

**Scenario:** a worker logs a timestamped edit, then much later writes unrelated result lines. Replaying it through text-only activity facts loses the timestamp and can make an old edit appear recent, changing idle/stall diagnostics. Keeping a second host timestamp parser in shared activity code defeats the extraction.

Include optional event time in normalized activity facts and define per-worker/run directory context. Keep scanner position/poll-time fallback policy shared, with parity tests for timestamped activity followed by non-activity lines, missing timestamps and bounded suffix reads. Specify separate decoder state for whole-run acceptance versus suffix diagnostics; a whole-run background decoder must not silently strengthen suffix evidence.

## Should-fix

1. **Make shippable stages concrete.** The ordering needs an explicit destination for M1 before identity/wake removal. Step 2 calls runtime rules pure although defaults read filesystem configuration, and makes defaults asynchronous while callers are synchronous today. State the transitional wrapper signatures and when callers change. Step 4 must specify artifact-write failure feedback: current `worker-launch.ts:106` only injects CLAUDE_ENV_FILE after a successful write; a precomputed envPatch must not inject a failed artifact path. The required shipping checks belong to every shipped step, including rebuilt committed bundles, not just step 9. Step 6 must add generated codec entry points and freshness coverage in the same change as hook imports; `scripts/build-plugin.mjs:25` currently builds only MCP/parse entry points.
2. **Complete the worker minimum for a third host.** The interactive minimum describes required functions, but is not an executable acceptance checklist: test two simultaneous conversations/checkouts, cross-worktree rejection, restart identity, tool-reply receipts and explicit unavailable wake/hooks. The worker minimum permits non-resumable hosts, yet the worker facet has no resume-capability result and `tools/workers.ts:241` persists `resume: true`. Define how adapter evidence initializes existing durable capabilities before creating the intent. Missing worker facet only models no workers at all, not workers without resume.
3. **Specify plan inputs and optional facets, rather than relying on ambient state.** Existing worker commands accept explicit `claudeChannel`, plugin override and shell-hook settings; WorkerInput does not describe where those come from. Factory-injected immutable configuration could cover them, but it must be named and tested. A hook-only import should expose a pure codec entry point, not require constructing an MCP-session adapter or stubbing install/transport services. Inspection is per installation/environment, identity fencing per MCP process, and log state per run; document these lifetimes independently. This will be smaller than pretending every operation shares one session lifetime.
4. **Correct the test table's “no hook record fallback.”** For Codex this is true for shared app-server identity guessing, not for every surface: `session.ts:281` uses metadata, rejects app-server guessing, then `:288` can match a parent-chain hook record for other recognized Codex parents. Worker records also precede log/tool ids at `:275`. Scope this test explicitly; the inventory's “first admitted ... wins” is similarly overbroad for workers.
5. **Make current host evidence auditable.** Name the Claude version/changelog revision checked on November 5, not only September's installed version, and link dated extracts for implementation briefs. Introduction versions in historical surveys establish history, not that the current host still honors a protocol. Version gating on an unreadable version would itself be a new behavior: current Claude socket use is evidence-based, and Codex's old-version shell-filter check is a warning. Define what “observed version” means when it is unknown. Do not introduce new gating incidentally.

## Inventory audit

Ran `rg -n -i 'claude|codex|CLAUDE_|CODEX_|app-server|channels|inbox' packages/room-mcp/src plugins/room/hooks` and inspected the matching mechanisms. The table is incomplete. Add these rows or explicit shared/compatibility exclusions (paths below are relative to `packages/room-mcp/src` unless stated):

| Omitted mechanism / source | Required disposition |
|---|---|
| `workspace.ts:15,29,44,54,98,122,138` | Host cwd/PWD rules, daemon deferral, metadata decode, permanent workspace binding and wrong-workspace rejection; M1. |
| `index.ts:93,97,114,216,260,265` | Claude channel capability advertisement, deferred bootstrap, actual Codex probe construction, exec grace wiring, metadata admission and dispatch. Probe construction is not solely in the reconciler. |
| `config.ts:134,148` | Explicit channel config and separate host precedence/environment fallback; M2. |
| `presence-end.ts:63` | Codex parent-command classification into shared-daemon versus interactive liveness policy. Preserve the shared liveness state machine. |
| `tools/workers.ts:177,178,179,233,241,280` | Public validation, host default, conditional mismatch warning, Claude fresh UUID allocation, persisted resume capability and channel configuration. Schema literals may stay; selection/allocation need ownership. |
| `worker-registry.ts:112,116,882`; `worker-projector.ts:55` | Environment host-session fallback and Claude-only missing-resume interpretation in lifecycle consumers. Migrate interpretation through facts without moving lifecycle policy. |
| `hooks-bridge.ts:202,228,241` | Host-specific warning text **and timing** (Codex up front versus Claude after observed edits), beyond doctor. |
| `prompt.ts:7,16,28`; `tools/join.ts:306`; `tools/scope.ts:154`; `tools/workers.ts:327`; `tools/messaging.ts:389` | Wake advice at join/company/spawn and Claude-specific advice to end a turn instead of waiting. The spec mentions prompt cleanup but does not inventory these behavioral callers. |
| `channel.ts:8`; `tools/context.ts:55`; `tools/state.ts:145`; `registry.ts:265,324` | Notification wire format and host-specific probe/channel plumbing. Temporary compatibility boundaries need explicit allowlisting. |
| `plugins/room/hooks/common.mjs:353,634`; `plugins/room/hooks/claude.json:8,20` | Native Claude executable recognition, Claude-derived context cap and separate Claude hook invocations. Recognition and host envelope limits need ownership; preserve existing shared cap until a separate change. |
| `stale-version.ts:4,50`; `index.ts:25`; `names.ts:203`; `worker-registry.ts:280,374` | Manifest-based release/staleness lookup, legacy host-name migration, persisted validation and legacy Codex default. Explicit compatibility exclusions, not indiscriminately removed literals. |

Other matches in `auto-join.ts`, `inbox-budget.ts`, `ledger.ts`, `solo.ts`, and `tools/index.ts` are generic bind-wait/inbox/receipt policy or comments, not omitted host protocol implementations. `worker-status.ts` remains shared projection. The existing inventory's `session.ts` row does not replace accounting for the distinct config resolver and workspace bootstrap.

## Citation verification

All cited file/line targets exist when basename-only references are resolved to `packages/room-mcp/src` and `:N` continuations are resolved to their named source. They are not all literal repository-relative paths as the table's convention suggests. The audit covered the cited functions/sections, not just existence of line numbers. The grouped register below enumerates targets checked; exceptions and qualifications follow it. A section-start citation is treated as supporting its following section, not as asserting that the exact heading line contains the entire claim.

| Source | Checked line anchors |
|---|---|
| `docs/roadmap.md` | 34, 37, 54 |
| `packages/room-mcp/src/worker-status.ts` | 85, 148 |
| `CHANGELOG.md` | 3, 7, 18, 38, 50, 57, 67, 75, 81, 87 |
| `packages/room-mcp/src/binding.ts` | 24, 32, 41, 70 |
| `packages/room-mcp/src/doctor.ts` | 18, 79, 95, 115, 140, 179, 186, 220 |
| `packages/room-mcp/src/wake-path.ts` | 52, 96, 119, 144, 174, 183 |
| `CLAUDE.md` | 95, 108, 135 |
| `docs/reference.md` | 71, 87, 160, 176, 178 |
| `docs/archive/reports/host-survey-2026-09-24-claude-code.md` | 9, 13, 35 |
| `docs/archive/reports/host-survey-2026-09-24-codex.md` | 9, 13, 106 |
| `packages/room-mcp/src/worker-shell-env.ts` | 12, 21, 29, 41, 74, 90 |
| `packages/room-mcp/src/session.ts` | 244, 257, 261, 270 |
| `packages/room-mcp/src/codex-turn.ts` | 33 |
| `packages/room-mcp/src/codex-app-server.ts` | 13 |
| `packages/room-mcp/src/wake-reconciler.ts` | 174, 201, 262, 285, 290, 373 |
| `packages/room-mcp/src/worker-config.ts` | 12, 22, 95, 105, 124, 166, 170, 185, 198, 202, 224 |
| `packages/room-mcp/src/worker-launch.ts` | 88, 106, 125 |
| `packages/room-mcp/src/run-log-facts.ts` | 63, 72, 82, 87, 110, 145 |
| `packages/room-mcp/src/worker-process.ts` | 66, 152, 201 |
| `packages/room-mcp/src/worker-activity.ts` | 86, 99, 123 |
| `plugins/room/hooks/session-start.mjs` | 13, 34 |
| `plugins/room/hooks/before-edit.mjs` | 16, 34, 65 |
| `plugins/room/hooks/common.mjs` | 53, 107, 436, 448, 591 |
| `docs/archive/reports/host-survey-2026-09-24-gemini-opencode.md` | 21, 61, 125, 138 |
| `docs/archive/reports/host-survey-2026-09-24-cursor-pi.md` | 11, 33 |
| `docs/archive/reports/host-survey-2026-09-24-landscape.md` | 22, 60, 102 |
| `packages/room-mcp/test/windows-smoke.test.ts` | 61, 158, 176, 187 |
| `packages/room-mcp/test/fixtures/windows-fake-host.mjs` | 1 |

Citation corrections and qualifications:

- `session.ts:261` does **not** support the claim that contradictory host evidence stays pending; see M2. The precedence claim also ignores `config.ts:148` and `tools/workers.ts:178`.
- `session.ts:244,270` support fencing and worker matching, but not universal first-tool-id precedence. A matching worker hook record wins, and interactive non-daemon matching remains possible. Narrow the inventory/test wording as described above.
- `binding.ts:24` is the exec predicate, not the initial wait implementation. The five-second constant is at `:29`; the wait is wired by `index.ts:216` into `auto-join.ts`. Cite that wiring.
- `wake-reconciler.ts:174` is a call to the awareness helper; its implementation is `prompt.ts:7`. Likewise, the production probe is constructed in `index.ts:114` even though the reconciler also has a default. These are incomplete ownership citations, not nonexistent lines.
- `worker-config.ts:185` is an install-version reader, not the warning itself. Add the mismatch helper at `:193` and its caller `tools/workers.ts:179` when claiming a warning is produced.
- `run-log-facts.ts:82` accepts `turn.started.thread_id` directly as well as a previous `thread.started`. “thread.started followed by turn.started” is an example, not a strict requirement. Do not accidentally tighten acceptance in the new decoder.
- `host-survey-2026-09-24-landscape.md:60` is the end of the previous paragraph. The ACP discussion begins at `:62`; correct that anchor. The historical third-host claims otherwise have support in their cited survey sections, including their stated inference limits; they are not current primary-source verification of those products.
- The Claude source shorthand `:13`, `:35` refers to the Claude survey, and Codex `:106` to the Codex survey. Spell these out. Basename-only `worker-shell-env.ts`, `wake-reconciler.ts`, `run-log-facts.ts` and `doctor.ts` references should use full paths for mechanical checking.
- `CLAUDE.md:95,108,135`, the reference/roadmap anchors, release-note headings, Windows-smoke anchors and remaining implementation anchors support their associated sections, subject to the interface/behavior limitations above. `worker-status.ts:85,148` does not contain another host-event parser. The Windows fixture is Claude-only, as stated.

## Notes on host evidence and scope

The local CLI reports `codex-cli 0.166.0`; its help lists `queue` and `--no-daemon`. This verifies the spec's local-version/help claim, not live transport behavior. The current [official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) documents queue; the September survey's statement that it was absent from the reference is historical. Current [OpenAI plugin documentation](https://developers.openai.com/plugins/build/plugins) confirms that plugin installation does not grant hook trust. Neither source establishes Room's observed split cache roots as a stable API.

The current [Claude messaging documentation](https://code.claude.com/docs/en/cross-session-messaging) supports the 2.1.224 macOS/Linux and 2.1.234 native Windows minimums. I also opened its [documentation index](https://code.claude.com/docs/llms.txt), [hooks reference](https://code.claude.com/docs/en/hooks), and [changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md). The raw changelog served by the browser was an older cached version headed 2.1.269, while the GitHub page did not expose the current contents; I do not count that as verification of the November 5 latest release. This is why dated/versioned evidence matters under CLAUDE.md:95. This review did not independently re-establish every historical introduction version from upstream release history; it verified that the cited local surveys/code actually make those claims.

The October 8 rehearsal is a bounded capability proof: shared daemon active-turn delivery was exercised, but ordering during a TUI-owned long-running tool was not. It also documents a race where a thread becomes idle before `turn/start`, producing a new turn. The compatibility sentence “Do not start a new turn ... to hide an unsupported capability” must not be expanded into a general no-new-turn guarantee: existing idle queue wake and that race already create turns. Altering the RPC to eliminate that race is separate behavior work.

The seven requested concerns do not require a larger generic host framework. They require a complete evidence boundary: startup/call metadata, identity, transport outcomes, worker plans and capabilities, typed log facts, hook codecs and install evidence. As written the single interface mixes three lifetimes and leaves some required evidence implicit; it is neither demonstrably minimal nor sufficient. Keep the explicit registry and narrow facets, but prove each against actual callers before freezing types.

No runtime suite or real-host worker/wake test was run for this review. Those checks remain implementation/release gates, including scale and native Windows coverage. Only this review file was written in the repository; no commit was made.

## Three questions the maintainer must answer

1. Is this strictly a behavior-preserving extraction, including today's conflicting host precedence, missing-record hook behavior and newest-cache warning, or which of those fixes are explicitly separate changes with their own acceptance tests?
2. What is the authoritative pre-binding context and lifetime for host, checkout and conversation ownership, including metadata without a workspace, an unreadable parent and multiple rooms in one MCP process; which exact facet owns each step before a Target exists?
3. What is the executable minimum for a third host: interactive tools only, workers without resume, or full parity—and how do typed capability evidence and the durable worker record prevent unsupported wake/resume/pre-edit behavior from being advertised?

Must-fix count: **4**.
