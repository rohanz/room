# Changelog

## 0.16.6

- Internal cleanup with two deliberate edge-case changes. Repo-relative path checks and symlink containment now have one implementation with named policies (`packages/roomd/src/repo-path.ts`); Git-private state paths and carry records have one resolver (`packages/roomd/src/git-dirs.ts`), parity-tested against the dependency-free hook copy.
- A worktree whose `.git` file has an empty `gitdir:` line keeps hook and exclude state under `<dir>/.git` instead of the checkout root. Worker `link` inputs recheck that the source is still inside the repository before copying.
- File reads and collection refuse a repository root that has changed into a symlink, instead of following it into another directory.

## 0.16.5

- Discard and automatic retirement prune vanished worker worktrees and clear their records, claims and overlays. Discard deletes `room/<tag>` only when its commits are already in the lead's HEAD; otherwise the branch and its unmerged commits remain. Plain collect reports the missing checkout without clearing its record, and Git errors name a missing worktree directory.

## 0.16.4

- Discarding a worker in an existing directory reports the stop and retained directory without an error. Worker model and file counts no longer borrow the lead's metadata or edits; room_state worker counts match listed rows.
- Merge previews expand worker tags to full room names and accept people lists that include the lead. Resume replies say when a finished worker was restarted. Branch switches deliver one reply after joining the new room and mark the old room warning seen; plain room_leave is covered by a regression check that it refuses while workers run.
- Stabilized the skip-log and runtime-presence tests on slower runners: they wait for the logged skip total and call the registered file-watch callback directly instead of relying on polling timing.

## 0.16.3

- Automatic-name and choice locks serialize stale-owner recovery, so concurrent contenders cannot remove a replacement lock held by a live process.
- Worker dev-server ports are reserved per machine across leads and nested workers, reclaimed after owner crashes, and released when workers stop or exit; resumed workers receive a fresh port when needed.

## 0.16.2

- Untagged agents display as "<owner>'s agent" in participants, messages, hooks and the web view; tagged agents keep their names. Message routing names do not change.
- Retiring an old worker no longer removes a later participant's shared work after that participant reuses the name and disconnects. Checkout identity now includes a machine ID, so teammates on different machines with the same path remain visible, along with their scopes, claims and conflict alarms.
- Worker stop, leave, shutdown and collection clean up all processes in a worktree only after verifying Room owns it. Workers started in an existing directory are stopped through a verified process handle or PID. A failed or timed-out process listing is reported without preventing an owned worker from stopping.
- Cancelling `room_wait` releases its listeners, timers and wake suppression immediately; an answer that arrives later remains unread for normal delivery.
- Collection again treats Python check caches and other reproducible dependency directories as regenerable; virtual environments remain retained. Test fixtures now clean up temporary repositories, deadline timers and a background process.

## 0.16.1

- Room advances its base only from pushed commits on the room's branch and warns an agent that switches branches; a detached HEAD (mid-rebase) neither moves the base nor warns. Base notices and join guidance show `git pull --ff-only --autostash` for catching up with uncommitted edits and tell the agent to stop if it cannot fast-forward.
- Agent instructions now make pushing finished work to the shared room branch the normal flow when the human asks to push. Join disclosures use plain phrases people can say to share plans only or limit shared file text.
- Exported room history has a history heading instead of PR comment text, and the first agent's name appears the same way in the timeline and participant list.
- Merge previews describe trivial results relative to a worker's carried base. Collected workers no longer keep worktrees for `*.tsbuildinfo` output, and resumed Codex workers are recognized by their host session ID.
- Human messages using the same name as an agent now reach that agent's inbox and wake paths. A regression check covers answers between workers.

## 0.16.0

- Worker progress notes stay queued without waking their own lead; questions, finishes, failures, interrupts and human messages still wake. `room_wait` is capped at 100 seconds to avoid Claude Code 2.1.212's automatic backgrounding threshold of 120 seconds. Answers crossing a wait are retained, `inReplyTo` addresses the asker automatically, worker questions surface first with reply instructions, and `room_send` accepts `message` as an alias for `text`.
- Worker collection ignores regenerable build output. Parallel collects queue with the tag they follow; collect-all skips bad records with reasons, worktree reuse checks the Git common directory, and failed cleanup retains the worktree. `carry: false` starts a worker from HEAD, and spawn warns when its brief names a path absent from the worktree. Recovery patches use the local date. An early tar exit no longer stalls `materializeGitTree` until its timeout.
- Collect, discard, stop and leave terminate processes running inside a worker worktree and name them, before the worker host is signalled so a server that would die with it is still named. Workers receive distinct `PORT` values in their environment, brief and spawn reply.
- A cancelled MCP call drops queued work, including a cancelled spawn. Room detects an updated bundle on disk once per session and asks the user to restart. Sessions in the same checkout appear as another session, without duplicate nearby work, and a session that is not its checkout's publisher reads its own files from disk; concurrent automatic names are reserved atomically, and a named local room is rejoined after restart.
- Collected, discarded and dead workers lose stale claims and overlays and leave active participant counts; merge preview can read the lead's own intent-only worker from its local worktree.
- Skipped file logs are counted once per scan, and ignored build and test output is not watched unless it contains tracked files. The symbol graph reindexes only edited paths, reducing idle CPU on busy repositories.
- `room_preview_merge` without a test command and `room_collect` skip files changed only by the lead; on a 13.7 GB repo, collection fell from 49 seconds to 0.4 seconds and preview from a 5.5 GB memory failure to 0.26 seconds.

## 0.15.2

