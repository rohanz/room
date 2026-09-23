# Review of 0.11.1 (carry-over and joins), by Codex gpt-6-astra, medium, 2026-09-23

Reviewed main at 8a9b939. Run in parallel with the other model's review; the lead session confirmed the blockers against the code before the fix batch.

VERDICT: Do not call 0.11.1 invisible or lossless yet: preview can write outside its scratch tree, retirement can delete output, and carried work is not consistently private or attributed to its lead.
The ordinary lead-side carry/collect algorithm is substantially better, and the focused checks passed.
The highest risks are destructive alternate paths and automatic creation of pushable snapshots of private work.
Worker-side previews, automatic conflicts, graph observations and the browser still disagree about carried ownership.
The reported 15-hour disconnection follows directly from the silent, one-shot local auto-join failure path.
An 86-second join is plausible through unbounded initialization, but its exact cause cannot be established without that session's logs.
Validation: typecheck and 76 tests passed; this review used no network, changed no source, and made no commit.

## Findings

1. **blocker — Preview can overwrite an external symlink target.** `packages/room-mcp/src/tools/files.ts:208`, `:214`; `packages/room-mcp/src/tools/combined-tree.ts:72`.

   **Defect:** Materialization checks current worktree symlinks but writes through symlinks restored from the ancestor archive.

   **Scenario:** At HEAD, `config.txt` is a tracked symlink to an external file, possibly another file in the lead's checkout. The lead replaces the symlink with a regular file containing WIP. Spawn carries that replacement, and the worker edits another file. Both current worktrees now have a safe regular `config.txt`, so the combined-tree checks accept it. A preview with `run` archives the older HEAD, recreating its symlink, then `writeFileSync(abs, text)` follows it. The external target is overwritten before tests start; deleting the scratch directory does not undo that write. The same issue applies to symlink ancestors replaced by directories.

   **TRACED:** The path filter only resolves current caller/worker paths; `materializeGitTree` restores ancestor modes and symlinks; the subsequent write loop neither rejects nor unlinks archived symlinks. No destructive reproduction was attempted.

   **Smallest clean fix:** Validate every scratch path component after extraction. Replace final symlinks without following them, and refuse or safely replace symlink ancestors before creating directories or writing merged files. Keep all writes within the resolved scratch root.

2. **blocker — Automatic retirement bypasses the ignored-output protection.** `packages/room-mcp/src/registry.ts:166`, `:173`; `packages/room-mcp/src/workers.ts:64`, `:365`.

   **Defect:** A Git-clean completed worker is force-removed without checking its ignored artifacts.

   **Scenario:** A carried worker produces only an ignored `artifact.bin`, calls done, and exits successfully. Git status is clean and the carried commit is excluded from `ahead`, so retirement selects `clean`. It calls `cleanupWorker(..., true)`, which force-removes the worktree and artifact. The lead need not call collect or discard. A worker whose source was already integrated but which retains ignored output reaches the same path. There is no recovery patch here.

   **TRACED:** `workerGitFacts` uses status without ignored files; `shouldRetire` accepts `{exited:true, done:true, dismissed:false, clean:true, ahead:0, merged:false}` as `clean`; `evaluateRetirement` never calls `ignoredWorkerArtifacts`. Its cleanup catch also proceeds to remove the room record when deletion failed, potentially orphaning retained files. This is a remaining route around the protection marked FIXED in the 0.10.2 readiness audit, not a repeat of the now-protected explicit collect path.

   **Smallest clean fix:** Share one retention/cleanup decision between collect and retirement. Retain the worktree and actionable record when ignored output exists or cleanup fails; retire only after successful safe cleanup.

