# Redesign plan, 2026-09-28: ledger, manifest, registry, repository rooms

Phase 1 output: four specs, each reviewed by Codex (gpt-6-astra, high), revised, re-reviewed where must-fix
items remained, and checked against each other by the lead.
- [ledger](2026-09-28-ledger.md): one delivery ledger ([review](reviews/2026-09-28-ledger-review.md))
- [manifest](2026-09-28-manifest.md): one sharing policy value plus a manifest ([review](reviews/2026-09-28-manifest-review.md))
- [registry](2026-09-28-registry.md): durable local worker registry and leases ([review](reviews/2026-09-28-registry-review.md))
- [reporooms](2026-09-28-reporooms.md): repository-level rooms and derived conflicts ([review](reviews/2026-09-28-reporooms-review.md))

The problem statement is [the 2026-09-27 audit synthesis](../../audit-2026-09-27-design.md).

Amended the same day with the human's decisions D1–D5 ([below](#decided-by-the-human-2026-09-28)): D1–D3
settle the three questions this plan put to the human, D4 settles ledger Q4 with a live check, and D5 adds
presence and publisher requirements from a live finding.

Amended again the same day for the lead's "narrow hub hybrid" decision: the relay and the server become the
authority for name leases, message order, trim and expiry ([hub spec](2026-09-28-hub.md); [Hub core](#hub-core)
below). The wave-0 rehearsal's §4 FAIL is corrected: it was not a Room bug.

## Shared decisions (lead rulings, binding on all four)

- **R1 Identity.** Participant (stable room name; owns scope, claims, manifest; the addressee), host
  session (immutable ID; unit of wake and hook state), worker (globally unique ID; tag is a lead alias).
- **R1a Name lease.** An O_EXCL lease under `<common>/room/names/` arbitrates within a clone. Across clones
  and machines the room's hub grants the name as a lease with a monotonic epoch, the fencing token (hub
  §2.3, §4; amended for the hub). The hub alone writes `holder {sessionId, epoch, pid, startTime, executable,
  workerId?, ended?}`; `machine` and the 90 s grace are gone. Every read and write is fenced on the live
  holder, by epoch from wave 4 (by session id until then, as built). Reporooms owns
  the participant record, manifest owns the manifest record, and registry adds the holder fields and a
  per-worktree publisher lease. Wave-0 lead rulings: `participantRecord(doc, name)` returns the raw fields,
  and one `acceptedGit(record, view): ParticipantGit | 'updating'` applies both fences (own and
  projected). Presence carries an optional `sessionId`, and `fresh` requires `presence.sessionId ===
  holder.sessionId`.
- **R1b Presence ends (D5).** A participant's presence ends within a bounded time once its host session
  has finished, even when its MCP process lives on (registry §18). Only the worktree's publisher writes
  base facts (`git`) and posts `pushed`; other sessions in the checkout never do (registry §16, reporooms
  §B2, §B4).
- **R2/R2a Receipts.** The CRDT `seen:<participant>` receipt `{sessionId, via, at}` is the only receipt.
  Delivery is at-least-once: a receipt only after a confirmed handoff; duplicates tolerated, loss never.
  Queued/woken is not a receipt; local files hold only cursors; the hook delivers through live MCP
  arbitration; `to` always means the addressee participant.
- **R3/R3a/R3c Base.** Each participant record carries `{branch, head, base}`; `meta.base` is deleted. One
  base per record per room, resolvable by every reader there: in a team room, the newest ancestor of HEAD
  on a remote-tracking ref (the manifest includes unpushed commits). No anchor → "cannot compare"; the
  daemon never stops. Pairwise checks use `git merge-base`.
- **R3b Writers.** One writer per record per room. A `where: here` worker's daemon writes its own team
  records; for `where: local` workers the lead's bridge writes the team projection against the lead's
  team base, exactly the registry's non-terminal workers, fenced by the lead's holder. Never owner policy.
- **R4 Manifest.** Per participant, relative to its base: path → `{change, state, hash?, size?}`, with
  `hash` and `size` only where the writer's policy authorizes the path's text (D1). Absence certifies
  "equals base" only with a complete, fresh, fenced head, coverage `all`, and `sha256(roomSalt‖path)` not
  in `excluded`. Entries are keyed per incarnation (`${name}\0${fence}`); no Y.Map is created by two
  writers at one key.
- **Declared sharing lists paths only (D1).** At `declared`, a changed file outside the text-authorized
  area appears as path, change kind (M/A/D) and state: no size and no content hash, because a hash of a
  small file can confirm guessed contents. Readers treat such an entry as a gap: a preview over it is
  PARTIAL and names it. Ignored and over-budget paths appear only as digests. The consent line for
  `declared` becomes "paths of every changed file; text only in your declared area".