- The MCP handshake now reads the plugin release version; both plugin manifests and marketplace metadata are 0.15.2. Private workspace package versions remain separate.
- Claude wake guidance now says the first socket wake is immediate, with at most one follow-up wake for events in the next five seconds, and names the 2.1.234 minimum on native Windows. The graph index no longer advertises unused peer-presence selection; its tests retain local-build and import-update regressions.
- Removed unused configuration, identity and message-predicate helpers. The large-carry regression now checks tracked and untracked bytes in the worker worktree as well as the no-stdin rule. Deferred cleanup tasks are recorded in the roadmap.
- Resumed workers keep their spawn-time sharing level. Workers recorded before 0.15.2 resume at `intent`, with that choice stated in the reply. Resume clears the saved stop reason on disk, counts live and in-flight starts against `ROOM_MAX_WORKERS`, and logs exit errors like a fresh spawn.
- Carry and discard now generate recovery patches with one policy: no colour or external diff/textconv, and fixed `a/` and `b/` prefixes. Discard verifies its patch against a fresh checkout before removing anything and keeps the worktree if verification fails. Synchronous Git calls in carry and recovery use `ROOM_GIT_TIMEOUT_MS` (30 seconds by default); a timed-out carry starts the worker from HEAD as before. If late cleanup fails after removal, the error says the base was reconstructed and identifies where the actual edits remain.
- Stopped-worker file counts and retirement now measure the worker's own changes from its recorded base. `link: []` fully disables `.roomlinks`. An unreadable baseline reports degraded contract coverage instead of treating the old file as empty; the carried-path cache is bounded and retries failed reads. Machine-read Git path lists use NUL framing so tabs and newlines in filenames survive. Merge previews identify the algorithm used and any fallback reason.
- Abandoned sharing-notice locks are recovered using their owner PID and a 10-second stale limit; lock contention no longer counts as delivery. Stopping the hook bridge cancels in-flight wakes. Claude sessions no longer scan Codex rollouts, and Codex fallback discovery is capped and cached. Relay takeover, daemon observer and archive-pipe failures are reported instead of crashing the MCP process.
- Scope, claim and proximity checks now share path normalization. A declared `.` scope covers the whole repository: under `share=declared`, it shares all changed files (before 0.15.2 it shared none). Empty and absolute scope paths cover nothing.

## 0.15.1

- `room_preview_merge` with `run` no longer mangles characters above U+00FF in live, uncommitted edits: an em dash (U+2014) became the control character U+0014, so a test could fail in the preview and pass on the real tree. Live text now enters the merge as UTF-8 bytes. A test covers previews and `room_collect` with an em dash, a CJK character and an emoji.
- A session blocked in `room_wait` no longer also gets a socket wake for the event the wait returns (sent at once since 0.14.1). Events that do not end the wait still wake, and a sent wake still marks nothing seen.
- The plugin eval mock tool list was already current. `npm run eval:mocks` now regenerates it from Room's `DEFS`, and a test checks tool names, descriptions, annotations and input schemas against the source definitions.

## 0.15.0

- Finished workers can receive `room_send` follow-ups in their retained worktree and Claude Code or Codex session; collection and discard end that option. Claude workers use documented effort, name, session and budget flags; `ROOM_WORKER_MAX_BUDGET_USD` sets the budget cap, and channel loading is opt-in with `ROOM_WAKE=channels` (Claude Code 2.1.281 CLI and session docs; Codex CLI 0.155.1 `exec resume --help`).
- Room uses host-provided Claude session, model and effort data and Codex hook thread IDs. Claude session attribution checks the parent command before using `CLAUDE_CODE_SESSION_ID` (exposed to MCP servers in Claude Code 2.1.154); bounded transcript and Codex rollout scans remain fallbacks when hook data is missing or stale. The before-edit hook records receipts while a session is alone so hook coverage is accurate.
- Claude wakes summarize only unread events and batch arrivals after follow-up wakes; `room_wait` labels addressed notes without asking for an answer. `room_create` and `room_close` request per-call host confirmation (Claude Code 2.1.199+), and the MCP SDK stays on 1.x to preserve the channel fallback.
- A `claude plugin eval` suite in `evals/` (Claude Code 2.1.269+) replaces the manual routing phrasing check. Six routing and three solo cases use mocks from Room's real `tools/list`; in validation every plugin case scored 1.00, routing cases without Room scored 0.00–0.67, and solo cases made no Room calls in either run.
- Claude's before-edit hook matcher includes `PowerShell`, and the hook records repo-relative write intents from its commands, including case-insensitive aliases and quoted Windows paths (PowerShell tool: Claude Code 2.1.84). Claude Code 2.1.281 ran the changed plugin hook without reapproval, while Codex 0.155.1 still reads only `hooks.json` and kept its hash trust. Codex 0.155.1 routed all seven tested parallel-worker phrasings to `room_spawn` with native subagents enabled, and Room worker worktrees loaded the repository's `AGENTS.md`.
- Plugin manifests and marketplace metadata are at 0.15.0.

## 0.14.1

- Claude socket wakes now post the first event immediately. Events arriving within the next five seconds produce at most one follow-up wake; a quiet window resets batching for the next immediate wake. Numbered wake texts remain distinct.
- Collecting a worker clears its overlays, claims and scope and retires it from live room state even when ignored output keeps the worktree. The retired record says `kept for ignored output at <path>`; `room_collect(tag, discard=true, force=true)` can still remove that worktree.
- A pending hook-bridge write no longer crashes the MCP server with an uncaught `ENOENT` when the repo directory is removed; the timers in `conflicts.ts`, `bridge.ts`, `graph-index.ts`, `tools/prs.ts` and `wake-path.ts` are guarded the same way, and tests stop their sessions before removing temp dirs.
- Claude sessions are told the before-edit hook may not be running only when their own tree has changed with no hook receipt since session start, and at most once; room-tool-only sessions no longer get the false warning. The Codex up-front note is unchanged.
- Plugin manifests and marketplace metadata are at 0.14.1.

## 0.14.0

