# Room — design spec

Working name: **room**. A shared live workspace where two people and their own coding
agents edit one repo, and the agents can see the humans, each other, and what everyone
intends, so nobody steps on anyone.

Status: approved verbally by Rohan 2026-09-09 ("scaffold a working version").
Build timing cleared with organiser. Target: demoable end to end with two laptops.

## 1. Goals and non-goals

Goals (day-one, in priority order):
1. Two machines, two clones of one repo, one room. Edits on either disk appear on the other
   within ~1s, via a CRDT on a small server. Works with any editor on disk.
2. Each person's own Claude Code joins the room through one MCP server, gains room tools,
   and is woken by room events through a Claude Code **channel** (no polling).
3. Claims: region-level (file + line range + intent), made by humans or agents, visible in
   the browser editor gutter, advisory (warn, don't block).
4. Agent bus: five structured message types. All visible in the browser feed.
5. Browser editor: CodeMirror 6 on the same Yjs docs, coloured cursors, claim gutters,
   presence list, feed. Humans can also edit from here.
6. Git stays normal: one branch per room, commit from your own clone, room broadcasts the
   base commit; daemons refuse to join on a different base.

Non-goals (day one): task board, agent review mode, replay, voice, >2 participants beyond
"should not break", browser-only participants without a clone, server-side agents, auth,
persistence across server restarts, binary files, non-git-tracked files.

## 2. Topology

```
 Rohan's laptop                      room server (Node)            Kieran's laptop
 ┌────────────────────────┐          ┌──────────────────┐         ┌────────────────────────┐
 │ repo clone (disk)      │◄──sync──►│ Y.Doc per room:  │◄──sync──►│ repo clone (disk)      │
 │ roomd (daemon)         │   ws     │  files: Map<path,│   ws    │ roomd (daemon)         │
 │ room-mcp (MCP+channel) │◄──ws────►│   Y.Text>        │◄──ws───►│ room-mcp (MCP+channel) │
 │ Claude Code            │          │  claims: Map     │         │ Claude Code            │
 │ browser tab (optional) │◄──ws────►│  bus: Array      │◄──ws───►│ browser tab (optional) │
 └────────────────────────┘          │  meta: Map       │         └────────────────────────┘
                                     │ + awareness      │
                                     └──────────────────┘
```

Single Y.Doc per room (not per file). Sub-documents are overkill for day one; one doc with
a `files` Y.Map of Y.Text keeps sync trivial and lets the browser open any file instantly.
All three local processes (daemon, MCP, browser) are ordinary y-websocket clients of the
same room doc. The server is `y-websocket`'s stock server plus nothing. **All coordination
state lives in the Y.Doc itself**, so the server has zero custom logic and every client
sees the same thing. Awareness (y-protocols) carries cursors and presence.

## 3. Shared document schema

```
doc.getMap('files')   : Map<relpath, Y.Text>            live text of every synced file
doc.getMap('claims')  : Map<claimId, Claim>             Claim = { id, path, from, to, by, byKind, intent, at }
doc.getArray('bus')   : Array<Msg>                      append-only; Msg = { id, type, from, fromKind, to?, at, ...body }
doc.getMap('meta')    : { repo, branch, base, createdAt, seededBy }
awareness state       : { user: {name, color, kind: 'human'|'agent'}, cursor?: {path, from, to}, status?: string }
```

Identity: `{ name, kind }`. Kieran's agent is `{name:'Kieran', kind:'agent'}` and shows as
"Kieran's agent". Colour is derived from name hash so all clients agree.

Msg types and bodies:
- `claim`     { path, from, to, intent }         (also written to claims map)
- `release`   { claimId, summary? }              (also removes from claims map)
- `changed`   { paths: string[], summary, symbols?: string[] }
- `question`  { to, text }
- `answer`    { to, inReplyTo, text }
- `conflict`  { claimId, otherClaimId, text }    emitted automatically by the MCP server when a claim overlaps
- `note`      { text }                           free text for humans from the browser (not for agents)

Line ranges are 1-based inclusive. Claims are advisory. Overlap = same path and ranges
intersect. Ranges are not remapped as the file changes on day one; claims are short-lived
and re-issued. (Relative positions via Y.RelativePosition are the day-two fix.)

## 4. Sync daemon `roomd`

Node/TS CLI: `roomd --room <url> --dir <clone> --name Rohan`.

Startup:
1. `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD` → branch, base.
2. Connect to room doc; wait for initial sync.
3. If `meta.base` is empty: **seed**. Write every `git ls-files` text file under the size
   cap (512 KB) into `files`, set `meta`. Mark seeded.
4. Else: require `meta.base === local HEAD` and same branch; otherwise exit 2 with a clear
   message ("room is at d4e5f6 on room/feature, you are at a1b2c3 — git checkout / pull").
   Then **adopt**: for every path in `files`, write room content to disk if it differs.
   Local tracked files not in the room are added to the room.
5. Start watcher.

Steady state:
- Disk → room: chokidar on the dir, filtered by git-tracked set (refresh set on
  `.gitignore`/index change and every 10s). On change: read file, if content hash equals
  the last hash we wrote for that path, skip (echo suppression). Else compute minimal diff
  (fast-diff) against the Y.Text and apply as insert/delete ops inside one transaction with
  origin = daemon. Character diff, not replace-all, so remote cursors and other edits are
  preserved.
- Room → disk: observeDeep on `files`. On change where transaction origin is not this
  daemon: write file atomically (tmp + rename), record its hash as "last written".
- Paths: forward-slash relative. Deletions: day one, a file removed from disk is removed
  from `files`; a file removed from `files` is deleted on disk. Renames = delete + add.
- Base tracking: poll `git rev-parse HEAD` every 2s. If it changes locally and working
  tree equals room, publish `meta.base`. If `meta.base` changes remotely and we are behind,
  attempt `git merge --ff-only <base>` if the object exists locally (after `git fetch`),
  else log a warning and keep syncing text. Day-one acceptable: the demo commits from one
  machine and the other just sees the base update.

Reliability rules: never crash on a single file error; log and continue. Debounce disk
events 50ms. Ignore files > cap and non-UTF-8 files (skip with a warning).

## 5. MCP server + channel `room-mcp`

Node/TS, stdio. Registered in the repo's `.mcp.json`; launched by Claude Code with
`claude --dangerously-load-development-channels server:room`. Env: `ROOM_URL`, `ROOM_NAME`,
`ROOM_DIR` (defaults from a `.room.json` written by `roomd` in the clone root so the user
configures once).

Capabilities: `experimental['claude/channel']: {}`, `tools: {}`. `instructions` tells
Claude: you are `<name>'s agent` in a shared room; before editing, call `room_state` and
respect claims and live cursors; claim before writing; announce `changed`; events arrive as
`<channel source="room" type=... from=...>`; respond with the tools, never ignore a
`question` addressed to you; when a `conflict` arrives, stop and ask your human.

Tools (all return concise text; JSON where structured):
- `room_state()` → participants (name, kind, status, cursor), open claims, `meta`, last 10
  bus messages. The one call every turn should start with.
- `room_read_live(path)` → current room text with line numbers; also notes any claims and
  cursors in that file.
- `room_read_committed(path)` → `git show HEAD:path`.
- `room_diff(path?)` → unified diff committed → live, for one path or all changed paths.
- `room_who(path, from?, to?)` → who is active or has claims overlapping that region.
- `room_claim(path, from, to, intent)` → creates claim; if overlapping claim exists,
  still creates it but returns the overlap and emits `conflict` on the bus. Returns claimId.
- `room_release(claimId, summary?)`.
- `room_send(type, to?, text, paths?, inReplyTo?)` → `changed | question | answer`.
- `room_wait(seconds)` → no-op sleep, for "wait for the human to move on" (max 30s).

Agents **do not** get a write tool. They edit files on disk with their normal tools; `roomd`
carries it into the room under the agent's identity? — No: the daemon cannot tell human
from agent edits on the same disk. Day-one rule: disk edits are attributed to the human
owner of the machine; the agent's activity is visible through its claims, cursor, and bus
messages, and its `status` in awareness ("editing handlers.py 13–15"). `room-mcp` sets the
agent's awareness cursor to its active claim. Good enough for the demo, and honest.

Channel push: `room-mcp` observes `bus` and `claims`. It pushes a `notifications/claude/channel`
for: any bus message not from this agent where `to` is this agent or `to` is empty and
type ∈ {claim, release, changed, conflict, question}; any new claim overlapping this agent's
open claims; a human cursor entering this agent's claimed region (debounced 3s, once per
claim). `meta` attrs: `type`, `from`, `from_kind`, `path`, `msg_id`. Content: one-line
human-readable summary plus JSON body.

