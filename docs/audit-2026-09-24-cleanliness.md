# Cleanliness audit of 0.15.1, by Codex (gpt-6-astra, medium), 2026-09-24

Reviewed main at f8b0708. The lead session verified findings 1 (resume uses the lead's sharing level, registry.ts:291) and 2 (discard's recovery patch lacks the fixed diff flags, workers.ts:672) in the code before the fix batch.


Reviewed commit `f8b0708`, including README, AGENTS, the 0.10.0–0.15.1 changelog, roadmap, recent history, source, shipped bundle samples and relevant tests. This is an implementation-cleanliness review, not a feature wish list. Known roadmap gaps (branch rooms, declared-output persistence, sharing-ceiling refresh, claim reanchoring, host sandbox access, etc.) are excluded.

**28 findings: 6 fix-now, 22 tidy, 0 leave.** Ranked by consequence, then maintenance cost. “Inferred” identifies a failure scenario established by code tracing but not reproduced here. Paths and line numbers refer to source, not generated duplicates, unless stated otherwise.

Verification: `npm run typecheck` passed. Ten focused Vitest files passed, **188 tests**: shared near/messages/views; MCP baseline/carry-no-pipe/collect; parse-engine/parse-jvm/parse-script/parse-systems. Tests used the requested environment isolation. An additional read-only, in-memory probe exercised worker resume and path matching. No network or host configuration directories were accessed; no source files were edited, no build-plugin command or commit was run. This is not a full-suite or live-host certification.

## Fix now

### 1. Resuming a worker can silently widen its sharing boundary — FIXED in 0.15.2 (0b06299)

- **Severity:** fix-now.
- **Locations:** `packages/room-mcp/src/tools/workers.ts:149`, `packages/room-mcp/src/tools/workers.ts:167`, `packages/room-mcp/src/registry.ts:289`, `packages/shared/src/types.ts:126`, `packages/room-mcp/test/workers.test.ts:1296`.
- **Problem:** Spawn accepts an independent `share`, but the worker record does not retain it and resume supplies the lead's current sharing level.
- **Consequence:** An `intent` worker under a `full` lead restarts with `ROOM_SHARE=full`; environment precedence overrides a remembered narrower level. This can publish file text after a routine follow-up. The test compares environments only when worker and lead use the same default. **Inferred end-to-end disclosure; the in-memory resume probe confirmed the generated full-sharing environment.**
- **Smallest clean change:** Persist the worker's effective sharing setting and reuse it on resume; resolve legacy records conservatively. Add a spawn-intent/resume-under-full regression and a worker-side sharing-change case.

### 2. Discard recovery bypasses the hardened patch-generation policy — FIXED in 0.15.2 (bb936e8)

- **Severity:** fix-now.
- **Locations:** `packages/room-mcp/src/workers.ts:320`, `packages/room-mcp/src/workers.ts:421`, `packages/room-mcp/src/workers.ts:461`, `packages/room-mcp/src/workers.ts:666`, `packages/room-mcp/src/workers.ts:672`, `packages/room-mcp/src/tools/collect.ts:163`.
- **Problem:** Carry generates configuration-independent patches with explicit color and prefix flags, while discard generates its recovery patch through a separate raw Git wrapper without those flags.
- **Consequence:** Config such as `color.ui=always` or custom diff prefixes can produce a recovery file unsuitable for ordinary `git apply`, after which discard removes the worktree and branch. **Inferred; hostile-config recovery was not executed.**
- **Smallest clean change:** Define one internal patch argument builder (no color, no external diff/textconv, fixed a/b prefixes) and use it for both carry snapshots and discard. Verify recovery by applying the patch in a scratch tree before destructive cleanup, with a hostile-config regression.

### 3. Resume clears the stop reason in the document but leaves it on disk — FIXED in 0.15.2 (bb936e8, 0b06299, fa56a76)

