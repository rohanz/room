---
name: room-workers
description: Running editing work through other agents. Use when asked for another agent, a few agents in parallel, work in the background, or for codex/claude to do part of it; load before room_spawn.
---

1. Split substantial work into independent parts with disjoint files where possible.
   For a few lines, do it yourself. Use built-in subagents for read-only research.
   A plan with sequential stages still parallelises within each stage: run each stage
   as a wave of workers. Workers do not share context; each needs its own brief. What
   Room does between them: shows who is near which file, warns before two edits collide,
   and when a worker changes a function's signature or removes a definition, tells the
   workers whose files use it (detected from the diff, no message needed).
2. Call `room_spawn(tag, task, host?, model?)`. Host defaults to your own host; override
   only when requested. Give each worker a self-contained task, owned files and test command.
   Pass a model only when specified.
   The worker starts from your code as it is now, including uncommitted work, and your own work is never reported as the worker's.
3. Briefly state what you dispatched. Answer workers' questions with
   `room_send(type="answer", inReplyTo=...)`; ask your human only for a decision that
   blocks the work. `room_wait` returns the event; read state only when more context is needed.
4. Preview current worker output together using full participant names:
   `room_preview_merge(people=[...], run="<tests>")`. Repeat after the last worker finishes
   and resolve conflicts or failing tests before collecting.
5. Call `room_collect()` once with no tag to bring every finished worker's changes into
   your working tree, uncommitted and unstaged. Conflicts write nothing: resolve them or
   collect one tag at a time. Running and failed workers are skipped. Fully collected workers
   are cleaned up after a clean exit. For named artifacts, use `tag, mode="copy", paths=[...]`;
   `tag, discard=true` stops a worker and removes its worktree, branch and logs, keeping a recovery patch for a week.
6. Run the tests on the real working tree, then report the work and validation result.
   Never commit or push unless the human asked. If asked to commit, use plain git for one
   task commit with a normal message; worker details do not belong in the history.

When you find workers stopped because the previous session ended, tell the human and ask whether to restart or discard them; do not silently redo their work.

Respect `ROOM_MAX_WORKERS`. Do not join a team room just to dispatch workers.
`where="local"` keeps workers local; a lead already in a team room still mirrors their
scope and claims there. Otherwise omit `where` to use the current room.

Room caps math-library threads. Pass the spawn reply's budget to explicit parameters
such as `n_jobs`, `num_threads` and `num_workers`; stagger heavy jobs.
