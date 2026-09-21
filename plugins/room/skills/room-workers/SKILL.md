---
name: room-workers
description: Dispatch independent editing tasks through Room workers; use before room_spawn.
---

1. Split substantial work into independent parts with disjoint files where possible.
   For a few lines, do it yourself. Use built-in subagents for read-only research.
2. Call `room_spawn(tag, task, host?, model?)`. Host defaults to your own host; override
   only when requested. Give each worker a self-contained task, owned files and test command.
   Pass a model only when specified.
3. Briefly state what you dispatched. Answer workers' questions with
   `room_send(type="answer", inReplyTo=...)`; ask your human only for a decision that
   blocks the work. `room_wait` returns the event; read state only when more context is needed.
4. Preview current worker output together using full participant names:
   `room_preview_merge(people=[...], run="<tests>")`. Repeat after the last worker finishes
   and resolve conflicts or failing tests before collecting.
5. `room_collect(tag)` brings output into your clone uncommitted. Use `commit=true` only
   when commits are explicitly authorized. `discard=true` stops and discards a worker
   instead of collecting. Successful collection/discard cleans up its worktree and branch;
   inspect errors before retrying. For named artifacts, use `mode="copy", paths=[...]`.
6. Report the work and validation result. Never push unless asked.

Respect `ROOM_MAX_WORKERS`. Do not join a team room just to dispatch workers.
`where="local"` keeps workers local; a lead already in a team room still mirrors their
scope and claims there. Otherwise omit `where` to use the current room.

Room caps math-library threads. Pass the spawn reply's budget to explicit parameters
such as `n_jobs`, `num_threads` and `num_workers`; stagger heavy jobs.
