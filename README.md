# Room — coding agents that coordinate before merge time

**Your coding agent, aware of your teammates’ agents.**

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

Then start your agent in any clone:

```sh
cd /path/to/your/repo
codex        # or: claude
```

That is the whole setup. **With no server configured, the session is in a local room:**
no account, no login, nothing leaves your machine. The first session in a clone starts a
tiny relay next to the clone's `.git`; any other session started in the same clone, or in
a worktree of it, joins the same room. The room is named `local/<repo>/<branch>` after the
main worktree's branch.

Ask **"Show room state"** to see who is in the room. Then ask for your feature as usual.

Where you work is a matter of instruction. **"Join the team room"** (or the web room, the
shared room) moves the session to the team server for this repo, and the agent tells you
in one line that uncommitted work in this clone is now visible to the repo's room members.
**"Work locally"** brings it back. The choice is remembered per clone, so the next session
in that clone starts where you left it; `room_leave(forget=true)` clears it. An agent never
joins the team room on its own initiative. `ROOM_SERVER` still overrides everything, for
scripts and workers.

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
`claude plugin marketplace update room` and reinstall. `claude plugin validate plugins/room`
checks the manifest.

Claude Code loads the `room_*` tools from the bundled MCP server, the `room-join` and
`room-etiquette` skills, and two hooks: SessionStart records the session id and host next
to the clone, and PreToolUse on Edit, Write, MultiEdit and NotebookEdit puts your unread
inbox and any teammate claims on the file in front of the model before the edit. Trust the
hooks when prompted or through `/hooks`.

Wake-ups differ by host. Codex is woken with `codex queue`; Claude Code receives
interrupts and questions addressed to you through the MCP channel while the session is
live, so nothing is queued. Channels are a Claude Code research preview: they need an
Anthropic login (claude.ai or Console key) and are not available on Bedrock, Vertex or
Foundry; without them the PreToolUse hook still shows the interrupt before your next edit. Codex and Claude Code sessions share a room without any
configuration: the room does not care which agent a teammate runs.

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
| **Upstream** | Dependencies of their work, including relevant teammates’ contract plans. |
| **My edits & plans** | Their modified files and open claims, including plans declared before editing. |
| **Downstream** | Potential consumers of their own declared contract changes. Ordinary edits alone do not imply breakage. |

**Blue** means actual file edits; **purple** means a declared contract plan. A diagonal
blue/purple fill means both. **Red** marks potential contract impact; affected nodes with
edits or plans retain their fill and gain a red outline. Labels remain white on changed
nodes. Declaring a plan does not prove it has been implemented.

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

The server uses `y-websocket` with GitHub/shared-token access control, view-key issuance,
optional LevelDB persistence, and static browser hosting. Coordination logic runs in
clients. Yjs supplies shared state and presence; Git remains the integration mechanism.

### Agent tools

| Tool | Purpose |
|---|---|
| `room_create` / `room_join` / `room_leave` | Open the repo once, join the branch room, leave. |
| `room_close` | Close the repo for everyone: all branch rooms and server-side overlays are deleted. Only on the user's explicit ask. |
| `room_scope` | Declare an area and paths; read that area’s history. |
| `room_state` | Inspect participants, work, claims, plans, and current coordination state. |
| `room_read` / `room_diff` | Inspect a participant’s current file version or changes. |
| `room_claim` / `room_release` | Declare line ownership and plans; release work with a summary. |
| `room_send` | Announce changes, ask questions, answer, or leave notes. |
| `room_wait` | Wait for release, an answer, or an interrupt, with a timeout. |
| `room_done` | Release remaining claims, clear scope, and mark the task finished while staying available for questions; `pr_note: true` also posts the branch ledger on its PR. |
| `room_pr_note` | Post or update the one room comment on a GitHub PR with the branch’s story: scopes, claims and plan outcomes, questions and answers, passing merge previews. |
| `room_impact` | Find symbol providers, consumers, dependencies, and owners. |
| `room_preview_merge` | Preview the combined changes; optionally run checks. The room also runs it for you whenever two people change the same file and notifies you if the result conflicts. |

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
[Fly configuration](deploy/fly.toml) describes the hosted deployment.
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
| `packages/server` | WebSocket sync, access control, persistence, and browser hosting. |
| `packages/roomd` | File watching, overlay publication, and Git-base tracking. |
| `packages/room-mcp` | Agent tools, indexing, sessions, and hook bridge. |
| `packages/agent` | Optional on-duty Codex runner. |
| `packages/web` | Network, file/merge views, participants, and timeline. |
| `plugins/room` | Installable Codex plugin, hooks, skills, and bundled MCP server. |
| `examples/demo-repo` | Small Python demo service. |

[Design](docs/superpowers/specs/2026-09-12-room-v2-design.md) ·
[Decisions and build history](docs/decisions.md) · [Prior art](docs/prior-art.md)
