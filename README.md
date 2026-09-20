# Room — coding agents that coordinate before merge time

**Your coding agent, aware of your teammates’ agents.**

## Status

Room has been tested live with a small team on GitHub-hosted repositories and in solo mode on macOS.
That coverage includes local rooms, Claude Code and Codex workers, and teams using mixed agent hosts.
It has also been soak-tested with 10 scripted participants.
OIDC, the Postgres store, Windows, and large monorepos are designed and unit-tested only.

## What we built

Two developers ask their agents to change the same codebase. One changes the order model;
the other adds coupons to the checkout that consumes it. Their work can break together
even when Git reports no conflicting lines.

Developers already resolve these integration issues through review, communication, and
rework. Room aims to prevent avoidable conflicts and incompatible assumptions before
they become implementation problems, reducing rework and speeding up iteration.

Room is a coordination layer for developers and small teams using coding agents
in parallel on a shared repository. It connects the agents inside their existing Git
clones and Codex sessions. They share
live edits, declare intended contract changes, identify affected teammates, and ask each
other questions before the work is merged. Developers keep their own editors, agents,
and Git workflow.

Built for the **“Agents leaving the chatbox”** hackathon.
[Read the brief and judging criteria](RULES.md).

## Quick start

Short version for people trying it: [docs/onboarding.md](docs/onboarding.md).

Prerequisites: Git, Node.js 24 LTS, and Codex CLI or Claude Code with plugin support.
Python indexing needs Python 3; the Python demo uses `uv`.

Install the plugin once per machine:

```sh
codex plugin marketplace add rohanz/room && codex plugin add room@room      # Codex
claude plugin marketplace add rohanz/room && claude plugin install room@room # Claude Code
```

Trust Room's hooks when prompted (or through `/hooks`). They put teammate claims and your
unread room messages in front of the model before every edit, and record the session so
it can be woken.

Room stays silent while you are alone and starts coordinating when someone joins or you spawn workers.

Then start your agent in any clone:

```sh
cd /path/to/your/repo
codex          # Codex needs nothing extra
claude-room    # = claude --dangerously-load-development-channels plugin:room@room  (see "Why Claude Code needs a flag")
```

That is the whole setup. **With no server configured, the session is in a local room:**
no account, no login, nothing leaves your machine. The first session in a clone starts a
tiny relay next to the clone's `.git`; any other session started in the same clone, or in
a worktree of it, joins the same room. The room is named `local/<repo>/<branch>` after the
main worktree's branch.

Ask **"Show room state"** to see who is in the room. Then ask for your feature as usual.

**"Join the room"** moves the session to the team server for this repo.
"Join the team room", "join the web room", and "join the shared room" also work.
The agent tells you that uncommitted work in this clone is now visible to the repo's room members.
**"Work locally"** brings it back. The choice is remembered per clone, so the next session
in that clone starts where you left it; `room_leave(forget=true)` clears it. An agent never
joins the team room on its own initiative. `ROOM_SERVER` still overrides everything, for
scripts and workers.
When a second agent is tagged automatically (for example, `rohanz+claude`), that tag sticks
to the clone across sessions so an offline overlay cannot be mistaken for another clone's work.

Areas come from `CODEOWNERS` at the room's base commit, not from the working tree. When
there is no matching `CODEOWNERS` area, an uncommitted file makes its top-level directory
an area only for the person who changed that file.

**Sharing levels.** By default the room sees the full text of files you change (`full`).
`ROOM_SHARE=declared` shares text only under the paths you declared in your scope, `intent`
shares plans and claims with no file text; `room_share` changes it live and a server can set
a ceiling. Teams should start at `declared`. Reading someone who shares less degrades to a
one-line answer rather than an error.

**What reaches an agent.** Routine events (scopes, releases, change notes) stay in the feed;
an agent's inbox only gets what is addressed to it, conflicts on its claims, and interrupts,
and `room_state` shows the people and claims near its own work in full with one line for
everyone else. The bus keeps a rolling window and folds older history into a ledger archive.

### Watching a local room

A local session prints a `browser view:` link like a hosted one, served by the relay itself:
`http://127.0.0.1:<port>/?room=…&key=…`. Open it to see the participants, their claims and
the feed. The link is machine-local (the relay only accepts loopback connections) and it
carries the room's key from `.git/room-local.json`, which is what lets the page connect.
Anyone who can run something on this machine and holds the link can read the room; the
key stops other users of a shared machine from guessing their way in.

### Dispatching workers

A session can fan work out to other agents through the room instead of around it:

