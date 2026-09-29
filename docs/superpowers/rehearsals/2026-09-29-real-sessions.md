# Real-session rehearsal of 0.17, 2026-09-29

Branch `redesign`. The Claude sessions and the final Codex session ran the plugin bundle built at `b397609`, and
the Codex session also had `dd91a2c`'s allow-list fix. The server ran from the `9a35865` checkout; later commits
do not touch `packages/server`. Machine: macOS (Darwin 25.5), Claude Code 2.1.284, codex-cli 0.158.0 (the shared
app-server daemon was 0.159.0). This rehearsal used real host sessions driven in plain words, not stand-in MCP clients.

## Setup

- **Server.** A local dev server: `GITHUB_CLIENT_ID=fake PORT=1294 HOST=127.0.0.1 YPERSISTENCE=/tmp/lead7/srv-data`,
  started from `packages/server` with `npx tsx src/index.ts`. Four fake logins (ana, ben, cy, obs) were minted with
  `/auth/device` + `/auth/poll {fakeLogin}` and written to per-person `ROOM_CREDENTIALS` files. Nothing was deployed.
- **Repository.** The private `rohanz/httpx-rehearsal` repo (snapshot `88b5c0a` of httpx 15d09a3). Two new branches,
  `r17-a` and `r17-b`, were pushed from `88b5c0a`. The clones were:

  | Person | Host | Clone | Branch |
  |---|---|---|---|
  | ana | Claude Code, `claude --plugin-dir /tmp/room-redesign/plugins/room` | `/tmp/reh-httpx-ana` | r17-a |
  | ben | Claude Code, same, declared sharing | `/tmp/reh-httpx-ben` | r17-b |
  | cy | Codex, installed branch plugin, `codex --no-daemon -c marketplaces.room.source="/tmp/room-redesign"` | `/tmp/reh-httpx-cy` | r17-a |

  Each session had `ROOM_SERVER=ws://127.0.0.1:1294` and its `ROOM_CREDENTIALS`. Claude sessions also had
  `--settings '{"enabledPlugins":{"room@room":false}}'` so that only the branch plugin loaded. cy had
  `ROOM_IDLE_LEASE_MS=120000`. No folder-trust prompt appeared for any clone.
- **Cards.** These were the httpx plan's cards (`docs/rehearsal-httpx-plan.md`): ana A, ben C, cy B. ben's card also
  asked him to improve `quote()`'s docstring, which sits in ana's lines, to provoke a claim conflict. Every card
  ended with the check command and "work from this repository only".
- **Observer.** A read-only `y-websocket` client with the `obs` login and no awareness dumped the room document
  six times (`manifest`, `manifestHead`, `bus` and the other roots). The dumps were used for the privacy and
  notice evidence below.

## Results

| Check | Result |
|---|---|
| Two people on different branches see each other, preview across branches, and get a cross-branch conflict notice when they claim near the same lines | **PASS** |
| Declared sharing reveals only paths and state outside the area (no hashes) | **PASS** |
| P2: a Codex finish produces no replayed messages | **PASS** (behaviour in two finish → next-turn cycles) |
| P3: a quit Codex session leaves the room within the idle rule | **PASS** (left immediately at host exit) |
| P7: previews are marked PARTIAL when a teammate's work is held | **PASS** |
| P8: a preview after a teammate pushes works without a manual fetch | **PASS**, with a wording note (F4) |
| Answer key: upstream's final test files on the combined branches | **243 passed** (planned 243) |

### 1. Two branches, one repository room: PASS

ana opened the room: "I opened a team Room for github.com/rohanz/httpx-rehearsal on the server at
ws://127.0.0.1:1294 and joined it as ana's agent, on branch r17-a." ben's session joined automatically at start and
said: "Who's here: ana's agent (on r17-a, no task declared) and you (on r17-b)." cy (Codex, r17-a) joined the same
room: `cy's agent joined github.com/rohanz/httpx-rehearsal`.

These are cross-branch claim notices, verbatim from the bus. ben is on r17-b and ana on r17-a:

```
cf:1288…:1          conflict  room -> ben : you edited httpx/_urlparse.py inside ana's claim (quote: Card A: change when '%' is treated as already-escaped in quote() body (signature unchanged))
cf:1288…:1:holder   conflict  room -> ana : ben edited httpx/_urlparse.py inside your claim (quote: …)
cf:1288…:1:clean    conflict  room -> ben : httpx/_urlparse.py: the conflict with ana cleared
cf:827d…:1          conflict  room -> ben : you edited httpx/_urlparse.py inside ana's claim (is_quoted: Card A follow-up: only treat escapes of unreserved chars or '/' as redundant (fixes %40/%3A/%5B double-escaping))
cf:827d…:1:clean    conflict  room -> ben : httpx/_urlparse.py: the conflict with ana cleared
```

ben's pane: "The last piece is the quote() docstring. It sits inside ana's claimed range, though she handed the
docstring to me." cy's claims told both teammates: `notified ana's agent (scope urlparse covers httpx/_urlparse.py)`,
`notified ben's agent (scope urlquoting covers httpx/_urlparse.py)`.

