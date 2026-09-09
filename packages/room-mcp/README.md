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
| `room_state()` | meta, participants (status/cursor), open claims, last 10 bus msgs, unread count |
| `room_read_live(path)` | live text with line numbers + claims/cursors in the file |
| `room_read_committed(path)` | `git show HEAD:path` from the local clone |
| `room_diff(path?)` | unified diff HEAD → live, one file or all changed |
| `room_who(path, from?, to?)` | cursors and claims overlapping a region |
| `room_claim(path, from, to, intent)` | claim a range (clamped); overlap → `conflict` on the bus + warning in reply |
| `room_release(claimId, summary?)` | release, posts `release` |
| `room_send(type, text, to?, paths?, inReplyTo?)` | `changed` / `question` / `answer` |
| `room_wait(seconds≤30)` | sleep, then reports how many bus messages arrived |

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
using the same `shouldWake` filter (`import { shouldWake } from '@room/room-mcp/wake'`)
and the same preamble (`AGENT_INSTRUCTIONS(name)` from `@room/room-mcp`).

## Limitations

No auth: anything in the room doc is forwarded. Claim ranges are not remapped as files
change. Disk edits are attributed to the machine's human; the agent is visible via claims,
cursor, status and bus messages.