- **Severity:** fix-now.
- **Locations:** `packages/room-mcp/src/registry.ts:127`, `packages/room-mcp/src/registry.ts:170`, `packages/room-mcp/src/registry.ts:302`, `packages/room-mcp/src/workers.ts:358`, `packages/room-mcp/src/workers.ts:370`, `packages/room-mcp/src/tools/workers.ts:257`.
- **Problem:** Intentional shutdown persists `lead-session-ended` in the carry record; resume clears only the Yjs field, and later registry tracking reloads the old reason.
- **Consequence:** A successfully resumed worker can be marked dismissed again when another session tracks the room, or later be reported as intentionally stopped when its actual exit reason is unknown; retirement also skips it. **Inferred restart sequence.**
- **Smallest clean change:** Give persisted stop state an explicit clear operation, call it as part of a successful resume transition, and bind it to the process generation/start identity. Test shutdown → resume → registry restart.

### 4. An abandoned notice lock permanently suppresses sharing disclosure — FIXED in 0.15.2 (6959496)

- **Severity:** fix-now.
- **Locations:** `packages/room-mcp/src/hooks-bridge.ts:66`, `packages/room-mcp/src/hooks-bridge.ts:81`, `packages/room-mcp/src/hooks-bridge.ts:227`, `packages/room-mcp/src/hooks-bridge.ts:239`, `plugins/room/hooks/common.mjs:78`.
- **Problem:** Both consumers use an exclusive lock file without stale-owner recovery, and the tool consumer interprets `EEXIST` as proof the hook delivered the notice.
- **Consequence:** If a process dies while holding the lock, the sharing notice can disappear indefinitely and the bridge retries its write every 150 ms. Lock contention is also not delivery evidence. **Inferred crash/abandoned-lock scenario.**
- **Smallest clean change:** Share a small lock/acknowledgement protocol with owner identity and stale-lock recovery; return “pending” on contention and regard only the matching delivered field as an acknowledgement. Test a pre-existing stale lock and a consumer dying before acknowledgement.

### 5. Background callbacks still have process-fatal escape paths — FIXED in 0.15.2 (bb936e8, 6959496, fa56a76)

- **Severity:** fix-now.
- **Locations:** `packages/relay/src/index.ts:384`, `packages/relay/src/index.ts:388`; `packages/roomd/src/index.ts:331`, `packages/roomd/src/index.ts:333`, `packages/roomd/src/index.ts:455`; `packages/room-mcp/src/workers.ts:530`; `packages/room-mcp/src/tools/files.ts:315`, `packages/room-mcp/src/tools/files.ts:338`; fatal policy at `packages/room-mcp/src/index.ts:186`.
- **Problem:** Relay takeover uses an unobserved `.finally()` promise, daemon observers discard async failures and `Promise.resolve(fn())` misses synchronous throws, Codex stdout does an unguarded synchronous log write, and archive piping omits an `extract.stdin` error handler.
- **Consequence:** A removed/unwritable Git directory, failing refresh, full log disk, or early tar exit/EPIPE can terminate the entire MCP process instead of failing one operation. The 0.14.1 callback-hardening pass did not cover these boundaries. **Inferred failure injection; not deliberately triggered.**
- **Smallest clean change:** Catch at each event boundary; use `Promise.resolve().then(fn).catch(report)` for the interval helper, observe takeover failures, guard log writes, and route pipe errors to the extraction operation's `fail`. Add fault-injection tests for these four boundaries rather than another happy-path timer test.

### 6. Carry/recovery still bypass the Git timeout boundary — FIXED in 0.15.2 (bb936e8, 7070f88)

- **Severity:** fix-now.
- **Locations:** `packages/roomd/src/baseline.ts:99`, `packages/roomd/src/baseline.ts:100`; `packages/room-mcp/src/workers.ts:328`, `packages/room-mcp/src/workers.ts:359`, `packages/room-mcp/src/workers.ts:371`, `packages/room-mcp/src/workers.ts:428`, `packages/room-mcp/src/workers.ts:633`, `packages/room-mcp/src/workers.ts:635`, `packages/room-mcp/src/workers.ts:666`; `packages/roomd/src/room-file.ts:9`; `packages/agent/src/cli.ts:35`. Existing deadline: `packages/roomd/src/git.ts:3`.
- **Problem:** All listed synchronous Git subprocesses omit a timeout, although the ordinary asynchronous Git helper has one.
- **Consequence:** The recent large-stdin freeze is fixed, but a stuck Git command or clean/smudge filter can still block the event loop, including watchdogs, wake delivery and shutdown. **Inferred remaining hang modes; the old stdin defect was not reproduced.**
- **Smallest clean change:** Route these calls through one bounded internal Git runner, preferably async for file work; at minimum use the same deadline policy everywhere. Do not disable checkout filters where they are needed for CRLF/content equivalence.

