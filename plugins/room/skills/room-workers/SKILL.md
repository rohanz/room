---
name: room-workers
description: Use only when the user explicitly requests Room workers or Room for delegation, or follows up with, interrupts, collects, or discards an existing Room worker. Generic requests for agents, parallel work or background work use the host’s normal delegation.
---

Use this workflow only for explicit Room delegation or its continuation. Installing or joining Room does not authorize Room workers. Otherwise use the host’s normal delegation.

1. Split substantial work by task. Parts may share files: give each worker a function
   or area to change, and let Room surface overlap. Keep parts in one agent when they
   must edit the same lines or one needs another's result first. Run independent parts
   in parallel as a wave, then do dependent work.
   For a few lines, do it yourself unless the human explicitly requested a Room worker.
   For one or two workers, lead them yourself. Before three or more workers or a long
   batch, especially when this session cannot be woken, offer once: "I can hand this to a background lead that stays on it until it's done; you can keep talking to me."
   If your human already said to go ahead, or chose how to run it, skip the offer and dispatch.
   If accepted, spawn one worker with a self-contained lead brief: the task, how to
   split it into tasks with functions or areas to change, the test command, and "collect your workers
   before room_done". That lead spawns the workers, answers their questions in a
   room_wait loop, previews and tests, collects their changes, then calls room_done.
   Steer it with room_send to its full `<lead>+<tag>` name; collect it at the end like
   any worker.
   A plan with sequential stages still parallelises within each stage: run each stage
   as a wave of workers. Workers do not share context; each needs its own brief. What
   Room does between them: shows who is near which file, warns before two edits collide,
   and when a worker changes a function's signature or removes a definition, tells the
   workers whose files use it (detected from the diff, no message needed). Workers
   claim the functions or line ranges they edit, ask each other questions, and check
   their combined changes in a preview before collection.
2. Call `room_spawn(tag, task, host?, model?)`. Host defaults to your own host; override
   only when requested. Give each worker a self-contained task, functions or areas to
   change, and a test command. Shared files are fine; ask workers to claim their regions.
   Tell them to run tests and builds in the foreground: ending a headless worker's turn kills its background jobs.
   The worker's `node_modules` links to your install with workspace packages pointing at its own sources; if the spawn reply warns that its cross-package tests would run your code, trust a preview with `run` over the worker's own test result.
   Pass a model only when specified.
   If asked to follow up with a worker, use `room_send(to=...)`; a message from its lead to a finished worker resumes its retained session in its worktree. Other workers ask that lead for a follow-up. When it needs a commit you made after spawning it, add `refresh=true`: Room rebases its branch onto your HEAD first (a stopped worker only; a conflict changes nothing) and tells it which commits came in. Do not point it at files in your tree. To stop the current edit and redirect that same worker, send the new task with `priority="interrupt"`; discard only when the human wants its work thrown away. Codex workers use the installed Room plugin, so install the lead's Room version for Codex or use host claude.
   The worker starts with eligible uncommitted work, or pass `carry=false` to start from HEAD. Tracked changes use a carry commit on the worker branch (`git push --all` can publish them); non-ignored untracked files are copied, never committed to a branch, with a private ref for merge and recovery. Files over 5 MB or beyond 50 MB total, nested repositories, escaping symlinks and linked inputs are skipped and named in the spawn reply. Carried edits are the lead's work in progress, already in the worker's worktree to build on. Edit around and after them freely; ask the lead before changing or removing the lead's own lines. Each worker gets its own `PORT` for dev servers.
