# Worker checkout ownership: retain in place on uncertainty

Recovery-ref creation and lifetime were revised on 2026-11-12; see
[recovery ref retention](2026-11-12-recovery-ref-retention.md). The historical
permanent-pin policy below is superseded; checkout ownership guarantees remain.

Revised 2026-11-11 after independent review of b6f0cb2c. The review is preserved
unchanged in [worker-checkout-ownership-review.md](2026-11-11-worker-checkout-ownership-review.md)
(from d12a1d04). It reproduced empty-root adoption, symbolic-ref target deletion
and cleanup-time adoption of a foreign branch tip. This design replaces the
capture engine; it does not claim atomic protection against every external Git
operation.

## Creation and identity

Keep ordinary worktrees at `.room/workers/<tag>` and worker records at `v:1`.
The existing `dir=` refusals and tag-in-use precedence remain. A supplied or
borrowed directory never gains destruction authority.

Before attachment, Room creates the final root with exclusive **non-recursive**
`mkdir`. EEXIST refuses even an empty directory. Record device, inode and birth
time from that directory before `git worktree add`, and require the post-add root
to match. Git's willingness to populate an existing empty directory is not a
creation receipt. Parent `.room` directories are not owned merely by their names.

Immediately after Room's successful add, synchronously write its existing
`room-preparation.json` marker in Git's per-worktree admin directory. It binds
worker ID, creation-attempt nonce, token, exact admin path/device/inode, root
identity, branch and original branch OID. No asynchronous work intervenes between
add completion and witness creation. Preserve this evidence through preparation,
active/kept workers, collection, discard and restart. Optional fields in the
existing preparation journal carry it; there is no record-version migration.

New intents require identity from the start. Promotion checks the original root
and marker before recording `prepared`; launch checks them again. Changing an
intent/preparing record to collecting/discarding must not erase its unfinished
origin and grant legacy authority. Missing, malformed or mismatched new evidence
retains the checkout. Restart never creates a missing marker to adopt a partial
checkout. A crash before a durable root/add/witness receipt may leak an empty
root or branch; that is reported rather than guessed away.

## Removal and refs

One verification policy precedes worker checkout/registration cleanup: match the
local record, marker, root identity, reciprocal gitfile/admin backlink, repository
and symbolic branch. Verify immediately before the destructive Git call, with no
await in between. On missing, changed, unreadable or user-locked evidence, retain
in place and report. Existing process, nested-worker, borrower, ignored-output
and recovery-patch rules remain additional requirements. `force` cannot waive
ownership. Do not reconstruct a base or restore carried files into a public path
after failed cleanup: that path may already belong to another checkout.

The policy covers preparation rollback, retry/fallback, prepare-finish, restarted
preparation/discard replay, explicit collect/discard of every phase, pending/kept
cleanup, ancestor discard and minute/hourly retirement. Temporary discard-patch
verification worktrees receive their own root receipt and marker; failed cleanup
retains their containing scratch directory. An empty public parent directory is
not removed without a creation receipt. Dependency setup deletes no output on failure or timeout, including empty
directories. There are no dependency cleanup receipts, identity records, rmdir or
leaf-unlink operations. Attempted container paths are kept only for diagnostics.
Setup refuses every existing install before writing any output; only an absent
or caches-only node_modules root is eligible. All children are created exclusively.
A partial install is retained, and the reply explains that inspecting and deleting
its node_modules (or discarding the worker) permits a fresh setup. Owned-worktree discard
or collect remains responsible for removing a failed worker checkout. Existing scratch folders without
a current-process creation receipt are retained and saving there is skipped;
needed scratch output can be copied explicitly. Scratch receipts are bounded
in-memory facts, so a restart deliberately makes old scratch roots uncertain. Ordinary private index/merge temporary
files do not gain checkout authority.

Branch deletion uses one exact-name, non-dereferencing Git ref transaction:

```
start
option no-deref
update refs/room/recovery/<tag>/<sha> <sha> <sha>
delete refs/heads/room/<tag> <sha>
prepare
commit
```