3. **blocker — Carry puts otherwise private WIP on pushable branches.** `packages/room-mcp/src/workers.ts:256`, `:261`, `:263`, `:275`.

   **Defect:** Spawn automatically commits every Git-eligible dirty path, including untracked secrets, under `refs/heads/room/<tag>` without a separate publication boundary.

   **Scenario:** A local-only lead has an untracked credential file that is not Git-ignored, or has deliberately excluded a tracked private file with `.roomignore`. Spawn copies and commits it regardless of `.roomignore`, scope or sharing level. While the worker branch exists, an ordinary later `git push --all` includes that snapshot and its blobs. Ref-walking tooling also discovers them. Cleanup removes the branch but does not erase already-created objects. This is worse than the roadmap's known text-sharing/redaction gap: even an intent-only or local session creates durable, ordinarily pushable Git history for the private content.

   **TRACED:** Carry consults Git exclusion only; it never invokes the Room sharing/ignore policy. The resulting commit is the worker branch tip. No push or network action was performed.

   **Smallest clean fix:** Keep carried snapshots and worker history off ordinary pushable branches, for example a detached worker plus privately managed recovery refs and explicit promotion when requested. Apply an explicit carry eligibility boundary, including Room exclusions, and disclose exclusions before dispatch. Merely suppressing the carry message or deleting the branch later does not protect `push --all`.

4. **blocker — Separate rooms can run workers in the same worktree.** `packages/room-mcp/src/workers.ts:246`, `:248`; `packages/room-mcp/src/tools/workers.ts:85`, `:100`.

   **Defect:** Worker isolation is keyed by repository/tag on disk but checked and reserved by room/lead in memory.

   **Scenario:** Two sessions in the same checkout use a team room and a local room respectively. Both spawn tag `tests`. Their room records and process-local reservations do not collide. The second `prepareWorktree` sees the first `.git` file and returns the same directory without checking ownership or liveness; the second agent starts there too. The two rooms cannot coordinate their concurrent edits. Collecting or discarding one record can act on the other's live output or remove its checkout.

   **TRACED:** The worktree path and branch omit room, lead and generation, while `workerIdBase` includes them; the existing-directory fast path is unconditional. This does not require a timing race or a malicious participant.

   **Smallest clean fix:** Reserve worktree ownership in the common Git directory across processes, keyed by canonical path, and verify it before reuse. Use unique per-worker paths/branches or refuse a tag occupied by another room/session.

5. **should-fix — A failed spawn can lose the carried base on retry.** `packages/room-mcp/src/tools/workers.ts:147`, `:155`, `:158`; `packages/room-mcp/src/workers.ts:248`, `:255`; `packages/room-mcp/src/tools/combined-tree.ts:44`.

   **Defect:** Carry provenance exists only in the returned preparation result and later worker record, so reuse after an intervening failure forgets it.

   **Scenario:** Worktree preparation successfully carries W1, then input linking or synchronous process creation fails before `setWorker`. The directory and branch remain. The lead changes or reverts W1 and retries that tag. The existing-worktree fast path returns no base or carried paths; the new worker record has neither. Collection falls back to the common ancestor, treating the old W1 snapshot as worker output. Reverting W1 in the lead can therefore be undone by collection, and the retry's prompt does not name its carried files as the lead's. Recreating a missing worktree from that surviving branch has the same missing provenance.

   **TRACED:** Early error returns after preparation do not roll back or persist its result; both reuse branches omit the recorded fork. The changelog acknowledges reuse behavior, but not this new loss of carry provenance and possible reapplication of reverted lead work.

   **Smallest clean fix:** Persist the immutable worker base and carry manifest before subsequent spawn steps; recover and validate them on reuse. Clean up newly prepared trees on pre-launch failures when safe, rather than silently adopting them without metadata.

6. **should-fix — A moving lead HEAD creates a snapshot from incompatible moments.** `packages/room-mcp/src/workers.ts:255`, `:256`, `:261`.

   **Defect:** Worktree creation pins one HEAD, but the later carry diff uses the moving name `HEAD`.

   **Scenario:** Preparation reads H0 and waits for worktree creation. The lead commits an existing edit as H1 during that await, leaving a different untracked file dirty. Carry diffs against H1 but applies the result to the H0 worktree. If the remaining changes are disjoint, the operation succeeds and reports a successful carry while the worker lacks H1's committed edit. A checkout/rebase during preparation creates the same mismatch. No post-snapshot HEAD check detects it.

   **TRACED:** The saved `base` is passed to worktree creation and rollback, not to `git diff`; untracked enumeration/copy happens in later steps without a coherence check.

   **Smallest clean fix:** Diff against the pinned commit and verify the lead's HEAD and selected inputs remained stable before accepting the snapshot; retry on movement. Do not silently certify a mixture of old committed state and newer dirty state.

