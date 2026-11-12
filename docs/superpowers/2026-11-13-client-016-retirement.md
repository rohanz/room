# Client 0.16 retirement audit (2026-11-13)

The boundary is the 0.17.48 retirement decision: ignore never-imported local 0.16 files;
preserve state that the owner's 0.17.47/0.17.48 installations and hosted volume already hold.
Class 1 means removed obsolete behavior; class 2 means a current persisted-state guarantee;
class 3 means uncertain and retained. Counts below are approximate source lines removed,
excluding tests and documentation.

| Candidate | Class | Removal or evidence for keeping |
|---|---|---|
| `session.ts` claim/reclaim/watchLegacyIdentity | 1 | Removed ~46 lines, including startup call, observer and mail rewrite. Only consumes the old `room.json.legacy` identity hint. Existing unresolved facts remain untouched. |
| `choice.ts`, `config.ts`, `room-name.ts` local branch-choice guard | 2 | Keep ignore-only guard: without it an untouched unmarked 0.16 `local/<basename>/<branch>` choice becomes active again, contrary to 0.17.48. Current `rememberTag` also writes unmarked choices; schema absence alone cannot reject every choice. Explicit schema-2 branch-shaped names and custom names remain valid. No importer survives here. |
| `roomd/room-file.ts` root `.room.json` fallback and `legacy` field; `roomd/index.ts` alias writer | 1 | Removed ~15 lines. Private worktree `room.json` remains current. Normal joins now write only room/name/dir; old root files are neither read nor removed. |
| `policy-store.ts` old retained-declared grant import and retirement deletion | 1 | Removed ~21 lines plus unused server argument at retirement callers. Only reads/removes `room-retained-declared*.json` in the private Git directory; no current writer exists. |
| `policy-store.ts` sharing baseline and preserved choice sharing fields | 2 | Keep `room/sharing/legacy-baseline.json`: `legacyBaseline` still writes this clone-wide floor today, and current choice rewrites preserve share/warned/warnedLevels. Removing it can widen an existing user's sharing after leave/rejoin or for another participant. Participant policy records also remain unchanged. |
| `doctor.ts` 0.16 leftover list and diagnostic fact | 1 | Removed ~38 lines: name-only enumeration, INFO row and associated fact. Current local-state diagnostics stay. |
| `tools/files.ts` legacy preview slots, claim ownership and sidecar roots | 2 | Keep. Commit `f24d1a94` (2026-09-30, manifest 0.17.0) introduced the shared cache and cleanup of earlier 0.17 per-process slots. Still-persisted Git worktree registrations and potentially live owners must remain protected. This is 0.17 cache cleanup, not a 0.16 importer. |
| `hub-core/hub.ts` protocol refusal advice | 1 | Replaced the 0.16 migration advice with the actual supported protocol requirement; protocol validation remains. |
| `worker-registry.ts` old-lead refusal advice | 1 | Replaced the historical upgrade diagnosis with `invalid Room worker ID`; the ID/run/nonce/registry admission checks remain. |
| Root `.room.json` ignore/exclude rule in roomd | 2 | Keep the ignore/exclude boundary so old private metadata cannot become shared file text. Corrected startup comments and metadata-write warning to name current private `room.json`. |
| `shared/doc.ts` legacyDeleted getter | 1 | Removed 2 unused lines. No source consumers exist; the current `MEMORY_TYPES` snapshot schema does not retain the old `deleted` root. |
| Shared `unresolved` and `aliases` maps and readers | 2 | Keep. `MEMORY_TYPES` persists both; `tools/scope` displays retained unresolved facts, `tools/names` recognizes placeholders/aliases, and `tools/messaging` resolves already-migrated aliases. Updated unresolved display to say retained migration history, since rejoining no longer reclaims a placeholder. |
| `shared/messages.ts` old branch-switch notice filter | 2 | Keep. Already-migrated buses may contain this obsolete notice (including ambiguous placeholder senders from pre-rc7 migration); delivering it would mislead current sessions. `relevance.test.ts` covers an existing bus, not an old file import. |
| Numeric receipt readers (`doc.ts`, `memory.ts`, `tools/scope.ts`) | 2 | Keep. Existing live room documents/snapshots may contain numeric receipts. `seen().has(id)` still ends delivery; snapshot filtering and state display must recognize those receipts rather than make delivered messages unread/owed again. |
| Server-side refusal of unmigrated registries | 2 | Untouched: `server/registry.ts` protects the hosted volume without opening legacy document values. |
| `worker-refs.ts` legacy record refs | 2 | Untouched, as required: these are current 0.17.47 worker records and recovery guarantees. |

