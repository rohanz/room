# Wave 3 review — 2026-09-29

Reviewed **`git diff 5eddd26 51fa373`**, with this worktree pinned to **51fa37324ce09f51634ed4116772c96bc374ffbb**. Binding references: the redesign plan (R1–R6, D1–D5 and hub rulings), and the ledger, manifest, registry, reporooms and hub specs dated 2026-09-28. **13 Must-fix, 4 Should-fix.** Later workers' overlays are not included. This report is the only retained change; no source files were edited and no commit was made.

## Must-fix

- **M1 — Held source text leaks through the published symbol graph. Owner: readers.**
  **Locations:** `packages/room-mcp/src/graph-index.ts:203`, `:293`, `:317`, `:400`.
  The new own-file adapter reads disk for any manifest entry, including a hashless `held: scope` entry. That text supplies both the graph and `observedContractChanges`, whose signature details are then replicated in `room.graphs`. Keeping the manifest itself hashless is therefore insufficient to enforce D1's paths-only disclosure and manifest §6 row 17's invisible-contract rule.

  **Probe:** in a real temporary Git repository, `api.py` changed from `def call(public):` to `def call(public, secret_customer):`. A's declared prefixes excluded that file and its manifest contained only `{change:'M', state:'held', held:'scope', at, fence}`. Running the actual `GraphIndex.start()`/`whenIdle()` published `observed[0].detail = "was \`def call(public):\` now \`def call(public, secret_customer):\`"`. The private parameter appears in the shared document despite no shared overlay, hash or size. Keep own-disk indexing local; derive replicated graph/contract facts only from text the current publication inputs authorize. Revalidate authorization before publication and withdraw already-published derived content on narrowing.

- **M2 — An in-flight projection can republish facts after sharing has been narrowed. Owner: project.**
  **Locations:** `packages/room-mcp/src/bridge.ts:245–264`, `:279–281`, `:309–322`.
  `projectWorker` captures the policy, lead base/fence and source snapshot, awaits Git composition, then writes without validating those inputs again. A subsequent queued pass cannot undo disclosure that already reached peers. The same missing completion check admits obsolete source facts and a record that retired while composition was pending. This violates manifest invariants 1/9/16, its snapshot rule, and registry §13's prohibition on resurrecting retiring projections.

  **Probe:** wrapped the instance's real `composeFacts` method to switch its policy from `full` to `intent` after the awaited Git work and before returning. The completed production projection still had coverage `all`, level `full`, and a named entry with hash, size and base hash while `policyStore.policy.level` was `intent`. Validate one captured publication input, source `semRev`/fence and current registry ID/phase immediately before the transaction; abandon/retry stale work. Narrowing must also withdraw existing projected disclosures promptly, rather than relying on the 30-second backstop.

- **M3 — Projection does not apply the lead's complete exclusion policy. Owner: project.**
  **Locations:** `packages/room-mcp/src/bridge.ts:270–283`, `:330–377`.
  Only `facts.carried` is filtered, and only by `.roomignore` plus `defaultIgnoredPath`. Source-manifest paths bypass even those checks; carried paths bypass Git ignore rules, file-size limits and total budget. Manifest §5.5 requires carried paths to pass the lead's exclusion decision, and invariant 7 requires excluded changed paths to be digests rather than names. The projection must not disclose more than the same work would disclose under the lead's own inputs.

  **Probes:** (1) a source-shared `x` matched by the lead's `.roomignore` became a named projected entry with hash/size/baseHash and `excluded: []`; (2) a real carried commit added a 20-byte file, with the lead configured for a 4-byte file cap and 8-byte budget. Projection again published the name, hash and `size:20`, with no exclusion. Use the complete applicable exclusion decision over the composed tree before emitting names or content facts, including the carried Git-tree facts needed for shape/size checks. Do not substitute the present two-rule filter for `daemon.excludes`/the equivalent immutable input rules.

