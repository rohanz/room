# 2026-10-18 hardening batch (Room 0.17.17)

Lead: Claude (this session), branch `brief-slices` off main @ 110f918a. Workers: Codex (gpt-6-astra, medium) in Room
worktrees. Inputs: the three audits in this directory (`audit-tests.md`, `audit-repo.md`, `audit-docs.md`) and the
benchmark phase analysis in `docs/host-snapshots/2026-10-16-delivery-audit.md` (section "Brief-slices check").
Every slice below is a rule plus known members. A worker owns the rule: anything the rule reaches that is not listed
is still the worker's, and goes in its `room_done` summary. "If relevant" is not a state; ask the lead.

Codex sandbox: no network, cannot listen on sockets, so socket suites fail in a worktree; run focused tests and
typecheck, and say which suites you could not run. The lead runs the full suite and CI checks on the integrated tree.
Do not commit or push. Do not edit `plugins/room/hooks.json` (hash-trusted by Codex).

## Slice 1: preview check time limit feedback (packages/room-mcp)

Rule: a worker whose preview `run` hits the 5-minute check limit must learn it from the reply and must not burn the
limit again on the same command. Evidence: benchmark worker lua-finish lost 5:00 at T+10:20 on
`vitest run stalled_jobs delay flow` and then ran two more 1-2 minute previews on the same files.
- `packages/room-mcp/src/tools/files.ts`: when a check is stopped at the time limit (the `PreviewProcessLimit` path,
  reply "merged-tree check did not finish"), the reply also says to narrow the command to named tests or a single
  file so it finishes well under the limit, and that the same command will be refused next time.
- Remember, per participant and per clone (in-memory in the session is enough), the `run` strings that hit the time
  limit. A repeat of the identical `run` by the same participant returns immediately with the previous stopped
  result and the narrowing advice instead of running again, unless the call passes `allowSlow: true`
  (new boolean schema property; keep `packages/room-mcp/test/tool-budget.test.ts` passing: total description budget).
  A different `run` string is not refused. Output-cap stops are not remembered (a smaller output filter fixes those).
- Every completed check reply already prints `check Nms`; keep it.
- Tests: extend `packages/room-mcp/test/preview-check-limit.test.ts` (uses `setPreviewCheckLimitsForTests`) for the
  advice text, the refusal on repeat, `allowSlow`, and that a different command is not refused. Update the
  `room_preview_merge` description if its text changes, and `docs/reference.md` "preview" limits paragraph (line ~103).

## Slice 2: lead and worker skills (plugins/room/skills, packages/room-mcp/test/skills.test.ts)

Rule: the skills must tell leads and workers how to avoid the three time sinks measured in the benchmark, without
making briefs longer. Members:
- room-etiquette: a preview `run` should finish well under the 5-minute limit; name tests rather than whole suites;
  a run that was stopped at the limit is narrowed, never repeated as is.
- room-workers (lead): size slices so no worker's slice is more than about twice another's; a rule over a large set
  can be split by member across two owners, each told the rule. When a worker finishes while another's slice is far
  from done, ask the running worker what members remain and hand some to the finished worker (a message to a
  finished worker resumes it).
- room-workers (lead): after collection, start the integrated test run in the background and review diffs or write
  the summary while it runs; stop background commands and monitors before the final message so the host exits
  cleanly (benchmark leads were killed at the 15 s close deadline twice).
- `packages/room-mcp/test/skills.test.ts`: keep the frontmatter/registered-tools test and the push/catch-up safety
  test; collapse the nine prose pins into one table-driven test of load-bearing phrases; drop version-stamp pins
  (`verified on 2.1.300`, `2.1.285`). Keep the tests in `skills.test.ts` green against the edited text.

## Slice 3: test suite wall time (packages/room-mcp/test, vitest config)

Rule: no single test file may dominate the run; the default run stays under about 7.5 minutes on 12 cores with no
coverage lost. Members (from `audit-tests.md`):
- Split `collect.test.ts` (borrowers :976-1265, copy :1471-1660, worker-preview :1666-1877 into their own files),
  `worker-refresh.test.ts` (two halves), `workers.test.ts` (plumbing :179-452, safety :1037-1370),
  `combined-kept-preview.test.ts` (permutations vs real-collect oracles). Shared fixtures move to `test/fixtures/`
  or a sibling helper; every test keeps its title and assertions.
