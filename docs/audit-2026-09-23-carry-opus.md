# Review of 0.11.1 (carry-over and joins), by Claude Opus 5.5, 2026-09-23

Reviewed main at 8a9b939. Run in parallel with the other model's review; the lead session confirmed the blockers against the code before the fix batch.

VERDICT: Carrying the lead's work is right for the lead's own collect, but it breaks everywhere else: carried workers get false conflicts, lead secrets land on a pushable branch, common git configs defeat it, and a failed spawn orphans it. Separately, the 86-second join is overlay seeding walking every tracked file with two git processes each.

Summary
- Blockers (2). A carried worker and its lead get false conflict reports on carried lines, from the worker's mandated preview and from both live watchers (1). Carrying commits non-ignored untracked files (`.env`, 150 MB datasets) to `refs/heads/room/<tag>`, where a push or PR takes them off the machine (2).
- Carry robustness. `diff.noprefix`, `color.ui=always` or `diff.external` makes every carry fail (3). A spawn that fails after the carry leaves a branch with no record, and reusing the tag silently loses the base (4). An untracked nested repo aborts the whole carry (9).
- Team rooms. A carried worker's base exists only on the lead's machine. Teammates' default preview fails with an untrue "git fetch" instruction, and their conflict watcher goes quiet (5).
- The live failure. Local auto-join failures are only logged, never retried, and the error points at `room_create` (6). The join cost is linear in tracked files and repeats on every HEAD move and every worker start (7). A stale discovery file can pin a client to a relay that refuses its key (8).
- Carried contract notices. They reparse every lead file on every overlay event (10) and miss reverts (11). Reply and prompt wording is untrue or unworkable in places (12, 13).
- Tests. The 17 carry tests pass, but only the lead's side is exercised. No test calls `room_preview_merge` as the worker, `mergePath` with a carried base, a failed spawn, or user git config, so findings 1, 3 and 4 pass CI.

## Findings

### 1. blocker: carried workers and their lead get false conflicts on carried lines
- **Where:** `packages/room-mcp/src/tools/combined-tree.ts:33-47`, `packages/room-mcp/src/conflicts.ts:65-71`
- **Defect:** The carried base is applied only to *participants* in `buildCombinedTree`, never to the caller, and `mergePath` ignores it entirely. A worker's own merge and both live conflict watchers therefore use `merge-base(leadHEAD, carried) = leadHEAD` as the 3-way base.
- **Scenario:**
  - The lead has `shared.txt` line 2 = `W` uncommitted and spawns `w`. The lead then edits line 2 to `W2`. The worker edits only `keep.txt`.
  - The worker's prompt makes it run `room_preview_merge` before finishing. That preview reports `CONFLICTS: shared.txt around line 2: conflict between rohanz+w and rohanz … needs a human or a rewrite`, a file the worker never touched.
  - If the worker also edits line 9 of `shared.txt`, both watchers post `merge-conflict`: "your shared.txt and rohanz+w's now conflict around line 2" to the lead, and the mirror message to the worker. That message wakes the worker, and the browser draws the span.
  - `room_collect` merges the same pair cleanly (`W2` plus `X9`). The notices are false, and they prompt workers to revert or ask about the lead's lines.
- **REPRODUCED:**
  - `/tmp/revscratch/s1.mts`: `createTools` harness, worker session calling `room_preview_merge({person:'rohanz'})`. It printed the CONFLICTS block above.
  - `/tmp/revscratch/s2.mts`: `mergePath` from both sides returned `{"status":"conflict","lines":[2]}`. `git merge-file` against the carried commit is clean: `line1\nW2\n…X9\nline10`.
- **Fix:**
  - Add one pair-base rule and use it in `mergePath`, in `buildCombinedTree`'s caller seed, and in the per-participant step. When one side is a worker whose recorded `base` descends from the ancestor, the 3-way base for that pair is that recorded base (the carried commit), for either direction.
  - Add worker-side preview and watcher tests.

