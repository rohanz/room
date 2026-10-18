# Astra port review, round 1 — 2026-09-29

Reviewed `cdce917` (including `1924dda` and merge `5a87063`) against main `73866e6`, the changes since `8097a8b`, and redesign `dbcfdb3`. This is a read-only review: no source or test files were changed. The port is **not ready to sign off**: the particular overlay-diff stall is addressed, but the stronger claim that the 0.17 readers/publisher cannot stall is false.

## Findings

1. **must-fix — The “bounded” merge still invokes unbounded node-diff3 on cheap-to-diff, repetitive input.** `packages/room-mcp/src/merge.ts:75`, `packages/web/src/merged.ts:185`.

   A successful bounded `diffLines` probe does not bound the following, different LCS algorithm in `diff3Merge`. Repeated lines have tiny edit distance but huge matching-equivalence classes. The actual web `classifyThreeWay` with `base = 'same\n'.repeat(4000)`, `a = base + 'a\n'`, and `b = 'b\n' + base` blocked for **55,027 ms**, with a scheduled timer never serviced during the call. The base is only **20 KB**. At 1,000 repeated lines the web call took 818 ms; the real MCP `gitMergeFile` fallback, with Git made unavailable, took 835 ms and likewise serviced no timer. These are calls into the checked-out implementation, not a substitute merge implementation. Throwaway probes: `/tmp/astra1-cpu-probe.mts` and `/tmp/astra1-merge-small.mts`.

   The 800-line unrelated-rewrite tests only exercise the rejected-probe branch. They do not exercise this admitted-but-expensive input. A browser can freeze outright; an MCP fallback can prevent every subsequent tool call/heartbeat from running. **Fix:** bound the actual merge algorithm, construct merge hunks from the already bounded diffs, or conservatively return exact whole-file alternatives when the LCS matching work would exceed a budget. A bound on edit distance alone is insufficient. Add repeated-line, small-edit regressions for both paths. A timeout checked after the synchronous call is insufficient. Row: **40a/readers**.

2. **must-fix — Claim reanchoring still performs quadratic synchronous hashing, and the newly ported disk path has no file-size bound.** `packages/roomd/src/reanchor.ts:26`, `packages/roomd/src/reanchor.ts:36`, `packages/roomd/src/index.ts:940`.

   For each claim whose original block is absent, `reanchorClaims` slices, joins, and SHA-256 hashes every window of the claim's width. Work is proportional to claims × candidate windows × window bytes. `reanchorOwnClaims` first reads every relevant regular file synchronously and without checking a size cap, then invokes this loop without yielding. The regular-file/safe-path checks do not impose a byte/work bound.

   A direct real-function probe with a half-file claim and replaced content took 112 ms for 4,000 lines, 429 ms for 8,000, and **2,057 ms for 16,000 lines / 436,890 bytes**, with no timer serviced. That last file is within the default 512 KiB publication cap; files on the new disk-read path need not even respect that cap. The core reanchor algorithm predates this port, but retaining it fails the expressly requested 0.17 stall audit. **Fix:** bounded asynchronous reads and a cancellable/yielding reanchor algorithm; use inexpensive rolling-window candidate filtering before exact verification, with a total work budget. If a claim cannot be checked within the budget, retain it with explicit uncertainty/retry rather than falsely releasing it. Guard the eventual transaction against changed inputs/fence. Rows: **38a**, **40a audit**.

3. **must-fix — A detected HEAD transition remains certified complete throughout the new autostash wait.** `packages/roomd/src/index.ts:750`.

   `pollHead` now awaits `waitForGitOperation(head)` before replacing publication inputs, setting `transitionPending`, and marking the manifest incomplete at lines 752–756. The comment immediately below still promises “before any awaited work.” Reporooms §B2 step 1 (`2026-09-28-reporooms.md:260`) and manifest §5.4 require readers to stop trusting complete coverage during the transition. The new wait can last five seconds; if Git remains busy it throws before invalidation, leaving the old manifest complete across retries.

   Probe `/tmp/astra1-publication-probe.mts` started a real local-room daemon over a temporary Git repository, committed a new HEAD, and gated `waitForGitOperation` inside a queued `pollHead`. At the gate the manifest still said `complete: true`, `coverage: all`, and the old base. This is a port regression from the previous transition ordering. **Fix:** invalidate prior scan inputs and mark the publishing incarnation incomplete as soon as the transition is recognized, before waiting for Git to settle. Keep claims/base/entries in the existing final atomic transaction. Add an assertion during a held `MERGE_AUTOSTASH` wait and after a busy timeout, not only after a successful pull. Row: **38a**; redesign regression: **B2/manifest completeness**.