At collect/discard or established-retirement admission, Room captures the direct
branch tip once under the worker operation lease. Operation admission and merge preflight do not create pins
or change the worker record. Once cleanup has begun, a recovery pin can remain
after a later refusal or failure. Before worker cleanup deletes a checkout,
registration or branch, it creates or verifies `refs/room/recovery/<tag>/<sha>`
for that captured tip. An explicit keep does not attempt checkout/branch cleanup.
Discard records the receipt in its ordinary v1 phase transition for crash replay;
restarted discard reuses it. Collection keeps the capture in its operation lease
without adding fields to a kept record. The actual branch expectation never comes
from a second cleanup-time observation.

Existing symbolic, dangling or conflicting recovery names refuse. The final
transaction conditionally writes the same pin OID as a direct ref and deletes
only the captured branch OID. This closes the separate pin-check/delete race.
On Git 2.45.2, `verify <pin> <OID>` with `--no-deref` still accepts a symbolic
pin resolving to that OID, and `symref-verify` is unavailable. The conditional
same-OID update materializes an intervening same-value symbolic replacement
without following or writing its target. Different-value or dangling races fail
the transaction and retain/report the branch. These behaviors were established
in a temporary real-Git experiment and the committed reviewer tests.

The original review required provenance, and rejected adopting a foreign branch
tip as deletion authority. The lead explicitly changed that contract to current-tip
content preservation: a foreign tip already present at admission may lose that
branch name only after its exact commit is safely pinned. This is a changed
policy, not restoration of the original provenance guarantee. It preserves the
captured tip and reachable ancestry; abandoned worktree-only reflog history is
not covered. Ordinary worker commits, collect/discard and keep then plain collect
remove the branch and permit immediate tag reuse.

Recovery refs have **no automatic expiry today**. Discard also saves its existing
recovery patch; reconciliation removes patches at least seven days old only once
their worker is retired. Active-worker patches remain. These retention rules are
unchanged.

Exceptional retention covers unreadable/symbolic initial refs, a name appearing
after initial absence, failed/conflicting or subsequently missing recovery pins,
and CAS failure or a Git lock/I/O failure. A missing checkout still retains commits
absent from the lead's HEAD under the existing rule. Intentional keep, unresolved
ownership, live users/processes and uncopied work still retain their checkout and
branch under the ordinary lifecycle rules.

Preparation that never ran has no such operation-time read. Its rollback still
uses only Room's recorded creation base or authorized carry tip. Carry obtains
its exact OID from `commit-tree` and conditionally writes from its prior known
OID. Unknown or changed preparation expectations retain the branch. Private
carry/collection/borrower refs use create-only writes or an ID-bound recorded
expectation for replacements;
missing borrower source pins never generate target deletions.

The v0.17.47 mutable private names are `refs/room/carry/<tag>`,
`refs/room/carry-untracked/<tag>`, `refs/room/collect-head/<tag>/<id>` and
`refs/room/collect-base/<tag>/<id>`. Old records have no ref-write receipts.
For these names only, a pre-change record supplies its stored `carriedBase`
or kept `base` when available, and a disagreement retains/reports the ref.
Old keeps clear the carried fields and do not store the previous delta OID.
Where that old record no longer holds the expectation, read the direct private
ref once under its operation lease, preserve its object under the same permanent
recovery namespace, then atomically verify the pin while replacing/deleting only
that exact name/value. This also preserves untracked tree objects, not only
commits. A later move or failed pin write retains/reports the private ref.
New identity-required records never take this compatibility path. The existing
`refs/room/recovery/<tag>/<oid>` names are never cleanup candidates.

Public empty parent
directories are left routinely and are no longer attempted cleanup candidates;
normal cleanup does not emit a retained-item warning for those parents.

## Missing/stale registrations and compatibility

Never run a global prune during spawn preparation or remove a stale registration
through its reusable checkout path. Find its own admin entry, require a verified
Room marker of this repository, and require the record to be ended or genuinely
absent in a complete registry inventory. Recheck that admin identity immediately
before removing just its metadata. Foreign, unmarked, locked or unreadable entries
remain; the refusal names the admin/path and quotes the exact `git -C <lead>
worktree remove <path>` command for the user to run only after confirming absence.
Forced add is rejected: experiments show it erases the old admin marker, and
`-b` can create a branch even when attachment fails. Ambiguous failed creations
therefore retain and report their remaining branch/root/registration.

