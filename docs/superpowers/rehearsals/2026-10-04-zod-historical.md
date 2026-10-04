# Zod historical TypeScript trial — 2026-10-04

Status: complete and independently reviewed. Eight actual Codex Room workers ran; the accepted checkout contains **five verified historical fixes**, with one unresolved candidate preserved separately and two rejected cards removed. Final validation passed **1,468 runtime tests + 1,351 type-test entries**, explicit TypeScript compilation and the library build. This was an isolated local evaluation, with no upstream contribution or production Room change. The delivered-but-not-followed pre-collection pause remains an observed control failure.

## Baseline and controls

- Target: MIT-licensed `colinhacks/zod`, tag `v4.0.6`, upstream commit `7dd7484802b1351c8b81d3d523aadd876fcdf73e`, 2025-07-23T22:31:04Z. `v4.0.0` was not a published Git tag. Source acquired as pinned archive into `/tmp/room-zod-historical-r1`, initialized as a standalone repository without remotes or upstream history. Local source commit `b6de352`; original-report cards/gates commit `86fc6b6`.
- Toolchain: Node 22.14.0, pnpm 10.12.1, TypeScript 5.5.4, Vitest 2.1.9. Frozen lockfile SHA256 `d938c089c06a6878197a77aa5b1e322cef6875188281b70358f4befc6072c4c8`. All locked dependencies installed; optional docs application not built.
- Room: installed 0.17.4, unchanged MCP SHA256 `38e31d28f9caddf302fb4c0044729f2b7e55c660cce396e1ddc418647776a141`. Codex CLI 0.160.0. Ordinary CLI lead, `gpt-6.1-sol`, medium effort, `--no-daemon --approve-for-me`; local Room workers requested with the same model/effort.
- Launch environment strips inherited `ROOM_*`, `CODEX_THREAD_ID`, and `CLAUDE_CODE_SESSION_ID`; cwd and PWD point to the isolated checkout. No artificial faults injected. No upstream PRs, pushes, external messages, or implementation commits authorized.
- Upstream `CONTRIBUTING.md` and source-local guidance read. No upstream AGENTS.md found. The trial authorizes local new regressions/evidence; it does not submit contributions.
- Original issue bodies only supplied to implementation agents; linked triggering commit removed from #5003. Fix patches, later tests and upstream history withheld until implementation freeze. This controls supplied context, not possible model-training exposure. Comparison will emphasize behavior and independently replayed regressions, not byte-identical patches.

## Cards and preflight

