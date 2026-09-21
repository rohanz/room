# Changelog

## 0.7.0 — 2026-09-21

- Local joins accept separate named rooms as `local/<name>` and show the current room and browser link. Re-joining the same room preserves the session; moves explain that old links no longer show it and are refused while its workers run. Worker/bridge room routing is preserved.
- Reset `companyTold` at every session start while preserving seen inbox ids, so a new session hears about teammates already present in the clone.
- Hook re-trust note: this release widened the before-edit hook matcher. Start Codex interactively and trust the Room hooks again; until then, `codex exec` silently skips the changed hook.
- The before-edit hook also runs on the host's shell tool. A Codex session that edited only through shell commands was never told it had company and never saw its inbox or teammates' claims. Inbox and company lines are delivered on any call; the claims warning fires only when the command looks like a write.
- New `room-workers` skill: the procedure for running parallel work through room workers (split, spawn, answer, preview all together, commit for the workers, merge, report). A phrasing check showed five of six everyday requests already reached `room_spawn`; the miss, "get codex to do half", is now named in the tool description.
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
