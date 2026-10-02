# Rehearsal: the Codex repository (Rust), five issues, all on Codex, 2026-10-03

Run on `redesign` at `ea93acf` (tag `v0.17.0-rc12`, manifests `0.17.0`). Method, plugin install/restore and tmux
driving follow [yesterday's all-Codex Werkzeug run](2026-10-02-codex-all.md); repository and trusted clone follow
[the 09-30 Codex run](2026-09-30-codex.md). Focus: yesterday's rc12 fixes (R1–R4) on a large Rust workspace.
Times are local (UTC+8); log excerpts keep their UTC stamps.

## Setup

- **Overnight damage, repaired first.** macOS's periodic `/tmp` cleaner had deleted 161 tracked files from this
  checkout at ~00:00 (`packages/hub-core/package.json`, `room-mcp/src/connection.ts`, `parse/languages/rust.ts`, …)
  and the git metadata and part of the working tree of the trusted Codex clone `scratchpad/cx/cy` (`rehearsal`
  "does not have any commits yet", `rust-toolchain.toml` gone). The checkout was restored to `ea93acf` with
  `git checkout -- <deleted files>` (no code change; `npm run typecheck` clean). The clone was re-cloned at the same
  trusted path with its 3.3 GB `codex-rs/target` moved aside and back. Long-lived rehearsal state under `/tmp`
  needs a refresh before each run.
- **Repository.** Private `rohanz/codex-rehearsal` (openai/codex at f908e5a, 8,371 watched files, 5,705 source
  files). New branch `r17-rust` at the snapshot `f9ff683`. Lead clone `scratchpad/cx/cy`, Codex-trusted since 09-30;
  no trust prompt appeared at any point.
- **Issues #15–#19**, written as human issues ending "keep the change inside the crate … don't look at upstream
  openai/codex, its changelog, or other branches". Answer key: the crate-only parts of five upstream commits after
  the snapshot, cherry-picked in order onto f908e5a (branch `key` in a blobless scratch mirror, outside the clone).

  | Issue | Card | Upstream | Crate / files |
  |---|---|---|---|
  | #15 | Mermaid flowchart quoted labels and `&` | 9477081ccd | `codex-mermaid`: `parse.rs`, `tests.rs`, README |
  | #16 | Mermaid unsupported shapes, `--orange`, state descriptions (**depends on #15**) | 6e1ab4d294 | `codex-mermaid`: `parse.rs`, `relations.rs`, `state.rs`, tests, 2 snapshots |
  | #17 | Opaque UTF-16 Windows paths inferred as POSIX | d6571322d2 | `codex-utils-path-uri`: `lib.rs`, `tests.rs` |
  | #18 | `//server/share` treated as POSIX by `LegacyAppPathString` | d1d0e89558 | `codex-utils-path-uri`: `api_path_string.rs` + tests |
  | #19 | `tui.keymap` errors hidden by an untagged enum | 819efd7273 | `codex-config`: `tui_keymap.rs` + tests |

  Overlaps by design: #15/#16 in `parse.rs` and `tests.rs` (#16 does not apply without #15); #17/#18 in one crate.
  Crate tests: snapshot 347 config / 17 mermaid / 79 path-uri; key 348 / 21 / 83. Upstream's tests fail 12 cases
  on the snapshot code (1 / 7 / 4).
- **Rust.** Rust 1.95.0 (rustup, pinned by `rust-toolchain.toml`). `brew install sccache` (0.18.0). One `cargo fetch`
  in the lead's clone (6.7 s, registry already warm), then a warm `cargo test --no-run` of the three crates (74 s,
  82 % sccache hits from the answer-key build in another directory). Lead environment: `RUSTC_WRAPPER=sccache
  CARGO_NET_OFFLINE=true`, `~/.cargo/bin` on `PATH`. Each worktree kept its own `target/`.
- **Server.** Local, from this checkout: `GITHUB_CLIENT_ID=fake PORT=1331 HOST=127.0.0.1 YPERSISTENCE=<scratch>/srv-data
  NODE_ENV=development ROOM_COMPACT_MIN_DELETED=1 npx tsx src/index.ts` in `packages/server`, in tmux. One fake login
  (`ana`) minted with `/auth/device` + `/auth/poll` into a `ROOM_CREDENTIALS` file. Nothing touched Fly.
