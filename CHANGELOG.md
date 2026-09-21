# Changelog

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
