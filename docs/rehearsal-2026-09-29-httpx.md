# Rehearsal: httpx at mixed sharing, 2026-09-29

A rerun of the httpx mixed-sharing rehearsal ([2026-09-27 rerun](rehearsal-2026-09-26-httpx.md#rerun-at-mixed-sharing-on-0162801629-2026-09-27)) on Room 0.16.37, right after the [Werkzeug run](rehearsal-2026-09-29-werkzeug.md).

## Setup

- **Versions:**
  - Room 0.16.37, server on Fly v67.
  - Claude Code 2.1.284.
  - **codex-cli 0.158.0.** Homebrew upgraded it between the two runs; the Werkzeug run's TUI was 0.157.1, and the daemon was already 0.158.0.
- **Repository:** private `rohanz/httpx-rehearsal`, with a new branch `rehearsal-0929` at the snapshot 88b5c0a (upstream 15d09a3). Issues #1–#3 were reopened. They are cards A–C of [rehearsal-httpx-plan.md](rehearsal-httpx-plan.md), with card A's clarified example.
- **Sessions:** three fresh clones at `/tmp/reh-httpx-{ana,ben,cy}`, one tmux session each. All three cards edit `httpx/_urlparse.py` and `tests/test_urlparse.py`.

| Who | Host | Issue | Sharing | How it was asked |
|---|---|---|---|---|
| Ana | Claude Code | #1 | full | "join the room" |
| Ben | Claude Code | #2 | declared | "join the room, and only share the files I'm working on" |
| Cy | Codex | #3 | plans only | "join the room, but only share my plans, keep my code on this machine" |

## Timeline

- **11:26:20 Ana joined** in 15 s.
  - Her log has `slow tool room_join 6997ms: settle 0ms, body 6997ms`.
  - The join message offered only the narrower levels (httpx finding 1 stays fixed).
- **11:26:42 Ben and Cy joined.**
  - Ben's join said "nothing is shared yet because I haven't declared an area".
  - Cy's said "this clone now shares only your plans, no file text".
- **11:27:54 All three were given:** "take issue #N on github (rohanz/httpx-rehearsal) and fix it. check with the others before you finish, and don't commit yet".
- **Ben (declared) finished first,** 57 s after the assignment.
  - He asked Ana whether his lines collided; she answered in 8 s.
  - He answered Cy's question.
  - His room_done said "2 changed file(s) you declared earlier stay shared while they differ from your base". He told his human the same, and how to withdraw them.
- **Cy's first question to Ana was refused** (finding 2). Cy resent it to `rohanz` 10 s later.
- **Ana (full):**
  - Her previews included only Ben's shared files. She said plainly "Codex shares plans only, so I can't preview their code".
  - She warned Cy about a side effect of her fix on raw URLs, and Cy confirmed its tests avoid that input.
  - She finished at 11:30:14.
- **Cy (plans only):**
  - It previewed its own local change merged with Ana's and Ben's shared files, with the check: no conflicts.
  - It finished at 11:30:42 with 246 passing.
  - After finishing, it was woken three more times for messages it had already handled inline (finding 3).
- **11:31:42 All three were told:** "commit it and push to the rehearsal-0929 branch".
  - **Ana** pushed 31301be at 11:31:54.
  - **Ben's push was rejected in the same second** (`cannot lock ref … is at 3130…`). He stopped, explained why, and asked before rebasing. On "yes, rebase and push" at 11:32:50, he rebased onto both other commits, reran 246 tests, and pushed 647ba1a at 11:33:01.
  - **Cy** pulled Ana's commit with `--ff-only --autostash` before committing, then pushed 1d5562f at 11:32:31.
  - Both Cy and Ana deleted the `uv.lock` the check command creates, and nobody committed it.
- **11:34 Everyone quit the way a user would** (`/exit` in Claude Code, `/quit` in Codex). Cy stayed in the room (finding 1).

## Scorecard

| | |
|---|---|
| Assignment to all three done | 2 min 48 s (Ben 0:57, Ana 2:20, Cy 2:48) |
| Push instruction to first push | 12 s (Ana, 11:31:54) |
| Push instruction to last push | 1 min 19 s (Ben, 11:33:01, including his question to me) |
| Conflicts | none; one rejected push, rebased cleanly on my yes |
| Questions | 5 asked, all answered within 11 s. One went to a name Room refused, and one was answered with a note instead of an answer, so it was never marked answered |
| Previews | Ana 2, Ben 1, Cy 2; each said what it could not include |
| Human interventions | one "yes, rebase and push" |

## Result and answer key

- `rehearsal-0929` = 31301be (#1), 1d5562f (#3), 647ba1a (#2).
- A fresh clone passes the check (246).
- **Answer key: 243 of 243.** The key is upstream's `tests/test_urlparse.py` and `tests/models/test_responses.py` at ee432c0, run with the check command on our code. 7 of these fail at the base.

## Findings

1. **A Codex session that the user quits stays in the room.** This reproduces Werkzeug finding 4 with a normal exit.
   - `/quit` in codex 0.158.0 printed "Reconnect: codex resume 01a0eb32-… Stop the current turn: run codex agents, select this task, and press x." The thread stays loaded in the app-server daemon.
   - Its Room MCP server (pid 84224, parent 17941 = `codex app-server --managed-daemon`) kept its Fly connection.
   - 40 s after `/quit`, the room still listed `rohanz+codex`, status `behind base (fetch): Run git pull --ff-only --autostash …`.
   - Both Claude Code sessions left the room on `/exit`.
   - **Consequence:** a Codex teammate who has gone home still looks present, and the room says it can be woken. Questions to it sit unanswered until someone resumes that thread.
2. **Room displays a name it does not accept as an address.**
   - Ana appears as "rohanz's agent" in `room_state`, in every notice ("rohanz's agent claims httpx/_urlparse.py:414-423"), and as the recipient ("rohanz+codex → rohanz's agent asks").
   - Cy's `room_send(to: "rohanz's agent")` at 11:28:40 was refused: "error: nobody called rohanz's agent is or was in this room; participants: rohanz, rohanz+claude, rohanz+codex".
   - The rename that fixed Werkzeug finding 6 changed the display name only.
3. **Codex was woken for messages it had already handled.** This is Werkzeug finding 3 again.
   - Cy saw Ben's answer (sent 11:28:51) and Ana's answer (11:30:09) inline in tool results, and acted on them before finishing at 11:30:42.
   - Codex then delivered them as new turns at 11:30:55, 11:31:03 and 11:31:13. Each one cost a turn in which Cy said "Checked: this earlier notification was already accounted for".
4. **At full sharing, a generated untracked file was shared.**
   - The check command (`uv run --isolated … --with-requirements requirements.txt`) creates a 180 KB `uv.lock`.
   - At 11:29:17, Ben's `room_state` listed Ana as "uncommitted, not yet pushed: httpx/_urlparse.py, tests/test_urlparse.py, uv.lock". Ana deleted it at 11:29:20, only because she noticed it in `git status`.
   - Room's default ignores and size budget do not cover lockfiles. At full sharing, any untracked file a tool writes goes to the room.
5. **Previews were partial with no warning of how current they were.** Ben's only preview (11:28:37) ran before Cy had edited anything, and he finished 14 s later. This is Flask finding 2. At plans-only it is expected, and every agent said so, but no preview said which teammates had not started.
6. **The before-edit hook fired 10 times on read-only or git commands** (Ana 6, Ben 4). This is Werkzeug finding 2.
7. **The slow-tool log names no phase.**
   - `slow tool room_join 6997ms: settle 0ms, body 6997ms` (Ana, 11:26:33) cannot show whether the time went on the server, on git, or on the graph index. Werkzeug's joins took about 1 s.
   - The two preview lines (2.7 s and 3.8 s) are all "body" as well, and they include the test run.
8. **Claude's cross-session wake arrives framed as a peer request.** Ben's pane showed "Another Claude session sent a message: [room] 1 thing needs you: rohanz+codex sent a note. Use the room_state tool to read them." Below it came Claude Code's warning about permission laundering. This is host text (2.1.284), but it puts Room tool names and a security warning in front of the human. In the Werkzeug run the same wake showed as one "[room] …" line.

## What worked

- **Every agent was honest about the sharing levels.**
  - Ana and Ben said which teammate their previews could not include.
  - Cy, at plans only, still previewed its own local code against everything the others shared.
  - Ben told his human which files stayed shared after finishing, and how to withdraw them.
- **The rejected push stopped and asked** (the 0.16.30 rule). Cy's pull-before-commit avoided a second rejection.
- **Upstream's tests pass on the combined branch.**
