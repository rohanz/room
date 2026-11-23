# Conflict wakes from state, not from messages (proposal, 2026-11-23)

Status: step 1 (atomic pair publication) landed 2026-11-23. Step 2 was replaced: a record-only
recorder went through two reviews without becoming trustworthy and was dropped, because the
existing `wake: woke … for merge-conflict cf:<pair>:peer:<episode>:…` log lines already give
wakes per session, pair and episode (the session measured below: 41 conflicts, 332 wakes, so
291 more than one per conflict). Count the same on a long session after `2218f70b` before
deciding step 3. That count cannot show a conflict with no wake at all.

## Why

Room stores who conflicts with whom as replicated state (the `conflicts` map). It then turns
every change in that state into a bus message, and each message needs an id, a duplicate rule,
a "cleared" partner, hub registration, and special handling for restarts, retired workers and
successors. On 2026-11-22/23 two attempts to make an open conflict wake a session once went
through seven independent reviews. Every "no" was a real defect in that conversion, not in
conflict detection:

- an interrupted check ending a conflict early; a false all-clear; a hidden conflict from old state;
- two openings sharing one clearing id; a quiet update and a waking notice sharing an id;
- a successor worker's notice deduplicated against its predecessor's;
- a wake remembered after the notice it stood for had expired unread.

What landed (`2218f70b`) is a patch: later updates to an open conflict are quiet, with an
in-process memory of "already woken" that falls back to waking when unsure. It has one
documented limit. It should remove most of the interruptions; it does not remove the cause.

Measured in one real session (about 40 workers, seven hours, before the patch): 426
conflict-type wakes in four hours, one worker woken 185 times.

## The idea

A session's conflicts are a level, not a stream of events. Each session reads the conflict
state and decides for itself:

- **Open set:** the peers (and, for the per-claim and per-symbol kinds, the claim or symbol)
  it currently has a settled conflict with.
- **Wake:** when something is in the open set that this session has not yet been shown.
- **Show:** the inbox line is written from the current state when the session reads it, so it
  is never out of date.
- **Cleared:** the entry is no longer in the open set. The session forgets it, so a later
  conflict with the same peer is new.

"Has this session been shown it" is one small record per open entry, kept where delivery
receipts already live. Nothing is posted, so there is nothing to deduplicate, supersede,
register or retire.

## What it needs (from a map of today's code)

1. **A wake source that is not a bus message.** Today wake candidates come only from the
   ledger's bus messages (`wake-reconciler.ts`, `ledger.ts`). This adds a second source.
2. **True states only.** A check writes one file at a time, so the map passes through moments
   that were never true (a pair looks clear between two writes). The abandoned attempt already
   showed the fix fits inside `conflict-set.ts`: publish a pair's result in one transaction,
   only when its evaluation completed. Review found that part sound. Measured cost: at most
   13 ms for 2,000 changed entries.
3. **A route for workers.** A worker's projected conflicts are stored in the team room, which
   the worker is not in; today it learns of them through messages in the workers' room. The
   lead is in both rooms and can read them directly. The worker needs the state mirrored.
4. **Readers that use messages today.** The web view builds its conflict cards and timeline
   only from bus messages; PR notes list `conflict` messages; `room_state` shows them under
   recent messages. `room_state`'s open-files list already reads the state.

## What goes away

About 700 lines that exist only for conflict notices: both `notice-lifecycle.ts` files
(193 and 148 lines), the posting half of `ConflictSlots` (about 220), the projected copies,
the superseded-notice read rule, worker-notice retirement, and the hub's lifecycle operation
and capability. About 19 test files (around 7,000 lines) are mainly about these and would be
replaced by a much smaller set about state transitions.

## What it costs

- **Size:** several days of worker time, in the most sensitive path Room has (waking).
- **History:** the web timeline and PR notes would show current conflicts, not past ones,
  unless a small history record is kept on purpose.
- **Shipped work removed:** the notice lifecycle from 0.17.4x.
- **Upgrade:** old sessions keep posting notices until restarted. With one user that means
  restarting sessions once; conflict-type messages already in a room expire as today.

## How I would build it, so each step can be judged alone

1. **Atomic pair publication.** Take it from the `wake-once-attempt` branch, alone, with its
   tests and a review. Useful by itself: `room_state` stops showing half-written results.
2. **Record only.** Compute the state-derived wakes beside the real ones and log both, the way
   the conflict shadow does. One long real session then shows whether they agree, and how
   many wakes each would have produced. No behaviour change.
3. **Switch and delete.** Only if step 2 agrees: wake from state, move the web view and PR
   notes to the state, delete the notice machinery.

Stop after any step if the evidence says so. After the quiet-updates patch, step 2's numbers
may show the remaining problem is small enough that step 3 is optional cleanup.

## Decisions for Rohan

1. **Go, wait, or stop.** My recommendation: do steps 1 and 2 now (small, no behaviour
   change), decide on step 3 from a real session's numbers.
2. **Sibling workers.** Decided 2026-11-23: keep today's behaviour. Two workers whose edits
   overlap are both woken, once per conflict, so they can settle it directly. The worker
   route in item 3 is therefore needed.
3. **History.** Is losing past conflicts from the web timeline and PR notes acceptable?
4. **Per-claim and per-symbol notices.** They have the same wake-on-every-change pattern and
   were left unchanged by the patch. Include them in the redesign from the start, or file
   conflicts first?