- **Lead.** One interactive Codex, codex-cli 0.159.2 (update prompt to 0.160.0 skipped), **gpt-6-astra high**:
  `codex --no-daemon -c 'marketplaces.room.source="/tmp/room-redesign"' -m gpt-6-astra -c model_reasoning_effort=high
  -s workspace-write -a on-request`, in tmux. MCP from `~/.codex/plugins/cache/room/room/0.17.0` (bundle sha
  `5e434a9a` = this checkout's). Workers: `codex exec -s workspace-write -c shell_environment_policy.filters=…
  -m gpt-6.1-sol` (effort host default).

## What was typed

| Time | Typed |
|---|---|
| 04:04:03 | join the room |
| 04:04:53 | yes (to "No room exists yet … Should I create it?") |
| 04:05:53 | here are 5 issues on this repo: #15 to #19 on github (rohanz/codex-rehearsal). get Sol workers to do them in parallel, one per issue, on Codex with gpt-6.1-sol. each worker can bring in one helper if it wants one. my laptop can only take about 10 codex sessions at once, so never more than 10 running at the same time, counting you and any helpers. this is rust: sccache is set up (RUSTC_WRAPPER), deps are already fetched so build offline, and only run cargo check / cargo test for the crate the issue is in, never the whole workspace. when they're done, check everything works together with the crate tests, collect the work through room, then open a PR for each issue against the r17-rust branch. |
| 04:14:50 | my laptop is struggling right now (load over 50), so no helpers for now please, keep it to the 5 workers. |
| 04:30:27 | thanks! review feedback on two of them. PR #21 (mermaid): make the 16-row state description cap a named constant, and add a short section to the mermaid README listing which flowchart shapes fall back to source. PR #23 (path-uri UNC): add a test that a bare //server with no share is rejected, and a doc example on the inference showing //server/share/project. load is fine again, so get one Sol worker per PR for this, and the mermaid one should bring in a helper for the README part while it does the code. have them commit on the PR branch but don't push yet, I want to look first. then preview the two together with the crate tests and tell me how it looks. |
| 04:41:10 | looks good, push both. one more small one for PR #24 (keymap): add a test that an empty list (insert_newline = []) still parses and means unbound. get a worker for it, have it commit in its own worktree, then check its commit with room's preview and the config tests before it goes onto the PR branch, and push that too. |
| 04:53:46 | great. last thing: get a quick worker on gpt-6.1-sool to run the mermaid crate tests on PR #21's branch head and tell me the count, no changes. (typo on purpose, to exercise R2) |
| 04:55:05 | yes, sol, sorry. go ahead |
| 05:01:47 | /quit |

No approval prompt reached the human: Codex's automatic approval review let 35 escalated commands through (cargo
outside the sandbox, `gh`, `git push`).

## Timeline

- **04:04 Join.** `room_join` → no room; on "yes", `room_create` 8.8 s (`daemon start 7054ms`), "alone here; the
  room stays quiet until someone joins". The lead's graph indexed 2,997 of 5,705 files in **75 s**.
- **04:06–04:07 Plan and spawn.** The lead read the five issues with `gh`, saw "#16 explicitly depends on #15", and
  spawned five workers 04:07:00–04:07:08, each `room_spawn` 2.3–2.5 s (`worktree add` ~1.1 s on the 86 MB tree).
  Brief: claims, crate-only cargo, `CARGO_BUILD_JOBS=2`, keep `RUSTC_WRAPPER=sccache`, one helper only after asking
  the lead for a slot, no commits. #16 was told to start with its class/state parts and take #15's work through
  Room. Peak 6 Codex processes of this run (lead + 5 workers, no helpers).
- **04:07–04:10 Every worker froze for two minutes (R4).** Each worker's graph indexed ~3,005 Rust files in
  **165–190 s**; meanwhile each MCP's event loop was blocked: `event loop lag 119675–135703ms: in flight room_claim`,
  and `room_claim` took **158–173 s**, `room_send` up to 170 s. The lead told me "some claim calls are hanging"
  (04:10:37) and "the Room delay has cleared" (04:11:27). Every worker also logged `graph: provenance refresh
  failed: Error: graph index is closed` three times when its MCP rebound to the Codex thread (26 lines in all).
- **04:08–04:13 Rust environment, discovered by the workers.** `gh issue view` failed in every worker (no network
  in the sandbox), so the lead pasted the issue bodies. `printenv RUSTC_WRAPPER` exited 1 in the workers: issue19
  asked the lead "RUSTC_WRAPPER is unset in this worker's exec environment". Then every worker's first `cargo test`
  failed with `sccache: error: Operation not permitted`; each re-ran the same command escalated outside the
  sandbox, approved by Codex's reviewer, and sccache worked there. (Analysis under Rust-specific findings.)
- **04:10–04:15 Load.** Five Room MCPs plus the lead's sat at ~100 % CPU each for 7+ minutes (indexing, then the
  conflict reconciler: 465 `conflicts … reconciled` lines in the run, 121 "changed during check", 21 "inputs moved
  twice", peak 47 a minute). 1-minute load reached **51** at 04:14 with only 1 cargo and 4 rustc running. I asked
  the lead to keep helpers off; it relayed "NO HELPERS" and serialized new builds to one cargo job.
- **04:11–04:19 Coordination.** 8 questions to the lead, 3 between workers. #15 and #16 negotiated `parse.rs`
  regions; #15 released `parse.rs` for #16's guards. Workers claimed whole files (`tui_keymap.rs:1-856`,
  `api_path_string.rs:1-437`, `parse.rs:1-143` of 143 lines), so #16's narrow claims (`parse.rs:31-34`, `57-61`,
  `69-73`, `85-85`) drew `CONFLICT: overlaps … parse.rs:1-143`, which was true of the claims as written. A worker
  preview found one real textual conflict, "around line 33: conflict between ana+issue15 and ana+issue16 … needs a
  human or a rewrite"; #16 moved its guard and the final preview merged it. Done reports: #18 04:14:36, #17 04:15:18,
  #15, #19, then #16 04:19:32 ("worker reported done; its process is still exiting").
- **04:17–04:19 A dependent worker could not test against its finished prerequisite.** #16's
  `room_preview_merge(includeOffline=true, people=[ana+issue15, ana+issue16])` answered three times "partial preview
  with ana+issue15: ana+issue15: coverage not-publisher; tests not run; combined work not verified" once #15 had
  exited (before collection). #16 finished "#16-only delta" and left the combined check to the lead.
- **04:20:16 Server restart 1.** #16's process had exited 39 s earlier, so again no worker was running. Down ~1 s.
  `compacting at load: 1614 structs (1187 deleted)` → 271 structs, `refused a replica of an earlier generation`,
  `1 lease(s) carried over`. The lead had a `room_preview_merge` in flight (44 s, `event loop lag 10642ms`); its MCP
  rejoined "with a fresh copy … under the same name" and logged `joined` 21 s after the refusal.
- **04:20–04:25 Combined preview and collect (R1).** The lead's five-way preview listed each exited worker as
  `ana+issueN: trusted local worktree`, merged in issue order ("both changed, merge cleanly:
  codex-rs/mermaid/src/parse.rs"), and with `run=cargo test -p codex-mermaid -p codex-utils-path-uri -p
  codex-config` took 203.6 s (`setup 67236ms, check 121627ms`): 28 + 87 + 348 = 463 passed. `room_collect` brought
  all five in (33.9 s, of which `cleanup 29361ms` removing five worktrees with their `target/`). The lead re-ran
  the three crate suites on the collected tree, split it back into one branch per issue, and opened **#20–#24**
  against `r17-rust` (#21 contains #20's commit; "Merge #20 before #21"). Worked for 23 m 39 s.
- **04:30–04:40 Follow-up on PR branches.** `room_spawn(dir=<lead's PR worktree>)` was refused: "is not an owned
  Room worktree for pr21; supply its .room/workers/pr21 checkout or omit dir". `room_spawn` has no base-branch
  option, so the lead made git worktrees of the PR branches under `/private/tmp/codex-rehearsal-feedback-*/` and
  spawned there; Room answered "is outside this repo, so no worktree was made and nothing is tracked for it beyond
  the pid" although they share the clone's `.git`. pr21 brought in its helper `pr21-readme` (nested spawn 04:33:47,
  2.9 s) for the README section and collected it (11.9 s). Both workers committed (bba1ac5, 44652ec).
- **04:34:31 Server restart 2, with three workers running** (pr21, pr23, pr21-readme) and the lead. Down ~1 s.
  Compaction 1563 → 240 structs; 5 refusals; `4 lease(s) carried over`; each session re-granted at a higher epoch.
  All four logged "document was compacted … rejoin with a fresh copy" within 5 s, then **every MCP stalled
  together**: `event loop lag 38472–42453ms: in flight none` at 20:35:15Z, and the helper's `room_scope` took 85.7 s.
  pr21 and pr23 `joined` at 04:35:23 (51 s), the helper and the lead at 04:35:27. During the gap a send from pr21
  returned "not sent: hub unreachable". No worker failed, no work was lost, and the lead never mentioned the restart to me.
- **04:37–04:40** The lead copied the two commits onto its collected tree and previewed against the live workers
  ("included ana+pr21 at b6f37e7844 + live changes"): CONFLICT notices for its stale copy of `state.rs` and
  `api_path_string*.rs` cleared once it applied the commits; 28 + 88 passed. Worked for 10 m 26 s.
- **04:41–04:51 Committed worker, Room preview (R1).** The lead pushed bba1ac5 and 44652ec, spawned tracked worker
  `pr24-empty` from the PR #24 head, which committed c779770 in its worktree. The lead's preview: "ana+pr24-empty:
  trusted local worktree … both changed, merge cleanly: …tui_keymap_chord_tests.rs … no conflicts", config tests
  **349 passed** (348 + the new one). The lead fast-forwarded PR #24 to exactly c779770 and pushed.
- **04:53–04:56 Failure reason (R2).** The worker on `gpt-6.1-sool` died at once; the lead received `[interrupt]
  ana+pr21-test-count → ana's agent: worker pr21-test-count failed: exit 1; codex:
  {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sool' model …`, and
  asked me "Did you mean gpt-6.1-sol?". The retry reported "28 passed, 0 failed" at bba1ac5.
- **05:01:47 Quit.** `stopping: SIGTERM` / `name lease on ana ended`; the server logged `lease … on ana released`.

## Grading

Combined branch: `r17-rust` + #20, #21, #22, #23, #24 merged `--no-ff` in issue order: **no conflicts**. Crate
tests there: config 349, mermaid 28, path-uri 88 (465, all pass). Upstream's test files and snapshots for all five
commits over the combined code: **config 348/348, mermaid 21/21 (upstream's class and state snapshots match
byte for byte), path-uri 87/87** (upstream's 83 plus the workers' extra `opaque_path_tests` module). Each PR alone:

| Issue | PR | Crate tests on PR alone | Closeness to upstream |
|---|---|---|---|
| #15 quoted labels | #20 | mermaid 23 | Same design: a flowchart-only label helper strips one pair of quotes and allows `&`, other families keep `&` banned; semicolons and entities still fall back. Adds a snapshot test and a longer README note. |
| #16 shapes/aggregation/state | #21 | mermaid 28 | Same three behaviours; upstream's class and state snapshots reproduce exactly. Review commit adds a named private cap and a README table of unsupported shapes. Contains #20's commit. |
| #17 opaque paths | #22 | path-uri 83 | Essentially upstream's code (`/\0` check; both prefix characters tested with the existing `is_windows_separator_byte`); 55 cases in a new test module. |
| #18 `//server/share` | #23 | path-uri 84 | Same `matches!` on two leading separators and the same doc-comment rewrite. The review commit's doc example is never compiled: the crate has `doctest = false`. |
| #19 keymap errors | #24 | config 349 | Same visitor with `deserialize_any` as upstream; upstream's TOML test passes unchanged. Plus the empty-list test from the follow-up. |

Conflicts landed: none. Lost work: none. Duplicate work: none, except #21 carrying #20's commit by design.

## The rc12 fixes

| | Result | Evidence |
|---|---|---|
| R1 combined preview includes workers' work; lead uses collect | **confirmed for the lead**, **not for a dependent worker** | Lead, 04:24: five exited, uncommitted workers each "trusted local worktree", 463 passed, then `room_collect` (33.9 s). Lead, 04:50: committed worker `pr24-empty` "trusted local worktree", 349 passed. But worker #16 previewing with exited #15: "coverage not-publisher; tests not run; combined work not verified" (×3, with `includeOffline=true`). |
| R2 real failure reasons reach the lead | **confirmed** | `worker pr21-test-count failed: exit 1; codex: {"type":"error","status":400,…"The 'gpt-6.1-sool' model …` (the raw JSON event; readable enough that the lead asked about the typo). |
| R3 no false CONFLICT for separate-line claims | **confirmed as far as exercised** | No "approximate" or whole-file widening anywhere in 10 sessions. Every CONFLICT traced to overlapping claims as written (workers claimed whole files, e.g. `parse.rs:1-143` of 143) or a real overlap at `parse.rs` line 33. Two narrow claims in one long file did not occur. |
| R4 tool latency under load | **refuted** | `room_claim` 158–173 s and `room_send` 170 s in five workers during graph indexing (event-loop lag 120–136 s); `room_scope` 12.7–17.3 s at start (`settle` 9.5–13.5 s), 25–30 s later, 85.7 s in the helper across restart 2; 38–42 s event-loop stall in all four MCPs after restart 2. Full list below. |

Slow-tool lines (all sessions): `room_claim` n=5 max 172,597 ms; `room_send` n=5 max 169,918 ms; `room_preview_merge`
n=19 max 203,647 ms (with a cargo run; without one 8.8–71 s, `git 58 calls 15677ms`); `room_scope` n=10 max
85,742 ms; `room_state` max 36,117 ms; `room_wait` max 38,239 ms; `room_collect` 33,896 / 11,867 ms;
`room_spawn` 2.3–2.9 s; `room_create` 8.8 s.

## Room problems

| | Severity | Finding | Evidence |
|---|---|---|---|
| X1 | **high** | Graph indexing blocks the MCP event loop on a large Rust workspace. Each worker indexed ~3,005 files in 165–217 s under load (49 s for a lone worker later; the lead 75–257 s) and, while it ran, every Room tool in that session hung: `room_claim` up to 173 s. With five workers starting together this is the first two minutes of every worker's life. Indexing should yield to tool calls (worker thread or chunked), and a worker could inherit the lead's index for unchanged files. | issue15 20:09:56Z `event loop lag 135703ms: in flight room_claim 136618ms`; 20:10:32Z `slow tool room_claim 172597ms`; `graph: indexed 3006 files in 189712ms`. |
| X2 | **high** | Six idle-ish Room MCPs pinned six cores. After indexing, every MCP kept ~100 % CPU in the conflict reconciler, re-checking because inputs changed mid-check: 465 reconcile lines, 121 "changed during check", 21 "inputs moved twice". Load 51 with almost no cargo running. Likely each worker's publish triggers everyone's reconcile. | `ps`: six `room-mcp.mjs` at 89–112 % CPU at 04:14; lead log 20:13:49–20:14:33Z. |
| X3 | medium | A dependent worker cannot preview against an exited prerequisite. The lead sees exited workers as "trusted local worktree", but a peer worker gets "coverage not-publisher" even with `includeOffline=true`, so #16 never tested with #15 and handed the combined check back to the lead. | issue16 ledger 20:16–20:18Z "partial preview with ana+issue15: … coverage not-publisher; tests not run". |
| X4 | medium | No way to start a tracked worker on an existing branch. `room_spawn` has `carry` and `dir` but no base: `dir=` on the lead's PR worktree was refused, so the lead spawned in git worktrees of the same clone outside its directory, which Room calls "outside this repo" and does not track beyond the pid (no own-worktree status, no collect). Follow-up work on a PR branch is a common request. | lead 04:32 `is not an owned Room worktree for pr21`; `… is outside this repo, so no worktree was made and nothing is tracked for it beyond the pid`. |
| X5 | medium | Rejoin after a compacting restart costs ~50 s per session with work in flight: all four MCPs logged a simultaneous 38–42 s event-loop stall ("in flight none") before `joined`, likely the full re-watch/resync of 8,375 files. Yesterday's lead (Werkzeug) rejoined in 1.6 s. | 20:35:15Z four `event loop lag …ms: in flight none`; pr21 `joined` 20:35:23Z; helper `room_scope 85742ms: settle 50498ms`. |
| X6 | low | `graph: provenance refresh failed: Error: graph index is closed` ×3 in every worker at the MCP's thread rebind (yesterday's R7 double join). | issue15.mcp.log 20:07:40Z. |
| X7 | low | `room_collect` cleanup spent 29.4 s deleting five worktrees, most of it their Rust `target/` (~3.8 GB each). | 20:25:20Z `room_collect 33896ms: … cleanup 29361ms`. |
| X8 | low | Leftovers after quit: two locked preview worktrees under `.git/room-preview/*/shared-86bc5d9d91987c54`, the uncollected `pr24-empty` worktree, and the lead's own delivery worktrees. Same as yesterday's R6. | `git worktree list` at 05:03. |