## Tidy

### 7. Resume bypasses the worker concurrency limit — FIXED in 0.15.2 (0b06299)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/workers.ts:94`, `packages/room-mcp/src/tools/workers.ts:138`, `packages/room-mcp/src/registry.ts:265`.
- **Problem:** Only fresh spawns check `maxWorkers`; resumed workers go straight to process creation.
- **Consequence:** Finished workers can all be restarted while the lead is already at its configured capacity. **Verified in-memory:** eight running records plus one retained worker became nine running records after resume.
- **Smallest clean change:** Use a shared launch-slot reservation for spawn and resume, counting in-flight starts as well as live workers; release it on failure. Test a resume at capacity and concurrent resumes.

### 8. Stopped-worker file counts reimplement—and violate—the carry rule — FIXED in 0.15.2 (bb936e8)

- **Severity:** tidy.
- **Locations:** divergent copy `packages/room-mcp/src/tools/scope.ts:21`; canonical rule `packages/roomd/src/baseline.ts:109`, `packages/roomd/src/baseline.ts:123`; correct consumers `packages/room-mcp/src/tools/collect.ts:273`, `packages/room-mcp/src/tools/files.ts:134`, `packages/room-mcp/src/workers.ts:669`; retirement's separate status count `packages/room-mcp/src/workers.ts:66`.
- **Problem:** `workerChangedCount` excludes every carried untracked path instead of only unchanged carried paths, and compares tracked files with HEAD rather than the worker's recorded delta base.
- **Consequence:** A stopped worker that edits only a carried untracked file, or commits its own output, can be described as having zero changed files; retirement's raw status count has the opposite problem for unchanged carried inputs. **Inferred UI results from the status commands.**
- **Smallest clean change:** Put worker-owned changed-path enumeration beside `workerBaseline`/`carriedUnchanged`, with explicit content/mode handling; use it for state and retirement. Do not introduce another carry predicate.

### 9. `link: []` does not fully disable `.roomlinks` — FIXED in 0.15.2 (bb936e8)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/workers.ts:23`, `packages/room-mcp/src/tools/workers.ts:108`, `packages/room-mcp/src/workers.ts:229`, `packages/room-mcp/src/workers.ts:415`.
- **Problem:** The link resolver correctly treats an explicit empty array as disabled, but `prepareWorktree` treats empty resolved exclusions as permission to read `.roomlinks` again.
- **Consequence:** A file named in `.roomlinks` can be excluded from carry even though the caller disabled links; it is neither carried nor linked. **Inferred from the two resolver paths.**
- **Smallest clean change:** Resolve links once in `resolveWorkerLinks`; pass an authoritative resolved list to preparation, distinguishing omitted input from an explicit empty list if the lower-level API still supports defaults.

### 10. Baseline read failures become false semantic evidence — FIXED in 0.15.2 (bb936e8, 6959496)

- **Severity:** tidy.
- **Locations:** `packages/roomd/src/baseline.ts:83`, `packages/room-mcp/src/graph-index.ts:166`, `packages/room-mcp/src/graph-index.ts:172`, `packages/room-mcp/src/conflicts.ts:224`, `packages/room-mcp/src/tools/combined-tree.ts:106`.
- **Problem:** Graph observations convert every failed baseline read to an empty old file; carried contract checks silently skip every failed read, while merge previews explicitly report missing private blobs.
- **Consequence:** The same missing object or filter failure can manufacture “added” signatures in one view, hide a contract change in another, and be an explicit error in collection. **Inferred error-path results.**
- **Smallest clean change:** Preserve a typed unavailable-base result from the baseline module; omit semantic claims and report degraded coverage until it can be read. Reserve empty old text for a verified absent path.