7. **should-fix — Internal carry commits still execute repository commit hooks.** `packages/room-mcp/src/workers.ts:275`; `packages/room-mcp/src/conflicts.ts:184`.

   **Defect:** `commit --no-verify` does not suppress `prepare-commit-msg` or `post-commit` hooks.

   **Scenario:** A repository has a prepare-message hook that rewrites commit subjects, or a post-commit hook that updates files or performs an external action. Merely spawning a worker executes it for the internal snapshot. Rewriting the carry subject also makes `carriedWorkerFor` reject the snapshot, so the special contract checks quietly stop. The existing failing-pre-commit-hook test covers a different hook and cannot catch this.

   **TRACED:** The command overrides identity and signing, but not `core.hooksPath`; carry detection later requires an exact subject match. Hooks were not executed during review.

   **Smallest clean fix:** Create internal snapshots through plumbing that does not execute commit hooks, and identify them through persisted structured carry metadata rather than a mutable commit subject.

8. **should-fix — Carry copies the inputs that spawn intends to link.** `packages/room-mcp/src/tools/workers.ts:113`, `:147`; `packages/room-mcp/src/workers.ts:263`, `:200`.

   **Defect:** Link paths are resolved only after carry has populated their destinations.

   **Scenario:** `.roomlinks` lists `data/`, containing non-Git-ignored untracked input files. This previously could be linked into a fresh worker. Carry now copies and commits `data/` first. `prepareWorkerLinks` then refuses the existing destination, returning `error: could not link inputs`. The failed spawn leaves the carried branch and checkout behind. Large inputs pay the copy/commit cost before the predictable refusal.

   **TRACED:** Carry is unconditional on the fresh branch and receives no link exclusions; destination validation rejects even an ordinary directory already created by carry.

   **Smallest clean fix:** Resolve and validate the requested/default input links first, exclude them from the snapshot, then install them. Persist those exclusions with the worker's provenance.

9. **should-fix — Carry has no byte budget and blocks the MCP process while copying.** `packages/room-mcp/src/workers.ts:261`, `:264`, `:270`, `:274`.

   **Defect:** All non-ignored untracked bytes are copied synchronously and committed without a size or total-work bound.

   **Scenario:** A repository has an untracked multi-GB dataset/archive that Room's daemon would skip by extension or size. Each new worker still copies and Git-adds it. `copyFileSync` blocks the event loop serving the lead's tools and possibly its relay; concurrent worker creation multiplies disk use. The Git helper's 30-second subprocess timeout does not bound the synchronous copy loop. A count of one untracked directory hides how much work is about to happen. This is a new local copying/history cost beyond the roadmap's already-known sharing caps.

   **TRACED:** There is no preflight stat budget, chunked cancellation or carry limit. The copy loop precedes the timeout-protected Git add/commit.

   **Smallest clean fix:** Preflight total bytes and eligible file types, honor link/ignore exclusions, and use bounded asynchronous copying. Refuse or explicitly report an oversized carry before starting a worker that would otherwise have an incomplete baseline.

10. **should-fix — Team participants cannot fetch another machine's carried base.** `packages/roomd/src/index.ts:261`; `packages/room-mcp/src/tools/context.ts:302`, `:316`; `packages/room-mcp/src/tools/combined-tree.ts:37`.

   **Defect:** Team workers advertise private carried commit IDs as ordinary participant bases, but remote peers have no way to obtain those commits.

   **Scenario:** Alice, sharing a team room at full, spawns a worker from dirty code; its HEAD is private C. Bob sees the worker's presence and changed-file overlay. Bob's preview including it runs `merge-base` against C in Bob's clone and fails with “HEAD … is not in this clone; git fetch, then retry.” Fetch cannot help because C was never pushed. Reads requiring an unchanged worker base file fail similarly. Lead-side collection works because Alice shares the worktree's object database; that does not validate the teammate journey.

   **TRACED:** The provider sends the base SHA, not the Git commit graph. The shared base-text cache is not used by these Git lookup paths, and it contains only selected file texts anyway.

   **Smallest clean fix:** Represent the private carried snapshot relative to an available shared commit, with the required per-file baseline data, so remote merge/read operations do not require a private commit. Until supported, exclude such a participant from remote previews with an honest local-only-base explanation; do not prescribe an impossible fetch or require publishing private WIP.