> Spawn a worker tagged `money` to switch prices to whole cents with a Money type, and one
> tagged `tiers` to add gold/silver discounts on top of it. Wait for both, preview the
> merges, and report.

`room_spawn` creates a git worktree at `.room/workers/<tag>` on branch `room/<tag>`,
starts a Claude Code or Codex agent there (`host` and `model` are arguments), and passes
it the room. The worker joins as `<you>+<tag>`, declares a scope, claims what it edits,
asks the lead questions on the bus, previews its merge, and calls `room_done`, which
wakes the lead with an addressed message. `room_state` lists workers with status, branch,
and their last message; `room_dismiss` stops one. Up to eight run at once
(`ROOM_MAX_WORKERS`). Add `.room/` to `.gitignore`.

Workers of one lead see each other, so two of them touching the same function get the
same claims and conflict notices as two teammates would.

## Team rooms

To work with teammates on other machines, point the plugin at a server:

```sh
ROOM_SERVER=hosted codex          # the hosted server, wss://room-rohanz.fly.dev
ROOM_SERVER=wss://room.example.com claude   # your own (see deploy/self-hosting.md)
```

The first person on a repo opens it once: ask **"Open a room for this repo"** (the agent
calls `room_create`). From then on every branch of that repo has a room, and each session
started in a clone joins the room for its current branch automatically:
`github.com/<owner>/<repo>/<branch>`. Nothing about your clone leaves your machine until
that join happens, and no session joins a repo nobody has opened.

The first time you use a server, the agent runs `room_login`: open the GitHub device
page it prints, enter the code, and approve Room. The server holds the resulting token
(revocable under GitHub → Authorized OAuth Apps); your `gh` token is never sent anywhere.
Your participant name is your GitHub login. To open or join a repo you need push access
to it, so public repos are not open rooms. The browser link `room_state` prints contains a
room-scoped view key valid for 7 days, rather than your GitHub token. Treat that link as
access to the room's shared code and activity.

Everything from the local workflow applies unchanged: the same tools, etiquette, and
workers. A lead's workers join the team room when the lead is in one, unless you ask for
them locally.

**Workers stay local.** Say "spawn the workers locally" (or `room_spawn` with
`where=local`) while you are in the team room: the lead opens a local workers room on
your machine, dispatches into it, and bridges the two. Workers never touch the server. The
team room sees the lead's scope as the union of its workers' paths, sees their claims under
the lead's name (`[tag] intent`), and any team message that touches a worker's files is
relayed to that worker as an interrupt. Questions from workers and their done messages
stay on your machine; `room_state` shows both rooms.

### Claude Code

The same plugin directory installs into Claude Code. Prerequisites are the same, with
Claude Code 2.1 or later in place of Codex:

```sh
claude plugin marketplace add rohanz/room
claude plugin install room@room
```

For a local checkout, `claude plugin marketplace add /path/to/room` instead. Update with
`claude plugin marketplace update room` and reinstall (the bundle is copied at install time,
so a new version on main reaches a session only after a reinstall). `claude plugin validate plugins/room`
checks the manifest.

Claude Code loads the `room_*` tools from the bundled MCP server, the `room-join` and
`room-etiquette` skills, and two hooks: SessionStart records the session id and host next
to the clone, and PreToolUse on Edit, Write, MultiEdit and NotebookEdit puts your unread
inbox and any teammate claims on the file in front of the model before the edit. Trust the
hooks when prompted or through `/hooks`.

Wake-ups differ by host. Codex is woken with `codex queue`. Claude Code receives
interrupts and questions addressed to you through the MCP channel, which is a research
preview: start Claude Code with `claude --dangerously-load-development-channels plugin:room@room` so the
channel registers (a dim "Channels (experimental)" line under the banner confirms it).
Without the flag an idle Claude session does not react until your next message; the
PreToolUse hook still shows the interrupt before your next edit. Channels need an
Anthropic login and are not available on Bedrock, Vertex or Foundry. Codex and Claude Code sessions share a room without any
configuration: the room does not care which agent a teammate runs.

## Why Claude Code needs a flag

`claude-room` is a one-line launcher shipped in the plugin (`plugins/room/bin/claude-room`, or `~/.claude/plugins/cache/room/room/<version>/bin/` once installed). It runs:

```sh
claude --dangerously-load-development-channels plugin:room@room
```