### 11. Stopping the hook bridge does not cancel in-flight wakes — FIXED in 0.15.2 (6959496)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/hooks-bridge.ts:189`, `packages/room-mcp/src/hooks-bridge.ts:250`, `packages/room-mcp/src/hooks-bridge.ts:295`, `packages/room-mcp/src/hooks-bridge.ts:309`.
- **Problem:** `stop()` clears observers and pending timers but there is no stopped/generation check in an active delivery retry loop.
- **Consequence:** A failed queue attempt can sleep, then wake an old thread and mark an old room message seen after the session has left or switched rooms. **Inferred asynchronous interleaving.**
- **Smallest clean change:** Give the bridge a cancellation generation or AbortSignal, check it before every queue/retry/state mutation, and test stopping while a queue attempt is pending.

### 12. A Claude session can fall through into Codex rollout discovery — FIXED in 0.15.2 (6959496)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/hooks-bridge.ts:271`, `packages/room-mcp/src/hooks-bridge.ts:280`, `packages/room-mcp/src/hooks-bridge.ts:284`; host resolver `packages/room-mcp/src/config.ts:109`.
- **Problem:** Missing/stale hook metadata triggers a Codex rollout scan unconditionally, regardless of the already-detectable process host.
- **Consequence:** A Claude session with no usable hook file can select a recent Codex thread for the same directory and queue a wake there, in addition to Claude's own router. **Inferred; no host session storage was inspected.**
- **Smallest clean change:** Determine the host before fallback discovery and run Codex discovery only for Codex; let the Claude router own Claude delivery independently of hook-file availability.

### 13. The “bounded” rollout fallback bounds depth, not work — FIXED in 0.15.2 (6959496)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/hooks-bridge.ts:355`, `packages/room-mcp/src/hooks-bridge.ts:360`, `packages/room-mcp/src/hooks-bridge.ts:372`; claim in `CHANGELOG.md:12`.
- **Problem:** Discovery recursively enumerates all entries within its depth limit synchronously, with no entry/time budget or cache, and its file descriptor is closed only on a successful read.
- **Consequence:** Large session histories can stall the MCP process every fallback poll; a read failure after open leaks a descriptor. **Inferred scale/error behavior.**
- **Smallest clean change:** Cache discovery per directory/start identity, cap entries/time, and close each descriptor in `finally`; prefer hook IDs. Keep this as a fallback, not an unconditional scan.

### 14. Path safety is repeated with materially different policies — FIXED in 0.16.6 (2f84af3)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/collect.ts:27`; `packages/room-mcp/src/tools/files.ts:196`, `packages/room-mcp/src/tools/files.ts:224`, `packages/room-mcp/src/tools/files.ts:247`; `packages/room-mcp/src/tools/combined-tree.ts:26`, `packages/room-mcp/src/tools/combined-tree.ts:78`; `packages/room-mcp/src/tools/context.ts:169`; `packages/room-mcp/src/workers.ts:223`, `packages/room-mcp/src/workers.ts:238`, `packages/room-mcp/src/workers.ts:628`; `packages/roomd/src/baseline.ts:109`.
- **Problem:** Lexical rejection and containment checks are copied across read, carry, recovery, mode and write paths, with different handling of backslashes, empty/dot components, `.git`, and symlink leaves.
- **Consequence:** Fixing traversal or platform behavior in one path does not protect the others; callers cannot tell which differences are intentional. This is a maintenance finding, **not a claimed demonstrated escape**.
- **Smallest clean change:** One repo-relative lexical validator and one containment helper, with explicit leaf policies (reject link, read contained link, replace link). Preserve collection's stricter no-symlink rule and preview's intentional leaf replacement.
- **Fix (0.16.6):** `packages/roomd/src/repo-path.ts` owns `validRepoPath` with named syntax presets, lexical `isInsideRoot`, and `containedRepoPath` with `reject-link`, `read-contained-link` and `replace-link` leaf policies; every listed caller uses it and characterization tests pin each one. One deliberate change: worker links recheck containment before copying, so a source retargeted outside after validation is refused. Kept as found: link inputs split on backslashes for validation while POSIX joins treat them as filename characters (conservative; recorded in the roadmap).

### 15. “Near” and scope coverage disagree on normalized paths — FIXED in 0.15.2 (6959496)