11. **should-fix — Worker-initiated previews still count carried lead edits as worker edits.** `packages/room-mcp/src/tools/combined-tree.ts:43`, `:105`, `:109`; `packages/room-mcp/src/workers.ts:151`.

   **Defect:** The own-base adjustment applies only to merge participants, not to a worker that is the caller.

   **Scenario:** H contains line A; the lead's A1 is carried into C. The worker changes a distant line, while the lead changes A1 to A2. The lead's preview uses C for the worker delta and preserves A2. When the worker follows its prompt and previews with the lead, initialization marks A1 as the caller's change against H, then merges the lead's A2 against H. That reports a competing edit on a line the worker never changed. The worker can stall or attempt to “resolve” the lead's own progression.

   **TRACED:** `deltaBases` iterates only `participants`; caller ownership is initialized against the common ancestor. The carry acceptance preview test invokes the lead's tool only.

   **Smallest clean fix:** Normalize the computation around the destination lead's live tree and apply each worker's own-base delta regardless of who invoked the tool. Test the same scenario from both callers and require equivalent results.

12. **should-fix — Automatic merge notices disagree with carried-base collection.** `packages/room-mcp/src/conflicts.ts:65`, `:71`, `:323`.

   **Defect:** `mergePath` still merges both full versions against their common ancestor, ignoring the worker's carried delta base.

   **Scenario:** A carried file has A1; the lead changes that line to A2 and the worker edits a distant line in the same file. Both now have overlays. The automatic watcher compares H→A2 against H→A1-plus-worker-edit and posts a merge-conflict notice. Explicit lead-side preview/collection correctly compare C→worker and merge cleanly. The unsolicited warning sends people to fix a nonexistent collision.

   **TRACED:** The automatic path is a separate merge implementation and never consults `worker.base` for delta application. This is not the documented adjacent-line limitation: the worker's actual edit can be far away.

   **Smallest clean fix:** Use the same own-base delta semantics for automatic checks and explicit previews, including opposite caller directions, and deduplicate their shared verdict.

13. **should-fix — Worker graph observations attribute carried signatures to the worker.** `packages/room-mcp/src/graph-index.ts:99`, `:161`, `:167`.

   **Defect:** Observed contracts compare a worker's overlay to the room base instead of the worker's baseline.

   **Scenario:** The lead changes `def rate(x)` to `def rate(x, year)` and carries it. The worker only changes the body. Its overlay includes the carried signature; its graph announces that the worker changed `rate`'s signature. Other participants can receive a wrongly attributed contract notice and the network view credits the wrong author. The worker prompt's ownership sentence cannot repair this derived state.

   **TRACED**, with the comparison **REPRODUCED** using the real parser and `observedContractChanges`: after `ensureLanguages(['api.py'])`, comparing `def rate(x):\n    return x\n` to `def rate(x, year):\n    return x * 2\n` returns a signature change; comparing the latter to carried `def rate(x, year):\n    return x\n` returns `[]`. Run with `node --import tsx --input-type=module`, importing those functions from `packages/shared/src/graph.ts` and `packages/room-mcp/src/parse/engine.ts`.

   **Smallest clean fix:** Separate the room-wide dependency projection from per-person observed-contract baselines; compute worker observations against its recorded carry/fork base and preserve that provenance after worker commits.