- **Conflicts belong to reporooms.** Conflicts are a derived set of slots keyed by
  `(owner, kind, other, path, subject)`, evaluated at the pair's merge base from each side's
  `{hash, state}`. A side whose entry is hashless (D1) makes the slot a *possible* conflict, keyed by that
  side's `{change, state, held}` instead of a hash, never a certified one (reporooms §B5). IDs are
  deterministic, and the set is reconciled on start, reconnect and change.
- **R5 Local state.** Durable local state lives under `<git common dir>/room/` and is written
  temp-and-rename or created exclusively.
- **R6/R6a Schema.** One schemaVersion 2 release (0.17), a hard cutover (D2). The server and a new relay
  generation refuse schema-less clients before sync; old live connections get 4001. No mixed-version team
  rooms; only local state migrates.
- **Trust model (D3).** Admitted means trusted, plus the schema version (audit item 8, first option). A
  size-cap failure is a visible 4413 rejection. Per-person permissions and validated operations are a
  post-redesign roadmap item (`docs/roadmap.md`, "Post-redesign").

## Hub core

The lead's binding decision (2026-09-28, "narrow hub hybrid"), specified in the [hub spec](2026-09-28-hub.md)
and supported by the Astra and Fable hub reviews. The hub is the process every room already has: the local
relay, or the server.
- **Hub:** name leases with an epoch; message order (the hub is the sole appender of `bus` and assigns `seq`);
  trim, bounds, outcomes and archive; participant expiry on the hub's clock.
- **CRDT:** claims, receipts `seen:<P>`, manifests, overlays, scopes, base and push facts, conflict slots,
  presence. **Local files:** the registry, the publisher lease, session binding.
- No persist-before-ack journal; an unreachable hub gives "[room] hub unreachable; coordination paused".