### 2. blocker: the carry commits untracked secrets and bulk data to a pushable branch
- **Where:** `packages/room-mcp/src/workers.ts:263-275`, `:152`
- **Defect:** Every non-ignored untracked file is copied and committed to `refs/heads/room/<tag>`, with no size cap. roomd's default ignores (`*.npy`, `*.pt`, `*.zip`, `dist/`, `build/` …) are not applied, and there is no secret-name check. The worker is still told it may push when the task says so, and nothing tells it that its branch holds the lead's uncommitted work.
- **Scenario:**
  - A lead has an un-ignored `.env` containing `API_KEY=…` and spawns a worker with "fix X and open a PR".
  - The worker pushes `room/<tag>`: the carried commit, authored `Room <room@localhost>`, publishes the key and all the lead's WIP.
  - `git push --all`, IDE "push all branches" and `git bundle --all` do the same while the branch exists.
  - A 150 MB `weights.npy` is copied and stored. The spawn took 7.4 s and grew the object store by 160 MB. A multi-GB file hits the 30 s `git add` timeout after its blobs are already written.
  - The roadmap's "secret redaction" covers broadcast text. This is worse: a durable, pushable git ref the human never chose.
- **REPRODUCED:**
  - `/tmp/revscratch/carry.mts` case `secret`: `git show refs/heads/room/w:.env` gives `API_KEY=sk-live-123`.
  - `/tmp/revscratch/s4.mts`: 150 MB `.npy` carried, `count-objects` size 160.21 MiB.
- **Fix:**
  - Filter untracked files through roomd's `defaultIgnoredPath`, a per-file and total size budget, and a secret-name denylist (`.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, `credentials*`).
  - Name what was skipped in the spawn reply.
  - Add to the prompt: "the first commit on your branch is the lead's uncommitted work; never push this branch; the lead collects."

### 3. should-fix: common user git configs make every carry fail
- **Where:** `packages/room-mcp/src/workers.ts:261-262`
- **Defect:** The carry patch comes from porcelain `git diff`, which honours user config (`diff.noprefix`, `color.ui=always`, `diff.external`). `git apply` then rejects it. `saveDiscardPatch` already passes `--no-ext-diff --no-textconv`; this call doesn't.
- **Scenario:** A developer with `diff.noprefix=true` (a popular setting) or difftastic as `diff.external` never gets a carry. Every spawn says "could not carry" or "commit them first", and nothing explains why.
- **REPRODUCED:** `/tmp/revscratch/s5.mts`
  - `diff.noprefix=true`: "error: deep/x.txt: does not exist in index", carry failed.
  - `color.ui=always`: "No valid patches in input", carry failed.
  - `diff.external=/bin/echo`: carry failed.
- **Fix:** Use `git diff --binary --full-index --no-color --no-ext-diff --no-textconv --src-prefix=a/ --dst-prefix=b/ HEAD …`, or `-c diff.noprefix=false -c color.ui=never`.

### 4. should-fix: a spawn that fails after carrying orphans the branch, and a retry drops the carried base
- **Where:** `packages/room-mcp/src/tools/workers.ts:113-156`, `packages/room-mcp/src/workers.ts:248`
- **Defect:** The returns after `prepareWorktree` (link failure `:148`, worker-count recount `:127`, spawner throw `:156`) leave the worktree and the `room/<tag>` branch with the carried commit, but no worker record. `room_collect discard` then answers "no worker w owned by you". Respawning the tag reuses the worktree with `created:false` and no `base`, so the carried lines count as the worker's.
- **Scenario:**
  - `.roomlinks` lists `data`, which is untracked but not ignored. The carry copies `data/`, and linking then fails with "link destination already present".
  - The agent retries the same tag. The lead keeps editing carried line 2.
  - `room_collect` returns "Nothing written; conflicting files: shared.txt (your edits, w)". Had the lead reverted instead, collect would have re-applied the reverted lines as the worker's.
- **REPRODUCED:** `/tmp/revscratch/s3.mts`: "spawn 1: error: could not link inputs…", "branches: + room/w | worktree exists: true | record: false", "base recorded: undefined", then the conflict above.
- **Fix:**
  - Remove the worktree and branch on every error return after a *created* worktree.
  - Validate links before carrying, and exclude link paths from the carry.
  - When reusing a worktree, recover `base` if its first commit above HEAD has `carriedSubject`.

### 5. should-fix: in team rooms, a carried worker's local-only base breaks teammates' previews
- **Where:** `packages/room-mcp/src/tools/combined-tree.ts:37-38`, `packages/room-mcp/src/tools/context.ts:302-316`, `packages/room-mcp/src/conflicts.ts:69`, `packages/roomd/src/index.ts:261`
- **Defect:** The default spawn is `where: 'here'`, which puts the worker in the team room. Its daemon publishes `baseOf = carried commit`, which exists only in the lead's clone.
- **Scenario:**
  - Any teammate's default `room_preview_merge` includes every present participant, so it throws "rohanz+w's HEAD 6c06a70f3f is not in this clone; git fetch, then retry". Fetching cannot help.
  - A teammate's `room_read(person=rohanz+w, path)` of an unchanged file hits `gitShow` "invalid object name", and `NeedFetch` sends the same untrue instruction.
  - Their conflict watcher returns `unknown`, so it never warns about the worker. Before 0.11 the worker's base was the lead's HEAD, normally the pushed room base.