Pre-change established records remain collectable/discardable when all recorded
facts match: local registry authority, owning status, proper lead lineage and
canonical root, repository, reciprocal registered admin, branch and any genuine
marker or other identity facts available. A mismatching existing marker is never
ignored. Markerless intent/preparing records are not established legacy workers.
New required-identity records cannot fall back to legacy verification.

Retained-item diagnostics live separately under the registry, without a new worker
record version, quarantine, moves or capture accounting. The retaining tool reply,
`room_state` and `room_state(check=true)` name the retained items and reasons.
Diagnostics survive record retirement and restart; items stop being listed only
when actually absent. Writer GC reclaims only confirmed-absent diagnostics and
ref-write receipts; retained content and permanent recovery refs never age out. Existing v0.17.47
readers can still read v1 worker records; old binaries do not enforce these new
checks, so restarting onto the new code is necessary for its protections.

## Limits and rejected alternatives

Six original sequences (1, 2, 3, 5, 6, 7) become ordinary preservation tests.
Sequence 4 remains an expected failure: a different process can replace a
checkout/admin after the final verification and before removal. Synchronous
adjacent checks shorten that window; they do not close it.

Four lead-approved boundaries also remain: same-name branch deletion/recreation
at the same OID (CAS cannot detect ABA); indistinguishable same-path/same-branch
replacements of pre-change established records; replacement of Room's own just-added path on its own branch before initial
witnessing; and an **empty** replacement at Room's reserved path between its own
successful exclusive mkdir and first root identity read. The last case is not
atomic identity proof: mkdir returns no handle. The lead accepts it because that
empty root contains no foreign content before Room fills it. A pre-existing
directory at mkdir still refuses, and a nonempty replacement before add fails
without deleting its files. The post-add impersonation boundary starts **after
successful add**; it does not excuse unrelated branches or later replacement.

This is accidental-concurrency protection, not a same-user security boundary.
Forged/copied private evidence, inode generation reuse beyond observable platform
identity, unsupported storage semantics and power-loss durability are not claimed
solved. Uncertain identity/persistence must retain rather than authorize cleanup.
The existing native-Windows descendant-process-inspection limitation remains.

The capture engine is rejected: two moves are not one transaction; it can strand
healthy/foreign roots, hide admins from Git enumeration, break relative
`commondir`, require durable multi-object recovery and downgrade policy, and block
clones behind unproven capture budgets. A v2 record would be quarantined and aged
away by an old binary. Portable retain-in-place checks avoid those new failures.
Native helpers and symlink/junction checkout-layout changes are also rejected.

Direct preview lifecycle is explicitly outside this change. Its original
`tools/files.ts:1021` worktree removal, `:1022` global prune and `:1026` partial
recursive deletion still infer ownership from preview paths/registration. Legacy
migration, orphan/clone cleanup, setup/reset failure and LRU eviction reach them
at `:1074`, `:1097`, `:1182`, `:1319`, `:1448`, `:1484` (ebd49225 locations).
Worker cleanup's `removePreviewCache` calls can reach the same prune. They remain
because otherwise retired-worker caches can persist indefinitely without another
preview: the cache's orphan/LRU cleanup runs on demand and local-state GC does not
own `room-preview`. Follow-up must add creation receipts/markers, exact-admin
checks and retain/report there, and replace the global prune; no claim of complete
repository-wide ownership safety is made until that follow-up lands.

## Verification

Tests first reproduced empty-root adoption, different-tip deletion, missing-source
borrower-pin deletion, markerless intent/preparing discard, late promotion and the
foreign stale-registration behavior. Add root-receipt replacement, copied-gitfile,
non-dereferencing symref, restart, retained-report, legacy compatibility and
preview-cache-reclamation coverage. Keep the real verification/removal race as
the single original expected failure; retain a separate expected failure for the
accepted empty mkdir/identity-observation boundary. Use focused Vitest runs, typecheck and knip;
the lead owns full integrated/release checks and supported-platform validation.

Corrected rule C first reproduced six real-tool failures on the creation-only
expectation policy. Collect and discard now test committed-worker tag reuse,
keep then plain collect, late branch movement with both commits preserved,
symbolic refs and failed recovery-pin writes. Normal reuse also exercises the
default carry path. Existing assertions that required manual branch removal were
restored to branch-gone/tag-reusable expectations.

