# Whole-redesign review: sharing and readers — 2026-09-29

Reviewed `git diff 8097a8b c449f3e`, with the worktree pinned to `c449f3ec5d42d030109a5145da0d00a192eb59a8`. **6 Must-fix; 2 Should-fix.** Scope: sharing policy/publication, manifests and their consumers, bases, conflict derivation, worker projection, previews and the web readers. Bindings: the 2026-09-28 redesign plan, manifest and reporooms specs, prior reviews, and the wave-3 rehearsal including its rerun. No source changes, commits or pushes; this report is the only retained file.

## Must-fix

### M1 — Claims disclose content hashes outside the text-authorized area

**Owner: sharing / claims / projection. Locations:** `packages/room-mcp/src/tools/claims.ts:58`, `:60`; `packages/roomd/src/reanchor.ts:7`; `packages/room-mcp/src/bridge.ts:438`, `:452`.

`room_claim` hashes the selected disk lines and stores `claimedHash` without consulting the sharing policy. A claim does not add a text grant. Thus a participant at declared sharing can claim an out-of-area one-line configuration file and publish exactly the guessing oracle D1 forbids. The bridge also copies that digest into the team-room claim without applying the lead's authorization. Narrowing an existing grant does not scrub claim hashes.

**Probe:** called the real claim handler with A at `declared`, no text prefixes, B scoped to `secret.txt`, and A's disk containing `SECRET_CUSTOMER=alpha`. The resulting replicated claim contained `claimedHash: fad493138a7173a6940696d76c3465e530682087d31b03f91836a0af453a001c`, equal to the digest of the guessed line; the claim succeeded without granting text permission.

**Fix:** retain private re-anchoring evidence locally; replicate a digest only where the current policy authorizes that path, and withdraw it on narrowing. Apply the lead's policy to mirrored claims too. Preserve reporooms §B6 through readable owner versions; unavailable versions must map approximately and yield possible rather than certified overlap. Reconcile manifest §6's local-source “claim digest” wording with invariant 16. Rohanz explicitly confirmed during this review that claims have **no D1 exemption** and requested this finding.

### M2 — Graph withdrawal waits behind the normal publication throttle

**Owner: readers / graph publication. Locations:** `packages/room-mcp/src/graph-index.ts:123`, `:466–474`.

After a full-sharing graph publishes an observed signature, narrowing to declared correctly removes the manifest hash/text and queues graph refreshes. However, replacing the replicated graph still obeys the ordinary 20-second throttle when its status remains `ready`. `room_share` does not await this withdrawal. A peer joining during that interval receives the out-of-area signature through `graphs`, although the current manifest is already hashless. This is a remaining withdrawal boundary, not a repeat of the repaired stable-held indexing or holder-change race.

**Probe:** published `def call(secret_customer)` using the real GraphIndex with the production 20-second interval, then changed the manifest to a hashless held entry with an empty declared area. After `whenIdle()` and another 250 ms, the replicated graph still contained `secret_customer`. The existing narrowing regression sets `minPublishMs: 0`, so it does not exercise this behavior.

**Fix:** synchronously remove or sanitize the owner's replicated derived content when authorization narrows; throttling may govern later additions, never withdrawal. Fence any rebuilt snapshot to the current policy/manifest. Test the default throttle and a new reader connecting after narrowing.

### M3 — Contract slots bypass manifest visibility and falsely clear when observations disappear

**Owner: readers / conflicts. Locations:** `packages/room-mcp/src/conflict-set.ts:302`, `:390–394`, `:439–451`.

For ordinary peers, `contracts()` trusts `graphs[other].observed` and edges without resolving the provider's current version or tying the graph to its manifest revision/fence. It also runs before the pair's completeness gate. Consequently an old graph can produce a certified contract conflict and copy its signature detail into a new slot/notice after the provider becomes hashless held. When the graph finally removes that observation, every missing contract key becomes `clean`, even though the provider remains unreadable. Reporooms invariant 7 requires readable evidence for certification and a clean evaluation before clearing; disappearance from the candidate set is insufficient.

**Probes:** (1) B had a current hashless held `x.py` and an old graph containing a signature change. Reconciliation created a `contract/conflict` slot with `why: "now secret_customer"` and a notify message, while its merge slot correctly said `possible`. (2) Starting from a real contract conflict, narrowing B and removing its graph observation changed the contract slot to `clean`/`settled: clean` without reading B's version.

**Fix:** validate the graph's source revision and resolve all contract inputs under the same snapshot rules as merge inputs. Held, excluded, incomplete, missing or stale graph coverage must produce unknown/possible, preserve prior settled evidence, and never emit a certified clear. Do not retain or newly copy restricted signature content into slots after narrowing. Cover both stale-observation and observation-removal transitions, including the carried branch's similar cleanup loop.

