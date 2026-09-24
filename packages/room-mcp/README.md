# @room/room-mcp

MCP server (stdio) that puts a coding agent into a live room: room state, claims, bus
messages, and event push. Agents edit files on disk with their normal tools; `roomd`
syncs them. Collection and export write files only when requested.

Configuration comes from one resolver (`src/config.ts`) with a fixed precedence: tool
argument, then `ROOM_SERVER`, legacy `ROOM_URL`, the choice remembered in the clone
(destination and who chose it, selected sharing level, per-worktree automatic tags and disclosure
state), then the default. The
settings: `ROOM_SERVER` (`local` by default, `hosted`, or a `ws(s)://` URL),
`ROOM_NAME` / `ROOM_OWNER` / `ROOM_TAG` / `ROOM_KIND` (identity), `ROOM_SHARE` (sharing level),
`ROOM_CREDENTIALS`, `ROOM_TOKEN`, `ROOM_LOG_FILE`, `ROOM_MAX_WORKERS`, `ROOM_STALE_DAYS`,
`ROOM_ROOM` (explicit room name, how workers get the lead's room), `ROOM_WEB`, and, for a
dispatched worker, `ROOM_WORKER_ID` / `ROOM_GEN`. Nothing is required: with nothing set a
session is in a local room.

Run: `npx tsx packages/room-mcp/src/index.ts` (or `npm run mcp` at the repo root).

## Tools

| tool | what |
|---|---|
| `room_login` | Log in to the room server; `action=logout` revokes and forgets the account. |
| `room_create` | Open a room for this repo on the server, then join the room for the current branch. |
| `room_join` | Join a room for this clone. where=local: a room on this machine only (no server, no login; the default). where=team: the team server (the user must ask for this: their uncommitted work in this clone becomes visible to the repo's room members); remembered for this clone so later sessions go there on their own. |
| `room_leave` | Leave the room: releases your claims, clears your scope, stops the daemon (and the local workers room, if you opened one). |
| `room_close` | On explicit request, export history, then forget local room memory or close every branch room for the repo on a team server. |
| `room_export` | Export the current room story, including compacted bus history, to a local markdown ledger without changing the room. |
| `room_scope` | Declare what you are working on: a one-word area (e.g. "auth"), a one-line summary, and the paths you expect to touch. |
| `room_state` | Sharing boundary, participants and overlapping work; `path` shows ownership and `link=true` adds the browser URL. |
| `room_read` | A live file with claims and history; `diff=true` compares with the base, and omitting `path` returns all diffs. |
| `room_impact` | Dependency graph query. symbol: who defines it and which files use it, with who owns those files (scope, claims, uncommitted changes). path: what the file depends on (symbols defined elsewhere) and what depends on it. |
| `room_preview_merge` | Would your uncommitted changes and other people's combine cleanly? A lead can preview all its workers at once. |
| `room_claim` | Claim what you are about to edit, saying what you will do: either a symbol (function/class name; the room resolves its line range) or a line range. |
| `room_release` | Release a claim with a summary of what you did. |
| `room_send` | Post to the bus. changed: paths + summary (+ symbols renamed/changed, which notifies whoever uses them). question: to a person's agent. answer: inReplyTo a question id. note: broadcast fyi. |
| `room_wait` | Block until a claim is released, a question is answered, or an interrupt arrives for you; or until timeout (default 30s, max 120s). |
| `room_done` | Mark your current task finished: releases any claims you still hold, clears your scope, and posts a one-line completion note. |
| `room_spawn` | Dispatch a worker agent into this room to do a task in parallel with you. |
| `room_collect` | Collect finished workers as unstaged edits, copy named artifacts, or discard one worker. |
| `room_pr_note` | Post (or update) ONE comment on a GitHub pull request with the branch's room story: who declared what, claims with plans and whether they were fulfilled, questions and answers, merge previews that passed, in bus order. |
| `room_share` | Change how much of your clone the room sees, live. |

Twenty tools. A reply starts with your inbox only when it holds unread messages. Full descriptions and argument schemas are in `src/tools/*.ts` (one module per concern, assembled by `src/tools/index.ts`); the agent-facing rules are in `src/prompt.ts` and the plugin's `room-etiquette` skill. The maintained user workflow is in the [main guide](../../README.md); this package guide records implementation details rather than duplicating those procedures.

`room_preview_merge` takes `people` (or `person`): a lead can preview all its workers at once, merged in order, and `run` executes a command in the fully combined tree. `room_export` writes the room's story (scopes, claims and plan outcomes, questions and answers, previews, plus the compacted bus archive) to `.room/ledger/<room>-<timestamp>.md`; `room_close` writes the same file before it deletes anything.

## Pull requests

Open pull requests targeting the room's branch count as declared intent. On join and every two minutes the client whose participant name sorts lowest among those present (a cheap leader election over awareness, so four agents do not fight) asks the server for them (`GET /github/prs`, which calls GitHub with the token behind the caller's device-login session and caches the answer for 60s per repo) and mirrors each one into the doc as a synthetic participant: identity `{ name: "pr#<n>", kind: "bot", owner: <author>, label: "PR #<n>" }` with a scope whose area is the PR's most common top-level directory, whose summary is its title and whose paths are its files. PRs never get overlays and are never routed messages; `room_state` lists them under "open pull requests", and `room_state(path)`, `room_impact` and the area ledgers see their paths like anyone else's scope. A closed PR disappears at the next refresh.

The other direction is `room_pr_note` (or `room_done pr_note:true`): the branch's room story is rendered as markdown, in bus order, and posted through `POST /github/pr-note`, which finds the caller's earlier comment by its `<!-- room-ledger -->` marker and edits it, so a PR carries exactly one such comment per person. Neither path posts unless the user requests it. Sessions without a GitHub token (a shared-token or OIDC login) get a 403 and a plain "log in with GitHub" reply; nothing is retried.

## Hosts

Both hosts load this server through the plugin in `plugins/room` (one directory, two
manifests). Install with `claude plugin marketplace add rohanz/room && claude plugin install
room@room` or `codex plugin marketplace add rohanz/room && codex plugin add room@room`; the
bundled server is `plugins/room/server/room-mcp.mjs` (rebuild with `npm run build:plugin`).
The plugin's hooks record the session so it can be woken and put unread inbox lines and
teammate claims in front of the model before every edit, including edits made through the shell.

Wake-ups differ by host. A Claude Code session receives interrupts and questions addressed
to it through the MCP channel (`notifications/claude/channel`, a research-preview feature
that needs an Anthropic login); a Codex thread is woken with `codex queue`, retried with
backoff, using the thread id the SessionStart hook recorded. If neither path is available
the pre-edit hook still shows the message before the next edit. Running the server by hand
(`npm run mcp`) works for scripts and tests; `ROOM_ROOM` and `ROOM_DIR` name the room and
clone.

## Identity

A participant is a principal: `{ name, kind, owner, label }`. `name` is the key everything in the room is filed under (overlays, claims, messages). `kind` is `human`, `agent`, `bot` or `ci`; anything that is not a human behaves like an agent for claims and wake-ups. `owner` is the verified GitHub login responsible for the participant: a person's own login, the runner of an agent, or the account that registered a bot. On a server with GitHub login the owner is always the login you signed in with; the first agent under a login takes the login as its name, and `ROOM_TAG=codex` makes a second one named `login+codex` (`ROOM_KIND` sets bot or ci). The server drops any presence whose owner is not the verified login. Display: `rohanz`, `rohanz+codex`, `deploy [bot]`; participant lists show `rohanz · agent` and `rohanz+codex · agent of rohanz · codex`.

## Sharing levels

By default joining a room publishes the full text of every file you have changed (`full`). The dial has three positions:

| level | what the room sees from you |
|---|---|
| `intent` | presence, scope, claims, plans and bus messages only; no file text at all, not even deletions |
| `declared` | file text only for paths under your `room_scope` paths; everything else is withheld (`room_share` lists it) |
| `full` | every changed file (the default for now) |

**Teams should set `ROOM_SHARE=declared`**: teammates still see what you are on and what you plan to change, and get your text only where you said you would work. Set it with the `ROOM_SHARE` env, the `share` argument of `room_join` / `room_create`, or `room_share(level)` at any time: lowering the level withdraws overlays immediately, raising it republishes what your disk holds, and under `declared` the published set follows your scope as you re-declare it. Your presence carries the level, so `room_state` shows it next to each person.

The server can cap it: `ROOM_SHARE_MAX` (advertised as `shareMax` in `GET /auth/config`). A client asking for more is clamped and told so in the join reply and in `room_share`.

Reading someone who shares less than `full` degrades rather than errors: `room_read` (including `diff=true`) and `room_preview_merge` on an `intent` sharer answer with one line (`X shares intent only; ask them or wait for their push`); paths a `declared` sharer keeps outside their scope come back as `not shared`.

## Areas (folder-scoped rooms)

A room is still one document per branch, but what you see is scoped to the folders you work in.

- **Where areas come from.** If the repo has a `CODEOWNERS` (`.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS` at the room's base commit), every pattern is an area named by its path prefix (`packages/server/`, `docs/`, `/` for `*`-style patterns) with the owners listed there; gitignore-style patterns are supported (`*`, `**`, `?`, trailing `/`, leading `/` anchors, bare names match at any depth) and the longest matching pattern wins. Without CODEOWNERS every top-level directory is an area and `/` holds root files. Parsing lives in `packages/shared/src/areas.ts` (`Areas`, `areaOf`, `areasOf`, `ownersOf`).
- **Membership.** You are in the areas covering your declared scope paths plus your changed paths. `room_scope` stores them on your scope record (`areas`) and in presence; `room_join` and `room_scope` say which areas you are in and who else is in them.
- **Filtering.** `room_state` lists participants, claims, uncommitted changes and bus only for your areas, with one line for the rest (`3 others in 2 other areas (api/, web/)`). Pass `all: true` to see everything; with no scope and no changes yet you see everything. The inbox drops broadcast `notify` messages whose paths (or sender) are outside your areas; addressed messages and interrupts always arrive. `room_state(path)` and `room_impact` provide path-specific views.
- **Ownership hint.** When you declare a scope or claim in an area you do not own per CODEOWNERS, the reply adds `owners of api/: @rohanz, @kieran` so your agent can ask them. Nothing is enforced. Use `room_state(path)` to inspect ownership around a path.

## Local rooms (no server)

When no tool argument, `ROOM_SERVER`, `ROOM_URL`, or remembered choice selects a team server,
a session joins a **local room**. The first session in a clone starts a relay on `127.0.0.1`
on a port derived from the clone's git dir, and records `{port, pid, key}` in
`<git common dir>/room-local.json` (mode 0600). Because the port is fixed per clone, two
sessions that start at the same instant cannot end up in two rooms: one binds it, the
other gets EADDRINUSE and joins. Later sessions in the same clone or any worktree of it
check that a relay (not some other service) answers `/health` on that port and connect,
presenting the key. When the relay's owner exits, a remaining session takes the port over
within about two seconds and the others reconnect. `RoomMemory` saves coordination history
in the Git common directory; live file text, bases, graphs, and claims are rebuilt by connected
clients. The room
is named `local/<repo basename>/<branch of the main worktree>`, so worktrees on other
branches still share it. Identity is `git config user.name` (plus `ROOM_TAG`), there is no
login; bare `room_create` targets the hosted team server (and `room_login` explains that it
needs a server), while `room_close`
forgets local history after explicit confirmation.

`ROOM_SERVER=hosted` selects the hosted server; any `ws://` or `wss://` URL selects another.

The relay also serves the built browser view (shipped with the plugin under `web/`, or
`packages/web/dist` for source runs) at `http://127.0.0.1:<port>/` plus `/health`, and
accepts websocket connections from loopback only, each carrying the relay key. A local
session's `browser view:` link points there and includes the key; it works on this machine
only, and only for someone holding the link.

## Choosing the room

`room_join` takes `where`: `local`, `team` (the hosted server, what `ROOM_SERVER=hosted`
means) or a server URL. Precedence: the `where` argument, then `ROOM_SERVER`, legacy `ROOM_URL`, then the
choice remembered in the clone (`<git common dir>/room-choice.json`, written when a join
was asked for by argument), then local. Joining the team room from a clone that never has
must be an explicit instruction, and the join reply says that uncommitted work in the clone
is now visible to the repo's room members. `room_leave(forget=true)` clears the memory.
`room_state` starts with the sharing boundary and includes the room name in its status. The skills map the phrases: "join the team
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
paths are re-posted into the local room. Plans, conflicts and base moves are interrupts;
the other relayed events are notifications, and pathless base events are not forwarded. Workers'
questions to the lead and their `done` messages stay local; the lead's inbox, `room_wait`
and `room_state` read both rooms. `room_leave`, `room_close` and process exit tear both
down and drop the mirrored claims.

## Workers

`room_spawn(tag, task, host?, model?, share?, dir?)` makes a git worktree at
`<repo>/.room/workers/<tag>` on branch `room/<tag>` from HEAD (or uses `dir`), and starts
`claude -p` or `codex exec` there, detached, with an explicit environment: `ROOM_SERVER`,
`ROOM_ROOM`, `ROOM_DIR`, `ROOM_TAG`, `ROOM_LEAD`, `ROOM_OWNER`, `ROOM_SHARE`, `ROOM_WORKER_ID`
(and `ROOM_TOKEN` when the lead joined a shared-token server). Other parent environment variables
are inherited except for the explicit lead-only Room variables.
Output goes to `.room/workers/<tag>.log`, the worker's MCP log to `.room/workers/<tag>.mcp.log`.
A stale worktree registration for the tag is pruned first. The worker's prompt is a fixed preamble (follow the etiquette,
ask the lead with `room_send`, `room_preview_merge`, then `room_done`) followed by the
task. The doc's `workers` map records tag, name, host, model, task, dir, branch, pid,
status (running, done, failed, dismissed) and summary; the lead's MCP process updates the
status on exit. A worker's `room_done` posts a `done` message addressed to its lead at
notify priority, which wakes the lead. `ROOM_MAX_WORKERS` (default 8) caps running
workers per lead. Room adds `.room/` to Git's private exclude file; no tracked ignore-file change is needed.

## Limitations

Access: a GitHub-named room requires a GitHub device-login session with push access to the repo;
`ROOM_TOKEN` does not admit it. The repo must first be opened with `room_create`.
For non-GitHub rooms, a client presenting the configured `ROOM_TOKEN` is admitted even when
the server has a login provider. A client without a matching token falls through to login
when a provider is configured. With no provider, the token is required when set; with
neither a provider nor a token, non-GitHub rooms are open.
Inside a room everything in the doc is visible to every member (subject to each person's sharing level). Claim ranges are not
remapped as files change. Disk edits are attributed to the machine's human; the agent is visible via claims,
cursor, status and bus messages.

## Automatic notices

Besides tool replies, the MCP process watches the room and posts on your behalf:
- an `interrupt` when your uncommitted edit lands inside someone else's open claim and you hold none there (the holder gets a `notify`);
- a `notify` when a file you changed no longer merges cleanly with a teammate's version (an `fyi` when it does again);
- an `fyi` on join when it evicts uncommitted work of someone absent for more than `ROOM_STALE_DAYS` (default 7).

Merge previews behind the conflict notices run at most four per ten seconds per client, coalescing
further changes, and a pair whose texts have not changed is not re-merged.

While the connection to the server is down, `room_state` starts with the sharing boundary and later
shows an `OFFLINE` line with the last known state; `room_send` and `room_wait` say the message is not delivered rather than pretending.
`room_wait` returns at once when a message that would end it is already unread in the inbox.

## Inbox rules

Message kinds are defined once, in `packages/shared/src/messages.ts`: each has a format, an audience,
a wake rule and a default priority. Routine events (`scope`, `release`, `changed`, `note`) never enter
an inbox unless addressed; `claim` and `conflict` reach the holders of overlapping claims; `question`,
`answer` and `done` reach the person they are addressed to; `plan` broadcasts at interrupt; `base`
wakes anyone with uncommitted work. Interrupts always reach the inbox. `notify` messages from other
areas are dropped by the areas filter. Registering a new kind is one entry in that table.

The bus keeps the last `ROOM_BUS_KEEP` messages (default 2000); older ones are folded into a compact
per-area ledger archive (counts, last seen per person, unfulfilled plans and open questions kept in
full) by the lowest-named present participant, at most once a minute. Ledgers, `room_pr_note` and
`room_export` read the archive too.

Wake-ups: interrupts and questions addressed to you reach an idle Codex thread through `codex queue` (retried with backoff; the thread id comes from the SessionStart hook) and a Claude Code session through the MCP channel notification.

## Workers: what a lead may and may not do

- `room_leave` is refused while workers you spawned are running; `force=true` dismisses
  them first (they are told why). Ending the lead's session dismisses them the same way.
- `room_collect(tag=..., discard=true)` stops and discards one worker. Process identity is
  checked before signalling a worker recovered after a lead restart.
- `room_spawn dir=` outside the repo needs `allowOutside=true`; no worktree or branch
  bookkeeping is done for it.
- Joining the team room on the choice remembered for a clone prints the same one-line
  visibility notice as an explicit join, once per worktree.
- The bridge relays team plans, conflicts and base moves to workers as interrupts; scopes,
  claims and change notices arrive at notify, at most once a minute per worker, path and
  type. When a worker's claim ends, the team gets a release naming any unfulfilled plans.

## Claude Code and the channels flag

Wake-ups reach Claude Code through the MCP channel capability, which is a research preview with an Anthropic-curated allowlist. Room is not on it, so a Claude Code session must be started with `claude --dangerously-load-development-channels plugin:room@room` for wake-ups to arrive; the plugin ships `bin/claude-room` which does exactly that and nothing else. The flag bypasses the allowlist for that one entry; organisation policy still applies. Codex wakes through `codex queue` and needs no flag.
