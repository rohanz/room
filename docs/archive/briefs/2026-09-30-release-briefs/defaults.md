YOUR AREA (tag defaults): make every default explicit to users (Rohan's request, part of the docs item).

Principle (Rohan): Room doesn't silently choose for people. Where a default is unavoidable, it is stated plainly, visible when it takes effect, and one sentence away from changing.

OWNED FILES: README.md, docs/reference.md, docs/onboarding.md, and ONLY the user-facing text of the first-team-join disclosure and the room_state header lines (find them: grep "shares the full text" / "share plans only" / sharingDescription in packages/room-mcp/src/{config,tools/join,tools/scope,tools/share,session}.ts) plus their tests. Do NOT edit tool DESCRIPTION strings, skills, prompt.ts or evals (the `split` worker owns those).

1. Add a "Defaults, and how to change them" section near the top of README.md (right after the quickstart's first-session part; mention it in one line in the quickstart). A table, one row per default: what it is, what it means in plain words, how to change it in plain words (what to say to the agent) and by argument/env. Cover at least:
   - sharing level: `full` by default; say exactly what full shares (full text of files you change, to members of the team room, on every branch); "share plans only" (intent) / "only my declared files" (declared); room_share / ROOM_SHARE; the server ceiling.
   - local vs team room: local by default, nothing leaves the machine; "join the room" / "work locally"; ROOM_SERVER; remembered per clone; `room_leave(forget=true)`.
   - worker model and effort: the host's own default; pass-through when named in the request; ROOM_WORKER_MODEL / ROOM_WORKER_EFFORT and per-host ROOM_CODEX_WORKER_* / ROOM_CLAUDE_WORKER_*; the spawn reply names what runs.
   - worker count cap (ROOM_MAX_WORKERS, default 8), worker compute budget (ROOM_WORKER_THREADS), Claude worker cost cap (ROOM_WORKER_MAX_BUDGET_USD, unset by default).
   - wake behaviour (ROOM_WAKE auto/channels/off; what auto does on each host).
   - the idle lease (ROOM_IDLE_LEASE_MS, default 30 min; what it means).
   - `.roomignore`, default ignores and the size budget (find the real defaults in packages/roomd/src: grep roomignore, DEFAULT_IGNORES, size budget constants).
   - preview cache (ROOM_PREVIEW_CACHE_GB, default 4, 0 off).
   - carry of uncommitted work into workers (default on; `carry=false`), links (.roomlinks).
   - anything else with a default you find (grep `process.env.ROOM_` in packages/*/src; the automatic tag like `rohanz+claude`; ROOM_AUTO_FETCH; ROOM_STALE_DAYS; ROOM_LEGACY_DAYS on the server). Verify every default value in code.
   Keep reference.md's env table consistent (link to the README table rather than duplicating prose).
2. Check that the first team join and `room_state` both state the current sharing level AND how to change it in one sentence. Keep what exists; fill gaps. If room_state's header only names the level, add the one-line how-to-change (keep it short: room_state output is read on every call). Update the tests that pin those strings.
3. List every remaining SILENT default you find that should be the user's choice (something Room decides without telling the user when it takes effect). For each: either make it visible where it takes effect (a short line in the relevant tool reply) if that is a small, safe text change within your owned files, or list it in room_done for the lead to rule on. Do not change behaviour (what Room does); only what it tells the user.

Tests: the tests that pin join/state strings (grep packages/room-mcp/test for the strings you change), `npm run typecheck`.
