# Trial rehearsal, 2026-09-25

The first run of the trial in `trial-plan.md` with real agents, driven the way a person would drive
them: plain words typed into interactive sessions, no Room jargon, prompts answered as they came.
Room 0.16.0 on the hosted server (Fly release v62).

## Setup

- A private repository, `rohanz/werkzeug-rehearsal`, holding one snapshot commit of Werkzeug at
  upstream `b5a33d286` (the full 5,898-commit history would not push; a snapshot also keeps the
  upstream answers out of reach). Branch `rehearsal`; the three task cards filed as issues 1–3
  without upstream PR numbers.
- Three clones, three interactive sessions in tmux: Ana and Ben on Claude Code 2.1.281 (Opus 5.5,
  auto mode), Cy on Codex 0.156.1 (GPT-6 Astra medium). All three used the owner's GitHub login, so
  this did not test three different logins.
- The hosted server already held a login, so no device-code step appeared. Not tested: a first
  login, Fly waking from idle (the machine had just been deployed), people on different machines.

## What was typed

| Time | Who | Typed |
|---|---|---|
| 02:57 | Ana | open a room for this repo and join it (then "Yes" at Room's confirmation prompt) |
| 02:58 | Ben, Cy | join the room |
| 02:59 | all | take issue 1 / take issue 2 / take issue 3 |
| 03:05 | Ana | commit and push it |
| 03:06 | Ana | no, we're all working on the rehearsal branch together, push it there. the others will pull |
| 03:10 | Ben | commit and push it to rehearsal |
| 03:12 | Cy | commit and push it to rehearsal |
| 03:17 | Ana | we're done for today. save the room's full history to room-history.md in this folder |

## Result

- All three cards were done within about three minutes of "take issue N" and pushed to the shared
  branch within 15 minutes of joining. Nobody coordinated in chat.
- The combined branch passes the trial check (286 tests: the 282 plus four new) and the whole
  Werkzeug suite (991). Against the answer key: the ETag for "Hello World" is byte-for-byte
  upstream's SHA3-256 value, the debugger hashes with SHA3-256, `content_md5` still works on both
  classes and warns. Change sizes are close to upstream's (A: 4 files +84 −12 vs +69 −22; B: 16 files
  +52 −52 vs 18 files +72 −74; C: 6 files +65 −6 vs 5 files +35 −16).
- Room at work, from the exported timeline and the agents' screens: every agent declared a scope and
  claimed exact line ranges before editing, and released them all; Cy's claim inside Ben's declared
  area notified Ben; Ben's signature change to `remove_entity_headers()` reached Cy as a contract
  notice, Cy checked it and needed no change; Ben stayed off a line inside Cy's claim; every agent ran
  a merge preview WITH the test command against the other two before saying done (no conflicts,
  286/312 passing); Ben rebased onto Ana's push without conflicts; each base move told the others to
  catch up, and Cy did before pushing, so the last push was a fast-forward.
- Nobody wanted to turn Room off. It was visible to the human only on join, in the agents' summaries
  ("I stayed clear of the lines codex had claimed"), and in one confirmation prompt.

## Findings

1. **A commit on another local branch was announced as the room's new base (bug) — FIXED in 0.16.1 (fc45d16).** Ana's agent ran
   `git checkout -b deprecate-content-md5`, committed and pushed that branch, while its session stayed
   in the `rehearsal` room. roomd saw HEAD ahead of the room base and advanced it
   (`packages/roomd/src/index.ts`, `maybeAdvance`), so Ben and Cy were told "rohanz's agent moved the
   base to 131480ac01 — git pull to catch up". `git pull` found nothing, so Cy's agent ran
   `git pull --ff-only --autostash origin deprecate-content-md5` into its own `rehearsal`. Harmless
   here only because Ana later pushed that same commit to `rehearsal`. A base should advance only
   while the member's checkout is on the room's branch, and a switch to another branch should be
   visible to the room (and to the agent that switched).
2. **Ana's agent would not push to the shared branch — FIXED in 0.16.1 (eba8df3).** It pushed a new branch instead, reasoning that
   "moving it would have shifted the base under the other two agents". In a shared-branch room that
   is exactly Room's job; the join and etiquette text should say that pushing finished work to the
   room's branch is the normal flow and that Room tells the others to catch up.
3. **"git pull to catch up" is not always the right instruction — FIXED in 0.16.1 (fc45d16, eba8df3).** With overlapping uncommitted
   edits, Cy's plain pull was refused and it had to discover `--autostash` itself. The base message
   and the etiquette rule should give the command that works with uncommitted work, or say what to
   do when pull refuses.
