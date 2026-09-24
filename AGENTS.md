# aitinkerhackathon — "Agents leaving the chatbox" hackathon

Rohan's entry. One-day build; a working prototype demoable by end of day.
`CLAUDE.md` is a symlink to this file.

## Read first

- `RULES.md` — the verbatim brief and the 4-criterion, 1–5 judging rubric. That file is
  the rules; this file is how we work.
- `docs/decisions.md` — what we're building and why (idea, environment, scope cuts).
  Empty until the idea is locked. **Do not start coding before it has an entry.**
- `docs/submission.md` — the deliverables checklist and demo script.

## Hard constraints (from RULES.md)

- **Build timing:** organiser confirmed (9 Sep) that pre-event building is fine; the "net-new during the event" text in RULES.md is from old rules. Keep a short "what was built when" note in `docs/decisions.md` anyway.
- Repo must be **public** on GitHub at submission. Never commit secrets; `.env` is
  gitignored, `.env.example` documents what's needed.
- Submission also needs: title, written description, 2-minute demo video, social post
  tagging event partners. See `docs/submission.md`.

## How the rubric should shape decisions

Each criterion is scored 1–5 and they're equally weighted, so a project that scores 4 on
everything beats a 5/5/2/3. Practical rules:

1. **End-to-end first, breadth never.** A 3 on "Core Requirements" needs the whole
   workflow working inside the real environment. Get the thin vertical slice running in
   the actual target (real Slack workspace, real browser extension, real device) before
   adding any second feature.
2. **The environment must be load-bearing.** The 1-score on Innovation is "the
   environment is irrelevant"; the 5 is "could not be reproduced in a standalone
   chatbox". Every feature should answer: what does the agent know or can it do *here*
   that it couldn't in a chat window? If the answer is "nothing", cut it.