- **TRACED:**
  - `baseFor` falls through to `room.baseOf(worker)`, the carried sha.
  - `merge-base` fails, which gives the throw at `:38`.
  - `gitShow` rethrows unknown-object errors (`roomd/src/git.ts:71-77`).
- **Fix:**
  - When the lead is in a team room, publish a carried worker's base as the carried commit's parent, with the carried files folded into its overlay under the lead's sharing level. Alternatively, bridge carried workers through the local workers room.
  - At minimum, skip such participants with an honest line: "works on rohanz's local carried commit; not previewable here".

### 6. should-fix: a failed automatic local join is silent and permanent (live failure, part 1)
- **Where:** `packages/room-mcp/src/index.ts:128-138`, `packages/room-mcp/src/tools/index.ts:52,58,82`
- **Defect:** `expected = startup.server !== LOCAL || !!startup.room` is false for the default local room, so a failed startup join sets no `startupNotice`, only `log(line)`. Nothing retries it, and `setPendingJoin` swallows the rejection.
- **Scenario:**
  - Every later tool call finds no session and returns "error: not in a room. room_join if a teammate has opened this repo, room_create otherwise."
  - In a local room that advice is wrong: there are no teammates, and `room_create` targets the hosted server. It also hides the logged cause.
  - This is exactly the 15-hour-later `room_spawn` error.
- **REPRODUCED (subagent):** `joinSession` with `connectTimeoutMs: 3000` against a relay recorded in `room-local.json` that refuses the key. It printed "join failed after 3042ms: could not sync with ws://127.0.0.1:…", then `room_spawn` gave "error: not in a room. room_join if a teammate has opened this repo, room_create otherwise."
- **Fix:**
  - Keep `lastJoinError`.
  - On a call with no session (and no deliberate leave), retry the join once, rate-limited to one attempt per 30 s.
  - If it still fails, say "not in the local room: the startup join failed (<cause>); retried now and failed; room_join where=local".
  - Drop the `expected` guard for non-`NoRoom` failures.

### 7. should-fix: join time grows with every tracked file, repeats on every HEAD move, and explains the 86 s
- **Where:** `packages/roomd/src/index.ts:330-337` (`pathsToReconcile` includes `this.tracked`), `:610-615`, `:751-753`, `:563-564`
- **Defect:** `seedLocalOverlay` runs sequentially over *every tracked and untracked file* and starts two git processes per file (`gitShow` base, then `gitHead`). It is awaited inside `start()`, and `pollHead` repeats it after every commit, pull or checkout. Each worker's daemon does the same on startup.
- **Scenario:**
  - Measured here: the pair costs about 42 ms per file (200 files took 8.4 s). A 2,000-file repo therefore joins in about 84 s: the reported 86 s. The subagent measured 23.9 s for 2,000 untracked files at 12 ms per file.
  - Tool calls block on the pending join with no cap.
  - Any single `gitShow` timeout or spawn error during the pass aborts the join (see 6).
  - After every lead commit, publishing stalls behind a full reseed.
- **REPRODUCED:** the timing loop over `git show HEAD:f; git rev-parse HEAD` (200 files, 8.386 s total). The per-file calls are TRACED.
- **Fix:**
  - Reconcile only `git status --porcelain -z --untracked-files=all` paths plus paths this person already published.
  - Read base texts with one `git cat-file --batch`.
  - Check HEAD once per batch.
  - Return from `start()` after sync and seed in the background.

### 8. should-fix: a stale discovery file can pin a client to a relay that refuses its key
- **Where:** `packages/relay/src/index.ts:159-169`, `:288-296`
- **Defect:** `recorded()` adopts any process whose `/health` says `{"local":true}`, even after logging "pid gone but relay answers". The key and the clone are never checked.
- **Scenario:** If the recorded port now belongs to another clone's relay, every upgrade gets 403 and y-websocket retries until the 15 s sync timeout. The watchdog never takes over, because that relay keeps answering, and the join fails the same way until the other process exits.
- **REPRODUCED (subagent):** a discovery file pointing at a live relay with a different key produced "joined relay … (pid 999999, pid gone but relay answers)", then "join failed after 3042ms".
- **Fix:** `/health` returns `sha256(realpath(commonDir))` and verifies a `key` query. `recorded()` adopts only on a match and otherwise treats the file as stale.

