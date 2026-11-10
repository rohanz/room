---
name: room-workers
description: Use only when the user explicitly requests Room workers or Room for delegation, or follows up with, interrupts, collects, or discards an existing Room worker. Generic requests for agents, parallel work or background work use the host’s normal delegation.
---

Use this workflow only for explicit Room delegation or its continuation. Installing or joining Room does not authorize Room workers. Otherwise use the host’s normal delegation.
Rules every participant follows (claims, questions, waiting, previews, evidence, commands,
finishing) are in [room-etiquette](../room-etiquette/SKILL.md); this adds the lead's.

1. Split and brief. Split substantial work by task and dispatch independent investigation
   and implementation early with short briefs. Size slices so none takes more than about twice another's effort;
   split a large set by member across two owners, each told the same rule and their members,
   with one owner responsible for finding and assigning unnamed members. Workers agree the
   names, inputs and outputs they need directly with the relevant peers; only dependent
   implementation waits for that agreement. Parts may share files: give each worker a
   function or area to change, ask it to claim its regions and let Room surface overlap.
   Sequence edits to the same lines or work that truly needs a result first. Workers implement against agreed interfaces concurrently and may finish at different times. For a few lines, do it yourself unless
   the human explicitly requested a Room worker.
   - Shared context once: write what every worker needs (setup, commands, repo rules, the
     spec) to one file before the first spawn, `<lead checkout>/.room/briefs/<batch>.md`, and
     give each brief its absolute path plus only its own slice. `.room/` is Git-ignored and
     never carried or collected, so every worker, with or without `carry=false`, reads the same
     live file and it never reaches a commit. Claude and Codex workers can read it; Codex
     cannot write it, so the lead owns edits and announces them with `room_send`. Not a
     relative repo path: untracked files are copied only when carrying. Room does not check
     absolute paths: get it right. A brief that limits reads to the worktree names this file.
   - Keep each brief self-contained and short by pointing at the source, not paraphrasing it:
     the interfaces it uses, owned area, the spec sections or rules that are its slice,
     expected behavior and appropriate validation. Before spawning, list the spec's observable
     rules (states, fields, counters, events, return values) and put each in exactly one brief.
   - A rule over a set ("every script that re-queues a job", "all callers of X") has one
     owner, or one owner per member set when partitioned: name the members you know and say
     that anything else the rule reaches is theirs to find and report in room_done.
     Never write "if relevant" for a member of a set: assign it or decide it now.
   - Mark a contract decision the spec does not state (throw or return, a payload shape,
     who increments a counter) as "decided, not in spec".
   - Point the test or review worker at the same spec rules, not at an implementer's file
     list, with the whole rule list and the "decided, not in spec" items to check against the
     spec's caller-visible text, so it finds what the briefs missed.
   Supervise directly or through a background lead, as the user prefers; ask only when a
   decision is needed. A background lead is one worker whose brief has the task, how to
   split it, validation, and "collect your workers before room_done"; steer it with
   `room_send` and collect it like any worker.