These are cross-branch previews, as bus notes:

```
ana : merge preview with ben, cy: no conflicts across 3 path(s); "uv run … pytest … tests/test_urlparse.py tests/models" passed
ben : merge preview with ana, cy: no conflicts across 4 path(s); "uv run … pytest …" passed
cy  : Combined preview with your current tests and ben's edits merged cleanly but failed 5 escaping tests … apparently because your quote implementation is not shared yet.
```

cy's preview ran while ana's tests were ahead of her code, so its test failure was genuine. The agents then
negotiated the A/C interaction (double-escaping of `%40`, `%3A` and `%5B`) through room notes, and each asked its
human once. The combined tree passed 256.

### 2. Declared sharing: PASS

ben chose "I only want to share my declared files". His head was
`level: "declared", textPrefixes: ["CHANGELOG.md", "httpx/_urlparse.py", "tests/test_urlparse.py"]`. The lead then
wrote `NOTES-ben.md` by hand in ben's clone, outside that area. The manifest entry the observer read was:

```
NOTES-ben.md {"change": "A", "state": "held", "at": 1790676526186.625, "fence": "3755319133995009", "held": "scope"}
```

The entry has no `hash`, `size` or `baseHash`. The path appears only under `manifest`, and not in `overlays`,
`graphs`, `basetextFlat` or `conflicts`. The file's text ("release timing") appears nowhere in the document. Earlier,
`uv run` had created a `uv.lock` in ben's clone. The only thing peers learned about it was the path and state:
`merge-conflict room -> ana : ben changed uv.lock too, outside their declared area; Room cannot check this merge`.

### 3. P2, a Codex finish produces no replayed messages: PASS

cy finished card B (`room_done`: "marked done (urlerrors); released 3 claim(s), scope cleared. You remain in the
room."). It then got two follow-up turns, each after a finished turn. Both turns called `room_state` and showed
only new items:

```
› Anything new from my teammates since you finished? Just tell me, don't change code.
• Called room.room_state … • Yes: Ana finished Card A’s percent-escaping fix and tests. …
› Any messages from teammates I should know about? Don't change anything.
• Called room.room_state
  └ [pushed:ana:88b5c0a…:58b3d34…] [notify] ana's local commits 88b5c0a..58b3d34 are now on origin/r17-a …
    [pushed:cy:58b3d34…:8700548…] [notify] cy's local commits 58b3d34..8700548 are now on origin/r17-a …
• No new teammate messages since your push. There are no open claims or uncommitted changes in the room.
```

Neither turn re-delivered a note it had already received. This grade is behavioural: the Codex TUI does not display
the text a hook injects.

### 4. P3, a quit Codex session leaves the room: PASS

`/quit` was sent at 18:15:58. cy's MCP log:

```
2026-09-29T10:15:58.125Z pid 8641: stopping: SIGTERM
2026-09-29T10:15:58.182Z pid 8641: name lease on cy ended; coordination paused
```

The observer read cy's holder record as `{"pid": 8641, …, "ended": "released"}`. At 18:16, ana's `room_state` listed
`cy │ offline │ — │ finished Card B`. Presence ended when the host exited, well inside the idle lease
(`ROOM_IDLE_LEASE_MS=120000`).

### 5. P7, PARTIAL when a teammate's work is held: PASS

This is ana's preview while `NOTES-ben.md` was held:

```
ana : partial preview with ben, cy: ben NOTES-ben.md: changed by ben, outside ben's declared area; command "uv run … pytest …" …
```

### 6. P8, a preview after a teammate pushes, without a manual fetch: PASS

ben committed card C as `2892c74` and pushed it to r17-b; the bus then carried `pushed:ben:88b5c0a…:2892c74…`, and
ben's head changed to `base: 2892c74…`. Before anyone previewed, ana's clone already contained `2892c74`, but
`origin/r17-b` still read `88b5c0a` and there was no `FETCH_HEAD`. Room had fetched the commit by SHA
(`roomd/src/base.ts`: `git fetch --no-tags --no-write-fetch-head origin <sha>`). ana was asked "ben just pushed his
work. Preview how my changes merge with ben's". The result was:

```
ana : merge preview with ben: no conflicts across 3 path(s); "uv run … pytest … tests/test_urlparse.py tests/models" passed   (256 tests)
```

ana checked the same result independently in a throwaway worktree on `2892c74` (256 passed). **F4 (wording):**
ana said "Because ben's work is now committed, it didn't clearly show which version of ben's work it used." The
preview line does not name the teammate's commit it used.

### 7. Pushes on a shared branch

ana pushed `58b3d34` to r17-a. cy then ran `git pull --ff-only --autostash` ("Applied autostash", 253 passed),
committed `8700548` and pushed `58b3d34..8700548`. There was no merge commit or rebase.

### Answer key

Clone r17-a (`8700548`) and merge `origin/r17-b` (`2892c74`); `_urlparse.py` and `test_urlparse.py` auto-merge. The
agents' tests pass: `256 passed`. Replacing upstream's changed test files at `ee432c0` (`tests/test_urlparse.py`,
`tests/models/test_responses.py`, `tests/test_decoders.py`) gives `243 passed in 0.30s`, which is the planned count.
The fixes meet upstream's own tests.

## Findings

- **F1 (fixed in `365eac7`, merged at `bc4c094`).** `room_create(where="team")` went to the hosted server
  (`wss://room-rohanz.fly.dev`) although `ROOM_SERVER` was set; the room-join skill tells agents to pass
  `where="team"`. ana's first attempt started a GitHub device login against the hosted server (code 35D8-8135). It
  was interrupted with Esc; no login completed and nothing was created. `3c9598d` had fixed only the no-`where`
  case. After the fix, the same plain-words request opened the room on `ws://127.0.0.1:1294`.
- **F2 (host behaviour, Codex 0.158/0.159).** A plain `codex` TUI runs through the shared app-server daemon, which
  spawns plugin MCP servers with the daemon's own environment. Its log read "room: local (default: nothing
  configured)", so the launching shell's `ROOM_SERVER` and `ROOM_CREDENTIALS` never arrived. The daemon also
  re-synced `room@room` from its configured marketplace source (the main checkout, 0.16.39), replacing the 0.17.0
  cache install. That first cy session therefore ran 0.16.39 and joined the **hosted** branch room
  `github.com/rohanz/httpx-rehearsal/r17-a` with the default credentials, with 0 changed paths and no text. It left
  a minute later through `room_leave`. `codex --no-daemon` fixed both problems. The README's
  `ROOM_SERVER=… codex` instruction does not work under the daemon, and the docs should say so.