- **Severity:** tidy.
- **Locations:** `packages/shared/src/near.ts:5`; `packages/shared/src/ledger.ts:36`; `packages/room-mcp/src/tools/scope.ts:69`, `packages/room-mcp/src/tools/scope.ts:98`; directory/claim matching at `packages/shared/src/claims.ts:9`, `plugins/room/hooks/before-edit.mjs:75`; hook mirror `plugins/room/hooks/common.mjs:185`.
- **Problem:** Near matching normalizes dots/backslashes and treats `.` as the root, whereas scope matching and claim display use raw prefix comparisons.
- **Consequence:** **Verified with pure helpers:** `coversPath('.', 'src/a.ts')` is true, but `scopeCovers({paths:['.']}, 'src/a.ts')` is false; a root scope affects claim guidance but not declared-sharing eligibility or scope-based routing consistently.
- **Smallest clean change:** Define normalization once in shared code, then separate directional containment from symmetric overlap and use the appropriate operation everywhere. Keep the dependency-free hook mirror generated or parity-tested; do not replace directional sharing checks with symmetric overlap.

### 16. Claim tools and hook snapshots separately assemble proximity evidence — FIXED in 0.16.8 (bd75ea3)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/claims.ts:24`, `packages/room-mcp/src/hooks-bridge.ts:219`, `packages/room-mcp/src/tools/scope.ts:96`.
- **Problem:** Scope paths, claims and changed paths are flattened into “nearby work” independently by the claim tool and hook bridge, while state visibility builds another partial version.
- **Consequence:** A new evidence source or filtering rule must be added in several places, and `room_state` can hide a participant whose changed paths alone caused the claim hook to warn. **Inferred visibility mismatch from `inView`.**
- **Smallest clean change:** Add one `coordinationPaths(room, excludingParticipant)` builder beside shared near policy; use its output for claims, hook snapshots and state overlap selection.

### 17. Git-private state path resolution has several implementations — FIXED in 0.16.6 (6b12cc8)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/hooks-bridge.ts:22`, `packages/room-mcp/src/config.ts:125`, `plugins/room/hooks/common.mjs:22`, `packages/roomd/src/room-file.ts:8`; carry-record path assembly at `packages/room-mcp/src/workers.ts:341`, `packages/room-mcp/src/workers.ts:359`, `packages/room-mcp/src/workers.ts:371`.
- **Problem:** Hook/config code hand-parses `.git`, room metadata shells out to Git, and carry stop-state helpers duplicate common-directory resolution and filenames.
- **Consequence:** Worktree/subdirectory handling, error policy and timeout fixes drift; a function named `sessionMetadataPath` is another general Git-directory resolver in disguise.
- **Smallest clean change:** Establish one worktree-private and one common-Git-directory resolver in roomd, plus a shared carry-record accessor. Generate or parity-test the dependency-free hook equivalent.
- **Fix (0.16.6):** `packages/roomd/src/git-dirs.ts` owns the worktree-private and common Git-directory resolvers and the carry-record accessor; the hook copy in `plugins/room/hooks/common.mjs` stays dependency-free and a parity test runs both over the same fixtures. One deliberate change: a gitfile with an empty `gitdir:` now falls back to `<dir>/.git` everywhere instead of the checkout root in hooks and excludes.

### 18. Worker launch orchestration is still split between spawn and resume — FIXED in 0.16.7 (471ceb3, ff52d69, 38e7b35, 392756b); 0.15.2 had shared the launch slot and exit path (0b06299)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/workers.ts:149`, `packages/room-mcp/src/tools/workers.ts:155`, `packages/room-mcp/src/tools/workers.ts:169`, `packages/room-mcp/src/tools/workers.ts:175`; `packages/room-mcp/src/registry.ts:288`, `packages/room-mcp/src/registry.ts:295`, `packages/room-mcp/src/registry.ts:303`; shared command builder `packages/room-mcp/src/workers.ts:196`.
- **Problem:** CLI argument construction is shared, but environment selection, priority wrapping, log paths, handle registration and exit/error callbacks are assembled twice, with resume silently swallowing exit-processing errors that spawn logs.
- **Consequence:** The sharing/cap omissions above are symptoms of two launch policies; future host/session-capture fixes can land in only one path.
- **Smallest clean change:** Extract a lifecycle launcher that receives fresh-versus-resume command options and a fully resolved policy record; keep worktree creation separate. Use one callback/logging implementation and verify both modes through it.