- Gate the deliberate scale tests (graph-responsiveness, preview-scale, preview-run-cache 36-43 s cases,
  manifest-preview S1, bridge F5, roomd rejoin-responsiveness and ignored-tree, server compaction soak, tools.test.ts
  "profiles five warm claims") behind an opt-in env var (e.g. `ROOM_TEST_SCALE=1`) via `describe.skipIf`/`it.skipIf`,
  and make CI set it (`.github/workflows/ci.yml` test job) so CI still runs them. Document the variable in AGENTS.md
  "Running and testing".
- Fix the flaky `tools.test.ts:1163` (spy on the session's own ConflictSet instance, not the prototype).
- Apply the prune rows of `audit-tests.md` that fall inside the files you split (collect.test.ts:797,1235,1081,
  119,144,227; workers.test.ts:294,698,991,1219,1138,1521-1526; worker-refresh.test.ts:420) and fix the misleading
  titles listed there. Other files belong to slice 4.
- Validation: `npx vitest run` on each split file; `npm run typecheck`; report per-file wall times before and after
  for the files you split.

## Slice 4: test pruning outside the split files (packages/room-mcp/test and other packages' tests)

Rule: a test is removed only when its behaviour is asserted by a named surviving test; otherwise it stays. Members:
the high-confidence rows in `audit-tests.md` outside slice 3's files (tools.test.ts:630,638,1949-2001,1404,1761,517;
carry-wip.test.ts:355; resume.test.ts:560; hooks.test.ts:92,396,385,310,1045; wake-turn.test.ts:165,385,510;
socket-wake.test.ts:28; conflict-set.test.ts:74,96,139,242; conflicts.test.ts:98,211; codex-app-server.test.ts:54-88;
names.test.ts:111; misc-regressions.test.ts; join.test.ts:225,216; open-confirm.test.ts:127+136), the hook
classifier consolidation (hook-port.test.ts rows and hooks.test.ts:371/385/396/402/414 driven in-process through
`pathsOf` from `plugins/room/hooks/common.mjs`, keeping at most five end-to-end spawns), the sleep trims table, and
the consolidation table. Do not touch collect/worker-refresh/workers/combined-kept-preview (slice 3) or
skills.test.ts (slice 2). For each removed test name the surviving test in your summary.
Validation: run every file you edited; `npm run typecheck`.

## Slice 5: repo hygiene (sources, package manifests, knip, docs/archive)

Rule: nothing unreferenced ships, and knip in CI sees production entry points. Members (from `audit-repo.md`):
- Delete list A: `.gcloudignore`; `docs/img/{room-hosted,room-live,room-network-kieran,room-run3-merged,room-v2}.png`;
  `packages/web/screenshot.png`; `packages/web/DARK-CONTRAST.md`. Confirm each is unreferenced before deleting.
- Test-only production code: `isForeignIdentity` (server/readonly.ts), `readSessionRuntime`/`writeSessionRuntime`/
  `SessionRuntime` (room-mcp/session.ts), `activityFromEvent` (worker-activity.ts), `prIdentity` (prs.ts),
  `createWriteIntentReader` (hooks-bridge.ts), `classifyThreeWay` (web/merged.ts): if nothing in `src` uses it,
  delete the function and the tests that only exist for it; if it is a documented surface, keep and say so.
  Drop `export` from `discoverLegacyWorktrees`. Leave `closeRegistryForDir` (36 test importers) for a later pass.
- `yjs` (hub-core), `y-protocols` (roomd, server) to devDependencies; add `tsx` where package scripts use it.
- Dedupe: `validParticipantName`/`assertValidParticipantName` (server/names.ts -> import from @room/shared),
  `safeUrl`/`HttpFailure` (relay/index.ts and server/http.ts -> hub-core), `incarnationFile`.
- `knip.json`: add production entries (`src/index.ts!`, `src/cli.ts!`, `src/main.ts!`, `src/parse/worker.ts!`,
  `src/doctor.ts!`) with ignores for test infra (`shared/src/test-env.ts`, `test-watchdog.ts`,
  `graph-noise.fixture.ts`, `web/src/test-manifest.ts`); `npx knip` must pass.
