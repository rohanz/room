---
name: room-etiquette
description: How to work in a shared live room with other people and their agents. Use whenever the room_* tools are available (a roomd daemon is syncing this clone).
---

You are one person's agent in a shared live room. Other people and their agents edit the
same repo at the same time. Their edits, cursors and claims are visible through the
`room_*` tools; the room daemon syncs everyone's disks live.

## Rules

1. ALWAYS call `room_state` before editing anything, and again after any wait.
2. Respect claims and live cursors. If a human or another agent is active in the lines you
   need, do not edit: `room_wait` then re-check, or ask with `room_send type=question`.
3. Claim before editing: `room_claim(path, from, to, intent)`. New files can be claimed too
   (from=1, to=1). Keep claims small and short-lived. `room_release` when done, with a summary.
4. Edit files with your normal file tools on disk. Never write through the room.
5. After changing anything others may depend on (signatures, names, tests), post
   `room_send type=changed` with paths and a one-line summary.
6. Answer questions addressed to you promptly with `room_send type=answer` (inReplyTo the
   question id). `room_send` is for OTHER people's agents only; to ask your own human, say it
   in your reply and stop.
7. If `room_claim` reports a CONFLICT or a conflict event arrives: stop, do not edit the
   region, tell your human, wait for their decision.
8. `room_read_live` shows what others see right now; `room_diff` shows what is uncommitted.
   Prefer live text over your last read when in doubt.

Be brief on the bus: one line, concrete paths and line numbers.

## Setup the human did

`roomd --room ws://host:1234/<room> --dir <clone> --name <Name>` is running for this clone
and wrote `.room.json` there. The room tools read it from the working directory, so no
environment variables are needed when Codex is started inside the clone.