### M4 — Base text is still read and stored under HEAD instead of the manifest anchor

**Owner: publication / bases / web. Locations:** `packages/roomd/src/publisher.ts:173`, `:223–225`; `packages/roomd/src/index.ts:856–857`; consumers `packages/web/src/panels.ts:765–766`, `:798–802`.

The manifest uses `inputs.head`, the resolved participant anchor, but base-text reads, storage keys and cleanup use `host.shared`. The surviving `refreshShared()` sets that value to local HEAD, or the old carried-parent special case. In a team room with unpushed commits, these differ. The browser asks for base text under the manifest anchor and finds none, although the publisher has stored a different revision's contents. It cannot show the proper diff or merge even for an otherwise fully shared modification. This also affects a local worker after HEAD advances beyond its pinned base.

**Probe:** created anchor B and an unpushed commit H modifying `x.py`, then ran real Publisher reconciliation with the production-shaped `shared=H`, `inputs.head=B`. The manifest described a modification against B, but `basetextFlat` held H's modified text under `A\0H:x.py`; `baseText(A, B, x.py)` was undefined.

**Fix:** prepare, write and retain base text against the captured manifest base in the same publication transaction. Keep any carried-untracked baseline adapter explicit. Remove `refreshShared` and its parallel base authority as reporooms §B3 requires. Add a daemon-to-web test with an unpushed commit and a worker whose HEAD has advanced beyond C.

### M5 — A worker branch rename drops its registry-pinned base and hides committed work from projection

**Owner: publication / bases / projection. Locations:** `packages/roomd/src/index.ts:842–853`; `packages/room-mcp/src/bridge.ts:262`, `:385–399`.

`localCarriedBase()` only returns the registry base while the branch spelling is `room/<label>`. A worker that commits a change and renames or switches its branch therefore moves its manifest base to HEAD and removes the committed change from its entries. The bridge still composes those entries as a delta against `record.base` C, without checking that `sourceHead.base === C`. It can consequently publish complete coverage while omitting that work. Manifest §5.5 pins C for the worktree's lifetime, and reporooms permits branch changes without changing room identity.

**Probe:** a real daemon with a numeric lease fence and injected in-memory provider started on `room/w`, registry base C. After a worker commit H, its manifest correctly retained base C and `x.py`. Running `git branch -m feature` and the production queued HEAD poll changed its head to `{base:H, complete:true, coverage:all}` with **zero entries**, while the registry base remained C. The bridge omission follows directly from composing B..C plus that empty source map.

**Fix:** derive worker identity/baseline from the trusted registry record, independently of branch spelling and current HEAD. Also remove `carried()`'s `baseline.sha === this.base` expiry, which discards carried-untracked baseline facts after a commit. Require projection's source baseline to match the baseline being composed, otherwise publish incomplete coverage. Test commit, branch rename/switch, restart and carried-untracked deletion across a commit.

### M6 — Skipped changed disk paths can still yield a passing complete preview

**Owner: readers / preview. Locations:** `packages/room-mcp/src/tools/combined-tree.ts:179–183`, `:328`; `packages/room-mcp/src/tools/files.ts:260–263`.

The builder removes unsafe symlink and directory/nested-repository candidates and adds only `ignoredNotes`. These omissions never enter `gaps`, so `complete = gaps.length === 0` remains true. The caller is read through disk and has no manifest coverage block to catch its excluded changes. A scratch run therefore tests ancestor content in place of the omitted change and can record `testsPassed:true` plus a passing-preview ledger note, contrary to manifest invariant 14/§6.1.

**Probe:** replaced A's tracked `x.py` with a symlink outside its checkout, with B unchanged at the same base. The real builder returned `paths:[]`, `gaps:[]`, `complete:true` while printing `NOT previewed (symlink leaving the worktree, A): x.py`. The actual `room_preview_merge(person=B, run="test ! -L x.py && echo 1 passed")` path recorded `lastPreview.complete:true` and `testsPassed:true`: that assertion succeeds on the substituted ancestor file and would fail on A's changed symlink.

**Fix:** every omitted changed candidate must contribute a named or participant-level gap, including caller and trusted-worker disk sources. Propagate that verdict through zero-path returns, scratch runs, `lastPreview` and ledger notes. Ordinary ignored dependency directories need not count merely because they exist; distinguish them from an actual changed candidate that was removed.

## Should-fix

### S1 — Preview never attempts the specified anchor fetch

