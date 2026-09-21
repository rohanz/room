# Audit of the longest real use of Room (2026-09-20/21)

One Claude lead and 38 spawned workers (Codex and Claude) on a private ML repo, about 20 hours,
one continuous lead session. Three read-only passes: the workers' Room server logs (6,291 lines),
the lead's transcript (232 tool calls, 66 of them Room calls), and the workers' own CLI logs
(843,000 lines, 836 Room calls by 22 Codex workers). Project content is deliberately not recorded
here. Several items below were fixed in 0.7.0 during the same day; they are marked.

## What worked

- `room_spawn`: 38 of 38 accepted calls produced a worktree, branch and log in about 15 s, across
  three model types. The human's plain requests ("spin up codex sessions and use the local room")
  always led to `room_spawn`, never to built-in subagents.
- Questions and answers: 15 worker questions were each answered by the lead, typically within
  10 to 60 s once wake-ups worked; several changed a worker's plan.
- Done notices with summary and changed files were how the lead learned of completions.
- Base-advance notices and lead interrupts changed behaviour usefully; sibling claims stopped two
  workers duplicating a shared file; no worker was confused about its identity or its lead.
- 24 scopes, 112 reads, 265 claims: zero tool-logic failures. Joins took about a second. No
  daemon restarted; stale overlays were cleared correctly; the size cap always held.

## What did not work, ranked

1. **Every conflict alarm was false: 16 of 16.** Three mechanisms. (a) The lead copied a worker's
   files from its worktree into the main clone while the worker's claims were open: 14 alarms,
   and the worker was alarmed too. (b) Claims of workers whose process had exited without
   `room_done` stayed open and kept raising alarms. (c) The lead started a Codex session directly
   in its own folder; it joined as `rohanz+codex`, claimed a file and wrote it, and Room blamed the
   lead because attribution is by folder. Fixes: release claims when a worker's process exits; a
   byte-identical copy of the claimant's own file is integration, not a conflict; attribute a write
   to the session that made it (the before-tool hook knows), not to the folder; two daemons on one
   directory must not both publish it.
2. **The integration half of Room was never used.** 0 `room_preview_merge`, 0 merges of
   `room/<tag>`, about 17 `rsync`/`cp` out of worktrees. Causes: workers are told not to commit and
   their deliverables were untracked or gitignored, so diff and preview could not see them;
   `room_preview_merge` failed with `git merge-file exited 128 without conflict markers` for every
   worker that tried (one called it 10 times); "merge preview clean" was therefore weak evidence.
   Room needs a first-class way for a lead to collect a worker's output, including untracked and
   ignored artifacts, and a preview that handles files absent at the base.
3. **The lead was deaf for the first 12 hours.** It was not started with the channels flag, so it
   polled with `sleep` loops and log tails; three worker questions waited 22 minutes and were only
   answered because the human typed something. Wake-ups later began working in the same session;
   cause unknown. `room_spawn` should say loudly at spawn time when the lead cannot be woken, and
   the workers skill (0.7.0) now tells leads to block on `room_wait`.
4. **Workers die silently.** Four Codex workers lost the MCP transport mid-run ("Transport
   closed") and never recovered; Codex does not restart a dead tool server, so they finished
   without done, preview or answers. Cause unknown: Room logs nothing about why it stops (no
   shutdown reason, no uncaught-exception handler). An invalid model name returned "spawned" and
   the worker exited with code 1 a minute later; another died from "model at capacity". The lead
   found all of this by reading log files. Fixes: log shutdown reason and uncaught errors; report
   an early or non-zero exit to the lead as an interrupt with the log tail.
5. **Noise.** 24 plan interrupts (cancelled or superseded plans), none useful; one dying worker
   produced six wake-ups in one second. Messages were delivered two or three times (channel, inbox
   prefix on the next tool reply, and the hook): 55 inbox blocks, up to 19 messages, including the
   lead's own message returned to itself. `room_state` reached 25,073 characters, half of it "open
   claims (95)". One worker made 108 claims for a directory nobody else touched; across workers,
   about 200 of 836 Room calls were avoidable claim traffic.
6. **Sharing hygiene.** The daemon followed each worktree's `data` symlink out of the worktree
   into gitignored data: 35 identical copies of one 287 KB CSV in the document. About 28% of
   publishes were run outputs; one results file was republished whole 49 times. `.DS_Store`,
   `.npy` and atomic-write temp files are read before being rejected. A merge or rebase in a
   worktree briefly published 41 files the worker never touched, because the watcher fires before
   the HEAD check. A stray directory copy published 74 files and dropped them 50 s later.
7. **Worktrees lack the inputs tasks need.** Eleven workers created their own symlinks into the
   main clone for ignored data; three asked first and were blocked. `room_spawn` should be able to
   link named untracked or ignored paths into the worktree, read-only.
8. **Spawn gaps.** No reasoning-effort setting, so the lead launched Codex outside Room for a
   high-effort run, which caused alarm mechanism (c). The compute budget line arrives after the
   task text is already sent; Room composes the worker prompt and should put the budget in it.
9. **Every worker re-indexes the symbol graph at once.** Six workers indexed the same 88 files
   simultaneously in about 7 s each, against 0.15 s alone.
10. **Sandbox friction.** Every `uv` call in a Codex worker needed a private cache directory
    (used 182 times), so each worker re-downloaded dependencies.

## Fixed the same day (0.7.0)

The "ahead of the room base but not pushed" line (76% of all server log output) is logged once;
custom local room names no longer strand a lead or its link; the before-tool hook covers shell
edits; workers get thread caps and lower scheduling priority; a question to a worker that is done
is answered at once; a finishing worker's summary is said once; "idle" is gone; local rooms keep
their history; finished workers retire into an archive.

## Proposed order

1. Trust: false alarms (1), plan noise and duplicate delivery (5), claims released on exit (1b),
   early-death reports and shutdown logging (4).
2. Integration: collecting worker output including untracked files, preview on new files (2),
   effort and budget in the worker prompt (8), linked inputs (7).
3. Hygiene and cost: symlinks, default ignores, churn debounce, HEAD settling (6), shared graph
   index (9), compact `room_state` and claim granularity (5).
