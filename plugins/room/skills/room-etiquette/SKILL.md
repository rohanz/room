---
name: room-etiquette
description: Use when others are present, you have workers, or your human asks about Room, who is here, sharing, claims, or coordination. Unneeded while alone.
---

Room lets coding agents see overlapping work and ask each other questions before merging.
Local rooms keep everything on this machine; a team room shares your configured plans or file text with its participants (`room_state` reports the destination and level).

When asked to open or show the room in a browser, call `room_open`. It opens the
current room in the configured HTML handler (normally your browser), preserving the complete URL. A successful tool
reply means the OS accepted the launch, not that the page was verified as connected.
If opening fails, return the tool's complete URL for pasting into the address bar.

When asked only for a room/browser link, call `room_state(link=true)` and return the
complete URL; do not launch a browser. Some clients strip fragments or block local
`file://` links: include the complete local URL as copyable text, and only present it
as clickable when that host is known to preserve it. Local links work on this machine.
The entire fragment, including the view capability, is required; the bare HTML path
is not a room link. Never commit the full link to documentation or logs.

While alone, work normally. With company:

1. Declare `room_scope(area, summary, paths)` once per task; read the returned overlap information.
2. Claim only when Room says another participant is near the file through their scope,
   claims, or changed files. Claim the files you will edit; use a symbol or line range
   when you need only part of a file. Read relevant live work with `room_read`.
   Never edit another participant's claim. Declare public-symbol changes in `plans`;
   `room_impact` shows consumers before you change an interface.
3. Answer addressed questions promptly with `room_send(type="answer", inReplyTo=...)`.
   Use exact participant names returned by `room_spawn` or `room_state` in messages,
   reads and previews; do not construct names from owner and tag.
   Ask the peer responsible for a dependency directly; ask the lead, if any, about scope
   decisions or unresolved ownership. Without a lead, agree scope with affected peers. Continue independent work while an answer is pending.
   When blocked, use `room_wait(questionId)` for that answer or `room_wait(claimId)`
   for the blocking claim (at most 100 seconds per call). A timeout is not an answer
   or approval; permission decisions stay with the human. Offline sends are queued,
   so do not assume delivery. room_wait observes Room dependencies only; use host task
   completion for your own commands, with one room_wait at a time.
4. Inbox interrupts require replanning; notifications need a relevance check. A real
   merge conflict arrives as an addressed notification: coordinate before editing the
   conflicting region. Routine activity stays in the feed. No explicit release or
   changed message is needed: Room detects changed definitions, and `room_done` releases claims.
5. Start independent work while interfaces are being agreed; implement
   each part when its required interfaces are agreed. Test against peers' live work without
   waiting for an integrated checkout. When affected interfaces need combined validation, use
   `room_preview_merge(people=["<returned peer name>"], run="<focused test command>")`,
   naming relevant peers, including finished ones. Name tests or a single file rather
   than whole suites so a preview `run` finishes well under the 5-minute limit. Narrow
   a command stopped at the time limit; do not repeat it on unchanged inputs. Room refuses
   an identical timed-out command on the same inputs unless `allowSlow: true` is passed;
   the limit still applies. Changed files are a new check.
   Choose task-appropriate evidence: focused
   checks for changed behavior, source review or document checks where applicable. Whoever
   integrates owns comprehensive relevant validation of the integrated result, including
   the CI checks the change requires.
   Agree who runs a shared check and share its inputs, command and result. Peers may
   reuse it only under the identical-input, command and environment rule below.
   Never copy peer files into your overlay to test: that duplicates ownership and can
   trigger conflict notices. Send findings and questions directly to the owning peer
   with `room_send(type="note"/"question", to=...)`. For a finished registered worker, ask
   its lead to resume it when an answer is needed; independent peers manage their own sessions. If adjacent edits need a shared line, preserve their version exactly;
   `resolve=true` can return a superset resolution for inspection.
   A default preview selects overlapping present peers and your own running workers.
   A reply naming skipped non-overlapping present peers means they are here: name the
   dependencies explicitly in `people`; include finished peers by name too.
   `SNAPSHOT result` reports the inputs and command result when peers move during a run.
   A pass is interim evidence for those revisions; it does not certify the latest combined
   code or rerun automatically. Reuse a complete passing preview only for identical preview
   inputs, command and relevant environment. Its input hash does not establish equivalence
   with the integrated tree. Validate the integrated tree unless exact equivalence is
   independently established. Partial, timed-out or output-limited runs do not validate
   the whole tree. Rerun for relevant
   changes, failures or uncertain inputs; before `room_done`, verify the evidence is current.
   Do not skip checks solely because reported changed paths do not overlap.