14. **should-fix — The browser's merged view duplicates and misattributes carried lines.** `packages/web/src/panels.ts:735`, `:739`.

   **Defect:** The merged browser panel uses one participant's base for all versions and does not consume worker delta bases.

   **Scenario:** Lead and worker both contain a carried line, but only the worker changed a neighboring line. With the lead's original base selected, the panel credits the carried line to both people and can render competing duplicated sections. With another first participant, it can choose a different baseline. This disagrees with the corrected lead collect path.

   **REPRODUCED** with the panel's real pure classifier, via `node --import tsx --input-type=module` and `import { classifyNWay } from './packages/web/src/merged.ts'`:

   ```js
   classifyNWay('base\nkeep\n', [
     { name: 'lead', text: 'carried\nkeep\n' },
     { name: 'worker', text: 'carried\nworker\n' },
   ])
   ```

   The first `carried` line has `changedBy: ['lead', 'worker']`, `conflict: true`; a second `carried` line appears in the competing section. The panel wiring is **TRACED**; no live browser was used.

   **Smallest clean fix:** Feed the view explicit per-person baseline/provenance data and render the same combined delta result as the tools. Do not label a single-base approximation as the merged worker result.

15. **should-fix — Preview tests do not run on the bytes and modes that collect applies.** `packages/room-mcp/src/tools/combined-tree.ts:27`; `packages/room-mcp/src/tools/files.ts:214`; `packages/room-mcp/src/tools/collect.ts:184`, `:198`.

   **Defect:** Preview decodes disk files as UTF-8 and materializes text without worker executable-mode changes, while collection uses lossless byte transport and mode merging.

   **Scenario:** A worker adds a binary fixture containing `0xff`, or adds an executable `run.sh`. Collection preserves the bytes and executable bit. Preview substitutes invalid UTF-8 with replacement characters and writes a new script with ordinary non-executable permissions. Even an untouched carried binary can enter the ancestor-difference path set and be rewritten this way in the scratch tree. Tests can fail against a tree that will never be collected, or pass without validating the actual collected binary. Existing collect binary/mode tests do not check preview materialization.

   **TRACED:** Preview uses default `utf8` reads and `writeFileSync` without mode propagation; collect explicitly requests `latin1`, supplies binary-safe base reads, and merges modes separately.

   **Smallest clean fix:** Share a byte-and-mode tree representation and materializer between preview and collection. Only decode files for textual merging when valid text; preserve opaque bytes and executable metadata otherwise.

16. **should-fix — CRLF checkouts make an unchanged carried file look like a worker delta.** `packages/room-mcp/src/tools/combined-tree.ts:125`, `:131`; `packages/room-mcp/src/tools/collect.ts:189`.

   **Defect:** Collection compares raw checkout bytes to unfiltered Git blob bytes.

   **Scenario:** With `core.autocrlf=true` or equivalent attributes, the carried commit stores LF while both worktrees contain CRLF. The worker leaves carried `app.py` unchanged and edits another file; the lead changes one carried line. For `app.py`, `theirs !== b` solely because of line endings, so the supposedly empty worker delta now overlaps the lead edit and can block the whole collect. Without a competing lead edit, the same path can be falsely attributed to the worker. Other clean/smudge filters have the same representation mismatch.

   **TRACED:** `previewText` reads filesystem bytes, while the collect `baseText` callback uses `git show`; neither canonicalizes the working version through Git's clean conversion nor reconstructs base checkout bytes. Latin-1 prevents byte loss but does not make those representations equivalent. No configured CRLF fixture was executed.

   **Smallest clean fix:** Compute deltas in Git's canonical representation, then materialize with the destination's checkout conversion, or consistently obtain equivalent checkout representations for all sides. Treat filter failures explicitly.

