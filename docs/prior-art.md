# Prior art (researched 2026-09-09)

Nothing found does: each person brings their own agent + agents coordinate with each other + agents see live human edits + editor-agnostic, execution-local. Cite these in the writeup and state the gap.

## Closest

- **AgentRoom** — arxiv.org/html/2608.23740v1 (Aug 2026). CRDT-shared filesystem (pycrdt) + 5 MCP tools: `room_claim`, `room_release`, `room_broadcast`, `room_read`, `room_state`. Advisory protocol: read state, claim before writing, adjust on conflict, broadcast completion. Code released. Result: uncoordinated concurrent agents underperform a solo agent; the coordination layer (not the CRDT) drives gains. Gap: fully autonomous, no humans live, file-level claims.
- **Zed Delta** — announced 12 Aug 2026, private beta. Humans + agents co-edit live buffers; conversation and worktree replicated together (DeltaDB); comments anchored to lines. Gap: Zed-only, Zed's agents, no stated agent-to-agent coordination.
- **Electric, "AI agents as CRDT peers with Yjs"** — electric.ax/blog/2026/04/08/ai-agents-as-crdt-peers-with-yjs. Agent joins Yjs doc server-side with cursor + presence (thinking/composing/idle). Single agent, prose docs.

## Adjacent

- Claude Code agent teams (code.claude.com/docs/en/agent-teams) and claude-peers-mcp: agents message each other, single account/machine, no live human-edit awareness.
- Cursor / Conductor Cloud / Amp orbs / Superconductor / AQ: many humans share one agent session. See aq.dev/multiplayer-coding-agents.
- anthropics/claude-code#60082 (May 2026): open request for multi-user Claude Code sessions, no maintainer response. Cursor forum thread 167009: shared live agent memory for teammates. Both demand signals.
- CodeCRDT (arxiv.org/pdf/2510.18893): evaluator agent catches semantic conflicts a CRDT can't (duplicate decls, type errors). Later-layer idea.

## Positioning line

"Humans and their own agents in one room, where the agents can see each other and the humans." Borrow AgentRoom's tool vocabulary; make claims region-level, not file-level.