6. When your human asks you to push, push your current branch; Room tells teammates on that branch to catch up. Run git pull --ff-only --autostash to catch up on a shared branch. If it refuses, or your push is rejected, stop and tell your human; never merge another branch into this one, and do not undo, rebase or recommit your commits to get past it without their yes.
7. A brief is a slice of the task, not its edge: when a rule you own reaches code your brief
   does not name, handle it or ask the lead who owns it before finishing, and list what you
   found in your summary. Before finishing, get a current preview of relevant peers, including affected dependencies;
   do not wait for them to finish. Resolve conflicts and run relevant tests, then call
   `room_done(summary)` with one line. Report the result and any unresolved blocker.
   Never commit or push unless asked; do not ask as a finishing ritual. Workers report
   progress in `room_done` and dependency findings to the owning peer; send a lead note
   only when it must know before they finish;
   routine progress notes from your own workers do not wake you, but addressed questions,
   worker completion (`room_done`), and eligible interrupts can. Codex leads on the shared
   app-server can receive coalesced pointers for addressed questions, eligible interrupts
   and addressed completion from their own registered workers mid-turn as tool output.
   Delivery does not interrupt a running tool; idle `codex queue` remains a fallback.
   A wake is not proof that content was read or acted on; host settings can block delivery.
   Continue independent work pending results. Interactive leads with an available wake
   path need not poll; headless leads must stay alive until supervision is complete.
   When blocked or ready for results, use short `room_wait` calls, including when wakes
   are unavailable or disabled.
   For missing wakes, inspect `room_state(check=true)` and `room-mcp.log` before
   concluding that Room cannot wake the host.
   On Claude Code with documented background-command lifetime and completion delivery
   (verified on 2.1.300), use host-managed background execution for long commands when
   responsiveness matters; await native completion and inspect the actual result
   before room_done. Its headless main conversation can stay alive for that command after
   an interim result, including with stdin closed. This does not protect unmanaged jobs
   from process exit. On unverified hosts, including Codex, keep commands in the foreground
   until background lifetime and completion delivery are verified.
   Current [host limits](https://code.claude.com/docs/en/tools-reference#time-limit-for-background-commands)
   (introduced in 2.1.285): text-prompt `-p` defaults to 10 minutes in the background;
   stream-json/unattended runs default to 30 minutes. An explicit background `timeout`
   can extend this up to 2 hours; `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS`
   can raise the defaults/maximum. Check the installed host's documentation before relying
   on overrides or a longer run. A timeout, interruption or missing result is not a pass.
   After required results are inspected, stop remaining background commands and monitors
   you started before `room_done` and the final message so the host exits cleanly.

Room never changes your files unless you ask it to bring in a worker's output; explicit
exports write the ledger. `room_close` removes the repository room for everyone on every branch
and requires your human's explicit request. `room_leave` ends participation when asked.

Only when the human explicitly asks to delegate through Room, or continues an existing Room worker workflow, load [room-workers](../room-workers/SKILL.md). Generic requests for agents, parallel work or background work use the host’s normal delegation, even while joined to Room.
Dispatch independent work early with short briefs that point at the spec rules each worker
owns rather than paraphrasing them; peers agree the interfaces each task
needs before implementing dependent parts. Claim the functions or line ranges you edit,
ask about overlapping work, and preview combined changes while peers run. Sequence only
same-line edits or work that truly needs a result first; workers may finish at different times.
For registered workers, collection always leaves output uncommitted and unstaged. If asked to commit, use plain git
for one task commit with a normal message. A message from its lead to a finished worker resumes its retained session
until default collection or discard. Defer collection while follow-ups or revisions remain,
or use `room_collect(keep=true)` to apply output and retain the worker for resumption.
When follow-ups are done, use plain `room_collect()` (no tag, no keep) to apply remaining
deltas and finish kept workers under the collection rules. `discard` abandons work;
`reason` belongs to checkpoint holds. `refresh=true` rebases only a stopped worker:
prefer peer previews for live dependencies. Keep bus messages brief and concrete.
