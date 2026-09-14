---
name: room-join
description: Join (or open) the shared room for this repo so this Codex session can see what teammates and their agents are doing and coordinate with them. Use when the user says "join the room", "create a room", "$room-join", or asks to work alongside a teammate's agent.
---

If the repo already has a room you were joined automatically when this session started;
`room_state` confirms it. Otherwise call `room_join` with no arguments. It derives the room
from the git origin and branch, takes your name from `git config user.name`, starts the
push-only sync daemon, and returns who is here, their scopes, open claims, and the browser
view URL. Nothing is written to disk by the room.

If it fails:
- "no room for <repo> yet": nobody has opened this repo. Tell the user; if they want one,
  call `room_create` (once per repo; every branch then has a room and teammates join
  automatically).
- "no origin remote": ask the user for a room name and call `room_join` with `room`.
- "room base is X; local HEAD is Y": tell the user to `git pull` (or check out the shared
  commit) and try again. Do not work in the room on a different base.
- "could not sync with ws://...": the room server is not reachable. Ask the user for the
  server URL (`server` argument) or to start one with `npm run server` in the room repo.

After joining, if the user has given you a task, immediately call
`room_scope(area, summary, paths)` describing it, then follow the room-etiquette skill.
Tell the user in one line who else is in the room and what they are on.

`room_leave` when the user says they are done.
