# Room 0.16.21 — whole-system design audit (Fable)

Read-only audit of HEAD (982515c). Scope: sources of truth, edge-triggered designs, trust
boundaries, failure and recovery, coupling, and complexity that is not paying for itself.
Not a diff review. Findings are ranked by consequence. "Before" = before a three-person
trial; "after" = after.

madge (`--circular`, run on every package): shared 2 cycles, roomd 0 own (3 inherited from
shared), room-mcp 3 own + 3 inherited, relay 0 own, server 0.

---

## Findings

### 1. Sharing eligibility is decided in eight places and cached in five — design-P1

**Where.** `packages/room-mcp/src/config.ts:404` (`resolveShare`), `session.ts:481-526`
(module-global `shareMaxCache`, `trackServerShare` loop, `serverShareMax` fan-out),
`session.ts:744` (`shareCeiling` closure), `roomd/src/index.ts:86-95` (`setEffectiveShare`,
`sharingGeneration`), `roomd/src/publisher.ts:108-125` (`isShared` mutates the daemon as a
side effect of a read), `publisher.ts:283-398` (`sharingChanged()` checked 15 times inside one
function), `bridge.ts:128-133` (monkey-patches `daemon.setShare` to substitute paths),
`retained-declared.ts` (in-memory set mirrored to a per-worktree file), `choice.ts:623`
(`rememberShare`), `Worker.share` in `types.ts:723`, awareness `share`.

**Problem.** "May this path's text be in the room right now?" depends on level, server
ceiling, scope paths, retained paths, ignore rules, size and budget. `eligibility(facts)` is
pure (good), but the facts are gathered from five mutable owners, and the decision is
re-checked after every `await` because any of them can move underneath. The 0.16.15–0.16.18
"three rounds of timing races" and the `sharingGeneration` guards are the symptom.

