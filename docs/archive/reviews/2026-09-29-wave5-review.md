# Wave 5 review — 2026-09-29

Reviewed **`git diff 80a1db2^1 80a1db2`** (server) and **`git diff 551616a^1 551616a`** (client), pinned to **551616a7189eb800e57ce75783aa5a1c27962a50**. Binding references: the 2026-09-28 redesign plan (R6/R6a, D1–D3, R-H6), reporooms (§B1/B2/B8/B11/B12/B13, deletions, migration, recovery and tests), hub (§6/§10), manifest step 6, and the naming-site map. **12 Must-fix, 3 Should-fix.** This report is the only retained change; no source edits or commits.

**Admission ruling:** asked rohanz about R6/D2 versus the older B11 matrix. The lead explicitly ruled that B11's pre-migration transition stands: the server deploys first, so 0.16 clients may continue in unmigrated branch rooms until the first admitted schema-2 request. Branch-mode admission alone is therefore **not a finding**. The binding boundary for this review is no schema-2 sync before migration, no 0.16 sync after migration, and immutable migrated archives. M1 finds an actual bypass of that boundary. The lead will record this transitional window as a decision for Rohan.

## Must-fix

- **M1 — A schema-2 viewer can bypass migration using a legacy canonical-key view token. Owner: server.**
  **Locations:** `packages/server/src/index.ts:542`, `:583–587`, `:595–601`.
  The view-token branch calls `accept()` before the authenticated path's `migrateOpenRepo`. B11/MF9 explicitly supports a legacy document already at the canonical key. An old token for that key matches `docKey` when a new browser sends `schema=2`, so the browser syncs the schema-less document while the repo remains branch-mode and 0.16 writers remain connected. Read-only enforcement on the viewer does not make this a schema-2 document or separate the two versions.

  **Probe:** invoked the real upgrade handler with socket/upgrade stubs, an open branch-mode `local/review`, and an existing canonical-key token. `?schema=2&view=old` produced `accepted:true, mode:"branch"`, with no migration timestamp. Require completed migration before accepting schema-2 viewers. An old bearer token must not itself authorize migration or silently gain access to the new repo room; refuse it with the old-link explanation and require a freshly authenticated preflight/token.

- **M2 — Server migration drops every ambiguous participant's scope. Owner: server.**
  **Locations:** `packages/server/src/migrate.ts:70–80`.
  The first loop creates every ambiguous `unresolved` entry with only `placeholder` and `claims`. The scope-copy loop then writes the scope only if that same entry does not exist. This condition is always false. Reclaiming an identity later restores its claims but permanently loses its scope, violating migration step 5.

  **Probe:** migrated two branch docs, each with ben's scope and claim. Both resulting `unresolved` values held their claims and lacked `scope`. Merge `scope` into the existing entry without replacing its claims; retain the insert-only/replay behavior. Add an assertion for the scope to the existing crash-boundary fixture.

- **M3 — Without YPERSISTENCE, migration writes a target that the websocket loader never reads. Owner: server.**
  **Locations:** `packages/server/src/index.ts:132–147`, `:178–190`, `:500–506`.
  In-memory migration stores the new repo update in `memoryDocs`. `loadDoc()` can read it, but the production connection path calls stock `setupWSConnection()` without hydrating that update or providing an in-memory persistence adapter. Its newly created live Y.Doc is empty. The registry nevertheless says migration completed, so subsequent joins do not retry it. Owed mail and claims disappear from the room even without a process restart.

  **Probe:** migrated one owed question with persistence disabled, then emitted the real connection event using a socket stub. The stored target had `savedMail:1`; the live doc had `liveMail:0` and no schema version. Make document initialization consume the same storage abstraction migration writes, before sync and hub startup. This also covers initial schema-2 room creation in the supported in-memory server mode.

- **M4 — Local migration turns already-receipted addressed messages into owed mail again. Owner: client.**
  **Location:** `packages/relay/src/local-migrate.ts:86–94`.
  An addressed message with an old receipt goes down the `else target.bus.push([copy])` path. Its receipt is never copied. The new delivery ledger considers addressed bus messages independently of the broadcast frontier, so the recipient receives the question again; hub trimming may move it back into owed mail. This breaks the migration's no-resurrection requirement.

  **Probe:** a legacy question `seen-q` to ben had `seen:ben[seen-q] = 123`. After `catchUpLocal`, the target had no receipt and real `owed()` returned `seen-q`. Either retain receipted history together with correctly translated receipts/outcomes, or leave it in the old archive and copy only owed addressed messages. Cover unique and unresolved recipients and restart persistence.