4. **The sharing note shown on join is in tool jargon — FIXED in 0.16.1 (eba8df3).** Every agent relayed "use room_share
   level=intent for plans only or level=declared to limit files to your declared area" to its human.
   It should be plain words a person can say back ("say 'share plans only' to keep file contents on
   this machine").
5. **The export reads as a PR comment — FIXED in 0.16.1 (eba8df3).** `room-history.md` starts "One comment per PR, updated in
   place", which is the PR-note format, not a history file.
6. **Names are asymmetric — FIXED in 0.16.1 (eba8df3).** The first session is "rohanz's agent" in the timeline and "rohanz" in
   the participant list; the others are "rohanz+claude" and "rohanz+codex". With one login per
   person this matters less, but the first joiner should read the same way everywhere.
7. **An agent mislabelled a teammate's task — NOT DONE: agent behaviour; watch for it on the day.**
   Ben said "rohanz on issue #3's deprecation work". The room's scopes were right; the agent misread them.

## Before the trial

- Fix 1–5 (and 6 if cheap), then rehearse once more on the hosted server with a Fly machine that has
  been idle, and with at least one other GitHub login if Kieran or Hrishi can spare ten minutes.
- The friend checklist should say "when your task is done, say: commit and push it to trial".

## Second run, same day (13:00, Room 0.16.3 plus hygiene, Fly v64)

Same repository and cards on a fresh branch `rehearsal-2` at the snapshot commit, three fresh clones,
same hosts, driven the same way. Two additions: the Fly machine had stopped from idle before anyone
joined, and Ana was told "when it's done, commit it on its own branch and push that branch so I can
look at it before it goes in", which is what triggered finding 1 last time.

Result: all three cards pushed to `rehearsal-2` within about nine minutes of "take issue N"; the
combined branch passes the trial check (286) and the whole suite (992); the ETag and the
`content_md5` deprecation match upstream's behaviour.

- **Fly from idle:** the first join woke the stopped machine; Ana was in the room about 21 s after
  "join the room", including loading the skill.
- **Finding 1 is fixed live:** Ana's review branch and its push produced no base message for anyone.
  When she moved the commit onto `rehearsal-2` and pushed, Ben and Cy were told once, with the new
  `git pull --ff-only --autostash` instruction; Ben fast-forwarded and pushed on top.
- **Findings 4 and 6 are fixed live:** the join note is plain words ("to keep file contents on this
  machine, say: share plans only"), and Ana reads as "rohanz's agent" to the others.
- **Addressing worked:** Cy's combined preview caught a failure in Ana's half-finished edit and told
  Ana (not Ben); Cy's question about overlapping test claims went to Ben, who answered it.

New findings:

8. **A branch switch takes a session out of the room.** Room follows the checkout to the new branch's
   room and releases its claims, so while Ana's work waited for review nobody could see it. This is
   the per-branch room model; repository-level rooms (roadmap) remove it. Until then the trial
   instruction "stay on the trial branch" matters.
9. **A stale base notice reached Codex.** Cy got "rohanz+claude moved the base to d877e4e, git pull" after
   it had already pulled that commit and pushed on top of it (Codex reads queued messages at the end of
   its turn). It handled it. Room's clone daemon now marks such notices seen when HEAD moves
   or when a notice arrives after its commit is already in HEAD. Delivery skips seen notices.
   **Fixed in 0.16.8.**
10. **Old branches in the same repository are visible to agents.** Ben saw last run's finished
    commit on the old `rehearsal` branch via `git fetch` (and said it did not look). The public trial
    repository will not have such branches; keep it that way.

## Third run, 2026-09-26 (Room 0.16.9, Fly v64, Claude Code 2.1.282, Codex 0.156.1)

Same cards on a fresh branch `rehearsal-3` at the snapshot commit, three fresh clones, driven the same
way, with the friend checklist's words: "join the room", "take issue N", "commit and push it".

- **Fly from idle again:** the machine was stopped; Ana was in the room 22 s after "join the room".
- **All three done in about seven minutes, all pushed straight to the shared branch** in order (Ana
  `d180802`, Ben `0713e79`, Cy `0c20698`, a fast-forward). Ana's agent pushed to the room's branch with
  no side branch and no refusal (rehearsal finding 2 is fixed in practice).
- **Coordination worked without the humans:** Ben found five lines it needed inside Cy's claimed range,
  asked Cy, waited for Cy to finish and release them, then edited; Cy handled a note that belonged to its
  own issue. Ben's preview of all three people's work: no conflicts, 641 tests passing.
- **Result:** the combined branch passes the trial check (286) and the whole suite (992); the ETag and
  the `content_md5` deprecation match upstream's behaviour. Cy received two base notices, both valid when
  delivered (before it had pulled).

New finding:

11. **An answer without `inReplyTo` is refused — FIXED in 0.16.10 (9c5143b).** Cy replied to Ben's question with `type: answer` and no
    `inReplyTo`; Room refused ("answer requires inReplyTo") and Cy resent it as a note, so Ben's question
    was never marked answered. Room could fill `inReplyTo` with the latest unanswered question from that
    recipient when there is exactly one.
