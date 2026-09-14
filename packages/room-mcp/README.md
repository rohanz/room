# @room/room-mcp

MCP server (stdio) that puts a coding agent into a live room: room state, claims, bus
messages, and event push. Agents edit files on disk with their normal tools; `roomd`
syncs them. Agents get no write tool.

Env: `ROOM_URL` (`ws://host:1234/<room>`), `ROOM_NAME` (owner's name; agent identity is
`{name, kind:'agent'}`), `ROOM_DIR` (clone path). Falls back to `<cwd>/.room.json`
`{ "room", "name", "dir" }` written by `roomd`.

Run: `npx tsx packages/room-mcp/src/index.ts` (or `npm run mcp` at the repo root).

## Tools

| tool | what |
|---|---|
| `room_login` | GitHub device login to the room server (two calls: show the code, then wait for approval). |
| `room_logout` | Forget the stored session for this server. |
| `room_create` | Open a room for this repo on the server, then join the room for the current branch. |
| `room_join` | Join the room for this clone. |
| `room_close` | DESTRUCTIVE: close the room for this whole repo, for everyone; all branch rooms and shared uncommitted work are removed from the server. Only on the user's explicit request. |
| `room_leave` | Leave the room: releases your claims, clears your scope, stops the daemon. |
| `room_scope` | Declare what you are working on: a one-word area (e.g. "auth"), a one-line summary, and the paths you expect to touch. |
| `room_state` | Room overview: who is here and on what, per-area activity, open claims with plans, files changed by whom, recent bus. |
| `room_read` | A file as a person sees it right now: base commit + their uncommitted edits (default: you). |
| `room_diff` | Unified diff from the base commit to a person's live version, for one path or all their changed paths. |
| `room_who` | Who holds claims in a region of a file, whose scope covers it, and who has changed the file. |
| `room_claim` | Claim what you are about to edit, saying what you will do: either a symbol (function/class name; the room resolves its line range) or a line range. |
| `room_release` | Release a claim with a summary of what you did. |
| `room_send` | Post to the bus. changed: paths + summary (+ symbols renamed/changed, which notifies whoever uses them). question: to a person's agent. answer: inReplyTo a question id. note: broadcast fyi. |
| `room_wait` | Block until a claim is released, a question is answered, or an interrupt arrives for you; or until timeout (default 30s, max 120s). |
| `room_done` | Mark your current task finished: releases any claims you still hold, clears your scope, and posts a one-line completion note. |
| `room_impact` | Dependency graph query. symbol: who defines it and which files use it, with who owns those files (scope, claims, uncommitted changes). path: what the file depends on (symbols defined elsewhere) and what depends on it. |
| `room_preview_merge` | Would your uncommitted changes and another person's combine cleanly? Three-way merge against the common base; nothing in any clone is written. |

Every reply (except join) starts with your unread inbox. Full descriptions are in `src/tools.ts`; the agent-facing rules are in `src/prompt.ts` and the plugin's `room-etiquette` skill.

## Claude Code (channel wake-ups)

`.mcp.json` in the clone:

```json
{
  "mcpServers": {
    "room": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/room/packages/room-mcp/src/index.ts"],
      "env": { "ROOM_URL": "ws://localhost:1234/demo", "ROOM_NAME": "Rohan", "ROOM_DIR": "." }
    }
  }
}
```

Launch with the channel enabled so room events arrive as `<channel source="room" ...>`:

```sh
claude --dangerously-load-development-channels server:room
```

Without the flag tools still work; `room_state` reports unread messages, so poll it.

## Codex CLI (`~/.codex/config.toml` or project `.codex/config.toml`)

```toml
[mcp_servers.room]
command = "npx"
args = ["tsx", "/abs/path/to/room/packages/room-mcp/src/index.ts"]
env = { ROOM_URL = "ws://localhost:1234/demo", ROOM_NAME = "Rohan", ROOM_DIR = "/abs/path/to/clone" }
```

Codex has no channel equivalent; `packages/agent` (`roomagent`) wakes the Codex thread
using the same shared message/claim wake policy (`shouldWakeOnMsg` and `shouldWakeOnClaim`
from `@room/shared`) as the MCP channel's `shouldWake` wrapper
and the same preamble (`AGENT_INSTRUCTIONS(name)` from `@room/room-mcp`).

## Identity

A participant is a principal: `{ name, kind, owner, label }`. `name` is the key everything in the room is filed under (overlays, claims, messages). `kind` is `human`, `agent`, `bot` or `ci`; anything that is not a human behaves like an agent for claims and wake-ups. `owner` is the verified GitHub login responsible for the participant: a person's own login, the runner of an agent, or the account that registered a bot. On a server with GitHub login the owner is always the login you signed in with; the first agent under a login takes the login as its name, and `ROOM_TAG=codex` makes a second one named `login+codex` (`ROOM_KIND` sets bot or ci). The server drops any presence whose owner is not the verified login. Display: `rohanz's agent (codex)`, `deploy [bot]`; participant lists show `rohanz+codex · agent of rohanz · codex`.

## Limitations

Access: the server admits a GitHub-named room only to GitHub tokens that can read the repo
with push access (or a shared `ROOM_TOKEN`), and only after someone has opened the repo with `room_create`.
Inside a room everything in the doc is visible to every member. Claim ranges are not
remapped as files change. Disk edits are attributed to the machine's human; the agent is visible via claims,
cursor, status and bus messages.

## Automatic notices

Besides tool replies, the MCP process watches the room and posts on your behalf:
- an `interrupt` when your uncommitted edit lands inside someone else's open claim and you hold none there (the holder gets a `notify`);
- a `notify` when a file you changed no longer merges cleanly with a teammate's version (an `fyi` when it does again);
- an `fyi` on join when it evicts uncommitted work of someone absent for more than `ROOM_STALE_DAYS` (default 7).

Wake-ups: interrupts and questions addressed to you reach an idle Codex thread through `codex queue` (retried with backoff; the thread id comes from the SessionStart hook) and a Claude Code session through the MCP channel notification.