- Claude Code 2.1.224+ on macOS and Linux wakes through its cross-session messaging socket with plain `claude`; native Windows needs 2.1.234+. Room detects the bound inbox through `CLAUDE_CODE_MESSAGING_SOCKET`, not a version string. `ROOM_WAKE=socket|channels|off` selects a process path; automatic selection prefers the socket and falls back to an admitted channel if absent or a send fails. `channels` forces channel notifications; `off` disables wakes and gives a specific note. Channels remain an optional fallback for older Claude Code. Codex keeps `codex queue`.
- Room sends a coalesced wake after a five-second quiet window for interrupts and addressed messages: `[room] 2 things need you: rohanz+ship asked a question; rohanz+cat finished. Use the room_state tool to read them (room_collect brings in finished workers). (#3)` The collection hint appears only when a worker finished. It includes up to five short sender and event phrases; beyond five, it shows four plus a count for more, without message bodies. Claude Code frames it as a message from another Claude session with its safety preamble. A successful socket write has no delivery acknowledgment and never marks room messages read. Background chatter does not wake anyone.
- Claude Code's inbound `hold` setting holds the wake; `refuse` drops it. The room message remains for the next turn.
- Live end-to-end checks passed on Claude Code 2.1.281 (macOS) with plain `claude` and no channel flag: an idle session woke 5.0 seconds after a worker finished, including a real `room_spawn` worker; five completions within one second produced one wake. A busy session absorbed the wake into its running turn, and the hook inbox showed the question at the next tool call. `crossSessionInbound: refuse` prevented the wake while leaving the message in the room for the next turn. Forced `channels` woke a flagged session without a socket post; `ROOM_WAKE=off` sent nothing.
- The README, onboarding, join skill and trial checklist now start Claude Code with plain `claude`; the friend checklist asks for Claude Code 2.1.224+ instead of a shell alias. Plugin manifests and marketplace metadata are at 0.14.0.

## 0.13.0

- The workers skill offers once to hand a batch of three or more workers, or a long batch, to a background lead: “I can hand this to a background lead that stays on it until it's done; you can keep talking to me.” For one or two workers, the session leads itself. A worker that spawns workers is prompted to collect them before its own `room_done`.
- A `room_send` note addressed to someone ends that agent's `room_wait` and wakes it. The sent line names the recipient (`sender → recipient`).
- Nested workers can be cleaned up with their lead-worker: discard first saves a recovery patch for each worker, then removes their worktrees, branches, refs and carry records deepest first. Without force, discard names those workers and refuses. Room's own `.room/` bookkeeping inside a worker worktree no longer counts as an uncopied artifact.
- Workers stopped when their lead's session ends retain that reason across a relay restart. Their partial edits can be taken by `room_collect(tag=<tag>)`, applied or copied, or discarded. A plain `room_collect()` skips them and explains how to recover them.
- The human's session can collect or discard workers orphaned by a dead lead-worker; while the lead-worker lives, its workers remain its responsibility. A dead grand-worker's tag explains how to free it.
- A worker spawning workers splits its advisory compute budget among them instead of passing on the whole budget. `room_state` counts a stopped worker's edits from its worktree instead of showing zero. The browser shows a lead-worker once with its workers nested beneath it.
- The README explains background leads and that Room starts Claude workers with `--dangerously-load-development-channels plugin:room@room` so they can be woken. Team and Enterprise policy may block this flag.

## 0.12.1

- A Claude Code session without instant wake-ups now says so once, to the human, only when it matters: at the first worker spawn, or when joining or checking a room with someone else present. It says everything still works (messages arrive on the next turn), gives the `claude-room` alias line for zsh or bash, and notes that Team and Enterprise accounts need an Owner to enable channels. It stays silent alone in a local room, with wake-ups on, with `ROOM_CLAUDE_CHANNEL=''`, and for Codex. The lead's "block on room_wait in a loop" instruction now appears once, on the first spawn, instead of on every spawn.
- The README, onboarding page, join skill and trial checklist now explain plain `claude`, optional per-session channel opt-in, and the shell alias without a versioned plugin path. Plugin manifests and marketplace metadata are bumped to 0.12.1.

## 0.12.0

- Worker spawn keeps the lead's untracked files outside branch history and ordinary pushes, retaining their contents under a private ref for merge and recovery, records content hashes to attribute carried files, and reports oversized, linked or unsafe paths it skipped. It retries when the lead's snapshot moves, bypasses Git config and hooks for internal snapshots, refuses occupied worktrees, and cleans up failed spawns. Carried counts now count files, and workers are asked to coordinate with the lead before editing carried files. Workers can spawn from detached HEAD with carry intact; the same lead can respawn into a kept worktree without losing its carry record, while other rooms remain excluded.
- Merge previews reject unsafe symlink ancestors, replace final symlinks safely, and run tests on the same content and file modes that collection would write. Automatic retirement keeps workers with ignored output or failed cleanup. Spawn validates input links before carry, cleans new worktrees after startup errors, refuses cross-room tag collisions, and reports carried and skipped file counts. Collection preserves carried untracked ownership and CRLF checkouts.
- Collect, preview and discard now use the same rule for worker changes to carried untracked files; discard recovery preserves a mode-only change such as `chmod +x`.
- Joining now retries transient failures at startup and before Room tool calls, with a bounded deadline and a clear failure step; local-room failures offer an immediate `room_join` retry. Room logs MCP events to a bounded, rotated `<git common dir>/room-mcp.log`. Initial indexing reads changed files rather than every tracked file and batches base reads; unwatcheable clones fail promptly.
- Local relay discovery verifies the clone and key, publishes atomically, and recovers from stale or foreign relays. Team workers publish against their lead's fetchable HEAD rather than a private carried base; teammates get an accurate explanation when a base exists only on the lead's machine.
- After an explicit `room_join` or `room_create`, a lost connection is rejoined on the next Room tool call with the same room, identity and sharing level; `room_leave` and `room_close` remain deliberate exits.
- Worker-side previews and both live conflict watchers compare a worker's own changes with its recorded base, avoiding false conflicts on carried lead lines. Graph observations and contract notices attribute carried signatures to the lead; the browser Merged tab uses each participant's base. Unchanged carried files under `core.autocrlf` are not worker edits. Carried contract checks are debounced and cached, detect a lead's revert to HEAD, cover same-file arrow functions and methods, and preserve import narrowing.

## 0.11.1

- When a worker starts with the lead's uncommitted work, its prompt names the carried files as the lead's and tells the worker not to edit them unless its task says so. The prompt lists up to 20 paths and counts any more; a clean spawn gets no carry warning.
- For a worker with a carried base, contract checks compare the lead's live carried files with the worker's recorded base and inspect the worker's changed or claimed files for uses, including calls in the same file. Signature changes, removals and renames send a deduplicated `contract` notice; body-only changes do not.

## 0.11.0

