# Repository-level rooms (spec `reporooms`, 2026-09-28, revision 3)

Status: design only (phase 1 of the Room redesign), against branch `redesign` at 0.16.33 (0481a9b); line
numbers are pointers and drift. Revisions 2–3 resolve `reviews/2026-09-28-reporooms-review.md` (MF1–MF14,
SF1–SF7, second-pass N1–N2 and the partly-resolved items; the three Leave items are kept). Revision 4 (same
day) carries the human's decisions: D1, a hashless held side gives a *possible* conflict (§B5); D2, the hard
cutover (§Migration); D3, admitted means trusted (invariant 9); D5, presence ends within a bounded time and
only the worktree's publisher writes base facts and posts `pushed` (invariants 10–11, §B2, §B4, participants
view). It also records the wave-0 lead rulings on `participantRecord`, `acceptedGit` and presence.
Revision 5 (wave 1, rollout step 2 as built): the `update by push` reflog test in §B4, the explicit-name
`origin` fallback in §B3, the expiry tenure details (holder-only measurement, restart on a concurrent
write) and H1 (risk 8).
Revision 6 (same day, the lead's hub decision; [hub spec](2026-09-28-hub.md)): the room's hub grants names
with an epoch and writes `holder`, posts are hub requests (so `pushed` and conflict notices follow their
transactions by ID), and the hub is the one expiry authority, on its own clock.

Lead rulings: **R1–R6** (the brief); **R1a** (this spec owns the participant record; registry adds
`holder`); **R3c** (a team-room base is an anchor peers can resolve; a projected worker uses the lead's
current team-room base; the lead–own-worker pair is not evaluated in the team room); **R6a** (`schemaVersion`
2 for all of 0.17; schema-less clients refused on repo-room docs, branch-room joins refused once migrated).
Review rulings: old view tokens revoked, archive behind an authenticated endpoint (MF6/MF14); ambiguous
names to an unresolved archive (MF8); flat participant records (MF11); the projector evaluates and
level-reconciles its workers' conflicts (MF13, N1); local migration is an insert-only catch-up (N2); the
unjoined admin close stays (SF1); admitted means trusted (SF6); `pushed` carries `{fromSha, toSha}` and
`to` only ever means the addressee.

Siblings, in the lead's tree: [ledger](2026-09-28-ledger.md), [manifest](2026-09-28-manifest.md),
[registry](2026-09-28-registry.md). Input map: [2026-09-21-repo-rooms-map.md](2026-09-21-repo-rooms-map.md).

## Goal

There is one room per repository. Each participant publishes its own `{branch, head, base}` (R3). Checks
between two participants are computed at the git merge base of their two bases, on the reader's machine. A
teammate on another branch is ordinary company. No room-wide commit is left that could lock a team out.

This is the "everyone is near everyone" case of the neighbourhood design (roadmap, "Decided 2026-09-21" and
"cost scales with overlap"). `neighbours()` in `packages/shared/src/near.ts` is the **consumer-selection
seam**: every place that picks whose state to consider goes through it. Today it returns every visible
participant. Scaling later narrows it. That later step also needs per-neighbour document subscriptions,
reconnect reconciliation and routing (§B9); it is more than a new function body.

## Problems it removes

Roadmap gap 1: teams that work one branch per person sit alone. **Fable 4**, the force-push lockout
(which 0.16.29's unjoined close only works around), `followBranch`, **Fable 5 / Astra 10**'s event-driven
conflicts, and the `behindBase`, Merged-tab and `meta.base` readers. Each is placed in §B1–B14 with its
deletion. 0.16.32's name lock gives way to the registry lease keyed by `roomKey`.

## Invariants

1. A room name has no branch: the canonical repo name for team rooms, `local/<main worktree basename>` or an explicit name for local rooms.
2. Nothing reads or writes a room-wide commit; `meta.base`, `meta.branch` and `meta.seededBy` are gone.
3. Each participant field has one writer (`git`: the worktree's publisher, registry §16, or the projector; `id`: the lease-holding session; `holder`: the room's hub, hub §4.1), and readers accept `git` only through `acceptedGit`, whose fence is the hub-granted lease (R1a; the epoch from wave 4).
4. `git.base` is an anchor every reader can try to resolve (R3c); with none, `anchored: false` and peers report "cannot compare", and base resolution never throws.
5. A pair is compared at `merge-base(A.base, B.base)`, and a commit that cannot be fetched yields "cannot compare" for that pair only, never an error, "equals base" or a daemon stop.
6. A HEAD transition ends in one Y transaction writing the `git` record (with `pushedPending` when a `pushed` is owed), the manifest entries and head (manifest §5.4), and the owner's claim moves and releases; the `pushed` notice is then posted to the hub by its deterministic ID (§B4; hub §2.3).
7. A conflict slot has a deterministic key, one fenced writer and deterministic notice IDs, and it leaves `conflict` or `possible` only on a clean evaluation at current inputs, never because its path left the candidate set. Contract slots are the exception: they are removed silently when either path leaves its owner's text-authorized area. A slot is `conflict` only when both sides' versions were read; a side that is a hashless held entry (manifest invariant 16, D1) makes it at most `possible`.
8. A branch switch never changes the room, the participant name, the cursor or the receipts.
9. Admitted means trusted (SF6; confirmed by the human as D3, 2026-09-28): single-writer rules are client discipline plus fences, and a write the server drops is surfaced to its writer as a rejected state. Validated operations are post-redesign roadmap work.
10. A participant's presence ends within a bounded time once its host session has finished, even when its MCP process lives on (D5; registry §18). A quiet session holding scope or claims whose host is still alive is shown idle, never dropped; a shared app-server session idle for eight hours releases its own claims and scope first (H1, registry §18).
11. Only the worktree's publisher (registry §16) writes a `git` record and posts `pushed`. Other sessions in the same checkout never write base facts or announce base moves (D5).

## Data model

### Room names: `packages/shared/src/rooms.ts` (new)

```ts
export function canonicalRepo(originDerived: string): string          // client: from normalizeGitOrigin only
export function repoRoomOf(name: string, isOpen: (repo: string) => boolean): string | undefined // server only
export function roomNameParts(name: string): { repo: string; host?: string; owner?: string; local: boolean } // moved from views.ts:6
export function roomKey(server: string | 'local', room: string): string  // registry leases and records
```

- **Clients never parse a stored name to strip a branch (SF4).** They derive from the origin
  (`normalizeGitOrigin`, `roomd/src/git.ts:62`, now lower-casing `github.com/<owner>/<repo>`, MF9) or use
  explicit names verbatim. Only the server maps legacy names, with `repoRoomOf(name, rooms.has)` (longest
  open prefix, which settles `git/h/repo/main` vs `git/h/grp/repo`, `names.ts:34`); the web uses the
  canonical name the server returns. `roomKey('local','local/x')` = `local/x`; `roomKey(server, name)` =
  `<ws origin>/<name>`. `roomNameParts` stops reading `local/foo` as a non-local repo (`views.ts:6-16`).

### Participant record: flat fields (MF11)

```ts
// participants: Y.Map<string, unknown>; key `${name}\u0000${field}`; every value is a whole JSON value (LWW)
'id'     -> { name, kind, owner?, label?, host? }                    // writer: lease-holding session
'holder' -> { sessionId, epoch, pid, startTime, executable, workerId?, at, ended? } // writer: the room's hub (hub §4.1)
'git'    -> ParticipantGit                                           // writer: the worktree publisher's daemon, or projector
'proj'   -> { projectedFrom: string /*worker id*/, projectedBy: string /*lead name*/ } // writer: projector
interface ParticipantGit {
  branch: string; head: string       // '' branch when detached; head is display-only, others may not resolve it
  base: string; anchored: boolean    // R3c; anchored=false: no resolvable anchor, peers report "cannot compare"
  remote?: string; upstream?: string // the room's remote and the ref used; ahead/behind are display only
  ahead?: number; behind?: number
  rev: number                        // +1 per completed HEAD transition
  fence: string                      // the writer's lease epoch (own) or the lead's (projection); session id until wave 4
  pushedPending?: { fromSha: string; toSha: string } // a `pushed` this transition owes (§B4)
}
export function participantRecord(doc: RoomDoc, name: string): ParticipantRecord | undefined // raw fields, unfenced
export function acceptedGit(record: ParticipantRecord, view: ParticipantView[]): ParticipantGit | 'updating'
```

No nested `Y.Map` exists, so two clones inserting `ben` concurrently cannot detach a writer's child map;
each field is last-writer-wins. **Fence (wave-0 lead ruling):** `participantRecord` returns the raw fields
and applies no fence. Every reader of `git` goes through `acceptedGit`, the one place that applies both
fences: `git.fence === holder.sessionId` (own) or `=== liveHolder(view, proj.projectedBy)` (projection);
otherwise it returns `'updating'`. From wave 4 the compared value is the hub's lease epoch (hub §4.1). There
is no `holder` race: the hub grants the name to one session, and a session whose lease lapsed or was
superseded stops publishing and re-acquires or renames (registry §15). `manifestHead.fence` (manifest §4.1)
follows the same rule. A
participant that shares a checkout with its publisher has no `git` field (invariant 11); readers show
"shares this checkout with <publisher>" from its `manifestHead.publisher` (manifest §5.7).

### Participants view (owned here; the manifest's `liveHolder` depends on it; SF5)

`packages/shared/src/views.ts`:
```ts
participantsView(doc, awareness, now): ParticipantView[]  // {name, kind, fresh, visible, holder, projectedBy?, idleMin?}
liveHolder(view, name): string | undefined                // holder.sessionId while that session has presence
// presence (awareness) gains: sessionId?: string; idleMin?: number   (wave-0 lead ruling; D5)
```

`fresh`: a presence entry exists whose `sessionId` equals `holder.sessionId` (wave-0 lead ruling; a
presence entry without `sessionId`, or with another session's, is not fresh). `visible`: fresh, or has
records and not expired; hiding is a local view decision that deletes nothing.

**Presence ends (D5).** On 2026-09-28 about 30 Room MCP processes were found outliving their Codex threads
under one shared `codex app-server`, and seventeen sat in one local room as present participants for two
days. Each session therefore ends its own presence by registry §18's rule: at once when its bound host
session has ended, and after the idle lease when it cannot see its host. `idleMin` is the session's own
measure of minutes since its last host activity (a Room call or a hook contact; registry §18), written by
that session on its awareness heartbeat and never compared with another machine's clock. Views render it
from 10 minutes on: "ben (idle 25 min)", and for a quiet session that holds scope or claims "ben (idle 3 h;
holds 2 claims)". Such a participant stays fresh and keeps its claims; leaving presence (awareness removed,
provider closed) is what makes it not fresh. Leaving deletes nothing: its records, claims and owed mail
stay and age toward the expiry below. **One destructive-expiry authority**
(Astra 12, Fable 7): the room's hub (hub §8; amended for the hub, it was the trim leader).
**Observation epochs (S5):** each hub incarnation is an epoch. During its own epoch the hub measures
continuous absence (records present, no live lease) with its **own monotonic clock** and adds only those
measured durations to `expiry[name] = {observedMs, epoch}`. No wall-clock timestamp written by another
machine is ever compared with the hub's clock. A new incarnation starts a new epoch and adds only its own
measurements, and time with no hub counts for nothing. The hub clears the entry of any live holder
(`observedMs` reads 0). When `observedMs` ≥ `ROOM_STALE_DAYS` (7), the hub runs
`expireParticipant(name)`: participant fields, manifest, head, text, claims (with release notices), scope,
graph and owned slots, in one transaction; owed mail is the ledger's and stays. Workers are retired by their
projector (registry) and are never measured. `evictStale` (`join.ts:342-356`) goes.

As built (wave 1, `shared/src/expiry.ts`, `ExpiryTenure` and `expireParticipant`; wired into
`trimBusIfLeader` through the ledger's `trimLeader`/`leadsTrim`): a tenure starts when `leadsTrim` flips
to true (a new `ep_…` epoch) and ends when it flips back. Its first observation of an absent participant
only starts a measurement. It adds time only while `expiry[name]` still holds what the tenure last saw
there; a write by another leader (a partition) or a deletion restarts its measurement from the value found,
so two leaders never count the same interval twice. Only participants with a `holder` field are measured:
until wave 4 writes `holder`, no participant can be `fresh`, and measuring holderless records would expire
live participants. **The hub step** keeps `ExpiryTenure` and `expireParticipant` in `shared/src/expiry.ts`,
runs them in the hub with `epoch = inc:<I>` and `fresh` meaning "live lease", and deletes the roomd wiring and
`trimLeader`/`leadsTrim` (hub §8). The partition case above cannot arise with one hub.

**No `expiresAt` in the view.** An earlier draft had `ParticipantView.expiresAt?`; it is dropped. A
timestamp would have to be derived from another machine's measurement, the thing this paragraph rules
out, and nothing in step 1 writes `expiry`. `visible` (records present and not yet expired) plus the
hub-written `expiry[name].observedMs` cover it: a view that wants to show "offline 3 days; expires in
about 4" computes `ROOM_STALE_DAYS − observedMs` at render time, so the participants view needs no field
for it. That display lands with the expiry authority (the trim leader's `expiry` writes and
`expireParticipant`) in rollout step (2), the plan's wave-1 `base` worker (lead ruling, 2026-09-28): it is
participant lifecycle, owned here, and wave 1 is where the ledger's trim leader landed (`delivery`). The
hub step then moved the authority to the hub (above). The "expires in about
N days" rendering itself is a view change and lands with the web readers.

### Conflict slots: new root `conflicts`

```ts
interface ConflictSlot {
  kind: 'merge' | 'edit-in-claim' | 'claims' | 'contract'
  owner: string; other: string; path: string; subject?: string // claims: `${myId}\0${theirId}`; contract: symbol
  status: 'conflict' | 'possible' | 'unknown' | 'clean'  // possible: one side hashless (D1), §B5
  inputs: string            // sha256 of every evaluation input (below): recompute only when it changes
  factId: string            // sha256 of what is reported (below): a new factId in `conflict`/`possible` is a new notice
  settled: 'conflict' | 'possible' | 'clean' | 'none'  // last non-unknown status; drives epochs across `unknown`
  epoch: number             // +1 on every notified conflict (§B5 step 4)
  lines?: number[]; why?: string
  fence: string             // the evaluator's lease (own, or the projector's for a projected owner); epoch from wave 4
  checkedAt: number; retryAt?: number   // display; unknown retry schedule
}
// key (slot identity): `${owner}\0${kind}\0${other}\0${path}\0${subject ?? ''}`
// a possible conflict (D1) lives in the same `merge` slot; its fact identity is
//   factId = sha256('possible' \0 path \0 mergeBase \0 owner.change \0 other.change)
// with no hash from either side, and its notice ID is `cf:<h(slot)>:<epoch>` like any other
```

The slot key never contained a hash, so a pair keeps one slot as its sides move between hashed and
hashless: the status and `factId` change, the key does not.

**Inputs (MF2)** hash everything that can change the answer: both bases, the merge base and `anchored`;
per side, the path's manifest entry `{hash, state}` (or the blob at base for a committed-only change) and
that side's `manifestHead.semRev` (manifest §4.1; it changes with coverage, exclusions, level,
completeness and fence); for claims each `{id, from, to, claimedHash}`. **A hashless side (D1)**, a `held`
entry with no `hash` (manifest invariant 16), contributes `{change, state, held}` in place of
`{hash, state}`, so its owner's re-edits (which move only its `at`) change neither the inputs nor the key.
**Fact identity** is what the notice reports, so edits that leave the conflict unchanged do not re-notify:
`merge`, the base-side text of the conflicting hunks plus the merge base; `possible`, the path, the merge
base and each side's change kind, and nothing derived from either side's content; `edit-in-claim`/`claims`,
the claim IDs and geometry; `contract`, the symbol and its before/after signature (S3).
**Notice IDs:** `cf:<h(slot)>:<epoch>` (conflict), `…:clean`, `…:holder`; a post whose ID exists in
`bus ∪ mail` is skipped (ledger dedupe). **Trust:** admitted means trusted; nothing is added to the
observe-only guard in `server/src/readonly.ts`, and nothing relies on it (SF6).

### Meta, messages, server records, local files

- **`meta`** is `{repo, createdAt, schemaVersion: 2, roomSalt}`. The room creator writes `roomSalt` once,
  for the manifest (§4.1). The hub mirrors its counters as `hubIncarnation`, `hubEpoch`, `hubSeq` (hub §3).
  The root `expiry` is written only by the hub. The roots `unresolved`
  (written by migration, deleted by the claiming session) and `aliases` (placeholder → name, written by the
  claiming session) exist only after a migration with ambiguous names. `bases` and `baseOf`'s
  `meta.base` fallback (`doc.ts:226-229`) are not part of schema 2. `baseOf` reads
  `participantRecord().git.base`.
- **`pushed`** replaces `base` (`messages.ts:52`, `BaseMsg` `types.ts:99`):
  `{type: 'pushed', branch, upstream, fromSha, toSha, commits, paths, summary}` with ID
  `pushed:<name>:<fromSha>:<toSha>`. It has no `to`.
- **Server `OpenRepo`** (`store.ts:11`):
  ```ts
  { by?, at, lastSeen?, mode?: 'branch'|'repo', legacy?: string[], unresolved?: number, migratedAt?,
    plan?: { id: string; sources: string[]; archiveOf?: Record<string, string> },
    step?: 'planned'|'frozen'|'moved' }                  // migration progress (§Migration)
  ```
  `branches` becomes `legacy` on load and is never trimmed before the purge (map risk 4).
- **Local files (R5):** `<common>/room/relay.json` `{schema: 2, port, pid, startTime, key}` (§B12), the hub's
  `<common>/room/hub/authority.lock` and `incarnation.json` (hub §3, §5), memory
  `<common>/room/relay/<enc(room)>.ydoc`, catch-up ledger `<common>/room/relay/migrated.json`. 0.16's
  `room-local.json` and `room-local/*.ydoc` are left to the old relay and migration. `room-choice.json`'s
  `room` is only ever explicit (`choice.ts:52`), so it is kept verbatim (SF4).

## Behaviour per path

### B1. Naming and join

`deriveRoomName(dir)` (`session.ts:191`) returns `{repo, branch, roomName: repo}`; `localRoomName(dir)`
(`roomd/src/local.ts:20`) drops its branch segment and `localBranch`; `normalizeLocalRoomName` is unchanged.
An explicit `args.room`/`ROOM_ROOM` in legacy form is sent verbatim in the schema-2 preflight; the server
answers `{room: canonical}` and the client joins that with one reply line, "room names no longer carry a
branch; joined github.com/o/r" (a spawned worker never re-targets, §B12). `room_join`'s "already here"
(`join.ts:145-161`) no longer depends on the branch; the running-worker refusal (`:162-163`) stays for
local↔team moves. The join line and `room_state` line 3 read `joined github.com/o/r as ben (on feat-x,
base abc1234567, 2 unpushed)` (`join.ts:201`, `scope.ts:98`). Deleted: `pinnedRoom` (`session.ts:52,496,563`;
`index.ts:160`) and branch stripping (`join.ts:40,190`; `tools/index.ts:78`).

### B2. Branch switch and HEAD transitions (replaces `followBranch`; MF4)

**Deleted:** `followBranch` and `blockedBranch` (`join.ts:307-339`), the `HandlerState.followBranch` slot
(`context.ts:105`), its call and banner (`tools/index.ts:79,92`), roomd's `warnBranchSwitch`,
`namedRoomBranch` and `roomBranch()` (`roomd/src/index.ts:377,787-806`).

A branch switch, a commit, a pull and a reset are all one transition in `Roomd.pollHead` (`:752-783`).
The applied state advances only when the whole transition commits:
Only the worktree's publisher (registry §16) runs the whole transition (invariant 11, D5). A session that
shares the checkout without the publisher lease runs only its claim part: steps 4 and 5 restricted to its
own claim moves and releases, with no `git` record, no manifest and no `pushed`. On 2026-09-26/27 every
session's daemon in one checkout announced each base move, seventeen identical notices per commit; with one
writer per checkout there is one.

1. Mark the transition as started: `manifestHead.complete = false` (manifest §5.4).
2. Read `branch`, `head` and the room remote's refs. Compute `base` (§B3).
3. Run the manifest reconcile plan against the new base.
4. Compute claim moves and releases for this participant's claims. `reanchorClaims`
   (`roomd/src/reanchor.ts:21`) runs over the new texts (disk, or git at the new head), using the
   `claimedHash` recorded at claim time. The old texts come from `git show <prev head>`, where
   `prev = participantRecord(me).git.head`.
5. **One transaction (invariant 6):** the new `git` record (`rev + 1`), the reconciled manifest entries
   and `manifestHead {complete: true, base}`, claim moves (`moveClaim`) and releases with their note ("that
   code changed in <sha>"), and `git.pushedPending` if §B4 applies. `snapshotOwnClaims`/`reanchorOwnClaims`
   (`:876-916`) fold into steps 4 and 5.
6. If `pushedPending` is set, post `pushed` to the hub by its ID (hub §2.3; posts are hub requests since
   the hub decision, so the notice cannot share step 5's transaction).

A transition runs whenever HEAD, the branch or the room remote's refs of interest move (`refsKey`), and
the record is rewritten (`rev + 1`) only when one of its fields changed. Until the publisher lease (wave 4),
the one seam `publishesBaseFacts()` is today's `!publishUnder`. The record's `fence` is the daemon's bound
host session (`RoomdOptions.sessionId`), else a per-daemon id until wave 4 binds one.

**Restart.** What survives is the CRDT `git` record and `manifestHead`. At start the daemon runs the same
transition with `prev` = the recorded `git.head`, so a crash anywhere before step 5 is retried in full, and
re-posts a recorded `pushedPending` by its ID, which the hub dedupes (a crash between steps 5 and 6). If
`prev` is not in the clone, or the record was lost with a snapshot, step 4 finds claims by `claimedHash`
over the current text and releases the rest. Manifest §5.4's final transaction is this one. Scope is
kept (a task, not a branch), there is no banner, and a worker's branchless room is never stranded.

### B3. Each participant's base (R3c; replaces `maybeAdvance`, `advanceBase`, `refreshBaseStatus`; MF3)

`Roomd.resolveBase()` replaces `refreshShared` (`:817-819`):

```
local room:           worker -> its carried commit C (registry pins it); otherwise HEAD
team room, own:       remote = the room's remote (the remote whose URL canonicalizes to the room name;
                               until the cutover also a prefix of a legacy branch-room name; for an
                               explicit room name no remote matches, and `origin` is used)
                      refs   = @{upstream} if on that remote, <remote>/<branch>, <remote>/HEAD (those that exist)
                      if a ref contains HEAD   -> base = HEAD
                      else candidates = merge-base(HEAD, ref) for each ref, non-empty
                           base = the candidate every other candidate is an ancestor of (newest anchor);
                                  if none dominates, the upstream's candidate
                      no candidate (orphan, unrelated history, no refs) -> base = HEAD, anchored = false
team room, projected worker (bridge): base = the lead's current team-room base (R3c; manifest §5.5)
```

- **The manifest covers everything since the anchor**, unpushed commits included (manifest §5.3 diffs the
  disk against `base`); today readers throw `NeedFetch` for an unpushed HEAD (`tools/state.ts:122-133`).
  Refs are observations, not proof: peers still resolve through `ensureCommit`, else "cannot compare".
- **Force-push.** Each `pollHead` tick (3 s) compares ref SHAs as well as HEAD, so after a fetch of a reset
  branch `resolveBase()` moves to the new anchor. Nobody closes anything; pairs whose commits are gone
  read "cannot compare" until the owner's anchor moves.
- **Own status** replaces `refreshBaseStatus`'s strings (`:859-873`), relative to my own upstream only,
  and never stops the daemon: `synced with origin/feat-x`, `N unpushed`, `behind origin/feat-x by N:
  <BASE_CATCH_UP>`, `diverged from origin/feat-x: stop and tell your human`, `no upstream`, `detached at
  <sha>`, `no anchor on origin: teammates cannot compare with you`.
- **`ensureCommit(dir, sha)`** fetches from the reader's own remote for this room (matched by canonical
  name, not assumed `origin`): `git -c credential.interactive=never fetch --no-tags --no-write-fetch-head
  <remote> <sha>` with `GIT_TERMINAL_PROMPT=0`, 20 s timeout, objects only (no ref or file change), at
  most once per sha per 5 minutes (in-memory). Failure gives `unknown: missing <sha>` in `NeedFetch`'s
  wording (`context.ts:155`). `comparePair(dir, remote, a, b)` (`roomd/src/base.ts`) is the pairwise
  primitive: `{mergeBase}`, or `{cannotCompare}` with `unknown: no anchor`, `unknown: missing <sha>` or
  `unknown: unrelated histories`; it never throws for these.
- **Deleted:** the divergence throw and meta seeding (`:431-452`), the `metaMap` observer (`:465-467`),
  `maybeAdvance`, `advanceBase` and `refreshBaseStatus` (`:824-873`), `gitPushedRoomHead` and
  `gitRoomRemoteBranchExists` (`git.ts:226-241`), and `baseRecovery` plus the code-2 base path
  (`auto-join.ts:46-54`).

### B4. `pushed` notices (replaces `base`; SF2)

- **Who:** only the worktree's publisher, from its own §B2 transition (invariant 11). A non-publisher in the
  same checkout never posts it. A lease handover posts nothing for moves before it: the new publisher had
  no `git` record, so its first transition has no `prev` and derives no `pushed` (as for a lost record,
  below).
- **When:** decided in §B2 step 5 (recorded as `pushedPending`, posted in step 6), iff the branch is unchanged, both records are anchored, `prev.base` is a
  *strict ancestor* of `next.base`, and either `next.base` is an ancestor of (or equal to) `prev.head`, or
  the anchor ref's reflog shows this clone's own push moved it to `next.base` (`update by push`): the
  anchor moved forward over commits this participant already had. The reflog test covers a commit and its
  push seen in one 3 s poll (`git commit && git push`, the usual agent sequence), which the ancestry test
  alone cannot tell from a pull. A pull of others' commits fails the third test (a fetch never writes
  `update by push`), a reset the second. It records
  an observed upstream advance, not who pushed: "ben's local commits abc1234..def5678 are now on
  origin/feat-x (3 commits: …)".
- **Guarantee.** The record (with `pushedPending`) is one Y transaction, and the notice follows it as a hub
  post by ID; neither is a durable commit. A relay crash before its deferred snapshot
  (`relay/src/memory.ts:83`) can lose both. The restart derives `pushed` only from a **surviving** `git`
  record. If the prior record survived, the same ID is posted and the hub returns the first copy while it is
  in `bus ∪ mail ∪ archive ∪ outcomes` (hub §2.3). If it was lost, the anchor updates
  silently and **no `pushed` is fabricated** (current refs cannot recover `fromSha`). Delivery is therefore
  at most once per `{fromSha, toSha}` observed with a surviving record, not guaranteed.
- **Routing** (`MessageKinds.pushed`, answering ledger Q3; `MessageRouteContext` gains `upstream`,
  `changedPaths`): same upstream with uncommitted work → `notify` with `BASE_CATCH_UP`; other neighbours
  whose changed paths meet `paths` → `fyi`; everyone else, feed only. Not relevant once `toSha` is an
  ancestor of my HEAD (ledger `relevant`, replacing `markIntegratedBaseNotices`, `:735-749`). Renderers:
  `hooks-bridge.ts:318-320`, `prs.ts:173-175`, `panels.ts:870,879`.

### B5. Conflicts: one derived slot set (audit item 4; MF1, MF2, MF13, SF3)

At `declared` and `intent`, files outside each owner's text-authorized area yield no contract or graph notice or evidence, beyond their manifest path and state. A contract exists only while both provider and consumer paths are authorized (or their owners share at `full`). Withdrawal removes every involved contract slot and graph fact synchronously without `:clean` or retained identity; re-entry is evaluated afresh. An authorized path with lagging graph provenance keeps its current `unknown` episode.

`ConflictWatcher` (`room-mcp/src/conflicts.ts:88-421`) becomes `ConflictSet` with one method,
`reconcile(reason)`. It is single-flight and keeps today's merge budget (four starts per 10 s).

1. **Owners** this session evaluates: me, and, as a lead's bridge in a team room, each worker I project
   (R3c, MF13), fenced by my holder. Pairs `(a, b)` for `b` in `neighbours`, skipping my own projected
   workers and my lead (handled locally). A non-publisher (manifest §5.7) is never an owner or a `b` for
   `merge`: its checkout's changes are its publisher's, which is paired. Its claims still take part in
   `claims` and `edit-in-claim` slots, read through its publisher's version.
2. **Candidates (MF1):** `changed(x) = manifest paths of x ∪ git diff --name-only mergeBase..x.base`
   (cached by `(mergeBase, base)`); `candidates = changed(a) ∩ changed(b) ∪ paths of this pair's existing
   slots`. A side that is incomplete, fenced out, `coverage != all` or `anchored: false` makes the pair one
   `unknown` slot (`path: '*'`, with the reason), never a clean silence.
3. **Evaluation:** `mergePath` (`conflicts.ts:66-83`) at `merge-base(a.base, b.base)` via `ensureCommit`.
   Each side's text is its manifest version (`versionOf`, manifest §6) if it has an entry, else git at its
   base (committed-only change), else the ancestor. **A hashless `held` side (D1)**, on either side or both,
   gives `possible` when the other side changed the path too (it is a candidate, so it did): "ben changed
   `x` too, outside ben's declared area; Room cannot check this merge". It is never `conflict` and never
   `clean`. A `held` side with a hash is read through `known(hash)` and, if that resolves, evaluated
   exactly. Otherwise `held`, `excluded`, `unknown` or a missing commit → `unknown` with `why`; `m ?? b`
   (`:78`) applies only to a genuine `base` version. `edit-in-claim`: my
   changed ranges against `b`'s claims mapped into my lines (§B6); `claims`: claim against claim;
   `contract`: today's `checkObserved` (`:251-289`) with before/after signature in the fact (SF3).
4. **Transitions** (only slots of owners I evaluate). A result of `conflict` is **notified** when
   `settled != 'conflict'` (first conflict, after clean, or clean→unknown→conflict) or when `factId`
   differs from the slot's (a different conflict, e.g. a second incompatible signature; S3). A notified
   conflict bumps `epoch`, sets `settled: 'conflict'`, writes the slot, then posts its notice
   `cf:<h>:<epoch>` to the hub by ID: to the owner (a projected owner: below), plus `…:holder` to `b` for
   `edit-in-claim` (`conflicts.ts:349-352`). Posts are hub requests (hub §2.3), so slot and notice no longer
   share a transaction; the level reconcile below covers the crash between them, for every owner.
   A result of `possible` is handled the same way with its own `settled: 'possible'`: notified (as `fyi`,
   one line) when `settled` differs or its `factId` changed, so re-edits of the hashless file are silent. A
   `possible` that becomes `conflict` once both sides can be read (the owner widens its declared area, or
   a hash resolves) is a new, `notify` conflict notice; one that evaluates clean posts `…:clean`. `possible`
   is not retried on a timer: its inputs change only when a side's entry does.
   `conflict` → `clean` sets `settled: 'clean'` and posts `…:clean` (`fyi`). `unknown` posts nothing, keeps
   `settled` and `epoch`, and retries at `retryAt` (1, 2, 4, then 8 min) whatever its inputs; so
   conflict→unknown→the same conflict is silent. A non-contract slot is deleted only when `clean` and out of the
   candidates, when `b` expires, or when its owner retires; contract withdrawal follows the area rule above.
   **Every owner, on start and reconnect (hub):** for each slot it evaluates with `settled` of `conflict`
   or `possible` at epoch e, it posts `cf:<h>:<e>` by ID; the hub returns the existing copy if there is one.
   **Projected workers (N1).** A projected worker's notice lives in the workers-room doc, so it cannot share
   the team slot's transaction. The projector **level-reconciles** it instead, on start, reconnect and any
   change to `conflicts` or the workers room. For every team slot owned by projected W with `settled` of
   `conflict` at epoch e, it ensures `cf:<h>:<e>` exists in the workers room, addressed to W. For
   `settled: 'clean'` it ensures `…:clean` exists. The post is idempotent by ID (ledger rev 3). No
   cross-document transaction exists, and a crash between the two docs is repaired by the next reconcile.
5. **Triggers:** start after first sync (Astra 10), reconnect (`synced`), observers of `manifest`,
   `manifestHead`, `participants`, `claims`, `graphs` (2 s debounce), and a 60 s tick serving `retryAt`.
6. `room_claim` (`tools/claims.ts:59-68`) writes its `claims` slots in its own transaction, then posts their
   notices by ID.
   Offline-but-unexpired neighbours are evaluated (`isPresent` gating, `:299,370`, goes); `coLocated` stays.
7. **Deleted:** the sets `reported`, `conflicting`, `mergeHashes`, `observedReported`,
   `integrationReported` (`:92-111`); `observeClaims` and `HandlerState.conflictPairs` (`claims.ts:165-185`,
   `tools/state.ts:31-32`). `externalReported` becomes a local 10-minute rate limit.

### B6. Claims across bases

A claim's lines are in its owner's text (`doc.ts:401-444`). When two bases or texts differ, today's
`claimsOverlap` (`shared/src/claims.ts:11`) compares positions in two different files.
- `mapRange(fromText, toText, range)` (new, `shared/src/claims.ts`) maps a range through a line diff, as
  `changedRanges` does (`conflicts.ts:51`). An edited range widens to the edited hunk.
- `claimInMyLines(claim, ownerVersion, myText)`:
  - same base and same text: identity;
  - owner version `text` or `base`: `mapRange`;
  - otherwise: the whole file, labelled "approximate".
- Used by: `room_claim` overlap, `edit-in-claim`, `room_state path=`, and the claims the MCP writes into
  the hook snapshot (ledger `state.json`), which are in my coordinates, so `before-edit.mjs` is unchanged.
- Only the owner re-anchors a claim, in §B2 step 4.

### B7. Previews and collect

- **`room_preview_merge` with no `people`** (`files.ts:145`) means: neighbours `b` whose `changed(b)`
  (§B5) intersects `changed(me)` or my scope (`nearPath`), plus my running workers. Committed branch work
  therefore counts (MF1). The reply names who was included and why.
- **`buildCombinedTree`** (`combined-tree.ts:68-101`) keeps its ancestor fold and ancestor..base path
  collection and calls `ensureCommit` before failing. With default people an unresolvable or unanchored
  participant is excluded and named; an explicitly named one still fails. Past 2,000 ancestor..base paths
  the preview says so and limits itself to manifest paths, never truncating silently.
- **`room_collect`** (`collect.ts:341-349`) is unchanged.

### B8. PR mirror (MF12)

Branches of interest are mine and my neighbours' (excluding `''` and `room/*`), capped at 10, most
recently active first. For each, `prLeader` (`prs.ts:78-82`) fetches `GET /github/prs?room=<repo>&branch=<b>`
(PRs targeting `b`) and `…&head=1` (PRs from `b`), deduplicates by number and caps at 20. Mirrored `pr#N`
scopes stay **coordination evidence** (§B9). The server reads `branch` from the query, parsing names only
for legacy names (`index.ts:274`); `openPrs` caching (`github.ts:78-85`) is unchanged. `room_pr_note` and
`myPr` (`tools/prs.ts:15-29,70-74`) use my `git.branch` ("check out the PR's branch, or pass number" when
detached). Ledger heading and filename (`prs.ts:114,185`): `<repo>_<branch>-<ts>.md`. Deleted: `branchOf`
(`prs.ts:105-108`).

### B9. The neighbourhood seam (`packages/shared/src/near.ts`; MF12, SF5)

```ts
export interface Neighbourhood { readonly everyone: boolean; has(name: string): boolean; names(): string[] }
export function neighbours(view: ParticipantView[], me: string): Neighbourhood       // evaluators and recipients
export function coordinationPaths(room: RoomDoc, nb: Neighbourhood, me: string): NearPath[] // evidence
```

- **`neighbours` now:** every `visible` participant except me and `pr#*`, with `everyone: true`.
- **`coordinationPaths`** gathers scope, claim and changed-path evidence from neighbours, **plus** the
  mirrored PR scopes (`prs.ts:52`). PRs are evidence, not participants, so a PR touching a file still
  produces the claim and hook proximity warning.
- **Consumers re-plumbed onto `neighbours`:** `hasCompany` (`company.ts:24-36`, fresh ∩ neighbours),
  `others` (`tools/state.ts:80-88`), `alsoIn`/`areasFor` (`scope.ts:220-244`), `room_state` listings
  (`scope.ts:106-112`), ConflictSet pairs, preview defaults, PR branches, `pushed` routing, and the hooks'
  `near` data (`hooks-bridge.ts:245`). `nearPath`/`coversPath` stay the path rule inside it.
- **Later.** Narrowing `neighbours` narrows every consumer. Receiving less state additionally needs
  per-neighbour document subscriptions and their lifecycle, reconnect reconciliation, message routing
  across documents, and no cross-document transactions (every record is already keyed by participant:
  `git`, `manifest`, `claims.by`, slot prefixes, `scopes`). That is future work, not implied by this seam.

### B10. Web view (`packages/web/src`; MF6, MF14)

- **Header** (`panels.ts:983-1004`): `owner / repo`, the `local` chip and the active count. The branch chip
  and `base <sha7>` go.
- **Participant rows** show branch, `N unpushed`, `behind upstream by N` from `git`, "updating" on a failed
  fence, "no anchor" when `anchored` is false, "idle N min" from presence (participants view, D5), and
  "shares this checkout with <publisher>" for a non-publisher. The `behind base` pill and `roomBase`/`basesByPerson`/
  `behindBase` (`views.ts:105-161`) go.
- **Merged tab** (`:784-794`): as today when all selected participants share `git.base`; otherwise it lists
  the pairs' conflict slots and says "branches differ; an agent's room_preview_merge checks the
  combination" (the browser has no git).
- **Timeline and board** (`board.ts:68`, `timeline.ts:114-118`) read `conflicts` slots. `web/src/conflicts.ts`
  (a duplicate) and the `'base moved'` rule in `deriveConflictSpans` are deleted. `network.ts:126-130`
  compares a snapshot's base with its owner's `git.base`.
- **Links:** a repo-room link needs a **newly minted** repo view token (`POST /view-token`, repo name,
  `schema: 2`). Old branch-room links get 410 and the page says "this link was for a branch room that no
  longer exists; ask a teammate for a new link". A `?branch=` filter is display only, never access control.

### B11. Server (`packages/server/src`; MF5, MF6, MF7, MF9, MF14, SF6)

- **`names.ts`.** `repoOf` (`:34`) is replaced by `repoRoomOf(name, rooms.has)`; the GitHub admission
  regression test is kept (`:26`, Leave 2). **Creating a new repo room (S4):** `POST /rooms` (schema 2)
  carries the client's origin-derived name, never a parsed stored name. When no open prefix matches, the
  server takes the name as canonical. If a proper prefix of it is already open, the name is a legacy branch
  form of that repo, and the server answers `409 {room: <prefix>}`.
- **Registry keys** are canonicalized on load. Entries whose canonical names match are coalesced (earliest
  `at` and `by`, union of `branches`/`legacy`), and differently cased doc names join `legacy`. A 0.16 doc
  already at the canonical key is handled by migration step 1 (MF9).
- **One lock per repo**, `repoLock(repo)`, serializes `POST`/`DELETE /rooms`, `expireIdle`, `closeRepo`,
  `migrateRepo`, and view-token minting and revocation; each re-checks `rooms.get(repo)` inside the lock, so
  a close racing a migration cannot resurrect a doc (MF7).
- **Preflight and upgrade matrix (MF5, Leave 3):**

| Request | Repo mode `branch` | Repo mode `repo` |
|---|---|---|
| 0.16 preflight (`POST /view-token`, no `schema`), any name | today's behaviour | **403**, text: "update Room to 0.17 or later: this repository now has one room for all branches (github.com/o/r)". 0.16 turns this into a permanent code-2 error with the text (`session.ts:471`, `auto-join.ts:51-54`) |
| 0.16 `POST /rooms`/`DELETE /rooms` without `schema` | today | 403, same text |
| 0.16 socket already joined | today | closed at migration with **4001**, same text. `watchClosed` stops reconnecting (`session.ts:570-578`; Leave 3) |
| 0.16 socket upgrade without a preflight | today | refused with HTTP 403 |
| schema 2, canonical name | admit first, then `migrateRepo`, then join | admitted as today |
| schema 2, legacy name | preflight returns `{room: canonical}` after admission; the client re-targets | same |

- **View tokens (MF6).** In `migrateRepo`, under the lock, every token whose room is in `legacy` is
  **revoked**: deleted from the live map and from `view-tokens.json`. Repo-room tokens are only ever
  minted fresh, by an admitted caller.
- **Archive (MF14):** `POST /archive/export {room: <legacy name>, session|token, schema: 2}` requires
  `admitted(repo)` by login session or `ROOM_TOKEN` (bearer view tokens refused), loads the persisted legacy
  doc read-only (`persistence.getYDoc`, in memory or not) and returns `Y.encodeStateAsUpdate`. No socket or
  write path exists for legacy or archive keys, so the archive is immutable. `GET /archive?repo=` lists
  legacy names and unresolved identities; `room_export room=<legacy>` renders the update in a scratch doc
  with `prs.ts`'s ledger code.
- **`closeRepo`** (`:130`) covers the repo, legacy and archive keys and clears `docMeters`/`capLogged`
  (which leak today). Idle expiry looks at one doc; audit `join` records the repo room.
- **Hub (hub §6, §10).** The schema-2 preflight reply carries `hub: 1`; the server runs the room's hub
  (`bindHub`, incarnation file) and `migrateRepo`'s writes use the hub origin. A 0.17 client refuses a server
  without `hub` with the deploy text.
- **Trust and cap (SF6):** admitted means trusted, plus `schemaVersion` (audit item 8, first option). At
  `ROOM_DOC_MAX_MB` the server stops dropping writes silently (`index.ts:400-405`): it closes the writer
  with **4413** "room is over its size cap (N MB)". A 0.17 client sets `s.rejected`, pauses publication,
  prefixes every tool reply with "[room] this room is over its size cap: your changes are not reaching
  others", shows it in `room_state`, and retries every 60 s. Its stale fence and presence keep others
  from reading its `manifestHead` as current.

### B12. Local rooms, the relay and mixed installs (MF10)

- **New relay generation.** A 0.17 session finds its relay only through `<common>/room/relay.json`
  (`schema: 2`, port derived from the common dir and schema 2) and adopts it only after `/health` returns
  JSON `{schema: 2, hub: 1}` (hub §5, §10: the relay is the local room's hub, started only under its
  authority lock). It never adopts a relay from 0.16's `room-local.json`; a live 0.16 relay keeps
  serving its 0.16 sessions and stops when they end. A schema-less upgrade to the 0.17 relay gets HTTP 426
  (a backstop: 0.16 clients do not know this relay). The new relay serves the new `web/`.
- **New lead, old worker: the contract with registry rev 3 (M10).** The 0.16 worker finds only the 0.16
  relay (or starts one) and sits alone in a 0.16 doc; the 0.17 relay never sees it, so no refusal or
  refusal note exists and nothing signals it on room text. While alive it is registry row 8 `running`,
  showing "has not joined the room: its host's Room plugin may be older than 0.17 (host codex)" after 60 s
  with no run writer; on exit rows 13/14 report `failed` with that detail and the log tail. (Registry test
  row 20's "stale refusal note" is a state that cannot occur.) A best-effort pre-spawn version check
  refuses earlier (decision 5).
- **Old lead, new worker:** a legacy `ROOM_WORKER_ID` (`lead/tag#gen`, registry M2) or legacy-form
  `ROOM_ROOM` makes the 0.17 worker exit non-zero at once: "this worker runs Room 0.17 but its lead runs an
  older Room: update the Room plugin for the lead's host". A spawned worker never re-targets its room.
- **Workers room:** still the lead's local room (`ensureWorkersRoom`, `tools/workers.ts:268`); `ROOM_ROOM`
  for workers (`worker-launch.ts:58`) is the branchless name.

### B13. `room_close` (SF1)

Joined team room: "close github.com/o/r for everyone: every participant on every branch loses this room's
shared work and history"; the server closes the repo, legacy and archive docs under `repoLock`. The
unjoined path (0.16.29, `join.ts:252-270`) stays as a deliberate admin path, so a room that cannot sync
(over the cap, corrupt) can still be deleted by an authenticated, confirmed call; its name is the
origin-derived repo name (`deriveRoomName(dir).repo`), with the slicing at `:268,285` deleted. Local:
`forget()` also deletes the migrated 0.16 memory files. The tool description (`join.ts:29`) and the
room-etiquette line ("removes all branch rooms") are reworded.

### B14. Identity, graph index and areas

- **Identity (R1, R1a).** The name lease is keyed by `roomKey` (registry §15), so one user's two clones on
  two branches get two names. Messages address participants (ledger), so a branch switch keeps the cursor
  and receipts. Worker IDs contain no room name (registry §Records).
- **Graph index.** `graph-index.ts` `rebuild` (`:138-186`) indexes `ls-tree <my git.base>` plus manifest
  paths, and rebuilds when my `git.rev` changes (it was a `meta` observer, `:114-116`). `textFor` reads
  others through `versionOf`.
- **Areas.** `loadAreas` (`scope.ts:207-218`) reads CODEOWNERS at my HEAD, cached per HEAD. Each
  participant publishes its own `areas`.

## Deleted code (summary; each is placed in §B1–B14)

room-mcp: `followBranch`, `pinnedRoom`, branch slicing, `base(s)` and `baseFor`'s room-base fallback
(`tools/state.ts:108-118`), `baseRecovery`, `ConflictWatcher`'s sets, `observeClaims`, `conflictPairs`,
`branchOf`, `evictStale`, `reserveAutoName` (registry). roomd: the divergence throw, meta seeding, the
`maybeAdvance` family, `warnBranchSwitch`, `namedRoomBranch`/`roomBranch`, `gitPushedRoomHead`,
`gitRoomRemoteBranchExists`, `localRoomName`'s branch. shared: `roomBase`, `basesByPerson`, `behindBase`,
"base moved", `bases` and the `meta.base` fallback, the `base` kind's wake rule (history rendering stays).
server: `repoOf`, `noteBranch`, the fake-branch `GET /rooms` admission (`index.ts:210`, now
`admitted(repo)`), the silent cap drop. web: `conflicts.ts`, the header branch chip, `meta.base` reads.
Docs: room-join `SKILL.md:22,42-45` (including "Do not work in the room on a different base"),
room-etiquette `:39`, README `:14-15,30-31,199-203,296,413,418,492`, onboarding `:35-36`,
`scripts/demo.sh:44`, and a `decisions.md` entry superseding 2026-09-14.

## Migration and compatibility (R6a)

No doc is shared by a 0.16 and a 0.17 client (§B11 matrix, §B12). What remains is moving state out of the
branch-room docs once, durably.

**`migrateRepo(repo)`.** It is triggered by the first **admitted** schema-2 request for a repo in mode
`branch` (a socket, `POST /rooms`, or a preflight). Admission is checked before migration starts. It runs
under `repoLock(repo)` and persists its progress in the store (`OpenRepo.plan`, `step`) (MF7):
1. **Plan, persisted first.** `sources` = `branches` ∪ persisted doc names that `repoRoomOf` maps to
   `repo` (case aliases included). If the canonical key K holds a doc without `schemaVersion: 2`, the plan
   maps K to a stable `archive:<repo>:<planId>` (`planId` fixed now), and in `sources`/`legacy` K is
   **replaced** by that key, so the purge can never touch the live doc (MF9). Await
   `{mode: 'repo', legacy, plan, step: 'planned'}`; from here 0.16 requests are refused.
2. **Freeze and drain.** Close live sockets on every source and on K (4001, update text) and refuse new
   ones; wait until none is connected and pending updates are flushed to persistence; revoke source view
   tokens; await `step: 'frozen'`.
3. **Move K** if planned: copy K's persisted state to its archive key (await), then `clearDocument(K)`
   (await), then await `step: 'moved'`. A rerun that finds the archive written and K cleared skips this.
4. **Load.** For each source, await `persistence.getYDoc(name)`, which includes docs not in memory.
5. **Identity (MF8).** A name is *unique* if it appears (scope, claim, overlay, deletion, presence record or
   addressed mail) in exactly one source. A **unique** name migrates by name: open claims keep `id`,
   `path`, `from`, `to`, `intent`, `plans`, `claimedHash` (no `anchor`) plus `origin: <source>`; its scope
   is copied; owed addressed messages (`to` set, no `seen:<to>[id]`) go to `mail` (the ledger's migration
   writer). An **ambiguous** name becomes a placeholder `?<h(source, name)>` (not a valid participant name)
   in every copied `from`, `to`, claim `by` and scope key, including the author of any migrated message
   another participant may reply to. Its claims and scope go to `unresolved[<source>\0<name>] =
   {placeholder, claims, scope}`; mail to or from it (a question from ambiguous ben to unique cy) goes to
   `mail` with the placeholder, keeping message IDs and `inReplyTo`, so cy's reply is addressed
   `to: ?<h>` and stays owed in `mail`.
6. **Write the target.** Build one update, then `persistence.storeUpdate(repo, update)` and await it. Keys
   are idempotent (message ID, claim ID, `unresolved` key, participant scope).
7. **Complete.** Await `migratedAt` and `unresolved: n` in the store. Only then are schema-2 clients
   admitted.

**Crash at any boundary.** The next admitted request re-takes the lock, reads `plan` and `step`, and
resumes. The plan and archive key are stable, the sources are frozen before any copy or clear, and nobody
is admitted before step 7, so a rerun cannot double-apply, lose mail or orphan the archive. Tests crash
after each step.

**Claiming an unresolved identity (MF8).** At its first 0.17 start a session reads its 0.16 evidence, the
worktree's `room.json` (`roomd/src/room-file.ts:8`, `{room: <url>, name}`), which suffices under the
trusted-member model (SF6); the rewritten `room.json` keeps it as `legacy: {room, name}` until the purge.
If `unresolved[<decoded room>\0<name>]` exists, the fenced holder releases it in one transaction: claims
re-owned to its current name, scope restored, every placeholder `from`/`to` in `mail` rewritten to its
name (the second migration writer, ledger), `aliases[?<h>] = <name>` written so renderers and late replies
resolve, entry deleted. Unclaimed entries are listed in `room_state` ("unresolved from
github.com/o/r/feature: ben (2 claims, 1 question); room_export room=… to read") and dropped at the purge.

**Claim validation.** Every migrated or released claim is validated by its owner's §B2 step 4 at the next
transition, which runs at every start. A claim is kept where its `claimedHash` is found in this clone's
text, and released with the note otherwise. Claims of different clones are never validated against one
disk, because ambiguous names are not merged.

**Purge.** After `ROOM_LEGACY_DAYS` (30), `clearDocument` runs for every legacy and archive key, `legacy`
is emptied, and unclaimed `unresolved` entries are deleted. `closeRepo` purges earlier.

**Local rooms (N2).** The old relay generation may still be writing, and nothing in 0.17 can freeze it, so
local migration is an idempotent, **insert-only catch-up** from `<common>/room-local/*.ydoc` (shared code
in `shared/src/migrate.ts`, same identity rules). It inserts only records whose message or claim ID is not
yet in `<common>/room/relay/migrated.json`, then records them there (temp-and-rename), so nothing released
or answered in schema 2 is resurrected; a 0.16-side deletion after the first copy is not propagated (the
owner validates or the claim expires). It reruns on every 0.17 relay start and whenever an old-generation
snapshot changes (watch plus mtime) while the old relay is alive (the `room-local.json` pid through the
process-identity probe). **Completion** is declared, and the old files frozen as the archive, only after
the old generation is gone and a final catch-up has run over its last snapshot; until then `room_state`
says "migrating from a running Room 0.16 session". The 0.16 files are kept until `forget`.

**Client files:** `room-choice.json` is kept verbatim (SF4); `room.json` as above; the registry maps
`record.room` through the server's canonical answer (registry M6); the manifest's grant file is looked up
once under the canonical room (manifest §4.2).

**Disclosure.** A repo room shows every branch's shared work to every admitted member. Branch rooms were
never a permission boundary (`admit.ts`), but they did separate content. The team-sharing note is shown
once more, keyed `worktree#server#repo-room-1` in `markWarned` (`choice.ts:95`) and combined with the
manifest's disclosure line: "Room now has one room per repository: teammates on any branch see what you
share". At `declared`, what is shared is the manifest's consent line (D1): "paths of every changed file;
text only in your declared area".

**Hard cutover (D2, confirmed by the human 2026-09-28).** Every teammate upgrades to 0.17 at once; the
branch rooms become the 30-day read-only archive above, and mixed-version rooms are refused (§B11 matrix)
rather than supported.

## Failure and recovery

Each case is exercised by the test in brackets. kill -9 mid-transition: rerun from the recorded `git.head`
(§B2) [T3, T4]. Crash between computing and writing a conflict, or between a slot and its notice: re-derived
at start; deterministic IDs prevent a double notice [T7]. Partition: one writer per field; `synced`
reconciles; the hub grants a name to one session, and a partitioned holder pauses within its lease TTL
(hub §4) [T8]. Force-push or no network: per-pair "cannot compare" until anchors move or `ensureCommit`
succeeds (20 s, cached) [T2]. Two sessions or two clones: registry leases, one record each. Migration
crash: resume from the persisted plan and step [T6]. Over the cap: 4413 and a visible rejected state [T6].
Relay crash before its snapshot: state re-derived from surviving records; `pushed` only from a surviving
record [T3]. Crash between the team slot and a projected worker's notice: the projector's reconcile
posts it by ID [T9]. A live 0.16 relay: catch-up until it is gone [T13].

## Test plan

Failing-first (each fails on 0.16.33 unless marked "pin"):
1. Diverged clones both join (invert `roomd/test/roomd.test.ts:476-486`); no status names a room base.
2. Anchors: A force-pushes a reset `main`, nobody is locked out, A↔C reads `unknown: missing` until C
   fetches; orphan history → `anchored: false`, no throw; an upstream on a non-origin room remote is used.
3. `pushed`: an unpushed commit gives the anchor and its file is in the manifest; a push posts one
   `{fromSha, toSha}`; a pull or a reset posts none; kill -9 with the record surviving re-posts the same
   ID, seen once; with the record lost, no `pushed` is posted (S2).
4. Transition boundary (MF4): kill before step 5 → readers see `complete: false` and the old claims; after
   restart claims are moved or released and `complete` is true; scope kept, no banner.
5. Names: GitHub lower-casing; `repoRoomOf` with `isOpen` on `git/h/repo/main` vs `git/h/grp/repo`;
   explicit `local/x/special` survives; `admitted('github.com/o/r')` without credentials takes the GitHub
   path (pin, Leave 2).
6. Server: the §B11 matrix against a real 0.16.33 `joinSession` built from the tag (403 → code-2 text;
   joined socket → 4001, no reconnect); `migrateRepo` crash after each of steps 1–7 then resume → one copy
   of mail, claims and scopes, archive found under the planned key; a live write during step 2 lands in
   the archive; branchless doc plus `github.com/O/R` alias together, K absent from `legacy` after purge;
   ambiguous `ben` → placeholder, cy's reply to ben's question stays owed to the placeholder and reaches
   `ben+host` after release; unique `cy` migrates; close racing migration does not resurrect; creating
   `git/h/grp/app` with no open prefix succeeds, `git/h/grp/app/main` with `git/h/grp/app` open → 409;
   an unadmitted request
   does not migrate; legacy view token revoked at live cutover; archive export of an offline persisted
   doc; bearer token refused at the archive; cap → 4413 and a rejected state.
7. ConflictSet: pre-existing conflict → one notice; restart → none; held→shared, timeout→success and a
   same-ID claim move and a coverage change (`semRev`) → re-evaluated; first result unknown→conflict →
   notice; conflict→clean→conflict and clean→unknown→conflict → new epoch notice; conflict→unknown→same
   conflict → silent; an edit that leaves the conflicting hunks unchanged → silent; A pushes its
   conflicting change → slot stays `conflict` (MF1); a second signature change while in conflict → a new
   contract notice (S3). **D1:** A (shared) and B (declared, `x` outside its area) both edit `x` → one
   `possible` notice, status never `conflict`; B edits `x` three more times → no new notice and unchanged
   `inputs`; A edits `x` again → no new notice (same `factId`); B widens its area to `x` and the hunks
   conflict → a `conflict` notice; the slot's key and every notice ID contain no blob id of B's `x`.
8. Flat records (MF11): two clones write `ben`'s fields concurrently and converge. The hub grants `ben` to
   one of them; the other gets `held` and takes the next name; a late `git` written under a lapsed lease fails
   the fence and reads `updating` (hub §4).
9. Projection (MF13): W (projected by L) edits in B's claim → slot owned by W written by L's bridge,
   notice delivered to W in the workers room; L–W not evaluated in the team room; kill L after the team
   slot commits and before the workers-room post → the restart's reconcile posts `cf:<h>:<e>` once (N1).
10. Previews: default people include a neighbour with an overlapping committed change; unfetchable
    neighbour excluded by name; explicit one errors.
11. PR (MF12): `pr#7`'s scope makes `room_claim` warn; base and head queries deduplicated; `room_pr_note`
    uses my branch.
12. Seam: a stub `neighbours` narrows every §B9 consumer; a grep test flags raw `scopes.keys()`,
    `overlays.keys()` or awareness-name reads outside `near.ts`/`views.ts`.
13. Mixed installs (MF10): a 0.17 session ignores a live 0.16 relay; a 0.16 worker under a 0.17 lead ends
    `failed` with "has not joined"; a 0.17 worker with a legacy `ROOM_WORKER_ID` exits with the lead text;
    local catch-up (N2): a 0.16 session posts a question after the first copy → the next catch-up inserts
    it once; a claim released in schema 2 is not resurrected; completion waits for the old relay to exit.
    Expiry (S5): a hub restart never expires early; a new incarnation counts only its own time (hub §4.4).
14. Web: no branch chip; Merged lists slots when bases differ; an old link shows the 410 page.
15. **One publisher announces (D5).** Five sessions in one checkout of a team room under five names; one
    commit, then its push. Exactly one `pushed` notice and one `git` record update, both from the
    publisher; the four others write no `git` field and post nothing, and still move their own claims. In
    a local room (where D5 was observed), one commit gives exactly one `git.rev` bump, from the publisher,
    and no notice; again the others write no `git`. Fails on 0.16.33, where every
    session's daemon posts its own base notice.
16. **Presence (D5).** `fresh` is false for a presence entry without `sessionId` or with a stale one
    (wave-0 ruling). A session that reports `idleMin: 25` renders "idle 25 min" and stays fresh; with 2
    claims, "holds 2 claims". A session that leaves (registry §18) stops being fresh at once, and its
    claims, scope and owed mail are still there afterwards.
17. **`acceptedGit`.** Own and projected fences in one function: a stale own fence, a projection whose
    lead's live holder changed, and a record without `git` (a non-publisher) each give `'updating'` or the
    publisher redirect, never a stale `git`.

Rehearsals (`scripts/demo.sh`, three clones; scripts belong to the implementation plan): branch per
person with a cross-branch conflict; force-push mid-session; commit without push; upgrade day with an
unanswered question migrating.

## Rollout and size

In order on the redesign branch, shipped together as the one schema-2 release (0.17), server deployed
first (`deploy/DEPLOYING.md`, `--depot=false`): (1) `rooms.ts`, participants view (presence `sessionId`,
`idleMin`), flat record, `acceptedGit`;
(2) `resolveBase`, transition boundary, `pushed`, the expiry authority (`expiry` writes by the trim leader,
`expireParticipant`; the election through the ledger's `delivery` API; moved to the hub in the hub step, hub
§8); (3) `ConflictSet`, claims across bases (needs the
manifest's `versionOf`); (4) the `neighbours` seam; (5) naming, server lock, migration, archive, cap, relay
generation, PR, web, skills, docs. About 2,400 production lines added and 1,400 deleted, plus ~1,050 test
lines: seven or eight Codex tasks; splits belong to the implementation plan.

## Risks and unresolved decisions

1. **Doc size.** One doc carries every branch's shared text, and unpushed commits now count. The
   mitigations are the manifest's facts tier and budget, and later neighbour-scoped text. Hitting the cap
   is now visible (4413), no longer silent.
2. **Privacy expectation.** Teams that treated branch rooms as private now share with every admitted
   member. The mitigations are the one-time disclosure and `.roomignore`.
3. **Noise.** Everyone in a repo is company. Path guidance still fires only through `nearPath`.
4. **Automatic `git fetch <sha>`** (§B3). Is an objects-only background fetch acceptable, or should Room
   only advise, as today? Built in step 2: fetch, with `ROOM_AUTO_FETCH=0` to turn it off. Checked
   2026-09-28: GitHub serves a want by SHA only for commits reachable from a ref
   (`uploadpack.allowReachableSHA1InWant` behaviour), so a commit force-pushed away cannot be fetched;
   that pair stays "cannot compare" until the owner's anchor moves, as §B3 says.
5. **Pre-spawn version check.** Reading a target host's installed Room version is host behaviour that
   changes weekly. Verify against current Claude Code plugin docs and `codex --help` (see
   `docs/host-survey-2026-09-24-*.md`). §B12's "has not joined" detail is the backstop.
6. **Far-apart branches.** Is the 2,000-path preview cap right?
7. **Upgrade lockout (R6a, D2).** It is abrupt but explicit, and the human chose it: 0.16 clients stop
   with a clear update text. A local migration stays "in progress" while a 0.16 session keeps its relay
   alive (N2).
8. **A finished host that left scope or claims (D5, H1).** Decided by the human on 2026-09-28 (H1,
   registry §18): a shared app-server session idle for eight hours releases its own claims and clears its
   scope, with one notice naming them; the next idle-lease tick then ends its presence. Until then it
   stays present, shown "idle Nh; holds …". An interactive CLI session is never released for quiet
   time. Its records then age toward the expiry above like any absent participant's.