3. Briefly state what you dispatched. Workers report progress in `room_done`; they send
   notes only when the lead must know before they finish. Routine progress notes from
   your own workers do not wake you; addressed questions, worker completion (room_done),
   and eligible interrupts can. Claude Code uses its inbox (2.1.224+ on macOS/Linux,
   2.1.234+ on Windows, or channels fallback); Codex uses `codex queue`. With an
   available wake path, an interactive lead can continue other work or wait for a wake
   instead of polling or watching worker PIDs. Host settings can still block delivery.
   A headless lead must stay alive: use short room_wait calls while supervising workers.
   If wake is unavailable or disabled, use room_wait too (at most 100 seconds per call);
   messages also arrive on other Room tool replies and eligible before-edit hooks.
   If an expected wake is missing, inspect room_state(check=true) and room-mcp.log;
   do not infer that Room cannot wake sessions from the progress-note rule. Answer
   questions with room_send(type="answer", inReplyTo=...); ask your human only for a
   blocking decision. A process-exit watcher cannot substitute for mid-task questions.
4. If the human explicitly requests a review checkpoint before collection, establish it
   before dispatch or collection: from the destination checkout call
   `room_collect(checkpoint="hold", reason="<requested review>")` and wait for success.
   A separate reviewer/controller should own the hold when its approval is required;
   it must use that same checkout, not its own worker worktree. Keep the returned private
   `reviewToken` for recovery; do not send it to the collecting lead. Messages alone do
   not establish holds. Preview, tests and worker follow-ups can continue while held.
   After review, the creating session calls `room_collect(checkpoint="release")`;
   a replacement reviewer can use `reviewToken` to release it. Release does not collect.
   Check with `room_collect(checkpoint="status")`; all reviewers must release their holds.
   Do not establish a hold when no checkpoint was requested. This blocks new collection
   calls for that destination only; it does not cancel an already-running collection,
   freeze lifecycle recovery, or protect against explicit leave/ancestor discard.
   Preview current worker output together using full participant names:
   `room_preview_merge(people=[...], run="<tests>")`. Repeat after the last worker finishes
   and resolve conflicts or failing tests before collecting.
5. When asked to "bring in their work" or "take the worker's changes", call `room_collect()` once with no tag to bring every finished worker's changes into
   your working tree, uncommitted and unstaged. Conflicts write nothing: resolve them or
   collect one tag at a time. Running and failed workers are skipped. Fully collected workers
   are cleaned up after a clean exit. Regenerable build output (`dist/`, `build/`, `out/`, `.astro/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `coverage/`, `test-results/`, `playwright-report/`, `node_modules/`, `vendor/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.gradle/`, `target/`, `*.tsbuildinfo`) does not keep a collected worktree. Recognized Python environments (`.venv/`, `venv/`, with valid `pyvenv.cfg`, interpreter and standard layout) are also disposable, including installed packages and other contents inside their standard directories. Unexpected top-level files, wrong entry types or linked environment roots keep the worktree for inspection. Worker scratch (untracked `*.log`, `*.tmp`, temp and swap files) is not collected; a copy is saved under `.room/scratch/<tag>/`. For named artifacts, use `tag, mode="copy", paths=[...]`;
   "Throw away the worker" means `tag, discard=true`: it stops the worker and removes its owned worktree, branch and logs, keeping a recovery patch for a week. A worker started with `dir=` in another worker's checkout detaches without removing it; discard the owner after its other users finish. Collect, discard and stop also stop processes running inside an owned worktree.
6. Run the tests on the real working tree, then report the work and validation result.
   Never commit or push unless the human asked. If asked to commit, use plain git for one
   task commit with a normal message; worker details do not belong in the history.

When you find workers stopped because the previous session ended, tell the human and ask whether to restart or discard them; do not silently redo their work.

Respect `ROOM_MAX_WORKERS`. Do not join a team room just to dispatch workers.
`where="local"` keeps workers local; a lead already in a team room still mirrors their
scope and claims there. Otherwise omit `where` to use the current room.

Room writes timestamped MCP events to the shared, 0600 `<git common dir>/room-mcp.log`; it rotates at 1 MB and keeps one older generation.

Room caps math-library threads. Pass the spawn reply's budget to explicit parameters
such as `n_jobs`, `num_threads` and `num_workers`; stagger heavy jobs.