By decision, mail addressed to an unreclaimed placeholder stays owed until the ordinary 14-day expiry.

No class-3 candidates remain. The mail regression exercises a real fenced session with a
private old identity hint: disconnect its replica, retire the recipient on the hub, prune
the bounded retirement marker, add late unresolved facts to the stale replica, then merge
it back. Neither startup nor a late observer may rewrite mail or resolve an alias; the
hub's deletion must survive and the ended message must remain unowed.

Changed expectations in retained tests: root `.room.json` stays byte-identical and is
ignored; worktree metadata fixtures use private `room.json`; old retained grants stay on
disk and grant nothing; joins drop obsolete `room.json.legacy` hints; unresolved-history
lines no longer advise rejoining; invalid worker IDs use the current generic refusal; hub refusals name the supported protocol instead of a retired migration release.
Removed tests cover only deleted reclaim/import/deletion/diagnostic behavior. Existing
history, sharing-floor, hooks, GC preservation and worker retirement assertions stay.

Validation evidence:

- `npm run typecheck` and `npx knip`: passed locally.
- MCP focused files: consent, doctor, policy-store, retired-016-doctor,
  retirement and worker-registry: 166 tests passed. The first added mail test
  initially called a nonexistent index method; corrected to the public `owed`
  helper. Final review-mail3/unresolved-state/legacy-local-choice/migrated-history/
  relevance run: 14 tests passed.
- Shared views/memory/messages/delivery: 79 tests passed. Roomd room-file/startup:
  5 passed. Hub/protocol: 48 passed after replacing the obsolete migration-advice
  assertion with the required protocol; hello-first and no-document-write assertions stay.
- The stale-mail regression fails against the original session/reclaim and room-file
  implementations at `hub.doc.mail.has(message.id)` (true); passes with removal.
- `local-retirement.test.ts`: all eight scenarios fail before join because the daemon
  cannot establish its process birth identity. Its unchanged relay startup requires
  `probeOwnProcess()` startTime/executable. On this macOS sandbox, `sysctl -n kern.boottime`
  exits 1 with `Operation not permitted`, preventing that identity read. These cases
  need the lead's unrestricted run; no socket/daemon pass is claimed.
- Initial four-worker preview (viewer rev 7, stalls rev 8, fixes rev 11): clean merge,
  typecheck passed, inputs `f76bf28697c82071334da42575bb8d73529dfdbd26a3edefbb75a5035e052048`.
- Broader regression preview (viewer 8, stalls 9, fixes 13): 100 passed, 3 failed.
  Viewer owns doctor server-health expectation; stalls owns two corrupt worker-record
  evidence expectations. Both passed in this worker's own tree and were sent directly
  to their owners. The stale-mail, policy, consent and unresolved-history checks passed
  in that combined snapshot (`30b71b6c23f520aa7b67fb6b16eef9e5327e7f9b566aa48eea2aa557241e0b20`).

- Owners confirmed the broader-preview failures: stalls is restoring quarantined-ID
  diagnostics on its inventory fast path; viewer is updating negotiated-health fixtures.
- Four-file combined regression preview (viewer 10, stalls 12, fixes 15): all 33 tests
  passed; no conflicts, inputs `d34ac521aa48459970e0ae4ebf1b82b088683cd85a0de38676726616a0698e5d`.
  Fixes moved its kept-publication/combined-tree files during that run; this remains
  evidence for the listed snapshot, not a claim about later peer revisions.
