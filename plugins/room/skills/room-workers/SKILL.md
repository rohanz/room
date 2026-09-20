---
name: room-workers
description: How to run parallel work through room workers. Use when the user asks to parallelise work that edits files, in any words (subagents, split this up, fan this out, get codex to do part of it), or when you are about to call room_spawn.
---

Route parallel work that EDITS files through `room_spawn`, whether or not the user said
"room". Use the host's built-in subagents for read-only or research fan-out. If unsure
whether the parts edit files, treat them as edits.

1. Split the task into independent parts with disjoint files where possible. Give each a short tag.
2. Call `room_spawn(tag, task, host, model?)` for each part. Explicitly set `host` to your
   own host (`codex` or `claude`) unless the user names another: "get codex to…" means
   `host="codex"`. The tool itself defaults to Claude. Pass `model` only when specified.
   Give each worker a self-contained task, the files it owns, and the test command.
3. Tell the user in one line what you dispatched and the browser link from `room_state`.
4. Loop on `room_wait`, then check `room_state`. Answer workers' questions promptly with
   `room_send(type="answer", inReplyTo="<question id>", text="…")`; relay decisions needing
   the human to your user and send their answer back. Check failures instead of waiting forever.
5. As workers report done, call `room_preview_merge(people=[...], run="<test command>")`
   with all workers together, using their full participant names returned by spawn.
   Repeat after the last finishes; resolve conflicts and failing tests before merging.
6. Commit each worker's uncommitted changes in its own worktree as the lead, then merge
   their `room/<tag>` branches into your branch. Never push. Respect any explicit user
   restriction on commits or merges; if prohibited, leave the previewed changes uncommitted.
7. Report what landed, the test result, conflicts, and that nothing is pushed.
   Call `room_dismiss(tag)` for any worker whose process is still running, even after it reports done.

Respect `ROOM_MAX_WORKERS` (default 8); wait for capacity. Do not spawn for a task that
is one file or a few lines. Never spawn into the team room unless you, the lead, are in it;
never join it just to dispatch workers. "Locally" / "in a local room" means pass
`where="local"` to `room_spawn`: the workers room stays on this machine. A lead already
in the team room still mirrors workers' scope and claims there. Otherwise omit `where`
to use your current room.