- A worker in a fresh worktree on a new branch starts with the lead's tracked changes, including staged changes and deletions, and non-ignored untracked files as one carried-in commit. Ignored files and `.room/` stay out. The first successful carry per lead session says `carried your N uncommitted changes into its worktree (commit <sha10>)`; a clean lead gets no carry commit or note.
- A carry copy, apply or commit failure resets the new worker to clean HEAD and every failed spawn reports that its uncommitted changes are absent; if the change count fails, the reply says `could not carry your uncommitted changes`. Existing worktrees and recreated worktrees on a surviving branch keep their prior behavior.
- `room_collect` and `room_preview_merge` compare each worker with its own recorded base, including a carried-in commit, so the lead's later edits to carried lines survive and untouched carried files are neither reapplied nor reported as worker changes. File-mode changes use that base too. A preview names the worker's base when it differs from the common ancestor.
- If a recorded worker base is unavailable or does not descend from the common ancestor, or an older worker has no base, previews and collection use the common ancestor. Adjacent-line edits can still conflict.
- A worker's worktree, now ahead of the room base by its carried commit, is no longer told to `git push` or `git pull`.
- `room_collect` no longer fails with `spawn git ENOENT` when it runs while a finished worker with no changes is being retired: collect, discard and retirement take turns on each worker.

## 0.10.2

- `room_collect` keeps a worker's worktree when it holds ignored output that was not copied: ordinary changes are applied, each kept artifact and its location is named, and only `room_collect(tag, discard=true, force=true)` deletes them.
- Merge previews detect common runner failure summaries even behind zero-exit pipelines and use one verdict for replies, completion status and ledger notes.
- Preview commands strip inherited `ROOM_*` control variables, retaining only `ROOM_MERGED_TREE`.
- Member identity checks are observe-only by default so objected Yjs updates and their causal successors still apply; experimental `ROOM_IDENTITY_GUARD=enforce` remains available, and concurrent color repair updates only the caller's slot.
- Directory claims that cover another participant's scoped or claimed files are refused, and agents are told to claim exact files.
- Each session builds its dependency graph locally instead of reusing lossy snapshots that could invent edges.
- Unique bare worker tags are resolved before sending; ambiguous or unknown recipients are rejected without posting.
- Team join and first scope warn once until a real same-session pre-edit hook receipt confirms coordination.
- Codex base-move wakes handle Git's actual result and continue without offering to commit or push.
- Missing-hook recovery guidance is tailored to the detected Codex or Claude Code host.

## 0.10.1

- Finding 1: automatic branch following preserves the selected sharing level and credentials instead of silently widening file sharing.
- Finding 2: the daemon atomically withdraws overlays and deletion markers when Git or `.roomignore` starts ignoring a path, and rechecks Git eligibility before republishing known paths.
- Finding 3: a lead in a team room can collect a local worker after Room verifies its ownership, repository worktree and worker branch.
- Finding 4: automatic branch following handles slash-containing branch names, remains in follow mode, preserves identity and credentials, leaves the old room connected on failure, and refuses to move while workers run.
- Finding 5: merge previews validate the ancestor commit and stream `git archive` into `tar` through argument-only child processes, so shell metacharacters in clone paths stay literal.
- Finding 6: view links cannot publish awareness; member writes and awareness client IDs are bound to the login or its tagged agents, rejected packets are audited, and the narrow Room-notice and numbered-PR exceptions are not treated as authorship proof.
- Finding 7: graph snapshot reuse reconstructs exact per-edge import facts, preserves narrowed edges, and resumes incremental refreshes for every participant.
- Finding 8: import narrowing resolves paths relative to the consumer and prefers exact or path-specific sources without treating a shared parent directory as a match.
- Finding 9: TypeScript and TSX structural type and interface bodies are retained in contract signatures.
- Finding 10: overload declarations across TypeScript, Java, C#, Swift and Scala are retained by syntax-node offset; contract comparison checks the complete signature set for each qualified name and preserves whitespace inside string literals.
- Finding 11: Rust reference-type trait implementations, generic Go pointer receivers, multi-pointer C functions, and C++ function templates and pointer-returning out-of-line methods are indexed.
- Finding 12: Python decorators are included in a definition's claimed range and contract comparison.
- Finding 13: anonymous JavaScript default exports and re-export barrels contribute definitions, external references and import sources to the graph.
- Finding 14: unnamed Kotlin companion methods are indexed, while expression bodies are excluded from function signatures.
- Finding 15: Ruby singleton-class methods and literal reader, writer and accessor declarations are indexed.
- Finding 16: PHP namespace functions are qualified, and trait uses and aliases are recorded.
- Finding 17: recovered workers use the guarded process identity probe and report an unwitnessed stop as reason unknown, with the worktree and log tail, while only recorded shutdowns say the lead session ended.
- Finding 18: stopping the on-duty runner aborts the active turn, clears queued work, ignores late callbacks and waits at most one second; CLI shutdown awaits it.
- Finding 20: pending sharing and startup notices are delivered once across hooks and tool replies with session-bound lock arbitration, including the first automatic solo team join.
- Finding 21: login recovery preserves and names the requested destination across both login calls, and the join skill carries that destination through.
- Finding 22: bare `room_create` explicitly targets the hosted team server and cannot return local same-room state.
- Finding 23: a clone remembers its chosen sharing level across sessions, and a later explicitly wider boundary is disclosed again.
- Finding 24: discard saves tracked and non-ignored changes in a one-week recovery patch; ignored artifacts outside dependency and cache trees make it refuse, list the artifacts and retain the worktree for explicit copying.
- Finding 25: pre-edit overlap guidance records its evidence, stays silent when the agent already has an adequate claim, and repeats only after that evidence changes.
- Finding 26: `room_done` credits a combined test only when it passed and names the exact preview command, without guessing why a local test failed.
- Finding 27: a non-worker `room_done` reply no longer promises that the finished session can be woken.
- Finding 28: session-start ignores stale or foreign company snapshots unless their session and room identity match and they are fresh.
- Finding 29: declared sharing retains only the paths that were eligible when a task finished, until the sharing level changes or an ignore rule or clean commit withdraws them.
- Finding 30: the on-duty CLI and message script preserve session, token and local-key credentials, fail synchronization within a deadline, and the demo prints authenticated fake sessions for each agent.
- Finding 31: the MCP package guide now lists the 20 shipped tools and current configuration, local-memory, bridge, worker-environment and offline-state behavior, with mutable workflow guidance linked to the main guide.
- Finding 32: participant documentation says the eight-colour palette repeats and names disambiguate people.
- Finding 33: operations and implementation docs now match the checked-in 512 MB deployment and its cold-start comment, distinguish the hosted server from the local relay, and remove the obsolete Python extractor CI comment.