- **M5 — Retrying a failed local snapshot save can persist the import ledger without the imported state. Owner: client.**
  **Locations:** `packages/relay/src/local-migrate.ts:55–56`, `:86–94`, `:123–128`.
  Catch-up mutates the live document before `saveMemory`. If saving fails, the next attempt sees those IDs already present and can make no new document changes. It then skips `saveMemory` because `changed` is false, but writes the ID/mtime ledger because `scanned` is true. A crash before the ordinary debounced memory save now loses the imported records permanently: future catch-ups regard them as already imported.

  **Probe:** forced the first snapshot rename to fail by placing a directory at its output path, removed the obstruction, and retried against the same doc. The result was `snapshotExists:false`, `ledger.messages:["lost-on-retry"]`, `liveMail:1`. Persist the target whenever advancing the import ledger, even if the IDs were already in memory, and never commit source mtimes/IDs until that save succeeds. Exercise failures before/after both writes, not only successful reruns.

- **M6 — A later legacy snapshot can make a previously imported identity ambiguous without repairing its earlier ownership. Owner: client.**
  **Locations:** `packages/relay/src/local-migrate.ts:63–83`, `:96–117`; `packages/room-mcp/src/session.ts:584`, `:639–659`.
  Identity ambiguity is recomputed on each scan, but previously processed source mtimes and claim/message IDs are skipped. First import ben from main as unique; while the old relay is still running, a feature snapshot introduces another ben. Only the new branch is put in `unresolved`; the main claim, scope and mail remain owned/addressed to bare ben. Whichever clone obtains that name can then validate or consume another clone's facts. Reclaiming unresolved state only once during session startup also leaves later catch-up records stranded for an already joined owner.

  **Probe:** first catch-up imported main/c1 under ben. Adding feature/c2 and catching up again left c1 in `claims` under ben and only c2 in `unresolved`. Persist a source-qualified identity decision and reconcile earlier imported records when ambiguity expands, without resurrecting released/receipted IDs. Observe newly imported unresolved records under the current lease and re-run reclamation/claim validation for the owning session.

- **M7 — The ordinary reply tool rejects questions from unresolved migrated senders. Owner: client.**
  **Locations:** `packages/room-mcp/src/tools/messaging.ts:45–50`, `:100`, `:153–155`; `packages/room-mcp/src/session.ts:650–657`.
  Migration correctly puts an ambiguous sender's question to a unique recipient into `mail`, with a placeholder as `from`. `room_send(type="answer", inReplyTo=...)` infers that placeholder, then rejects it because `knownNames` includes neither mail-only senders nor unresolved identities. Thus the spec's explicit “ambiguous ben asks unique cy; cy replies to the placeholder and it stays owed” path fails. The written `aliases` map also has no reader in message routing, so a late explicit placeholder address cannot resolve after reclamation.

  **Probe:** called the actual messaging handler with cy's migrated question in `mail` and the corresponding unresolved record. It returned `error: nobody called ?abc123 is or was in this room; participants: cy`. Recognize source-backed unresolved recipients for replies, retain mail addressed to them, and resolve aliases consistently during target inference, validation and delivery. Do not broadly admit arbitrary unknown names.

- **M8 — The client does not surface or handle the new 4413 rejection. Owner: client.**
  **Locations:** `packages/room-mcp/src/session.ts:824–831`; `packages/room-mcp/src/connection.ts:11–20`; `packages/room-mcp/src/tools/scope.ts:119–125`.
  The server now closes capped writers with 4413 and a useful reason, but `watchClosed` only handles 4001. Connection tracking discards the code/reason and reports generic offline state. The provider continues its normal reconnect behavior; there is no 60-second cap retry or the required “your last edits are not in the room” state. A writer can keep editing while being told only that it is disconnected, losing the actionable rejection that D3/B11 specifically require.

  **Evidence:** searched the production client, daemon and web paths: no 4413 handling exists. Preserve the rejection and reason, stop normal rapid retries, show the rejected-publication state in tool/hook output and `room_state`, and retry at the specified interval. Clear it only when publication is accepted again. Server-side cap unit tests passing does not exercise this client path.