17. **should-fix — Reverting a carried definition to HEAD produces no contract notice.** `packages/room-mcp/src/conflicts.ts:210`.

   **Defect:** Carried comparison enumerates only the lead's currently dirty paths, so a return to clean HEAD disappears from its candidate set.

   **Scenario:** HEAD has `rate(x)`, the worker carries `rate(x, year)` and writes a consumer passing two arguments. The lead restores the provider to HEAD. The daemon clears its overlay; `changedPaths(lead)` becomes empty. This is a signature change relative to the worker's actual base, but no carried comparison runs. Committing a later provider edit similarly removes the dirty-path candidate after reseeding.

   **REPRODUCED** with an in-memory `RoomDoc` and real `ConflictWatcher.checkObserved`: injected `carriedWorkerFor` returned `{base:'carry', lead:'lead'}`, `baseText` returned `def rate(x, year):\n    return x\n`, and the worker overlay was `from api import rate\ndef use(): return rate(1,2026)\n`. With a lead overlay containing a third parameter, the real method posted one notice. With no lead overlay and `liveText('api.py','lead')` returning clean `rate(x)`, it posted none. This isolates candidate selection; Git carry recognition was stubbed, not claimed as an end-to-end reproduction.

   **Smallest clean fix:** Persist/enumerate the carried provider paths as well as current dirty paths, and compare them after overlay removal and lead-base movement. An unchanged new HEAD must not erase a change relative to the worker's snapshot.

18. **should-fix — Same-file carried calls are missed for ordinary arrow functions and methods.** `packages/room-mcp/src/graph-index.ts:29`, `:35`, `:43`.

   **Defect:** The workaround for references filtered as local definitions only masks a small set of keyword-prefixed declarations.

   **Scenario:** A carried TypeScript file defines `const rate = (...) => ...` and calls it later; or a Java/TypeScript class calls one of its own methods. The lead changes that definition's signature while the worker changes the consumer in the same file. The parser removes the locally defined name from refs, and the masking regex cannot find these declaration forms, so the advertised same-file contract notice never fires.

   **REPRODUCED** using `node --import tsx --input-type=module` and the real `referencesSymbol` from `packages/room-mcp/src/graph-index.ts`:

   ```js
   await referencesSymbol('a.ts',
     'export const rate = (x: number) => x;\nexport function use() { return rate(1); }\n', 'rate') // false
   await referencesSymbol('a.java',
     'class A { int rate(int x) { return x; } int use() { return rate(1); } }', 'A.rate') // false
   await referencesSymbol('a.ts',
     'class A { rate(x: number) { return x; } use() { return this.rate(1); } }', 'A.rate') // false
   ```

   A plain TypeScript `function rate` and the tested Python method case returned true.

   **Smallest clean fix:** Preserve raw call/reference facts separately from external-only refs in parser output; use those facts for same-file consumption instead of rewriting source with a language-incomplete regex.

19. **should-fix — Carried contract checks bypass the existing import narrowing.** `packages/room-mcp/src/conflicts.ts:221`; `packages/room-mcp/src/graph-index.ts:25`.

   **Defect:** Once a worker has any carried commit, its lead-contract checks match bare symbol names without checking the provider module.

   **Scenario:** Many modules define `Config`; the worker explicitly imports it from `other.ts`. The lead changes a carried `Config` in `pricing.ts`. Ordinary graph checks can narrow the consumer to `other.ts`, but the carried path directly calls `referencesSymbol(..., 'Config')` and tells the worker that its consumer uses the pricing definition. A trivial carried README edit is enough to select this alternate algorithm for the lead's changes. This is a regression beyond the documented general absence of type resolution: explicit import evidence that the existing path uses is discarded.

   **TRACED**, with the match **REPRODUCED**: `referencesSymbol('use.ts', 'import { Config } from "./other";\nexport function use(x: Config) { return x; }\n', 'Config')` returned true. The caller supplies no provider path to distinguish `pricing.ts`.

   **Smallest clean fix:** Match carried provider/consumer pairs through the same import-narrowing rules as the normal graph, while retaining the new same-file call support and worker-relative signature comparison.