Sender gating: only messages from the room doc are forwarded; the room has no auth, which
is acceptable for a LAN/ngrok demo. Documented as a limitation.

## 6. Browser editor `web`

Vite + TypeScript, no framework. Connects to the room doc with `y-websocket` and awareness.
- Left: file tree from `files` keys. Click opens a CodeMirror 6 editor bound with
  `y-codemirror.next` (remote cursors/selections built in).
- Gutter + line background for claims in owner colour, with a hover label "Rohan's agent ·
  refactoring validation". Claim from the editor: select lines → "Claim" button → intent
  prompt (inline input, no `window.prompt`).
- Right: participants (colour dot, name, kind, status), open claims, feed (bus, newest at
  bottom, type badge, coloured sender). Humans can post a `note`.
- Top: room meta (repo, branch, base short sha), your name (from `?name=` or a stored
  value), connection status.
- Edits made in the browser flow to both disks via the daemons. Warn (toast) when your
  cursor enters someone else's claim.

## 7. Server

`server/`: y-websocket server (`y-websocket` 3.x `bin/server` equivalent in a tiny script)
on `PORT` (default 1234). Room name is the URL path. No persistence. One extra HTTP route
`GET /health`. Deployable anywhere Node runs; for the demo either LAN IP or a tunnel.

