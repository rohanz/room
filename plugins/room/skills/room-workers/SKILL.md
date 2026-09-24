---
name: room-workers
description: Running editing work through other agents. Use when asked for another agent, a few agents in parallel, work in the background, or for codex/claude to do part of it; load before room_spawn.
---

1. Split substantial work into independent parts with disjoint files where possible.
   For a few lines, do it yourself. Use built-in subagents for read-only research.
   For one or two workers, lead them yourself. Before three or more workers or a long
   batch, especially when this session cannot be woken, offer once: "I can hand this to a background lead that stays on it until it's done; you can keep talking to me."
   If accepted, spawn one worker with a self-contained lead brief: the task, how to
   split it into workers with owned files, the test command, and "collect your workers
   before room_done". That lead spawns the workers, answers their questions in a
   room_wait loop, previews and tests, collects their changes, then calls room_done.
   Steer it with room_send to its full `<lead>+<tag>` name; collect it at the end like
   any worker.
   A plan with sequential stages still parallelises within each stage: run each stage
   as a wave of workers. Workers do not share context; each needs its own brief. What
   Room does between them: shows who is near which file, warns before two edits collide,
   and when a worker changes a function's signature or removes a definition, tells the
   workers whose files use it (detected from the diff, no message needed).
2. Call `room_spawn(tag, task, host?, model?)`. Host defaults to your own host; override
   only when requested. Give each worker a self-contained task, owned files and test command.
   Pass a model only when specified.
   The worker starts with eligible uncommitted work, or pass `carry=false` to start from HEAD. Tracked changes use a carry commit on the worker branch (`git push --all` can publish them); non-ignored untracked files are copied, never committed to a branch, with a private ref for merge and recovery. Files over 5 MB or beyond 50 MB total, nested repositories, escaping symlinks and linked inputs are skipped and named in the spawn reply. Carried files remain the lead's; coordinate with the lead before editing them. Each worker gets its own `PORT` for dev servers.
3. Briefly state what you dispatched. Workers report progress in `room_done`; they send
   notes only when the lead must know before they finish. Notes from your own workers
   do not wake you. Answer questions with `room_send(type="answer", inReplyTo=...)`;
   ask your human only for a blocking decision. Loop short `room_wait` calls (at most
   100 seconds each); read state only when more context is needed.
4. Preview current worker output together using full participant names:
   `room_preview_merge(people=[...], run="<tests>")`. Repeat after the last worker finishes
   and resolve conflicts or failing tests before collecting.
5. Call `room_collect()` once with no tag to bring every finished worker's changes into
   your working tree, uncommitted and unstaged. Conflicts write nothing: resolve them or
   collect one tag at a time. Running and failed workers are skipped. Fully collected workers
   are cleaned up after a clean exit. Regenerable build output (`dist/`, `build/`, `out/`, `.astro/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `coverage/`, `test-results/`, `playwright-report/`, `node_modules/`, `__pycache__/`, `.pytest_cache/`, `target/`) does not keep a collected worktree. For named artifacts, use `tag, mode="copy", paths=[...]`;
   `tag, discard=true` stops a worker and removes its worktree, branch and logs, keeping a recovery patch for a week. Collect, discard and stop also stop processes running inside the worktree.
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