3. **Failure handling is explicitly scored** (Technical Execution 5: "thoughtful failure
   handling"). Timeouts, retries, and a graceful "I couldn't do that" path are worth more
   than a fourth tool.
4. **User control is scored** (Usefulness 3–5: "reasonable user control", "clear and
   controllable"). Confirm-before-act for anything irreversible; show what the agent is
   doing.
5. Demo reliability beats capability. If a feature works 70% of the time it is a demo
   liability; either harden it or cut it before recording.

## Conventions

- Python via `uv` only (deps and running). Other stacks are fine if the environment
  demands it (e.g. a browser extension in TS); say so in `docs/decisions.md`.
- Claude models: default to `claude-fable-5-1` for the agent loop, `claude-haiku-4-5-20251001`
  for cheap classification/routing steps. Read the `claude-api` skill before writing
  API code; don't work from memory.
- Tests: pytest for anything non-trivial and testable offline. Under hackathon time
  pressure, prioritize a smoke test of the end-to-end path over unit coverage.
- Commit small and often on `main`. Commit messages state what changed and why.
- Clean up dead code before the final commit; the repo is part of the submission and
  judges read it.
- Log agent actions (tool calls, decisions) to stdout or a file — this doubles as demo
  material and as the "explain what it did" story.

## Layout

```
RULES.md                 verbatim brief + rubric (do not edit)
AGENTS.md                this file (CLAUDE.md -> AGENTS.md)
docs/decisions.md        idea, scope, findings from live runs, what-was-built-when
docs/prior-art.md        AgentRoom, Zed Delta, etc. and the gap we fill
docs/submission.md       deliverables checklist + demo script
docs/superpowers/        design specs (v2: 2026-09-12-room-v2-design.md) + plans
packages/shared/         one Y.Doc schema: overlays, scopes, claims (with plans), rolling bus + ledger archive,
                         workers; messages.ts (every message kind: format/audience/wake/priority), views.ts
                         (participant/claim/area/worker lines shared by web and tools), areas.ts, identity;
                         src/parsed.ts holds parser output shared by the indexer and consumers
packages/server/         y-websocket server: GitHub device login + OIDC (auth.ts), admission (admit.ts),
                         open/close/list repos, GitHub PR proxy, read-only view keys, doc/message caps,
                         audit, LevelDB docs + File/Pg store (store.ts)
packages/relay/          loopback relay for local rooms: discovery file + key, /health, serves the web view
packages/roomd/          push-only daemon: clone -> my overlay; base tracking; share levels; .roomignore,
                         default ignores + size budget; never writes disk
packages/room-mcp/       src/tools/* (one module per concern: join, scope, claims, messaging, files,
                         workers, share, prs; index.ts assembles DEFS), registry.ts (a process holds several
                         rooms), config.ts (arg > env > remembered > default), session.ts, workers.ts,
                         bridge.ts (lead in two rooms), conflicts.ts, hooks-bridge.ts, prs.ts, graph-index.ts;
                         src/parse/ (engine.ts, spec.ts, index.ts, languages/*) is the tree-sitter indexer
packages/agent/          roomagent: on-duty Codex thread fed by chat + interrupts/addressed notifies
packages/web/            read-only room view: participants, overlays with claim gutters, feed, network
plugins/room/            Codex AND Claude Code plugin (both manifests): skills, hooks, bundled MCP server + web/;
                         server/grammars/ contains the shipped tree-sitter grammars
examples/demo-repo/      tiny Python service used in the demo (uv)
scripts/demo.sh          server + shared origin + two clones on one machine
scripts/say.mts          post a message into a person's agent chat and watch the room
scripts/build-plugin.mjs esbuild bundle of room-mcp into plugins/room/server
```

## Host features change weekly: read the current docs first

Room is built on Claude Code and Codex, and both change every week. Before designing around, relying on or
explaining a host feature (hooks, channels, cross-session messaging, plugins, permissions, `codex queue`),
read its current documentation and changelog, not memory: the index at https://code.claude.com/docs/llms.txt
and its `.md` pages, https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md (publish dates:
`npm view @anthropic-ai/claude-code time`), and `codex --help` / Codex's docs. Name the version a feature
arrived in. Every batch brief says this too; Codex workers have no network, so the lead saves dated snapshots
of the pages they need. Room ran on research-preview channels for weeks after cross-session messaging, which
wakes idle sessions with no flag, had shipped (Claude Code 2.1.224, 2026-08-07).

## Running and testing

Hook definitions (`plugins/room/hooks.json`, `plugins/room/hooks/claude.json` — event, matcher, command) are frozen. Codex trusts each by content hash (`[hooks.state]` in `~/.codex/config.toml`), and any change un-trusts it for every user. Change behavior in the hook scripts instead.

- Claude Code 2.1.224+ wakes through its cross-session messaging inbox with plain `claude` (2.1.234+ on native Windows). `plugins/room/bin/claude-room` is an optional channels fallback for older versions. Keep README, onboarding and the join skill aligned when wake behavior changes.
- Hosted server operations (deploy, secrets, opening/closing repos, incidents): `deploy/DEPLOYING.md`.
  Deploy with `--depot=false`; only server/web changes need a deploy, plugin changes need a bundle rebuild + push.

- CI runs these same commands (`npm run typecheck`, `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`, `npm run build -w @room/web`, and `npm run build:plugin`) on every push to `main` and every pull request, and checks that committed plugin assets are up to date.
- `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test` runs every package's vitest suite
  (some suites listen on loopback; inherited ROOM_* variables change identity-sensitive tests).
- `npm run typecheck`; `npm run build:plugin` after touching room-mcp, roomd, relay, shared or web
  (the bundle, `plugins/room/web` and tree-sitter grammars are committed; the build copies the
  grammars into `plugins/room/server/grammars`). Installed plugins copy the bundle: reinstall
  `room@room` on both hosts after a rebuild. `node scripts/build-plugin.mjs --skip-web` rebuilds
  only the server bundle (for sandboxes that cannot build the web view); never commit from it.
- Tool descriptions are how a human's plain words reach the right tool. Keep the routing words
  ("another agent", "in parallel", "in the background", "codex/claude to do part of it") when
  trimming, stay under the budget in `packages/room-mcp/test/tool-budget.test.ts`, and rerun a
  human-phrasing check after any description change: a trim once sent "get codex to do half" to
  a built-in subagent.
- Implementation work goes to Codex (model 5.6 Sol at medium, or 6 Astra at low): either the
  codex:codex-rescue subagent or room workers with `host: 'codex'`. Claude plans, writes briefs,
  leads room batches, reviews, integrates and deploys. Codex's sandbox cannot write a git dir
  outside its cwd and cannot listen on sockets: give it a standalone clone (`git clone … /tmp/room-x`,
  `npm install`), expect the socket suites to fail there, and run the full suite yourself before
  merging. Room batches: one lead (`claude -p` with the room plugin, no ROOM_SERVER) spawns
  Codex workers into worktrees, commits their worktrees itself, previews and octopus-merges.
- Reviews alternate Fable and Codex; six rounds on 2026-09-15 found ~60 issues, none repeated.
- `scripts/demo.sh` brings up a server and two clones and prints the join commands. Join
  from a clone with plain Codex (`ROOM_SERVER=ws://host:1234 codex`, then `$room-join`) or
  with `npx tsx packages/agent/src/cli.ts --dir <clone>`.
- With no `ROOM_SERVER` a session is in a local room (`local/<repo>/<branch>`, relay on loopback,
  `.git/room-local.json`). Team rooms are named `<host/owner/repo>/<branch>` from the clone's origin
  (non-GitHub hosts become `git/<host>/…`); URL-encoded in the ws path. A repo must be opened once
  (`room_create` / `POST /rooms`) before its branch rooms accept connections. Without
  `YPERSISTENCE` the server is in-memory: restart it to reset. A dev server needs
  `GITHUB_CLIENT_ID=fake` to log anyone in (test issuer; refused with NODE_ENV=production).
- Ports: server 1234 by default; demo scripts in this repo have used 1244 to avoid a stray
  server from an earlier session.
- Quick tool-level smoke without Codex: call `createTools` / `joinSession` from
  `@room/room-mcp` in a tsx script (see the test in `packages/room-mcp/test/tools.test.ts`).
