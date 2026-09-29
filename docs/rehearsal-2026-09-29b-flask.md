# Rehearsal: Flask at declared sharing with two Codex agents, 2026-09-29 (confirmation round on 0.16.38)

This morning's [Flask run](rehearsal-2026-09-29-flask.md) repeated on Room 0.16.38, after the
[Werkzeug](rehearsal-2026-09-29b-werkzeug.md) (P1–P10 defined there) and [httpx](rehearsal-2026-09-29b-httpx.md) confirmation runs.
As this morning, nobody was told when to push.

## Setup

- **Versions:** Room 0.16.38, Claude Code 2.1.284, codex-cli 0.158.0 (GPT-6-Astra medium).
- **Repository:** private `rohanz/flask-rehearsal`, new branch `rehearsal-0929b` at the same snapshot 2b1a766. Issues #1–#3 were open.
- **Sessions:** fresh clones at the morning's paths `/tmp/reh-flask-{ana,ben,cy}`.
  - Ana: Claude Code, issue #1.
  - Ben: Codex, issue #2.
  - Cy: Codex, issue #3.
- **Sharing:** declared for all three. Each was told "join the room, and only share the files I'm working on".
- **Folder trust and login:** no prompt from any host. Stored Room credentials were used.

## Timeline

- **13:46–13:47 Joining.**
  - Ana joined in 14 s.
  - Ben and Cy joined as `rohanz+codex-2` and `rohanz+codex`. Their joins log the phases: `room_join 4373ms: settle 1965ms, resolve 91ms, preflight 61ms, connect 8ms, sync 96ms, daemon start 2078ms, other 73ms` and `3621ms: settle 1209ms, … daemon start 1360ms, other 839ms`.
  - Every join note said "this clone now shares files in your declared area", with no "declared earlier" (P10).
- **13:47:42 All three were given:** "take issue #N on github (rohanz/flask-rehearsal). check with the others before you finish, and push to the rehearsal-0929b branch when you're done".
- **13:48 `CHANGES.rst` placement.**
  - Ben asked `rohanz's agent` directly (P5), and so did Cy.
  - Ana answered: #1 at the top, QUERY at the end, IPv6 in the middle.
- **13:49:3x Ana's three-way preview failed 8 tests, all Ben's new IPv6 tests.** His fix was not written yet.
  - Ana told Ben: "preview_merge of all three of us (combined tree) fails 8 tests, all yours".
  - Ben answered: "That preview caught my deliberate red-test stage" (P7).
- **13:50:01 First push:** Ana pushed 855dd47, 2 min 19 s after the assignment.
- **13:50:04 and 13:50:36 Ana read Ben's `CHANGES.rst` diff, and it showed Ben deleting her #1 entry** (finding 1). She pulled, previewed again, and at 13:51:04 told Ben "Your CHANGES.rst still shows my #1 entry as removed rela[tive …]".
- **13:50:36 Ana's read also hit P8:** "error: rohanz+codex's HEAD 5beb801e7d is not in this clone; git fetch, then retry". She pulled and retried.
- **13:50:41 Cy pushed 5beb801**, then sent room_done and told Ben "Your turn: pull --ff-only --autostash".
- **13:51:03 Ben pulled 5beb801, which changes `tests/test_basic.py`. His claim in that file survived:**
  - `kept claim on tests/test_basic.py:1902-1925 after 5beb801e7d: the file has your uncommitted edits` (P1).
  - Last time the same pull released it.
- **13:51:22 Ben pushed 45b87ed.**
  - Room then released his claim "that code changed in 45b87ed8f6", his own commit, by design.
  - Cy's `test_basic.py:55-69` claim was released by Cy's own 5beb801 in the same way.
  - None of the three pushes was rejected.
- **13:51–13:53 The Codex queues.**
  - Ben received 13 wake turns after his room_done (13:51:22).
  - Cy received 10 after its room_done (13:50:47).
  - Each was a message already handled or superseded, including two base notices saying "You have uncommitted work" after the agent had pushed (P2).
  - Ben answered one replayed question with a new message to Cy, "This appears to be your earlier coordination question delivered late …", which woke Cy once more.
- **13:55:34 Everyone quit** (`/quit` twice, `/exit`).
  - The room listed both `rohanz+codex` and `rohanz+codex-2` at 13:55:49, 13:56:04, 13:56:18 and 13:56:33.
  - Both MCP servers logged `stopped: requested` at 13:56:32–34, and the room was empty at 13:56:46 (P3, about 60–70 s).