### 9. should-fix: an untracked nested repository aborts the whole carry, with no reason given
- **Where:** `packages/room-mcp/src/workers.ts:263-272`, `:279`
- **Defect:** `ls-files --others` lists a nested repo as `vendor/lib/`. `copyFileSync` on a directory throws EISDIR, the bare `catch {}` discards the reason, and nothing is carried.
- **Scenario:** A lead with a cloned tool under `vendor/` loses the carry for every spawn and is told to "commit them first". The error is never shown.
- **REPRODUCED:** `carry.mts` case `nested-repo`: `carried=undefined failed=true`.
- **Fix:**
  - Skip entries ending in `/`, and non-regular files, naming them in the reply.
  - Return the error text in `carryFailed` so the reply can say why.

### 10. should-fix: carried contract checks reparse every lead file on every overlay event, unbounded
- **Where:** `packages/room-mcp/src/conflicts.ts:119`, `:167-171`, `:192-217`
- **Defect:** Every overlay change by anyone runs `checkAllObserved`, which queues a fresh `checkObserved(lead)`. There is no debounce and no dedupe of in-flight work.
- **Scenario:** For a carried worker, each check runs `git show` plus two tree-sitter parses for *every* lead changed path, and `referencesSymbol` over every worker path. With a 40-file lead and 4 workers, one save anywhere costs about 160 git processes and 320 parses, and checks pile up concurrently.
- **TRACED:** `onOverlays` → `checkAllObserved` → `queueObserved` (no guard) → loop at `:210`.
- **Fix:**
  - Debounce per person, like `schedule`.
  - Skip when the lead's overlay texts are unchanged (hash).
  - Cache `observedContractChanges` by (base sha, text hash).

### 11. should-fix: a carried definition the lead reverts is never reported
- **Where:** `packages/room-mcp/src/conflicts.ts:210`
- **Defect:** The check iterates `changedPaths(lead)`. Reverting, stashing or checking out a carried file removes it from that set, so a signature restored to HEAD is never compared with the carried commit.
- **Scenario:** The worker builds on the carried `foo(a, b)`. The lead runs `git stash` or reverts `foo`. The worker is not told, and `room_collect` then applies calls to a signature that no longer exists.
- **TRACED.**
- **Fix:** Iterate `carried paths ∪ changedPaths(lead)`, where the carried paths come from `git diff-tree <base>`. A path with no overlay uses the lead's HEAD text, and a deleted one uses `null`.

### 12. should-fix: "carried your N uncommitted changes" counts the wrong thing
- **Where:** `packages/room-mcp/src/tools/workers.ts:182`, `packages/room-mcp/src/workers.ts:105-107`
- **Defect:** N comes from `status --untracked-files=normal` lines, not from what was carried.
- **Scenario:**
  - 30 new files under `newpkg/`: "carried your 1 uncommitted change".
  - A dirty submodule: reported N=2, but only 1 path was carried.
- **REPRODUCED:** `carry.mts` cases `untracked-dir-count` (count=1, 30 paths) and `submodule-dirty` (count=2, paths=[a.txt]).
- **Fix:** Report `carried.paths.length`.

### 13. should-fix (product): the carried-files prompt rule works against the motivating use case
- **Where:** `packages/room-mcp/src/workers.ts:156`
- **Defect:** "do not edit them unless the task says so" applies to every carried file, and only 20 are named.
- **Scenario:** In the roadmap's own motivating case (a day of uncommitted rewrites), the worker's target files are carried. A brief that doesn't know it must grant permission gets a worker that refuses, or asks, about the files it was sent to change. Beyond 20 files the worker cannot tell which files the rule covers at all.
- **TRACED.**
- **Fix:**
  - Reword: "these are the lead's uncommitted changes, already in your base; the lead may keep editing them; change them only where your task needs to".
  - Write the full list to a file in the worktree's git dir and name that file.