20. **should-fix — Failed default-local auto-join leaves the session disabled indefinitely.** `packages/room-mcp/src/index.ts:127`, `:130`, `:142`; `packages/room-mcp/src/index.ts:68`.

   **Defect:** Default-local startup errors are log-only, and the single failed auto-join promise is never retried.

   **Scenario:** A restarted MCP process encounters one local sync, relay, Git or initialization failure. With `startup.server === LOCAL` and no explicit room, `expected` is false, so no pending notice is delivered. The promise settles with `session === null`. Fifteen hours later, `room_spawn` merely awaits that already-finished promise and reaches the generic not-in-a-room error, including irrelevant team/create guidance. Manual local join succeeding later is fully consistent with this path.

   **TRACED:** This explains the lasting disconnection in the supplied incident, but does not identify which startup operation originally failed. The prior startup-notice fix only covered destinations considered `expected`; default local remains uncovered.

   **Smallest clean fix:** Use a single-flight local connection state with bounded retry/backoff and a safe on-demand retry before room-dependent tools. Preserve and report one actionable local failure after retries, including its phase. Never interpret this failure as permission to join/create a team room. Cancel retries on explicit leave/shutdown.

21. **should-fix — Relay discovery accepts the wrong relay as healthy.** `packages/relay/src/index.ts:159`, `:289`, `:294`, `:329`.

   **Defect:** Discovery and takeover health checks establish only that the port serves some Room relay, not that it accepts this clone's key.

   **Scenario:** A stale discovery file points to an old port now occupied by a different clone's relay, with a different key. `recorded()` adopts it even when the recorded PID is gone. WebSocket authentication rejects the stored key; the identity probe times out after 15 seconds. The two-second takeover loop keeps seeing `{local:true}` and never repairs the connection. Another example is an inconsistent discovery/key file while a relay remains alive. A transient exiting owner alone normally has a takeover path; the stronger failure is that “healthy” is not the right health test.

   **TRACED:** `/health` does not check or identify the key/common directory; the client probe sends none. PID liveness affects only the log text. This is one concrete possible startup failure, not a claim about the incident's actual stale file.

   **Smallest clean fix:** Authenticate the liveness probe with the discovery key and bind the response to the relay instance/clone. Atomically publish discovery data; on authentication/sync failure re-read discovery and re-enter the ownership election instead of repeatedly trusting the same open port.

22. **should-fix — Local join has no total deadline and waits for a serial full-tree seed.** `packages/roomd/src/index.ts:247`, `:286`, `:610`, `:751`, `:838`; `packages/room-mcp/src/session.ts:290`, `:327`, `:469`.

   **Defect:** The connection deadlines bound individual sync phases, not initialization or the tool call; join remains pending through every tracked/untracked file and watcher readiness.

   **Scenario:** In a large repository, `gitTracked` includes clean tracked files and all eligible untracked files. `seedLocalOverlay` processes them sequentially. A normal text file incurs `git show` and `gitHead`, filesystem safety checks and reads even when it is clean; oversized eligible files can incur hashing. Only afterwards does startup recursively establish the watcher and await `ready`. Watcher errors are merely logged and cannot reject that readiness promise. Every MCP call awaits auto-join, so a slow or stuck seed/watcher stalls even attempts to inspect Room. Per-Git-operation timeouts do not provide a total budget.

   **TRACED:** A cold untagged local join can first sync a throwaway identity-probe provider (15-second default), then the actual daemon provider (another independent 15-second deadline), then seed/watch with no overall deadline. Manual join additionally awaits normal join bookkeeping. Graph indexing starts only after daemon initialization and `graph.start()` is not awaited by join; it is not a direct explanation for an 86-second initial local join. A recently stopped owner is normally recoverable by the two-second relay watcher. The observed 86 seconds is compatible with seeding/watcher/Git costs, but there is no measured breakdown here and no hard-coded 86-second timer.

   **Smallest clean fix:** Seed changed paths from Git status/diff rather than spawning Git per clean tracked file, batch base reads, and do bounded cancellable initialization with phase timings. Return connected/indexing status without blocking unrelated tools on the full scan, while accurately marking coordination coverage incomplete. Reject watcher startup on error and enforce an overall startup deadline. Pair this with the local retry state in finding 20.