- **M4 — The local-worker claim-conflict rehearsal cannot work for ordinary fresh edits. Owner: conflicts / project.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:223–226`, `:331–350`, `:384–385`; `packages/roomd/src/disk-scan.ts:77`.
  A projected worker's own version is read from its **team projection**, which deliberately contains `held: worker` entries and no text. Its `known(hash)` only uses `git cat-file`; publishing a working file computes `git hash-object` without `-w`, so a new uncommitted blob normally is not in Git. The evaluator never reads the worker's authoritative local source or trusted worktree. Consequently it cannot map the edit against the teammate's claim, even when the lead authorizes that path. The caller-side local-source requirement in manifest §6 is missing from this evaluator.

  **Probe:** a correctly fenced W projection held the hash of `worker\n`; B claimed line 1 of base `old\n`. `reconcileProjectedConflicts` produced only `edit-in-claim / unknown / cannot map claim` and **zero worker notices**. Writing that same blob with `git hash-object -w` made the notice appear. The existing projected-conflict test supplies a `shared` W entry and team overlay, a state the real bridge never emits. Resolve an authorized projected owner's text through the source workers-room snapshot or registry-validated local adapter, verify the expected hash, and test the actual bridge-produced held entry without manually storing its blob.

- **M5 — The team claim holder's conflict notice is posted into the workers room. Owner: conflicts / project.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:128–130`, `:98–102`, `:384–385`.
  `ConflictSlots` receives `notices.post`; for projected W this is the workers-room poster. Both the W notice and the `:holder` notice addressed to teammate B use that one poster. B is in the team room and never receives its notice. Reporooms §B5 requires W's notice in the workers room and the claim holder's notification in the room where the holder participates.

  **Probe:** after making W's blob resolvable in the M4 fixture, the workers-room post spy received recipients `W, B, W, B` (initial posts plus deterministic replay), while the team poster received **zero** calls. These repeated IDs are retries, not a claim of duplicate hub acceptance. Give owner and holder notices distinct destinations, and preserve those destinations during replay. Also render the holder copy from B's perspective; copying “you edited … inside B's claim” tells B the wrong actor.

- **M6 — Excluding a still-conflicting path falsely clears its conflict. Owner: conflicts.**
  **Location:** `packages/room-mcp/src/conflict-set.ts:206–217`.
  An existing slot's path is added to candidates, but an absent named entry immediately becomes `clean` when it falls outside either changed-path set. This happens before `versionOf` can check the exclusion digest. Absence is therefore being treated as unchanged again, contrary to R4 and reporooms §B5's `excluded → unknown` rule. The caught Git-diff failure at line 207 has the same unsafe empty-set interpretation.

  **Probe:** A and B first produced a certified conflict on `x`. B then removed the named entry and published `digestPath(roomSalt, 'x')`, with complete/all coverage and an increased revision. Reconciliation changed the existing slot to **`clean`** and posted “x: the conflict with B cleared.” Nothing had established that B reverted. Resolve both sides before clearing an existing slot; exclusions and failed enumeration must retain unknown status and prior settled evidence, never certify clean.

- **M7 — A non-publisher's claims are skipped entirely. Owner: conflicts.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:197–202`, `:249`, `:331`.
  The pair-level coverage gate continues before `claims()` whenever either participant has `coverage:none`. In particular, a colocated non-publisher never contributes its claims through the publisher's version, although reporooms §B5 explicitly keeps its `claims` and `edit-in-claim` slots while excluding only its merge pair. This is a reader obligation already applicable to the current non-publisher state, not a request to implement wave-4 leases early.

  **Probe:** A had shared text; B had `coverage:{kind:'none',reason:'not-publisher'}, publisher:'A'`; both claimed the same line. The only result was `merge / * / unknown`, with **no claims slot and no notices**. Separate merge eligibility from claim evaluation, and redirect the non-publisher's file version to the recorded publisher before mapping its claims.