4. **must-fix — Teammate diff reads can compare a new manifest version against a previously captured base.** `packages/room-mcp/src/tools/files.ts:102`, `packages/room-mcp/src/tools/files.ts:114`, `packages/room-mcp/src/tools/files.ts:126`; `packages/room-mcp/src/tools/state.ts:101`.

   `readDiff` captures `theirBase` once, then calls `readVersion`. The latter independently snapshots and retries after a semantic revision change. It can successfully return text/base from the *new* manifest, while the diff still loads the *old* Git base. The all-files loop additionally captures paths separately, obtains another snapshot per file, yields between files, and finally reads current coverage. This violates manifest invariant 13's one immutable snapshot per participant per operation and can reproduce the very “their already committed code is shown as edits” symptom fixed in 39b.

   Probe `/tmp/astra1-diff-base-race.mts` uses two real commits and the real file handler, with the injected `readVersion` seam advancing Ben from the old base to the new committed text while awaiting. It returns `-old committed / +new committed`, despite no uncommitted change, and labels the old base as Ben's base. The seam models the retry in the actual `readVersion`; this is not a live-network race reproduction. **Fix:** derive base, paths, text, explanatory note, and coverage from one captured snapshot; check it at operation end and retry the whole operation, or return updating. Do not retry only the text read. Add transitions during single-path and multi-path diffs. Row: **39b**; redesign regression: **manifest invariant 13**.

5. **must-fix — Many-file work outside the yielding diff-preparation loop remains unbounded, including a quadratic publication path.** `packages/roomd/src/publisher.ts:127`, `packages/roomd/src/publisher.ts:134`, `packages/roomd/src/publisher.ts:203`.

   The new yields at `publisher.ts:187` help preparation, but do not cover the following:

   - `applyInputs` repeatedly searches the facts array while iterating excluded/overlay paths (`facts.some`), then synchronously republishes metadata and withdraws text. A real `Publisher.applyInputs` probe over 5,000 and 15,000 one-byte published files took **156 ms and 1,034 ms**, respectively, without servicing a timer. Total text for the larger case was only 15 KB. Probe: `/tmp/astra1-many-probe.mts`. Per-file and total-text byte caps cannot bound path count or this quadratic work.
   - `policy.ts:96` sorts/plans/hashes all excluded paths synchronously. `publisher.ts:203` synchronously stats/checks every text path before apply; `publisher.ts:222` and `manifest-publish.ts:45` construct/compare/write all metadata and apply every prepared text change in one turn. Declared/ignored paths can grow independently of the text-byte budget. The requirement to apply atomically is real, but does not make this amount of synchronous work bounded.
   - `packages/room-mcp/src/tools/files.ts:475` synchronously materializes every merged file for preview. `conflict-set.ts:446` has cached, carried, held, and unreadable branches that bypass its only merge-loop budget call at line 482; immediate promise continuations do not yield to timers/I/O.
   - `packages/shared/src/manifest.ts:73` copies every entry and every overlay's full text synchronously per snapshot. `graph-index.ts:325`, `:337`, `:355`, and `:508` repeatedly request such snapshots while indexing individual files. Its parse-size guard is also after `ownText`'s uncapped `readFileSync` at line 309. The graph's existing parse/edge yields do not bound those reads/snapshot copies.
   - The carry path retains another known aggregate stall: `worker-git.ts:252`/`:255` checks every carried hash synchronously through `carriedContentHash` (`roomd/src/baseline.ts`), twice per attempt. Individual Git command timeouts bound each command, not the event-loop delay over the entire list. This is retained behavior, not a new claim that 0.16.40 fixed worker carry.

   **Fix:** use indexed membership rather than `facts.some`, prepare metadata and filesystem work in guarded yielding batches, and put yielding budget checks at the top of every many-file loop (including fast/skip branches). Cache immutable snapshots by revision rather than repeatedly copying a whole participant for one path; cap bytes before reading graph disk text. Preserve the required atomic apply: bound the total operation count/entry count accepted for a transaction, or use a spec-approved prepared-generation swap. Do not simply split the transaction and violate §5.3. Add responsiveness tests around policy narrowing, metadata-only/held files, cached conflicts, graph snapshots, and preview materialization, not just diff preparation. Rows: **40b**, **40a audit**.