23. **later — A stopped relay handle can start a new listener after shutdown.** `packages/relay/src/index.ts:327`, `:329`, `:332`, `:353`.

   **Defect:** The asynchronous takeover tick checks `stopped` only before awaiting health and is not drained by `stop()`.

   **Scenario:** A non-owner begins a health probe while the owner exits. Its session then leaves or its failed join calls `local.stop()`: the timer is cleared and no owned relay exists yet, so stop returns. The probe resolves false; the already-running tick starts a relay and writes discovery despite the stopped handle. That listener is left without an active session managing its lifecycle. Overlapping ticks can also race their own shutdown.

   **TRACED:** There is no stopped/generation check after either asynchronous operation and no tracked in-flight tick to await or cancel.

   **Smallest clean fix:** Serialize takeover attempts, recheck a generation/stopped flag after awaits, close a newly acquired listener if shutdown won, and make stop drain the in-flight attempt.

## Verified fine

- `npm run typecheck` passed. `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run packages/room-mcp/test/carry-contract.test.ts` passed 7 tests. The same command form for `packages/room-mcp/test/collect.test.ts packages/room-mcp/test/retirement.test.ts packages/web/src/merged.test.ts` passed 69 tests. No socket-listening failure was counted as a pass.
- Read the requested carry acceptance tests and traced their assertions. The lead-side combined-tree path uses each recorded worker base, preserves distant lead edits to carried lines, supports different worker snapshots and includes committed worker output through disk-vs-base comparison. The selected collect tests exercised these paths, real Git state, conflict refusal, binary additions, executable modes, deletions, retained ignored artifacts and cleanup. These successes do not cover the alternate paths above.
- Carry supplies its own Git identity, disables commit signing and bypasses pre-commit/commit-msg verification. Tracked changes, staged changes reflected on disk, deletions and non-ignored untracked regular files are included; Git-ignored files and `.room/` are excluded. On a handled carry error it attempts a reset/clean or recreation and returns a failure marker. Ordinary detached HEAD is usable as a pinned spawn base; there is no inherently necessary branch-name dependency for that step.
- Explicit collection checks for an ongoing merge/rebase/cherry-pick/revert before writes, validates the worker's repository and branch, rejects symlink collection paths, preserves the lead index/history, and refuses the entire selected batch on a text conflict. These protections are stronger than the preview materializer and automatic retirement paths identified above.
- The seven carried-contract tests really parse signatures and check notices, renames, removals, Python same-file/claimed consumers, deduplication and body-only silence. They manually publish lead graph updates and dirty paths, so they do not exercise a provider becoming clean or the full daemon/graph pipeline.
- Default destination remains local; the relay binds loopback and WebSockets require its stored key. The reported failure does not involve a fallback to a hosted server. Prior fixes and open roadmap items were checked before deciding what to report; unchanged known limitations are not presented as new findings.

## Not covered

- No network, live relay socket experiment, host session, browser interaction, external authentication, actual worker model execution, push or hook execution. No access to the incident's original logs/discovery file was available; the 86-second duration is not reproduced. Source traces identify possible causes and rule out a direct awaited graph-index build, not a unique historical cause.
- No source file was changed and nothing was committed. The only review deliverable is this root `REVIEW.md`; typecheck/tests may create their normal ignored build/cache and temporary fixture files. No `~/.claude` or `~/.codex` contents were inspected or modified. The `carry-wip.test.ts` acceptance suite was read but not run because its full `createTools`/hook attachment path can fall back to scanning host session history; only the isolated suites listed above were executed.
- Sparse checkout, submodule content, LFS, CRLF/filter configurations, special filenames, live renames, lead merge/rebase transitions and huge-file performance were not fixture-tested. The CRLF finding is a representation-level source trace; no additional platform guarantee is claimed. Submodule/nested-directory preview omissions and refusal paths were read, but no end-to-end submodule carry claim is made.
- No exhaustive server/authentication audit, plugin rebuild/freshness certification, mutation testing or full repository suite. Existing carried-work tests omit the reversed preview caller, failed-spawn provenance recovery, commit-hook variants, Git conversion filters and the automatic ignored-output cleanup route; passing them does not establish those properties.