### 19. Graph snapshot reuse left an unread option and stale test distinctions — FIXED in 0.15.2 (91a2610)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/graph-index.ts:69`; callers `packages/room-mcp/src/session.ts:410`, `packages/room-mcp/src/session.ts:466`; tests `packages/room-mcp/test/graph-index.test.ts:207`, `packages/room-mcp/test/graph-index.test.ts:226`, `packages/room-mcp/test/graph-index.test.ts:249`, `packages/room-mcp/test/graph-index.test.ts:264`.
- **Problem:** `opts.present` is never read, but production constructors and peer-state test variants still pass it.
- **Consequence:** Tests named around offline/stale peer eligibility imply a selection path that no longer exists; the constructor and callers advertise dead behavior.
- **Smallest clean change:** Delete the option and its caller arguments; retain one strong “always builds locally despite a tempting peer snapshot” test and the independent import-update regression.

### 20. Replaced designs leave unused public helpers and a stale message predicate — FIXED in 0.15.2 (6959496, 91a2610)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/choice.ts:109` and tests `packages/room-mcp/test/choice.test.ts:25`; `packages/relay/src/index.ts:150`, `packages/relay/src/index.ts:161` and `packages/relay/test/relay.test.ts:100`; `packages/shared/src/identity.ts:44`; `packages/shared/src/doc.ts:460`; actual registry `packages/shared/src/messages.ts:50`.
- **Problem:** `chooseServer` has test-only callers, old port/relay probes survive only in tests, `sameParty` has no direct callers, and unused `isMsgType` maintains a hand list that omits `merge-conflict`.
- **Consequence:** The exported API suggests multiple authorities for configuration, relay admission and message kinds; the stale predicate would reject a real kind if reused. Repository searches found no production consumers; **external consumers are unknown**.
- **Smallest clean change:** Move test probes to test helpers, test `resolveConfig` directly, remove unused internal exports, and derive any retained message predicate from `MessageKinds`. Check intended external API compatibility before removal.

### 21. One overlay event schedules refresh of every changed source path — FIXED in 0.16.8 (06c3697)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/graph-index.ts:78`, `packages/room-mcp/src/graph-index.ts:128`, `packages/room-mcp/src/graph-index.ts:146`, `packages/room-mcp/src/graph-index.ts:119`.
- **Problem:** Initial indexing uses eight workers, but incremental events enumerate all current and previous changed paths and immediately start one refresh per path.
- **Consequence:** An edit to one file can reread/reparse unrelated changed files and launch many Git reads concurrently; the initial-build concurrency limit does not protect the hot path. **Inferred workload amplification, not a benchmark claim.**
- **Smallest clean change:** Extract affected paths from Yjs events, retain explicit removal handling, and route all refreshes through the same bounded queue. Test that changing one overlay does not refresh unrelated files.

### 22. The carried-path cache survives sessions and caches failed promises — FIXED in 0.15.2 (bb936e8)

- **Severity:** tidy.
- **Locations:** `packages/roomd/src/baseline.ts:34`, `packages/roomd/src/baseline.ts:39`.
- **Problem:** `committedPaths` is a process-global, unbounded SHA-to-promise map that never removes rejected reads.
- **Consequence:** Long-running processes retain entries for deleted workers, and a transient read failure poisons that SHA for later attempts, even from another available checkout. **Inferred lifetime/failure behavior.**
- **Smallest clean change:** Scope the cache to a session or bound it; evict rejected promises and account for repository availability in its key/lifecycle.

### 23. Git filename parsing is not consistently NUL-framed — FIXED in 0.15.2 (bb936e8, 6959496)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/files.ts:215`, `packages/room-mcp/src/tools/combined-tree.ts:66`, `packages/room-mcp/src/graph-index.ts:108`, `packages/roomd/src/git.ts:193`; sound examples `packages/roomd/src/git.ts:157`, `packages/room-mcp/src/tools/combined-tree.ts:62`.
- **Problem:** Some path lists use newline splitting and Git's quoted presentation, while `gitTreeModes` splits a NUL-framed tree entry at every tab and truncates a path containing a tab.
- **Consequence:** Legal paths with tabs, newlines or quoted characters can lose modes, be missed by indexing, or appear under a nonexistent quoted name. **Inferred unusual-filename cases.**
- **Smallest clean change:** Use `-z` for every machine-read path list and split tree metadata at the first tab only; share parsers and add round-trip filename tests.