## Scorecard

| | This run | Morning |
|---|---|---|
| Assignment to first push | 2 min 19 s (Ana, 13:50:01) | 1 min 30 s |
| Assignment to last push | 3 min 40 s (Ben, 13:51:22) | 3 min 25 s |
| Conflicts | none; the `CHANGES.rst` collision was avoided by agreement before anyone edited | same |
| Questions | 7 asked (Ben 3, Cy 4), all answered within about 30 s; none refused | 9, one refused |
| Previews | Ana 2, Ben 1, Cy 1; Ana's first showed Ben's red tests and was read correctly | 6 |
| Rejected pushes | 0; the agents sequenced their pushes and each pulled first | 0 |
| Human interventions | none | none |

## Result and answer key

- `rehearsal-0929b` = 855dd47 (#1), 5beb801 (#3), 45b87ed (#2).
- A fresh clone passes the check (529).
- **Answer key: 171 of 171.** Same key as this morning: upstream's final `test_basic.py` and `test_testing.py`, plus the case-sensitivity test for #1.

## Fix confirmation (this run)

| | Result | Evidence |
|---|---|---|
| P1 | **fixed** | Ben's catch-up pull of 5beb801, which changed another part of `tests/test_basic.py`, kept his claim; the log says why. The only releases came from each agent's own commit. Morning: 4 wrong releases. |
| P2 | **still seen**, as heavy as before | Ben 13 replay turns, Cy 10. Morning: 12 and 8. One replay triggered a new message and a further wake. |
| P3 | **still seen**, shorter | Both Codex sessions were present for about 60 s after `/quit`, then stopped on their own. Morning: present at 25 s, then killed. |
| P4 | **fixed** | 0 "Claim before editing" warnings. |
| P5 | **fixed** | Ben sent 2 questions and 2 notes to `"rohanz's agent"`; all were delivered, with no "nobody called" error. Morning: refused. |
| P7 | **still seen** | Ana's three-way preview failed 8 of Ben's tests-first tests. Read correctly, but the preview did not mark Ben's work as unfinished. |
| P8 | **still seen**, once | Ana, 13:50:36, "rohanz+codex's HEAD 5beb801e7d is not in this clone; git fetch, then retry". |
| P9 | **fixed** | The phase breakdown is in both Codex joins, and `kept claim` / `released your claim` / `advanced room base` are in the logs. Previews still log only `body` (13.2–26.4 s). |
| P10 | **fixed** | Declared join note; "with 2 other participants". The `+codex` / `+codex-2` names are kept by design. |

## New findings

1. **`room_read` diffs a teammate's file against the reader's base, so a teammate who has not pulled appears to delete what the reader committed.**
   - Ana pushed 855dd47 at 13:50:01. At 13:50:04 and 13:50:36, `room_read(person: "rohanz+codex-2", path: "CHANGES.rst", diff: true)` showed `--- a/CHANGES.rst base / +++ b/CHANGES.rst rohanz+codex-2` with `-   Autoescaping is enabled for templates with upper- or mixed-case file … :issue:`1``.
   - Ben had never touched that entry. His overlay was simply based on 2b1a766.
   - Ana told Ben his file "still shows my #1 entry as removed", and Ben had to confirm after pulling that it was fine.
   - **Cause:** `packages/room-mcp/src/tools/files.ts:80` calls `baseText(s, p, worker ? person : undefined)`, which uses the reader's base for any teammate who is not a local worker. The diff should use the teammate's own base, `baseFor(s, person)`.
   - Any time bases diverge (right after a push), `room_read diff` misattributes the reader's own commit to the teammate as a deletion.
2. **Previews again took 13–26 s** (`room_preview_merge` 22.2, 13.2, 24.8 and 26.4 s, all `body`). The check itself runs in about 1.5 s. See httpx finding 2.

## What worked

- **No human help at all.** The agents agreed changelog placement and push order, reviewed each other's diffs, and each pulled before pushing. No push was rejected.
- **Claims now survive a teammate's push.** Ben kept his `test_basic.py` claim through Cy's commit to the same file.
- **Addressing by display name works.**
- **Upstream's tests pass on the combined branch.**