## 8. Repo layout (monorepo, npm workspaces)

```
packages/shared/    schema types, identity/colour, claim overlap, msg helpers, doc accessors
packages/server/    y-websocket server
packages/roomd/     sync daemon CLI
packages/room-mcp/  MCP server + channel
packages/web/       Vite app
examples/demo-repo/ tiny Python project for the demo (create_order handler + tests)
.mcp.json           registers room-mcp for this repo (used when demoing on this repo itself)
docs/               specs, plans, decisions, prior-art, submission
```

TypeScript throughout (Yjs is JS-native; a Python MCP would need a second CRDT runtime).
Vitest for tests. `tsx` to run. Node 22. Python via uv only in `examples/demo-repo`.

## 9. Error handling

- Daemon join on wrong base: exit with instructions. Server unreachable: retry with backoff,
  keep local edits queued (Yjs handles offline merge).
- Non-UTF-8 or oversize file: skipped with a single warning, listed in `roomd` status.
- Claim ranges past EOF: clamped. Unknown path in tools: clear error text, no throw.
- MCP tool failures return text errors, never exceptions, so Claude can recover.
- Channel dropped (session not launched with the flag): tools still work; `room_state`
  shows unread messages so polling is a fallback. Instructions tell Claude to call
  `room_state` at the start of each task regardless.
- Browser disconnect: status pill goes red, editor becomes read-only until reconnected.

## 10. Testing

- `shared`: unit tests for overlap, colour, bus helpers.
- `roomd`: integration test — two daemons, two temp git repos, one in-process server;
  write on A, assert on B; edit both concurrently, assert convergence; echo test (no
  ping-pong); base mismatch refusal.
- `room-mcp`: unit tests for tool handlers against an in-memory doc; channel push
  filtering (own messages not pushed; addressed questions pushed).
- `web`: smoke via Playwright optional; manual for day one.
- End-to-end script `scripts/demo.sh`: starts server, seeds demo repo into two temp clones,
  two daemons, prints the `claude` launch command for each side.

## 11. Demo path (what must work reliably)

1. Start server. Rohan `roomd` seeds from `examples/demo-repo`. Kieran clones, `roomd` joins.
2. Both open the browser, see each other's cursors.
3. Rohan asks his Claude Code: "refactor validation in create_order into a helper".
   Agent calls `room_state`, claims 13–15 with intent, edits, sends `changed`.
4. Kieran's Claude Code receives the channel event, was asked "add an email notification
   after save", sees the claim, sends a `question`, gets `answer`, edits line 18, updates
   the test to the renamed helper, `release`s.
5. Rohan hits commit; Kieran's daemon sees the base update.
Failure demo: Kieran claims the same lines → `conflict` lands in both sessions, both
agents stop and ask their humans.
