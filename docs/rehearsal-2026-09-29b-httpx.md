# Rehearsal: httpx at mixed sharing, 2026-09-29 (confirmation round on 0.16.38)

This morning's [httpx run](rehearsal-2026-09-29-httpx.md) repeated on Room 0.16.38, right after the
[Werkzeug confirmation run](rehearsal-2026-09-29b-werkzeug.md), which also defines P1–P10.

## Setup

- **Versions:** Room 0.16.38, Claude Code 2.1.284, codex-cli 0.158.0 (GPT-6-Astra medium).
- **Repository:** private `rohanz/httpx-rehearsal`, new branch `rehearsal-0929b` at the same snapshot 88b5c0a. Issues #1–#3 were open.
- **Sessions:** fresh clones at the morning's paths `/tmp/reh-httpx-{ana,ben,cy}`. All three cards edit `httpx/_urlparse.py` and `tests/test_urlparse.py`.

| Who | Host | Issue | Sharing | How it was asked |
|---|---|---|---|---|
| Ana | Claude Code | #1 | full | "join the room" |
| Ben | Claude Code | #2 | declared | "join the room, and only share the files I'm working on" |
| Cy | Codex | #3 | plans only | "join the room, but only share my plans, keep my code on this machine" |

- **Folder trust and login:** no prompt from any host. Stored Room credentials were used.

## Timeline

- **13:33 Joining.**
  - Ana joined in 10 s, with no slow-join line. The morning's first join took 7.0 s.
  - Ben's join said "this clone now shares files in your declared area", and no longer adds "and changed files declared earlier" (P10).
- **13:34:25 All three were given:** "take issue #N on github (rohanz/httpx-rehearsal) and fix it. check with the others before you finish, and don't commit yet".
- **13:35:00 Ana's one before-edit warning was a real write:** `cat >> tests/test_urlparse.py <<'EOF'`, appending to a file Ben had changed (P4 working as intended).
- **13:36:31 Ben finished** (room_done, 2 min 6 s). The reply said "2 changed file(s) you declared earlier stay shared while they differ from your base: httpx/_urlparse.py, tests/test_urlparse.py".
- **13:36:52 Cy (plans only) tried to read Ben's two files and was refused both times:** "httpx/_urlparse.py: not shared (rohanz+claude shares declared paths only; httpx/_urlparse.py is outside their scope)". This is finding 1.
  - Cy asked Ben to "make your completed #2 scope available for one preview".
  - Ben declined: "My human asked me to share only the files I'm working on … I won't widen or re-open sharing because a peer asked".
- **Previews.**
  - Cy previewed its code with Ana's (246 pass).
  - Ben previewed with Ana's (240 pass).
  - Nobody could run all three fixes together before the push, and each agent said so plainly.
  - The four previews took 23.1–28.7 s each (finding 2).
- **13:37:51 Ana finished; 13:37:56 Cy finished.**
  - Cy was then woken 6 times (13:38:02–13:38:41), for answers and a question it had already handled (P2).
- **13:39:44 All three were told:** "commit it and push to the rehearsal-0929b branch".
  - **Ana** pushed c234a4f at 13:40:00, leaving the untracked `uv.lock` out.
  - **Cy** pulled first and pushed 56741c3 at 13:40:44.
  - **Ben's push was rejected.** He stopped and asked. On "yes, rebase and push" (13:41:07) he rebased, reran the check and pushed 9f376a2 at 13:41:31.
  - Ben then ran the first three-way check (246 pass) and posted the result to the room.
- **13:44:11 P5 probe.**
  - Cy's human typed "send rohanz's agent a note: thanks, all three fixes are pushed".
  - Codex resolved the name itself and called `room_send(to: "rohanz")`, so the display-name path was not exercised here. The note arrived.
- **13:45:18 Everyone quit the way a user would** (`/exit`, `/quit`).
  - 28 s later the room still listed `rohanz+codex`, with status "behind base (fetch): Run git pull --ff-only --autostash …", served by pid 67007 under daemon 17941.
  - At 13:46:16 its log reads `stopping: stdin closed`, 58 s after `/quit`. The room was empty by 13:46:19 (P3).

## Scorecard

