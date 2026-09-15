---
name: room-join
description: Choose and join a room for this clone. Use when the user says "join the team room", "join the web room", "join the shared room", "work locally", "leave the team room", "create a room", "$room-join", or asks to work alongside a teammate's agent.
---

You were joined automatically when this session started: a LOCAL room on this machine
unless ROOM_SERVER is set or this clone remembers a choice. `room_state` says which on its
first line.

Where to be is the user's call, by instruction:
- "join the team room" / "join the web room" / "join the shared room": `room_leave` if you are
  in a local room, then `room_join(where="team")`. Tell the user in one line that uncommitted
  work in this clone is now visible to the repo's room members. The choice is remembered for
  this clone; later sessions go there on their own.
- "work locally" / "leave the team room" / "local room": `room_leave(forget=true)`, then
  `room_join(where="local")`.
- a server URL: `room_join(where="wss://…")`.
Never join the team room on your own initiative.

`room_join` derives the room from the git origin and branch (local rooms: from the clone
and its main branch), takes your name from your login or `git config user.name`, starts the
push-only sync daemon, and returns who is here, their scopes, open claims, and the browser
view URL. Nothing is written to disk by the room.

If it fails:
- "not logged in": the server uses GitHub login. Call `room_login`, show the user the code
  and URL it returns exactly as written, then call `room_login` again to wait for GitHub to
  confirm. Never ask the user for a token. Your name in the room is your GitHub login.
- "no room for <repo> yet": nobody has opened this repo on the team server. Tell the user;
  if they want one, call `room_create(where="team")` (once per repo; every branch then has a
  room and teammates join automatically).
- "no origin remote": ask the user for a room name and call `room_join` with `room`.
- "room base is X; local HEAD is Y": tell the user to `git pull` (or check out the shared
  commit) and try again. Do not work in the room on a different base.
- "could not sync with ws://...": the room server is not reachable. Ask the user for the
  server URL (`server` argument) or to start one with `npm run server` in the room repo.

After joining, if the user has given you a task, immediately call
`room_scope(area, summary, paths)` describing it, then follow the room-etiquette skill.
Tell the user in one line who else is in the room and what they are on.

`room_leave` when the user says they are done.

On Claude Code, wake-ups (a teammate's question or interrupt while you are idle) only arrive if the session was started with `claude --dangerously-load-development-channels plugin:room@room`. When you call room_done or otherwise go idle in a team room, tell the user in one line that you will only see new room messages on their next message unless Claude Code was started with that flag.