## 0.10.0

- The MCP symbol indexer now uses tree-sitter for Rust, Go, C, C++, Java, Kotlin, C#, Swift,
  Scala, Python, JavaScript, TypeScript, TSX, Ruby and PHP. This replaces the Python 3
  subprocess and the JS/TS regex extractor; the browser keeps its existing regex path.
- Contract changes compare a definition's signature (the text before its body), so body-only
  edits do not warn. Methods are qualified with their container.
- A name defined in more than a handful of files (currently 5, set by a named constant in
  `packages/shared/src/graph.ts`) creates edges only when the consumer imports the defining
  module. The graph remains name-based, has no type resolution, matches method calls by name
  and keeps the 3,000-file cap.
- The plugin carries about 27 MB of prebuilt grammars in `server/grammars/`; only grammars for
  languages present in the repository are loaded.

## 0.9.0

- Last-worker cleanup removes empty `.room/workers` and `.room` directories after collection or discard.
- Workers stopped at lead shutdown retain `stopReason: lead-session-ended`, remain visible with their partial-work location, and produce no death interrupt; the next lead asks whether to restart or discard instead of silently redoing the work.
- Alone joins and same-room rejoins omit browser access links; explicit state links, joins with company and first-spawn links remain available.
- The spawn description keeps its routing words (another agent, in parallel, in the background, codex/claude doing part): a live phrasing test showed trimming them routed “get codex to do half” and “start another agent, don’t wait” to built-in subagents.

- K1. Team joins disclose the actual sharing level, repository and server once per worktree and destination, including first participants and environment-selected auto-joins.
- K2. Unknown sharing levels fall back to plans only and report the invalid setting instead of widening to full text.
- K3. Destination precedence is explicit argument, ROOM_SERVER, legacy ROOM_URL, remembered choice, then local; environment overrides do not become remembered choices. The optional team runner uses an explicit or saved destination instead of silently falling back to localhost.
- K4. Logout is `room_login(action: "logout")`; the separate `room_logout` tool is removed.
- C1. `room_collect()` collects every done worker in finish-time/tag order; optional `tag` selects one. The shared preview engine combines their changes with the lead’s current edits before writing. Any conflict writes nothing and names paths/tags. Changes are always uncommitted and unstaged; running/failed workers are skipped. The commit argument and commit/merge path are removed; requested commits use plain Git afterwards. Named artifact copy and discard remain.
- C2. Full successful collection cleans up an exited worker’s worktree and branch, removes logs after a successful exit, and retires its room record; failed or partial collection preserves recoverable work.
- C3. `room_collect(discard: true)` replaces `room_dismiss`: stop without collecting and remove its worktree, branch and logs, releasing claims and retiring the record; committed and uncommitted changes (including untracked non-ignored files) are saved as one recovery patch for a week, with expired patches pruned on discard.
- C4. Room privately excludes `.room/` and moves root `.room.json` into the worktree’s Git directory as `room.json`, migrating the legacy file once.
- C5. Workers default to the caller’s host, receive setup guidance once per session, and finish with one line through `room_done`; finished workers are no longer told to stay for questions.
- L1. The always-loaded prompt applies coordination rules only with company, describes disk writes truthfully, and reserves worker dispatch for substantial work.
- L2. Claims are needed only where work overlaps; `room_claim` records nothing when no claim is needed. Routine release and changed announcements are no longer required.
- L3. Routine waiting, browser-link and renewed commit-permission relays are removed; the sharing disclosure remains mandatory.
- L4. Replies avoid repeating wait-ending messages and routine guidance; waiting no longer mandates a second state call.
- L5. State starts with the sharing boundary and returns browser links only with `link: true`; `room_state(path)` replaces `room_who`, and `room_read(diff: true)` replaces `room_diff`.
- L6. Feed-only message kinds (scope, release, claim, broadcast changed) do not wake agents; a changed notice addressed to someone who uses the renamed symbol still does; actionable merge conflicts use an addressed conflict kind that enters the inbox and wakes its recipient.
- L7. Tool descriptions and compact schemas have a 9,500-character regression budget (20 tools, 9,023 characters in this batch); shorter instructions and skills explain Room without a tool tour.
- S1. With coordination expected, missing hook activity produces one actionable notice; startup login and join failures reach the first Room reply instead of only logs.
- S2. Addressing a participant known to be unwakeable says it will see the message on its next turn.
- S3. State reports changed files withheld by size or sharing budget; the daemon withdraws stale shared text when a file becomes too large.
- S4. Company is announced once per session using participant names and their current task or files.
- S5. Before-edit hooks request a claim only where another participant’s scope, claim or changes overlap the path, using the same directory-boundary matcher as the tools.
- D1. README starts with installation and local/team use; Claude Code channel setup has one canonical explanation linked by onboarding, the launcher and join skill.
- D2. Guides document collection and cleanup, actual storage locations, the current same-branch requirement, and plugin updates taking effect in new sessions.
- D3. Current guides and plugin descriptions use plain, consistent terms: team room, participants, and you; historical submission drafts are labelled as such.

## 0.8.0 — 2026-09-21

- Linked inputs and symlinks leaving a worktree are listed under "NOT previewed" on both worker and lead previews.
- Collection waits up to 15 seconds for a worker that reported done to exit; force remains available when it does not exit.
- A fast successful exit after `room_done` is completion, not a death interrupt; failed or unreported exits retain diagnostics and log tails.
- Collection and retirement share linked-input exclusions, so a merged worker retires even when Git lists its input symlink as untracked.
- Extracted Claude channel notification logic and added regressions proving a successful send leaves messages unseen for `room_wait` and inbox delivery.
- Fixed before release use: a Claude wake-up no longer marks a message as seen. Sending a wake-up is not proof the agent received it (a session without the channels flag ignores it; a busy session queues it), and marking it seen made `room_wait`, the inbox and the hook skip the message, so an interrupt could vanish. Only tool replies and hook context count as delivered.
Fixes from the audit of the longest real use of Room (`docs/audit-2026-09-21-qube.md`).

