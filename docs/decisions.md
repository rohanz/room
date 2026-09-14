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

## 2026-09-12 — v2: coordination, not sync
**Decision:** Stop writing teammates' edits to each other's disks. The room holds one live
overlay per person; agents read each other's versions through tools and preview-merge
before committing. Git stays git. Spec: `superpowers/specs/2026-09-12-room-v2-design.md`.
**Why:** Disk sync was the riskiest code (a Codex review found lost/duplicated edits on
same-line merges), it broke tests with half-done teammate edits, and the product is
agents coordinating, not text merging.
**Also decided:** one-step join (`$room-join`, room derived from origin + branch); plugin
mode is primary, the runner is "on duty" mode; intent first (scope with an area, claims
with declared plans); three priorities (fyi / notify / interrupt) with the room upgrading
changes that land in someone's scope or symbols; area and file ledgers read at the moment
of need; blocking `room_wait`; base commit advances when a member commits and others are
marked behind; browser becomes a read-only room view.
**Cut:** browser editing and chat, cursors from the browser, enforcement of claims at the
sync layer (advisory + conflict events instead; revisit if agents skip claims in rehearsal).

## Built when (v2)
- 12 Sep: Codex review pass and fixes (57 tests), v2 spec, phase 1 (overlays, push-only
  daemon; Codex gpt-5.6-sol), phase 2 (join, inbox, scopes, plans, ledgers, wait, preview
  merge, plugin skills; Claude), base tracking (Claude), phase 3 read-only web view
  (Codex). Live two-clone smoke run of join → scope → claim with plan → read teammate's
  version passed against a real server.

## 2026-09-12 — Symbol graph
**Decision:** Each agent's MCP process keeps a live definitions/references graph over the
base commit plus everyone's overlays (Python via `ast`, JS/TS via regex; per-file refresh
on overlay change, rebuild on base move). Exposed as `room_impact`, the impact line on
claims with plans, the "waiting on" section of `room_state`, and the scope/symbol upgrade
rule (replacing the earlier `git grep`).
**Why:** Recent code-graph work for agents (Aider's repo map, CodeGraph and the 2026
Codebase-Memory study) converges on tree-sitter tag maps served over MCP; the same shape
answers our coordination questions: who breaks if I rename this, and what am I waiting on.
**Cut:** call graphs, types, cross-language resolution, persistence, graph edges in the
browser view. Names are enough for coordination; revisit if false positives bite.

## 2026-09-12 — Dependency network browser view
**Decision:** Add a Network tab with participant selection, current-change and transitive
upstream highlighting, provider-to-consumer arrows, file details, search and zoom. Local
MCP indexers publish bounded, timestamped graph snapshots in the Y.Doc. The existing file
viewer remains available. Browser URLs preselect the joining participant.
**Why:** Make the dependency coordination visible during a demo and let people inspect
the upstream work their edits depend on. Overlay reverts and edits during extraction now
trigger fresh indexing; snapshots expose base and readiness rather than implying exactness.
**Limits:** Name-based inference and the indexer's existing mixed-overlay selection remain.
No parser migration, automatic conflict resolution, or guaranteed message interruption.
**Validation:** Model and indexer regression tests plus a live two-clone browser preview.

## 2026-09-13 — Result
Room placed third at the "Agents leaving the chatbox" hackathon. Live demo: two people,
dependent tickets on one function, merge previewed and pushed clean with no merge step.

## 2026-09-14 — Rooms are opened per repo, joined per branch
**Decision:** A repo must be opened once on the server (`room_create`, `POST /rooms`)
before any of its branch rooms accept connections. After that, a Codex session in a clone
auto-joins the room for its current branch, as before. The registry persists with the
room data.
**Why:** Auto-creating a room for any clone with a git origin meant a session could start
sharing uncommitted work with nobody having decided the repo uses Room. Opening is the
deliberate act; joining a branch of an opened repo is routine and should stay automatic.
Repo-level rather than branch-level because branches are where work lands, not a decision
anyone should have to repeat.
**Cut:** closing/archiving rooms, per-branch opt-out, an admin list of open repos.

## 2026-09-14 — Post-event hardening
**Decision:** Six changes in one pass. (1) The plugin directory carries a Claude Code
manifest next to the Codex one; same skills, hooks and bundle. (2) Wake-ups are marked
delivered only on success, retried with backoff, and wait for a fresh session file.
(3) View-key connections are read-only at the server. (4) Repos can be closed
(`room_close`, `DELETE /rooms`) and listed; overlays of people absent 7 days are evicted
on join. (5) Per-person overlay budget (8 MB) and `.roomignore`. (7) The MCP process
raises an interrupt when an edit lands inside someone else's claim, and previews the
merge automatically when two people change the same file. Also: joining now requires
push access to the GitHub repo, so public repos are not open rooms.
**Cut:** GitLab/Bitbucket auth, OAuth instead of forwarding the gh token, diff-based
overlay updates for large files.

## 2026-09-14 — GitHub device login; names bound to login; idle repos expire
**Decision:** The hosted server runs GitHub's OAuth device flow itself (`GITHUB_CLIENT_ID`)
and keeps the resulting token; clients hold only an opaque Room session and never send a
`gh` token. Participant identity is the verified GitHub login; the server drops awareness
updates that claim another name. `ROOM_TOKEN` is unset on the hosted server. Repos nobody
connects to for 30 days are closed automatically.
**Why:** Forwarding personal `gh` tokens to a third-party server was the one trust
problem a team outside ours would reject; self-declared names made every claim and
message spoofable; and rooms lived forever.
**Cut:** GitHub App installation tokens (finer permissions, more setup), server-side
inspection of Yjs updates for message authorship.