## Other things exercised

| | Result | Evidence |
|---|---|---|
| Nested helper | **held** | pr21 spawned `pr21-readme` (04:33:47, 2.9 s), the helper joined, survived restart 2, and pr21 collected it (11.9 s). Its worktree was `…/pr21/.room/workers/pr21-readme`, inside the untracked outside-repo checkout. In the first wave no helper ran: I asked for none at load 51. |
| Server restart with workers running | **held, slowly** | Restart 2: lead, two workers and a helper all re-granted (`4 lease(s) carried over`, epochs superseded), nothing lost, no agent noticed; ~51 s to rejoin (X5). |
| "merges cleanly" wording | **held** | "both changed, merge cleanly: codex-rs/mermaid/src/parse.rs"; "ana and ana+pr24-empty made the same change: …tui_keymap.rs". |
| Background-work detection | not exercised | Workers polled long cargo runs through Codex's own exec sessions (`write_stdin`), not shell background jobs. |
| Worker refresh | not used | #16 coordinated with #15 by messages and left the combined check to the lead (X3); the lead built #21 on top of #20's commit. |
| Changed-definition notices | not exercised | No public signature changed (#19 replaced a derived `Deserialize` with a manual impl). |
| Done reports reaching the lead | **held** | All nine worker done reports and the one failure arrived through `room_wait` or the inbox; the helper's reached pr21. |
| Env scrub | **held** | Workers ran with `shell_environment_policy.filters={"ROOM_*"="exclude"}`. |

## Rust-specific findings

- **`RUSTC_WRAPPER` does not reach workers, and it is not Room's scrub.** Codex starts MCP servers with a filtered
  environment: the lead's `codex` process had `RUSTC_WRAPPER=sccache` and `CARGO_NET_OFFLINE=true`, its
  `room-mcp.mjs` (pid 63120) had only `PATH`, `ROOM_SERVER`, `ROOM_CREDENTIALS` among them, so the workers Room
  launched had neither. Workers set them by hand on the lead's instruction. Room could pass the lead's build
  environment through, or say in the spawn reply which variables a worker will not get.
- **sccache cannot work inside Codex's `workspace-write` sandbox.** The client must reach its server on
  127.0.0.1:4226; the sandbox denies it (`sccache: error: Operation not permitted`), and
  `SCCACHE_IGNORE_SERVER_IO_ERROR=1` does not help (checked with `codex sandbox`). Only
  `sandbox_workspace_write.network_access=true` works, and Room's worker command (`codex exec -s workspace-write`)
  has no way to pass it. In practice every worker re-ran cargo escalated outside the sandbox (35 escalations
  approved by Codex's reviewer), which defeats the sandbox for the heaviest command of the task.
- **sccache helped once reachable:** 3,943 compile requests, 79.7 % hits over the run (82 % on a cold `target/` in a
  different directory). Workspace crates still rebuilt per worktree: `pr24-empty`'s first `codex-config` test build with one job took
  about 7 minutes.
- **Preview `run` with cargo works on this repo now.** Combined-tree setup 67 s cold, 18 s, then 0.5 s, no timeouts
  (09-30 C1: 173–180 s and a timeout). The lead pointed `CARGO_TARGET_DIR` at its own `target/` so the preview's
  cargo reused it; the lead's `target/` grew 6.7 → 9.5 GB.
- **Tree-sitter Rust indexing** is capped at 3,000 of 5,705 files and takes 75–257 s per session here (X1).
- **Big worktrees:** `worktree add` ~1.0–1.5 s; each worker `target/` ~3.8 GB; free disk went from 95 GB to a low of 70 GB (during grading).
- `just fmt` failed in every worker on non-Rust formatters (missing `dotslash`, uv cache permission in the sandbox);
  Rust formatting itself passed. Not Room.

## What worked

- One paragraph became five Codex workers on the requested model, the dependency was spotted from the issue text,
  every worker stayed in its crate, and all five PRs merge in order with upstream's own tests passing (12 tests that
  fail on the snapshot pass on the result). #17, #18 and #19 are essentially upstream's code; #16 reproduces
  upstream's snapshots exactly.
- Room's preview and collect did the integration this time: the lead previewed exited workers' uncommitted work
  and a committed worker's commit, ran the crate tests on the combined tree, and collected through Room.
- A real failure reason reached the lead and became a one-line question to the human.
- Two compacting restarts, the second under three running workers and a nested helper, lost nothing.

## Codex plugin: before, during, after

Before (04:02:49):

```
room@room  installed, enabled  0.16.40  <main checkout>/plugins/room
room                    <main checkout>
0.16.40
  "version": "0.16.40",
```

Install (04:02:51):

```
$ codex plugin add room@room -c marketplaces.room.source="/tmp/room-redesign"
Added plugin `room` from marketplace `room`.
Installed plugin root: ~/.codex/plugins/cache/room/room/0.17.0
room@room  installed, enabled  0.17.0   <main checkout>/plugins/room
room                    <main checkout>
0.17.0
  "version": "0.17.0",
```

During: every session of this run (the lead, 5 + 2 + 1 + 2 workers, 1 helper) ran from the 0.17.0 cache. One
Codex session not started by this run began while rc12 was installed: another job's `codex exec` in
`/tmp/room-0171` at 04:09:09. A Codex app-server daemon (0.160.0) ran throughout; the lead used `--no-daemon`.

Restore (05:02:03):

```
$ codex plugin remove room@room
Removed plugin `room` from marketplace `room`.
$ codex plugin add room@room
Added plugin `room` from marketplace `room`.
Installed plugin root: ~/.codex/plugins/cache/room/room/0.16.40
room@room  installed, enabled  0.16.40  <main checkout>/plugins/room
$ ls ~/.codex/plugins/cache/room/room/
0.16.40
  "version": "0.16.40",
room                    <main checkout>
```

The restored `server/room-mcp.mjs` matches the main checkout's (sha `219cf78e`).

Cleanup: tmux sessions `rust-lead` and `rust-srv` killed; nothing listens on 1331; the sccache server I started was
stopped; no codex, cargo, rustc or room-mcp process from this run remains (older room-mcp processes from other
sessions and the Codex daemon were left alone). Removed: the answer-key and grading worktrees (5.0 and 5.6 GB of
`target/`), `pr24-empty`'s and the feedback worktrees' `target/` (4 GB), a sandbox test crate. Kept: the trusted
clone's `codex-rs/target` (now 9.5 GB), the lead's worktrees and patches under `.room/`, the scratch answer-key
mirror (86 MB). The clone's `.git/room-choice.json` now remembers `ws://127.0.0.1:1331`; the next run should
choose its server again. Free disk at the end: 85 GB (95 GB at the start).