2. Spawn. Call `room_spawn(tag, task, host?, model?)`. Host defaults to your own; override
   it, or pass a model, only when requested. Copy exact participant names from `room_spawn`
   replies or `room_state`; pre-spawn briefs say to use the names the lead sends after spawn,
   and the lead sends those returned names. Codex workers use the installed Room plugin:
   install the lead's Room version for Codex or use host claude. Each worker gets its own `PORT`.
   - Workers start with your eligible uncommitted work (`carry=false`: from HEAD). Tracked
     changes ride a carry commit on the worker branch (`git push --all` can publish it);
     untracked non-ignored files are copied, never committed; the reply names skipped files.
     Carried edits are the lead's: workers edit around them and ask before changing them.
   - `node_modules` links to your install (workspace packages to the worker's sources). If
     the reply warns that cross-package tests would run your code, trust a preview `run`
     over the worker's own result; with no `node_modules`, `.bin` scripts fail there.
   - Pass the spawn reply's thread budget to explicit parameters such as `n_jobs`,
     `num_threads` and `num_workers` (Room caps math-library threads); stagger heavy jobs.
   Respect `ROOM_MAX_WORKERS`. Do not join a team room just to dispatch workers;
   `where="local"` keeps workers local (a team-room lead still mirrors their claims there).
3. Supervise. Briefly state what you dispatched. While workers run, keep handling new input
   from your human or host as you would alone; wait only on a specific dependency (an
   answer, the worker whose result you need next) and continue independent work otherwise.
   - Progress notes from your own workers do not wake you; addressed questions, completion
     (room_done) and eligible interrupts can. Codex leads on the shared app-server get pointers
     for those, and completion from their own registered workers mid-turn as tool output.
     A wake is not proof that content was read or acted on. An interactive lead with a wake
     path does not poll (room-etiquette, Waiting).
   - A headless lead (`claude -p`, `codex exec`) must stay alive until supervision is
     complete: it must not end its turn with background commands, rescue jobs or host agents
     pending, and uses short room_wait calls (at most 100 seconds) when blocked or ready for
     results, as must any lead whose wakes are unavailable. A process-exit watcher cannot substitute for questions.
   - Answer worker questions with `room_send(type="answer", inReplyTo=...)`; ask your human
     only for a blocking decision.
   - Follow-ups: `room_send(to=...)`. A message from its lead to a finished worker resumes its
     retained session in its worktree; other workers send it findings but ask its lead to
     resume it. Add `refresh=true` when it needs a commit you made after spawning it: Room
     rebases a stopped worker's branch onto your HEAD first (a conflict changes nothing) and
     lists the commits that came in. Prefer named peer previews for live dependencies; do not
     stop workers just to refresh them. To redirect a worker mid-edit, send the new task with
     `priority="interrupt"`; discard only when the human wants its work thrown away.
   - Rebalancing: if one worker finishes while another's slice is far from done, ask the running worker what members remain and
     hand some to the finished worker. Agree the handoff and release old claims before the new owner edits.
   - Restarting or reconnecting the lead's Room MCP stops its running workers; worktrees and
     sessions remain, and the next reply carries a notice with resume commands. Room never
     resumes them: for workers stopped because the previous session ended, ask the human
     whether to restart or discard them; do not silently redo their work.
4. Review checkpoint. Only if the human explicitly requests one, before dispatch or
   collection call `room_review(action="hold", reason="<requested review>")` from the
   destination checkout and wait for success. A reviewer whose approval is required owns
   the hold from that checkout, not its worktree, and keeps the private `reviewToken` from
   the collecting lead. Messages do not establish holds; work continues while held. After
   review the creating session (or a replacement with `reviewToken`) calls
   `room_review(action="release")`, which does not collect; `action="status"` checks it;
   every reviewer must release. A hold blocks new collection for that destination only, not
   a running collection, lifecycle recovery or explicit leave/ancestor discard.
5. Preview. While workers run, preview combined work by returned names, including finished
   workers (rules in room-etiquette). Include the lead when workers start from different
   kept or carried snapshots: Room anchors on it and applies worker deltas in collection
   order; a stale lead publication shows as a gap, retried by an addressed message without
   refresh. Clean text merges still need behavioral tests. Resolve conflicts and failing
   tests before collection. Start the final full check as a preview while the last workers finish,
   if it can complete within the preview limit. A command that cannot finish within five
   minutes must run on the collected tree; `allowSlow` only permits retrying timed-out inputs.
6. Collect. Keep finished workers resumable until follow-ups and requirement revisions are
   done: defer collection, or `room_collect(keep=true)` applies finished output while keeping
   the worktree, branch, logs and session. `keep` is apply-only, incompatible with copy or
   discard; later collection applies only changes since the last. Kept output counts as the lead's: before `refresh=true`, commit the output of all kept
   rounds and any work carried in at spawn, or Room refuses (docs/reference.md); send
   without refresh to resume on the worker's existing copy. Finish kept workers with plain `room_collect()` (no tag, no keep).
   - Default collection ends resumption and brings every finished worker's changes into your
     working tree, uncommitted and unstaged. Conflicts write nothing: resolve them or collect
     one tag at a time. Running and failed workers are skipped.
   - A collected worktree is removed once its process is gone; until then `room_state` says
     why and a later collect or the sweep finishes. Build output (`dist/`, `*.tsbuildinfo`,
     the rest in docs/reference.md) and Python environments do not keep it; unexpected files
     do. Scratch (`*.log`, `*.tmp`) is saved to `.room/scratch/<tag>/`, not collected. Bring
     named artifacts and files over 5 MB with `room_collect(tag, mode="copy", paths=[...])`.
   - "Throw away the worker" means `room_collect(tag, discard=true)`: it stops the worker
     and removes its worktree, branch and logs, keeping a recovery patch for a week. `discard`
     abandons work; `reason` belongs to `room_review(action="hold")`. Collect, discard and
     stop also stop processes running inside an owned worktree.
   - A `dir=` retry in a failed worker's checkout previews and collects normally and detaches
     without touching the owner; discard the owner after the retry and its other users finish.
7. Validate and finish. Whoever integrates owns full relevant validation, including the CI checks the change requires.
   Reuse a complete passing preview only for identical preview inputs, command and relevant environment.
   Validate the collected tree unless collect reports it identical to the most recent preview of this checkout, which passed the same command you would run.
   The report covers files and command only: Git state (HEAD, refs, index), environment and ignored files are not compared.
   Rerun commands that read Git state on the collected tree, even when HEAD is unchanged.
   Files written by another process during collect are outside the guarantee; stop concurrent writers.
   Rerun when installed dependencies, ignored build output or services the command depends on differ.
   Partial, timed-out or output-limited runs do not validate the whole tree. Where background commands are verified, start the integrated test run in the background and review diffs or write the summary
   meanwhile. Await completion and inspect the actual result before reporting it.
   Stop remaining background commands and monitors you started before the final message.
   Workers are plain `codex exec` / `claude -p` processes (ROOM_WORKER_ID): stop your jobs
   by pid, never by a pattern such as `pkill -f codex`. Report the work and evidence.
   Never commit or push unless the human asked. If asked to commit, use plain git for one
   task commit with a normal message; worker details do not belong in the history.

For a missing wake or worker problem, see `room_state(check=true)` and `<git common dir>/room-mcp.log`.
