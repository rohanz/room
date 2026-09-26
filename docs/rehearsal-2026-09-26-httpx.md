# Rehearsal: httpx at `declared` sharing, 2026-09-26

Second codebase after Werkzeug (docs/rehearsal-2026-09-25.md), run at the tier below full sharing. Plan
and cards: docs/rehearsal-httpx-plan.md. Room 0.16.13 (installed), server on Fly v66, Claude Code
2.1.283, codex-cli 0.157.1 (default model GPT-6-Astra medium).

## Setup

- Private repo `rohanz/httpx-rehearsal`, default branch `rehearsal`, snapshot 88b5c0a (tree of upstream
  15d09a3, 2023-04-19). Issues #1–#3 are cards A–C. The check passes 237 tests at the base.
- Three clones, three sessions, driven in plain words the way a person would:
  - Ana: Claude Code, card A (percent-encoding in `quote()`);
  - Ben: Claude Code, card B (`InvalidURL` messages);
  - Cy: Codex, card C (per-component safe characters).
- All three cards edit `httpx/_urlparse.py` and `tests/test_urlparse.py`.

## Timeline (local time)

- 21:54 Ana: "open a room for this repo and join it". She opened the repo on the server and joined the
  `rehearsal` room at the default level (full), and was told how to narrow sharing.
- 21:57 Ana: "actually, only share the files I'm working on". Sharing went to declared. An untracked
  `uv.lock` (made by my setup) stopped being shared.
- 21:58–21:59 Ben and Cy: "join the room, and only share the files I'm working on". Each joined at
  declared with nothing shared yet, and asked what they would work on.
- 21:59 Each got: "take issue #N on github (rohanz/httpx-rehearsal) and fix it. don't commit yet".
- 22:01–22:02 All three finished:
  - Each declared its files and claimed only the lines it changed.
  - Cy asked Ben to keep clear of its lines, and Ben answered with his exact line ranges.
  - Every combined preview was conflict-free; the last ones passed 244 tests.
- 22:01 Ana flagged that card A's second example contradicted its first. The fault was mine: the value
  is the whole URL `http://example.com?q=foo%2Fa`, not the query `q=foo%2Fa`. She asked me to confirm
  instead of guessing. After my correction she changed only the test (22:03); the fix already gave the
  intended output.
- 22:03 All three were told "commit it and push to the rehearsal branch" at the same moment:
  - Ben pushed first (fast-forward).
  - Cy ran `git pull --ff-only --autostash`, reran the check, and pushed.
  - Ana's push was rejected. The ff-only catch-up refused because her commit diverged, and she stopped
    and asked before rebasing. On "yes, rebase and push" she rebased onto both (no conflicts), got 244
    passing and pushed (22:04).
- 22:05 Issue #3 closed on request; #1 and #2 closed from their commit messages.

About five minutes from assignment to three pushed fixes. No agent fetched upstream httpx; the only
`encode/httpx` strings in their logs are links inside the repo's own files.

## Result

- `rehearsal` = f949b40 (#2), a9f1397 (#3), c413a4d (#1). A fresh clone passes the check with 244 tests.
- **Answer key:** I replaced every test file upstream changed between 15d09a3 and ee432c0 with
  upstream's version, and ran the check on our code: **243 passed**, the planned count. The fixes meet
  upstream's own tests, not only the agents'.

## What declared sharing did

- Nothing was shared until a task declared its files.
- Only the declared source and test files were visible to teammates; untracked files never were.
- The merge previews still saw every teammate's changes to the shared files, including Ben's after he
  had finished. Retained declared paths keep a changed file shared after its scope ends. That is what
  made the previews complete.

## Findings

1. **The join note offered the level you were already on.** At declared it read "this clone now shares
   only the files in your declared area …; to share only my declared files, say: only my declared
   files". It should offer only narrower levels.
2. **`room_done` hid retained files.** At declared its reply said "scope cleared", and Ben told his
   human "nothing of mine is shared from here on". Teammates' previews were still using his changed
   files, correctly. The reply should say which changed files stay shared, and until when (commit or
   revert).
3. Not reproduced: Ben's join summary mentioned an untracked `uv.lock` about 20 s after I deleted it.
   The check command recreates `uv.lock` in each clone (`uv run` with the project's pyproject), so every
   agent kept seeing one later and correctly left it out of commits.
4. Card error (mine, not Room's). Ana caught it and asked instead of guessing; this was the clearest
   user-control moment of the run.

Fixes 1 and 2 are below.

## Fixes (0.16.14)

- Findings 1 and 2 were implemented by Codex (gpt-6-sol, medium) in 7c65076:
  - the join disclosure offers only narrower levels;
  - at declared, `room_done` lists the changed files that stay shared until they are committed or
    reverted.
- The full suite passed three times (1667 tests), with typecheck and knip clean.
- The live check on 0.16.14 passed: after finishing, Ben said "httpx/_urlparse.py stays shared until you
  commit or revert it", and after a revert he said nothing was shared.
- The Astra review of 0.16.14 found that `room_done` read an unreconciled retained set: an unpublished
  first edit was dropped when the scope cleared. It also found that `room_share` could say "nothing is
  shared" while retained files were, and that the README was stale. 0.16.15 fixes all of them, with
  real-daemon tests.
