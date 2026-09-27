# First trial with real users: plan

Status 2026-09-25: first hosted rehearsal completed with three agents on one shared branch
([results](rehearsal-2026-09-25.md)); findings 1–6 are fixed in 0.16.1. A second rehearsal
with an idle Fly machine and a second GitHub login is still to do. Trial date is not set.
Rule: nothing big merges within 48 hours of the trial.

## What it tests

Whether Room helps three people work on one repository at the same time, and whether it stays out
of the way. Rohan, Kieran and Hrishi, each with their own agent (two on Claude Code, one on Codex),
about 90 minutes, one team room on the hosted server, GitHub login. Nobody coordinates by chat.

## The repository

A fork of [pallets/werkzeug](https://github.com/pallets/werkzeug), rewound to commit `b5a33d286`
(2026-04-11, "clean up old comments (#3157)"), on ONE shared branch named `trial`. Rooms are per
branch today, so everyone must stay on `trial`; repository-level rooms come after the trial
(see `superpowers/specs/2026-09-21-repo-rooms-map.md`).

Why Werkzeug: mid-sized Python (tree-sitter and the symbol graph are strongest there), ships a
`uv.lock`, and the relevant tests (`tests/sansio tests/test_http.py tests/test_wrappers.py`, 282
tests) run in under a second with `uv run --group tests pytest -q …`, so checking work is cheap.

## The three tasks

Three PRs that upstream merged within two weeks of each other, each of which applies cleanly to the
base on its own (checked with `git apply --check --3way`), so the upstream result is the answer key.

| Card | Upstream | Task in plain words | Size upstream | Lands in |
|---|---|---|---|---|
| A | #3158 | Deprecate the `content_md5` header property on `Request` and `Response`: keep it working, warn when used, note it in CHANGES.rst. | 4 files, +69 −22 | `sansio/request.py` ~287, `sansio/response.py` ~379, `tests/test_wrappers.py` |
| B | #3162 | Make header-name capitalisation consistent across the codebase (one convention everywhere headers are read or set). | 18 files, +72 −74 | `sansio/request.py` 239, `sansio/response.py` (10 places), `wrappers/response.py` 763–792, `test.py`, `utils.py`, 8 test files |
| C | #3164 | Generate ETags (and the debugger pin) with SHA3-256 instead of SHA-1, which FIPS 140 forbids. Note that caches may be invalidated. | 5 files, +35 −16 | `http.py`, `debug/__init__.py`, `wrappers/response.py` 786–789, `tests/test_wrappers.py` |

Designed collisions: A and B edit the same two `sansio` files a few lines apart; B and C edit the
same lines of `wrappers/response.py`; all three edit `tests/test_wrappers.py`; C changes
`generate_etag` in `http.py`, which the response wrapper B is editing calls. B is cross-cutting and
should go to whoever is most comfortable.

Task cards are filed as GitHub issues on the fork ("take issue 2"), which also tests step 1 of
"Tasks from issues" in the roadmap. The cards must NOT name the upstream PR numbers, and must say
"do not look at upstream Werkzeug or its changelog": an agent with web access could otherwise copy
the merged answer. The fork's history stops at the base, so nothing local gives it away.

## What is measured

1. How often each person noticed Room at all (each writes a tally mark when they do).
2. Whether warnings arrived BEFORE a collision or after it (from the room's timeline afterwards).
3. Whether the combined `trial` branch passes the 282 tests, and how it compares with upstream's
   result for the three PRs.
4. The exact moment, if any, someone wanted to turn Room off, and why.
5. Anything Room said that was untrue or confusing (quote it).
Keep the room's exported ledger and each person's notes.

## Freeze

Frozen on 2026-09-27 (0.16.24, then the fixes a review and a mixed-sharing rerun found; see CHANGELOG through the latest 0.16.x), after these rehearsals:
- [Werkzeug](rehearsal-2026-09-25.md);
- [httpx at declared sharing](rehearsal-2026-09-26-httpx.md);
- [click at full sharing](rehearsal-2026-09-27-click.md);
- [httpx rerun at mixed sharing](rehearsal-2026-09-26-httpx.md#rerun-at-mixed-sharing-on-0162801629-2026-09-27): full, declared and plans only together.

It is also frozen after the [design audit](audit-2026-09-27-design.md), whose post-trial work waits for after the trial. Nothing merges within 48 hours of the trial unless a rehearsal or live check blocks on it.

## Before the day

- [ ] Rohan confirms the repo choice and creates the fork (public, under rohanz); `trial` branch at
      the base; three issues filed; Kieran and Hrishi added as collaborators (Room admits by push access).
- [x] First hosted rehearsal: two Claude Code agents and one Codex agent, three clones, cards A–C
      at the same time. All used the owner's GitHub login; see the [results](rehearsal-2026-09-25.md).
- [ ] Second hosted rehearsal: let the Fly machine idle first, then join with at least one other
      GitHub login to check wake-up and first-login behaviour.
- [x] Fix only what the rehearsals find (done through 0.16.24), then the 48-hour quiet period.
- [x] Fresh-install simulation up to login ([results](fresh-install-2026-09-27.md)).
- [ ] On the day, check `codex --version`. Codex 0.157 runs sessions through a shared app-server daemon; 0.16.24 handles it, but re-check it on newer versions.
- [ ] Fly set to always-on the day before (`min_machines_running = 1`), back to stop-on-idle after.
- [ ] Friend checklist sent: the two install commands per host; Claude Code 2.1.224 or later
      (`claude --version`; 2.1.234 on native Windows); trust the hooks in Codex when asked,
      "say: join the room", follow the login
      code, stay on `trial`, `uv run --group tests pytest -q tests/sansio tests/test_http.py tests/test_wrappers.py`;
      when your task is done, say: **“commit and push it to trial”**.

### Friend checklist (ready to send)

> **Before the day**
> 1. You need git, Node.js 22 or later (`node --version`), `uv`, a GitHub account with access to the
>    trial repo, and Claude Code 2.1.224 or later (`claude --version`; 2.1.234 on native Windows) or Codex.
> 2. Install Room:
>    - Claude Code: `claude plugin marketplace add rohanz/room && claude plugin install room@room`
>    - Codex: `codex plugin marketplace add rohanz/room && codex plugin add room@room`
> 3. Clone the trial repo and check out `trial`.
>
> **On the day**
> 1. Start your agent in the clone as usual. In Codex, accept the prompt to trust Room's hooks.
> 2. Say **"join the room"**, open the login link it gives you, and enter the code.
> 3. Say **"take issue N"** (your issue number). Talk to your agent normally; you don't need Room words.
> 4. When it's done, say **"commit and push it to trial"**. If it asks before pulling or rebasing, that's
>    expected: say yes if the summary looks right.
> 5. Afterwards, tell Rohan anything that confused you or felt slow.

## On the day

Everyone clones the fork, checks out `trial`, starts their agent, says "join the room", then
"take issue N". Commit and push to `trial` when a task is done; the second and third pushers pull
first, which is where merge previews should earn their keep. Rohan keeps the browser view open and
does not steer anyone with it.

## First two-person run, 2026-09-27

Rohan (Claude Code) and a second person (Codex, own GitHub login, own machine) worked on `rohanz/click-rehearsal` branch `pair`, issues #2 and #1, which overlap in `core.py`.
- **Join and login:** both worked with no help.
- **Coordination:** the Codex agent asked first which regions each would touch. Rohan's agent answered within 15 seconds and flagged one dependency. Both claimed exact, non-overlapping ranges.
- **Combined checks:** both previewed the combined code with the full test suite: no conflicts, all passing. Both finished in about three minutes.
- **Not done:** the simultaneous push and the answer-key check were left for another time.
- **To ask:** the second person's clone shared an unrelated untracked `excalidraw.log` at full sharing. Did the join disclosure tell them?
