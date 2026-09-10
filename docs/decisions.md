# Decisions log

Append-only. Date every entry. Most recent at the bottom.

## Template

```
## YYYY-MM-DD — <title>
**Decision:** ...
**Why:** ...
**Cut / not doing:** ...
```

## Idea (not yet locked)

- Environment: _TBD_
- Users: _TBD_
- Core interaction (one sentence): _TBD_
- Why the environment is essential (what the agent knows/does here that a chatbox can't): _TBD_
- Thin vertical slice for the first working demo: _TBD_

## Built during the event (for eligibility)

Keep current. Judges may ask which parts were created during the hackathon.

- Pre-existing / reused: (libraries, templates, starter repo, ...)
- Built during the event: (everything else — list the core pieces)

## 2026-09-09 — Idea locked: "room"
**Decision:** Build the collaborative-agents room. Two people, two clones, one CRDT room; each
person's own coding agent joins with room tools, sees live edits + claims + other agents.
Spec: `superpowers/specs/2026-09-09-room-design.md`. Plan: `superpowers/plans/`.
**Why:** Hits the rubric's "could not be reproduced in a chatbox" line directly; prior-art
gap confirmed (`prior-art.md`): AgentRoom has agents-only, Zed Delta has no agent-to-agent.
**Cut / not doing (day one):** task board, review mode, replay, voice, browser-only
participants, server-side agents, auth, persistence.

## 2026-09-09 — Codex is the primary agent runtime
**Decision:** It's a Codex hackathon. `packages/agent` drives a Codex SDK thread per person,
feeding it the human's chat (from the browser sidebar, via the room doc) and room events as
sequential turns. Room tools stay an MCP server (`room-mcp`), which Codex loads through
`--config mcp_servers.room`. Claude Code stays supported through the same MCP server's
channel capability.
**Why:** Codex has no channel/push mechanism (openai/codex#15299, #17543), so a local runner
is the only way to wake a Codex agent on room events. Bonus: the chat living in the doc means
both people can see both agents' transcripts.

## 2026-09-09 — Execution is local, coordination is shared
**Decision:** Server = stock y-websocket, zero custom logic; all state in one Y.Doc. Each
laptop runs the daemon, the agent, tests and git against its own clone.
**Why:** No sandbox to build; bring-your-own toolchain and keys; git stays normal. The sync
daemon is the risk and gets built and tested first.

## Built when (for the writeup)
- 9 Sep (pre-event, cleared with organiser): docs, spec, shared schema, server, demo repo,
  and first versions of roomd / room-mcp / agent / web.

## 2026-09-10 — Findings from the first live runs (Codex)
- **Codex MCP approval.** With `approval_policy=never`, MCP tools without annotations are
  treated as needing approval and fail ("MCP tool call requires approval"). Fix: every room
  tool declares `annotations` (readOnlyHint for reads, destructiveHint:false for all) and the
  server config sets `default_tools_approval_mode = "auto"`. Both are in place.
- **Sandbox network.** `workspace-write` has no network by default, so `uv` could not fetch
  pytest. Runner sets `networkAccessEnabled: true`; demo clones are `uv sync`ed up front.
- **Untracked files must sync.** Agents create files without `git add`. roomd now syncs
  tracked + untracked-non-ignored files and asks git per new file to dodge a refresh race.
- **Tool ergonomics.** Claims on not-yet-existing files are allowed (range 1-1); `room_send`
  to yourself is refused with a hint to talk to your human in chat; broadcast claim/release
  events only wake an agent when they touch a file it has a claim in (otherwise each claim
  in the room cost a turn of "acknowledged").
- **Observed:** two Codex agents on overlapping tasks in one file claimed distinct regions,
  released, announced `changed`, and reacted to each other's events; clones converged.

## 2026-09-10 — Codex plugin
**Decision:** Ship `plugins/room` (manifest, `room-etiquette` skill, bundled MCP server) with
the repo as its own marketplace (`.agents/plugins/marketplace.json`). Verified: plain `codex
exec` in a synced clone loads the skill, gets the `room_*` tools, and posts on the bus.
**Why:** It is the native distribution unit for Codex users and gives a second mode that
needs no runner: normal Codex, room-aware. The runner stays for reactive agents.
**Gotchas (Codex 0.153):** `${PLUGIN_ROOT}` is not expanded in `.mcp.json` command/args;
use `cwd: "."` (plugin dir) with a relative script path. MCP servers get a clean env, so
`env_vars: ["PWD", ...]` passes the user's directory through; room-mcp walks up from PWD to
find `.room.json`. `codex exec` blocks on an open stdin; use `</dev/null` in scripts.