6. **should-fix — Several upstream regression assertions were dropped rather than faithfully adapted.** `packages/room-mcp/test/workers-room-move.test.ts:58`, `packages/room-mcp/test/hook-port.test.ts:120`, `packages/room-mcp/test/declared-retained-read.test.ts:64`, `packages/room-mcp/test/timing.test.ts:299`.

   Comparing the named tests with `git show origin/main:<path>` finds these concrete losses:

   - **35d:** `workers-room-move.test.ts` now has two tests. Main's cases for workers-room shutdown failure, spawn requested during a move, move requested during spawn preparation, and move requested during discard are absent. Manually setting `phase: 'retired'` is not a replacement for the collect/discard serialization test. The send case still verifies the final destination, but its immediate pre-release assertion no longer proves it stayed blocked over an event-loop turn.
   - **36a:** main's specific “`room_spawn where=local` from a team room refuses another repository” test was removed from `workers.test.ts`. The replacement covers an already-local lead and an ordinary team-room outside spawn, but not that destination-changing seam. The code's check of the chosen session appears correct; the missing cross-mode regression should still be restored.
   - **37e:** main's “`room_wait` says ready to collect when the worker's process has exited” case was removed. The surviving still-exiting case also reduces its assertion from the full “`room_collect waits up to 15 s`” wording to a substring. Both branches remain implemented, but the two-way distinction is no longer fully tested.
   - **38b:** the new 83-case suite carries the broad classifier table and five file-operand cases, but omits main's branch-checkout negatives, most redirected file-operand cases, the eleven “warns and records the first file operand” cases, and the exact redirect-output/operand assertions. The missing cases include BSD `sed -i ''`, `sed -f`, multiple operands, `git restore -s HEAD --staged --worktree`, PowerShell move/rename source operands, and shell `apply_patch` heredocs. `hooks.test.ts:328` retains a reduced parser test, omitting main's exact multi-operand/patch-move and 20,001-character checks. A generic “warned somewhere” assertion does not prove the correct file's write intent was recorded.
   - **39a:** the replacement retained-read test no longer invokes `room_preview_merge` after `room_done`, no longer restores the deleted retained file to verify withdrawal, and replaces current-authority narrowing with a legacy-key stale overlay (`setOverlay('Owner', ...)`, rather than the active incarnation). Main's removed presence cap/coalescing tests are legitimately obsolete, but retained preview inclusion and refusal of stale text during narrowing still matter. The separately cited hashless-held preview test does not exercise retained-after-done preview.
   - **38e:** the upstream timed-join assertion requiring `connect 50ms, sync 2100ms, daemon start 900ms` was reduced to `sync 2100ms.*daemon start 900ms`. The source has a connect phase, so there is no architectural reason to remove its assertion.

   The implementation for the shell classifier and move queue is present; these are coverage findings, not invented observed behavior failures. **Fix:** bring over the omitted cases using registry identities and manifest authority, preserving the behavioral assertions. Use explicit barriers rather than arbitrary short sleeps for ordering. Keep obsolete legacy mechanics removed, but exercise their surviving user-facing guarantees. Rows: **35d, 36a, 37e, 38b, 38e/join, 39a**.

7. **should-fix — The load-hardening claim is incomplete: claim tests bypass the production queue, and worker fixtures still mix synthetic processes with real liveness.** `packages/roomd/test/head-claims.test.ts:185`, `packages/room-mcp/test/workers.test.ts:1578`, `packages/room-mcp/test/registry-fixture.ts:98`.

   In the full roomd/shared run, “keeps an edited claim when an autostash pull changes other lines in the same file” and “waits out an in-progress autostash before deciding whether to release a claim” failed with `StalePublication: publication inputs changed during prepare`, from `Publisher.prepare` through `pollHead`. The isolated head-claims rerun passed **17/17**. `pulledClaim` directly calls the private `pollHead` while the watcher can enqueue work; other portions of this file already use the queued `pollHead` helper. The claimed adaptation to queued polling is only partial. This is a harness race, not evidence that the production serialized transition is inherently broken.

   The lead also reported full-suite-only failures of the preexisting-checkout and other-lead-tag cases. Both passed in my broad workers run. The latter seeds PID 4242 with `startTime: 'fixture:unknown'` via `registerWorkers`, whose executable comes from real `probeProcess`; it is not added to `setupLead`'s synthetic live set. Registry/projector code can consequently receive different process evidence than the tool fixture. A real PID collision is possible, and sandbox process inspection is separately unavailable. The former is intended to test migration of an already existing checkout and should explicitly await/assert the imported registry fact, not infer migration completion from setup ordering. I did not reproduce a production duplicate launch or tag theft from these reports.

   My broad workers run additionally failed the port-release test while waiting for its synthetic kill callback and the retained-dirty-worker preview test at final discard (`no worker finished owned by you`). Both passed on a focused rerun, together with the two cases the lead reported: **4/4**. These strengthen the fixture-isolation concern; they do not justify changing lifecycle expectations to accept premature retirement.

   **Fix:** route all test HEAD transitions through the existing queued helper and wait for the relevant settled publication. Give all lifecycle readers/projectors a single deterministic process-identity/liveness fixture; never probe the host for made-up PIDs. Explicitly synchronize the migration fixture. Preserve the restored registry §6 row 8 “reported but alive is running” assertions. Rows: **38a, HARDEN**.