- **M9 — The archive is not reachable through the specified room_export interface. Owner: client.**
  **Locations:** `packages/room-mcp/src/tools/join.ts:32–33`, `:267–270`; `packages/room-mcp/src/tools/scope.ts:129–132`.
  B11 specifies `room_export room=<legacy>` rendering the authenticated archive update in a scratch document. The tool schema accepts only `path`, and its handler always exports the current session. There is no client call to `/archive/export`. Passing the requested legacy room would therefore produce a successful-looking ledger of the wrong room. Users cannot inspect the archived evidence for unresolved identities through Room before the 30-day purge.

  **Evidence:** server endpoints exist, but no production client calls either archive endpoint. Add the legacy-room argument, authenticate using repo access, load the returned update into a disposable doc and export that document. Make unresolved-state guidance identify the export command, and reject an unavailable archive explicitly.

- **M10 — Version 0.17 manifests still ship the old committed runtime and browser assets. Owner: client.**
  **Locations:** `plugins/room/.claude-plugin/plugin.json:3`, `plugins/room/.codex-plugin/plugin.json:3`; `plugins/room/server/room-mcp.mjs:46951`, `:54751`; `scripts/build-plugin.mjs:16–44`.
  Neither merge rebuilds the committed plugin assets. At the reviewed HEAD the manifests advertise 0.17.0, but the shipped bundle still declares `version: "0.16.34"` and `LOCAL_FILE = "room-local.json"`. Installing this revision runs the previous relay/naming implementation under a new release label; it does not deliver the reviewed schema-2 source. The browser copy is likewise unchanged by these merges. This is an explicit manifest step-6/release requirement, not a source formatting issue.

  **Evidence:** inspected the committed bundle and merge file lists. A fresh scratch esbuild bundle of the pinned source succeeded. Rebuild and commit all generated plugin assets from the integrated source before release, then verify both hosts' installed plugin handshake and relay generation. No generated assets were changed by this review.

- **M11 — PR selection reads stale participant git fields without their epoch fences. Owner: client.**
  **Locations:** `packages/room-mcp/src/tools/prs.ts:55–56`, `:88–96`; `packages/room-mcp/src/prs.ts:90`, `:115`.
  The new PR branch selection reads raw `participantRecord(...).git`, bypassing `acceptedGit`. After a name is replaced, or a projected worker's lead loses its lease, the old git record is intentionally still readable as raw data but has no authority. These callers nevertheless fetch/mirror its branch and can choose that old branch's PR for the default external `room_pr_note`. This violates reporooms invariant 3 and the fenced-reader requirement, even though the branch is no longer parsed from the room name.

  **Probe:** holder epoch 22, git fence `"21"`, branch `obsolete`. `acceptedGit` returned `"updating"`, but real `refreshPrs` issued both target and head requests for `obsolete`. Read accepted facts for all candidate and own-branch operations; report updating/unavailable rather than selecting a stale PR. Revalidate authority/branch after awaited fetches before replacing the shared mirror or posting a default-branch note.

- **M12 — Migrated-claim validation can remove claims after its name lease lapses. Owner: client.**
  **Locations:** `packages/roomd/src/index.ts:886–906`; `packages/room-mcp/src/session.ts:594–595`.
  The caller checks `lease.fence()` before awaiting `validateMigratedClaims`, but the validator awaits `reanchorOwnClaims` and then mutates claims without checking the fence again. Its only ownership check is `current.by === this.name`. If the lease lapses or a successor takes the same name during the Git read, the old validator can move/delete that name's current claims. The normal HEAD-transition path rechecks its captured fence; the newly added migration path does not. Release notices also cannot repair an unauthorized deletion once posting refuses the lapsed lease.

  **Probe:** invoked the real validator method with an injected claim-reader completion that revoked fence 22 during its await. It returned with `fence:null, claims:0`. Capture a valid epoch at entry, revalidate it after every awaited read and immediately before mutation, and ensure the current claim still matches the snapshot being validated. On loss, leave the claim for the valid holder's reconciliation. This is required by hub §7 and migration's claim-validation rule.

## Should-fix

- **S1 — Old browser links get neither the specified 410 response nor an actionable explanation. Owner: server/client.**
  **Locations:** `packages/server/src/index.ts:583–587`; `packages/web/src/conn.ts:53–57`.
  Migration revokes old tokens, but their branch links receive generic 403. The browser explicitly skips its HTTP explanation for URLs carrying a view token, so the user sees a disconnected/retrying view rather than B10/B11's “this link was for a branch room that no longer exists; ask for a new link.” Distinguish migrated branch/archive links and present the documented terminal explanation without exposing archive data to the bearer. This is separate from M1's pre-migration acceptance bypass.

