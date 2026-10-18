# Room — agent coordination for production use

Room is a maintained tool for coordinating coding agents, both local workers and
independent users' agents. It began as a hackathon project; the repository directory
still has its original name. Hackathon deadlines, judging criteria and demo scope
are historical context, not constraints on current engineering decisions.
`CLAUDE.md` is a symlink to this file.

## Read first

- `README.md` — current product scope, installation and supported workflows.
- `docs/reference.md` — tool behavior, coordination and worker lifecycle contracts.
- `docs/roadmap.md` — planned work; distinguish proposals from shipped behavior.
- Relevant design documents and `docs/decisions.md` for rationale. Check historical
  decisions against current code, tests and documentation before relying on them.
- `RULES.md` and `docs/archive/submission.md` preserve the original hackathon brief and
  submission history. Keep `RULES.md` unchanged; neither governs current priorities.

## Engineering priorities

1. **Correctness and user control.** Protect users' files, work in progress, identity
   and sharing boundaries. Make consequential actions explicit and respect the
   user's authorization. Never commit secrets; keep configuration examples safe.
2. **Reliable end-to-end behavior.** Validate in supported hosts and environments,
   including failure, restart and recovery paths. A successful demo is evidence for
   that run, not a production-readiness guarantee.
3. **Simple, maintainable design.** Prefer existing host capabilities and clear
   ownership over duplicate machinery. Reproduce a problem before changing its
   mechanism; use focused tests to isolate causes before expensive full runs.
4. **Appropriate verification.** Match checks to the change and its risks, preserve
   required CI checks, and cover regressions and affected integrations. Neither
   hackathon time pressure nor a benchmark target justifies weaker validation.
5. **Measured efficiency.** Bound memory, CPU, disk use and background-process
   lifetimes. Improve real coordination and latency without trading away correctness.
   Report benchmark conditions, failed runs and uncertainty honestly.
6. **Useful documentation and diagnostics.** Keep setup, tool descriptions, skills
   and release notes aligned with actual behavior. Log enough to diagnose failures
   while protecting private code, credentials and user data.

## Conventions

- Use the existing stack: TypeScript with the repository's npm workspaces and Vitest;
  Python tooling and examples use `uv` and pytest. Explain substantial stack changes.
- Choose models and effort according to the user's request and the task. Room itself
  does not impose a worker model. Check current host/API documentation before relying
  on model availability or host features.
- Run focused checks during implementation and the relevant release checks before
  shipping (see below). Preserve completed validation evidence; rerun when changed
  inputs or unresolved concerns require it.
- Commit only when authorized. Keep commits focused, explain what changed and why,
  and preserve other contributors' work in shared checkouts.
- Remove dead code as part of maintenance. Keep architecture and instructions clear
  enough for another contributor to understand and safely extend.

## Layout