8. **should-fix — The approved fresh no-report behavior still contradicts the normative registry table.** `docs/superpowers/specs/2026-09-28-registry.md:339`.

   Row 13 says every witnessed exit 0 without a report is `failed`. `worker-status.ts:101` now intentionally returns `done + noReport` for a fresh run. I asked rohanz rather than treating this as an unauthorized design change. The lead explicitly confirmed the fresh-run exception is approved by the port brief, and only resumed workers must retain rows 12/15. Source ordering correctly preserves row 8 (live process wins), late report replacement, and the resumed rules. The port table says an exception is required but does not amend the spec.

   **Fix:** amend §6 row 13 to distinguish fresh witnessed exit 0 (`done`, `noReport`, “ended without a report”) from resumed exit 0 with no prior report (`failed`), retaining the first-match ordering and earlier-report resume cases. This is a documentation reconciliation, not a request to revert working behavior. Row: **36b**.

9. **nit — HEAD retry/backoff is a fourth conflict/adaptation that the verdict table silently calls a full port.** `docs/superpowers/specs/2026-09-29-port-0.16.35-40.md:17`, `packages/roomd/src/publisher.ts:143`.

   Main's 0.16.37 HEAD-reconcile behavior includes the retained retry/backoff behavior; tracked refresh has its own coalesced poll backoff. The redesign instead logs each distinct publisher error once and retries dirty publication on a fixed 5-second tick (`publisher.ts:143–154`). This is exactly what manifest §5.3 (`2026-09-28-manifest.md:323`) specifies: the old backoff timer goes. It is therefore an intentional, justified conflict, not missing implementation. The table currently claims only three conflict parts and does not tell the reader that this sub-behavior of 37b was superseded.

   **Fix:** mark the HEAD retry/logging portion of 37b as adapted/CONFLICT against manifest §5.3, distinguish it from tracked-poll exponential backoff, and update the totals. Keep the fixed-tick/distinct-message tests. Row: **37b**.

10. **should-fix — Some main join diagnostics were silently dropped; the real already-joined path is also unattributed.** `packages/room-mcp/src/session.ts:751`, `packages/room-mcp/src/session.ts:756`, `packages/room-mcp/src/session.ts:768`, `packages/room-mcp/src/timing.ts:87`.

    Main wraps both HTTP preflight calls and `serverShareMax` in the preflight phase; the port calls them directly. The tool handler times its separate admission check, which does not account for these later requests or the direct `joinSession` path. `startAutoTaggedRoomd` also records `name`, but the join phase formatter does not list it, so name acquisition is reported as other. The reduced helper-level test in finding 6 does not establish coverage of a real join.

    Additional lead-supplied evidence: `room_join {where: 'team', share: 'full'}` after startup auto-join logged `slow tool room_join 3230ms: settle 0ms, resolve 27ms, other 3203ms`. I checked with the lead: this was `currentReply`, **not a fresh join**, so it is not proof that fresh connect/sync instrumentation is absent. It shows the common share/disclosure/state/view-token path also has no meaningful attribution.

    **Fix:** restore timing around the actual session preflight/share-limit requests, report the measured name phase, and label the already-joined share/state work. Add a delayed real-handler/direct-session test rather than relying only on the daemon-start helper. Rows: **38e/join**, related **37a**.

## Verification and remaining limits

All commands unset `ROOM_TAG`, `ROOM_OWNER`, and `ROOM_SERVER`. Tests were limited to at most three concurrent workers/probe processes. `nice -n 10` was attempted but this sandbox refused `setpriority`. Throwaway probes and logs were written only under `/tmp`.

