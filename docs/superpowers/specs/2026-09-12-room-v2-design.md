# Room v2 — design spec

Supersedes the sync and interaction parts of `2026-09-09-room-design.md`. Schema, server,
claims and bus concepts carry over; what changes is who writes to disk (nobody but the
owner), how an agent joins (one step), and how agents coordinate (intent first, with
priorities).

Status: approved by Rohan 2026-09-12 after design discussion. Focus: usability and
real-life use, not demo tricks.

## 1. What changed and why

| v1 | v2 | Why |
|---|---|---|
| Room text is one merged Y.Text per file; daemon writes teammates' edits to your disk | Room holds one live **overlay per person**; nothing is ever written to your disk by the room | Disk sync was the riskiest code and broke tests with half-done teammate edits. The product is coordination, not sync. |
| Join = run daemon with URL, dir, name; then run agent | `$room-join` inside normal Codex; room derived from git remote + branch; daemon started in-process | One step, no names typed three times. |
| Agent is woken by every relevant event (runner) or never (plugin) | Plugin is primary. Every tool response carries the inbox; `room_wait` blocks on a claim or answer. Runner stays as optional "on duty" mode | Agents see what matters on their next move without a second process. |
| Claims only | **Scope** declared up front, then claims as you edit | Others know what you're on before you touch anything. |
| Every bus message equal | Three priorities: `fyi`, `notify`, `interrupt`; room upgrades a change that lands in someone's scope | Small edits wake nobody; a rename reaches whoever uses it. |
| Browser is an editor with chat | Browser is a read-only room view | Humans work in their own editor; the view is for watching agents. |

## 2. Topology

```
 Rohan's laptop                          room server                Kieran's laptop
 clone ──push only──► overlay:Rohan ◄─── one Y.Doc ───► overlay:Kieran ◄──push only── clone
 Codex + room plugin (MCP + daemon)    claims, scopes, bus,       Codex + room plugin
 browser view (optional)               meta, presence             browser view (optional)
```

Server is still stock y-websocket with no logic. All state in one Y.Doc.

## 3. Shared document schema

```
doc.getMap('meta')            { repo, branch, base, createdAt }
doc.getMap('overlays')        Map<person, Y.Map<relpath, Y.Text>>   each person's live uncommitted files
doc.getMap('deleted')         Map<person, Y.Map<relpath, true>>     files a person deleted locally
doc.getMap('scopes')          Map<person, Scope>                    Scope = { by, byKind, summary, paths: string[], at }
doc.getMap('claims')          Map<claimId, Claim>                   Claim = { id, path, from, to, by, byKind, intent, at, anchor }
doc.getArray('bus')           Array<Msg>                            Msg gains `priority: 'fyi'|'notify'|'interrupt'`
doc.getArray('chat:<name>')   Array<ChatItem>                       runner mode only
awareness                     { user: {name, kind, color}, status, lastActive }
```

- `overlays.<person>` contains only files that differ from `meta.base`. A file absent from
  every overlay is unchanged from HEAD. Overlay text is the full file.
- `claims[].anchor` is a Yjs relative position into the owner's overlay text so line ranges
  follow edits above them. `from`/`to` are recomputed on read.
- `repo` is the normalised origin (`host/owner/repo`). Room name = `<repo>/<branch>`.

## 4. Daemon (in `roomd`, embedded by the MCP server)

- Watches the clone (chokidar, tracked + untracked-non-ignored, same ignore rules as v1).
- On change: if file text equals `git show base:path`, remove it from my overlay; else set
  my overlay text (minimal diff applied to the Y.Text so anchors survive).
- Deletions go to `deleted.<me>`. Renames appear as delete + add.
- **Never writes to disk.** No adopt, no pull, no merge. `merge.ts` and the pull path are
  deleted.
- Join check: `git rev-parse HEAD` must equal `meta.base` if the room already has one;
  otherwise this clone sets it. Mismatch is a refusal with the two SHAs and "pull first".
  Dirty tree is fine (it becomes your overlay).
- Presence: `lastActive` bumps on every overlay write and tool call.

## 5. Room derivation and join

`room_join({ server?, name?, room? })`:
1. `name` defaults to `git config user.name`, then `$USER`.
2. `room` defaults to `<normalised origin>/<branch>`. No origin: error asking for `room`.
3. `server` defaults to `ROOM_SERVER` env, then the plugin's default server URL. Documented
   as demo-grade (in-memory, unauthenticated).
4. Starts the daemon in-process, waits for sync (timeout 15s), writes `.room.json`
   (gitignored by the daemon adding it to `.git/info/exclude`).
5. Returns: room name, base SHA, participants with scopes, open claims, browser URL.

`room_leave()` releases my claims, clears my scope, stops the daemon. Also runs on MCP
server exit.

The plugin ships a `room-join` skill so `$room-join` in Codex calls `room_join` and then
prompts the user for a scope if they gave a task.

## 6. Tools (MCP, `room_*`)

