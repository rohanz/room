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

Ask **“show room state”** to check it. A local session starts with `local: nothing leaves this machine`, then shows `room: local/<repo>` and `you: <name> in local/<repo>`. A team session shows `team room:`, `room: github.com/<owner>/<repo>`, and your branch and base. Ask for the browser link to see participants and activity.

If setup seems wrong, ask **“is Room set up right?”**. The agent checks Room state. You can also run `bin/room-doctor` from a checkout or the installed plugin at `~/.claude/plugins/cache/room/room/<version>/bin/room-doctor` or `~/.codex/plugins/cache/room/room/<version>/bin/room-doctor` (replace `<version>` with the installed version).

### Work with teammates

One team room covers **every branch of a repository**. You need push access to its GitHub repository.

1. Say **“log in to Room”**. Open the GitHub device page, enter the code, and approve Room.
2. One person says **“open this repo on the server”**. The agent uses `room_create` to open it once.
3. Teammates install Room and say **“join the room”** from their own clones.

The hosted server is `wss://room-rohanz.fly.dev`. To choose it explicitly, launch Codex with `ROOM_SERVER=hosted codex --no-daemon`. For your own server, use `ROOM_SERVER=wss://room.example.com codex --no-daemon` and [self-hosting instructions](deploy/self-hosting.md). Codex's shared app-server daemon does not pass shell `ROOM_*` variables to Room. The agent tells you what the clone will share on its first team join; you can say **“share plans only”** or **“only my declared files”**.

[Follow a first session](docs/onboarding.md) · [Reference and troubleshooting](docs/reference.md) · [Upgrade from 0.16](docs/upgrading.md)

## How people use it

When you ask your agent to work on a feature, it can announce the files it expects to edit. If another agent is near that code, Room shows the overlap and the agents can claim separate lines or ask each other a question. An addressed question can wake an idle session. Before bringing work together, agents can preview the combined tree and run checks. Claims are advisory; commits and pushes remain your decision.

You can also ask **“use a couple of subagents for this”**. Room runs workers in their own Git worktrees and brings finished work back as uncommitted, unstaged edits. The spawn reply names each worker's host, model and effort when known. Room has no default worker model or effort: a request or worker environment setting can select one; otherwise the host chooses.

![Room file viewer showing participants’ changes and activity](docs/img/room-v2-redesign.png)

The browser view shows participants, changed files, claims, the activity feed and a network of possible effects from changed function signatures. The screenshot is from an earlier two-agent run; the current UI also has a Network tab.

## Status and limits

[![CI](https://github.com/rohanz/room/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rohanz/room/actions/workflows/ci.yml)

Room has been used live with small teams, local rooms, mixed Claude Code and Codex workers, and GitHub repositories on macOS. OIDC, Postgres, Windows and large monorepos have unit coverage but limited live use. Claims cannot prevent writes. Symbol impact is inferred and needs tests to confirm compatibility. A team room trusts everyone it admits; [the roadmap](docs/roadmap.md) tracks finer permissions and scale work. See [failure handling and diagnostics](docs/reference.md#limits-and-diagnostics).

Room began as an [“Agents leaving the chatbox” hackathon](RULES.md) entry. Its environment matters because an agent can respond to actual uncommitted files, Git bases, teammate plans and questions while you work.

## Contributing

For a checkout, run `npm ci` and `npm run build:plugin`. Add the checkout as a local marketplace with `claude plugin marketplace add /path/to/room` or `codex plugin marketplace add /path/to/room`; Claude Code can also load it with `--plugin-dir /path/to/room/plugins/room`. See [AGENTS.md](AGENTS.md) for the repository layout and test commands, and [local development](docs/reference.md#local-development) for the server and sample.

Room is released under the [PolyForm Noncommercial License 1.0.0](LICENSE). Personal use, research, modification and sharing are allowed; selling Room or running it as a paid service requires a commercial licence.