Validation environment: macOS arm64, Git 2.45.2, Node 22.23.4 and Vitest 5.
The reported full-suite failures were first reproduced across all 18 named files.
Focused repairs cover optional reporting contexts, unchanged keep-record shape,
shared private initialization, real creation evidence in fixtures, borrower marker
ownership and canonical registry paths. Six wake failures were sandbox loopback
`EPERM`; the unchanged 25-test file passes with approved loopback access.
The 5,000-file preview case passes serially in the quiet window. The separate
preview event-loop responsiveness case belongs to the gate worker and is excluded
from this worker's package run. Typecheck, knip and whitespace checks pass.

Legacy upgrade tests first reproduced carry refresh and kept-anchor failures.
Real-tool refresh/collect/cleanup/tag-reuse tests now cover carried untracked
objects and twice-kept delta pins, plus known-value disagreement, late private-ref
movement and refusal to grant new records legacy authority. Native Windows,
cross-volume and power-loss behavior have not been validated here. The lead owns
supported-platform, bundled-plugin and integrated release validation; this brief
explicitly excludes edits to the generated bundle and hooks.json.

The [implementation review of c7c2620c](2026-11-11-worker-checkout-ownership-implementation-review.md) is preserved unchanged alongside this design.
Its newly introduced pin race, registry re-entry deadlock and resolved-metadata
growth have ordinary passing regressions on the corrected implementation.
The R2 correction removed leaf tracking, but R3 below also removes the remaining
directory receipt and deletion mechanism entirely. Three pre-existing v0.17.47 file-level
omissions remain expressly deferred by the lead: scratch refresh within a matching
root, blind tag-sidecar deletion, and artifact rm-before-write replacement. Their
reviewer tests are documented expected failures; reference.md names the exact
historical sites. This does not expand the checkout/admin check-use exception.

Final package validation (2026-11-12 SGT), with no concurrent heavy job:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER TEST_SCALE=1 \
  ./node_modules/.bin/vitest run packages/room-mcp/test packages/relay/test \
  --maxWorkers=3 \
  -t '^(?!.*keeps the event loop responsive throughout a preview with a check)'
