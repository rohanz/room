# First session with Room

[Install Room](../README.md#start-in-five-minutes) for Claude Code or Codex first. You need Node.js 22+, Git, a repository with a commit, and Claude Code 2.1.224+ (2.1.234+ on native Windows) or Codex 0.157+. In Codex, trust Room's hooks when prompted or in `/hooks`.

## Start locally

1. Start your agent as usual from your repository. Ask it to work on a small feature. With no team destination chosen, Room uses `local/<repo>` and nothing leaves your machine.
2. Say **“show room state”**. Look for `local: nothing leaves this machine`, `room: local/<repo>`, and `you: <name> in local/<repo>`. Ask for the browser link if you want to see participants and activity; the local link works while a session is running.
3. If you do not see those lines, ask **“is Room set up right?”**. The agent checks its Room connection and hooks. The installed plugin also has `bin/room-doctor`; see [the quickstart](../README.md#start-in-five-minutes).

Another session in this clone or its linked worktrees uses the same local room when both select local. A separate clone has its own local room. Its participant name may get a tag such as `rohanz+claude`; automatic labels match the host and avoid retained worker names. The default state view shows online participants elsewhere separately from offline history.

Automatic room selection does not always mean immediate connection. Claude normally connects when its Room MCP starts. With Codex’s shared app-server, the first Room tool call supplies the repository and starts joining; **“show room state”** is enough, with no explicit join request. A remembered team choice or `ROOM_SERVER` overrides the local default.

Two connected sessions in the **exact same checkout** count as company and can receive addressed questions and notifications through their host’s wake path. Room still deduplicates shared file reports; explicit scopes and claims remain separate. For substantial parallel edits, use separate linked worktrees to isolate file changes; they still share the local room.

## Add teammates

One team room covers every branch of a GitHub repository. Each teammate needs push access and installs the same Room version.

1. Say **“log in to Room”**. Open the GitHub device page, enter the code, and approve Room.
2. One participant says **“open this repo on the server”**. This runs `room_create` once.
3. Each teammate says **“join the room”** from their clone. **“Show room state”** now reports `team room:`, `room: github.com/<owner>/<repo>`, and `you: <name> in github.com/<owner>/<repo>` with that person's branch and base.

The hosted server is `wss://room-rohanz.fly.dev`. For a self-hosted server, launch Codex with `ROOM_SERVER=wss://room.example.com codex --no-daemon`; the shared app-server daemon does not inherit shell `ROOM_*` variables. Room states what this worktree shares on first join. By default, members of the team room on every branch see the full text of eligible files you change. Say **“share plans only”** or **“only my declared files”** to narrow it; `room_share` changes it later. The [defaults table](../README.md#defaults-and-how-to-change-them) and [reference](reference.md#sharing-and-agent-context) explain the levels. **“Work locally”** returns to the local room.

## Coordinate a task

Ask your agent to change a file while a teammate works nearby. It can name its area with `room_scope`, claim lines before editing with `room_claim`, and ask the other agent a question. The room reports overlaps and relevant changes; claims guide coordination but do not lock files.

For a substantial task, say **“use a couple of Room workers in parallel for this”** and name separate work areas; they may share files. Each Room worker gets its own worktree and a spawn reply that names its host, model and effort when known. The worker scopes and claims its work, then reports completion. Ask your agent to **preview the merge**. `room_preview_merge` combines current work in a scratch tree and can run your check command there. Once you approve collection, `room_collect` brings finished output into your tree **uncommitted and unstaged**. A conflict leaves your files alone and names the conflicting paths. You decide when to commit or push.

A question addressed to an idle agent can wake its session. Claude Code 2.1.224+ uses its messaging inbox with plain `claude` (2.1.234+ on native Windows); Codex uses its queue. The wake carries a short pointer, then the agent reads the actual Room message. See [wake paths](reference.md#wake-paths).

If something is missing or stale, ask for room state and use [diagnostics](reference.md#limits-and-diagnostics). After a plugin update, restart the agent session or reconnect its MCP server to load the new tools.