```
RULES.md                 historical hackathon brief + rubric (do not edit)
AGENTS.md                this file (CLAUDE.md -> AGENTS.md)
docs/decisions.md        idea, scope, findings from live runs, what-was-built-when
docs/prior-art.md        AgentRoom, Zed Delta, etc. and the gap we fill
docs/archive/submission.md       historical submission checklist + demo script
docs/superpowers/        design specs (v2: 2026-09-12-room-v2-design.md) + plans
packages/shared/         one Y.Doc schema: overlays, scopes, claims (with plans), rolling bus + ledger archive,
                         workers; messages.ts (every message kind: format/audience/wake/priority), views.ts
                         (participant/claim/area/worker lines shared by web and tools), areas.ts, identity;
                         src/parsed.ts holds parser output shared by the indexer and consumers
packages/server/         y-websocket server: GitHub device login + OIDC (auth.ts), admission (admit.ts),
                         open/close/list repos, GitHub PR proxy, read-only view keys, doc/message caps,
                         audit, LevelDB docs + File/Pg store (store.ts)
packages/hub-core/       the hub shared by server and relay: name leases, bus order, trim, expiry (hub.ts),
                         hub protocol frames (protocol.ts), the live document size cap (doc-cap.ts)
packages/relay/          loopback relay for local rooms: discovery file + key, /health, encrypted websockets;
                         serves no page (the plugin ships a file viewer, plugins/room/web/viewer.html)
packages/roomd/          push-only daemon run inside a session: clone -> my overlay; base tracking; share
                         levels; .roomignore, default ignores + size budget; never writes disk
packages/room-mcp/       src/tools/* (one module per concern: join, scope, claims, messaging, files,
                         workers, share, prs; index.ts assembles DEFS), registry.ts (a process holds several
                         rooms), config.ts (arg > env > remembered > default), session.ts,
                         bridge.ts (lead in two rooms), conflict-set.ts, hooks-bridge.ts, prs.ts, graph-index.ts;
                         worker-*.ts (registry, launch, deps: node_modules links, shell-env: ROOM_* scrub, activity);
                         src/parse/ (engine.ts, spec.ts, index.ts, languages/*) is the tree-sitter indexer
packages/agent/          roomagent: on-duty Codex thread fed by chat + interrupts/addressed notifies
packages/web/            read-only room view: participants, overlays with claim gutters, feed, network
plugins/room/            Codex AND Claude Code plugin (both manifests): skills, hooks, bundled MCP server + web/;
                         server/grammars/ contains the shipped tree-sitter grammars
examples/demo-repo/      tiny Python service used in the demo (uv)
scripts/demo.sh          server + shared origin + two clones on one machine
scripts/say.mts          post a message into a person's agent chat and watch the room
scripts/build-plugin.mjs esbuild bundle of room-mcp into plugins/room/server
scripts/build-server.mjs esbuild bundle of the server for the image (`npm run build:server`)
scripts/room-inventory.mts read-only LevelDB pre-flight for the 0.17 cutover (docs/upgrading.md)
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

`plugins/room/hooks.json` is frozen: Codex trusts its hooks by content hash (`[hooks.state]`
in `~/.codex/config.toml`), and a change un-trusts them for every user. Claude Code alone reads
`plugins/room/hooks/claude.json` and does not hash-trust plugin hooks (verified on 2.1.281);
0.15.0 adds `PowerShell` to its before-edit matcher. Keep behavior changes in hook scripts where possible.

- Claude Code 2.1.224+ wakes through its cross-session messaging inbox with plain `claude` (2.1.234+ on native Windows). `plugins/room/bin/claude-room` is an optional channels fallback for older versions. Keep README, onboarding and the join skill aligned when wake behavior changes.
- Hosted server operations (deploy, secrets, opening/closing repos, incidents): `deploy/DEPLOYING.md`.
  Deploy with `--depot=false`; only server/web changes need a deploy, plugin changes need a bundle rebuild + push.

- CI runs these same commands (`npm run typecheck`, `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`, `npm run build -w @room/web`, and `npm run build:plugin`) on every push to `main` and every pull request, and checks that committed plugin assets are up to date.
- The plugin manifests and marketplace entry carry the release version; `package.json` versions at 0.1.0 are private workspace package versions, not the plugin release version. The MCP handshake reads the Claude plugin manifest version.
- `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test` runs every package's vitest suite
  (some suites listen on loopback; inherited ROOM_* variables change identity-sensitive tests).
  Every package has a `vitest.config.ts` that reuses the root `vitest.shared.ts`, so a run from
  `packages/<pkg>` gets the same setup (`isolateTestEnv` clears inherited `ROOM_*`, `CLAUDE_*`, `CODEX_*`,
  `OIDC_*`, git location, worker launch and server variables) as a run from the root.
  A test worker whose event loop stands still for 120 s, or whose file runs past 15 minutes, is reported by
  `[test watchdog]` (`packages/shared/src/test-watchdog.ts`) with the test and the command it waits on, and the
  wait is ended: a blocked synchronous call cannot be timed out by vitest and would otherwise stall the run silently.
- Deliberate scale and responsiveness tests are opt-in: `TEST_SCALE=1 npm test`. The default run skips these large synthetic repositories and soak cases; CI sets `TEST_SCALE=1` so they remain required coverage.
- Release: `npm run bump -- <version>` stamps both plugin manifests, the marketplace entry and the hooks stamp
  (`packages/room-mcp/test/release-version.test.ts` checks they agree and that CHANGELOG has the heading); then rebuild the plugin and tag `v<version>`.
- `npm run typecheck`; `npm run build:plugin` after touching room-mcp, roomd, relay, shared or web
  (the bundle, `plugins/room/web` and tree-sitter grammars are committed; the build copies the
  grammars into `plugins/room/server/grammars`). Installed plugins copy the bundle: reinstall
  `room@room` on both hosts after a rebuild. `node scripts/build-plugin.mjs --skip-web` rebuilds
  only the server bundle (for sandboxes that cannot build the web view); never commit from it.
- Tool descriptions route explicit Room delegation to Room workers. Generic agent, parallel
  or background requests use the host’s normal delegation; being installed or joined is not consent.
  Stay under the budget in `packages/room-mcp/test/tool-budget.test.ts`, regenerate eval mocks
  with `npm run eval:mocks`, and rerun the `claude plugin eval` suite after routing changes. From the repo root, run `claude plugin eval . --scaffold --allow-tools Edit Write`
  (Claude Code 2.1.269+; [eval docs](https://code.claude.com/docs/en/plugin-evals)). Add
  `--trust-plugin` for noninteractive runs. It clones a pinned demo repo and makes model calls.
- A message to a finished worker resumes its retained session in its worktree. A collected or
  discarded worker cannot be resumed. `ROOM_WORKER_MAX_BUDGET_USD` sets the Claude worker
  `--max-budget-usd` cap (documented in the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference)).
- Our release batches assign implementation work to Codex, with the model and effort named
  in each worker request. Room itself sets no default worker model or effort; the host
  chooses when neither the request nor worker environment selects one. Use either the
  codex:codex-rescue subagent or room workers with `host: 'codex'`. Claude plans, writes briefs,
  leads room batches, reviews, integrates and deploys. Codex's sandbox cannot write a git dir
  outside its cwd and cannot listen on sockets: give it a standalone clone (`git clone … /tmp/room-x`,
  `npm install`), expect the socket suites to fail there, and run the full suite yourself before
  merging. A Room worker's worktree needs no install: its `node_modules` links to the lead's packages,
  with `@room/*` pointing at the worktree's own sources (see docs/reference.md, "Workers and previews"). Room batches: one lead (`claude -p` with the room plugin, no ROOM_SERVER) spawns
  Codex workers into worktrees, commits their worktrees itself, previews and octopus-merges.
  The [2026-09-24 Codex host survey](docs/archive/reports/host-survey-2026-09-24-codex.md) reports that
  Codex 0.156.1 (2026-09-23) lists GPT-6 Sol and GPT-6 Luna (the 2026-09-24 batch ran
  codex-cli 0.155.1). Check `model/list` before choosing a model on a different installation.
- Reviews alternate Fable and Codex; six rounds on 2026-09-15 found ~60 issues, none repeated.
- Historical issue rehearsals need a separate curator: check maintainer disposition, reproduce the failure on the pinned baseline, and verify the same assertion passes on a pinned upstream reference before dispatch. A closed issue or linked commit is not sufficient. Keep reference implementations and upstream history out of worker briefs; record supplied hints and any post-freeze review feedback. Report target-code correctness separately from Room coordination, and verify requested checkpoints against raw event order rather than the lead's recollection.
- `scripts/demo.sh` brings up a server and two clones and prints the join commands. Join
  from a clone with plain Codex (`ROOM_SERVER=ws://host:1234 codex --no-daemon`, then `$room-join`) or
  with `npx tsx packages/agent/src/cli.ts --dir <clone>`.
  Codex's shared app-server daemon does not pass your shell's `ROOM_*` variables to Room.
- With no `ROOM_SERVER` or remembered team choice, a session is in a local room
  (`local/<main-worktree basename>`, relay on loopback, discovery in
  `<git common dir>/room/relay.json`). Team rooms are named `<host/owner/repo>` from
  the clone's origin (non-GitHub hosts become `git/<host>/…`); all branches share the
  repository room. A repo must be opened once (`room_create` / `POST /rooms`) before
  that room accepts connections. Without
  `YPERSISTENCE` the server is in-memory: restart it to reset. A dev server needs
  `GITHUB_CLIENT_ID=fake` to log anyone in (test issuer; refused with NODE_ENV=production).
- Ports: server 1234 by default; demo scripts in this repo have used 1244 to avoid a stray
  server from an earlier session.
- Quick tool-level smoke without Codex: call `createTools` / `joinSession` from
  `@room/room-mcp` in a tsx script (see the test in `packages/room-mcp/test/tools.test.ts`).
- For a development checkout, run `npm ci && npm run build:plugin`, then
  `claude plugin marketplace add /path/to/room` or `codex plugin marketplace add /path/to/room`.
  Install `room@room` with the host's plugin command. Public GitHub install and user
  setup live in [README.md](README.md); release changes live in [CHANGELOG.md](CHANGELOG.md).