Room wakes an idle Claude Code session (a teammate's question, an interrupt, a worker finishing) by pushing an MCP channel notification. Channels are a Claude Code research preview: only channels on Anthropic's curated allowlist register, and Room is not on it yet. The flag skips the allowlist for this one plugin entry and nothing else; your organisation's channel policy still applies. Without it, an idle Claude session does not react to room messages until you next talk to it. Codex needs no flag: its wake path is `codex queue`. We ship the launcher so nobody has to remember the flag, and we say what it does here, in the launcher itself, in the onboarding page and in the join skill, because a flag with "dangerously" in its name deserves an explanation rather than a wrapper. To use it, add the bin directory to your PATH or define `alias claude-room='claude --dangerously-load-development-channels plugin:room@room'` in your shell profile.

## Why the environment matters

A chat prompt does not contain your teammate’s uncommitted code or their latest change
of plan. Room combines file watching, Git state, declared intent, and symbol references
to give agents that context while they work.

- **Before an edit:** the agent can see who holds the lines and what they intend to change.
- **When a contract changes:** relevant consumers receive the declaration; superseded or
  cancelled plans generate interrupts for affected agents.
- **When an agent is idle:** the plugin can queue an interrupt or addressed question into
  its Codex session, provided the session bridge is available.
- **Before integration:** agents can preview a merge and run checks; developers retain
  control of commits and pushes.

Claims are advisory. Room helps agents coordinate; it does not lock files or guarantee
that their changes are compatible.

## Browser interface

![Room file viewer showing two participants’ changes and the activity timeline](docs/img/room-v2-redesign.png)

*File-view screenshot from an earlier two-agent run: participant changes, possible
conflicts, and the coordination timeline. The current UI also includes the Network tab.*

### Dependency network

Choose a participant to explore three directions:

| View | What it shows |
|---|---|
| **Upstream** | Dependencies of their work, including teammates’ contract changes that reach it. |
| **My edits & plans** | Their modified files and open claims, including plans declared before editing. |
| **Downstream** | Potential consumers of their contract changes: importers of a symbol whose signature they announced or changed. |

A contract change has two sources. An **announced** plan is declared on a claim before the
edit, and reaches consumers immediately. An **observed** change is read from the diff: when
a definition line (a `def`, `class`, `function` or exported `const`) differs from the base
commit, the room treats it like a plan on that symbol and tells anyone whose changed or
claimed files use it. Body-only edits produce nothing. Where both exist for a symbol, the
announcement wins. **Blue** means actual file edits; **purple** means a contract change. A
diagonal blue/purple fill means both. **Red** marks potential contract impact; affected
nodes with edits or plans retain their fill and gain a red outline. Neither source proves
the change is finished; the merged-tree test run is the proof.

Participant colours are assigned in join order from an eight-colour palette and kept for
the life of the room, so people who are in a room together never share a colour.

Hover or keyboard focus gives a preview; click or Enter opens dependencies, owners,
plans, and consumer details. Search, participant selection, compact nodes, zoom, Fit,
and Expand help navigate larger repos. Turn off **Relevant to my work** to explore all
indexed files. **Changed files** opens the merged preview, diff, and file reader alongside
the participant and timeline views.

## Implementation

```text
Developer A’s clone                                  Developer B’s clone
       │ file watcher                                       │ file watcher
       ▼                                                    ▼
  Room MCP + daemon ───── shared Yjs room over WebSocket ── Room MCP + daemon
       ↕                         │                          ↕
  Codex + hooks            Browser view                Codex + hooks
```

1. **Publish local changes.** The push-only daemon watches each clone and publishes its
   file overlays and deletions. An overlay is a participant’s current version of a file
   relative to their Git base. Remote edits never get written into your working tree.
2. **Share coordination state.** One Yjs document holds overlays, per-person bases,
   scopes, line claims, declared plans, messages, and graph snapshots. Area and file
   ledgers give agents the relevant history.
3. **Find relevant consumers.** Each MCP process indexes definitions and references over
   the base plus overlays: Python via AST, JS/TS via regex. It uses the index to route
   relevant plans and changes, answer impact queries, and publish the browser graph.
4. **Deliver context.** Room tool replies surface the agent’s inbox. Pre-edit hooks show
   unread messages and teammate claims. The session bridge queues interrupts and
   addressed questions into Codex; an optional on-duty runner also handles room events.
5. **Integrate with Git.** Merge previews happen in memory or, when tests are requested,
   a temporary workspace. The shared base advances only when the new commit is on the
   remote. Teammates see that their clone is behind and can pull.

The server uses `y-websocket` with GitHub device-login (or OIDC) admission, read-only view
keys, size caps, optional LevelDB or Postgres persistence, and static browser hosting; the same
relay code, in `packages/relay`, runs on loopback for local rooms. Coordination logic runs in
clients: a session registry (`packages/room-mcp/src/registry.ts`) lets one process hold
several rooms, and message routing, views and configuration each live in one place
(`packages/shared/src/messages.ts`, `views.ts`, `packages/room-mcp/src/config.ts`). Yjs
supplies shared state and presence; Git remains the integration mechanism.

### Agent tools

| Tool | Purpose |
|---|---|
| `room_login` / `room_logout` | GitHub device login to a team server (the agent shows you a code); forget it. |
| `room_create` / `room_join` / `room_leave` / `room_close` | Open the repo once on a server; join a room (`where=local`, `team`, or a URL, remembered per clone); leave; close the repo for everyone (destructive, on explicit ask; the story is exported first). |
| `room_export` | Write the room's story, with the compacted bus archive, to `.room/ledger/`. |
| `room_scope` | Declare an area and paths; read that area's history. |
| `room_state` | Who is here and on what, claims, plans, workers, recent bus, filtered to your areas (`all=true` for everything). Starts with `OFFLINE` when the server is unreachable. |
| `room_read` / `room_diff` / `room_who` | A participant's live file or diff; who holds claims in a region. |
| `room_claim` / `room_release` | Declare line ownership and plans; release with a summary. |
| `room_send` / `room_wait` | Announce changes, ask, answer, note; wait for a release, an answer, an interrupt, or a worker's done message. |
| `room_impact` | Symbol providers, consumers, dependencies, and owners. |
| `room_preview_merge` | Three-way merge with one or several people's live trees, in order; optionally run the tests in the combined tree. The room also tells you when a file you changed stops merging cleanly with a teammate's. |
| `room_done` / `room_pr_note` | Finish a task (release, clear scope, tell the lead if you are a worker; `pr_note: true` posts the branch ledger on its PR); post or update the one room comment on a PR. |
| `room_spawn` / `room_dismiss` | Dispatch a Claude Code or Codex worker into a worktree, in this room or a local workers room; stop one. |
| `room_share` | Change your sharing level live: `intent`, `declared`, `full`. |

**Pull requests are intent too.** Open PRs targeting the room’s branch are mirrored into the room as `pr#<n>` bot participants owned by their author, with a scope built from the files they touch, so a claim or a symbol change that lands on a file an open PR is rewriting is flagged the same way a teammate’s declared work is. The server fetches them with the GitHub token it holds from device login (`GET /github/prs`, cached a minute); one elected client keeps the mirror fresh every two minutes. In the other direction `room_pr_note` writes the branch’s coordination story onto its PR as a single comment that is edited in place, so reviewers see who declared what, which plans were fulfilled or cancelled, what was asked and answered, and which merge previews passed.

## Limitations and failure handling

- **Potential impact is not verified breakage.** Symbol references are inferred, not a
  fully resolved import or call graph. Runtime behavior and compatibility need tests.
- **The graph is a projection.** An index prefers its participant’s overlay, then another
  participant’s overlay, then the base. It does not represent every separate version at
  once. The browser renders at most 250 files and asks you to narrow larger views.
- **Claims depend on agent cooperation.** Overlaps raise interrupts; they do not prevent
  writes. Cancelled plans and releases update coordination state, not source code.
- **Git and connection failures are visible.** Behind clones are identified; unavailable
  bases or divergence at join require fetching or reconciliation. Connection attempts
  time out, offline claims become stale, and graph snapshots expose age and status.
- **Room shares code with the room.** Overlays and coordination history travel to the
  server. Local sample rooms have no persistence unless configured.

## Areas for improvement

**Graph efficiency and accuracy.** Build on the existing symbol index with algorithms
and data structures that reduce repeated work as a repository grows. Forward and reverse
adjacency indexes can support targeted upstream and downstream traversal; incremental
edge updates and cached reachability results can avoid recomputing unaffected paths.
Strongly connected components can group dependency cycles, while module-level aggregation
and rendering only visible nodes can keep the browser responsive on larger graphs.
Language-aware symbol resolution would also reduce false connections from matching names.
These changes should be measured against indexing time, update latency, memory use, and
impact-query accuracy.

**Contract declarations and landed changes.** Make the relationship between an agent’s
intent and the code that actually lands more explicit. Declarations should describe the
old and proposed contract, identify affected symbols, and retain a clear history when a
plan is revised or cancelled. Link those declarations to file revisions and pushed
commits so Room can distinguish a proposed change from an implemented one. Consumer tests
can then provide evidence of compatibility instead of treating an edit or released claim
as proof that the contract is satisfied.

**Incoming data and coordination handling.** Handle arriving edits, declarations, and Git
base updates as a consistent sequence of revisions. Preserve each participant’s version,
reconcile updates against the correct base, and invalidate stale graph results when their
source data changes. Deduplication, batching, and explicit handling of out-of-order updates
would help keep the displayed state and agent context consistent. Recovery should cover
reconnects, abandoned claims, cancelled work, and simultaneous changes to the same file,
with a clear distinction between current activity and retained history.

These are proposed improvements to the prototype, not claims of capabilities already
implemented.

## Local development and verification

```sh
git clone https://github.com/rohanz/room.git
cd room
npm ci
npm run build
npm run build:plugin
```

Start the server and Vite in separate terminals:

```sh
# Terminal 1 — local sample server; state resets when this process stops
HOST=127.0.0.1 PORT=1234 npm run server

# Terminal 2 — browser development server
npm run web
```

To connect Codex to this server, launch it from the target clone with
`ROOM_SERVER=ws://localhost:1234 ROOM_WEB=http://localhost:5173 codex`.
GitHub-named rooms are entered only through GitHub device login (`GITHUB_CLIENT_ID` on the
server, `room_login` on the client); a `gh` token is never forwarded and would be refused. For
local development set `GITHUB_CLIENT_ID=fake`: the server mints a session for any `fakeLogin`
posted to `/auth/poll` (refused under `NODE_ENV=production`; `scripts/demo.sh` uses it). A repo
must be opened once (`room_create`, or `POST /rooms`) before its branch rooms accept
connections. For non-GitHub repos (`local/...`, `git/...`) a shared secret works instead: set
`ROOM_TOKEN` on the server and provide the matching token in the client’s `ROOM_SERVER` URL;
it never admits a `github.com/...` room. Set `YPERSISTENCE` to a directory to retain room
state across server restarts.

The [Dockerfile](Dockerfile) packages the server with a prebuilt browser view (run
`npm run build -w @room/web` first);
[Fly configuration](deploy/fly.toml) describes the hosted deployment and [deploy/DEPLOYING.md](deploy/DEPLOYING.md) is the operations runbook.
To run your own server with GitHub or company (OIDC) login, an audit log and optional
Postgres, follow [deploy/self-hosting.md](deploy/self-hosting.md) (Docker Compose in
`deploy/docker-compose.yml`).
[The MCP README](packages/room-mcp/README.md) covers additional client integration.

### Explore a larger sample

With the local server and browser running:

```sh
npm run seed:scale -w @room/web -- --dir /tmp/atlas-commerce-sample --server ws://localhost:1234 --web http://localhost:5173
```

Use a destination that does not exist. This creates a Git repo with **168 TypeScript
files and 319 inferred dependency edges** across 16 commerce domains, platform modules,
and storefront/admin apps. Four sample participants have 12 modified files: eight
edit-only files and four with both edits and declared contract plans.

The actual indexer builds the graph. Participant activity is synthetic and labeled
`SAMPLE`; the functions are dependency fixtures, not a working commerce application.
The script prints a browser link and stays running so edits in the generated repo update
Kieran’s overlay. Each run gets a unique room unless you supply `--room`. Ctrl-C stops
the publisher and leaves the generated repo intact.

### Checks and repository layout

```sh
npm test
npm run typecheck
npm run build
npm run build:plugin  # regenerate after MCP or daemon changes
```

| Directory | Responsibility |
|---|---|
| `packages/shared` | Room schema, ledgers, symbol graph, and message-routing rules. |
| `packages/server` | WebSocket sync, login and admission, persistence, audit, and browser hosting. |
| `packages/relay` | The loopback relay behind local rooms: discovery file, key, health, browser view. |
| `packages/roomd` | File watching, overlay publication, and Git-base tracking. |
| `packages/room-mcp` | Agent tools (`src/tools/*`), session registry, config, workers, bridge, indexing, hook bridge. |
| `packages/agent` | Optional on-duty Codex runner. |
| `packages/web` | Network, file/merge views, participants, and timeline. |
| `plugins/room` | Installable Codex and Claude Code plugin: hooks, skills, bundled MCP server and browser view. |
| `examples/demo-repo` | Small Python demo service. |

[Original v2 design (historical)](docs/superpowers/specs/2026-09-12-room-v2-design.md) · [Changelog](CHANGELOG.md) ·
[Decisions and build history](docs/decisions.md) · [Prior art](docs/prior-art.md)

## License

Room is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use,
modify, fork and share it for any noncommercial purpose, which includes personal use and
research. Using it at work is not something we intend to pursue. Selling Room, or running it
as a paid service, is not permitted without a commercial licence: open an issue or write to
the author.
