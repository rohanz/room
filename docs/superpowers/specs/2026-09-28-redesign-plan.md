# Redesign plan, 2026-09-28: ledger, manifest, registry, repository rooms

Phase 1 output: four specs, each reviewed by Codex (gpt-6-astra, high), revised, re-reviewed where must-fix
items remained, and checked against each other by the lead.
- [ledger](2026-09-28-ledger.md): one delivery ledger ([review](reviews/2026-09-28-ledger-review.md))
- [manifest](2026-09-28-manifest.md): one sharing policy value plus a manifest ([review](reviews/2026-09-28-manifest-review.md))
- [registry](2026-09-28-registry.md): durable local worker registry and leases ([review](reviews/2026-09-28-registry-review.md))
- [reporooms](2026-09-28-reporooms.md): repository-level rooms and derived conflicts ([review](reviews/2026-09-28-reporooms-review.md))

The problem statement is [the 2026-09-27 audit synthesis](../../audit-2026-09-27-design.md).

## Shared decisions (lead rulings, binding on all four)

- **R1 Identity.** Participant (stable room name; owns scope, claims, manifest; the addressee), host
  session (immutable ID; unit of wake and hook state), worker (globally unique ID; tag is a lead alias).
- **R1a Name lease.** An O_EXCL lease under `<common>/room/names/` arbitrates within a clone. Across clones
  and machines, the CRDT `holder {sessionId, machine, pid, startTime, exe}` arbitrates, and ownership is
  eventually consistent. Every read and write is fenced on the live holder. Reporooms owns the participant
  record, manifest owns the manifest record, and registry adds the holder fields and a per-worktree
  publisher lease.
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
- **R4 Manifest.** Per participant, relative to its base: path → `{hash, size, state}`. Absence certifies
  "equals base" only with a complete, fresh, fenced head, coverage `all`, and `sha256(roomSalt‖path)` not
  in `excluded`. Entries are keyed per incarnation (`${name}\0${fence}`); no Y.Map is created by two
  writers at one key.
- **Declared sharing lists facts.** At `declared`, out-of-scope changed files appear as held facts: path,
  size and hash, with no text. Ignored and over-budget paths appear only as digests. The consent line
  changes to match. **(Product decision; see below.)**
- **Conflicts belong to reporooms.** Conflicts are a derived set keyed by
  `(a, b, path, aHash, bHash, mergeBase)`. IDs are deterministic, and the set is reconciled on start,
  reconnect and change.
- **R5 Local state.** Durable local state lives under `<git common dir>/room/` and is written
  temp-and-rename or created exclusively.
- **R6/R6a Schema.** One schemaVersion 2 release (0.17). The server and a new relay generation refuse
  schema-less clients before sync; old live connections get 4001. No mixed-version team rooms; only
  local state migrates.
- **Trust model.** Admitted means trusted, plus the schema version (audit item 8, first option). A
  size-cap failure is a visible 4413 rejection.

## Dependencies

- **Foundation** (reporooms step 1 and registry step 1): the flat participant record, holder, participants
  view, room keys, `boundSession()` and leases. Every other spec reads one of these.
- **ledger** needs `boundSession()` and the fence. Its resume acceptance needs registry §7.
- **manifest** needs `resolveBase` and the transition transaction (reporooms step 2). Its reader for trusted
  worker disks needs the registry store. `project()` needs the registry's `projectable()`.
- **reporooms** `ConflictSet` needs the manifest's `versionOf`/`semRev`, and its migration posts through
  the ledger's `post(id)`.
