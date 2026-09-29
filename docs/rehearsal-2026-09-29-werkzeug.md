# Rehearsal: Werkzeug at full sharing, 2026-09-29

A rerun of the first rehearsal ([2026-09-25](rehearsal-2026-09-25.md)) on Room 0.16.37, driven the same way:
plain words typed into three interactive sessions.

## Setup

- **Versions:**
  - Room 0.16.37: Claude Code loads it from the repository's directory marketplace, and Codex's plugin cache holds 0.16.37.
  - Hosted server on Fly v67.
  - Claude Code 2.1.284 (Opus 5.5, auto mode).
  - codex-cli 0.157.1 (GPT-6-Astra medium). **Its sessions run through the shared app-server daemon, which is 0.158.0** (`~/.codex/packages/app-server-daemon/releases/0.158.0…`, running since 2026-09-28).
- **Repository:** private `rohanz/werkzeug-rehearsal`, with a new branch `rehearsal-0929` at the snapshot 9a5464f (upstream b5a33d286). Issues #1–#3 are cards A–C of [trial-plan.md](trial-plan.md).
- **Sessions:** three fresh clones at `/tmp/reh-werkzeug-{ana,ben,cy}`, each in its own tmux session:
  - Ana: Claude Code, issue #1.
  - Ben: Claude Code, issue #2.
  - Cy: Codex, issue #3.
- **Sharing:** full for all three, the default and what the trial uses.
- **Login:** the stored Room credentials; no device code was needed.
- **Folder trust:** each host asked to trust its new folder on first start, and I answered as a user would.

## What was typed

| Time | Who | Typed |
|---|---|---|
| 11:13:05 | Ana | join the room |
| 11:13:23 | Ben, Cy | join the room |
| 11:13:54 | all | take issue 1 / take issue 2 / take issue 3 |
| 11:15:47 | Ana | commit and push it |
| 11:18:56 | Ben, Cy | commit and push it (at the same moment) |
| 11:20:50 | Ana | we're done for today. save the room's full history to room-history.md in this folder |

## Timeline

- **11:13 Joining.** Each agent joined `github.com/rohanz/werkzeug-rehearsal/rehearsal-0929` in 11–13 s. Ana was "rohanz's agent"; Ben and Cy were "rohanz+claude" and "rohanz+codex", and each said why.
- **11:14 Scopes.**
  - All three declared a scope within 40 s of "take issue N".
  - Cy told Ana which part of `CHANGES.rst` it would take.
  - Ana told Ben to leave the new `content_md5` code alone.
- **11:15:30 Ana finished,** 1 min 36 s after the assignment.
  - Her combined preview with the check passed, but it covered only 5 paths: Ben had not edited anything yet.
- **11:15:59 First push:** Ana pushed 825a384, 2 min 5 s after the assignment.
- **11:16:06 Ben caught up** with `git pull --ff-only --autostash`, as Room tells him to.
  - **7 s later Room released all five of his claims,** saying "that code changed in 825a3845d2" (finding 1).
  - It released Cy's two claims the same way when Cy pulled at 11:16:19.
- **Questions.** Ben asked Cy twice for lines inside Cy's claim (11:15, 11:16). Cy answered both within 25 s, and Ben edited only after each yes.
- **11:16:43 Cy finished** (room_done). **11:17:06 Ben finished,** and his last preview passed 633 tests.
  - Cy was then woken five times for things it had already handled (finding 3).
- **11:18:56 Ben and Cy were told to push at the same moment.**
  - Ben pushed 6d45e39 as a fast-forward.
  - Cy pulled Ben's commit with `--ff-only --autostash` before committing, reran 311 tests and pushed 8ef989c at 11:19:49. Neither push was rejected.
  - 10 s after Cy's push, Codex delivered the base notice for Ben's commit, which said "You have uncommitted work" (finding 3).
- **11:21 Ana saved the history** (34 lines) and left the room.

## Scorecard

| | |
|---|---|
| Assignment to first push | 2 min 5 s (Ana, 11:15:59) |
| Assignment to last push | 5 min 55 s (Cy, 11:19:49) |
| Conflicts | none, textual or semantic |
| Questions | 2 asked (Ben → Cy), 2 answered within 25 s, both as answers to the question |
| Previews | Ana 1, Ben 2, Cy 3 (plus 1 after pushing); all conflict-free with tests passing |
| Rejected pushes | 0 |
| Human interventions | none beyond the typed lines above |

## Result and answer key