| Issue | Reproduced defect | Reference eligibility before freeze |
|---|---|---|
| [5066](https://github.com/colinhacks/zod/issues/5066) | Record rejects plain object with string-valued own constructor key | Mapped merged historical fix |
| [5061](https://github.com/colinhacks/zod/issues/5061) | Integer template rejects negative integer string | Mapped merged historical fix |
| [5027](https://github.com/colinhacks/zod/issues/5027) | Mini keyof returns literal instead of enum | Mapped merged historical fix |
| [4976](https://github.com/colinhacks/zod/issues/4976) | Optional-array treeify error type lacks accessible items | Provisional later-release behavioral reference; validation pending |
| [5003](https://github.com/colinhacks/zod/issues/5003) | Catch input JSON schema incorrectly requires property | Provisional later-release behavioral reference; validation pending |
| [5073](https://github.com/colinhacks/zod/issues/5073) | Top-level legacy _output loses brand | Mapped closing commit |
| [4973](https://github.com/colinhacks/zod/issues/4973) | Inferred File type differs from platform File | Mapped merged historical fix |
| [5091](https://github.com/colinhacks/zod/issues/5091) | Set bounds report exclusive issue metadata/messages | Mapped merged historical fix |

All eight reproduced before launch: four TypeScript errors and four runtime/metadata failures. #5003's original report misplaces `{io:'input'}` on `z.object`; preflight and card explicitly normalize it to `z.toJSONSchema(schema,{io:'input'})`. #5091 concerns error metadata/messages, not actual acceptance boundaries. #4973 retains the original reporter's readonly-property diagnosis as an explicit original-report hint. Type assertions must be checked by real `tsc`, not only executed by Vitest. #5071 was dropped because the minimal standard-binding assertion passed. #4983 and #5079 were excluded as likely intentional behavior rather than counted as bugs.

Preflight type command: `node_modules/.bin/tsc --strict --noEmit --skipLibCheck --target es2022 --module nodenext preflight.ts`. Failures preserved in `/tmp/room-zod-historical-r1-run/preflight/types.log`. Runtime probes used `node --import tsx`, with results preserved alongside source. The broader required final type gate uses the baseline's actual test tsconfig.

Independent Astra prelaunch review accepted all eight task semantics after the above clarifications. Two provisional references must pass post-freeze independent replay before counting as historical answer-key matches.

## Clean baseline and setup failures

- Full Vitest: **1,448 runtime tests across 141 files + 1,337 type-test entries across 140 files** (2,785 entries, 281 file entries), no type errors; 5.27 seconds reported duration (`baseline-tests-cache.log`).
- Explicit `tsc --noEmit -p packages/zod/tsconfig.test.json`: exit 0.
- Direct library `zshy --project tsconfig.build.json` from `packages/zod`: exit 0. Package manifest unchanged by build. Direct build avoids unrelated format hooks in root `pnpm build`.
- First filtered dependency install omitted docs dependencies, but Vitest workspace discovery still loaded docs PostCSS config. Full frozen install resolved this; no source/assertion changes.
- Initial library-build command used a nonexistent package-local binary path; corrected to the root binary. An attempted `--workspace false` was parsed as a filename; preserved as harness error, not a product failure.
- Initial resolution snapshot test failed because pnpm was missing from PATH, then because `npm pack` could not use sandbox-restricted default cache. Adding pinned pnpm to PATH and writable temporary `npm_config_cache` made the original full suite green. No snapshot/assertion weakened.
- `tsx` CLI hit sandbox EPERM creating an IPC pipe; `node --import tsx` ran the same source without that unnecessary CLI pipe.

All initial failures remain in `/tmp/room-zod-historical-r1-run/`. No platform rejection appeared in controller tool results; the parent observed a transient platform content flag ending one controller turn, resumed unchanged benign work, and retained the artifacts.

## Actual lead and evidence

Lead thread: `01a10588-6f6e-7b11-bf6b-df7f09c76ab7`; launcher PID 86283. Launch prompt, script, timestamped events, stderr, completion exit and final response live in `/tmp/room-zod-historical-r1-run/`. Actual lead is responsible for Room joins/spawns, failing-before regressions, shared-file claims, sibling previews, review, full combined preview, normal collection, actual collected-tree validation, and frozen implementation artifact.

The following sections record observed worker identities, validation, failures, normal cleanup, immutable freezes and completed independent review.

## Observed implementation and integration

All eight actual workers ran concurrently. The shared local room initially had nine active participants: the CLI lead plus `rohanz+bug5066`, `rohanz+bug5061`, `rohanz+bug5027`, `rohanz+bug4976`, `rohanz+bug5003`, `rohanz+bug5073`, `rohanz+bug4973`, and `rohanz+bug5091`. Every spawn confirmed pnpm workspace links pointed at that worker's own sources. No cross-package fallback warning appeared. Budgeted threads fell from three to one as concurrency filled.

All eight preserved real failing-before regressions. Workers used claims, addressed questions and sibling previews. The negative-integer change exposed an existing positive-port assertion; the original worker preserved it and added sign-restriction handling. A mistaken password-pattern expectation edit was caught and reverted. The first branded-output fixes caused compiler recursion failures; the original worker repaired them without suppressions. Set inclusive metadata affected File expectations through shared checks; those workers coordinated narrow edits and merged cleanly. Multiple moving-input previews were explicitly rejected as not fully checked and rerun. These are recorded failures and corrections, not a claim that every first attempt passed.

| Issue | First meaningful failing regression | Final isolated explicit tsc |
|---|---|---|
| 5066 | exit 1; 7.332 s; four runtime failures | exit 0; 3.837 s |
| 5061 | exit 1; 5.485 s; negative integer template | exit 0; 3.785 s |
| 5027 | runtime exit 1; 6.918 s; compiler exit 2; 3.842 s | exit 0; 5.831 s |
| 4976 | compiler exit 2; 5.437 s; eight TS2339 errors | exit 0; 5.424 s |
| 5003 | exit 1; 7.337 s; input property required | exit 0; 4.849 s |
| 5073 | compiler exit 2; 6.03 s; eight errors | exit 0; 4.72 s |
| 4973 | compiler exit 2; 4.209 s | exit 0; 4.389 s |
| 5091 | exit 1; 5.875 s; two metadata/message failures | exit 0; 6.706 s |

The `nice` command emitted sandbox permission errors in several workers, but still ran their tests; these warnings are retained. No worker was silently replaced. Lead review and all-eight combined preview occurred before normal `room_collect({})`. No conflict resolution force/discard was used.

### Complete validation

| Stage | Library build | Full Vitest | Explicit tsc |
|---|---|---|---|
| Stable combined preview with persisted output | exit 0; 3.128 s | exit 0; 5.502 s wall | exit 0; 3.645 s |
| Actual collected working tree | exit 0; 3.287 s | exit 0; 7.461 s wall, 7.11 s reported | exit 0; 3.730 s |

Both full runs reported **287 files, 2,831 test entries passed, no type errors**. Vitest counts include its type-test entries; do not describe this as 2,831 unique runtime cases. Full commands/results/output are in `trial/evidence/lead/{combined-preview,collected-tree}/`. `git diff --check` passed, HEAD remained `86fc6b662821b61dca88108a4993e4560640693b`, and the index remained empty. The fixes are uncommitted.

Normal collection removed all eight worker worktrees. Four locked Room preview-cache worktrees remained and were preserved; no forced cleanup was used to make this look pristine.

### Delivered pause instruction was not followed

The controller requested an independent-review pause before collection so the original threads could still receive corrections. `codex --no-daemon queue` rejected that CLI combination; normal `codex queue` accepted a message, but delivery to the active lead was not observed. A temporary local `trial-controller+checkpoint` MCP participant therefore sent one addressed Room interrupt. This is controller instrumentation, not a ninth implementation worker.

The interrupt `m_mutfj9qzh6o7l6` appears in the lead's completed `room_preview_merge` result, **event item_73**, before the lead started `room_collect({})`, **event item_77**. Nevertheless, the lead collected all eight. The lead's initial later statement that the checkpoint became visible only after collection is contradicted by the recorded tool-result order. A correction was sent to the lead. This is an observed agent instruction-following/control failure despite delivered Room inbox content, not a lost-delivery claim or a suite failure. Collection was not undone and retired workers were not represented as resumable.

### Freeze and independent review

The controller froze the actual collected source before any reference implementation was read: `/tmp/room-zod-historical-r1-run/frozen-first-collected/`. Its complete `packages/zod/src` snapshot and `source-manifest.json` have manifest-serialization SHA256 `c7bd71a08758c3bb19627a2072882f98ad9001424c9562793c0b981774123028`; `candidate-ready.json` records exact time and file inventory. A per-file comparison at that pre-review checkpoint found no source changes since this freeze. The accepted tree intentionally differs after the documented selective removals below.

The lead also created `/tmp/room-zod-historical-r1-run/implementation-frozen.json` at 2026-10-04T06:21:56Z, with binary patch SHA256 `15a375dd811739e0d1ad75b092b3e60f29d1e9cdf6ce49ec7f590df65af7f073` and its separately serialized source-manifest hash `41781ee1582872dffcf015ed0a672e078a268dc3341b2b371c4ebeca1881a630`. Different manifest serialization explains different aggregate hashes; actual per-file source content matches the first freeze.

At the first-freeze checkpoint, independent post-freeze review was still pending. It is now complete, with the final acceptance decision below. No exact later-release SHA was preregistered for #4976/#5003: v4.1.0 was suggested, but must be pinned and labelled selected after freeze. A closing event is only candidate metadata: #5073's closing commit requires independent verification and must not be called a validated answer key merely because GitHub recorded closure. Any corrections after this point are post-freeze integration repairs, not blind original-worker output.

## Post-freeze selection correction

Independent review found that matching a reporter's requested behavior did not establish an accepted upstream bug. This was a trial-selection error and is retained in the record.

- **Five verified historical matches:** #5066, #5061, #5027, #4973, #5091.
- **One unresolved candidate:** #4976 remains reproducible in later upstream releases. Its useful local type improvement was preserved as a separate candidate patch/test/evidence artifact, not counted as a historical answer-key match or kept in the accepted historical checkout.
- **Two rejected cards:** #5003's maintainer intentionally keeps input catch properties required because the emitted schema describes what callers should pass, rather than every value recovered by catch. #5073 was not accepted as a legacy-alias fix because of recursive typing limitations; its closing commit did not fix the reported branding issue. Their candidate behavior changes and new tests were selectively removed from the accepted checkout. Their original worker patches, tests and failures remain in the immutable first freeze.

The reviewer selected and pinned v4.1.0 after freeze; it still failed all three original repros (#4976/#5003/#5073). Current stable v4.6.5 (tag commit `59bbc03e10c636b9eb3c393dfeb552819774ec21`, registry integrity verified by reviewer) also retained those behaviors. These failed reference comparisons remain evidence. Neither release was a preregistered answer key for those cards.

Before the maintainer rationale was established, review identified a wrapper case (`catch(...).readonly()`) and the original lead was resumed for an initially authorized post-freeze repair. Root then rescinded that repair when the rationale invalidated the task. The controller verified the exact CLI process and interrupted it, preserving the transcript and a post-exit patch. The turn inspected code; no implementation edit was observed. A briefly started six-task reconciliation was likewise stopped when the final acceptance scope became five historical matches. These are controller scope-correction events, not Room worker failures. The original lead thread is retained across resumptions; no replacement workers were spawned, and all initial artifacts remain intact.

The final reconciliation restored rejected/unresolved contributions to baseline while preserving the five accepted fixes. Full gates, accepted freeze and independent subset review are complete below.

## Final accepted historical result

Verified historical references (read only after the first implementation freeze):

| Issue | Upstream fix |
|---|---|
| #5066 | [PR #5098](https://github.com/colinhacks/zod/pull/5098) |
| #5061 | [PR #5181](https://github.com/colinhacks/zod/pull/5181) |
| #5027 | [PR #5045](https://github.com/colinhacks/zod/pull/5045) |
| #4973 | [PR #4974](https://github.com/colinhacks/zod/pull/4974) |
| #5091 | [PR #5093](https://github.com/colinhacks/zod/pull/5093) |

These are behavioral matches for the issue scope, not identical patches. The #5061 candidate also preserves the baseline's positive-only constraints. The post-freeze v4.1.0 reference was pinned to `2ca716d6313dcfab425d3555ac8bf85929bc57a4`; #5073's closing commit `fc1e556318159b4740ba3d6b37660e783d2a3cb7` still failed its original reproduction.

Independent Astra review accepted the final five-task subset: **#5066, #5061, #5027, #4973 and #5091**. The reviewer independently replayed runtime and compiler holdouts, checked the corresponding upstream fixes after freeze, and verified all eleven retained source/test paths are byte-identical to the original worker candidate. Five rejected/unresolved tracked files match baseline, the treeify test was removed from accepted source, the lockfile is unchanged, and no retained contribution was lost. Final sign-off: `/tmp/room-zod-astra-review/final-review.json`; source audit and independent holdout sources/logs are alongside it.

The rejected interpretations are supported by the maintainer's [#5003 rationale](https://github.com/colinhacks/zod/issues/5003#issuecomment-3131303570) and [#5073 rationale](https://github.com/colinhacks/zod/issues/5073#issuecomment-3172004500). A closed issue and a failing assertion written to match its request were insufficient task-selection evidence. The two rejected cards are not counted as historical successes despite passing the originally specified tests.

The separate unresolved #4976 candidate is preserved at `/tmp/room-zod-historical-r1-run/unresolved-4976-candidate/`: source patch, new regression test, full candidate patch and evidence. Candidate patch SHA256 `bca11222e0d44a4eb60bf8524c07c5c368990ed53ec686aac0c876aeaf7734df`; it passes `git apply --check` against the accepted checkout. It remains outside the accepted historical tree and is not an upstream submission.

Final actual-tree gates, run after rebuilding:

| Gate | Result | Wall time |
|---|---|---|
| Library build | exit 0 | 3.132 s |
| Full Vitest | 285 file entries: 143 runtime + 142 type; 2,819 test entries: **1,468 runtime + 1,351 type**; no type errors | 5.994 s (5.54 s Vitest reported) |
| Explicit package tsc | exit 0 | 3.570 s |

Exact commands, timestamps and output: `trial/evidence/lead/accepted-subset-validation/`. The original eight-task collected candidate had 1,474 runtime tests + 1,357 type entries (2,831 total); those are preserved as initial-candidate results, not substituted for final accepted counts.

Accepted freeze: `/tmp/room-zod-historical-r1-run/implementation-accepted-subset.json`, created **2026-10-04T06:39:31.489Z**, with changed-file copies, patch, source manifest and evidence inventory under `frozen-accepted-subset/`.

- Accepted source-tree SHA256: `b598e74c021e5cff6ac8d4f6725b5e11e51ce1c25e075bb7d0e585cfb119f959`.
- Tracked binary-patch SHA256: `a100f7dec8324578efd4c5256b6b8d934d3e9728aae19231010a0b37f2ab4716`.
- All initial freezes and all eight workers' evidence verified unchanged by hashes. A first reconciliation guard compared differently ordered manifest representations and stopped before editing; the corrected comparison confirmed identical source and preserved that harness failure.
- Original lead thread remained `01a10588-6f6e-7b11-bf6b-df7f09c76ab7` across all resumptions. Final lead **exit 0 at 2026-10-04T06:39:41.523Z**, recorded in `accepted-five-exit.json`.
- Registry audit confirms eight workers, exactly one run each, witnessed exit 0, retired with collected disposition, cleanup done, and all owned worktrees absent. Postcollection state reports zero open claims. Four locked preview caches remain, without forced removal. Compact audit: `/tmp/room-zod-historical-r1-run/room-evidence/final-worker-audit.json`.

Original eight-worker execution timing is separate from review and correction: lead launch **06:09:49.873Z** to last normal collection **06:18:57.649Z**, **9 min 7.776 s**. The final accepted-scope reconciliation resumed at **06:34:06.374Z**, reached passing full gates at approximately **06:36:34.176Z**, froze at **06:39:31.489Z**, and exited at **06:39:41.523Z**: **5 min 35.149 s** for that reconciliation turn. The intervening independent review and two controller-stopped scope-correction turns are retained and are not hidden inside the worker execution number.

Installed Room 0.17.4 and production remained unchanged. The accepted checkout is uncommitted and unstaged, with no remote. No replacement workers, upstream PRs, pushes or external messages were used. This run demonstrates functioning parallel implementation, shared-file coordination, invalidated-preview handling and normal collection; it also demonstrates that advisory inbox delivery did not enforce the requested collection pause, and that historical task selection needs maintainer-resolution validation before success can be counted.