- **registry** projectors need the manifest's projection inputs. Its name and publisher leases need
  reporooms' participants view.

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
| 1 Cores | `delivery`: shared `delivery.ts` owed/trim/bounds/outcomes (ledger 1) · `facts`: manifest types, `roomSalt`, `versionOf`, dual publication (manifest 1) · `store`: registry store, reconcile, `statusOf`, adapter, local migration (registry 2) · `base`: `resolveBase`, transition transaction, `pushed` (reporooms 2) | sol high · sol medium · sol high · sol high |
| 2 Writers | `ledger`: `Ledger`, `FlushedStdioTransport`, batches, arbitration endpoint and hook scripts (ledger 2–3) · `policy`: `PolicyStore`, `PublicationInputs`, `plan`/`apply`; delete retention, `setShare`, `sharingGeneration` (manifest 2) · `writes`: registry write paths, launch handoff, report writer, discard plan (registry 3) | sol high · sol high · sol high |
| 3 Readers | `readers`: readers onto `versionOf`, preview completeness (manifest 3) · `conflicts`: `ConflictSet`, claims across bases (reporooms 3) · `wake`: `WakeReconciler`, content-free wakes (ledger 4) · `project`: bridge `coordination` + `project()` + registry projectors (manifest 4 + registry 4, one worker; they share `bridge.ts`) | sol medium · sol high · sol medium · sol high |
| 4 Seams | `near`: `neighbours()` seam (reporooms 4) · `web`: web readers with the git-less adapter (manifest 5) · `names`: name and publisher leases replacing the tmpdir lock and `choosePublisher` (registry 5) · `resume`: resume acceptance, roomagent, local receipt migration (ledger 5) | sol medium · sol medium · sol high · sol medium |
| 5 Cutover | `server`: `names.ts`, admission refusal matrix, per-repo lock, `migrateRepo`, archive export, tokens, 4413 · `client`: every naming site in the map, relay generation + catch-up migration, PR mirror, `followBranch` deletion, skills/README/onboarding, consent text (manifest 6) | sol high · sol medium |

Reviews: gpt-6-astra high after every wave, alternating with a Fable pass on waves 2 and 5 (AGENTS.md).
After each wave: `npm run typecheck`, `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npm test`,
`npm run build:plugin`. Wave 5 also needs `claude plugin eval` (routing wording changes).

Collision owners: `shared/src/doc.ts` is wave-0 `record`'s (later waves use the new modules); `bridge.ts`
one worker in wave 3; `tools/index.ts` `ledger` in wave 2; `session.ts` `leases` (wave 0), `names` (wave 4).

## Rehearsals that prove each step

- **Wave 0.** Two clones join one local room under the same name. The second is refused; after a
  kill -9 of the first, the second takes over. Nested-map race test: two in-memory docs create the same
  participant, and the loser stops writing.
- **Wave 1.** Kill -9 the lead between intent and spawn: the worker is `ambiguous`, never relaunched. A
  diverged branch plus a force-push reset: the daemon keeps publishing, and the pair reports "cannot
  compare".
- **Wave 2.** The Codex queue wake scenario from 2026-09-27 with `hooks.json` unchanged: no duplicate, no
  loss. The 0.16.15–0.16.18 retention scenarios: a scope ends mid-edit and the path is retained. Discard
  interrupted after the patch: replay is idempotent.
- **Wave 3.** The Flask rehearsal: the preview says PARTIAL for held files instead of reading as a
  regression. The carried-preview false alarm from 0.16.33 is gone without the `withheld` special case. A
  local worker edits inside a teammate's team claim and gets the conflict notice.
- **Wave 4.** Two sessions in one checkout: one publisher, and the other shows why it isn't. A resumed
  worker's clean exit without a report is not `done`.
- **Wave 5.** A team rehearsal on a hosted test server: two people on different branches of one repo see
  each other, preview across branches and get cross-branch conflicts. A 0.16 client gets the 403/4001
  text; a migrated branch room carries owed mail and claims, ambiguous names land in `unresolved`;
  `room_close` works unjoined. Rerun the httpx and click rehearsal scripts.

## For the human to decide before wave 0

1. **Held facts at `declared`.** Teammates would see the paths, sizes and hashes of every changed file,
   with text only in the declared area. Hashes of tiny files can confirm guessed contents. The
   alternative, "unknown" outside the area, keeps today's disclosure but degrades previews.
2. **A hard cutover to 0.17.** Every teammate must upgrade at once, old branch rooms become a 30-day
   read-only archive, and mixed-version rooms are refused rather than supported.
3. **The trust model.** Admitted members are trusted, with no server-side write validation. Validated
   operations are deferred.
