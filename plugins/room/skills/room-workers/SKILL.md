---
name: room-workers
description: Use only when the user explicitly requests Room workers or Room for delegation, or follows up with, interrupts, collects, or discards an existing Room worker. Generic requests for agents, parallel work or background work use the host’s normal delegation.
---

Use this workflow only for explicit Room delegation or its continuation. Installing or joining Room does not authorize Room workers. Otherwise use the host’s normal delegation.

1. Split substantial work by task and dispatch independent investigation and implementation
   early with short briefs. Size slices so none takes more than about twice another's
   effort; split a large set by member across two owners, each told the same rule and
   their members, with one owner responsible for finding and assigning unnamed members.
   Workers agree the names, inputs and outputs they need directly with the relevant peers;
   only dependent implementation waits for that agreement, not the whole task or team.
   Parts may share files: give each worker a function or area to change and let Room
   surface overlap. Sequence edits to the same lines or work that truly needs a result first.
   Interface dependencies still take time: workers can implement against the agreed
   interfaces concurrently and test a combined preview, without waiting for your integrated
   tree. They may finish at different times.
   For a few lines, do it yourself unless the human explicitly requested a Room worker.
   Choose direct supervision or a background lead to fit the user's preference and the task.
   Offer that choice only when a decision is needed; existing authorization is enough to proceed.
   If using a background lead, spawn one worker with a self-contained lead brief: the task, how to
   split it into tasks with functions or areas to change, appropriate validation, and "collect your workers
   before room_done". That lead spawns workers, answers their questions, waits on specific
   dependencies when blocked, continues independent work, previews and tests, collects
   their changes, then calls room_done.
   Steer it with room_send to the exact participant name returned by Room; collect it at the end like
   any worker.
   Keep each self-contained brief short by pointing at the source, not by paraphrasing it:
   the interfaces it uses, owned area, the spec sections or rules that are its slice,
   expected behavior and appropriate validation. Before spawning:
   - List the spec's observable rules (states, fields, counters, events, return values)
     and put each in exactly one brief.
   - A rule over a set ("every script that re-queues a job", "all callers of X") has one
     owner, or one owner per member set when partitioned: name the members you know and
     say that anything else the rule reaches is theirs to find and report in room_done.
     Never write "if relevant" for a member of a set: assign it or decide it now.
   - Mark a contract decision the spec does not state (throw or return, a payload shape,
     who increments a counter) as "decided, not in spec".
   - Point the test or review worker at the same spec rules, not at an implementer's file
     list, with the whole rule list and the "decided, not in spec" items to check against
     the spec's caller-visible text, so it finds what the briefs missed.
   What
   Room does between them: shows who is near which file, warns before two edits collide,
   and when a worker changes a function's signature or removes a definition, tells the
   workers whose files use it (detected from the diff, no message needed). Workers
   claim the functions or line ranges they edit, ask each other questions, and check
   their combined changes in a preview before collection. Workers send findings or
   interface questions directly to the owning peer with `room_send(type="question"/"note", to=...)`.
   Never copy peer files into a worker's overlay to test: this creates duplicate ownership
   and can trigger conflict notices. Use the preview scratch tree instead.
2. Call `room_spawn(tag, task, host?, model?)`. Host defaults to your own host; override
   only when requested. Give each worker a self-contained task, functions or areas to
   change, the spec rules it owns, and appropriate validation. Shared files are fine; ask workers to claim their regions.
   Copy exact participant names from `room_spawn` replies or `room_state` for briefs,
   messages, reads and previews; never derive them from owner and tag. Pre-spawn briefs
   say to use the names the lead sends after spawn, and the lead sends those returned names.
   Workers choose focused checks for their changes; verify affected interfaces with peers in a combined preview when needed. Follow [room-etiquette](../room-etiquette/SKILL.md) for command lifecycle. On Claude Code with documented background-command lifetime and completion delivery (verified on 2.1.300), use host-managed background commands when responsiveness matters, and await the actual result before room_done. On unverified hosts, including Codex, keep commands in the foreground until their background lifetime and completion delivery are verified.
   The worker's `node_modules` links to your install (followed when it is itself a link), with workspace packages pointing at its own sources; if the spawn reply warns that its cross-package tests would run your code, trust a preview with `run` over the worker's own test result, and if it warns that the worktree has no `node_modules`, its `./node_modules/.bin/...` scripts fail there.
   Pass a model only when specified.
   If asked to follow up with a worker, use `room_send(to=...)`; a message from its lead to a finished worker resumes its retained session in its worktree. Other workers can send findings to it but ask its lead to resume it if an answer is needed. When it needs a commit you made after spawning it, add `refresh=true`: Room rebases its branch onto your HEAD first (a stopped worker only; a conflict changes nothing) and tells it which commits came in. Prefer named peer previews for live dependencies; do not stop workers just to refresh them onto your integrated tree. To stop the current edit and redirect that same worker, send the new task with `priority="interrupt"`; discard only when the human wants its work thrown away. Codex workers use the installed Room plugin, so install the lead's Room version for Codex or use host claude.
   The worker starts with eligible uncommitted work, or pass `carry=false` to start from HEAD. Tracked changes use a carry commit on the worker branch (`git push --all` can publish them); non-ignored untracked files are copied, never committed to a branch, with a private ref for merge and recovery. Files over 5 MB or beyond 50 MB total, nested repositories, escaping symlinks and linked inputs are skipped and named in the spawn reply. Carried edits are the lead's work in progress, already in the worker's worktree to build on. Edit around and after them freely; ask the lead before changing or removing the lead's own lines. Each worker gets its own `PORT` for dev servers.
