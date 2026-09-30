# Room reference

[Quickstart](../README.md#start-in-five-minutes) · [First session](onboarding.md) · [Upgrade from 0.16](upgrading.md)

## Rooms and destinations

A local room is named `local/<main-worktree basename>`. It uses a loopback relay, needs no account, and is shared by sessions in a clone and its linked worktrees. A team room is named from the canonical Git origin, such as `github.com/owner/repo`; all branches of that repository meet there. The room shows each participant's branch and base separately. A GitHub team repo must be opened once with `room_create`, and joining it requires push access. A server without GitHub or OIDC login can admit a non-GitHub room with a shared token. GitHub rooms cannot use that token.

The destination rule is **tool argument > `ROOM_SERVER` > legacy `ROOM_URL` > remembered clone choice > local**. `room_join(where="team")` chooses `ROOM_SERVER`, then the server in `ROOM_URL`, then `wss://room-rohanz.fly.dev`. An explicit URL wins. `room_join(where="local")` keeps everything on this machine. Saying “join the room” makes a team choice; “work locally” switches back. The choice is stored in the common Git directory and applies to linked worktrees. `room_leave(forget=true)` clears it. Environment settings override the choice without saving it. Room never moves to a team room on its own initiative.

For a self-hosted server, see [self-hosting](../deploy/self-hosting.md). If launching Codex with `ROOM_SERVER`, use `codex --no-daemon`; the shared app-server daemon does not inherit your shell's `ROOM_*` variables. In a team room, `room_login` prints a GitHub device URL and code. The server holds the approved token; Room does not send your `gh` token. `room_state(link=true)` returns a seven-day, room-scoped browser view key. Anyone holding the link can read the shared code and activity.

## Sharing and agent context

On the first team join from a worktree, Room tells the user what will be shared. The notice includes that teammates on any branch can see it. `room_share` changes the level while connected; a server can set a ceiling.

| Level | What others receive |
|---|---|
| `full` (default) | Full text of eligible changed files. |
| `declared` | Paths of every changed file; text only in the agent's declared area. |
| `intent` | Plans and claims, with no file text. |

At `declared`, a changed file that was declared stays shared while it differs from its base, even after `room_done` or a daemon restart. Changing the sharing level, ignoring the file, or exceeding the size budget withdraws its text; declaring it again shares it. “Share plans only” withdraws file text. An invalid `ROOM_SHARE` value falls back to `intent` and reports the setting. When two sessions use one checkout, its primary session publishes file text; the secondary session's area does not control that publication. Reading a person who shares less produces a short explanation.

Areas come from `CODEOWNERS` at the room's base commit. If no rule matches, an uncommitted file gives its top-level directory an area for its editor. `room_scope` states intended work. Claims are advisory and can include planned public interface changes. Room indexes definitions and references with tree-sitter and reports likely consumers of changed signatures; a body-only edit does not become a contract change. Announced plans take precedence over observed signatures. Routine scopes and releases stay in the feed. An inbox receives addressed messages, relevant conflicts and interrupts; `room_state` gives full detail near your work and one line for unrelated people. The bus keeps a rolling window and archives older messages in the ledger.

The local browser link is `http://127.0.0.1:<port>/?room=…&key=…`. It accepts loopback connections only; anyone on this machine holding its key can read the local room. When another session uses your login, Room assigns a stable clone tag such as `rohanz+claude` so an offline overlay cannot be confused with another clone's work.

The browser's Network tab shows upstream dependencies, a participant's own edits and plans, and potential downstream consumers. Announced plans and observed definition changes are separate sources. Blue indicates edits, purple contract changes, and red potential impact. The graph is a projection and does not prove a change has landed or works. Participant colors follow join order and repeat after eight people; names disambiguate them. Search, participant selection, zoom and “Relevant to my work” help narrow larger views.

Open pull requests to or from participants' branches appear as `pr#<n>` participants with scopes from their changed files. One elected client refreshes the mirror about every two minutes; server GitHub PR data is cached for a minute. `room_pr_note` can update one coordination comment on your branch's PR. It summarizes declared work, revised plans, questions, and previews.

## Common tools

| Tool | Purpose |
|---|---|
| `room_login` | GitHub device login or logout. |
| `room_create`, `room_join`, `room_leave`, `room_close` | Open a repository room, join, leave, or close it for everyone. Closing requires an explicit request. |
| `room_state`, `room_read`, `room_export` | Inspect people and files, read permitted versions, or export the ledger and old archives. |
| `room_scope`, `room_claim`, `room_impact` | Declare intended work, claim lines, and inspect consumers before changing an interface. |
| `room_send`, `room_wait`, `room_done` | Ask or answer, wait for a dependency, and finish a task. |
| `room_preview_merge`, `room_collect`, `room_spawn` | Check combined work, collect finished workers, or dispatch a worker. |
| `room_share`, `room_pr_note` | Change the sharing level or update a PR's coordination comment. |

## Wake paths

Claude Code **2.1.224+** on macOS, Linux and WSL 2, and **2.1.234+** on native Windows, can wake an idle session through its cross-session messaging inbox with plain `claude`. Room sends a short pointer; the agent reads the message through Room. Claude Code may frame the pointer as a message from another session. It is a prompt to inspect Room, not authority from another user. Events close together are coalesced. `crossSessionInbound=hold` delays the wake and `refuse` drops it; the Room message remains for the next turn. An organization may disable cross-session messaging.

`ROOM_WAKE=auto` (default) uses the inbox socket when available and an admitted channel if needed. `ROOM_WAKE=channels` forces the optional channel path; `ROOM_WAKE=off` turns wakes off for the process. For older Claude Code, `plugins/room/bin/claude-room` launches the channels fallback with `--dangerously-load-development-channels plugin:room@room`; channels are a research preview. Codex uses `codex queue`. Codex **0.157+** attaches Room to the session's folder on its first Room request; this was observed with the shared app-server daemon in **0.157.1**.

## Workers and previews

Ask for “another agent”, “a few agents in parallel” or “Codex to do part of it” for substantial parallel work. `room_spawn` makes a worktree under `.room/workers/<tag>`; each worker gets its own development port. It carries eligible tracked and non-ignored untracked work from the lead. Files over 5 MB or beyond 50 MB total, nested repositories, and unsafe links are skipped and named in the reply. The worker's changes return through `room_collect` as uncommitted, unstaged edits. A conflict leaves the lead's files untouched. Collection of a finished worker removes its worktree, branch and logs; a failed collection preserves them. Discard retains a recovery patch for a week. A worker in a borrowed checkout detaches without deleting the owner's worktree. A message to a finished worker resumes its retained session until collection or discard.

Room has **no default worker model or effort**. The model and effort named in the request win, then a per-host setting (`ROOM_CODEX_WORKER_MODEL`, `ROOM_CLAUDE_WORKER_MODEL` and their `_EFFORT` variants), then `ROOM_WORKER_MODEL` / `ROOM_WORKER_EFFORT`; otherwise the host's own default applies (Codex's `config.toml` or built-in default, Claude Code's settings). The spawn reply reports what the worker runs with. `ROOM_WORKER_THREADS` overrides its compute thread budget; `ROOM_WORKER_MAX_BUDGET_USD` caps a Claude worker through that host's `--max-budget-usd`. Workers are capped at eight by default (`ROOM_MAX_WORKERS`). A lead can dispatch locally while in a team room: its worker messages remain on this machine and the lead bridges relevant team updates.

`room_preview_merge` combines selected participants at each pair's merge base. With `run=`, it runs a check in a temporary checkout and keeps a reusable worktree slot under the Git common directory's `room-preview/`. Ignored build output can stay warm. The preview cache has a size cap (`ROOM_PREVIEW_CACHE_GB`, default 4; 0 disables reuse). A sparse clone's check uses a full-tree checkout without changing the source's sparse settings. A crashed process can leave a claimed slot; stop Room processes and inspect `git worktree list --porcelain` and the slot's `.git` and reciprocal admin `gitdir` before manually removing its `.claim` and registered worktree.

## Files Room writes

Room never writes a teammate's live edits into your working tree. It writes session bookkeeping in the worktree's Git directory (`room.json`, migrated from root `.room.json`) and choice, relay discovery, local snapshots and a rotating `room-mcp.log` in the common Git directory. The local browser link uses the key in `room/relay.json`, works only over loopback, and requires a running session. Local memory is saved in `room/relay/*.ydoc`; file text and claims are rebuilt by connected sessions. `room_leave` preserves memory. `room_close confirm=true` exports the ledger and closes the repository room for everyone; in a local room it also forgets saved memory. Exports go under `.room/ledger/`; worker worktrees and logs go under `.room/workers/`. Room adds `.room/` to Git's private `info/exclude`.

Credentials live in `~/.config/room/credentials.json`, subject to `XDG_CONFIG_HOME` or `ROOM_CREDENTIALS`. `ROOM_LOG_FILE` changes the log location. The log is mode 0600 and rotates at 1 MB with one older generation. Temporary merge directories use the OS temp directory.

When a teammate pushes a commit on your branch, Room can show that your clone is behind. To catch up with uncommitted edits, run `git pull --ff-only --autostash`. If it refuses, get help before trying another Git history operation.

## Environment variables

| Variable | Purpose |
|---|---|
| `ROOM_SERVER` | `hosted` or a team WebSocket URL; takes priority over remembered choice. |
| `ROOM_URL` | Legacy team URL fallback. |
| `ROOM_SHARE` | `full`, `declared`, or `intent`. |
| `ROOM_WAKE` | `auto`, `channels`, or `off`. |
| `ROOM_TAG` | Your label when one login has several sessions. |
| `ROOM_WORKER_MODEL`, `ROOM_WORKER_EFFORT` | Your default worker model and effort; otherwise host defaults apply. |
| `ROOM_CODEX_WORKER_MODEL`, `ROOM_CODEX_WORKER_EFFORT`, `ROOM_CLAUDE_WORKER_MODEL`, `ROOM_CLAUDE_WORKER_EFFORT` | Per-host worker defaults; they override the generic pair. |
| `ROOM_WORKER_THREADS`, `ROOM_WORKER_MAX_BUDGET_USD` | Worker compute budget and Claude cost cap. |
| `ROOM_MAX_WORKERS` | Maximum concurrent workers; default 8. |
| `ROOM_PREVIEW_CACHE_GB` | Preview cache cap in GiB; default 4, 0 disables reuse. |
| `ROOM_IDLE_LEASE_MS` | Positive idle lease in milliseconds for an unheld Codex app-server session; default 30 minutes. |
| `ROOM_CREDENTIALS`, `ROOM_LOG_FILE` | Alternate credential and log paths. |
| `ROOM_TOKEN` | Shared server token for non-GitHub rooms. |
| `YPERSISTENCE` | Server state directory. |

## Updating plugins

Update the marketplace and the plugin, then start a new agent session. Existing sessions retain their original tools and instructions. If a hook definition changes, trust it again when prompted. Codex reads hooks from the marketplace source and the MCP bundle from its plugin cache; refreshing the marketplace alone can leave those versions apart. Reinstall after refreshing.

```sh
claude plugin marketplace update room
claude plugin update room@room

codex plugin marketplace upgrade room
codex plugin add room@room
```

Codex accepts Git marketplace references such as `owner/repo@ref` and `--ref <REF>` when adding a marketplace. See [the 0.17 upgrade steps](upgrading.md) for the protocol cutover.

## Limits and diagnostics

Claims depend on agent cooperation. The dependency graph infers possible effects; tests establish compatibility. A graph view projects overlays and renders at most 250 files at once. A team room trusts admitted participants, and shared files and history reach the server. Connection failures, stale claims, missing Git bases and files over sharing limits are reported. If a tool is slow, `room-mcp.log` records its phase durations and process ID. `room_state` shows connection and sharing state; asking “is Room set up right?” requests the setup check. `bin/room-doctor` is also available in a checkout or installed plugin.

## Local development

```sh
git clone https://github.com/rohanz/room.git
cd room
npm ci
npm run build
npm run build:plugin
```

Start `HOST=127.0.0.1 PORT=1234 npm run server` and `npm run web` in separate terminals. For a local team-server test, use `ROOM_SERVER=ws://localhost:1234 ROOM_WEB=http://localhost:5173 codex --no-daemon`. Set `GITHUB_CLIENT_ID=fake` on a development server for test login; production refuses it. A repo still needs `room_create` before joining. Without `YPERSISTENCE`, a server restart resets state. Run `npm test`, `npm run typecheck`, `npm run build -w @room/web`, and `npm run build:plugin` before shipping. [AGENTS.md](../AGENTS.md) has the current contributor commands; [deploy instructions](../deploy/DEPLOYING.md) cover hosted operations.
