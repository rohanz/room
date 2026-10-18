CONTEXT. Repo: the Room repo, branch `redesign` (0.17.0: one room per repository, hub, ledger, manifest, registry; rehearsal fixes done and signed off). This is the RELEASE-READINESS batch for 0.17.0: make Room easy for other people to install and use. Rohan (the human) approved the goals: install straight from GitHub by default; a clean README and docs; `room doctor`; every tool and skill description says clearly when to use it.

Read first: AGENTS.md (contributor rules; the "Running and testing" section is binding), then your own brief. Host facts verified by the lead on 2026-09-30 (saved under /tmp/room-hostdocs: Codex release notes and PRs, Claude Code CHANGELOG.md and llms.txt; you have no network, read those files instead):
- Both hosts install from GitHub: `claude plugin marketplace add rohanz/room && claude plugin install room@room`; `codex plugin marketplace add rohanz/room && codex plugin add room@room` (Codex also accepts `owner/repo@ref` and `--ref <REF>`).
- Codex reads hook definitions from the marketplace source and runs the MCP server from its plugin cache (observed on 0.158); they can drift between `codex plugin marketplace update` and a reinstall.
- Codex 0.159.0 (2026-09-29) adds opt-in `instant_interrupt` (PRs 48135, 48141: new user input preempts a model response). Codex 0.159.1 (2026-09-29) makes `gpt-6.1-sol` the default bundled model. This machine has codex-cli 0.158.0 and Claude Code 2.1.285; Node v22.14.0.
- Claude Code 2.1.224 (2026-08-07) wakes idle sessions through cross-session messaging (2.1.234 on native Windows); plugin hooks are not hash-trusted (verified 2.1.281).

Rules:
- Stay inside your OWNED FILES. If you must touch another file, keep it minimal and name it in room_done; ask the lead (room_send type=question) when unsure. Other workers own the rest.
- Do NOT edit plugins/room/hooks.json or plugins/room/hooks/claude.json (frozen). Never edit ~/.claude or ~/.codex; never read credential files, auth.json or Keychain entries (reading ~/.codex/config.toml for hook trust state is fine).
- Do not rebuild the plugin bundle (plugins/room/server, plugins/room/web); the lead does. Do not commit (the lead commits).
- Tests assert on events and ordering, never wall time. You cannot open sockets: socket-listening suites fail for you; say which ones you could not run and the lead runs them.
- Run `npm run typecheck` and your packages' vitest files (`npx vitest run <files>` from the package dir, under `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER`). Keep `npx knip` clean for what you add.
- Wording: plain, short sentences a newcomer understands; name host versions when you rely on a host feature. Match the surrounding code's style and comment density.
- Finish with room_done: what changed, tests run and their result, what you could not run, and any decision the lead must rule on.