**Failure scenario.** Add one more fact (per-directory ceiling, or "withhold while a worker
is being collected") and every site above needs an edit; miss one and a file is published
under a level that forbids it. Today: `Publisher.isShared()` calling `setEffectiveShare`
from inside `publishDiskState` means a *read* can withdraw overlays mid-batch.

**Smallest change that removes the class.** One immutable `PublicationPolicy` value
`{level, ceiling, scopePaths, retained, ignore, sizeCap, budget, version}` owned by the
daemon and replaced atomically (Bridge and `room_share` produce a new value; nothing
patches methods). One reconciler: `desired = plan(policy, diskSnapshot, headTexts)` →
diff against the doc → write inside one transaction tagged with `policy.version`; a batch
whose version is stale is dropped and rescheduled. Delete `sharingGeneration`,
`isShared()`'s side effect and the `setShare` monkey-patch.

**When.** Before the trial (this is the code that decides what leaves the machine).

---

### 2. "Has this agent seen this message" has six ledgers and five delivery paths — design-P1

**Where.** CRDT `seen:<name>` (`shared/src/doc.ts:537`); in-memory `HandlerState.seen`
(`tools/state.ts:30`, pruned at 5000); hook file `room-hook-seen.json`
(`plugins/room/hooks/common.mjs:66-77`, replayed by `syncHookSeen` from six call sites in
`hooks-bridge.ts` and `messaging.ts`); `HooksBridge.woken/pending/delivering`
(`hooks-bridge.ts:171-177`); `SocketWakeRouter.pending` (`wake-path.ts:569`);
`room-state.json` `unread` + `pendingDisclosure/pendingNotice` guarded by a
`.notice-lock` file protocol duplicated in `hooks-bridge.ts:82` and `common.mjs:85`;
`upgraded` copies (`messaging.ts:583`). Delivery paths: tool-reply inbox, PreToolUse hook,
`codex queue`, Claude inbox socket, channel notification, resume-prompt (`markSeen(to)` in
`messaging.ts:368`).

**Problem.** Each path keeps its own receipt and then reads the others' files to avoid
double delivery. Correctness depends on the order in which observers fire
(`syncHookSeen` "before another delivery path reads its inbox"), not on one fact.

**Failure scenario.** MCP restarts: in-memory `seen` is empty; `syncHookSeen` only trusts
hook receipts whose `shown[id] === me` or `to === me`; a broadcast interrupt the hook
already showed is delivered again by the inbox. Or the reverse: the wake router's
`isUnread` sees the CRDT receipt written by the hook and never wakes, while the hook's
receipt came from a *different session* in the same worktree (the `sessionStateDir`
lookup in `common.mjs:36`).

**Smallest change.** The CRDT `seen` map is the only receipt. Hooks do not keep their own
list: the hook writes `{ids, sessionId}` to one append-only file that the MCP folds into
`seen` on every read (it already does this in `syncHookSeen`; make it the *only* path and
delete `HandlerState.seen`, `woken`, `hookSeen.seen`, `shown`). Every delivery path becomes
"send iff `!seen.has(id)`; on success `markSeen`". The disclosure/notice arbitration
(`pendingDisclosure` + lock files in two languages) collapses to the same rule with a
synthetic message id.

**When.** Before the trial. Duplicate or lost wakes are the first thing a three-person
trial will notice.

---

### 3. Worker status is written on edges by five writers; the record is both input and output — design-P1

**Where.** `tools/workers.ts:62` (`room_done` in the worker process), `registry.ts:66-95`
(`finishWorkerProcess` from the exit callback), `registry.ts:185-245` (`evaluateRetirement`
on a 60 s timer, "unwitnessed"), `tools/workers.ts:285-343` (`dismissWorker`),
`registry.ts:417` and `tools/workers.ts:211` (resume/spawn failure paths). Stop reason is
additionally persisted in the carry record file (`worker-git.ts:158-178`) and in the
retired record. Guards comparing `id`, `gen`, `pid`, `startedAt` appear in ~10 places
(`registry.ts:68,84,350,375,401`, `workers.ts:60,203`, `doc.ts:140,147,189`).

**Problem.** `workerRealState` + the `decide*` tables (`worker-state.ts:572-654`) are the
right shape: state-based. But the doc record's `status` is still what every reader shows
and what `occupiedWorkers`, `recipientNotice`, `myWorkers`, the bridge and the web trust,
and it is only updated when a process in *this* MCP sees an exit. The generation guards
exist because two processes (worker and lead) and two times (exit, retirement) race to
write one field.

**Failure scenario.** Lead is killed -9 (host closes the MCP without SIGTERM, laptop
sleeps past the host's timeout). Detached worker finishes, `room_done` sets `done`; fine.
Worker crashes instead: no exit callback runs; record says `running` until a later lead
session's 60 s timer probes the pid. Meanwhile `occupiedWorkers` counts it, `room_spawn`
refuses the tag, `room_send` to it says "already running", `hasCompany` reports company.

**Smallest change.** Split the record: `WorkerSpawn` (immutable: id, tag, dir, branch,
base, carried*, pid, processStartTime, hostSessionId, task, lead) written once at spawn;
`WorkerReport` (`done` message, summary) written once by the worker. Status is a
*projection* `statusOf(spawn, report, probe(pid), fs.exists(dir))` computed at read time;
the doc may cache it with `computedAt` for the web view but no decision reads the cache.
This deletes `finishWorkerProcess`'s guard ladder and most of the `gen` machinery.

**When.** The projection function before the trial (it is mostly `workerRealState`
renamed); deleting the cached `status` after.

---

### 4. Two "base" facts: room-wide `meta.base` and per-person `bases[name]` — design-P1

**Where.** `shared/src/doc.ts:261-263` (`baseOf` falls back to `meta.base`),
`roomd/src/index.ts:412-424` (start throws `RoomdError(…, 2)` on "diverged" or "unknown"),
`index.ts:717-748` (`maybeAdvance` decides from `gitPushedRoomHead`), `index.ts:750-760`
(`advanceBase` posts a `base` message), `conflicts.ts:349-352` (merge uses per-person
bases + `mergeBase`), `tools/state.ts:108-118` (`base`/`baseFor`).

**Problem.** Conflict detection, previews and collection already work per person (good).
But the daemon's *lifecycle* is still gated on the room-wide value: a clone whose HEAD is
not an ancestor/descendant of `meta.base` cannot join at all, and `RoomdError` code 2 is
non-retryable (`auto-join.ts:453-456`), so the session is permanently out.

**Failure scenario.** Three people on one branch; one force-pushes a rebase (or the branch
is reset). Everyone's daemon restart hits `local HEAD … has diverged from room base — stop
and tell your human` and refuses to join; the room is empty until someone runs
`room_close`. The roadmap already names "room per repository, per-person base" as the
next change; this finding is the part of it that is a live hazard.

**Smallest change.** Stop using `meta.base` as a decision input. Join always succeeds;
`bases[me] = HEAD`; `base` notices become "X pushed C (n commits)" derived when
`bases[X]` moves to a commit that is on the remote; "behind/diverged" is a per-pair status
line computed from `merge-base`, not a startup error.

**When.** Removing the startup throw: before the trial. Renaming rooms per repo: after.

---

### 5. Edge-triggered coordination keeps private dedupe state that is never reconciled with the doc — design-P1

**Where.** `conflicts.ts:373-394` (`reported`, `conflicting`, `mergeHashes`,
`observedReported`, `integrationReported`, `externalReported`), `bridge.ts:30-42`
(`mirrored`, `relayed`, `recent`, `lastScopeKey`), `hooks-bridge.ts:171-177`,
`tools/state.ts:31-32` (`upgraded`, `conflictPairs`), `graph-index.ts:82-90`,
`wake-path.ts:569-573`. Each `start()` subscribes to Yjs events and acts on deltas.

**Problem.** The derived facts (there is a conflict between A and B on path P; claim X is
mirrored as Y; message M was relayed to worker W) live only in process memory. Restart
loses them; an event that happened before `start()` is never seen (ConflictWatcher only
runs `checkAllObserved` at start, not `check` for existing overlaps; HooksBridge has
`pending` only for wakes it saw).

**Failure scenario.** Lead restarts while two workers hold overlapping claims: the
`conflictPairs` set is empty, `observeClaims` fires only on new adds, so no conflict is
raised until one of them re-claims; when the lead restarts *again* after a conflict was
raised, `s.room.messages().some(x => x.type === 'conflict' …)` rescues that one case
(`tools/claims.ts:489`) but nothing rescues merge-conflicts, contract notices, relays or
mirrors (`Bridge.start` re-mirrors from `l.openClaims()` but drops mirrors whose local claim
it can no longer match, so the team sees the mirror twice).

**Smallest change.** For each derived fact, one pure `derive(doc, now)` and one
`reconcile()` that runs on any change *and* on a timer, and dedupes by the doc itself:
deterministic ids (`conflict:<a>:<b>`, `mirror:<localId>`, `relay:<msgId>:<worker>`) so a
second writer's `set` is idempotent. The bridge already stores `mirrorOf`; add the local
claim id and rebuild `mirrored` from the doc. Then the private sets become caches that
can be dropped at will.

**When.** Conflicts and bridge before the trial; hooks/wake after (they are covered by
finding 2).

---

### 6. Presence, "company" and "who is here" are computed six different ways — P2

**Where.** `company.ts:736-748` (`hasCompany`: fresh, not viewer, not same checkout, plus
running workers), `tools/state.ts:80-88` (`others`: scopes ∪ overlays ∪ presence − retired),
`registry.ts:251-253` (`activeIn`), `roomd/src/index.ts:546-559` (`trimBusIfLeader`: all
awareness names, no freshness), `prs.ts:69-73` (`prLeader`), `tools/join.ts:320-334`
(`evictStale`: any presence), `messaging.ts:231-254` (`recipientNotice`), `conflicts.ts`
`isPresent`, `roomd` `choosePublisher` (watchedDirectory only), plus `splitParticipants` in
`views.ts` which already has the right shape and is used only by `room_state` and the web.

**Problem.** Each site picks its own freshness rule (some use `isFresh`, most do not) and
its own notion of "counts as a person" (viewers, PR bots, same-checkout sessions, workers).

**Failure scenario.** A crashed peer: gone from `hasCompany` after 30 s, present in
`others()` forever (it owns overlays), present in `trimBusIfLeader` for 30 s (so two
processes may both think they are the trim leader for one interval), "offline" in
`recipientNotice`. Reviews keep finding these one at a time.

**Smallest change.** Promote `splitParticipants` to the single `participants(doc,
awareness, now)` view returning `{name, kind, fresh, viewer, worker, sameCheckout,
hasWork}` and make every site above a filter over it.

**When.** Before the trial; it is a mechanical consolidation.

---

### 7. Claims and overlays of a dead session outlive it by up to seven days — P2 (failure/recovery)

**Where.** `tools/join.ts:318-334` (`STALE_MS` = 7 days for overlays), `tools/scope.ts:250`
(claim shown `[stale]` after 7 days but never released), `tools/state.ts:160` (`clearStale`
only on a new session with the *same name*), `roomd/src/index.ts:113-135` (`stop()` is the
only place presence is cleared cleanly).

**Problem.** Kill -9, host crash, sleep beyond the socket timeout: awareness clears in 30 s
but claims, scopes, overlays and base texts stay. Only the same person rejoining, or seven
days, removes them. Between, teammates get conflict interrupts against a ghost, `room_read`
of a stale overlay, and `room_state` "uncommitted, not yet pushed" lines.

**Smallest change.** One staleness rule with a short window (minutes, not days) driven by
the daemon heartbeat that already exists (`lastActive` in presence, `overlayAt` in the
doc): a claim whose owner has no fresh presence for N minutes is *released by any peer*
(the doc already tolerates peer deletes, and the owner's `observeOwnedData` repair restores
overlays if it was a false alarm). Overlays follow the same rule with a longer N.

**When.** Before the trial (claims); overlays after.

---

### 8. Trust boundary: every document write from an admitted client is trusted; the server-side guard is observe-only and costs a second document per room — P2

**Where.** `server/src/index.ts:50-55` (`IDENTITY_GUARD_MODE` default `observe`),
`server/src/readonly.ts:165-260` (`DocumentIdentityGuard` keeps a full shadow `Y.Doc` per
room and replays every update into it; deletes are always allowed at line 244),
`doc.ts:118-128,173-204` (`clearOverlays`, `clearWorkerCoordination`, `retireParticipant`
callable by anyone), `roomd/src/index.ts:261-297` (owner repairs foreign deletes 40 ms
later).

**Problem.** Two half-measures. Clients assume the doc is honest (the web view renders
`workers`, `scopes`, `claims` as-is; the MCP will `kill(pid)` and `git worktree remove`
based on a `Worker` record, mitigated by start-time and path checks). The server detects
violations but cannot reject them without desynchronising the client, so it doubles
memory per room and writes audit lines nobody reads.

**Failure scenario.** Not malice — an old plugin version. A 0.15 client that still manages
legacy `basetext` entries or posts `release` for others is indistinguishable from an
attacker, and the guard only logs. Meanwhile the shadow doc for a 64 MB room is another
64 MB.

**Smallest change.** Decide one model. For a small team with push access, the honest
answer is "admitted means trusted": delete the guard, keep `bindIdentity` for presence
(cheap, already enforced), and add a doc schema version so old clients are refused at
admission (see finding 12). If enforcement is wanted later, do it as validation of the
decoded update *before* applying (structs name their root and key; no shadow doc needed)
and reply with an explicit rejection message the client understands.

**When.** After the trial; but delete the shadow doc before if memory is tight on the
512 MB VM.

---

### 9. Wall-clock time from other machines is used as identity and ordering — P2

**Where.** `tools/join.ts:94` (`m.at >= worker.startedAt` decides which lead notes a
worker sees), `tools/workers.ts:115` (`gen = max(retiredAt)+1` — a generation counter made
of timestamps), `doc.ts:113` (`overlayAge` compares writer clock to reader clock),
`bridge.ts:273` (`RELAY_DEDUPE_MS`), `views.ts` `activityLabel`, `registry.ts:228`
(`m.at >= w.startedAt` to find the done message), `messages.ts` `trimBus` ordering.

**Failure scenario.** Two machines two minutes apart: the lead's post-spawn briefing is
filtered as "history" for a worker on the other machine (`markHistorySeenOnJoin`); a
worker's `done` is not matched at retirement; overlays evict early or late.

**Smallest change.** Order by document causality, not `at`: messages get a monotonic index
from the bus position at insertion (the Y.Array already gives this); "after spawn" means
"after the spawn note's index". Generations are a counter stored in the doc, not
`retiredAt+1`. Keep `at` for display only.

**When.** The `markHistorySeenOnJoin` filter before the trial (one line); the rest after.

---

### 10. Carried-ness is keyed on `HEAD == recorded base`, so it silently expires — P2 (confirms live note c)

**Where.** `roomd/src/index.ts:372-376` (`carried()` returns the baseline only while
`baseline.sha === this.base`), `publisher.ts:304-315`, `baseline.ts:586-612`
(`carriedUnchanged` / `workerChangedPaths` do it correctly by blob hash),
`tools/scope.ts:67,220` (`areas` from `changedPaths`).

**Problem.** Two definitions of "the lead's file": the daemon's (HEAD equality) and
collection's (blob hash under the private ref). They agree only until the worker's first
commit.

**Failure scenario.** Worker commits once. `carried()` is now `undefined`; every carried
untracked file compares against HEAD, where it does not exist, and is published as the
worker's own change. `areasFor` picks up its directory, so the worker's status and scope
claim an area it never touched, and the lead's `room_state` reports N changed files that
are its own. This is the "carried untracked file as its scope" note: confirmed, and it is a
design gap rather than a one-off.

**Smallest change.** Make `baseline.ts` the only definition: the daemon asks
`carriedUnchanged(baseline, path)` regardless of HEAD, and `workerBaseline` is valid for the
life of the worktree (the private ref keeps the blobs).

**When.** Before the trial; the fix is small and the symptom is visible to every lead.

---

### 11. Import cycles and back-references between layers — P2

**Where (madge).** shared: `claims.ts > format.ts > messages.ts`, `doc.ts > claims.ts >
near.ts` (and `near.ts > doc.ts > ledger.ts`). room-mcp: `session.ts <> connection.ts`,
`registry.ts > tools/claims.ts > tools/context.ts` (masked by a dynamic `import()` at
`registry.ts:82`), `registry.ts <> worker-launch.ts`. Also `config.ts:355` imports
`plugins/room/hooks/common.mjs` (the runtime package depends on the plugin's hook file),
and `roomd` reaches back into `@room/shared` doc internals while `room-mcp` reaches into
`@room/roomd/git`, `/baseline`, `/local` sub-paths.

**Cost.** A change to message formatting (`format.ts`) can affect claim overlap logic
through the cycle; `registry.ts` cannot be tested without loading every tool module; the
dynamic import exists only to break a load-order cycle and hides the dependency from the
type checker.

**Smallest change.** A leaf `shared/src/model.ts` with types and pure helpers
(`claimsOverlap`, `containsPath`, `formatPlans`) that nothing else in shared imports from
above; `Rooms` takes `releaseClaims` as a constructor dependency; `launchWorkerProcess`
takes a `LaunchHost` interface (`setHandle`, `watch`, `aborted`) instead of `Rooms`;
`newestModelInTranscriptTail` moves into shared and the hook copy is parity-tested like
`near.ts` already is.

**When.** After the trial.

---

### 12. Compatibility layers for versions that no one runs — P3

**Where.** Three base-text maps with fallback reads and sweepers (`doc.ts:206-259`:
`basetext`, `basetextByPerson`, `basetextFlat`); `legacyRetirements`/`repairRetired` run on
*every* tool call (`tools/state.ts:71-75`); legacy `room-retained-declared.json` migration
(`retained-declared.ts:629-636`); `.room.json` root migration (`room-file.ts`); `ROOM_URL`
alongside `ROOM_SERVER` (`config.ts:428`); `/auth/device` route (`server/src/index.ts:170`);
`gen` alongside `id` for workers (`workers.ts:60`); "older clients omit owner/label"
(`types.ts:590`); hook `readHookSeen` accepting the pre-0.7.0 array form.

**Cost.** Every one of these is a second code path that reviews must reason about, and
several are the reason for findings 2 and 8 (a legacy client can still write the shared
`basetext` map; the guard has to allow it).

**Smallest change.** A `schema` field in `meta`; a client refuses to join a doc with a
different schema and says "update the plugin"; a server refuses a client whose handshake
version is below the minimum. Then delete every migration above in one commit.

**When.** Before the trial — this removes risk, and there are no external users to
migrate.

---

### 13. `Daemon` ⇄ `Publisher` and `HandlerState`: wide mutual interfaces — P3

**Where.** `publisher.ts:40-72` (`PublicationHost`: 30 members, including callbacks into
the daemon's *policy*: `setEffectiveShare`, `choosePublisher`, `scheduleDisk`,
`scopePaths`), `tools/context.ts:63-135` (`HandlerState`: ~65 members threaded through
every tool module), `session.ts:300-333` (`Session`: 20 mutable fields; `daemon.stop`
wrapped three times at `session.ts:661,689,771`; `daemon.setShare` wrapped by the bridge).

**Cost.** 0.16.21 moved 400 lines out of `index.ts` but the two classes still share one
state machine, so a change to one concern (sharing) edits both files plus the bridge. The
`HandlerState` spread (`...workers, ...join, ...share, …`) means a name collision is silent.

**Smallest change.** Publisher receives a `PublicationPolicy` *value* (finding 1) and a
`DiskReader`; it returns proposed doc writes; the daemon applies them. `Session` becomes an
immutable record plus a `SessionRuntime` with an explicit `onStop` list instead of wrapping.
`HandlerState` stays, but each tool module declares the narrow `Pick<>` it needs (the
factories already do this; the handlers should too).

**When.** After the trial.

---

### 14. Two sessions in one checkout: a lot of machinery for a case that should be refused — P3

**Where.** `roomd/src/index.ts:160-189` (`choosePublisher`, re-run on every 3 s poll and
before every publish), `publishUnder` in presence, `company.ts:726-731`
(`sameCheckoutSession`, used at ~12 call sites in `tools/*`), `share.ts:531-537`,
`common.mjs:36-45` (`sessionStateDir` searching worktrees by session id), per-session
`room-write-intents-<hash>.json`.

**Cost.** The secondary session shares no text, cannot anchor claims, gets special replies
from `room_done`/`room_share`/`room_join`, and the election has hysteresis rules that only
tests exercise. The 0.16.17 note "the primary publishes" is a workaround, not a design.

**Smallest change.** One daemon per checkout: the first MCP process owns it (the relay
already solves this election with a deterministic port and a file), later MCPs in the same
checkout connect to the same daemon rather than starting their own. That removes
`choosePublisher`, `publishUnder` and most `sameCheckoutSession` calls, and is the natural
home for finding 1's single policy. Until then, refuse a second session with a clear
message.

**When.** Refuse before the trial; the daemon-per-checkout after.

---

### 15. Wake transport options and host sniffing — P3

**Where.** `wake-path.ts:493-531` (parses the parent's `ps -o args=` to detect
`--dangerously-load-development-channels`), `ROOM_WAKE=auto|socket|channels|off`,
`plugins/room/bin/claude-room`, `channel.ts`, `hooks-bridge.ts:389-426` (`findThreadForDir`
walks `~/.codex/sessions` reading rollout heads when the SessionStart hook did not run),
`config.ts:458-471` (`resolveSessionHost` via `ps -o comm=` of the parent).

**Cost.** Four ways to wake Claude and two ways to find a Codex thread, for hosts that now
ship one supported path each (socket since 2.1.224; `codex queue` with the hook's id).
Every one needs a test double and a doc paragraph.

**Smallest change.** Socket for Claude, `codex queue` with the hook-recorded id for Codex,
`ROOM_WAKE=off` as the only switch. Drop channels, the parent-args scan and the rollout
scan; if the SessionStart hook did not run, say so once (the hook-health note already
exists).

**When.** After the trial.

---

## The four live-check notes

- **A collected worker's stale "is on <area>" reaches later workers — confirmed, and it
  is finding 3/5 in miniature.** `scope` messages never enter an inbox (`inbox: false`),
  but the scope *record* is only removed by `clearWorkerCoordination`, which runs at
  retirement. Collection retires a worker only when `facts.clean && exitCode === 0` and
  there are no ignored artifacts (`registry.ts:226-233`, `collect.ts:226,392`); a
  collected worker whose worktree is kept never retires, so `room_scope`'s "overlaps X's
  scope" (`scope.ts:73`), `room_state path=` (`scope.ts:53`) and the offline participant
  line keep showing it. Fix: collection always clears coordination (scope, claims,
  overlays); keeping a worktree is not a reason to keep a scope.
- **A worker receives its own status line — dismiss as a bug, keep as a cost.** The line
  is `room_state`'s participant list, which deliberately includes `(you)`
  (`scope.ts:135`). The `you:` line two lines above already carries the identity, so the
  `(you)` participant entry can be dropped from the compact view to save tokens. The hooks
  `companyLine` and `others()` already exclude self.
- **A worker's status claims a carried untracked file as its scope — confirmed; finding
  10.**
- **The resume reply does not say whether context was kept — confirmed.**
  `resumeWorker` returns "resumed <tag> with your message" once `proc.started` resolves
  (`registry.ts:443`); nothing checks that `--resume <id>` / `codex exec resume <id>` found
  the conversation. For Codex the evidence already exists: `onSessionId` yields the
  `thread.started` id; report "context kept" iff it equals `hostSessionId`. For Claude,
  wait a bounded moment for an early non-zero exit before replying, else say "context
  retention not verified".

---

## What is sound (do not touch)

- **`worker-state.ts`**: `workerRealState` plus the `decide*` tables are state-based and
  tested; finding 3 asks to make *more* of the system use them, not to change them.
- **Process identity** by pid + OS start time + executable (`worker-process.ts:833-883`)
  and cwd-scoped termination; this is the right way to make `kill` safe.
- **Path safety** (`roomd/src/repo-path.ts`, one validator and one containment helper with
  named leaf policies) and the git-dir resolvers (`git-dirs.ts`), parity-tested against
  the hook copy.
- **Admission** (`server/src/admit.ts`): one rule for open/list/close/view/connect; push
  access checked against GitHub; forwarded tokens refused everywhere.
- **The local relay** (`relay/src/index.ts`): deterministic port so racers collide on
  purpose, a key in a 0600 file, `/health` that proves clone and key, takeover on owner
  exit. This is the pattern finding 14 should reuse.
- **`near.ts`**: one proximity rule used by claims, hooks and `room_state`.
- **`MessageKinds`** (`messages.ts`): one registry for format, audience, wake and
  end-of-wait per kind. (Finding 2 is about receipts, not routing.)
- **`eligibility(facts)`** in `publisher.ts` is the right pure core; finding 1 is about
  how its inputs are gathered.
- **Auto-join** (`auto-join.ts`): single-flight, bounded, non-retryable errors named.
- **Claim re-anchoring** with digests (`reanchor.ts`, `moveClaim`): claims follow code
  without sharing text.
- **Server `WriteQueue`** and the Postgres full-table replacement inside one client
  transaction.