Every tool response is prefixed with the caller's **inbox**: unread bus messages addressed
to them or upgraded to them, highest priority first, then marked read (per-agent read
cursor kept in the MCP process). Format: `[inbox 2] interrupt from Kieran: ...`.

| Tool | Does |
|---|---|
| `room_join`, `room_leave` | §5 |
| `room_scope(summary, paths[])` | Declare or replace my scope. Posts `scope` on the bus at `notify`. |
| `room_state()` | Meta, participants (scope, status, lastActive), open claims, files changed per person, last 10 bus. |
| `room_read(path, person?)` | Live text of `path` as `person` sees it (default: merged view of HEAD + my overlay). With line numbers and claims. |
| `room_diff(path?, person?)` | Diff from base to a person's overlay. |
| `room_who(path, from, to)` | Claims and scopes touching a region, plus who changed the file. |
| `room_claim(path, from, to, intent)` | Claim; returns overlaps. Overlap with another party posts `conflict` at `interrupt`. |
| `room_release(claimId, summary?)` | Release; posts `release` at `fyi`. |
| `room_send(type, to?, text, priority?, paths?, symbols?)` | `changed` (default `notify` if `symbols` given else `fyi`), `question` (`notify`), `answer` (`notify`), `note` (`fyi`). |
| `room_wait({ claimId? , questionId?, timeoutMs? })` | Blocks until that claim is released, that question answered, any `interrupt` for me arrives, or timeout (max 120s). Returns which. |
| `room_preview_merge(person)` | Three-way merge of my overlay and theirs against base, in memory. Reports clean paths, conflicting paths with hunks. Uses a diff3 library. |

Readiness: tools return "room not synced yet, retry" before first sync (kept from v1).

**Scope upgrade rule** (in the MCP process of the *sender*): after a `changed` is posted,
for each other participant whose scope paths include any changed path, or whose overlay
files reference any changed symbol (plain-text search of the symbol name), post a copy of
the message addressed to them at `notify`. Never above `notify` automatically.

## 7. Etiquette (skill text, applies to Codex plugin and runner preamble)

1. After join, declare a scope before editing: one line and the paths you expect to touch.
2. Read the inbox at the top of every tool response. `interrupt`: re-plan before continuing.
   `notify`: check whether it touches what you're doing. `fyi`: nothing.
3. Claim before editing, small and short-lived, release with a summary.
4. Don't edit inside another party's claim. `room_wait` on it or ask with a `question`.
5. Announce renames and signature changes as `changed` with `symbols`.
6. Answer questions addressed to you on your next move.
7. If a question gets no answer in the wait, say so to your human and proceed only where
   you don't depend on it.
8. Before telling your human you're done, `room_preview_merge` against anyone who changed
   the same files and report the result.
9. Edit on disk with normal tools. Nothing you do in the room changes your disk.

## 8. Runner (`roomagent`, optional)

Keeps v1 behaviour (events as turns, preemption on `interrupt`, `/stop`, `/resume`) but:
- wakes only on `interrupt`, and on `notify` addressed to me; never on `fyi`.
- mirrors the transcript to the terminal as well as `chat:<name>`.
Repositioned in docs as "leave your agent on duty".

## 9. Browser view (`web`)

Read-only. Left: participants with scope, status, lastActive. Centre: file list showing who
changed each file; selecting a file shows the chosen person's overlay with claim gutters
(colour per party). Right: the feed with priority badges. No editing, no chat panel, no
cursors. URL: `/?room=<ws>/<repo>/<branch>`.

## 10. Failure handling (all visible to the user)

- Join on wrong base: refusal with both SHAs and "git pull, then $room-join".
- Server unreachable: join fails within 15s with the URL tried.
- Tool before sync: "not synced yet, retry".
- Claim overlap: conflict at `interrupt`, both parties told, neither edit is blocked.
- Unanswered question: `room_wait` returns `timeout`; etiquette rule 7.
- Daemon dies: presence goes offline within the awareness timeout; claims older than 10 min
  from an offline party are shown as stale and can be released by anyone.
- Codex turn timeout and git timeouts kept from v1.

## 11. Testing

- shared: overlay accessors, anchor recomputation, priority defaults, scope-upgrade matching.
- roomd: disk change → overlay set/clear/delete; base check; never writes to disk (assert
  clone bytes unchanged after remote overlay changes).
- room-mcp: inbox prefix and read cursor; `room_wait` resolves on release, answer,
  interrupt, timeout; `room_preview_merge` clean and conflicting; join derivation from
  fixture repos with and without origin.
- web: presence and feed rendering with priorities (existing panels test pattern).
- Smoke: `scripts/demo.sh` brings up server + two clones; `scripts/say.mts` drives both.

## 12. Deliverables order

1. shared schema + roomd overlays, delete disk-write paths.
2. room-mcp: join/leave, inbox, priorities, scope, wait, preview_merge, upgrade rule;
   plugin skill; runner adjustments.
3. web read-only view; README, AGENTS.md, decisions.md, demo script.
