# @room/room-mcp

MCP server (stdio) that puts a coding agent into a live room: room state, claims, bus
messages, and event push. Agents edit files on disk with their normal tools; `roomd`
syncs them. Agents get no write tool.

Env: `ROOM_URL` (`ws://host:1234/<room>`), `ROOM_NAME` (owner's name; agent identity is
`{name, kind:'agent'}`), `ROOM_DIR` (clone path), `ROOM_SHARE` (sharing level, see below). Falls back to `<cwd>/.room.json`
`{ "room", "name", "dir" }` written by `roomd`.

Run: `npx tsx packages/room-mcp/src/index.ts` (or `npm run mcp` at the repo root).

## Tools

| tool | what |
|---|---|
| `room_login` | GitHub device login to the room server (two calls: show the code, then wait for approval). |
| `room_logout` | Forget the stored session for this server. |
| `room_create` | Open a room for this repo on the server, then join the room for the current branch. |
| `room_join` | Join a room for this clone: `where=local` (default), `where=team`, or a server URL; a `team` choice is remembered for the clone. |
| `room_close` | DESTRUCTIVE: close the room for this whole repo, for everyone; all branch rooms and shared uncommitted work are removed from the server. Only on the user's explicit request. |
| `room_leave` | Leave the room (and the local workers room, if any); `forget=true` clears the remembered choice. |
| `room_scope` | Declare what you are working on: a one-word area (e.g. "auth"), a one-line summary, and the paths you expect to touch. |
| `room_state` | Room overview: who is here and on what, per-area activity, open claims with plans, files changed by whom, recent bus. Filtered to your areas; `all=true` shows everything. |
| `room_read` | A file as a person sees it right now: base commit + their uncommitted edits (default: you). |
| `room_diff` | Unified diff from the base commit to a person's live version, for one path or all their changed paths. |
| `room_who` | Who holds claims in a region of a file, whose scope covers it, and who has changed the file. |
| `room_claim` | Claim what you are about to edit, saying what you will do: either a symbol (function/class name; the room resolves its line range) or a line range. |
| `room_release` | Release a claim with a summary of what you did. |
| `room_send` | Post to the bus. changed: paths + summary (+ symbols renamed/changed, which notifies whoever uses them). question: to a person's agent. answer: inReplyTo a question id. note: broadcast fyi. |
| `room_wait` | Block until a claim is released, a question is answered, or an interrupt arrives for you; or until timeout (default 30s, max 120s). |
| `room_done` | Mark your current task finished: releases any claims you still hold, clears your scope, and posts a one-line completion note. `pr_note: true` also posts the branch ledger on the PR whose head is this branch. |
| `room_pr_note` | Post or update the one room comment on a GitHub PR with the branch's story (scopes, claims and plan outcomes, questions and answers, passing merge previews). Default PR: the open one whose head is this branch. |
| `room_impact` | Dependency graph query. symbol: who defines it and which files use it, with who owns those files (scope, claims, uncommitted changes). path: what the file depends on (symbols defined elsewhere) and what depends on it. |
| `room_preview_merge` | Would your uncommitted changes and another person's combine cleanly? Three-way merge against the common base; nothing in any clone is written. |
| `room_spawn` | Dispatch a worker agent (claude or codex, optional model) into this room, or with `where=local` into a local workers room while you stay in the team room; it reports back with room_done. |
| `room_dismiss` | Stop a worker you spawned; its worktree and branch are kept. |
| `room_share` | Change how much of your clone the room sees, live: `intent`, `declared` or `full`. Without `level`, reports the current level and what is withheld. |

Every reply (except join) starts with your unread inbox. Full descriptions are in `src/tools.ts`; the agent-facing rules are in `src/prompt.ts` and the plugin's `room-etiquette` skill.

## Pull requests

Open pull requests targeting the room's branch count as declared intent. On join and every two minutes the client whose participant name sorts lowest among those present (a cheap leader election over awareness, so four agents do not fight) asks the server for them (`GET /github/prs`, which calls GitHub with the token behind the caller's device-login session and caches the answer for 60s per repo) and mirrors each one into the doc as a synthetic participant: identity `{ name: "pr#<n>", kind: "bot", owner: <author>, label: "PR #<n>" }` with a scope whose area is the PR's most common top-level directory, whose summary is its title and whose paths are its files. PRs never get overlays and are never routed messages; `room_state` lists them under "open pull requests", and `room_who`, `room_impact` and the area ledgers see their paths like anyone else's scope. A closed PR disappears at the next refresh.

