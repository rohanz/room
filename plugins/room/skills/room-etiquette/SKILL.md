---
name: room-etiquette
description: Use when others are present, you have workers, or your human asks about Room, who is here, sharing, claims, or coordination. Unneeded while alone.
---

Local rooms keep everything on this machine; a team room shares your configured plans or file text with its participants (`room_state` reports the destination and level).

To show the room in a browser, call `room_open` (success means the OS accepted the launch);
if it fails, return its complete URL. For only a link, return `room_state(link=true)`'s
complete URL as copyable text (clients may strip fragments): the whole fragment is the
view capability. Never commit the full link to documentation or logs.

While alone, work normally. With company:

1. Declare `room_scope(area, summary, paths)` once per task; read the returned overlap.
2. Claim only when Room says another participant is near the file through their scope,
   claims, or changed files. Claim the files you will edit; use a symbol or line range
   for part of a file (a file you added is claimed whole with no range; a base file needs
   from=1 and to=<last line>). Read relevant live work with `room_read`. Never edit another
   participant's claim. Declare public-symbol changes in `plans`; `room_impact` shows consumers.
3. Answer addressed questions promptly with `room_send(type="answer", inReplyTo=...)`.
   Use exact participant names returned by `room_spawn` or `room_state`; never construct
   them from owner and tag. Ask the peer responsible for a dependency directly; ask the lead,
   if any, about scope decisions or unresolved ownership. Without a lead, agree scope with affected peers.
   Send findings directly to the owning peer with `room_send(type="note"/"question", to=...)`.
   For a finished registered worker, ask its lead to resume it when an answer is needed;
   independent peers manage their own sessions. Offline sends are queued: do not assume delivery.
4. Waiting. Continue independent work while an answer is pending. When blocked, use
   `room_wait(questionId)` for that answer or `room_wait(claimId)` for the blocking claim
   (at most 100 seconds per call). A timeout is not an answer or approval; permission
   decisions stay with the human. room_wait observes Room dependencies only: one room_wait
   at a time, and use host task completion for your own commands. An interactive session
   with an available wake path does not poll: with nothing else to do, end the turn. A headless session (`claude -p`, `codex exec`), or one whose wakes
   are unavailable or disabled, stays alive until its Room work is complete and uses short
   room_wait calls when blocked; messages also arrive on other Room tool replies and eligible
   before-edit hooks. For a missing wake, inspect `room_state(check=true)` and `room-mcp.log`
   before concluding that Room cannot wake the host.
5. Interrupts require replanning; notifications need a relevance check. A real merge conflict
   arrives addressed to you: coordinate before editing that region. No release or changed
   message is needed: Room detects changed definitions; `room_done` releases claims.
6. Evidence. Start independent work while interfaces are agreed; implement each part when
   its interfaces are agreed, and test against peers' live work without waiting for an
   integrated checkout: `room_preview_merge(people=["<returned peer name>"], run="<focused test command>")`,
   naming relevant peers, including finished ones. Never copy peer files into your overlay to
   test: that duplicates ownership and can trigger conflict notices. If adjacent edits need
   a shared line, preserve their version exactly; `resolve=true` returns a superset resolution
   for inspection. Choose task-appropriate evidence: focused checks for changed behavior,
   source review or document checks where applicable. Whoever integrates owns comprehensive
   relevant validation of the integrated result, including the CI checks the change requires.
   Agree who runs a shared check and share its inputs, command and result.
   - Name tests or a single file rather than whole suites so a preview `run` finishes well under the 5-minute limit
     (it also stops at 4 MB of output); keep it under two minutes, since interactive Claude
     Code moves a longer tool call to a background task. Narrow a command stopped at the time limit; do not repeat it on unchanged inputs.
     Room refuses an identical timed-out command on the same inputs unless `allowSlow: true` is passed; the limit still applies.
   - A default preview selects overlapping present peers and your own running workers; a
     reply naming skipped non-overlapping present peers means they are here: name the
     dependencies in `people`.
   - A pass is interim evidence for those revisions; it does not certify the latest combined
     code or rerun automatically. Reuse a complete passing preview only for identical preview inputs, command and relevant environment.
     Validate the collected tree unless collect reports it identical to the most recent preview of this checkout, which passed the same command you would run.
     The report covers files and command only: Git state (HEAD, refs, index), environment and ignored files are not compared.
     Rerun commands that read Git state on the collected tree, even when HEAD is unchanged.
     Files written by another process during collect are outside the guarantee; stop concurrent writers.
     Rerun when installed dependencies, ignored build output or services the command depends on differ.
     Leads should start the final full check as a preview while the last workers finish, if it fits
     the preview limit; longer commands must run on the collected tree.
     Partial, timed-out or output-limited runs do not validate the whole tree. Rerun for relevant
     changes, failures or uncertain inputs; before `room_done`, verify the evidence is current.
     Do not skip checks solely because reported changed paths do not overlap.
7. Commands. On Claude Code with documented background-command lifetime and completion
   delivery (verified on 2.1.300), use host-managed background execution for long commands
   when responsiveness matters; await native completion and inspect the actual result before room_done.
   It does not protect unmanaged jobs from process exit. On unverified hosts, including Codex,
   keep commands in the foreground until background lifetime and completion delivery are verified.
   Background commands have [time limits](https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands)
   (10 minutes for text-prompt `-p`, 30 for stream-json; a `timeout` extends to 2 hours): check
   the installed host's docs before a longer run. A timeout, interruption or missing result is not a pass.
   After required results are inspected, stop remaining background commands and monitors you started before `room_done` and the final message so the host exits cleanly.
8. When your human asks you to push, push your current branch; Room tells teammates on that branch to catch up. Run git pull --ff-only --autostash to catch up on a shared branch. If it refuses, or your push is rejected, stop and tell your human; never merge another branch into this one, and do not undo, rebase or recommit your commits to get past it without their yes.
9. Finishing. A brief is a slice of the task, not its edge: when a rule you own reaches code
   your brief does not name, handle it or ask the lead who owns it, and list what you found
   in your summary. Get a current preview of relevant peers, including affected dependencies,
   without waiting for them to finish; resolve conflicts, run relevant tests, then call
   `room_done(summary)` with one line: the result and any unresolved blocker. Workers report
   progress there; send a lead note only when it must know before you finish. Never commit or push unless asked; do not ask as a finishing ritual.

Room never changes your files unless you ask it to bring in a worker's output; explicit
exports write the ledger. `room_close` removes the repository room for everyone on every
branch and requires your human's explicit request. `room_leave` ends participation when asked.
Keep bus messages brief and concrete.

Only when the human explicitly asks to delegate through Room, or continues an existing Room worker workflow, load [room-workers](../room-workers/SKILL.md). Generic requests for agents, parallel work or background work use the host's normal delegation, even while joined to Room.