```

Result: **301 files passed, one skipped; 4,009 ordinary passes, five expected
failures, 18 skips and one todo; 1,154.35 seconds**. The sole explicitly excluded
test is the lead-owned preview event-loop case. All 18 originally reported failing
files were attempted before repairs and are included in this complete run.
Typecheck, knip and whitespace checks pass. An intermediate full run exposed
three stale race hooks after the ref API changed: the fixture now hooks the
record-aware writer at the same post-publication checkpoint. Assertions remain
unchanged; its complete three collection files passed all 149 tests before this
final package run. Both independent review documents match their original Git
blobs byte for byte.

| Expected failure | Remaining limit | v0.17.47 status |
|---|---|---|
| `does not remove a foreign replacement between witness verification and Git removal` | Checkout/admin verification and removal are not atomic. | Existing original sequence 4. |
| `refuses a foreign root swapped after mkdir succeeds but before the first identity read` | Accepted empty mkdir/first-stat window; mkdir returns no handle. | This exclusive reservation checkpoint is new; v0.17.47 had the broader pre-existing-empty-root adoption problem. |
| `review: an unowned replacement log is not erased merely by its worker tag` | No sidecar generation receipt. | Existing `worker-git.ts:605` deletion. |
| `review: artifact regeneration does not overwrite a foreign replacement file` | Existing file removed before exclusive write. | Existing `worker-artifacts.ts:36` behavior. |
| `review: repeated scratch saving preserves foreign children of its unchanged owned root` | Matching-root refresh still recursively replaces children. | Existing recursive scratch refresh. |

## R2 attempt: remove dependency leaf rollback receipts (superseded by R3)

The receipt added in 4d1ff6cc for each `.bin` file/link served only rollback
cleanup. It was intended to answer implementation-review finding 4: preserving a
replaced package child or a newly added `.bin` child instead of deleting their
unchanged parent recursively. No other operation consumed those receipts.

R2 reproduced a regression: after copying a shim, a replacement `.bin` ancestor
redirected `lstat(target)` to a pre-existing outside file. Rollback then unlinked
that outside file using the identity it had just observed. The whole original
R2 file reproduced 11 passes and this one failure on 4d1ff6cc.

Remove the mechanism: no `.bin` leaf receipt, no package-symlink leaf receipt,
and no dependency rollback `unlink`. Keep only existing directory identities
and nonrecursive `rmdir` of verified empty directories. All nonempty or changed
output remains and is named in the result and retained-item record, with an
inspection/removal step before retry. The previous finding 4 remains covered by
ordinary preservation tests: retained children prevent their parents' removal.
`COPYFILE_EXCL` remains a separate refusal to overwrite an existing copy target;
it is not a rollback receipt.

The lead explicitly corrected the R2 local-replacement characterization: the
shim must now remain and its parent path must be reported. Only that assertion
and its explanatory comment changed from c526d64e; no other R2 assertion changed.
Separate real-worker tests cover both local replacement and foreign-parent
replacement, followed by force discard and immediate tag reuse, with the outside
file preserved throughout. Three older dependency tests now expect reported
partial output after timeout/unreadable input; retry removes only fixture-owned
partial output explicitly, leaving pre-existing caches intact.

Audit of additions in 4d1ff6cc:

| Site | Same shape and disposition |
|---|---|
| `worker-deps.ts`, `.bin` copy then `remember(target)` then rollback `unlink` | Newly introduced public leaf adoption; removed. |
| `worker-deps.ts`, package `link` then `remember(at)` and the same rollback loop | Package receipts predated 4d1ff6cc, but its new unlink branch used them too; all dependency leaf receipt/unlink behavior removed. |
| `worker-metadata-gc.ts`, `collectResolvedWorkerMetadata` | New private JSON lstat/read/validate/reread/unlink path. Parent symlinks are refused at inspection, but path ancestry is not held atomically until unlink. This remains within the documented private-evidence trust/check-use boundary; it does not record public leaf creation or remove retained content. |
| `worker-refs.ts`, `clearRefReceipt` | New private JSON read/owner-check/reread/unlink path, with the same private ancestor/check-use limitation. It removes bookkeeping only, never the object/ref described by that receipt. |
| `worker-refs.ts`, `rememberRefWrite` | Receipt follows Room's own successful Git mutation, not an observed filesystem leaf; ref mutation uses exact-name CAS/pin transaction. No new public leaf unlink path. |

No other new public lstat/record/unlink site was found in that commit. The shared
private directory initializer adds no deletion; its descriptor-based POSIX chmod
check predates 4d1ff6cc. The preparation helper changed only missing-path
canonicalization, leaving its already documented checkout/admin check-use window.

The lead-required merge of cb98e489 completed automatically as 1bffddd9: no
conflicts were resolved, `withCollectLease` and reference documentation merged
cleanly, and CHANGELOG is exactly cb98e489's content without an edited entry.
Final R2 validation runs on this merged tree with no test excluded, including the
previously excluded preview event-loop case.

R2 validation completed on 2026-11-12 SGT:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER TEST_SCALE=1 \
  ./node_modules/.bin/vitest run packages/room-mcp/test packages/relay/test \
  --maxWorkers=3
```

**309 files passed, one skipped; 4,037 ordinary passes, five previously documented
expected failures, 17 skips and one todo; 1,123.08 seconds. No test-name filter or
exclusion was used.** The preview event-loop case now runs and passes. Focused
R2/dependency validation passed four files (58 ordinary passes plus the three
already accepted file-level expected failures); the entire R2 file passes its
12 tests. Typecheck, knip and whitespace checks pass. No production or fixture
changes were made during the complete run.

The R2 dangling Room-private ref case remains the lead-approved characterization:
a dangling name within `refs/room` can be materialized without losing an object
or creating its user-branch target. Branch writes with a nonzero expectation
retain dangling replacements; symbolic recovery names still refuse. This repair
does not change those ref rules.

After fix commit 66471518, the lead requested a further merge of e403f294.
That merge completed automatically as 9d77dd94. No conflicts were resolved by
hand: CHANGELOG, `plugins/room/server/compat.json` and
`packages/server/test/room-first-load-marker.test.ts` exactly match e403f294.
There was no ownership-specific reason to alter the server test.