Lead rulings:
- **R-H1 Counters never repeat.** Epoch and seq are `I · 2^21 + n`; each hub start takes a new incarnation
  `I`, made durable (an fsync'd file) before it serves (hub §3).
- **R-H2 Takeover window.** A new incarnation expires nothing on time measured before it started: live leases
  get a fresh TTL, a 5 s settle window adopts leases that arrive late by sync, and a relay successor seeds from
  its own replica (hub §4.4).
- **R-H3 One authority per clone.** The relay takes an O_EXCL authority lock (wave 0's `leases.ts`, moved to
  the relay) before it starts; a relay without it grants nothing (hub §5).
- **R-H4 Partition.** TTL 45 s, renew every 15 s; the client measures validity from the send time of its last
  acknowledged renew, so it pauses no later than the hub re-grants (hub §4.2–4.3).
- **R-H5** No journal: message durability stays what the doc gives today.
- **R-H6** Hub writes use a hub origin, which the server's identity guard and size cap never count as a
  member's (hub §6).
- **R-H7** Accepted messages reach clients through the CRDT bus; the only push is `lease-lost` (hub §2.5).

One engine, `packages/hub-core`, is used by both the relay and the server; hub protocol 1 ships with schema 2
(R6) and is refused with an update text otherwise (hub §10).

## Dependencies

- **Foundation** (reporooms step 1 and registry step 1): the flat participant record, holder, participants
  view, room keys, `boundSession()` and leases. Every other spec reads one of these.
- **ledger** needs `boundSession()` and the fence. Its resume acceptance needs registry §8 and, for Claude
  runs with no Room call, the registry's stream-json worker argv (registry §3, D4).
- **manifest** needs `resolveBase` and the transition transaction (reporooms step 2). Its reader for trusted
  worker disks needs the registry store. `project()` needs the registry's `projectable()`.
- **reporooms** `ConflictSet` needs the manifest's `versionOf`/`semRev`, and its migration posts through
  the ledger's `post(id)`. Its expiry authority is the hub (hub §8), which runs wave 1's `ExpiryTenure` and
  `expireParticipant`; the trim-leader election that wave 1 built through `delivery` is deleted.
- **hub** needs wave 1's `trim`, `admit`, `ExpiryTenure` and `expireParticipant` and wave 0's `leases.ts`.
  Wave 2's post RPC, wave 3's integer cursor and wave 4's name acquisition need the hub step.
- **registry** projectors need the manifest's projection inputs. Its name and publisher leases, and the
  presence end (§18), need reporooms' participants view; its name lease needs the hub step.

## Implementation order and why

The batches follow the dependency graph. The riskiest shared contracts (record shape, leases, fences)
come first so that later waves build on tested primitives. User-visible cutover (names, server, migration)
comes last, so the branch stays runnable against today's rooms until the final wave. Each wave is a Room
batch:
- a Claude lead;
- Codex workers in worktrees with owned files;
- an octopus merge;
- the full suite run by the lead (Codex cannot listen on sockets);
- an astra review before the next wave.

| Wave | Workers (owned area) | Model / effort |
|---|---|---|
| 0 Foundation | `record`: shared `rooms.ts`, flat participant record, `holder`, `schemaVersion`, participants view (reporooms 1) · `leases`: `leases.ts`, `createExclusive`/guarded release, `boundSession()`, session dir (registry 1) | sol high · sol high |
| 1 Cores | `delivery`: shared `delivery.ts` owed/trim/bounds/outcomes (ledger 1) · `facts`: manifest types, `roomSalt`, `versionOf`, dual publication (manifest 1) · `store`: registry store, reconcile, `statusOf`, adapter, local migration (registry 2) · `base`: `resolveBase`, transition transaction, `pushed`, the expiry authority (the trim leader's `expiry` writes and `expireParticipant`, consuming the leader election through `delivery`'s API; the hub step moves this authority to the hub) (reporooms 2) | sol high · sol medium · sol high · sol high |
| Hub | `hub`: `packages/hub-core` (leases with epochs, sequencer, incarnations, re-assertion, hub-run trim and expiry), relay wiring (authority lock, `leases.ts` moved, seed on takeover), server wiring (`bindHub`, incarnation file), the contract suite over both adapters, a thin unwired `HubClient`; deletes `trimLeader`/`leadsTrim` and roomd's trim-leader and tenure wiring (hub §11) | Opus high (socket tests) |
| 2 Writers | `ledger`: `Ledger`, `FlushedStdioTransport`, batches, arbitration endpoint and hook scripts; `post` becomes an RPC through `HubClient` and the client append goes (ledger 2–3, hub §11) · `policy`: `PolicyStore`, `PublicationInputs`, `plan`/`apply`; delete retention, `setShare`, `sharingGeneration` (manifest 2) · `writes`: registry write paths, launch handoff, report writer, discard plan (registry 3) | sol high · sol high · sol high |
| 3 Readers | `readers`: readers onto `versionOf`, preview completeness (manifest 3) · `conflicts`: `ConflictSet`, claims across bases (reporooms 3) · `wake`: `WakeReconciler`, content-free wakes; the cursor's frontier and the registry's `busFrontier` become a hub seq (ledger 4, hub §11) · `project`: bridge `coordination` + `project()` + registry projectors (manifest 4 + registry 4, one worker; they share `bridge.ts`) | sol medium · sol high · sol medium · sol high |
| 4 Seams | `near`: `neighbours()` seam (reporooms 4) · `web`: web readers with the git-less adapter (manifest 5) · `names`: name and publisher leases replacing the tmpdir lock and `choosePublisher`, names acquired from the hub after the O_EXCL lease, epoch fences, the paused state, no 90 s grace or `machine`; publisher-only base facts and `pushed`; presence end and the idle lease (registry 5, §15, §16, §18; hub §4, §7) · `resume`: resume acceptance, the Claude stream-json worker argv and its log parsing, roomagent, local receipt migration (ledger 5, registry §3/§8) | sol medium · sol medium · sol high · sol medium |
| 5 Cutover | `server`: `names.ts`, admission refusal matrix with the preflight `hub: 1` and the hub protocol refusal (hub §10), per-repo lock, `migrateRepo` (hub-origin writes), archive export, tokens, 4413 · `client`: every naming site in the map, relay generation + catch-up migration, PR mirror, `followBranch` deletion, skills/README/onboarding, consent text (manifest 6) | sol high · sol medium |

Reviews: gpt-6-astra high after every wave, alternating with a Fable pass on waves 2 and 5 (AGENTS.md).
After each wave: `npm run typecheck`, `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`,
`npm run build:plugin`. Wave 5 also needs `claude plugin eval` (routing wording changes).

Collision owners: `shared/src/doc.ts` is wave-0 `record`'s (later waves use the new modules); `bridge.ts`
one worker in wave 3; `tools/index.ts` `ledger` in wave 2; `session.ts` `leases` (wave 0), `names` (wave 4);
`relay/src/index.ts`, `server/src/index.ts` and `packages/hub-core` the hub step's `hub`.

## Rehearsals that prove each step

- **Wave 0.** Two clones join one local room under the same name. The second is refused; after a
  kill -9 of the first, the second takes over. Nested-map race test: two in-memory docs create the same
  participant, and the loser stops writing. **Clone binding (D5, open):** a Codex thread started through
  the shared app-server (the `codex-rescue` path) whose turn metadata names clone X binds to X's room, not
  to the main checkout's. On 2026-09-26/27 such threads worked in `/tmp` clones but joined the main
  checkout's local room, possibly on pre-0.16.24 bundles; record the bundle version and the outcome
  (registry open question 4). *Corrected 2026-09-28 (rehearsal §4):* not a Room bug. The Codex plugin's
  broker starts threads in its `--cwd`, which was the lead's checkout; the prompt only set a per-command
  workdir. With `--cwd <clone>` Room joins that clone's room. The lingering MCPs are the broker never
  unsubscribing threads, which the idle lease (registry §18) still covers.
- **Hub** (after the hub step; hub §12). Kill -9 the relay owner mid-session: a survivor takes over and
  every other holder keeps its name and epoch. Restart a LevelDB server, gracefully and with kill -9: no
  epoch or seq repeats. A partitioned holder (and a laptop asleep 2 minutes) stops coordination writes within
  one lease TTL, and another session gets the name only after the hub's TTL. Two relays started together:
  one authority.
- **Wave 1.** Kill -9 the lead between intent and spawn: the worker is `ambiguous`, never relaunched. A
  diverged branch plus a force-push reset: the daemon keeps publishing, and the pair reports "cannot
  compare".
- **Wave 2.** The Codex queue wake scenario from 2026-09-27 with `hooks.json` unchanged: no duplicate, no
  loss. The 0.16.15–0.16.18 retention scenarios: a scope ends mid-edit and the path is retained. Discard
  interrupted after the patch: replay is idempotent.
- **Wave 3.** The Flask rehearsal: the preview says PARTIAL for held files instead of reading as a
  regression, and no manifest field holds a hash or size of an out-of-area file (D1). The carried-preview
  false alarm from 0.16.33 is gone without the `withheld` special case: a carried file outside the lead's
  declared area is a named gap, never a revert. A local worker edits inside a teammate's team claim and
  gets the conflict notice. Both sides edit a file one of them holds outside its area: a *possible*
  conflict, not a certified one.
- **Wave 4.** Two sessions in one checkout: one publisher, and the other shows why it isn't. Five
  sessions in one checkout (D5): in a team room, a commit and its push give exactly one `pushed` notice
  and one `git` update, from the publisher; in a local room, where D5 was observed, a commit gives
  exactly one `git.rev` bump, from the publisher, and no notice. The other sessions write no `git`. A Codex
  `codex-rescue` thread through the shared app-server finishes: its participant shows idle, then leaves
  within the idle lease, and a quiet interactive session holding a claim stays. A resumed worker's clean
  exit without a report is not `done`; a resumed Claude worker that makes no Room call is receipted only
  on an `assistant` event of its session (D4).
- **Wave 5.** A team rehearsal on a hosted test server: two people on different branches of one repo see
  each other, preview across branches and get cross-branch conflicts. A 0.16 client gets the 403/4001
  text; a migrated branch room carries owed mail and claims, ambiguous names land in `unresolved`;
  `room_close` works unjoined. Rerun the httpx and click rehearsal scripts.

## Decided by the human, 2026-09-28

1. **Held facts at `declared` (D1): paths only.** Outside the text-authorized area a changed file
   appears as path, change kind (M/A/D) and state, with no size and no content hash: hashes of small
   files can confirm guessed contents. Such entries are gaps for every reader. Exact resolution by hash
   applies only where a hash exists (text-authorized paths, or `binary`/`worker` entries at `full`).
   Carried through: manifest invariant 16, §4.1, §4.5, §5.1, §5.3, §5.5, §6, §8 consent, §10, §12;
   reporooms §B5 *possible* conflicts.
2. **A hard cutover to 0.17 (D2): confirmed.** `schemaVersion: 2`. Every teammate upgrades at once, old
   branch rooms become a 30-day read-only archive, and mixed-version rooms are refused rather than
   supported.
3. **The trust model (D3): confirmed.** Admitted means trusted, with no server-side write validation.
   Per-person permissions and validated operations are a post-redesign roadmap item.
4. **Claude resume acceptance (D4, ledger Q4), by a live check on Claude Code 2.1.283.** The evidence for
   a run with no Room call is an `assistant` event with `session_id === hostSessionId` in the run's
   stream-json log; `system/*` events and the exit code are not evidence. Claude workers therefore run
   with `--output-format stream-json --verbose` (registry §3, ledger §Resume).
5. **Presence and the publisher (D5), from a live finding.** About 30 Room MCP processes outlived their
   Codex threads under the Claude plugin's shared `codex app-server`; seventeen sat in the main checkout's
   local room as present participants for two days, and each one's daemon announced every base move.
   Presence now ends within a bounded time (registry §18), and only the worktree's publisher writes base
   facts and posts `pushed` (registry §16, reporooms §B2, §B4). Why those threads joined the main
   checkout's room was checked in the wave-0 rehearsal (§4, corrected 2026-09-28): the broker runs threads in
   its own `--cwd` (there the lead's checkout), and a prompt's per-command workdir does not change that; with
   `--cwd <clone>` Room joins the clone's room.
