# Changelog

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
