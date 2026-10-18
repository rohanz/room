# Historical roadmap findings

These sections preserve the dated 0.16 fixes and 2026-09-27 findings from the roadmap. They are historical evidence, not a current open-issue list. See the [current roadmap](../roadmap.md) and [reference](../reference.md).

## Fixed in 0.16.3

- **Crash recovery lock race (0.16.1 audit finding 8):** automatic-name and choice locks now serialize stale-owner recovery with a reclaimable guard and re-read the owner before removing a lock.
- **Worker port reservations (0.16.1 audit finding 9):** worker ports now include the parent, use machine-local reservations across leads, and release or reclaim reservations after worker exits.

## Fixed in 0.16.4

- **Worker wording and bookkeeping (0.16.x check):** Discarding a worker launched in an existing directory reports the stop and retained directory without an error. Its own model is shown, and the lead's edits are not counted as worker files. Worker counts match displayed rows, preview names use full room names, and a finished worker's resume reply says it was restarted.
- **Leave, preview, and branch switch (0.16.x check):** Plain `room_leave` refuses while workers run; `force=true` dismisses them. Preview lists accept the lead's name alongside others, and a branch switch delivers one reply after joining the new room while marking the old room warning seen.

## Fixed in 0.16.6

- **Path safety (2026-09-24 cleanliness audit finding 14):** one repo-relative validator and one containment helper with explicit leaf policies for every read, write, carry, recovery and baseline path.
- **Git-private state paths (2026-09-24 cleanliness audit finding 17):** one worktree-private and one common Git-directory resolver plus one carry-record accessor, parity-tested against the hook copy.

## Fixed in 0.16.7

- **Worker lifecycle (2026-09-24 cleanliness audit finding 18):** one real-state report and one decision table per lifecycle operation, and one launcher for fresh and resumed workers.
- **Resume race (0.16.4 live check):** a message sent right after a worker finishes waits for the old process to exit and resumes the worker once, or says plainly that it was not delivered. It is never left on the bus twice.

## Fixed in 0.16.8

- **Proximity evidence (2026-09-24 cleanliness audit finding 16):** one `coordinationPaths` builder in `packages/shared/src/near.ts` for claim guidance, hook snapshots and room-state visibility; room_state now shows a participant whose changed paths alone made the claim hook warn.
- **Graph refreshes (2026-09-24 cleanliness audit finding 21):** an overlay event refreshes only the paths it touched, and initial and incremental refreshes share one queue of 8.
- **Stale base notices (rehearsal 2026-09-25, second run, finding 9):** a base notice whose commit is already in the recipient's HEAD is marked seen instead of delivered, on every delivery path.

## Fixed in 0.16.10

- **Workers in room_state (0.16.7 live check):** room_state shows the lead's current workers (running, finished but not collected, stopped) by default; retired history is listed with `all=true` and labelled collected, discarded or stopped (reason).
- **Discard logs (0.16.x check):** discarding a worker whose worktree vanished now removes its `.log` and `.mcp.log`, through the same cleanup as a normal discard.
- **Implicit answers (rehearsal 2026-09-25 finding 11):** an answer without `inReplyTo` answers the sender's one open question from the recipient, or lists the candidates.
- **Carried edits (every live check):** workers build on the lead's carried edits without asking; they ask only before changing or removing the lead's own lines.

## Fixed in 0.16.12

From the [2026-09-26 triage](reports/triage-2026-09-26-roadmap.md):

- **Claims revalidated after HEAD moves (triage 1):** your own claims follow their lines to the new HEAD, or are released with a note naming the commit.
- **Notes to nobody (triage 2; carry-wip "broadcast rulings went out as fyi"):** an unaddressed notify or interrupt note reaches every other participant's inbox.
- **Preview without `run` (triage 5; tree-sitter "a clean merge preview hid a semantic break"):** the reply says no tests ran and suggests the repository's test command. Running them by default remains open.
- **"git push" with no remote (triage 10; 0.8.0 "labels compare against the room's base"):** says "committed locally" and gives push advice only when the remote branch exists.
- **Lingering process renames you (triage 3):** the temporary `+<host>` name is not remembered.
- **Unreachable sharing ceiling (triage 6):** not cached; the local choice applies and it is fetched again on reconnect.
- **Declared output lost on restart (triage 7; review finding 29):** retained declared paths persist per worktree.

Proved fixed earlier by the triage and marked inline below: preview em dash (0.15.1), preview environment leak, exit-status verdict, note recipient display, bare worker tag, Codex hook message to a Claude lead (0.10.2), double wakes, stale eval mocks (0.15.1), directory claims (0.10.2), questions to busy workers (before-edit hook), recovery patches for landed work and the spawn-time hook warning (0.14.1), the sharing banner (0.10.1), real-repo measurement (`measure-room-perf.mts`). "A collected worker cannot take a fix-up" is by design since 0.15.0.

## Found 2026-09-27, after the trial

- **Receipts are per participant, not per session.** A hook receipt written by one session can hide a message from another session with the same participant name in the same worktree. This belongs to the delivery-ledger redesign in docs/archive/reports/audit-2026-09-27-design.md.
- **An agent cannot reply to a note, only to a question.** In the httpx rerun, an agent could not acknowledge a status note. **Fixed in 0.16.33:** `inReplyTo` may name a note addressed to you; the reply goes to its author as a note with `inReplyTo` recorded and answers no question.
- **Force-push recovery closes the room for everyone.** 0.16.29 lets `room_close` work unjoined, but a reset branch still needs close-and-reopen, and that drops the room's history. With repository-level rooms, re-base the room when its recorded base is gone from the remote (audit 2026-09-27, Fable 4).
- **Duplicate delivery after a Codex queue wake.** Since 0.16.26 an agent can see a queued message twice. A registered prompt-submit hook could record receipts when Codex injects the message, but `hooks.json` is frozen, and changing it un-trusts the hooks for every Codex user.
- **A worker's own preview flags its carried lead edits as a conflict.** A worker that starts from the lead's uncommitted work compares against the original base, so its `room_preview_merge` reports a conflict at the carried lines. The lead's preview and collect are correct; this is a false alarm that can waste the worker's time. The worker-side preview should use its carried base, as the lead side already does (`workerBaseline`). **Fixed in 0.16.33:** the pairing was already shared; the cause was the lead's side. With no overlay for a file, the worker read the lead at its pre-carry HEAD. When the lead's version still equals its HEAD, and that HEAD is an ancestor of the carried base, the lead's side is now the pair baseline.
- **A fresh worker's startup context includes finished workers' scope history.** It is rendered as "earlier: … was on …", which is accurate but is noise for a new worker. Drop other workers' finished scope events from a worker's startup briefing.
- **Previews at declared sharing can be partial while a teammate is mid-task.** In the Flask rehearsal, a preview had a teammate's new tests but not yet their fix. Show per teammate which declared files are not shared yet, or how old the shared ones are, so a partial preview is not read as a regression.
- **Fixed in 0.16.33: name presence check missed a live peer.** Root cause: the symbol index blocked the event loop on a large repository, so presence heartbeats stopped. Original note: In the Codex-repo rehearsal, a session joining 42 s after another saw no presence for it. 0.16.32's machine-wide lock covers the same machine. For one user on two machines, reproduce against a running server with two separate joins and find why the temporary provider's awareness was empty.
- **Merge preview git timeout on large repositories.** A three-way preview in an 86 MB repository failed on a git timeout. Scale the timeout with repository size, or make it adaptive. **Fixed in 0.16.33:** whole-tree git steps get 30 s + 15 ms per path, capped at 5 minutes; a preview that still times out names the step and says the combined code was not checked.

