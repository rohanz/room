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
| `room_create` | Open a room for this repo on the server, then join the room for the current branch. |
| `room_join` | Join the room for this clone. |
| `room_leave` | Leave the room: releases your claims, clears your scope, stops the daemon. |
| `room_scope` | Declare what you are working on: a one-word area, a one-line summary, and the paths you expect to touch. |
| `room_state` | Room overview: who is here and on what, per-area activity, open claims with plans, files changed by whom, recent bus. |
| `room_read` | A file as a person sees it right now: base commit + their uncommitted edits (default: you). |
| `room_diff` | Unified diff from the base commit to a person's live version, for one path or all their changed paths. |
| `room_who` | Who holds claims in a region of a file, whose scope covers it, and who has changed the file. |
| `room_claim` | Claim what you are about to edit, saying what you will do: either a symbol (function/class name; the room resolves its line range) or a line range. |
| `room_release` | Release a claim with a summary of what you did. |
| `room_send` | Post to the bus. |
| `room_wait` | Block until a claim is released, a question is answered, or an interrupt arrives for you; or until timeout (default 30s, max 120s). |
| `room_done` | Mark your current task finished: releases any claims you still hold, clears your scope, and posts a one-line completion note. |
| `room_impact` | Dependency graph query. |
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

## Limitations

Access: the server admits a GitHub-named room only to GitHub tokens that can read the repo
(or a shared `ROOM_TOKEN`), and only after someone has opened the repo with `room_create`.
Inside a room everything in the doc is visible to every member. Claim ranges are not
remapped as files change. Disk edits are attributed to the machine's human; the agent is visible via claims,
cursor, status and bus messages.
