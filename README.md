# Room

Room lets coding agents see teammates' work while they are still editing.
Agents can claim code, ask each other questions, and preview their changes together.
Your files and Git workflow stay yours: Room shares context, then you decide what to merge.

## Start in five minutes

You need **Node.js 22+**, **Git**, a repository with at least one commit, and either **Claude Code 2.1.224+** (2.1.234+ on native Windows) or **Codex 0.157+**. The plugin carries its server bundle; you do not need to build it to install from GitHub.

Install for your agent:

```sh
claude plugin marketplace add rohanz/room
claude plugin install room@room
```

```sh
codex plugin marketplace add rohanz/room
codex plugin add room@room
```

In Codex, accept the Room hooks prompt, or trust Room in `/hooks`. Its session-start and before-edit hooks put relevant room context in the agent's path. Start your agent as usual inside your repository. You can simply work: the default **local room** stays on this machine. Say **“join the room”** when you want the team room.

Sessions in one clone and its linked worktrees use the same local room by default; separate clones have separate local rooms. Claude normally connects when its Room MCP starts. Codex’s shared app-server waits until the first Room tool call supplies the session’s repository, so say **“show room state”** once to establish and verify its connection. Once connected, separate sessions in the same checkout count as company and receive eligible coordination notifications, just like sessions in linked worktrees. Shared file changes are still deduplicated. See [startup and wake behavior](docs/reference.md#rooms-and-destinations).

The [defaults table](#defaults-and-how-to-change-them) shows what Room chooses and what to say to change it.

Ask **“show room state”** to check it. A local session starts with `local: nothing leaves this machine`, then shows `room: local/<repo>` and `you: <name> in local/<repo>`. A team session shows `team room:`, `room: github.com/<owner>/<repo>`, and your branch and base. Ask for the browser link to see participants and activity.

If setup seems wrong, ask **“is Room set up right?”**. The agent checks Room state, server schema, hub protocol and storage health, and verifies a saved login when the server supports it. You can also run `plugins/room/bin/room-doctor` from a checkout, or from the installed plugin at `~/.claude/plugins/cache/room/room/<version>/bin/room-doctor` or `~/.codex/plugins/cache/room/room/<version>/bin/room-doctor` (replace `<version>` with the installed version).

When updating Room, finish active worker batches first, update the plugin, then restart your agent sessions. A running session can keep an old hook path after the installer removes that version. Ask **“is Room set up right?”** in the fresh session to verify the loaded bundle and hook trust. See [updating plugins](docs/reference.md#updating-plugins).

### Work with teammates

One team room covers **every branch of a repository**. You need push access to its GitHub repository.

1. Say **“log in to Room”**. Open the GitHub device page, enter the code, and approve Room.
2. One person says **“open this repo on the server”**. The agent uses `room_create` to open it once.
3. Teammates install Room and say **“join the room”** from their own clones.

The hosted server is `wss://room-rohanz.fly.dev`. To choose it explicitly, launch Codex with `ROOM_SERVER=hosted codex --no-daemon`. For your own server, use `ROOM_SERVER=wss://room.example.com codex --no-daemon` and [self-hosting instructions](deploy/self-hosting.md). Codex's shared app-server daemon does not pass shell `ROOM_*` variables to Room. The agent tells you what the clone will share on its first team join; you can say **“share plans only”** or **“only my declared files”**.

[Follow a first session](docs/onboarding.md) · [Reference and troubleshooting](docs/reference.md) · [Upgrade from 0.16](docs/upgrading.md)

## Defaults, and how to change them

| Default | What it means | Change it |
|---|---|---|
| Local room | Nothing leaves this machine until you choose a team room. Room remembers the choice per clone, including linked worktrees. | Say **“join the room”** or **“work locally”**; use `room_join(where="team"/"local")`. Set `ROOM_SERVER=hosted` or a WebSocket URL to choose a team destination at launch. `room_leave(forget=true)` clears the saved choice. |
| `full` sharing in a team room | Members of that repository's team room, on **every branch**, receive the full text of eligible files you change. A server can lower the ceiling with `ROOM_SHARE_MAX`; your request cannot exceed it. Local rooms stay on this machine. | Say **“share plans only”** for `intent` (plans and claims, no file text), **“only my declared files”** for `declared` (eligible changed paths, text only in your declared area), or **“share all changed files”** for `full`. Ignored, unsafe, oversized and budget-excluded paths remain digest-only. Use `room_share(level=...)` or set `ROOM_SHARE` before launch. |
| File publication limits | Room skips files matching `.roomignore`; it also excludes `.env` and `.env.*` except `.env.example`, common build and cache directories, temporary and binary extensions, and untracked lockfiles; it does not watch wholly gitignored folders. It shares at most **512 KiB per file** and **8 MiB total** of changed file text. | Edit `.roomignore` in the clone to exclude more paths. Say **“show room state”** to see skipped files. These built-in limits are not user settings. |
| Worker host, model and effort | The caller's host runs a worker by default. Room passes through a model and effort named in a spawn request; otherwise the host chooses its own default. The spawn reply names what runs when known. | Ask for a specific host, model or effort, or pass `host`, `model`, `effort` to `room_spawn`. Set `ROOM_WORKER_MODEL` / `ROOM_WORKER_EFFORT`, or the per-host `ROOM_CODEX_WORKER_*` / `ROOM_CLAUDE_WORKER_*` pair. |
| Eight concurrent workers | Room caps workers at eight. Its computed CPU and memory budget is shown to each worker; scheduling priority defaults to `nice 10`. | Set `ROOM_MAX_WORKERS` for the count, `ROOM_WORKER_THREADS` and `ROOM_WORKER_MEM_GB` for compute budgets, or pass `threads` to `room_spawn`. |
| No Claude worker cost cap | Room does not set Claude's `--max-budget-usd` unless you choose a cap. | Set `ROOM_WORKER_MAX_BUDGET_USD` before launching the lead. |
| Carry uncommitted work | New workers receive eligible tracked and non-ignored untracked edits: at most **5 MiB per file** and **50 MiB total**. `.roomlinks` lists input paths linked into worker worktrees. | Ask **“start the worker from HEAD”** or pass `carry=false` to `room_spawn`; pass `link=[]` to disable `.roomlinks` for that worker. |
| Worker dependencies linked, Room's variables kept out | A worker's `node_modules` links to your installed packages, with workspace packages pointing at the worker's own sources, so its tests run its code; the spawn reply warns when Room cannot link. The worker's shell commands do not see Room's `ROOM_*` variables. See [workers](docs/reference.md#workers-and-previews). | A worker can delete its linked `node_modules` and install its own. |
| Automatic wake | Claude Code 2.1.224+ (2.1.234+ on native Windows) uses its cross-session inbox when available, then an admitted channel if needed. Codex uses its queue. | Set `ROOM_WAKE=channels` for the optional Claude channel path or `ROOM_WAKE=off` to stop wakes on both hosts (messages still wait in the inbox); `ROOM_WAKE=auto` restores the default. |
| 30-minute idle lease | An unheld Codex app-server session is retired after 30 minutes idle. | Set `ROOM_IDLE_LEASE_MS` to a positive number of milliseconds. |
| 4 GiB nominal preview cache | Merge previews with checks reuse a cached worktree. Eviction runs after a preview; active or locked entries and temporary checkouts can exceed the limit, so it is not a disk quota. `ROOM_PREVIEW_CACHE_GB=0` turns reuse off. | Set `ROOM_PREVIEW_CACHE_GB` to the desired GiB limit. |
| Automatic name tag | When one login has more than one session, Room adds a clone or host tag such as `rohanz+claude` to keep identities separate. | Set `ROOM_TAG` before launching the agent. |
| Automatic Git base fetch | Room may fetch a missing base commit from the room's remote, at most once per SHA per five minutes. | Set `ROOM_AUTO_FETCH=0` to disable it. |
| Seven-day participant expiry | After seven days offline, Room removes that participant's overlay, scope, claims and other owned coordination state. Owed ledger messages remain. | Set `ROOM_STALE_DAYS` to a positive number. |
| Server cleanup after 30 days | The server closes repositories idle for 30 days and removes legacy branch records 30 days after migration. | Server operators can set `ROOM_IDLE_DAYS` and `ROOM_LEGACY_DAYS`. |
| Server size caps | The team server accepts up to 64 MiB per live room document and 16 MiB per WebSocket message. A local room applies the same rule to its live document at 64 MiB: once a room is over the cap, writers are refused (close 4413) and reads continue. Its snapshots above 64 MiB are skipped, preserving the previous snapshot. Its identity guard observes by default. | Server operators can set `ROOM_DOC_MAX_MB`, `ROOM_MAX_MESSAGE_MB`, and experimental `ROOM_IDENTITY_GUARD=enforce`. |

## How people use it

When you ask your agent to work on a feature, it can announce the files it expects to edit. If another agent is near that code, Room shows the overlap and the agents can claim separate lines or ask each other a question. An addressed question can wake an idle session. Before bringing work together, agents can preview the combined tree and run checks. Claims and coordination messages are advisory: delivering a requested pause does not guarantee the agent follows it. For a requested precollection review, a reviewer can establish an explicit [collection hold](docs/reference.md#workers-and-previews); ordinary batches need no hold. Commits and pushes remain your decision.

Ask explicitly for **“Room workers”** or **“use Room to have Codex do half of this”**. Generic requests for another agent or background work use your host’s normal delegation. Room runs workers in their own Git worktrees and brings finished work back as uncommitted, unstaged edits. The spawn reply names each worker's host, model and effort when known. Room has no default worker model or effort: a request or worker environment setting can select one; otherwise the host chooses.

![Room file viewer showing participants’ changes and activity](docs/img/room-v2-redesign.png)

The browser view shows participants, changed files, claims, the activity feed and a network of possible effects from changed function signatures. The screenshot is from an earlier two-agent run; the current UI also has a Network tab.

## Status and limits

[![CI](https://github.com/rohanz/room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rohanz/room/actions/workflows/ci.yml)

Room has been used live with small teams, local rooms, mixed Claude Code and Codex workers, and GitHub repositories on macOS. OIDC, Postgres, Linux (where CI runs), Windows and large monorepos have test coverage but limited live use. Claims cannot prevent writes. Symbol impact is inferred and needs tests to confirm compatibility. A team room trusts everyone it admits; [the roadmap](docs/roadmap.md) tracks finer permissions and scale work. See [failure handling and diagnostics](docs/reference.md#limits-and-diagnostics).

The [0.17.6 validation record](docs/superpowers/rehearsals/2026-10-06-wake-guidance.md) covers clarified worker wake instructions and a paired Claude comprehension check. Room’s wake behavior is unchanged.

The [0.17.5 release record](docs/superpowers/rehearsals/2026-10-05-0175-release.md) tracks the plugin-only collection review-hold update and installation checks.

The [0.17.4 validation record](docs/superpowers/rehearsals/2026-10-04-0174-release.md) covers eight-worker Python rehearsals, sharing and lifecycle recovery, independent review, release CI and an installed-plugin smoke test. These are bounded checks, not a guarantee of unattended reliability. If a worker outlives its launcher and its exit cannot be verified, collection retains its worktree for inspection.

A [local TypeScript trial on historical Zod](docs/superpowers/rehearsals/2026-10-04-zod-historical.md) ran eight Codex workers and retained five independently matched historical fixes. One unresolved proposal was saved separately and two invalid task selections were rejected. The trial also recorded a delivered review-pause message that the lead ignored; passing project tests did not erase that coordination failure.

Room began as an [“Agents leaving the chatbox” hackathon](RULES.md) entry. Its environment matters because an agent can respond to actual uncommitted files, Git bases, teammate plans and questions while you work.

## Contributing

For a checkout, run `npm ci` and `npm run build:plugin`. Add the checkout as a local marketplace with `claude plugin marketplace add /path/to/room` or `codex plugin marketplace add /path/to/room`; Claude Code can also load it with `--plugin-dir /path/to/room/plugins/room`, and its Claude workers then load the same directory. Codex has no such option: Codex sessions and Codex workers run the installed plugin, so reinstall `room@room` after each `npm run build:plugin`. See [AGENTS.md](AGENTS.md) for the repository layout and test commands, and [local development](docs/reference.md#local-development) for the server and sample.

Room is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal use, research, modification and sharing are allowed; selling Room or running it as a paid service requires a commercial licence.
