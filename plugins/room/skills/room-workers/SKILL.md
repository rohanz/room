---
name: room-workers
description: Use only when the user explicitly requests Room workers or Room for delegation, or follows up with, interrupts, collects, or discards an existing Room worker. Generic requests for agents, parallel work or background work use the host’s normal delegation.
---

Rules for everyone in a room (claims, questions, waiting, previews, evidence, commands,
finishing) are in [room-etiquette](../room-etiquette/SKILL.md). This adds what a lead needs.

## Briefs

Keep briefs short: say only what the worker cannot find out for itself. That is the
outcome and why it matters, what must not break, and how you will judge it done. Leave
the method to the worker, point at sources instead of restating them, and tell it to
decide and report what it chose, asking only when blocked.

- Say it once. Rules that always hold for the project belong in its own instructions
  (`AGENTS.md`, `CLAUDE.md`), which workers read. Context for this batch goes in one file,
  `<lead checkout>/.room/briefs/<batch>.md`: give each brief its absolute path plus only its
  own slice. `.room/` is Git-ignored and never carried or collected, so every worker, with
  or without `carry=false`, reads the same live file. Codex workers can read it but not
  write it, so you own edits and announce them with `room_send`.
- Every requirement has exactly one owner. When the work follows a spec, give each worker
  the spec sections or rules that are its slice, not your summary of them, and check before
  spawning that nothing observable in the spec (a state, field, counter, event or return
  value) is left without an owner.
- When a rule covers many places ("every script that re-queues a job"), give the worker
  the rule itself and the places you know of, not only your list. It finds the rest and
  reports them. Never write "if relevant": assign it or decide it.
- When you decide something the spec does not state, mark it "decided, not in spec" so
  it gets checked against the spec.
- A reviewer or test worker gets what changed, what it must guarantee, the question you
  want answered, and the spec itself. Leave out the implementers' file lists, earlier
  rounds' findings and the author's account of the fix: they tell an independent reviewer
  where to look and what to conclude. Ask it to report any rule no brief covers, so it
  finds what the briefs missed.

A background lead is a worker like any other. Its brief says to collect its own workers
before `room_done`.

## Spawning

- Host defaults to yours. Pass a host or model only when the human asked for one. Codex
  workers use the Room plugin installed for Codex, which must match your version.
- Use the exact participant names from the `room_spawn` reply or `room_state`, and send
  them to workers that need to reach each other.
- A worker starts with a copy of your uncommitted work (`carry=false`: from HEAD only).
  Changes to tracked files become a commit on the worker's branch, which `git push --all`
  would publish. Untracked files that are not ignored are copied, and the reply names any
  that were skipped. Those edits stay yours: workers ask before changing them.
- `node_modules` links to your install, with workspace packages pointing at the worker's
  sources. If the reply warns that cross-package tests would run your code, trust a
  preview `run` over the worker's own result.
- Each worker gets its own `PORT` and a thread budget. Pass the budget to explicit
  parameters such as `n_jobs` or `num_workers`, and stagger heavy jobs.
- In a team room, `where="local"` keeps workers local. The team room still shows their
  claims and changed paths, without file text. If another lead's local worker changes the
  same file, Room cannot read the other side: ask that lead, or one of you collects and
  previews.

## While workers run

- Keep handling your human's requests, and wait only on a result you need next. Progress
  notes from your workers do not wake you. Addressed questions, completion and interrupts
  can. Being woken means a message arrived; it is not proof that content was read or acted on.
- A headless lead (`claude -p`, `codex exec`) must stay alive until supervision is complete:
  ending the turn ends the session. Use short `room_wait` calls instead. So does any lead
  whose host cannot wake it.
- A message from its lead to a finished worker resumes its retained session in its
  worktree. `refresh=true` first rebases a stopped worker onto your HEAD and lists what
  came in; a conflict changes nothing. For a dependency on a running worker, use a named
  preview. `priority="interrupt"` redirects a worker in the middle of an edit.
- If one worker finishes while another is far from done, ask the running worker what
  remains and hand some over. Agree the handoff before the new owner edits.
- Restarting or reconnecting your Room MCP stops running workers. Worktrees and sessions
  remain, and the next reply says how to resume. For workers stopped because an earlier
  session ended, ask the human whether to restart or discard them; do not silently redo
  their work.

## Review holds

Use these only when the human asks for a review checkpoint.

- `room_review(action="hold", reason=...)`, called from the checkout that will receive the
  work, blocks new collection there until it is released. Workers keep working.
- A reviewer whose approval is required creates the hold itself, from that checkout and
  not from its own worktree. It keeps the private `reviewToken`, so the collecting lead
  cannot release it.
- A message does not create a hold. Releasing does not collect. Every reviewer must release.

## Previews

Preview combined work by name while workers run. Include yourself when workers started
at different times or from different versions of your work: Room then starts from your
copy and adds each worker's changes on top. A clean text merge still needs a behavioural test.

## Collecting

- `room_collect()` brings every finished worker's changes into your working tree,
  uncommitted and unstaged, and ends resumption. Conflicts write nothing: resolve them or
  collect one tag at a time. Running and failed workers are skipped.
- `room_collect(keep=true)` applies finished output and keeps the worktree, branch, logs
  and session, so follow-ups still work. Later collection applies only what changed since.
  Kept output counts as yours: before `refresh=true`, commit it and anything carried at
  spawn, or Room refuses. Finish kept workers with plain `room_collect()`.
- `room_collect(tag, discard=true)` throws the work away: it stops the worker and removes
  its worktree, branch and logs, ignored files included. A recovery commit is kept for a
  week and the reply says how to restore it. Discard only when the human wants the work gone.
- Ignored build output is left behind, and scratch (`*.log`, `*.tmp`) is saved to
  `.room/scratch/<tag>/`. Bring named artifacts and files over 5 MB with
  `room_collect(tag, mode="copy", paths=[...])`. A worktree holding unexpected files is
  kept, and `room_state` says why.
- Collect, discard and stop also stop processes running inside the worktree.

## Finishing

You own validation of the collected tree, including the CI checks the change requires.
room-etiquette says when a passing preview can stand in for it. Workers are plain
`codex exec` / `claude -p` processes: stop your jobs by pid, never by a pattern such as
`pkill -f codex`. Never commit or push unless the human asked.

For a missing wake or a worker problem, see `room_state(check=true)` and
`<git common dir>/room-mcp.log`.