As directed, the complete MCP/relay run above was not repeated. Post-merge
`npm run typecheck` and `npm run knip` both pass. A TEST_SCALE=1 run of the entire
server package plus the two merge-added MCP selector files, the complete R2 file
and the real dependency discard/reuse file passed **543 tests**, with no failures,
skips or expected failures, in **28.57 seconds**. These focused checks cover the
new merged inputs; the lead owns final whole-repository validation after landing.

## R3: dependency setup never deletes output (reuse superseded by R4)

The directory receipt left in R2 had the same fundamental flaw. R3 replaces
`node_modules` with a link after `.bin` mkdir and before its identity observation;
`rememberDirectory` then records a pre-existing outside empty `.bin`, and `rmdir`
erases it after a source read fails. This is not a last-check/use replacement or
a new empty Room root. The unchanged a289aab1 reviewer file reproduced one failure
and one passing three-cycle lifecycle control on 6a22844d.

Delete the mechanism completely: `rememberDirectory`, its device/inode/birthtime
map, all callers, every directory-removal attempt and the old rollback loop are
gone. Setup failure only reports attempted container paths and leaves output in
place. These strings are diagnostics, never creation receipts or deletion
authority. Successful setup clears its old diagnostic records, not output files.
The ordinary creation-marker-verified worktree removal handles discard/collect.

Retries into a partly populated install keep real containers, matching link
destinations and copied shims with identical bytes and permissions. Missing entries
are created exclusively; mismatching or unexpected entries are named and retained.
Recognized tool caches retain their existing treatment. Copied shim comparison
uses two 64 KiB buffers and deadline checks, with asynchronous reads; no existing
shim is chmodded or overwritten. The informational retained-output flag keeps
failure notes from claiming an existing install is absent; it is not a worker
record field or a cleanup receipt.

Changed existing expectations in `worker-deps.test.ts`:

1. Cache-only partial setup now retries in place; its explicit fixture removal of
   retained `.bin` is gone, and the existing `.bin` inode must remain unchanged.
2. An unmatched workspace install now reports the exact `node_modules/left-pad`
   conflict instead of the old generic already-exists reason, and stays present.
3. An unmatched non-workspace install now reports its exact conflicting path and
   incomplete-setup warning instead of silently returning an empty reply; it stays
   present. No-lockfile, missing-workspace and not-ignored preflight cases still
   assert no output because they never attempted setup, not because of rollback.
4. The existing non-state mkdir audit for worker dependency output now counts the
   consolidated helper's single `mkdirSync(at)` instead of three separate `dst`
   and `to` sites. No path exemption was added, and duplicate/stale allowance
   assertions and the shared private-state initializer requirement are unchanged.

New tests require retained/reported empty output after a source-read failure,
matching-entry retry without inode replacement, unchanged mismatching links,
regular shims and extra entries, and detection of a same-sized shim mismatch past
the first comparison buffer. Existing R2 assertions, worker discard/reuse controls
and all assertions in a289aab1 remain unchanged this round. The R3 reviewer control
requires three failed-setup → discard → same-tag cycles with no checkout, branch
or retained-item report left after each discard.

R3 validation on the finished source:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER TEST_SCALE=1 \
  ./node_modules/.bin/vitest run packages/room-mcp/test packages/relay/test --maxWorkers=3