- **M8 — Conflict results are committed from stale snapshots after awaits. Owner: conflicts.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:172–196`, `:227–249`, `:255–372`.
  Unlike previews, `ConflictSet` never calls `snapshotStillCurrent` or otherwise rechecks `semRev` and the current holder before settling/posting. Git reads, parsing, the merge budget wait and posting all yield. A scope withdrawal, HEAD transition or holder replacement during that work can still produce a certified notice under the old inputs. Later reconciliation does not retract that notice. Manifest §6 explicitly includes conflict inputs in the snapshot/completion-check rule.

  **Probe:** injected a B downgrade to `intent` at the existing `budget()` await, after both versions had been read. The completed pass wrote a **`conflict`** slot and posted its notice although B's live coverage was already `none/intent` with a new `semRev`. Buffer evaluations, revalidate all affected snapshots and the owner's session fence before writing, retry once, and retain unknown/moved status when stability cannot be obtained. Apply the same rule to contracts and claim mapping, not only merge slots.

- **M9 — Hook claim snapshots still contain the other participant's line coordinates. Owner: conflicts / wake.**
  **Location:** `packages/room-mcp/src/hooks-bridge.ts:90–100`.
  `HooksBridge.write()` copies foreign claims' `from`/`to` directly into `state.json`. Reporooms §B6 explicitly requires these to be mapped into the caller's file, so the unchanged before-edit hook can warn on the correct lines. The mapping added to tool replies does not fix the hook path.

  **Probe:** B claimed line 1 of `old\n`; A's checkout and shared version were `inserted\nold\n`. Calling the actual writer produced `state.claims[0].from === 1`, instead of **2**. An edit to A's line 2 can therefore miss the relevant claim check. Resolve a stable owner version and the caller's disk version, map before publishing the snapshot, and use an explicitly approximate whole-file warning when the owner version is unavailable. Refresh when either side's relevant version changes.

- **M10 — Worker projectors never recover an unposted completion. Owner: project.**
  **Locations:** `packages/room-mcp/src/worker-projector.ts:24–53`, `:71–85`; `packages/room-mcp/src/worker-registry.ts:650–672`.
  The new projector writes views and retirement cleanup but never invokes the deterministic completion-posting path. Production calls remain in `room_done` and child-exit callbacks. If those encounter an outage, or the lead dies before the callback/post, a restarted projector displays terminal status without ever restoring the completion delivery. Registry §7 expressly assigns this recovery to the projector; wave 2's review deferred persistent-outage/restarted-lead recovery to this wave.

  **Probe:** used a real temporary registry, seeded a worker, recorded a witnessed failing exit, and made the initial `postObservedFailure` throw “hub unreachable.” Two subsequent production `projectWorkers` passes left `status:'failed'`, `posted` absent and **zero completion post calls**. Reconcile unposted terminal runs from durable report/exit evidence on start, registry change and reconnect, post `wk:<id>:<run>`, and persist `posted` only after hub acceptance. Keep resume-prompt acceptance (wave 4) separate from this already-required completion recovery.

- **M11 — Retirement leaves the retired owner's conflict slots behind. Owner: project / conflicts.**
  **Location:** `packages/shared/src/doc.ts:209–228`.
  The new ID-keyed retirement transaction removes the participant, manifest, overlays, receipts and view, but never removes `conflicts`. Registry §12 explicitly includes conflict slots in the compare-and-delete transaction, and reporooms §B5 permits their removal when the owner retires. A retired owner no longer has an evaluator to clean them; a later worker reusing the participant name inherits the previous worker's settled facts/epochs, whose notice IDs are keyed by name rather than worker ID.

  **Probe:** installed a W-owned conflict slot and a holder carrying `workerId:'w'`, then called the real `retireWorker('w', …)`. W's manifest disappeared while the conflict map still contained **one W-owned slot**. Delete the retired owner's slots inside the same worker-ID-checked transaction, preserving slots belonging to a newer incarnation under that name. Add the conflict map to the retirement replay/tag-reuse tests.

- **M12 — Replicated worker views are consumed without their projector fence. Owner: project.**
  **Locations:** `packages/shared/src/doc.ts:172–175`; `packages/room-mcp/src/tools/messaging.ts:53–68`; `packages/room-mcp/src/tools/scope.ts:132`.
  `workerViewOf` chooses a view by name/start time, ignoring its `fence`; the messaging reader then treats its terminal status as authoritative. Other listings consume raw `workerViews.values()` too. Registry §13 MF11 requires views from an obsolete/dead lead to read as stale/updating against the lead's live holder. Writing a fence into each view is not sufficient without this reader check.

  **Probe:** set L's current holder to `new-L`, left W's done view fenced `old-L`, and invoked the actual `room_send` handler for a question to W. It reported **“W … will not answer; its summary: old completion”** rather than a stale-view status. The same branch terminates `room_wait` and caches that terminal conclusion. Add one accepted-view reader using the lead's current live holder, route all remote classifications/listings through it, and keep the lead's trusted local registry status as the separate authoritative path.

- **M13 — A team projection masks the worker's real room for reads and previews. Owner: readers / project.**
  **Locations:** `packages/room-mcp/src/registry.ts:170–185`; `packages/room-mcp/src/tools/context.ts:169–173`; `packages/room-mcp/src/tools/files.ts:117–122`; `packages/room-mcp/src/tools/combined-tree.ts:39`.
  Adding projected manifest heads makes `Rooms.activeIn(team, W)` true. `holding(W, team)` consequently returns the team room before considering W's actual workers room. The file reader then asks `trustedWorker` using the team room key, which fails the registry's `candidate.lead.room === lead.room` capability check for a local worker. Preview additionally only considers that trusted disk path when the selected session is local. The lead therefore sees its own worker's text as held/PARTIAL despite having the authoritative local room and worktree available. Manifest §6 rows 4/14 and registry's local capability routing require the source to remain usable.

  **Probe:** constructed a lead with both rooms and W's source plus team projection; the actual `Rooms.holding('W', team)` returned **`team`**, not **`local`**. The downstream room-key mismatch and preview gate are direct code paths, not a live-host claim. Prefer the registry-owned source/joined room for the lead's own local workers; a projection is evidence for team peers, not proof that W joined the team room. Test `room_read` and preview through the normal lead tools after `Bridge.project()` has run.

## Should-fix

- **S1 — Unknown-conflict retry deadlines are written but never consulted. Owner: conflicts.**
  **Locations:** `packages/room-mcp/src/conflict-set.ts:64–67`, `:145`, `:221–222`, `:375–385`.
  `retryAt` records the specified 1/2/4/8-minute backoff, but no evaluation gate reads it. Every 60-second tick and every unrelated observed change redoes unknown pairs, including Git/remote-commit work. A bridge also creates a new `ConflictSet` each pass, resetting its merge-start budget. A missing remote commit in a busy room can therefore cause repeated expensive work instead of backing off. Honor the deadline for unchanged unknown inputs, invalidate it on relevant changes, and retain one budget/reconciler across projected-owner passes. This finding is from static control-flow inspection; no remote fetch was attempted.

- **S2 — Partial previews disappear from the ledger instead of being recorded as partial. Owner: readers.**
  **Location:** `packages/room-mcp/src/tools/files.ts:225–227`.
  The reply and `lastPreview` correctly distinguish partial runs, but the only posted preview note is behind `complete`. Manifest §6.1 requires an explicit partial-preview ledger entry, excluded from passing previews, so a PR note can explain what was and was not checked. The passing partial-tree regression test confirms no passing note, but does not assert the required partial note. Post a separate partial verdict carrying gaps/test command/result and render it without verification wording. The existing Flask-style regression passed with `complete:false`, `testsPassed:false`, `partialPassed:true`; its room had no preview note at all.

- **S3 — Unchanged projections never refresh activity or scan age. Owner: project.**
  **Locations:** `packages/room-mcp/src/bridge.ts:49–50`, `:291–311`, `:317`.
  `entryIdentity` intentionally omits `at`, but the outer `unchanged` return occurs before the loop that could copy a newer `at`. It also discards the newly calculated `scannedAt` on every semantically unchanged scan. A worker repeatedly editing a hashless out-of-area file therefore retains its original projected edit time, and a continuously reconciled projection appears arbitrarily old. Preserve stable `rev`/`semRev` while copying display timestamps and scan heartbeat; test an at-only source update and a no-content-change scan. Static finding; it does not justify moving semantic revisions for these timestamps.

- **S4 — The large-file claim fallback is labelled exact. Owner: conflicts.**
  **Locations:** `packages/shared/src/claims.ts:35`, `:61–63`.
  Above one million line-pairs, `mapRange` deliberately falls back to the whole file, but `claimInMyLines` still returns `approximate:false`. The conflict evaluator can turn that conservative fallback into a certified conflict/interrupt and tool replies omit the approximation warning. **Probe:** a 1,001-line owner file, one line inserted at the top, and a one-line claim at 500 yielded `{from:1,to:1002,approximate:false}`, although the exact mapped claim is line 501. Propagate approximation metadata, or use a bounded diff that can provide the precise mapping without the quadratic table.

## Wave-3 rehearsal and deletion assessment

- **Flask / held implementation with shared passing tests:** the focused reader regression passes. It names the held file, says PARTIAL, records `complete:false` and prevents a passing verification flag. The ledger portion remains incomplete (S2), and D1 cannot be claimed end-to-end while the graph and projection disclosures in M1–M3 remain.
- **Carried-preview false alarm:** `withheld`, `declaredNote`, `leadUsesCarriedBase` and `unchangedLead` are absent from the production reader code. The resolver's hashless-held branch cannot substitute a known blob, and preview removes gap paths before merging. The shared-core behavior supports the intended replacement, but this review did not run a native carried-worker rehearsal; local-worker source routing still has M13.
- **Local worker edits a teammate's team claim:** **not supported** for ordinary new uncommitted content (M4). Even when Git already has the blob, the holder notification is misrouted (M5). The current unit fixture's shared projected overlay does not demonstrate the real bridge path.
- **One held side produces a possible conflict:** the actual derived-slot test passes for a hashless held entry and remains stable on at-only edits. Exclusion transitions and concurrent input changes are not covered by that success (M6/M8).
- **Applicable deleted code:** the bridge's scope/policy monkey-patch and restoration path, `repairRetired`, the old worker mirror module, the old `ConflictWatcher` state sets/claim-pair observer, `SocketWakeRouter`, content-bearing wake module and HooksBridge delivery queues are removed. The retired-owner conflict cleanup is incomplete (M11). Legacy overlay/deleted helpers still in `RoomDoc` are explicitly assigned to manifest step 6; web readers, epoch/name/publisher enforcement, host-presence expiry and resume acceptance are later-wave work and were not reported merely for remaining here.
- **Wake/cursor:** the inspected path uses a content-free pointer, integer frontier and integer launch `busFrontier`; successful waking writes `wakes.json`, not a receipt. Focused tests support batching, retries, reservations, frontier persistence and higher hub incarnations. This is not a live Codex/Claude wake rehearsal.

## Validation and limits

- First focused Vitest run: **27 passed in 7 files** — `conflict-set`, `manifest-preview`, `reader-manifest-guard`, `ledger-cursor`, `worker-projector`, `lead-bridge`, and shared `claims-across-bases`. The command also named the removed `wake.test.ts`, which contributed no tests.
- Second focused run: **47 passed, 2 failed in 5 files** — `socket-wake`, `bridge`, `graph-index-events`, `ledger-cursor`, and shared `retired-worker`. Both failures were solely `listen EPERM` while creating the test's Unix sockets. The named removed shared `retirement.test.ts` contributed no tests. The three cursor tests ran twice; across both runs **71 distinct tests passed**, plus those two sandbox-blocked cases.
- Additional temporary tsx probes used real Git repositories, an actual worker registry, real graph parsing, in-memory Room documents, production handlers/projectors, post spies, and instance-level await seams. They reproduced the outputs described above. The final probe run completed successfully; setup errors in earlier attempts were corrected before counting evidence. Harnesses and their temporary repositories were deleted after inspection.
- Validation used at most two Vitest workers, with heavy commands staggered and file watching set to polling. `nice -n 10` was requested; the sandbox refused `setpriority`. No source edits, full-suite run, typecheck, build, plugin rebuild, host launch, external message delivery or socket rehearsal is claimed. Both this worktree and the shared dependency checkout were at clean `51fa373` during the probes; live peer overlays were not substituted for the reviewed code.
- Finish preview: `room_preview_merge(people=["rohanz"])` reported **no conflicts**, zero peer paths applied and this report as the one local-only path, against common ancestor `51fa373`. No combined-code tests were run. Final Git status contains only this new report.
