# Design audit synthesis, 2026-09-27

Two independent whole-system audits of Room 0.16.21 (982515c):
- [Astra, gpt-6-astra high](audit-2026-09-27-design-astra.md): 14 findings.
- [Fable](audit-2026-09-27-design-fable.md): 15 findings.

They were asked for design-level problems, not line-level bugs, because diff reviews on every change
for weeks kept finding local races.

## The shared diagnosis

Both audits reach the same root cause from different directions:
- **One fact lives in several places.** A fact is decided in several places, or replicated state is
  used as local authority.
- **Correctness hangs on events.** Correctness depends on observing events (transitions, callbacks,
  timers) rather than on reconciling current state.

The 0.16.15–0.16.18 retention rounds were one instance: the fix that ended them (0.16.17) replaced an
event-driven flush with a state rule. The same shape recurs elsewhere.

## Where they agree

| Area | Astra | Fable | What both say |
|---|---|---|---|
| Message delivery and "seen" | 5, 6 | 2 | Receipts live in several ledgers; delivery marks seen before the recipient has it; hook state is per checkout while delivery is per session. |
| Sharing and scope | 3, 9 | 1 | Sharing policy is decided in about 8 places. Scope is at once authorization, coordination and publication state. |
| Worker records | 2, 7 | 3 | Status is written on edges by several writers. Replicated records authorize local actions. Worker keys are narrower than the resources they lock. |
| Conflicts and dedupe | 10 | 5 | Conflicts are evaluated on events, with process-lifetime dedupe sets. There is no reconciliation at start or reconnect. |
| Clocks and garbage collection | 12 | 7, 9 | Writer timestamps are compared with reader clocks. Joiners delete others' work on staleness. |
| Server trust | 11 | 8 | The identity guard is observe-only, deletes are always allowed, and the size cap drops writes silently. |
| Structure | 13 | 11, 13 | Wide `HandlerState` and `PublicationHost`, plus remaining import cycles. |
| Resume reply and ledger wording | 14, note 4 | notes 1, 4 | Historical "is on" lines read as current. The resume reply doesn't say it resumed the retained conversation. |

Found by one audit only, and checked:
- **Astra 1** (collection has no durable journal): real. A kill during collection leaves a partial
  apply. Rare.
- **Astra 4** (local-room value snapshots resurrect deleted entries): reproduced in memory by Astra.
  It affects local rooms and workers rooms only; the hosted server stores full Yjs history.
- **Astra 8** (pollHead records the new HEAD before its transition succeeds): real, and a small fix.
- **Fable 4** (divergence from the room base stops the daemon): deliberate. A diverged checkout must
  stop and ask rather than merge. The trial rules forbid force pushes. Revisit with repository-level
  rooms.
- **Fable 10** (carried files count as worker changes after the worker's first commit): real. Workers
  are told not to commit, so it's low impact for the trial.
- **Fable 12** (compatibility layers nobody runs): true. Removing them is a schema-version decision for
  after the trial.

## Before the trial (0.16.22)

These are small, concrete fixes, each with a failing test first:
1. **Resume reply.** Say that Room resumed the worker's retained conversation (both audits).
2. **Scope and ledger replies.** Render past activity as history, not as "is on", and leave out the
   event this reply itself just posted (both audits; live-check notes).
3. **Worker briefing filter.** Order by bus position, not by comparing wall clocks across machines.
   Two machines a few minutes apart currently lose a worker's briefing (Fable 9, Astra 5).
4. **HEAD transitions.** pollHead records a HEAD as applied only after its whole transition succeeds,
   and retries otherwise (Astra 8).
5. **Level-triggered publication.** Reconcile Git changes once the watcher is ready, and on a slow
   periodic timer, so a missed watcher event cannot leave an edit unpublished (Astra 9).

## After the trial: the design work

Each item removes a class of problems, not one instance. They are ordered by how many recent bugs
their class produced.

1. **One delivery ledger.**
   - The CRDT `seen` is the only receipt.
   - Pending delivery is kept apart from bounded history, and addressed messages are kept until
     acknowledged.
   - Hook state is keyed by host session ID.
   - The other seen sets are deleted.
2. **One sharing policy value.**
   - Owner authorization, the derived coordination scope, and a manifest of published paths become
     three separate records.
   - Readers use the manifest.
   - The bridge never overwrites authorization.
   - `sharingGeneration`, the `setShare` monkey-patch and `isShared()`'s side effect go away.
3. **A local worker registry.**
   - A durable local record authorizes directories and host sessions, and records launch intent
     before spawning.
   - The CRDT carries a status projection.
   - Workers are keyed by globally unique IDs.
   - Status is computed at read time from `workerRealState`.
4. **Derived conflicts.** A conflict set keyed by participants, path and input revisions, reconciled
   on start, on reconnect and on change, with deterministic IDs.
5. **One participants view.** Everyone filters one `participants(doc, awareness, now)`. Staleness is
   a local view decision; destructive expiry has one authority.
6. **Collection journal.** Record original bytes and phase before writing, replace files with
   temp-and-rename, and recover before the next collection.
7. **Local-room causality.** Keep causal checkpoints, or introduce a document epoch that reconnecting
   clients rebuild from.
8. **Server trust model.** Choose between "admitted means trusted" plus a schema version, and
   validated operations with explicit rejection. Drop the shadow document.
9. **Structure.**
   - Narrow capability interfaces per handler.
   - Break the import cycles: shared `claims/format/messages`, `registry` ↔ `worker-launch`, and
     `session` ↔ `connection`.
   - Remove the compatibility layers behind a schema version.
   - Two sessions in one checkout get one daemon per checkout.

## What both audits say to keep

- The one-way overlay model, with collection as the only writer of the lead's files.
- The carried-work baseline.
- Process identity by pid, start time and executable.
- `workerRealState` with the `decide*` functions.
- Path safety (`repo-path.ts`, `git-dirs.ts`).
- GitHub admission and read-only viewers.
- The message kind registry.
- The pure `eligibility()` core.
- Yjs itself.