```

The final complete run passed **312 files**, with one skipped file: **4,169
ordinary passes, five previously documented expected failures, 17 skips and one
todo**, in **1,160.67 seconds**. No test-name filters or exclusions were used.
The unchanged R3 file passes both cases, the unchanged R2 file passes all 12,
and `worker-deps-rollback` passes both real discard/reuse controls. Focused
dependency/reviewer validation passes 66 ordinary cases and the three already
accepted file-level expected failures across five files.

The first complete run exposed two audit failures caused by the consolidated
mkdir site; the count correction above fixes those without relaxing assertions.
Its third failure was the test watchdog killing the preview fixture's synchronous
`git add` after a 120-second stall, before preview execution. The entire preview
file and corrected audit passed a serial rerun (12 tests, 65.70 seconds; maximum
preview/collect event-loop delays 45.48 ms for 5,000 files and 110.27 ms for
50,000 files). The subsequent complete run above passes with no source change
between runs. These commands ran with loopback access; no sandbox-limited cases
were omitted. Typecheck, knip and whitespace checks also pass.


## R4: refuse existing installs; remove reuse

Independent review of 15eefc9d reproduced `matchingLink` accepting an existing
`../../alias/../packages/a` link whose native filesystem target is the lead's
package. Its lexical normalization incorrectly made it look like the worker's
package. Reusing an existing empty `.bin` through a foreign worktree root also
extended that install and returned success. Both new controls fail on 15eefc9d
with `linked:true`; the partial-install retry refusal fails there too.

Restore the exact v0.17.47 `cachesOnly` predicate: a target is absent, or a real
node_modules directory containing only dot entries other than `.bin` (including
an empty directory). Preflight **all** target roots before writing anything. Any
other install returns `linked:false`, names `<path> already exists in the
worktree`, and tells the user to inspect/delete that node_modules or discard the
worker before setup can run again. The refusal is explicit for non-workspace
repositories too, as directed, rather than v0.17.47's silent skip in that case.

Delete `matchingLink`, `matchingFile`, `existingEntries`, the conflict helper,
and every acceptance path for existing links, shims and package directories.
The sole reuse exception is a caches-only node_modules root present during
preflight. A set of those path names remembers that exception; it contains no
identities or cleanup authority. An absent root must still be created with
exclusive mkdir if it appears before setup reaches it. Every child mkdir,
symlink and `COPYFILE_EXCL` copy is exclusive; EEXIST stops setup and reports
retained output. No rollback deletes anything, and no existing shim is opened,
chmodded or overwritten. A partly populated install with `.bin` or packages is
never resumed, even if all entries match.

Keep the existing persistent failure diagnostics: the unchanged R3 lifecycle
control requires stable retained-item entries, and the lead explicitly approved
keeping them. This also preserves room_state visibility until ordinary owned
checkout cleanup removes the paths. Reply text alone does not provide that
visibility across tool calls or restart. There are still no dependency cleanup
receipts, identity records, leaf-unlink or rmdir operations.

Changed assertions in `worker-deps.test.ts`:

1. Matching partial-install retry expects `linked:false`, an already-exists reason
   and inspect/delete/discard guidance instead of successful reuse. Existing
   link/shim inode, executable-mode and worker-source checks stay unchanged.
2. Each of the package-link, shim and extra-entry conflict cases expects refusal
   of the whole node_modules, rather than inspection of its conflicting leaf;
   all existing byte/link/inode preservation assertions remain.
3. The buffer-comparison case becomes an existing-install refusal without opening
   any shim. It uses small source/replacement strings instead of a large buffer;
   source-byte assertions compare the whole string, while target bytes and inode
   remain protected. The reported path is the install root, not the shim.
4. Cache-only setup interrupted after `.bin` creation refuses retry instead of
   completing. The unresolved worker therefore still imports `lead-a:third`,
   rather than `worker-a:third`; retained `.bin` identity and tool-cache survival
   checks remain. A separate fresh caches-only root still links successfully
   without replacing its root or cache file.
5. Workspace and non-workspace pre-existing `left-pad` installs now report
   `node_modules already exists in the worktree`, not a conflicting leaf path.
   Their preservation and non-workspace incomplete-setup warning remain required.

New controls cover the native symlink/.. target, foreign-root empty `.bin`,
EEXIST for a root appearing after preflight, and a nested pre-existing install
refused before any root output is created. The root-appearance test reproduced
success after the initial simple restoration; exclusive root creation now
refuses it. R2, R3, worker-deps-rollback and the private-state audit assertions
are unchanged this round.

R4 validation on the finished source:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER TEST_SCALE=1 \
  ./node_modules/.bin/vitest run packages/room-mcp/test packages/relay/test --maxWorkers=3
```

The complete run passed **312 files**, with one skipped file: **4,173 ordinary
passes, five previously documented expected failures, 17 skips and one todo**,
in **1,091.36 seconds**, without filters or exclusions. The preview scale cases
both pass (maximum event-loop delay 39.06 ms at 5,000 files and 81.59 ms at 50,000).
Focused dependency/reviewer/audit validation passes **50 tests across five files**,
including unchanged R2 (12), R3 (2) and worker-deps-rollback (2). Typecheck, knip
and whitespace checks pass. No source or test input changed during the complete
run, no test was omitted for sandbox restrictions, and no expected failure was
added. Generated bundles remain the lead's integration/release work.
