---
name: room-join
description: Choose a local or team room when your human asks to join, create, move, or leave.
---

You were joined automatically when this session started: a LOCAL room on this machine
unless ROOM_SERVER is set or this clone remembers a choice. `room_state` says which on its
first line.

Where to be is the user's call, by instruction:
- "join the room" / "join the team room": `room_leave` if you are
  in a local room, then `room_join(where="team")`. Relay the returned `note for your human`
  sharing sentence once, exactly as written. The choice is remembered for
  this clone; later sessions go there on their own.
  A bare "join the room" (including "join the room for this repo") means the team room, because the session is already in a local room by default; do not ask which room.
- "work locally" / "leave the team room" / "local room": `room_leave(forget=true)`, then
  `room_join(where="local")`.
- a server URL: `room_join(where="wss://…")`.
Never join the team room on your own initiative.

`room_join` derives the room from the git origin and branch (local rooms: from the clone
and its main branch), takes your name from your login or `git config user.name`, starts the
push-only sync daemon, and returns who is here, their scopes, open claims, and the browser
view URL. A local room needs no name and no origin remote. Pass `room` for a local join
only when the user asks for a separate, named room; it becomes `local/<name>`.
Re-joining the same room prints its current state and browser link. Moving rooms is refused
while your workers are running; wait for them or use room_collect(discard=true) first. The join reply includes the new browser link.
Live sharing does not apply other participants' edits; collection and explicit exports can write files.
In a room on a shared branch, when your human asks you to push, push to the room branch; Room tells the others to catch up. Run git pull --ff-only --autostash to catch up. If it refuses, stop and tell your human; never merge another branch into this one.

If it fails:
- "Room was updated on disk; restart this session to pick up fixes": restart this session to load the
  updated plugin before retrying.
- "not logged in": the server uses GitHub login. Preserve the server named in the error:
  call `room_login(server="…")`, show the user the code and URL it returns exactly as written,
  then call `room_login(server="…")` again with the same server to wait for GitHub to confirm.
  Retry the original join destination afterward. Never ask the user for a token. Your name in
  the room is your GitHub login.
- "no room for <repo> yet": nobody has opened this repo on the team server. Ask the user
  whether to open one; joining is not permission to open it. Only after they say yes, call
  `room_create(where="team", confirm=true)`. Once per repo; every branch then has a room and
  teammates join automatically.
- "no origin remote" when joining a team/server room: ask the user for a room name and call `room_join` with `room`. A local room needs no name and no origin; its name is derived from the clone.
- "room base is X; local HEAD is Y": run `git pull --ff-only --autostash` and try again; if it refuses, stop and tell your human; never merge another branch into this one. Do not work in the room on a different base.
- "could not sync with wss://...": the server is not reachable. Continue independent work, and ask your human only if choosing another destination blocks the task.

After joining, if the user has given you a task, immediately call
`room_scope(area, summary, paths)` describing it if others are present, then follow the room-etiquette skill.

`room_leave` when the user says they are done.

Plain `claude` on Claude Code 2.1.224 or later wakes through its messaging inbox with
no launch flag (2.1.234 on native Windows). `ROOM_WAKE=socket|channels|off` selects
the process wake path; automatic selection uses the socket first. `claude-room` is an
optional channels fallback for older Claude Code. If inbound messages are held or
refused, room messages remain for the next turn. See [Claude Code wake-ups](../../../../README.md#claude-code).
