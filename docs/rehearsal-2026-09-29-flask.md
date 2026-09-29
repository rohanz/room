# Rehearsal: Flask at declared sharing with two Codex agents, 2026-09-29

A rerun of the Flask rehearsal ([2026-09-28](rehearsal-2026-09-28-flask.md)) on Room 0.16.37, after the
[Werkzeug](rehearsal-2026-09-29-werkzeug.md) and [httpx](rehearsal-2026-09-29-httpx.md) runs. Two things
changed from last time:

- Ben ran on Codex, so two Codex sessions shared one app-server daemon.
- Nobody was told when to push. Each assignment ended "push to the rehearsal-0929 branch when you're done", so the pushes raced on their own.

## Setup

- **Versions:** Room 0.16.37, server on Fly v67, Claude Code 2.1.284, codex-cli 0.158.0 (GPT-6-Astra medium).
- **Repository:** private `rohanz/flask-rehearsal`, with a new branch `rehearsal-0929` at the snapshot 2b1a766 (upstream 06ea505). Issues #1–#3 were reopened. The cards, overlap and answer key are in the [earlier doc](rehearsal-2026-09-28-flask.md).
- **Sessions:** three fresh clones at `/tmp/reh-flask-{ana,ben,cy}`.
  - Ana: Claude Code, issue #1.
  - Ben: Codex, issue #2.
  - Cy: Codex, issue #3.
- **Sharing:** declared for all three. Each was told "join the room, and only share the files I'm working on".

## Timeline

- **11:37 Joining.**
  - Ana joined in 22 s. Her log has `slow tool room_join 6859ms: settle 0ms, body 6858ms`.
  - Ben and Cy joined within 4 s of each other, as `rohanz+codex-2` and `rohanz+codex`.
- **11:38:25 All three were given:** "take issue #N on github (rohanz/flask-rehearsal). check with the others before you finish, and push to the rehearsal-0929 branch when you're done".
- **11:38:55–11:39:21 `CHANGES.rst`, the known textual collision.**
  - All three asked where their bullet should go.
  - Ana answered both: Cy at the top, herself in the middle, Ben at the end.
  - Ben's first question, addressed to "rohanz's agent", was refused (finding 3), and he resent it to `rohanz` 6 s later.
- **11:39:37 Ana's preview of all three** merged cleanly. Its only failures were Ben's 8 new IPv6 tests, because his source fix was not written yet. Ana and Cy both read this correctly, as work in progress, and told Ben.
- **11:39:55 First push:** Ana pushed 88005a2, 1 min 30 s after the assignment.
  - Cy's proposal to push first crossed her push, and she apologised.
  - Cy proposed an order, Cy then Ben, and both agreed.
- **11:40:27 Ben** caught up with `git pull --ff-only --autostash`. Cy did the same at 11:40:5x.
  - Their claims in `tests/test_basic.py` and `CHANGES.rst` were released "that code changed in 88005a2ad0", a commit that does not touch `test_basic.py` (finding 1).
- **11:40:59 Cy** pushed bb7a1a4 and told Ben ("You can pull --ff-only --autostash and proceed").
- **11:41:50 Ben** pulled and pushed ac5cfcf. He had waited on Cy's answer with `room_wait` to push in the agreed order. None of the three pushes was rejected.
- **11:42:00–11:43:50 The Codex queues:**
  - Ben's Codex delivered 12 queued Room messages as separate turns after its task had ended.
  - Cy's Codex delivered 8.
  - Every one had already been handled (finding 2).
- **11:44 Everyone quit** (`/exit`, `/quit`). Both Codex sessions stayed in the room (finding 4).

## Scorecard

| | |
|---|---|
| Assignment to first push | 1 min 30 s (Ana) |
| Assignment to last push | 3 min 25 s (Ben) |
| Conflicts | none; the `CHANGES.rst` collision was avoided by agreement before anyone edited |
| Questions | 9 asked (placement, push order, "any concerns?"), all answered within about 30 s; 1 refused for its address |
| Previews | Ana 2, Ben 2, Cy 2; the early ones showed Ben's unfinished work and were read correctly |
| Rejected pushes | 0; the agents agreed an order and each pulled first |
| Human interventions | none |