**Owner: readers / preview / bases. Locations:** `packages/room-mcp/src/tools/files.ts:174–182`; `packages/room-mcp/src/tools/combined-tree.ts:116–121`.

Both automatic selection and the explicit combined-tree fold call `git merge-base` directly. Neither invokes `ensureCommit`, although reporooms §B7 explicitly requires it. A peer's newly pushed, reachable anchor is skipped or causes “git fetch, then retry” simply because the caller has not fetched yet; the conflict evaluator already has the shared resolver needed to recover.

**Probe:** cloned a temporary repository, then committed a new B anchor in the clone's local-file origin. Explicit combined-tree preview failed with the manual-fetch message. Calling production `ensureCommit(clone, 'origin', B)` succeeded without changing the checkout; the unchanged preview then completed successfully.

**Fix:** use accepted participant facts and the reader's room remote to run bounded, rate-limited `ensureCommit` before overlap enumeration and ancestor folding; respect `ROOM_AUTO_FETCH=0`. Preserve the specified default-skip versus explicit-failure behavior only after resolution fails. The same §B7 path also lacks its promised 2,000 committed-path bound; add explicit partial/truncation reporting when bounding that enumeration.

### S2 — Missing room salt silently disables exclusion certification

**Owner: shared manifest readers; cross-area initialization boundary. Location:** `packages/shared/src/manifest.ts:129–132`.

With a complete, correctly fenced, all-coverage head containing exclusion digests, `versionOf()` simply skips the exclusion check when `snap.roomSalt` is absent and returns `base`. The ordinary creator should always supply the salt, but this reader converts an invalid/incomplete document into a positive equality assertion rather than failing closed. It violates R4's requirement to establish non-membership before certifying absence.

**Probe:** created an accepted head with the digest for `secret`, removed only `meta.roomSalt`, and resolved `secret`. The real resolver returned `{kind:'base', text:'base'}`. No malicious writer or socket was needed for this boundary probe; it is not evidence that normal room creation routinely loses its salt.

**Fix:** validate the salt before certifying any absent path and return an explicit unknown/updating result if it is missing or invalid. Keep creator/admission validation as a second boundary; do not let readers regenerate a salt over existing digests. Cover absent and malformed salt in both Node and browser adapters.

## Checks and limits

- **125 checked-in tests passed across 14 suites:** shared manifest, cross-base claims and compatibility deletion; roomd policy publication/regressions, base resolution and pushed-pending; MCP policy store, manifest preview, conflict set, graph events, bridge and worker projector; web manifest reader. Worktree-specific aliases prevented imports from resolving to the lead's source checkout. Jobs used one Vitest worker and polling. `nice -n 10` was attempted, but the sandbox denied `setpriority`.
- **Nine disposable probes** exercised the production classes/handlers with temporary Git repositories and in-memory documents/providers. They reproduced the findings above; the contract item has two independent cases. Their assertions deliberately confirm the observed incorrect behavior, not correctness. Temporary scripts, configurations, evidence files and repositories were removed. No listening sockets, live host launches, external network fetches, full build or deployment were used.
- **Prior fixes retained:** checked current-incarnation entry filtering and completion guards; hashless held resolution; exclusion-before-deletion and error/incomplete publication; durable grant settlement; same-transaction git/claims/manifest transitions; pushed acceptance; projection policy/source/retirement guards and carried-mode exclusions; projected-owner text and notice destinations; non-publisher claims; possible-conflict labels; zero-path partial-ledger recording; and the git-less missing-base-text adapter. Passing tests cover their asserted cases, not every live interleaving. Resolved findings are not counted again. M2 and M3 identify additional graph/contract boundaries beyond the earlier fixes.
- **Deletion audit:** the production `withheld` reader, `setShare`, `sharingGeneration`, old retention module/backoff machinery, bridge policy monkey-patch, old conflict watcher, overlay-based `changedPaths`/`whoChanged`/deleted compatibility APIs, and `meta.base` reads are gone. The still-active `refreshShared` authority and carried lifetime checks are **not** gone; M4/M5 describe their concrete consequences. Legacy base-text fallback accessors (`basetext`, `basetextByPerson`) also remain in `shared/src/doc.ts:245–261`; no additional reachable schema-2 failure from those fallback roots was established, so they are not a separate defect count. The rehearsal's local carried-base disclosure was explicitly accepted by the lead in the earlier review and is not re-reported.
- **Room finish preview:** `room_preview_merge(people=["rohanz"])` reported no conflicts against `c449f3ec5d`, with the other two review reports on the lead's side and this report on mine. No combined-code test was needed for these report-only changes. Final working-tree status contains only this review file.