### 24. A fallback merge is still advertised as Git's result — FIXED in 0.15.2 (6959496, bb936e8)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/merge.ts:28`, `packages/room-mcp/src/merge.ts:46`, `packages/room-mcp/src/merge.ts:58`, `packages/room-mcp/src/merge.ts:66`; `packages/room-mcp/src/tools/combined-tree.ts:123`.
- **Problem:** The merger falls back on setup errors, malformed output and output-limit failures as well as missing Git, but returns no algorithm/degradation field and every preview labels itself “merge algorithm: git”.
- **Consequence:** A user can receive a clean fallback preview under an assurance the actual Git merge was used; the once-only stderr warning is not part of that result. **Inferred fallback case.**
- **Smallest clean change:** Return the algorithm and fallback reason, surface them in preview output, and propagate operational failures where fallback would conceal missing evidence. Add a timeout to this asynchronous Git invocation too.

### 25. Versions and wake guidance have multiple stale authorities — FIXED in 0.15.2 (91a2610)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/index.ts:80` (`0.2.0`); `packages/room-mcp/package.json:3`, `package.json:4` (`0.1.0`); plugin manifests `plugins/room/.codex-plugin/plugin.json:3`, `plugins/room/.claude-plugin/plugin.json:3` and `.claude-plugin/marketplace.json:13` (`0.15.1`). Wake prose: `README.md:215`, `packages/room-mcp/src/hooks-bridge.ts:7`, `packages/room-mcp/src/hooks-bridge.ts:286`, `packages/room-mcp/src/prompt.ts:20`; behavior `packages/room-mcp/src/wake-path.ts:115` and Windows requirement `README.md:212`.
- **Problem:** The MCP handshake advertises an unrelated old release, README still describes five-second coalescing without the immediate first wake, bridge comments/logs say Claude delivery is via channel, and the generated update hint omits the documented native-Windows minimum.
- **Consequence:** Diagnostics identify the wrong release and guide readers toward the wrong timing/transport or insufficient Windows version. Historical changelog entries were not treated as current promises merely because behavior later changed.
- **Smallest clean change:** One release-version input for manifests/handshake (document separately versioned packages if intentional), and one current wake-policy description covering immediate-first batching and platform minimums. Reconcile prose with the existing router, without changing the frozen Codex hook manifest.

### 26. Follow-up and no-pipe tests leave the recent integration seams untested — FIXED in 0.15.2 (0b06299, 91a2610, 7070f88)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/test/workers.test.ts:1296`, `packages/room-mcp/test/workers.test.ts:1316`, `packages/room-mcp/test/workers.test.ts:1334`; `packages/room-mcp/test/carry-no-pipe.test.ts:35`.
- **Problem:** Resume tests use mocked process exits and default sharing, assert assembled flags, and never reload persisted stop state or exercise capacity; the large-carry test checks a recorded path and lack of stdin, not equality of the carried large bytes/tracked patch.
- **Consequence:** The sharing/stop/cap defects above pass the follow-up suite, and dropping tracked carry entirely would still pass the first no-pipe test. Other carry/collection tests provide useful coverage, so this is not a claim the whole suite is hollow.
- **Smallest clean change:** Add the missing cross-boundary resume scenarios with real temporary Git metadata and a fake executable; assert large tracked and untracked contents and `carryFailed` as well as the no-stdin invariant. Replace fixed-delay exit coordination with an explicit test-controlled handshake where practical.

### 27. Cleanup's “restored” worktree is not a restored snapshot — FIXED in 0.15.2 (bb936e8)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/workers.ts:592`, `packages/room-mcp/src/workers.ts:614`, `packages/room-mcp/src/workers.ts:624`, `packages/room-mcp/src/workers.ts:627`, `packages/room-mcp/src/workers.ts:635`, `packages/room-mcp/src/workers.ts:641`.
- **Problem:** If cleanup fails after force-removing a worktree, rollback recreates branch HEAD plus spawn-time carried untracked blobs, not its removed uncommitted output; blob restoration also uses the default synchronous maxBuffer despite carry accepting files up to 5 MB.
- **Consequence:** The error says “restored” for a different tree, and a valid larger carried file can make recovery itself fail. Collected output may still exist in the lead, and discard has a recovery patch, so this is **not a claim all output is necessarily lost**. **Inferred late-cleanup failure.**
- **Smallest clean change:** Keep a reversible snapshot until all destructive cleanup steps succeed, or explicitly report a reconstructed base and the actual recovery location; use the bounded binary Git reader for restoration. Inject a failure after worktree removal in tests.