The other direction is `room_pr_note` (or `room_done pr_note:true`): the branch's room story is rendered as markdown, in bus order, and posted through `POST /github/pr-note`, which finds the caller's earlier comment by its `<!-- room-ledger -->` marker and edits it, so a PR carries exactly one such comment per person. Sessions without a GitHub token (a shared-token or OIDC login) get a 403 and a plain "log in with GitHub" reply; nothing is retried.

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

## Sharing levels

By default joining a room publishes the full text of every file you have changed (`full`). The dial has three positions:

| level | what the room sees from you |
|---|---|
| `intent` | presence, scope, claims, plans and bus messages only; no file text at all, not even deletions |
| `declared` | file text only for paths under your `room_scope` paths; everything else is withheld (`room_share` lists it) |
| `full` | every changed file (the default for now) |

**Teams should set `ROOM_SHARE=declared`**: teammates still see what you are on and what you plan to change, and get your text only where you said you would work. Set it with the `ROOM_SHARE` env, the `share` argument of `room_join` / `room_create`, or `room_share(level)` at any time: lowering the level withdraws overlays immediately, raising it republishes what your disk holds, and under `declared` the published set follows your scope as you re-declare it. Your presence carries the level, so `room_state` shows it next to each person.

The server can cap it: `ROOM_SHARE_MAX` (advertised as `shareMax` in `GET /auth/config`). A client asking for more is clamped and told so in the join reply and in `room_share`.

Reading someone who shares less than `full` degrades rather than errors: `room_read`, `room_diff` and `room_preview_merge` on an `intent` sharer answer with one line (`X shares intent only; ask them or wait for their push`); paths a `declared` sharer keeps outside their scope come back as `not shared`.

## Areas (folder-scoped rooms)

A room is still one document per branch, but what you see is scoped to the folders you work in.