- **F3 (fixed in `dd91a2c`).** `plugins/room/codex-mcp.json`'s `env_vars` allow-list lacked `ROOM_IDLE_LEASE_MS`,
  `ROOM_AUTO_FETCH`, `ROOM_GIT_TIMEOUT_MS`, `ROOM_WORKER_MAX_BUDGET_USD` and `ROOM_WORKER_NICE`, so a Codex-hosted
  MCP never saw them. `codex-env.test.ts` now asserts them.
- **F4 (wording, open).** A preview after a teammate pushes does not name the teammate commit it used.
- **Side effect of the temporary install.** Another of Rohan's sessions started a `codex exec` in `/tmp/room-f40`
  (branch `fix-0.16.40`) at 18:11:55, while 0.17.0 was installed. Its Room MCP (pid 32440) loaded 0.17.0 and opened
  a 0.17 local room there: `local room local/room-f40: started relay …; hub: incarnation 1790676715`. That clone was
  left untouched. The MCP keeps 0.17 in memory until that exec ends, and its cache directory is gone.
- **Claude Code prompts.** `--allowedTools 'mcp__plugin_room_room__*'` and `'mcp__plugin_room_room'` did not
  pre-approve the plugin's `room_create`, which prompted every time. ana was switched to auto mode for the session
  after repeated compound-command prompts.

## Codex plugin: before, during, after

Before (`codex plugin list`, `codex plugin marketplace list`):

```
Marketplace `room`
/Users/rohan/Documents/progwork/aitinkerhackathon/.agents/plugins/marketplace.json
room@room  installed, enabled  0.16.39  /Users/rohan/Documents/progwork/aitinkerhackathon/plugins/room
room                    /Users/rohan/Documents/progwork/aitinkerhackathon
```

For the install, the override applied to that one command only; the marketplace config was not changed:

```
$ codex plugin add room@room -c marketplaces.room.source="/tmp/room-redesign"
Added plugin `room` from marketplace `room`.
Installed plugin root: /Users/rohan/.codex/plugins/cache/room/room/0.17.0
```

Restore, at 18:16:22:

```
$ codex plugin remove room@room
Removed plugin `room` from marketplace `room`.
$ codex plugin add room@room
Added plugin `room` from marketplace `room`.
Installed plugin root: /Users/rohan/.codex/plugins/cache/room/room/0.16.39
$ codex plugin list | grep room@room
room@room  installed, enabled  0.16.39  /Users/rohan/Documents/progwork/aitinkerhackathon/plugins/room
$ grep '"version"' ~/.codex/plugins/cache/room/room/*/.codex-plugin/plugin.json
  "version": "0.16.39",
```

`~/.codex/config.toml` still has `[plugins."room@room"] enabled = true`, `[marketplaces.room] source =
"/Users/rohan/Documents/progwork/aitinkerhackathon"` and the same two `hooks.state."room@room:…"` trusted hashes.
`plugins/room/hooks.json` is byte-identical to main's.

## Cleanup

The tmux sessions `reh-ana`, `reh-ben`, `reh-cy` and `reh-srv` were closed, and the server on :1294 was stopped.
The clones `/tmp/reh-httpx-{ana,ben,cy}`, `/tmp/lead7` (server data, creds, dumps, answer-key files) and the
observer script were removed after this report was written. The `r17-a` and `r17-b` branches remain on the private
repository.