- `rehearsal-0929` = 825a384 (#1), 6d45e39 (#2), 8ef989c (#3).
- A fresh clone passes the check (284) and the whole suite (990).
- **Answer key: 505 of 505 pass.**
  - The key holds upstream's test changes from #3158, #3162 and #3164, each PR's own diff (`git diff <merge>^1 <merge> -- tests`), applied to the snapshot's tests. That changes 8 files.
  - Upstream's only test change for #3158 removes the `content_md5` assertion, so I added four tests:
    - `content_md5` warns and still works on `Request`;
    - the same on `Response`;
    - `generate_etag` is SHA3-256;
    - `werkzeug.debug` does not use SHA-1.
  - At the base, 6 of these tests fail. With upstream's three source diffs applied, all 505 pass.

## Findings

1. **A teammate's push released claims whose code had not changed. This is the one that matters.**
   - Ben ran the catch-up Room prescribes (`git pull --ff-only --autostash`, 11:16:06). At 11:16:15 his inbox held five notices from `room [bot]`, "released your claim on src/werkzeug/sansio/response.py:120-330: that code changed in 825a3845d2", and the same for `response.py:430-700`, `request.py:238-242`, `utils.py:540-546` and `tests/test_wrappers.py:910-955`.
   - Ana's commit touched none of those ranges. Its hunks were `request.py` 34, 288, 297–302; `response.py` 33, 380, 387; `utils.py` 150–186; `test_wrappers.py` 797–828.
   - Cy lost `tests/test_wrappers.py:510-560` and `CHANGES.rst:60-64` the same way after its own pull.
   - Ben kept editing inside the released ranges with no claim, and told his human "the new room notes only say my claims were released when the base moved".
   - **Suspected cause:** `reanchorOwnClaims` (`packages/roomd/src/index.ts:903`) runs when HEAD moves. It compares each claim's `claimedHash`, which was taken over the agent's edited overlay text, with the text it reads at that moment. During `--autostash` the working tree is briefly clean (HEAD text), so every claim over edited lines "changed".
   - This fits the evidence: both agents were mid-edit inside their claims when they pulled. It is not yet reproduced in a test.
2. **The before-edit hook warns on commands that edit nothing.**
   - Ana and Ben received "[room] Claim before editing: …" 18 times. Triggers included `grep -n "^def test" tests/test_wrappers.py`, `sed -n`, every `pytest` run, and `git add … && git commit`.
   - At the commit, the warning listed a dozen entries such as "rohanz+claude has changed on src/werkzeug/sansio/request.py". "Has changed on" is also ungrammatical.
   - Ana had to explain it to her human after pushing: "The warning that showed up during the push is just their existing claims on files I named in the command; committing and pushing didn't edit any of their line ranges."
   - **Suspected cause:** the PreToolUse Bash matcher treats any file path named in a command as an edit.
3. **Codex was woken five times for messages it had already handled, and the last notice was false.**
   - Cy answered Ben's first question at 11:15:57 (it saw it inline in a tool result), and the second at 11:16:43. It pulled Ana's base at 11:16:19.
   - After its turn ended at 11:16:49, Codex delivered each of them again as a new turn: the first question (11:16:50), Ana's base notice (11:17:01), two claim releases (11:17:35, 11:17:44) and the second question (11:17:51).
   - Each wake cost a turn in which Cy re-checked and said "already approved" or "already up to date".
   - At 11:19:59, after Cy had pulled Ben's commit and pushed on top of it, it was told "rohanz+claude moved the base to 6d45e3976e … You have uncommitted work. Run git pull --ff-only --autostash". Its tree was clean.
   - This is the known stale-notice case (Werkzeug finding 9, click finding 3), and it now covers questions too. Room marks base notices seen when HEAD moves, but Codex's queued turn was built before that, and answered questions are not withdrawn from the queue.
4. **A closed Codex session stays in the room.**
   - After Cy's tmux session was killed (11:22), its Room MCP server (pid 37694) kept running as a child of the Codex app-server daemon (pid 17941), with its Fly connection ESTABLISHED.
   - Three minutes later, the room's awareness (read with the view key) still showed `rohanz+codex`, status `synced`, `wakeUnavailable: false`.
   - Claude sessions left the room when their process ended.
   - Teammates would see Cy as present and wakeable, and could wait for answers that never come. Killing the process removed it.
5. **Previews ran before the others had edited anything.** Ana's only preview (11:15:08) covered 5 paths, all hers; Ben had declared his scope but had not edited yet. She reported "a preview merge of my changes with the other two agents' work in progress has no conflicts". This is Flask finding 2: a preview does not say which teammates' work it did not include.
6. **`room_state` says "sharing the full text of files you change with 1 people"** while three agents are present.
   - It counts distinct human owners other than you (`packages/room-mcp/src/tools/scope.ts:85`), so with one login it is 1.
   - "1 people" is ungrammatical, and it reads as "one other agent".
7. **Team-room daemon events are missing from `room-mcp.log`.**
   - Every clone's `.git/room-mcp.log` has the local-room daemon's lines, the team join, and the new "slow tool" lines (`room_preview_merge` 3.4–11.7 s, all of it in "body", which includes the test run).
   - The team daemon's own log lines are absent: "advanced room base", and the "released your claim …" line `reanchorOwnClaims` logs. Finding 1 had to be reconstructed from the agents' transcripts.
8. **Wake and export wording.**
   - Claude's wake line names the sender "room": "[room] 4 things need you: room sent a note; room sent a note; room sent a note; room sent a note".
   - The exported history reads "claimed tests/test_wrappers.py:510-560 … → done: released your claim on …: that code changed in 825a3845d2", which is second person and labelled "done" in a third-person history.
9. **Preview errors when a teammate has pushed.** At 11:16:02 Ben and Cy each got "error: rohanz's HEAD 825a3845d2 is not in this clone; git fetch, then retry". Both pulled and retried correctly. Room could fetch the base itself, or say "pull to catch up first".

## What worked

- Joins took 11–13 s with no login step.
- Every agent scoped and claimed before editing and asked before touching a teammate's claimed lines. Every question was answered as an answer (rehearsal finding 11 stays fixed).
- Both simultaneous pushes went through without a rejection, because Cy caught up before committing.
- The combined branch passes upstream's own tests.