- A1. Integration is not a conflict: an edit inside someone's claim that is byte-identical to the holder's own current text raises nothing; one fyi per holder ("rohanz integrated 4 files of rohanz+volkeys").
- A2. Writes are attributed to the session, not the folder: the before-tool hook records per-session write intents (newest 200, 10 minutes); a change my session did not intend in the last 2 minutes is someone else's, at most one fyi per path per 10 minutes. Without hook evidence the old behaviour stays.
- A3. Two agents in one folder: overlap checks between co-located participants are skipped, and the second one's join reply says its changes are published under the first participant's name.
- A4. Tool replies and hook context mark messages seen; ids the hook showed are picked up from `room-hook-seen.json`, only for the participant they were shown to. Channel sends do not mark delivery.
- B1. A worker process that exits without `room_done` has its claims released and plans ended quietly (`releaseClaimsOnDone`).
- B2. The lead gets one interrupt when a worker dies (non-zero exit or exit without done) with the last 5 log lines, ANSI stripped, at most 600 characters. Exits within 90 s use an early-exit duration in the wording.
- B3. `room_spawn` `effort` is validated and passed to Codex as `-c model_reasoning_effort=<value>`; shown only for Claude.
- B4. Compute budget, priority and effort are in the worker's prompt; the spawn reply is shorter.
- B5. `room_spawn` `link` (default: `.roomlinks`) symlinks repo-relative inputs from the lead's clone into the worktree, validated, recorded on the worker (`Worker.link`) and named in the prompt as read-only.
- B6. When the lead's session cannot be confirmed wakeable (`claudeWakeUnavailable`, shared with `claudeWakeNote`), the spawn reply starts by saying so and telling it to loop on `room_wait`.
- C1. `room_preview_merge` handles files absent at the base, present on one side only, or added on both sides (empty base), never surfaces a raw git exit code, and names changed paths it did not preview because git ignores them.
- C2. New lead tool `room_collect` collects worker output and named artifacts with path checks and modified-destination protection. Its original history-writing behavior is removed in 0.9.0.
- C3. The room-workers skill finishes with `room_preview_merge`, then `room_collect`, then the report; README tools table updated.
- D1. The daemon never descends into a symlinked directory, never publishes a path whose real path leaves the worktree, and treats paths git cannot classify beyond a symlink as ignored.
- D2. Default ignores by name without reading the file (`.DS_Store`, `*.npy`, `*.npz`, `*.parquet`, `*.pkl`, `*.pt`, `*.bin`, `*.sqlite`, `*.zip`, `*.gz`, `*.tmp`, `*~`, dot-prefixed atomic-write temps); a skip is logged once per path.
- D3. A path published more than 5 times in 2 minutes is then published at most once every 30 s, trailing edge.
- D4. HEAD is checked before publishing; if it moved the overlay is rebased on the new HEAD. Changes within 300 ms are batched; a burst of more than 20 paths in a second waits 2 s.
- D5. Presence carries `watchedDirectory` (sha256 of the real path, never the path) and `publishUnder` for a second, non-publishing daemon on the same directory.
- D6. The symbol graph index starts with 0 to 4 s jitter and reuses a present participant's ready snapshot for the same base from the last 60 s, computing only its own observed contract changes.
- D7. The daemon logs one line with the reason when it stops.
- E1. Plans ended because their owner finished, left or died, or superseded by the same owner, are fyi, never enter an inbox, never wake anyone, and are coalesced to one line per owner per event.
- E2. `room_state` shows my claims and those overlapping my scope or changes in full, everyone else as one line per person; the default reply is capped near 8,000 characters with a final line saying what was omitted; `all=true` is complete, grouped by person.
- E3. Directory claims: `room_claim` on a path ending in "/" covers everything under it and needs no line range (`claimsOverlap`, `RoomDoc.claimsFor`).
- E4. A lead whose workers are running is told "nothing yet; 3 workers still running (a, b, c); nothing needs you" when `room_wait` times out, never "Tell your human".
- E5. A participant's own messages never enter its own inbox.
- E6. The MCP server logs why it stops (stdin closed, SIGTERM, SIGINT) and writes uncaught exceptions and unhandled rejections to its log file and stderr before exiting.

## 0.7.0 — 2026-09-21

- Treat reported-done, failed and dismissed workers as unable to answer even before process exit; question waits return immediately. Participant lines show recency once, and shared web/room_state activity labels use finished-worker timestamps instead of recent tool activity.

- Local rooms remember. The relay saves the room's memory (timeline and its archive, finished-worker records, worker records, scopes, colours) to `<git dir>/room-local/` and loads it on start; it never saves file text, base texts, graphs or claims, which present agents rebuild. Reading a file from a finished worker that is no longer connected falls back to its worktree on disk, labelled as such. `room_close` on a local room forgets it.
- Add Node 22 GitHub Actions CI for typechecking, identity-isolated tests, web/plugin builds and committed plugin asset freshness, with a README status badge.
- Asking someone who cannot answer no longer times out: `room_send` to an exited or retired worker replies at once with when it finished and its one-line summary, an unknown name lists the participants, and `room_wait` on that question returns the same line. An offline teammate keeps the old behaviour plus "X is offline; it will see this when it returns".
- A finishing worker's summary is said once, in the done message. Releases on done carry the claim's own short summary (or "released on done") and plans ended by finishing are fyi with no summary text (`releaseClaimsOnDone`).
- Activity means "did something": every tool call (hook-recorded, throttled to 5 s) and every `room_*` call touches presence. One shared `activityLabel` in `views.ts` words it for web and `room_state`: "working" under 90 s, then "last action 4m ago", never "idle"; a live worker is "running", plus "quiet 6m" after 5 minutes without an action.
- Hooks resolve their state directory by session id, not shell cwd, so a lead working inside a worker's worktree is no longer described as that worker.
- Spawned workers run under `nice` (`ROOM_WORKER_NICE`, default 10, 0 disables, POSIX only); the tracked pid is still the worker's. The spawn reply shows "priority nice 10".
- `room_preview_merge` with `run` ends with "tests: PASSED|FAILED (exit N)" and the runner's own summary lines (vitest, pytest, jest), ANSI stripped, at most 6 lines.
- Local rooms save read markers (`seen:*` maps, newest 2000 per participant), so addressed messages are not re-delivered after a restart.

