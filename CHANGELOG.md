# Changelog

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