## Result and answer key

- `rehearsal-0929` = 88005a2 (#1), bb7a1a4 (#3), ac5cfcf (#2).
- A fresh clone passes the check (531).
- **Answer key: 171 of 171.** The key is upstream's final `test_basic.py` and `test_testing.py`, plus the case-sensitivity test for #1.

## Findings

1. **A catch-up pull released claims on code the pushed commit did not touch.** This is Werkzeug finding 1 again.
   - 88005a2 changes `CHANGES.rst`, `src/flask/sansio/app.py` and `tests/test_templating.py`.
   - After Ben's `git pull --ff-only --autostash` (11:40:27), `room [bot]` released his `CHANGES.rst:28-29` claim and his `tests/test_basic.py:1903-1924` claim, "that code changed in 88005a2ad0".
   - After Cy's pull, it released Cy's `tests/test_basic.py:54-72` and `CHANGES.rst:4-6` the same way.
   - Ana also got a "released your claim on CHANGES.rst:21-22" notice from `room [bot]` for her own commit.
2. **Two Codex agents each replayed their whole inbox after finishing.**
   - Ben received 12 wake turns between 11:42:00 and 11:43:35, all after his push and room_done (11:41:54): questions already answered, base notices already pulled, and "released your claim" notices.
   - Cy received 8 wake turns (11:41:13–11:42:27), all after its room_done (11:41:08).
   - Among them were base notices saying "You have uncommitted work" when the tree was clean, and a question ("Please tell me when your push completes") that Cy had answered 80 s earlier.
   - For about two minutes, each Codex pane was a scroll of "Checked. This update is already resolved."
   - This is the heaviest form of Werkzeug finding 3 so far: with more agents and more messages, the backlog grows.
3. **"rohanz's agent" cannot be addressed.** Ben's `room_send(to: "rohanz's agent")` at 11:38:55 was refused: "nobody called rohanz's agent is or was in this room; participants: rohanz, rohanz+codex, rohanz+codex-2". This is httpx finding 2 again, from a different agent.
4. **Quit Codex sessions stay in the room.**
   - 25 s after `/quit` in both, the room listed `rohanz+codex` (status `synced`) and `rohanz+codex-2` (status `done: Issue #2 pushed …`).
   - Their MCP servers (pids 20953, 21309) are children of the app-server daemon 17941.
   - This is httpx finding 1 again.
5. **Two Codex sessions of one user are `rohanz+codex` and `rohanz+codex-2`.**
   - The humans cannot tell which is which from the names, and the agents' summaries used "codex" and "codex-2".
   - The labels come from join order, not from the clone or the task. Ana's summary had to explain "codex-2 says issue #2 is done".
6. **The declared-sharing join note is confusing on a fresh clone.** All three were told "this clone now shares files in your declared area and changed files declared earlier". Nothing had been declared earlier.
7. **Slow first join with no phase breakdown.** Ana's join took 6.9 s, as Ana's did in the httpx run (7.0 s). Both were the first joiner on a new branch room. The log splits only "settle" and "body", so it does not say where the time went.
8. **Previews while teammates are mid-task.** Ana's and Cy's first previews failed 8 of Ben's tests, because his tests were written before his fix. Both agents read this correctly, but it is Flask finding 2 from 2026-09-28: the preview does not say which teammates' work is incomplete.

## What worked

- **The agents coordinated the whole run with no human help:**
  - they agreed the changelog placement before anyone edited;
  - they agreed a push order;
  - the last pusher waited for the push before it;
  - all three pushes were fast-forwards.
- **Declared sharing gave enough for three-way previews with tests.**
- **Upstream's tests pass on the combined branch.**