- Archive moves with link updates: `docs/trial-plan.md`, `docs/rehearsal-httpx-plan.md`, `docs/submission.md` into
  `docs/archive/` (update AGENTS.md:16,62 and relative links in archive reports); `docs/superpowers/specs/reviews/`
  to `docs/archive/reviews/`; `docs/superpowers/plans/2026-09-29-port-briefs/` and `2026-09-30-release-briefs/` to
  `docs/archive/briefs/`. `git mv`; then grep for broken relative links.
- Validation: `npm run typecheck`, `npx knip`, `npm run build:plugin -- --skip-web` only if you touched room-mcp
  sources (do not commit the bundle; the lead rebuilds), and the tests of any package whose src you changed.

## Slice 6: documentation corrections (docs/, README.md, CHANGELOG.md)

Rule: every shipped behaviour is described once, accurately, and nothing shipped is listed as planned. Members
(from `audit-docs.md`):
- `docs/roadmap.md`: mark preview-cache pruning (shipped 0.17.0), version-mismatch detection (partly: room_state
  message shipped; viewer-asset and worker-admission parts remain) and locked preview worktrees (eviction shipped;
  crash case open) accordingly; move "Fixed in 0.16.x" and "Found 2026-09-27" sections to `docs/archive/`.
- `docs/reference.md`: add `room_open` to the common tools table; add the implemented-but-undocumented parameters
  listed in audit-docs row 10 where they matter to users (keep it short).
- `CHANGELOG.md` 0.17.16: fix the graph-budget line (it was a test change), tighten the first two bullets so the
  0.17.16 delta over 0.17.12 is clear, remove the stray blank line. Do not add a 0.17.17 heading (the lead bumps).
- Fold `docs/onboarding.md` into README.md (its two unique paragraphs: same-checkout sessions and Codex first-call
  binding; the coordinate-a-task walkthrough) and delete it; update links in README.md, docs/README.md,
  docs/reference.md, docs/submission.md (which slice 5 moves: coordinate on its final path via a question).
- README.md: replace the five dated validation-record paragraphs with one link to the archive index.
- `docs/upgrading.md:86`: drop the "v0.16.40 tag if added later" sentence.
- Validation: `grep -rn "onboarding.md"` finds nothing stale; every relative link you touched resolves.

## Lead's own work after collection
Full suite (`env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`, with the new scale env var set once), typecheck,
`npx knip`, `npm run build:plugin`, plugin eval if tool descriptions changed, then `npm run bump -- 0.17.17`,
CHANGELOG 0.17.17 entry, tag, reinstall on Codex, one Room benchmark arm on the frozen harness with the new plugin.

## Pre-commit review (2026-10-18, after collection)

Two independent reviews of the integrated tree before the task commit: Codex (gpt-6-astra) on the production diff, a fresh Claude reviewer on the test diff.

Production findings, all fixed in the same commit:
- Preview repeat refusal was keyed on the command string alone, so a fixed tree was still refused and a successful `allowSlow` retry never cleared it; the history also kept full stopped output with no bound. Now keyed on command plus preview inputs (ancestor, merged paths, modes), cleared when the command finishes, at most eight entries with a 4 KB tail each.
- The three-miss liveness tolerance also delayed takeover when the owner's port was refused outright, past the 5 s retry budget of interrupted posts. A refused port is now decisive at the next tick; only timed-out probes count toward the tolerance (`probeRelay` returns `slow` for a timeout).

Test findings:
- Sixteen worker-activity label tests (command-argument and secret redaction, Codex item labels, malformed input, label cap) had gone out with a test-only wrapper; restored, driven through `WorkerActivityTracker.poll` on a log file.
- The skills table had dropped four negative wording pins; restored as `absent` rows.
- The ignored-tree pruning test was gated as scale although its assertions are correctness; it now runs by default on a 300-file tree and at 3,000 files with `TEST_SCALE=1`.
- One awareness case added: an `owner` field cannot vouch for a name outside the login's `login+label` family.
- Everything else in the test diff was a move or an audit-listed prune; gated tests have no hidden dependents; fixtures do not change isolation.