- **Where areas come from.** If the repo has a `CODEOWNERS` (`.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` at the room's base commit), every pattern is an area named by its path prefix (`packages/server/`, `docs/`, `/` for `*`-style patterns) with the owners listed there; gitignore-style patterns are supported (`*`, `**`, `?`, trailing `/`, leading `/` anchors, bare names match at any depth) and the longest matching pattern wins. Without CODEOWNERS every top-level directory is an area and `/` holds root files. Parsing lives in `packages/shared/src/areas.ts` (`Areas`, `areaOf`, `areasOf`, `ownersOf`).
- **Membership.** You are in the areas covering your declared scope paths plus your changed paths. `room_scope` stores them on your scope record (`areas`) and in presence; `room_join` and `room_scope` say which areas you are in and who else is in them.
- **Filtering.** `room_state` lists participants, claims, uncommitted changes and bus only for your areas, with one line for the rest (`3 others in 2 other areas (api/, web/)`). Pass `all: true` to see everything; with no scope and no changes yet you see everything. The inbox drops broadcast `notify` messages whose paths (or sender) are outside your areas; addressed messages and interrupts always arrive. `room_who` and `room_impact` are path-specific and unchanged.
- **Ownership hint.** When you declare a scope or claim in an area you do not own per CODEOWNERS, the reply adds `owners of api/: @rohanz, @kieran` so your agent can ask them. Nothing is enforced.

## Local rooms (no server)

Without `ROOM_SERVER`, a session joins a **local room**. The first session in a clone
starts a relay on `127.0.0.1` (a minimal y-websocket server: in-memory, no persistence)
on a port derived from the clone's git dir, and records `{port, pid, key}` in
`<git common dir>/room-local.json` (mode 0600). Because the port is fixed per clone, two
sessions that start at the same instant cannot end up in two rooms: one binds it, the
other gets EADDRINUSE and joins. Later sessions in the same clone or any worktree of it
check that a relay (not some other service) answers `/health` on that port and connect,
presenting the key. When the relay's owner exits, a remaining session takes the port over
within about two seconds and the others reconnect; every client holds the full document,
so nothing is lost. The room
is named `local/<repo basename>/<branch of the main worktree>`, so worktrees on other
branches still share it. Identity is `git config user.name` (plus `ROOM_TAG`), there is no
login, and `room_create` / `room_close` / `room_login` explain that they need a server.

`ROOM_SERVER=hosted` selects the hosted server; any `ws://` or `wss://` URL selects another.

The relay also serves the built browser view (shipped with the plugin under `web/`, or
`packages/web/dist` for source runs) at `http://127.0.0.1:<port>/` plus `/health`, and
accepts websocket connections from loopback only, each carrying the relay key. A local
session's `browser view:` link points there and includes the key; it works on this machine
only, and only for someone holding the link.

## Choosing the room

`room_join` takes `where`: `local`, `team` (the hosted server, what `ROOM_SERVER=hosted`
means) or a server URL. Precedence: the `where` argument, then `ROOM_SERVER`, then the
choice remembered in the clone (`<git common dir>/room-choice.json`, written when a join
was asked for by argument), then local. Joining the team room from a clone that never has
must be an explicit instruction, and the join reply says that uncommitted work in the clone
is now visible to the repo's room members. `room_leave(forget=true)` clears the memory.
`room_state` names the room on its first line. The skills map the phrases: "join the team
room" / "join the web room" / "join the shared room" → `room_join(where="team")`; "work
locally" / "leave the team room" → `room_leave(forget=true)` then `room_join(where="local")`.

## Lead in two rooms

`room_spawn(where="local")` while the lead is in a team room opens a local workers room
for the clone as a second session in the same MCP process and dispatches the workers
there; they never connect to the server. A `Bridge` keeps the team room informed: the
lead's team scope is the union of its workers' declared and changed paths (summary "lead
of N workers: …"); workers' claims are mirrored into the team room under the lead's name
with the intent prefixed `[tag]`, and removed when the worker releases; team messages
(claims, releases, changes, conflicts, plans, base moves, scopes) that touch a worker's
paths are re-posted into the local room as interrupts addressed to that worker. Workers'
questions to the lead and their `done` messages stay local; the lead's inbox, `room_wait`
and `room_state` read both rooms. `room_leave`, `room_close` and process exit tear both
down and drop the mirrored claims.

## Workers

`room_spawn(tag, task, host?, model?, share?, dir?)` makes a git worktree at
`<repo>/.room/workers/<tag>` on branch `room/<tag>` from HEAD (or uses `dir`), and starts
`claude -p` or `codex exec` there, detached, with `ROOM_ROOM`, `ROOM_TAG`, `ROOM_LEAD`,
`ROOM_DIR` and the lead's `ROOM_SERVER` in its environment; output goes to
`.room/workers/<tag>.log`. The worker's prompt is a fixed preamble (follow the etiquette,
ask the lead with `room_send`, `room_preview_merge`, then `room_done`) followed by the
task. The doc's `workers` map records tag, name, host, model, task, dir, branch, pid,
status (running, done, failed, dismissed) and summary; the lead's MCP process updates the
status on exit. A worker's `room_done` posts a `done` message addressed to its lead at
notify priority, which wakes the lead. `ROOM_MAX_WORKERS` (default 8) caps running
workers per lead. The daemon ignores `.room/`; add it to `.gitignore` too.

## Limitations

Access: the server admits a GitHub-named room only to GitHub tokens that can read the repo
with push access (or a shared `ROOM_TOKEN`), and only after someone has opened the repo with `room_create`.
Inside a room everything in the doc is visible to every member (subject to each person's sharing level). Claim ranges are not
remapped as files change. Disk edits are attributed to the machine's human; the agent is visible via claims,
cursor, status and bus messages.

## Automatic notices

Besides tool replies, the MCP process watches the room and posts on your behalf:
- an `interrupt` when your uncommitted edit lands inside someone else's open claim and you hold none there (the holder gets a `notify`);
- a `notify` when a file you changed no longer merges cleanly with a teammate's version (an `fyi` when it does again);
- an `fyi` on join when it evicts uncommitted work of someone absent for more than `ROOM_STALE_DAYS` (default 7).

Wake-ups: interrupts and questions addressed to you reach an idle Codex thread through `codex queue` (retried with backoff; the thread id comes from the SessionStart hook) and a Claude Code session through the MCP channel notification.

## Workers: what a lead may and may not do

- `room_leave` is refused while workers you spawned are running; `force=true` dismisses
  them first (they are told why). Ending the lead's session dismisses them the same way.
- `room_dismiss` signals a process this session spawned. A worker known only by pid (the
  lead restarted) is signalled only if that pid is alive and started after the worker
  record; otherwise it is marked dismissed and left alone, and the reply says so.
- `room_spawn dir=` outside the repo needs `allowOutside=true`; no worktree or branch
  bookkeeping is done for it.
- Joining the team room on the choice remembered for a clone prints the same one-line
  visibility notice as an explicit join, once per worktree.
- The bridge relays team plans, conflicts and base moves to workers as interrupts; scopes,
  claims and change notices arrive at notify, at most once a minute per worker, path and
  type. When a worker's claim ends, the team gets a release naming any unfulfilled plans.