3. Briefly state what you dispatched. Workers report progress in `room_done` and send
   dependency findings to the owning peer; a lead note is for information it needs before
   they finish. Routine progress notes from
   your own workers do not wake you; addressed questions, worker completion (room_done),
   and eligible interrupts can. Claude Code uses its inbox (2.1.224+ on macOS/Linux,
   2.1.234+ on Windows, or channels fallback); Codex leads on the shared app-server can
   receive coalesced pointers for addressed questions, eligible interrupts and addressed
   completion from their own registered workers mid-turn as tool output. Delivery does
   not interrupt a running tool; idle `codex queue` remains a fallback. A wake is not
   proof that content was read or acted on. Host settings can still block delivery.
   An interactive lead with an available wake path does not poll: with nothing else to
   do, end the turn; the wake brings the next worker result or question. room_wait
   observes Room dependencies only: call it for a specific dependency (a questionId or
   claimId), one room_wait at a time, and use host task completion for your own commands,
   including one the host moved to the background.
   The exception is a headless lead, which has no turn to return to: it must stay alive
   until supervision is complete, continuing independent work pending results and using
   short room_wait calls (at most 100 seconds) when blocked or ready for results, as
   must any lead whose wakes are unavailable or disabled;
   messages also arrive on other Room tool replies and eligible before-edit hooks.
   If an expected wake is missing, inspect room_state(check=true) and room-mcp.log;
   do not infer that Room cannot wake sessions from the progress-note rule. Answer
   questions with room_send(type="answer", inReplyTo=...); ask your human only for a
   blocking decision. Ask the owning peer directly about dependencies and the lead for
   scope or unresolved ownership. A timeout is not an answer or approval; permission
   decisions stay with the human. A process-exit watcher cannot substitute for questions.
   While workers run, keep handling new input from your human or host as you would alone.
   Wait only on a specific dependency (an answer, the worker whose result you need next);
   otherwise continue independent work. If one worker finishes while another's slice is
   far from done, ask the running worker what members remain and hand some to the
   finished worker. Agree the handoff and release old claims before the new owner edits;
   a message from the lead resumes a finished worker.
4. If the human explicitly requests a review checkpoint before collection, establish it
   before dispatch or collection: from the destination checkout call
   `room_collect(checkpoint="hold", reason="<requested review>")` and wait for success.
   A separate reviewer/controller should own the hold when its approval is required;
   it must use that same checkout, not its own worker worktree. Keep the returned private
   `reviewToken` for recovery; do not send it to the collecting lead. Messages alone do
   not establish holds. Preview, tests and worker follow-ups can continue while held.
   After review, the creating session calls `room_collect(checkpoint="release")`;
   a replacement reviewer can use `reviewToken` to release it. Release does not collect.
   Check with `room_collect(checkpoint="status")`; all reviewers must release their holds.
   Do not establish a hold when no checkpoint was requested. This blocks new collection
   calls for that destination only; it does not cancel an already-running collection,
   freeze lifecycle recovery, or protect against explicit leave/ancestor discard.
   As lead, preview combined work while workers run, using returned participant names,
   including finished workers: `room_preview_merge(people=["<returned peer name>"], run="<focused test command>")`.
   Choose task-appropriate evidence: focused tests for changed behavior, source review or
   document checks where applicable. Interim checks cover affected peer interfaces; the
   integrator owns full relevant validation after collection, including the CI checks the change requires. A preview `run` stops at 5 minutes or 4 MB of output and reports that it did
   not finish, with its last output; name tests or a single file so interim commands finish
   well under the limit. Keep a preview `run` under two minutes: an interactive Claude Code
   session moves a longer tool call to a background task (verified 2026-10-21; a headless
   `claude -p` session does not), and the full suite belongs to the integrated tree after
   collection, not to a preview. Narrow a timed-out command; do not repeat it on unchanged inputs.
   Include the lead when workers start from different kept or carried snapshots. Room
   anchors that preview on the lead and applies worker deltas in collection order.
   A stale or incomplete lead publication produces a gap; an addressed message to the
   worker without refresh retries publication. Clean text merges still need behavioral tests.
   Workers use focused combined previews with named peers when needed to test interfaces
   and send failures to the owner. Resolve conflicts or failing tests before collection.
   Bare previews select overlapping present peers and your own running workers. The reply
   names skipped non-overlapping present peers: include relevant dependencies explicitly
   in `people`, including finished peers. `SNAPSHOT result` lists the tested inputs,
   command result and peers that moved during the run. A pass is interim evidence for
   those revisions; it does not certify the latest combined code or rerun automatically.
   Reuse a complete passing preview only for identical preview inputs, command and relevant
   environment. Its input hash does not establish equivalence with the collected tree.
   Validate the collected tree unless exact equivalence is independently established.
   Partial, timed-out or output-limited runs do not validate the whole tree. Rerun for relevant changes, failures or uncertain inputs;
   before `room_done`, verify the evidence is current.
   Reported paths inform investigation; do not skip checks solely because changed paths do not overlap.
