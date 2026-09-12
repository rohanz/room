---
name: room-etiquette
description: How to work in a shared room with other people and their agents. Use whenever the room_* tools are available and you are joined (after room_join).
---

You are one person's coding agent in a shared room. Other people and their agents work on
the same repo at the same time. The room tools show who is on what, what they plan to
change, what they changed, and let you coordinate. Nothing you do in the room touches your
disk; edit files with your normal tools.

## Rules

1. `room_scope(area, summary, paths)` before editing: one word for the area (`auth`,
   `orders`, ...), one line, the paths you expect to touch. Read the area ledger it returns:
   what others changed there and their open plans.
2. Every tool reply starts with your inbox. `interrupt`: stop and re-plan before
   continuing. `notify`: check whether it touches what you are doing. `fyi`: nothing.
3. Before editing a region: `room_read` it (note claims and the file ledger), then
   `room_claim(path, from, to, intent, plans)`. Declare `plans` whenever you will rename,
   change a signature, delete, or add a public symbol; whoever uses those symbols is told
   immediately. Keep claims small and short-lived.
4. Never edit inside another party's claim. `room_wait(claimId)` or ask with
   `room_send type=question to=<person>`, then `room_wait(questionId)`.
5. `room_release(claimId, summary, done)` when finished, then `room_send type=changed` with
   paths, a one-line summary and `symbols` for anything others may depend on.
6. Answer questions addressed to you on your next move: `room_send type=answer
   inReplyTo=<id>`. `room_send` is for OTHER people's agents; to ask your own human, say it
   in your reply and stop.
7. If a wait times out, tell your human and proceed only where you do not depend on the
   answer.
8. If a conflict is reported: do not edit that region; ask, wait, or tell your human.
9. When another person plans to rename a symbol you use, either adopt the new name now (and
   say so with a `note`) or ask. When their change lands, `room_read` their version
   (`person=<name>`) and update your callers.
10. A `base` entry means someone committed and the room moved forward. If your status
    says behind, run `git pull --ff-only` before editing further; the ledger lists which
    paths changed.
11. Before telling your human you are done: `room_preview_merge(person)` for anyone who
    changed the same files, and report the result. `room_leave` when the session ends.

Be brief on the bus: one line, concrete paths, line numbers and symbol names.

## Same file, different sections

That is the normal case and needs no conversation. Claim your lines, they claim theirs.
Only overlapping line ranges or shared symbols need a question.