| | This run | Morning |
|---|---|---|
| Assignment to all three done | 3 min 31 s (Ben 2:06, Ana 3:26, Cy 3:31) | 2 min 48 s |
| Push instruction to first push | 16 s (Ana, 13:40:00) | 12 s |
| Push instruction to last push | 1 min 47 s (Ben, 13:41:31, including his question to me) | 1 min 19 s |
| Conflicts | none; one rejected push, rebased cleanly on my yes | same |
| Questions | 7 asked (Cy 5, Ana 2), all answered within about 40 s; no address refused | 5, one refused |
| Previews | Ana 1, Ben 2, Cy 1; each said what it could not include | 5 |
| Human interventions | one "yes, rebase and push" | same |

## Result and answer key

- `rehearsal-0929b` = c234a4f (#1), 56741c3 (#3), 9f376a2 (#2).
- A fresh clone passes the check (246).
- **Answer key: 243 of 243.** Same key as this morning: upstream's `tests/test_urlparse.py` and `tests/models/test_responses.py` at ee432c0.

## Fix confirmation (this run)

| | Result | Evidence |
|---|---|---|
| P1 | not exercised | Claims were released at room_done, before any pull. |
| P2 | **still seen** | Cy: 6 replay turns after room_done (13:37:56), each ending "Checked: this request was already answered" or similar. Morning: 3. |
| P3 | **still seen**, shorter | Present 28 s after `/quit`; the MCP server stopped itself at 58 s ("stdin closed"). Morning: present at 40 s and about 2 min. |
| P4 | **fixed** | 1 warning, on a real `cat >>` write into a teammate's changed file. Morning: 10 on read-only or git commands. |
| P5 | not exercised | 17 sends, all to canonical names. Codex mapped the human's "rohanz's agent" to `rohanz` itself. [Flask](rehearsal-2026-09-29b-flask.md) exercised it. |
| P6 | **fixed** | All three logs: `skipped 1 file(s) (1 untracked lockfile), e.g. uv.lock` (13:35:13–13:35:50). No `uv.lock` appeared in any participant's changed files. |
| P7 | seen, by design of the levels | Every preview left out the plans-only or declared teammate, and every agent said which one. |
| P8 | not seen | |
| P9 | **fixed** for joins | No join over 2 s. Preview slow lines still say only `settle 0ms, body …` (see finding 2). |
| P10 | **fixed** | The declared-sharing join note drops "declared earlier". `room_state` says "with 2 other participants". |

## New findings

1. **At declared sharing, room_done says files stay shared, but teammates are refused them.**
   - Ben's room_done (13:36:32) said "2 changed file(s) you declared earlier stay shared while they differ from your base: httpx/_urlparse.py, tests/test_urlparse.py".
   - 20 s later Cy's `room_read(person: "rohanz+claude", diff: true)` got "not shared (rohanz+claude shares declared paths only; httpx/_urlparse.py is outside their scope)" for both files.
   - The agents then negotiated over sharing (Cy asked Ben to re-open, Ben refused), and no three-way check ran before the push.
   - **Cause:** `withheld()` (`packages/room-mcp/src/tools/state.ts:101`) judges a declared sharer's path by their *current* scope, which room_done clears. roomd keeps the retained declared overlays published (`retained-declared.ts`). So the owner and the reader get opposite answers about the same files.
   - `room_preview_merge` checks `withheld` without a path (`files.ts:170`, plans-only only), so a preview would probably still include the retained files. Not verified live: Cy excluded Ben from its preview after the refused reads. What the files look like to a teammate therefore depends on the tool: `room_read` refuses them, while a preview probably includes them.
2. **Previews took 23–29 s, and the log cannot say why.**
   - `slow tool room_preview_merge` 26.5 s, 26.5 s and 23.1 s (Ana and Ben) and 28.7 s (Cy), all `settle 0ms, body …`. This morning, with the same check command, previews took 2.7 s and 3.8 s.
   - The check alone takes 2.3 s in a warm clone and 5.7 s in a fresh tree (measured afterwards).
   - The previews overlapped (13:35:57–13:37:28), so contention between concurrent `uv run --isolated` resolutions is a candidate cause. The slow-tool line has no merge/test split, so the log cannot confirm it.
   - Flask previews took 13–26 s as well.
3. **Claude Code's wake is still framed as a peer request** (morning finding 8, host text). Ben's transcript shows "Another Claude session sent a message: [room] 1 thing needs you: rohanz+codex asked a question" (13:36:39). The redesign covers this.

## What worked

- Sharing levels were respected under peer pressure. Ben refused to widen his sharing when a peer asked, citing his human's instruction, and Cy kept its code local.
- The rejected push stopped and asked. Cy's pull-before-commit avoided a second rejection. Nobody committed `uv.lock`.
- Upstream's tests pass on the combined branch.