### 28. The tool split retained an implicit, order-dependent service locator — DEFERRED (roadmap)

- **Severity:** tidy.
- **Locations:** `packages/room-mcp/src/tools/context.ts:361`, `packages/room-mcp/src/tools/context.ts:388`, `packages/room-mcp/src/tools/index.ts:46`; lifecycle responsibilities in `packages/room-mcp/src/workers.ts:319`, `packages/room-mcp/src/workers.ts:522`, `packages/room-mcp/src/workers.ts:583`.
- **Problem:** Handler state begins with dozens of `undefined!` services filled by ordered installers, retains orphaned comments from the old monolith, and the worker utility module still mixes launch, Git snapshots, recovery, links and process identity.
- **Consequence:** Typechecking cannot prove the state is fully initialized before handlers use it, and lifecycle changes cross modules in ways that produced the spawn/resume drift above. This is a concrete dependency problem, not a finding based only on line count.
- **Smallest clean change:** Remove orphaned comments; construct typed worker lifecycle and coordination services before composing handlers, reducing installer mutation in small steps. Split worker Git snapshot/recovery from process launch/identity along their existing function boundaries; avoid a wholesale rewrite or speculative host-adapter expansion.

## Verified clean

- **Central carry semantics substantially hold up.** `workerBaseline`, `pairBaseline`, `baselineText` and `carriedUnchanged` are shared by preview, collection and conflict paths. Focused tests cover opposite caller directions, carried untracked content and modes, CRLF, missing private blobs and preservation of the lead's later edits. The remaining state-count copy is finding 8.
- **The recent synchronous large-stdin fix is present in both source and shipped bundle.** Regular files are hashed by filename; tracked patches are applied from a temporary file. The bundle contains both changes (`plugins/room/server/room-mcp.mjs:24658`, `plugins/room/server/room-mcp.mjs:32030`); it was not falsely flagged stale just because the fix followed the version-bump commit. Deadline coverage remains finding 6.
- **Carry ref naming is centralized.** `carryRef`/`carriedUntrackedRef` in `packages/room-mcp/src/workers.ts:321` own the source spellings and their create/delete/restore uses; the private untracked base is not another ordinary worker branch. No second source definition was found.
- **Preview and apply collection share one combined-tree engine.** The collection suite passed real temporary-repository checks for conflict refusal, ignored-output retention, symlink-safe materialization, file modes, binary additions and the UTF-8 regression. These tests exercise resulting files, not just messages.
- **Message routing and presentation have a real shared registry.** The shared message and view suites passed. The unused `isMsgType` list is a leftover, not evidence that the main routing path has duplicated policies.
- **Parser regressions are substantive.** All four selected parser suites passed against shipped grammars, including structural signatures and language-specific definitions/imports. This does not claim type resolution or eliminate the documented name-based graph limitations.
- **The hook/shared overlap mirror has an explicit parity test** (`packages/room-mcp/test/hooks.test.ts:973`); maintaining a dependency-free hook copy is understandable. The unnormalized scope/claim paths, rather than the existence of that mirror alone, are the problem in finding 15.
- **Channels and transcript fallbacks are not automatically dead code.** The channel path remains selectable through `ROOM_WAKE=channels`/automatic fallback, and transcript refresh is bounded to a 64 KB tail and cached by transcript metadata. Their continued existence is documented in 0.15.0; rollout discovery's separate host/work bounds are findings 12–13. No host version assumptions were checked online.
- **Sharing wording has a canonical production helper.** Tool replies use `sharingDescription` in `packages/room-mcp/src/config.ts:50`; repeating its explanation in README is not another executable policy. Invalid share values fail toward intent, and collection's full local disk access is explicit in its engine call.
- **Plugin release metadata agrees at 0.15.1**, and explicit old model strings in generic override tests are not themselves stale model defaults. The MCP handshake discrepancy is identified separately in finding 25.