### 14. later: absolute or escaping untracked symlinks point the worker into the lead's clone
- **Where:** `packages/room-mcp/src/workers.ts:268`
- **Defect:** `readlink` is copied verbatim.
- **Scenario:** An untracked `cfg -> /…/lead/real.txt` in the worker still points at the lead's file, so the worker's edits write the lead's clone directly. `room_collect` then refuses the whole worker ("symlink leaving the worktree" → "Nothing written; files need manual collection").
- **REPRODUCED** that the link targets the lead's clone (`carry.mts` case `abs-symlink`). The collect refusal is TRACED (`combined-tree.ts:76-77`, `collect.ts:193-194`).
- **Fix:** Skip symlinks whose target leaves the repo, and name them.

### 15. later: a carry during a merge or rebase commits conflict markers as the worker's base
- **Where:** `packages/room-mcp/src/workers.ts:258-278`
- **Defect:** There is no check for an in-progress git operation.
- **Scenario:** A lead mid-merge spawns a worker. The worker's base contains `<<<<<<<` markers, with no warning.
- **REPRODUCED:** `carry.mts` case `mid-merge-conflict` carried `a.txt`.
- **Fix:** Reuse `assertNoOperation` (`collect.ts:50`). Skip the carry and say "finish the merge first".

### 16. later: the carry commit still runs post-commit and reference-transaction hooks
- **Where:** `packages/room-mcp/src/workers.ts:275`
- **Defect:** `--no-verify` skips only pre-commit and commit-msg. Repos with a post-commit hook (auto-push, notifications, LFS lock tooling) run it on the lead's WIP.
- **TRACED.**
- **Fix:** Add `-c core.hooksPath=/dev/null` to the commit.

### 17. later: the browser's Merged tab attributes carried lines to the worker
- **Where:** `packages/web/src/panels.ts:735-739`
- **Defect:** One base (`baseOf(people[0])`) is used for all versions.
- **Scenario:** With the lead first, a carried worker's overlay is diffed against the lead's HEAD, so the lead's carried lines appear as "lines by rohanz+w". The false `merge-conflict` spans from finding 1 are drawn on top.
- **TRACED.**
- **Fix:** Classify each version against its own `baseOf`, or against the pair base from finding 1.

### 18. later: spawning in a repo with no commits throws a raw git error
- **Where:** `packages/room-mcp/src/workers.ts:255`
- **Scenario:** The reply is "could not create a worktree for w: git rev-parse HEAD failed: fatal: ambiguous argument 'HEAD'…".
- **REPRODUCED:** `carry.mts` case `unborn`.
- **Fix:** Check for an unborn HEAD and reply "make a first commit before spawning workers".

## Verified fine
- `packages/room-mcp/test/carry-wip.test.ts` and `carry-contract.test.ts` pass (17 tests). `npm run typecheck` is clean.
- **Lead-side collect and preview:** each worker's delta is judged against its own carried commit. The lead's later edits to carried lines survive, and untouched carried files are not re-applied. Checked for two workers with different snapshots (test 3), for workers that reset their branch below the carried commit (`w.base` is still used), and for leads that commit, pull or reset after the spawn (the carried commit always descends from the merge-base).
- **Discard after carry:** the recovery patch is taken against the carried commit, so it holds only the worker's changes.
- **Carry commit settings:** identity is forced (`-c user.name/email`), signing is off, and pre-commit is skipped. It works with no git identity and with commit signing on. `core.autocrlf=true` carries correctly (reproduced).
- **What is carried:** executable bits are preserved. Staged, unstaged and deleted changes are carried. A moved submodule pointer is carried as a gitlink. A detached HEAD works (the branch is created from the sha). FIFOs are not listed by git and are ignored.
- **Failure paths:** a carry failure resets the worktree to HEAD (`reset --hard` plus `clean -fdx`). The `git()` helper keeps patch bytes untrimmed.
- **Carried worker's daemon:** it never advances the room base (`isWorkerWorktree` guard, `roomd/src/index.ts:574`). Its overlays and `room_read diff` are relative to the carried commit, so the lead's carried text is not re-published as the worker's.
- **Retirement:** `workerGitFacts` excludes the carried commit from "ahead", so an idle carried worker retires cleanly.

## Not covered
- Sparse checkout, git LFS, Windows, and `core.fsmonitor`/untracked-cache interactions with the carry.
- Behaviour of a live team server with a carried worker (finding 5 is traced, not run).
- The browser was not run (finding 17 is traced).
- The full `npm test` run, including the socket-listening suites.
- The real Claude Code host restart. For the live failure, the exact cause of the original join failure cannot be recovered without that session's MCP log. The log's timestamps on "relay … / synced … / watching N files" would separate cause 7 from causes 6 and 8.
- Server, auth and PR tooling beyond the paths above.
