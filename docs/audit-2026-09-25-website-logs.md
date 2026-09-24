# Room in real use: the website repo, 22–25 Sep 2026

Read-only review of Room's behaviour during two days of heavy use in the owner's website repository
(Astro site, ~400 tracked files, ~13 GB of untracked art). Sources: the lead's Claude Code transcript
(one session, 22 Sep 09:43Z to 24 Sep 16:58Z: 75 room_spawn, 87 room_collect, 154 room_wait,
63 room_send, 4 room_state, 0 room_preview_merge), `.git/room-mcp.log` (only its last 13 minutes
survive), 52 recovery patches under `.room/discarded/`, and live processes. Site content is out of
scope. Status is against 0.15.2.

## Findings, most impactful first

1. **Notes from a lead's own workers wake it constantly (NEW).** 65 wakes in 28 minutes from 6
   workers: 50 "sent a note", 8 questions, 5 finished, 2 mixed; none failed or interrupt. 36 became
   new turns while idle, 16 of them no-ops (wait 2 s, summarise, stop). About 147M input tokens
   (mostly cache reads of a ~0.8M context) over those 36 turns; the 16 no-ops about 27M. Notes came
   ~25 s apart, so the 5 s batch window never helped. Many lead replies were bare acknowledgements.
   Cause: an addressed `notify` wakes (`packages/shared/src/wake.ts`), and workers address progress
   notes to their lead. The lead ignored "Use the room_state tool" 33 times and used room_wait.
2. **room_wait's 120 s cap equals Claude Code's move-to-background point (NEW).** 33 of 154 waits
   were backgrounded ("still running after 120s"); 600000 requests are clamped to 120000
   (`WAIT_MAX`, messaging.ts). The lead then had overlapping waits and read results out of order.
3. **A stale pre-fix server froze the session (root cause fixed in 0.15.1; cancellation and
   stale-code warning on the roadmap).** Six spawns backgrounded at 165–721 s, room_state took 121 s.
   The lead TaskStopped 7 calls and then bypassed Room with hand-made worktrees and `codex exec`.
   It read `installed_plugins.json` (0.8.0), which is misleading: the running code is the checkout.
4. **An old Room process on the same clone appears as another person (phantom-self part NEW).**
   A still-open IDE session's Room server (started 23 Sep, ~100% CPU) stayed in the room as
   "rohanz" publishing the checkout's own untracked WIP as someone else's nearby changes; the
   restarted session joined as "rohanz+claude". Workers saw both names as possible addressees.
   The header said "you: rohanz's agent" while the list said "rohanz+claude (you)".
5. **Log spam and idle CPU on a large repo (NEW).** ~7,700 "skip <ignored file>" lines in 13
   minutes (one per Playwright trace file, 4 processes); the 1 MB rotation lost all earlier
   history. Both live room-mcp servers sat near 100% CPU while idle.
6. **Collect keeps worktrees over regenerable build output (on the roadmap, happens every time).**
   63 discard+force, 5 refused plain discards (`.astro/`, `dist/`, `test-results/`, generated
   JS), 19 real collects; each collect ends "kept <tag>: uncopied ignored artifacts" and a forced
   discard prints an alarming "deleted without a copy" list. 52 recovery patches, mostly for work
   that had already landed.
7. **Collect is slow, serial, and misreports queueing (NEW).** 60–130 s per collect (median 23 s);
   three in parallel took 66 s, 130 s, then "error: room not synced yet, retry" at 131 s; the retry
   worked.
8. **Collect and discard trip on stale records (NEW).** One vanished worktree (`ENOENT lstat
   .room/workers/og-sections`) aborted collect-all; "skipped og-split: failed" gave no reason;
   a replacement worker reused a dead worker's worktree, then discard refused it as "not an owned
   Room worktree"; "Directory not empty" twice; a `git ls-files` internal error.
9. **Worker processes outlive their worker (NEW).** A worker's `astro dev` from 22 Sep is still
   running, reparented to init in its own process group, cwd deleted; it caused "Directory not
   empty". Workers fought over dev ports; the lead hand-assigned them.
10. **Claims and overlays of finished or dead workers linger (partly fixed in 0.14.1).** Two workers
    asked to overrule a "historical" claim from a worker collected the day before; a merge preview
    showed a dead predecessor's overlay as conflicting "ghost edits"; room_state counted 15 active
    participants including workers finished a day earlier.
11. **Merge preview unusable here (general item on the roadmap).** The lead broadcast "skip
    room_preview_merge" (slow with large untracked art) and never ran one. That ruling, and another,
    went out as `fyi`.
12. **Carry friction (NEW).** The lead stashed the human's tracked edits before spawning because
    they import untracked files workers cannot get; room_spawn has no "start from HEAD" option. A
    worker could not find an untracked spec file its brief named.
13. **Smaller.** 5 spawns "not in a room" after a restart although the local room was remembered,
    then an 86 s room_join; `room_send` with `message=` fails ("text is required"); names like
    "rohanz+claude's agent"; 4 of ~10 worker questions got no `inReplyTo` answer, some arrived
    piggybacked on unrelated collect or spawn results.

## What worked

After the restart six spawns took 28–43 s; question-to-answer took 15–20 s; the 29 wakes absorbed
during busy turns never interrupted work; four workers collected cleanly and the combined tree passed
typecheck, 797 unit tests and the build; the lead split ownership of files between workers through
answers and it held.

## Also seen on 2026-09-25 (0.15.2 live check and CI)

- room_preview_merge refuses the lead's OWN `share=intent` worker ("shares intent only"); collect works.
- A worker gave up after "three unanswered waits" although the answer had been sent (the 0.15.2
  batch lead saw the same crossing).
- room_state keeps counting collected and discarded workers as finished.
- The discard recovery patch is named with the UTC date.
- `archive-signal.test.ts` ("early tar exit while git archive is piping") hung once on CI's Linux
  runner (passed on re-run; 0/32 locally in Docker): `materializeGitTree` can hang until its 60 s timer.