- Roomd + shared: **409 passed, 3 failed, 53 files**. Two failures are finding 7's claim race; one is `packages/roomd/test/local.test.ts` failing to listen on loopback (`EPERM`). Every other roomd/shared file passed, including publication-reconcile, head-transitions, poll, takeover-poll, skip-log, shared text-diff/anchors/messages/views. Head-claims isolated rerun: **17 passed**.
- Focused port batch 1 (`hook-port`, `stale-version`, `timing`, `non-repo`, `room-move`, `workers-room-move`): **147 passed, 3 failed**. The three failures are MCP subprocess startup using this worktree's absent `node_modules/.bin/tsx` (`ENOENT`); the parent checkout provides dependencies for normal in-process tests. No symlink or repository dependency files were added.
- Focused port batch 2 (`config`, `join`, `workspace`, `carry-wip`, `collect`, `worker-status`, `registry`, `resume`, `watcher-exclusions`, `skills`, `diff-teammate-base`, `declared-retained-read`, `bounded-reader-diff`, web `merged` and `lifecycle`): **271 passed / 15 files**.
- Full MCP/web (`npx vitest run packages/room-mcp/test packages/web/src --maxWorkers=1 --pool=threads`): **1,764 passed, 68 failed, 8 skipped; 128 passing / 18 failing files; 2 unhandled EPERM errors**, 868.77 s. Log: `/tmp/astra1-mcp-web-tests.log`. All web suites passed. Socket-backed failures affect `auto-join`, `hook-fixes`, `hooks`, `login`, `local`, `names`, `names-join`, `post`, `publisher-join`, `room-move-real`, `room-move-server`, `same-checkout`, `session-takeover`, `socket-wake`, and `wakes-audit`. The wedged-relay auto-join case and login setup time out after their listener fails. `non-repo` and one auto-join logger case also encounter the absent worktree-local `tsx`. `auto-tag` hits watcher `EMFILE`. Six worker lifecycle assertions encounter synthetic/host-liveness disagreement; two additional worker failures pass in isolation as described in finding 7. These results are not a green full-suite run.
- Hooks/wakes diagnostic rerun: **104 passed, 16 failed**. Thirteen endpoint/wake cases fail `listen EPERM 127.0.0.1`; two SessionStart ancestry assertions cannot observe this sandbox's parent process identity; one hook-state output assertion remained empty in this failure run. A further isolated rerun of the three hook-state/paused-state cases passed **3/3**. The classifier/receipt port suite itself passed in the focused batch. A passing isolated helper does not certify a socket-backed path that this runner cannot execute.

The probe timings are observed on this machine under test load, not performance thresholds. The decisive evidence is the unbounded algorithms and absence of an event-loop turn, not a promise that every machine takes the same milliseconds.

Frozen-manifest check: `git diff dbcfdb3 HEAD -- plugins/room/hooks.json plugins/room/hooks/claude.json` is empty. Both files are unchanged as required.

## Spec/behavior checks beyond the findings

The three declared conflicts are real: reporooms §B1–B2 replaces branch-following with repository-room identity; registry §17 uses SessionStart ancestry for Codex CLI and leaves shared app-server binding absent; ledger wake invariants require sender/kind pointers without content. The claim-release history still contains path/range, while wake text does not. No content-bearing wake regression was found in source.

The OBSOLETE implementation arguments are sound: forced discard stages the tree and excludes carried/linked paths from the resulting diff (registry §10); spawn enumerates durable registry records rather than running Git in finished worktrees (§3); retained sessions resume until retirement (§8); manifest authority and PolicyStore retention replace awareness-list read authority (§5.2/§6). Their available regression suites pass. Finding 6 qualifies retained-read coverage.

Repository preflight distinguishes absent/bare/metadata directories, unborn symbolic refs, and other Git failures; `room_login` remains exempt. Root canonicalization preserves distinct worktrees/submodules. Move preflight, cancellation, claim restoration, old-session rollback, server precedence, and canonical clone identity are present; branch-switch-in-place is the correct repository-room adaptation. The remaining objection in 35d is lost ordering coverage, not removal of its serialized dispatcher. Local-worker join-only relay mode does not acquire a new hub authority lock; wrong-clone admission is rejected before local join.

Registry row 8's source ordering and strong assertions were preserved after integration. D1 path-only held entries do not gain content hashes from the lockfile/policy port. The final publication applies in one Y transaction; finding 3 concerns the earlier incomplete boundary, and finding 5 concerns how much synchronous work that transaction accepts. The stale-version implementation and tests match main's numeric comparison, 30-second cache, orphaned sibling probe, and warning-first behavior, including unjoined tool replies. Fair reconcile still permits only one inline follow-up and queues subsequent work; its regression suite passed.

