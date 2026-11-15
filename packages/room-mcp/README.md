# @room/room-mcp

MCP server (stdio) that puts a coding agent into a room: room state, claims, messages and
event push. Agents edit files on disk with their normal tools; `roomd` publishes the changes.
Collection and export write files only when requested.

How Room behaves is documented in one place, [docs/reference.md](../../docs/reference.md):
the tools, rooms and sharing levels, workers and previews, notices, local workers in a team
room, pull-request notes, the environment variables and the files Room writes. This file
only says where things are in the package.

Run: `npx tsx packages/room-mcp/src/index.ts` (or `npm run mcp` at the repository root).
The plugin ships a bundle of this package (`npm run build:plugin`, into `plugins/room/server`).

## Layout

- `src/tools/*`: one module per concern (join, scope, claims, messaging, files, workers,
  collect, share, prs); `index.ts` assembles the tool definitions. Tool descriptions are the
  text the model sees and have a size budget (`test/tool-budget.test.ts`).
- `src/config.ts`: one resolver for every setting, with a fixed precedence: tool argument,
  then environment, then the choice remembered in the clone, then the default.
- `src/session.ts`, `src/registry.ts`: a session in a room; a process can hold several rooms.
- `src/bridge.ts`: a lead in a team room with workers in a private local room.
- `src/conflict-set.ts`: overlap, merge and contract checks and their notices.
- `src/worker-*.ts`, `src/retire.ts`: the worker registry, launch, Git and refs, discard and
  retirement.
- `src/hosts/*`: what differs between Claude Code and Codex.
- `src/parse/*`: the tree-sitter index behind changed-definition notices and `room_impact`.
- `src/prs.ts`: pull-request lookup and notes through the server's GitHub proxy.

## Tests

`npx vitest run packages/room-mcp/test/<file>` runs one file. The whole suite and the
separate scale pass are described in [AGENTS.md](../../AGENTS.md).