5. Keep finished workers resumable until follow-ups and requirement revisions are done:
   defer collection, or use `room_collect(keep=true)` to apply finished output while
   retaining the worktree, branch, logs and session. `keep` is apply-only, incompatible
   with copy or discard; later collection applies only changes since the last collection.
   After keep, preview and collection use a private snapshot of the delivered worker tree as its base; delivered edits count as the lead's. Commit the collected output from all kept rounds and any uncommitted work carried into the worker at spawn before refreshing it. Room rebases only when Git proves the cumulative snapshot changes since a unique shared ancestor are contained in the lead's HEAD, then moves the base to that HEAD. If the worker already has that HEAD, refresh resumes it without rebasing or changing its kept snapshot or collection refs, even when collected output is still uncommitted. Otherwise snapshot changes absent from your HEAD, overlapping committed revisions or an unprovable shared ancestor refuse refresh. Committing a revision or removal of snapshot content does not establish containment; later kept rounds may still refuse refresh. Send without refresh to resume with the worker's existing copy intact. Committing only the latest round or only some hunks does not prove containment of earlier kept output or carried work.
   When follow-ups are done, finish kept workers with plain `room_collect()` (no tag,
   no keep): it applies remaining deltas, reports "already present" otherwise, and cleans
   up under the rules below. `discard` abandons work; `reason` belongs to checkpoint holds.
   Default collection ends resumption and brings every finished worker's changes into
   your working tree, uncommitted and unstaged. Conflicts write nothing: resolve them or
   collect one tag at a time. Running and failed workers are skipped. Fully collected workers
   are cleaned up after a clean exit. Regenerable build output (`dist/`, `build/`, `out/`, `.astro/`, `.next/`, `.nuxt/`, `.svelte-kit/`, `.turbo/`, `.cache/`, `coverage/`, `test-results/`, `playwright-report/`, `node_modules/`, `vendor/`, `__pycache__/`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `.gradle/`, `target/`, `*.tsbuildinfo`) does not keep a collected worktree. Recognized Python environments (`.venv/`, `venv/`, with valid `pyvenv.cfg`, interpreter and standard layout) are also disposable, including installed packages and other contents inside their standard directories. Unexpected top-level files, wrong entry types or linked environment roots keep the worktree for inspection. Worker scratch (untracked `*.log`, `*.tmp`, temp and swap files) is not collected; a copy is saved under `.room/scratch/<tag>/`. For named artifacts, use `tag, mode="copy", paths=[...]`;
   "Throw away the worker" means `tag, discard=true`: it stops the worker and removes its owned worktree, branch and logs, keeping a recovery patch for a week. A worker started with `dir=` in another worker's checkout detaches without removing it; discard the owner after its other users finish. Collect, discard and stop also stop processes running inside an owned worktree.
6. Run full relevant integration validation, including the CI checks the change requires, on the collected
   tree unless exact equivalence with a complete
   passing preview is independently established; a preview input hash alone cannot
   establish it. After collection, on a host with verified background lifetime and
   completion delivery (see room-etiquette), start the integrated test run in the
   background and review diffs or write the summary while it runs. Otherwise keep it
   in the foreground. Await completion and inspect the actual result before reporting
   validation; a stopped check is not a pass. Stop remaining background commands and
   monitors you started before the final message so the host exits cleanly.
   Report the work and validation evidence.
   Never commit or push unless the human asked. If asked to commit, use plain git for one
   task commit with a normal message; worker details do not belong in the history.

When you find workers stopped because the previous session ended, tell the human and ask whether to restart or discard them; do not silently redo their work.

Respect `ROOM_MAX_WORKERS`. Do not join a team room just to dispatch workers.
`where="local"` keeps workers local; a lead already in a team room still mirrors their
scope and claims there. Otherwise omit `where` to use the current room.

Room writes timestamped MCP events to the shared, 0600 `<git common dir>/room-mcp.log`; it rotates at 1 MB and keeps one older generation.

Room caps math-library threads. Pass the spawn reply's budget to explicit parameters
such as `n_jobs`, `num_threads` and `num_workers`; stagger heavy jobs.
