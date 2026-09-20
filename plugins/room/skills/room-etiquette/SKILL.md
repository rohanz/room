---
name: room-etiquette
description: How to work in a shared room with other people and their agents. Use when someone else is in the room, when you spawned workers, or when the user asks about the room. Not needed while you are alone.
---

How to work in a shared room with other people and their agents. Use when someone else is in the room, when you spawned workers, or when the user asks about the room. Not needed while you are alone.

You are one person's coding agent in a shared room. Other people and their agents work on
the same repo at the same time. The room tools show who is on what, what they plan to
change, what they changed, and let you coordinate. Nothing you do in the room touches your
disk; edit files with your normal tools.

## Rules

1. `room_scope(area, summary, paths)` before editing: one word for the area (`auth`,
   `orders`, ...), one line, the paths you expect to touch. Read the area ledger it returns:
   what others changed there and their open plans.
2. A tool reply starts with your inbox when you have unread messages. `interrupt`: stop and re-plan before
   continuing. `notify`: check whether it touches what you are doing. `fyi`: nothing.
   Routine scope, release, change, and done-note events stay in the room feed and browser;
   they do not enter the inbox unless explicitly addressed to you.
3. Before renaming or changing a signature: `room_impact(symbol)` shows who defines and
   uses it and who owns those files. `room_state` lists what you are waiting on: others'
   planned changes to symbols your files use.
4. Before editing a region: `room_read` it (note claims and the file ledger), then
   `room_claim(path, symbol, intent, plans)`, or `from`/`to` for a line range. Declare `plans`
   whenever you will rename, change a signature, delete, or add a public symbol; whoever uses
   those symbols is told immediately, before you edit. A changed definition line is also
   detected from your diff and reported to its consumers, but only once the edit exists.
   Keep claims small and short-lived.
5. Never edit inside another party's claim. `room_wait(claimId)` or ask with
   `room_send type=question to=<person>`, then `room_wait(questionId)`.
6. `room_release(claimId, summary, done)` when finished, then `room_send type=changed` with
   paths, a one-line summary and `symbols` for anything others may depend on.
7. Answer questions addressed to you on your next move: `room_send type=answer
   inReplyTo=<id>`. `room_send` is for OTHER people's agents; to ask your own human, say it
   in your reply and stop.
8. If a wait times out, tell your human and proceed only where you do not depend on the
   answer.
   If the room is offline, sends are only queued locally and waits cannot observe replies;
   tell your human and do not assume delivery.
9. If a conflict is reported: do not edit that region; ask, wait, or tell your human.
   Conflict notices arrive automatically when your edit overlaps someone's claim or your
   file now conflicts with theirs; treat them like interrupts.
10. Never re-create another person's change in your clone, and never edit lines that belong
    to their claim or announced change. When they announce a rename, signature or new symbol,
    write your code against the declared name and carry on; your clone lags until git merges.
    - To verify code that depends on their unmerged work:
      `room_preview_merge(person, run="<test command>")` runs the tests on the merged tree
      without touching any clone.
    - If you insert next to a line they changed, copy their version of that line exactly.
      The preview then reports the overlap as resolvable, and
      `room_preview_merge(person, resolve=true)` returns the resolved file for your clone.
11. A `base` entry means someone committed and the room moved forward. If your status
    says behind, run `git pull --ff-only` before editing further; the ledger lists which
    paths changed.
12. Before telling your human you are done: `room_preview_merge(person, run=<tests>)`
    against each person who changed the same files, using their CURRENT state (a lead
    previews all its workers at once with `people=[...]`, merged in order). Do not wait
    for them to finish their task and do not ask them to tell you when they are ready; if
    their later work conflicts, they will see it in their own preview. Then
    `room_done(summary)` so the room shows your task as finished; stay in the room for
    questions.
13. Report to your human in one line: what landed, the test count, and whether the merge
    preview with each teammate was clean (name any conflicting files). Then ask whether to
    commit and push. Never commit or push unless they say yes; after a push, teammates are
    told the base moved. `room_leave` when the session ends.
14. `room_close` removes every branch room of the repo for everyone. Only on the user's
    explicit ask. It exports the room's story to `.room/ledger/` first; `room_export` does
    that on its own at any time.

Be brief on the bus: one line, concrete paths, line numbers and symbol names.

## Parallel work

For parallel edits, load the [room-workers skill](../room-workers/SKILL.md).
Follow it for dispatch, coordination, preview and merge; keep built-in subagents for read-only work.

## Same file, different sections

That is the normal case and needs no conversation. Claim your lines, they claim theirs.
Only overlapping line ranges or shared symbols need a question.
