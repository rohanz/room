# Receipt replay after a graceful daemon restart

Status: investigated 2026-11-09/10; fix proposed, not implemented. Evidence under
`/tmp/room-soak-daemon-3h-d`, `/tmp/room-soak-repro-{a,f,g,k}` (reproducing) and
`/tmp/room-soak-repro-{d,e,h,i,j,l,m,n,o,p,q}` (not reproducing); harness commits on
branch `soak-daemon-harness`.

## Symptom

After the local daemon is stopped with SIGTERM and restarted, some participants are
redelivered every addressed message they received since the previous compaction: in the
3 h soak, 735 messages to four of eight participants within a minute of the restart; in
24-minute runs, 100 to 240 messages to between three and six participants. Nothing is lost;
an agent is flooded with stale claim, conflict, question and answer notices.

## What the data shows

1. The daemon's saved snapshot and its reloaded document hold every receipt before and
   after the restart (observer sampling and snapshot copies agree, per participant).
2. At the moment of a redelivery the participant's replica has the full bus (its own copy,
   not doubled) and is `synced`, but its own receipt map answers `has()` false for every
   key. The map still holds one item per key; every item is a deleted tombstone and every
   one was written by the *previous* snapshot's lineage (the copy a compaction loaded).
   The newer snapshot's items for those keys are not present yet.
3. The ledger's receipt prune (`pruneSeen`) is not the deleter: with it instrumented
   from the loaded package, no reproducing run recorded a prune. (Three earlier "no prune"
   results were invalid: the worktree's `@room/*` imports resolve to the main checkout, so
   patches there never ran; see memory `worktree-shared-packages-resolve-to-main`.)
4. Forcing each newer snapshot copy to sort *before* the previous one in Yjs tie-breaks
   produced zero redeliveries; unforced, roughly half the runs reproduce.

## Mechanism

A graceful stop saves `memorySnapshot(doc)`: a rebuilt copy with fresh Yjs identities,
the same object the compaction path writes. Compaction treats that copy as a new
generation and refuses surviving replicas (close 4409, rejoin fresh). A graceful restart
keeps the generation, so survivors reconnect and *merge* with a document of a different
lineage. Every bus message and every receipt then exists twice. The hub removes bus
duplicates (`reassert`). Receipts are Yjs map entries, and Yjs resolves two concurrent
items for one key by identity order: the item that sorts earlier is marked deleted at
integration time ("not the current attribute value"). When the newer snapshot's identity
sorts later than the previous one, the daemon deletes the survivor's receipt items as it
integrates them and broadcasts that deletion. A replica that applies the deletion before
it holds the daemon's copies reads every receipt as gone, owes everything, and redelivers.
The exact message ordering that lets the deletion precede the copies was not captured
(reproduction is load dependent); the data in (2) is that state, observed.

## Fix

1. **A graceful stop ends the generation.** When the final save succeeds, stamp a new
   generation into the snapshot (the compaction path's `writeMemory(..., generation)`),
   so the restarted daemon refuses survivors with 4409 and they rejoin with fresh
   replicas. No merge of lineages, so no duplicate bus entries and no demoted receipt
   items. Only a crash, where nothing was saved after the last debounce, keeps the
   generation; that is the one case where survivors hold posts the file lacks.
2. **Relay: no broadcasts to a connection before its first sync reply**, and never drop a
   sync step 1 while the daemon is not yet accepting; queue it. Protects the crash path
   and any other partial-sync moment.
3. **Ledger: prune receipts only for messages provably ended** (present in `archive` or
   `outcomes`), never for "not on the bus I currently see".

Validation: the soak reproduces at roughly one run in two with `SOAK_COMPACT_MIN_DELETED=300`
and restarts at 8 and 16 minutes; after the fix, ten such runs must show redeliveries only
of the at-least-once kind (receipt written offline, replica discarded before reconnecting).
Unit: a daemon-fixture test that a survivor across a graceful restart is refused with 4409
and that a fresh replica's receipt map matches the snapshot's.