## Per-row verdicts

“Confirmed” means source/spec comparison and the available named regressions found no issue; it does **not** assert that socket/subprocess cases blocked above passed. Split rows are listed separately so neither half disappears.

- **35a: confirmed** — plain no-repository answer/dispatcher checks; subprocess verification limited above.
- **35b: confirmed** — only genuinely unborn HEAD gets the first-commit message; Git failures remain errors.
- **35c: confirmed** — preflight/rollback/cancellation present; branch-follow CONFLICT is justified; live relay/server verification limited.
- **35d: problem #6** — durable worker block/queue exists, but four upstream ordering/failure tests are missing.
- **35e: confirmed** — concrete environment/remembered server precedence and login destination preserved.
- **35f: confirmed** — root/subfolder/worktree/submodule behavior preserved; subprocess limit noted.
- **35g: confirmed** — Claude inherited-PWD protection and Codex fallback preserved.
- **35h: confirmed** — own-worktree metadata boundary and copied-checkout directory preserved.
- **36a: problem #6** — canonical common-dir guard, lead clone environment, worker-side refusal and join-only legacy relay behavior are present; the team-to-local cross-repository regression was dropped, and live relay coverage is limited.
- **36b: problem #8** — approved behavior is implemented and unit-tested; normative table needs amendment.
- **36c: confirmed** — stale-version warning and cache/orphan cases preserved.
- **36d: confirmed** — OBSOLETE rationale valid; direct and collect ignored-parent regressions pass.
- **36e: confirmed** — per-session bounded receipt evidence present; registry §17 CONFLICT justified; host/socket integration limits noted.
- **36f: confirmed** — OBSOLETE rationale valid; no-Git-in-finished-worktree regression passes.
- **37a: problem #10** — spawn/Git/watchdog phases present; join attribution is incomplete.
- **37b: problem #9** — tracked coalescing/backoff works; HEAD retry override is an undocumented conflict part.
- **37c: confirmed** — watcher exclusion warning implementation and config tests present.
- **37d: confirmed** — whole-file hint and empty-scope refusal/guidance preserved.
- **37e: problem #6** — report-versus-exit wait text and collect retry wording present; ready-after-exit test and full wait-budget assertion were dropped.
- **37f: confirmed** — OBSOLETE rationale valid; skill and resume tests pass.
- **37g: confirmed** — receipt read/scan bounds, rename-age recheck and restoration races preserved; port tests pass.
- **38a: problems #2, #3, #7** — autostash claim retention cases pass in isolation, but synchronous reanchor, incomplete boundary, and test queue races remain.
- **38b: problem #6** — actual classifier is wired and its 83 port cases pass; missing operand/write-intent regressions; frozen manifests unchanged.
- **38c: confirmed** — exact-name precedence, display-name normalization and ambiguity refusal present.
- **38d: confirmed** — tracked/untracked lockfile transitions, generated ignores and named-path withholding preserved; roomd regressions pass.
- **38e/join: problems #6, #10** — file logger wiring present; reduced connect assertion and incomplete actual-path phase attribution.
- **38e/roomd: confirmed** — supplied logger receives failure/skip/stop lines; tests pass.
- **38f/wording and wakes: confirmed** — participant count/retention wording and content-free wake conflict are correct; live wake verification limited.
- **38f/shared release builder: confirmed** — daemon uses the shared release formatter; roomd/shared assertions pass apart from unrelated claim-test race above.
- **39a: problem #6** — OBSOLETE authority/retention rationale is correct; retained preview/narrowing/deletion-withdrawal coverage was reduced.
- **39b: problem #4** — steady-state own-base/carried-base/error handling tests pass; concurrent semantic revision can mix bases.
- **39c: confirmed** — preview phases and bounded per-user overlap markers match main; timing tests pass.
- **40a/publication: problems #2, #5** — rewritten overlay diff itself is bounded and exact; the requested wider hash/publication audit is not clean.
- **40a/readers: problems #1, #5** — patch/changed-range bounds work, but actual node-diff3 and several many-file paths remain unbounded.
- **40b: problem #5** — guarded yielding prepare exists and tests pass; substantial unbounded work remains before/after it.
- **40c: confirmed** — bounded inline follow-up and queued-work fairness preserved and tested.
- **HARDEN: problem #7** — restored strong lifecycle expectations are correct; queue/liveness/migration fixtures still need deterministic hardening.
