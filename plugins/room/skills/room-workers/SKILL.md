---
name: room-workers
description: Use for another agent, agents in parallel, work in the background, or codex/claude to do part of it. Also use to follow up with, interrupt, collect, or discard a worker; load before room_spawn.
---

1. Split substantial work by task. Parts may share files: give each worker a function
   or area to change, and let Room surface overlap. Keep parts in one agent when they
   must edit the same lines or one needs another's result first. Run independent parts
   in parallel as a wave, then do dependent work.
   For a few lines, do it yourself. Use built-in subagents for read-only research.
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
   Pass a model only when specified.
   If asked to follow up with a worker, use `room_send(to=...)`; a message to a finished worker resumes its retained session in its worktree. To stop the current edit and redirect that same worker, send the new task with `priority="interrupt"`; discard only when the human wants its work thrown away. Codex workers use the installed Room plugin, so install the lead's Room version for Codex or use host claude.
   The worker starts with eligible uncommitted work, or pass `carry=false` to start from HEAD. Tracked changes use a carry commit on the worker branch (`git push --all` can publish them); non-ignored untracked files are copied, never committed to a branch, with a private ref for merge and recovery. Files over 5 MB or beyond 50 MB total, nested repositories, escaping symlinks and linked inputs are skipped and named in the spawn reply. Carried edits are the lead's work in progress, already in the worker's worktree to build on. Edit around and after them freely; ask the lead before changing or removing the lead's own lines. Each worker gets its own `PORT` for dev servers.
3. Briefly state what you dispatched. Workers report progress in `room_done`; they send
   notes only when the lead must know before they finish. Notes from your own workers
   do not wake you. Answer questions with `room_send(type="answer", inReplyTo=...)`;
   ask your human only for a blocking decision. Loop short `room_wait` calls (at most
   100 seconds each); read state only when more context is needed.
4. Preview current worker output together using full participant names:
   `room_preview_merge(people=[...], run="<tests>")`. Repeat after the last worker finishes
   and resolve conflicts or failing tests before collecting.
5. When asked to "bring in their work" or "take the worker's changes", call `room_collect()` once with no tag to bring every finished worker's changes into
   your working tree, uncommitted and unstaged. Conflicts write nothing: resolve them or
   collect one tag at a time. Running and failed workers are skipped. Fully collected workers
   are cleaned up after a clean exit. Regenerable build output (`dist/`, `build/`, `out/`, `.astro/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `coverage/`, `test-results/`, `playwright-report/`, `node_modules/`, `vendor/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.gradle/`, `target/`, `*.tsbuildinfo`) does not keep a collected worktree. For named artifacts, use `tag, mode="copy", paths=[...]`;
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