- Retirement rule corrected after review: a finished worker retires only when its worktree is clean and its branch has nothing the lead lacks. Workers leave changes uncommitted for the lead, so "branch is merged" was trivially true at exit and would have removed their work from the room before the lead saw it. Dismissing a dirty worker records how many uncommitted files stay on disk.
- Fix idle Codex wake-ups: unflagged SessionStart hooks identify as Codex, and wake routing prefers the MCP process host over stale session hints.
- Detect Claude models from the last 64 KB of the transcript on tool calls, caching transcript mtime and size to skip unchanged files; live presence refreshes automatically.

- People, Board and room_state show verified session models and explicit worker effort, refresh hook metadata on session changes, and retain worker metadata offline.

- Browser view batches room-driven updates: one render per animation frame (a one-second timer when the tab is hidden), and the code pane recomputes its merge only when the open file's inputs change. With a 1,400-line file open, a burst of 200 unrelated updates went from 258 long tasks and about 24 s of blocked main thread to none, worst frame 39 ms. Clicks still render immediately. The large-file threshold drops from 3,000 to 1,500 lines.
- Spawned Claude and Codex workers receive deterministic math-library thread caps and an informational memory budget; explicit environment settings are preserved, with per-worker `threads` and lead-wide `ROOM_WORKER_THREADS` overrides.
- Worker lifecycle: a worker whose process exited after `room_done` is retired once it is dismissed, its `room/<tag>` branch is merged into the lead's HEAD, or its worktree is clean and not ahead. Retiring removes its overlay, deleted marks, scope, claims (released as "retired"), graph snapshot and colour slot in one transaction and leaves one compact archive record (`RoomDoc.retiredWorkers()`, capped at 200). The lead's MCP process evaluates the rule after each worker exit, `room_dismiss`, merge previews and every 60 s. Workers that exit without `room_done` stay visible as failed until dismissed, and `room_spawn` refuses to overwrite them. Tags and colours are reusable after retirement.
- `room_state` counts "N active" participants, shows running and failed workers in full and one "finished: N (all=true lists them)" line; `all=true` lists the archive. `splitParticipants` in `@room/shared` is the one split into active / offline teammates / retired workers, used by tools and the browser view.
- Browser view: People and Board list active participants with workers nested under their lead ("<lead> · 2 running · 15 finished", finished group expands to archive records); header says "N active"; timeline and merge chips come from active participants plus the visible timeline window, the rest behind one "more" control.
- Log an unpushed HEAD warning once per distinct HEAD/base pair instead of repeating it every base poll.

- Local joins accept separate named rooms as `local/<name>` and show the current room and browser link. Re-joining the same room preserves the session; moves explain that old links no longer show it and are refused while its workers run. Worker/bridge room routing is preserved.
- Reset `companyTold` at every session start while preserving seen inbox ids, so a new session hears about teammates already present in the clone.
- Hook re-trust note: this release widened the before-edit hook matcher. Start Codex interactively and trust the Room hooks again; until then, `codex exec` silently skips the changed hook.
- The before-edit hook also runs on the host's shell tool. A Codex session that edited only through shell commands was never told it had company and never saw its inbox or teammates' claims. Inbox and company lines are delivered on any call; the claims warning fires only when the command looks like a write.
- New `room-workers` skill: the procedure for running parallel work through room workers (split, spawn, answer, preview all together, collect, test, report). A phrasing check showed five of six everyday requests already reached `room_spawn`; the miss, "get codex to do half", is now named in the tool description.
- Fixed two sessions under one login both joining as the bare login when one runs in a worktree of the other's clone: the remembered tag is now stored per worktree, and the name probe judges presence by the connection heartbeat (one shared definition with company), not by the last file change.
- Company is detected from the connection heartbeat, not from the last file change, so an agent that thinks for a minute between edits still counts as present.
- Instructions, the etiquette skill and the `room_spawn` description say to prefer `room_spawn` over a host's built-in subagents for parallel edits: separate worktree, identity, claims and wake-ups.
- Code view handles large files: above 3,000 lines it shows changed regions with context, collapses unchanged runs and pages long runs 500 lines at a time, with "show all" rendered in chunks. Lines over 2,000 characters are clipped with a control to show the rest, and the changed-files list caps at 300 rows. A 32,000-line file that used to hang the tab now opens in under 50 ms.
- Room stays silent while a session is alone and starts coordinating when another participant joins or the session spawns workers.

## 0.6.9 — 2026-09-16

- License changed from MIT to PolyForm Noncommercial 1.0.0. Releases up to 0.6.8 remain MIT.
- A bare "join the room" means the team room.
- Observed contract changes: a changed definition line in someone's diff is treated like a declared plan on that symbol. Consumers whose changed or claimed files use it get a `contract` notice, and the network view's Downstream column fills from both announced plans and observed changes (announced wins per symbol).
- Participant colours are assigned per room in join order and kept, instead of hashed from the name, so people in the same room never share a colour.
- The daemon drops stale overlay entries at start for files that no longer exist on disk or at base, instead of showing yesterday's files as current.
- Auto-assigned tags stick to the clone (`room-choice.json`), and a name that still holds another clone's uncommitted work counts as taken, so a returning session cannot overwrite a teammate's overlay.
- Browser timeline shows room notices (contract changes, conflict notes) in the addressee's episode instead of dropping them.
- Codex plugin no longer passes `GH_TOKEN`/`GITHUB_TOKEN` through to the MCP server; nothing reads them and forwarded tokens are refused by the server.

## 0.6.8 — 2026-09-15

- Code pane: hovering a line shows a one-line annotation in the right column; clicking opens an inline detail row (owners, claims and plans, conflict pair and resolution). The floating card remains only on the Board and the Network tab.
- Network tab: downstream impact now shows consumers of every plan seen in the session (released ones in grey) and matches symbols by bare name; zoom defaults to 150% with steps of 25.
- Resize handles are short grips between the columns.

## 0.6.7 — 2026-09-15