- **S2 — Manifest step 6's overlay compatibility API deletion is incomplete. Owner: client.**
  **Locations:** `packages/shared/src/doc.ts:169`, `:361–373`, `:401–411`; `packages/roomd/src/publisher.ts:133`, `:206`.
  `changedPaths`, `whoChanged`, `deleted` and the compatibility `paths`/`hasFile` wrappers remain. They enumerate legacy overlay/deletion keys, so a canonical participant with hashless held entries yields no changes, and incarnation keys can be returned as people. Current migrated readers mostly avoid them; the publisher still depends on `changedPaths` for internal cleanup. Move that cleanup to a deliberately internal incarnation-map helper and remove the public overlay-based reader surface promised in manifest step 6. Keep any legacy decoding needed for migration explicitly separate.

- **S3 — Local completion uses PID liveness alone and does not freeze a completed archive. Owner: client.**
  **Locations:** `packages/relay/src/local-migrate.ts:15–19`, `:49–53`, `:124–128`; `packages/relay/src/index.ts:308–313`.
  B12/N2 calls for a process-identity probe and a final catch-up followed by frozen legacy snapshots. `oldRunning` only calls `pidAlive`, so a reused PID can keep the migration banner active for an unrelated process. `ledger.complete` is written but never used to stop imports; a later old-generation run can continue importing into what was declared a completed archive. Use the available process identity evidence conservatively, define the handling of an indeterminate legacy identity, and persist/enforce the final source set once completion is declared.

## Specific checks and verification

- **Question 1 — transitional admission:** allowed by the lead's explicit ruling above. Ordinary schema-less member requests are rejected after mode changes, and migration closes old connections with 4001. M1 identifies the exceptional viewer route. Real socket refusal/reconnect timing was not exercised in this sandbox.
- **Question 2 — migration:** `RepoLocks` serializes same-repo operations; migration writes use `HUB_ORIGIN`; the stable plan/archive key and persisted `planned/frozen/moved/written` boundaries pass their existing replay tests. Unique claims preserve IDs and hashes, strip anchors and gain source origins; server mail copying excludes receipted messages. This is **not** an end-to-end crash-safety approval: M2–M7 cover lost scopes, unhydrated targets, receipt replay, failed-save recovery and identity/reply failures; M12 covers the new claim validator's missing fence recheck. Existing server tests inject failure after successful step saves, not every I/O boundary or live drain race.
- **Question 3 — naming map:** source searches found no remaining `followBranch`, `pinnedRoom`, `blockedBranch`, `meta.base` reads, or room-base fallback in the reviewed production source. Remaining `lastIndexOf('/')` calls inspected are file paths, encoded-room URL/server separation, or the intended longest-prefix helper. PR calls now send explicit branch parameters; target/head union, de-duplication, 10-branch/20-PR caps and detached/worker-branch filtering are implemented, with the fencing defect in M11. D1's exact declared-sharing wording and the one-time any-branch disclosure are present. Both plugin manifests and the Claude marketplace version say 0.17.0.
- **Question 4 — relative publisher import:** `session.ts:22` crosses the workspace boundary to `../../roomd/src/publisher.js`, but scratch esbuild successfully resolved and bundled the pinned implementation; it is **not an observed plugin build failure**. These are private source workspaces. A supported independently packaged/dist-only roomd would need an exported package entry point; that distribution is not established here, so no speculative must-fix is counted.
- **Question 5 — deletions:** the reporooms summary's named obsolete production implementations are gone: branch follower/pinning/slicing, shared-base helper and recovery, old ConflictWatcher sets/claim observer/pairs, `branchOf`, `evictStale`, `reserveAutoName`, divergence/meta-base publication and advancement family, branch warnings/remote-room helpers, shared room-base/behind fields, server `repoOf`/`noteBranch`/fake admission branch/silent cap drop, and web `conflicts.ts`/header branch chip/meta-base reads. Historical `base` rendering remains intentionally, with its wake disabled. The separate binding manifest step-6 deletion and generated-asset requirements are incomplete (S2, M10).

**Validation:** 9 selected offline suites, **75 tests passed**: server migration, names, repo lock, document size and store; relay local migration and memory; room-mcp PRs and consent. Tests used aliases pointing to this pinned worktree, two workers, and the repository's identity-sanitizing setup. A scratch bundle of the pinned MCP source also built successfully. Additional disposable probes used the actual migration, delivery, PR and messaging implementations. Server probes retained production handlers but replaced listening/transport with stubs; they are not live websocket integration results. No socket suite or real 0.16 binary cutover rehearsal was run. Probe scripts, fixtures, bundles and temporary test configuration were removed after use.

**Room coordination:** `room_preview_merge(people=["rohanz"])` reported no conflicts against common ancestor 551616a718; only this review file differed. No combined-code test run was needed for the report-only change.
