---
name: room-etiquette
description: Coordinate when other participants are present, you have workers, or your human asks about Room. Unneeded while alone.
---

Room lets coding agents see overlapping work and ask each other questions before merging.
Local rooms keep everything on this machine; a team room shares your configured plans or file text with its participants (`room_state` reports the destination and level).

While alone, work normally. With company:

1. Declare `room_scope(area, summary, paths)` once per task; read the returned overlap information.
2. Claim only when Room says another participant is near the file through their scope,
   claims, or changed files. Prefer one directory claim (`path` ending `/`) for an area
   you own; otherwise use a symbol or line range. Read relevant live work with `room_read`.
   Never edit another participant's claim. Declare public-symbol changes in `plans`;
   `room_impact` shows consumers before you change an interface.
3. Answer addressed questions promptly with `room_send(type="answer", inReplyTo=...)`.
   Ask the relevant agent when uncertain; use `room_wait(questionId)` or
   `room_wait(claimId)` for a dependency. On timeout, continue independent work or wait
   again; ask your human only if their decision is actually needed. Offline sends are
   queued, so do not assume delivery.
4. Inbox interrupts require replanning; notifications need a relevance check. A real
   merge conflict arrives as an addressed notification: coordinate before editing the
   conflicting region. Routine activity stays in the feed. No explicit release or
   changed message is needed: Room detects changed definitions, and `room_done` releases claims.
5. Write against teammates' declared interfaces without recreating their changes.
   Validate dependent work with `room_preview_merge(people=[...], run="<tests>")` in a
   scratch tree. If adjacent edits need a shared line, preserve their version exactly;
   `resolve=true` can return a superset resolution for inspection.
6. If the base moves and your clone is behind, `git pull --ff-only` before further edits.
7. Before finishing, preview the current work of participants touching the same files;
   do not wait for them to finish. Resolve conflicts and run relevant tests, then call
   `room_done(summary)` with one line. Report the result and any unresolved blocker.
   Never commit or push unless asked; do not ask as a finishing ritual.

Room never changes your files unless you ask it to bring in a worker's output; explicit
exports write the ledger. `room_close` removes all branch rooms of a repo for everyone
and requires your human's explicit request. `room_leave` ends participation when asked.

For substantial parallel edits, load [room-workers](../room-workers/SKILL.md).
Collection always leaves output uncommitted and unstaged. If asked to commit, use plain git
for one task commit with a normal message. Finished headless workers cannot
answer new questions; use their output and summary. Keep bus messages brief and concrete.