- Merge previews and the conflict watcher use git's own merge (`git merge-file`), so a clean preview means a clean push; the reply says so.
- Previews and conflict checks consider present participants only; offline overlays are skipped by default (`includeOffline`), and the browser's merge chips start off for offline people.
- Sessions clear their presence on exit; a restart seconds later no longer tags itself; room_done explains local test failures that a clean combined preview makes expected.
- Browser view: every changed line tinted by author with a participant chip row and an n-way merge; resizable columns; stacked or collapsed conflict tags in a reserved column; tooltips wrap and stay on screen.

## 0.6.6 — 2026-09-15

- "Join the team room" on a repo nobody has opened now asks before opening; `room_create` needs `confirm=true` for a new repo.
- Automatic tags use the host the plugin sets (`ROOM_HOST`), so a Codex session next to a Claude one is `+codex`; the tag is announced in the first reply.
- The offline banner in room_state is computed from the primary session and only after a real disconnect.
- The channels note prints once at join, neutrally; the merged pane tints every changed line by author; tooltips wrap and stay inside the viewport.

## 0.6.5 — 2026-09-15

- `claude-room` launcher: starts Claude Code with `--dangerously-load-development-channels plugin:room@room`, the one flag Room's wake-ups need during the channels research preview. The flag, what it does, and why, are explained in the launcher, the README, the onboarding page and the join skill.

## 0.6.4 — 2026-09-15

- Claude Code wake-ups: workers spawned by a lead start with the channels flag; join and done replies on a Claude host say when wake-ups need `--dangerously-load-development-channels plugin:room@room`; docs updated (Codex needs nothing).
- A second session under the same login on the same branch is tagged automatically (`rohanz+claude`, `-2`, …); ROOM_TAG still wins.
- Browser view: favicon is the cube; overlay layer for tooltips; header box equal in both themes; lighter theme fade; audit fixes.
- Server: reconnecting clients keep their presence.

## 0.6.3 — 2026-09-15

- Browser view: light theme by default with a Light/Dark/System control and a short fade; neutral code pane; conflicts rendered as author-tinted lines with one tag on the right, claim overlaps (amber "both claimed") distinguished from text conflicts (red); single line-number column with side dots in divergent regions; Network tab restyled (segmented zoom defaulting to Fit, stat chips, tooltip); presence in the people rail follows live presence; header shows the logo at 40px and `owner / repo` with a branch chip; reconnect notice waits two seconds; pluralised counts.
- Server: a reconnecting client's presence is no longer dropped by the identity guard.

## 0.6.2 — 2026-09-15

- Browser view redesigned: Room brand and logo, a Board view for projectors and shared links (participant cards with areas, sharing level, claims and plans, nested workers, hide-offline, full-width timeline with filters) and the restyled Code inspector; dark mode with checked contrast; no more spurious view-token call on load.

## 0.6.1 — 2026-09-15

- Less noise by default: routine scope, release, change and note events stay in the feed; the inbox prefix appears only when something is unread; `room_state` shows the people and claims near your work in full and one line for the rest; the agent instructions are six rules, with detail in the etiquette skill.
- Rolling bus (`ROOM_BUS_KEEP`, default 2000) with a compact ledger archive; `room_pr_note` and ledgers read it.
- `OFFLINE` banner in `room_state` while the server is unreachable; sends and waits say so; `room_wait` returns at once on an already-unread message that would end it.
- `room_preview_merge` takes `people`: a lead previews all its workers in order; `run` uses the combined tree.
- `room_export` writes the room's story to `.room/ledger/`; `room_close` does the same before deleting anything.
- `room_spawn` prunes stale worktree registrations; `room_join` refuses a `name` argument on login servers instead of joining invisibly; PR mirrors never claim a symbol's definition; dismiss wording matches state.
- Daemon: unified default ignores, watched-file count with a warning above 20,000; conflict watcher limited to four merges per ten seconds with hash dedupe.
- Internals: session registry, `tools.ts` split by concern, one auth model (forwarded GitHub tokens refused; `ROOM_TOKEN` non-GitHub only; `GITHUB_CLIENT_ID=fake` test issuer), `@room/relay` package, message kinds registry, shared views, one config resolver.
- README status paragraph; onboarding fixes from a fresh-install walkthrough; deploy runbook.

## 0.6.0 — 2026-09-15

The day after the hackathon. Everything below was built, reviewed (four passes, alternating Fable and Codex) and live-tested.

**Rooms**
- Local rooms by default: no server, no account. A relay next to the clone; the browser view is served from it on a same-machine link.
- Rooms by instruction: "join the team room" / "work locally", remembered per clone. The hosted server is opt-in (`ROOM_SERVER=hosted`).
- Repos are opened once (`room_create`), then every branch has a room. Repos idle for 30 days close themselves; `room_close` for now.
- Folder-scoped areas from CODEOWNERS; room state and the inbox are filtered to your areas.
- Sharing levels: `intent`, `declared`, `full`; a server ceiling; the bridge never widens what a lead publishes.

**Workers**
- `room_spawn` / `room_dismiss`: a lead dispatches Claude Code or Codex workers into worktrees, coordinated through the room; `room_done` wakes the lead.
- A lead in a team room can keep its workers in a local room (the bridge): the team sees one participant.

**Identity and access**
- GitHub device login; the server holds the token, clients keep an opaque session. Push access required; public repos are not open rooms.
- Principals: `{name, kind: human|agent|bot|ci, owner, label}`; names bound to the verified login; one person can run several agents (`ROOM_TAG`).
- OIDC login, audit log, Postgres option, self-hosting guide. Forwarded GitHub tokens are refused everywhere.

**Coordination**
- Automatic conflict notices: editing inside someone's claim, or a file that no longer merges cleanly, posts an interrupt.
- Reliable wake-ups: retries, freshness checks, Claude Code channel.
- Pull requests appear as participants; `room_pr_note` posts the room's story to the PR.

**Server hardening**
- Read-only view links, message and document size caps, graph snapshot throttling, idle expiry. Runbook in `deploy/DEPLOYING.md`.

**Internals**
- Session registry (a process can hold several rooms), stable worker ids, tools split by concern, message kinds registry, shared views for browser and agent, one config resolver, the relay in its own package.
