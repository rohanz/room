# Independent review: worker checkout ownership

Reviewed 2026-11-11 by `astra-ownership`. **Verdict: not sound.** The capture approach is useful, and the seven specific regressions have plausible remedies, but the written design still permits deletion outside the approved boundaries. Correct the creation and ref protocols before implementing it.

This reviews **b6f0cb2cbe452724cb545c1706b701daf0ff4ce0**, not a moving branch. `D:<line>` below refers to `docs/superpowers/2026-11-11-worker-checkout-ownership.md` at that commit. Source references otherwise use this review's starting tree, **ebd49225eac4dceb6b7d96c5a7b420081205a130**. The brief is `.room/briefs/0.17.48e-ownership.md`. I read the repository instructions, current worker/reference contracts, roadmap and relevant decisions; I did not author or implement the design. No production code changed.

## Findings requiring changes

### 1. A successful add does not prove Room created the root directory

**Confirmed loss, outside boundary (c).** D:180-187 records root identity only after `worktree add`. Git accepts an already existing **empty** directory, keeping its inode. A different process can create that directory after Room's absence check but before add. Room then stamps it and later deletes a directory it did not create. D:412-413's assertion that an occupied/reappearing path makes unforced attachment fail is false for an empty directory.

Reproduction in a fresh committed repository (`w` initially absent):

```sh
mkdir w
# Record w's inode with Node fs.lstatSync('w', {bigint:true}).ino.
git worktree add -b room/task w
# Exit 0; w has exactly the same inode.
git worktree remove w
# Exit 0; the pre-existing directory is gone.
```

The observed inode was 461676507 both before and after add. The approved exception starts **after Room's successful add**, and concerns removing its just-created worktree and re-adding at the same path on its own branch. This is a pre-add foreign directory, not that exception. It also applies to detached preview creation.

**Required change:** obtain a root-creation receipt before Git attachment, for example exclusive nonrecursive `mkdir` of the final root, durably record that identity, then require the post-add root to match it. Refuse `EEXIST`, including empty directories. Verify the admin separately under the approved post-add boundary. Do not turn an absence check followed by Git add into a receipt. Test replacement between mkdir, receipt, add and witness. Do not widen the approved boundary to cover this race.

### 2. Default ref CAS can delete a different branch through a symbolic ref

**Confirmed loss.** D:373-379 specifies `git update-ref -d <full-ref> <expected-old>`. That dereferences symbolic refs. An ordinary `git symbolic-ref` between verification and deletion redirects deletion to a branch Room did not create, even when its value equals the expected OID.

```sh
old=$(git rev-parse HEAD)
git update-ref refs/heads/user-target "$old"
git symbolic-ref refs/heads/room/task refs/heads/user-target
git update-ref -d refs/heads/room/task "$old"
git show-ref --verify refs/heads/user-target
# CAS exits 0; show-ref fails: user-target was deleted.
git symbolic-ref refs/heads/room/task
# Still prints refs/heads/user-target: the symbolic name remains dangling.
```

This is not permission to delete a same-name branch recreated at the same commit; it deletes a **different name**. Restore commands can likewise write through an unexpected symbolic ref. A preceding `symbolic-ref` check is another check/use race.

**Required change:** specify and test non-dereferencing mutation (`update-ref --no-deref`, including the equivalent transaction option), exact full names, expected values and symbolic-ref policy for every creation, restore and deletion. My `--no-deref -d` experiment removed only the named symbolic ref and preserved `user-target`. Treat any stronger guarantee about rejecting symbolic replacements atomically as a separate requirement needing proof; a precheck alone cannot provide it.

### 3. A captured checkout does not freeze its symbolic branch's value

**Confirmed loss.** D:385 obtains the deletion expectation from the captured checkout's tip. The captured admin `HEAD` is still `ref: refs/heads/room/task`; that ref lives in the shared common directory. Another actor can delete/recreate it at a different tip **before** Room observes the captured HEAD. All root/admin/marker identities still match, and Room adopts the foreign value as its expectation, then successfully deletes it. D:17 and D:378's recorded-value policy is contradicted by this caller rule.

```sh
git worktree add -b room/task w
old=$(git rev-parse room/task)
git commit --allow-empty -m foreign-tip
new=$(git rev-parse HEAD)
git update-ref -d refs/heads/room/task "$old"
git update-ref refs/heads/room/task "$new"
mkdir private
mv w private/payload
observed=$(git -C private/payload rev-parse HEAD)
git update-ref -d refs/heads/room/task "$observed"
# observed == new != old; CAS exits 0; foreign branch is gone.
```

The reproduction keeps the original admin; moving it privately does not make the common ref immutable. Comparing the captured worktree's files or index also cannot prove ref generation (the reproduction uses an empty commit).

**Required change:** do not upgrade branch deletion authority from cleanup-time reads. Use the last independent durable authorized write expectation, with unknown/change meaning retain. Merely recording the freshly observed foreign tip before erasure does not fix provenance. The smallest safe policy may leave branches after ordinary worker commits when their current value cannot be authorized. Obtaining stronger automatic cleanup while workers freely update Git refs requires a separately justified contract. Same-tip ABA remains the only approved ref-generation exception.

### 4. The captured Git pair has a third pointer: `commondir`

**Confirmed inspection failure; preservation is possible but recovery is underspecified.** D:330-331 mentions rebinding the gitfile/backlink; D:347-349 calls for controlled admin/common context. A normal admin contains `commondir` with `../..`. Moving it from `.git/worktrees/w` to `.git/room/capture/admin` makes that relative pointer resolve to `.git/room`, not `.git`.

I moved the root and admin, rewrote the root gitfile and admin `gitdir`, and ran `git --git-dir=<captured-admin> --work-tree=<payload> rev-parse HEAD`: exit 128, not a Git repository. With an explicit `GIT_COMMON_DIR=<original .git>`, Git 2.45.2 reported the desired common directory but still failed to resolve `HEAD`/list refs. Rewriting the **verified owned** captured admin's `commondir` to the absolute original common directory made HEAD resolution succeed. Thus the proposed wording does not yet specify a working Git inspection context on the tested Git.

**Required change:** define the exact portable inspection setup, including `commondir`, or inspect with a separate owned temporary Git context. Journal each authorized metadata rewrite and its expected old/new bytes. Add crashes during all three rewrites. Never rewrite a rejected foreign pair. This is an implementation gate, not grounds for falling back to public-path Git operations.

### 5. Downgrade is missing, and it damages recovery metadata

D:217-226 changes records to `v:2` and says not to run old processes concurrently. It does not describe a sequential downgrade. At **v0.17.47 / 66f09ca52c245cda3a904a9fa0b18ee95a28498f**, `worker-codecs.ts:37` accepts only `value.v === 1`. `worker-file-store.ts:372-380,1338-1366` classifies v2 as invalid and writer reconciliation moves the file into `registry/quarantine` (`:337-343`). `local-state-gc.ts:75,115,142-143` expires those quarantined files after 30 days. A new full-life record can therefore be moved out of service and eventually erased by an old binary. No old code replays new checkout-capture journals.

This is source-derived behavior, not a claimed live old-plugin run. A new marker is just an unknown file to old Git cleanup. An unknown `registry/checkout-cleanup` directory is covered by the old generic registry `owner` rule (`local-state-gc.ts:73-74`), so the old GC does not automatically erase that payload directory; it also does not understand or resolve it. Sidecar envelopes at the proposed non-registry location have no new-version diagnostics in the old UI. Old global prune sites still exist and can remove uncaptured stale metadata.

**Required change:** state downgrade unsupported while v2 records or unresolved captures exist; provide a concrete export/inspection and return-to-new-version procedure. Test a real old reader/writer/GC against fixtures. Do not promise that a new version's compatibility flag can stop an already shipped old binary unless the old code demonstrably honors it. User acceptance of the operational restriction is a release decision.

### 6. Durability and filesystem identity claims remain conditional, not established

D:208 makes creation timestamps optional. Device/inode identify a live object but are not a portable never-reused generation ID across deletion and restart. A preserved admin marker is separate from the root; an ordinary moved/copied gitfile can still name it. The design needs an explicit argument and tests for root identity reuse, filesystem timestamp resolution and unsupported identity semantics; it must retain where the required proof is unavailable. I did **not** reproduce inode reuse in this run, and do not claim the tested APFS root comparison fails today.

D:275-279 and D:470-474 prescribe conservative durability, correctly. However “existing atomic-write conventions” do not prove the new operation's ordering: `packages/relay/src/leases.ts:34-39` swallows directory-sync `EINVAL`, `ENOTSUP`, `EISDIR`, and `EPERM`; `:85-113` fsyncs files and renames them. The design needs an explicit supported-storage decision before enabling destructive replay, including how failure to durably publish the witness/receipt is detected. Killing a process is not a power-loss test. Directory-sync failure must not silently count as the capability needed for the stronger guarantee.

Private destinations are protected by D:64-72's reserved namespace assumption, not by mode 0700 against another process of the same user. That is consistent with excluding deliberate capability forgery, but the implementation must keep capture slots out of existing sweep/prune namespaces and out of a checkout ancestor which can itself be removed. D:283-288's example is not a fully determined placement rule for nested workers and a common directory on another volume.

### 7. Stage ordering and bounded accumulation need tightening

D:640-649 enables worker capture deletion before the adjacent preview/GC/diagnostic routes are closed in stage 5. D:658-660 says intermediate stages fail closed, but does not specify the switch that enforces it. Worker cleanup calls preview cleanup (`worker-git.ts:243-246`); stage 4 cannot be independently safe while it still reaches the old global prune. Put all indirect destructive routes behind the same gate before activating any adapter.

D:547-556's 64-operation limit needs a clone-wide atomic reservation, not independent worker leases and count-then-capture. At 63, two workers can otherwise both admit. Specify release/recovery of that reservation, a fair cursor for the 64-per-sweep budget, and whether it counts retained-in-place failed creations, unknown refs, empty envelopes created before journal publication, and multiple sidecar/temp captures belonging to one generation. Without those definitions, the claimed bound on future automatic capture growth is unproven. No automatic expiry of foreign bytes is the correct policy; it does not bound their size or all metadata leaks.

## Independent Git experiments

All ran on **Darwin, Git 2.45.2**, 2026-11-11, in fresh temporary repositories with local test-only author identity, a committed `tracked` file and `.gitignore` containing `ignored`. Global/system Git config and inherited `GIT_*` variables were excluded. No experiments touched the lead's checkout. Commands were foreground; only the focused Vitest run used two workers. An attempted `nice -n 10` reported `setpriority: Operation not permitted`; its Python command nevertheless completed. This is not Linux, Windows, cross-volume, network-filesystem or power-loss evidence.

For each move/remove cell below I created a fresh linked worktree on `room/task` (or `user/foreign`), wrote an admin sentinel, applied the state, then ran `git worktree <operation> [--force [--force]] <w> [<absent-destination>]`. The values are exit status for **zero / one / two** force flags:

| State | Move | Remove | Observed effect |
|---|---|---|---|
| Clean | 0 / 0 / 0 | 0 / 0 / 0 | Move keeps admin inode and updates backlink; remove destroys root and admin. |
| Tracked dirty | 0 / 0 / 0 | 128 / 0 / 0 | Non-force remove retains both; force erases dirty bytes. Move does not require cleanliness. |
| Ignored-only output | 0 / 0 / 0 | 0 / 0 / 0 | Even non-force remove erases ignored data. |
| User locked | 128 / 128 / 0 | 128 / 128 / 0 | One force still preserves; double force overrides lock. |
| Missing root, registered admin | 128 / 128 / 128 | 0 / 0 / 0 | Move reports missing gitfile; remove deletes the registration. |
| Foreign registered, clean | 0 / 0 / 0 | 0 / 0 / 0 | No ownership distinction; moves or deletes foreign worktree. |

For add, start with a detached foreign worktree and admin sentinel. For missing cases remove only its root; for plain recreate it as a nonempty ordinary directory. Run `git worktree add [force flags] -b room/task <w>`:

| Destination state | Zero / one / two force | Sentinel and branch result |
|---|---|---|
| Missing, unlocked registration | 128 / 0 / 0 | Failure retains admin; successful force replaces it and erases sentinel. Branch created in all three. |
| Missing, locked registration | 128 / 128 / 0 | Only double force replaces admin. Branch created even on both failures. |
| Nonempty plain directory | 128 / 128 / 128 | Root/admin preserved; branch nevertheless created. |
| Existing clean, dirty or ignored-output registered root | 128 / 128 / 128 in each case | Root/admin preserved; branch nevertheless created. |
| Unregistered foreign empty directory | 0 (unforced tested) | Same root inode adopted. This is the counterexample in finding 1. |

I separately repeated forced replacement with a named `room-preparation.json` containing a foreign ID: the marker disappeared. The missing-registration single/double-force results agree with D:143-154.

Other independently observed results:

- Fresh admin contained `HEAD`, `ORIG_HEAD`, `commondir`, `gitdir`, `index`, `logs/HEAD`, and `refs/`; `HEAD` was symbolic and `commondir` was `../..`. A worker commit preserved admin inode and symbolic HEAD, advanced the shared branch/HEAD log and added `COMMIT_EDITMSG`. `index` is binary; this is not an immutable directory snapshot.
- `worktree move` preserved admin inode and rewrote `gitdir`; raw rename preserved inode and left old backlink. `worktree list --porcelain` marked that raw-moved entry prunable. `worktree repair <new>` preserved admin inode and updated backlink.
- `worktree remove <absolute-admin-path>` exited 128, “not a working tree”. There is no demonstrated identity-selector removal command.
- Moving into an existing empty destination with Git put the checkout at `<destination>/w`. Raw rename over an empty destination replaced its inode. An already open tracked-file handle still read `base` after raw rename; Git from the raw-moved root could still resolve HEAD before the admin move.
- Remove/re-add on the same path and same branch reused the admin **name**, with a new inode in this run. Forced attachment of the same branch at another path created two symbolic HEADs naming that branch. A copied gitfile in a replacement root resolved the original HEAD despite the different root inode.
- Expected-old delete against a different direct-ref tip exited 1 and retained the new value; delete/recreate at the expected tip exited 0 and removed it. Packed-ref deletion with the expected old value worked. SHA-256 repository CAS worked with a 64-character OID.
- Symbolic-ref deletion, cleanup-time branch adoption and relocated `commondir` behaved as findings 2–4 describe.

**Comparison:** none of the specific local observations quoted in D:99-174 differed from my repeats. The false claim is the broader occupied-path/unforced-add conclusion at D:412-413; the ref and admin-context failures are omitted cases, not disagreement with its direct-ref CAS experiment.

The initial matrix harness and raw output were `/tmp/astra-ownership-experiments.py` and `/tmp/astra-ownership-experiments.jsonl`; additional probes were `/tmp/astra-ownership-extra.py` and short foreground Python commands. Temporary artifacts are not the deliverable or a dependency for reading this report. To reproduce the matrix: `git init`, set local `user.name/user.email`, commit `tracked` and `.gitignore`, `git worktree add -b room/task w`; apply exactly the state above; run each command on a **fresh** repository and inspect both `w` and `git -C w rev-parse --absolute-git-dir` saved before the operation. Never reuse a destructively tested row's repository for another cell.

## Each of the seven documented sequences

These are assessments of the intended complete protocol, not claims that implementation tests already pass. None of the original seven falls under the three approved ownership exceptions.

| # | Sequence | Does the specified mechanism prevent that particular loss? |
|---|---|---|
| 1 | Discard markerless intent | Yes if D:34-35,217-223,496 are applied at every replay: it is unverified, never legacy, and authorizes no checkout/admin/ref cleanup. Retain the foreign objects in place. |
| 2 | Discard markerless preparing | Same, including startup reconciliation. `prep.created` and phase cannot become a witness. |
| 3 | Replacement before prepare-finish | Yes for the existing post-witness injection: D:240-249 rejects promotion; later cleanup compares captured root/admin with the original witness. Do not launch; retain replacement. A replacement before the initial witness is only excepted when it is exactly the approved post-add own-path/own-branch replacement. |
| 4 | Replacement after check, before remove | Yes for a genuinely witnessed root: D:283-307 atomically captures, then verifies. Replacement before capture is retained privately on mismatch; replacement after capture stays public and is never deleted. Admin capture has its own equivalent check. Inode-generation and private-namespace conditions in finding 6 remain proof obligations. |
| 5 | Different-tip branch recreated after worktree removal | Yes for the original timing: D:364-385 must already have an immutable expected OID, then exact-name non-dereferencing CAS fails on the changed tip. Finding 2 is needed for general ref safety; finding 3 shows an earlier replacement still defeats the written broader contract. |
| 6 | Clean returned checkout during stale removal | Yes: D:402-429 refuses the unmarked foreign stale entry instead of invoking path removal/prune/forced add. If a witnessed admin is captured, a later foreign root is never removed by cleanup. The returned-empty-root variation needs finding 1's fix. |
| 7 | Ignored-output returned checkout | Same as #6. Git's treatment of ignored files is irrelevant once no destructive path-selected Git command is used. Preserve both committed and ignored bytes. |

Existing fault spies on `worktree remove` will stop firing. Replace them with capture/ref fault boundaries and assert the foreign object actually appeared. For #4, bytes at a reported retained location are preservation; requiring the original pathname to remain populated would reject the design's explicitly disclosed relocation outcome. The lead must approve that usability consequence, not silently call it “untouched”.

Focused baseline command:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER ./node_modules/.bin/vitest run \
  packages/room-mcp/test/spawn-cleanup-limitations.test.ts \
  packages/room-mcp/test/spawn-stale-registration.test.ts --maxWorkers=2
```

Result: **2 files passed; 7 passed and 7 expected fail; 14 total; 10.45 seconds**. These expected failures reproduce the baseline limitations, not validate the design. No full suite, build, platform suite or production implementation was run for this document-only review.

## Removal inventory audit

I searched every TypeScript file under `packages/room-mcp/src` for worktree remove/prune, branch `-D`, `update-ref` including stdin deletes, recursive rm/rmdir and unlink. I inspected the requested `retire.ts`, `tools/collect.ts`, `worker-file-store.ts`, `worker-git.ts`, `worker-preparation.ts`, and `local-state-gc.ts` call chains. The design identifies all literal production `worktree remove`, `worktree prune`, and `branch -D` invocations in that tree. Its inventory is nevertheless incomplete:

| Missed site | What it removes / required treatment |
|---|---|
| **`worker-git.ts:207-212` (`inheritWorkerRefs`)** | `sources.map` emits unguarded `delete ${targets[index]}` when the source pin is missing. D:509 names `removeWorkerRefs` at 216-219 but omits this second deletion route. It can delete a target pin created by another actor. Apply exact-name CAS/provenance here, or omit the unnecessary missing-source delete when creating fresh borrower pins. Test the stdin command, not only literal `-d`. |
| `merge.ts:57-81` | Recursive deletion of `mkdtemp` merge-file directory. Outside public worker paths, but an omission from the design's adjacent private-temp inventory; classify under its exclusive private-container rule, without demanding a checkout journal. |
| `preview-evidence.ts:42-50` | Recursive deletion of private preview-index temporary directory, including failure cleanup. Same classification; no Git registration. |
| `preview-evidence.ts:209` | Private temporary evidence file unlink via rm; include if the inventory continues to cover file-level sidecars. |
| `tools/files.ts:453` | `scratchVenv` symlink cleanup before preview population. D:518 starts at 476 and misses it. Restrict to the owned preview generation and created link; no public root cleanup authority. |
| `preview-cache.ts:213-225` | Removes a preview quarantine marker after process checks. This is the existing process quarantine, not a new ownership capture manifest. State the distinction explicitly so this helper cannot clear new preservation evidence. |
| `worker-file-store.ts:982,1003` | Discard-patch scratch-file cleanup. Include in private temporary-file policy; not a directory/registration deletion. |
| `worker-file-store.ts:1230-1231` | Dead orphan operation/tag reservation cleanup. Private registry facts, not checkout deletion; ensure a new cleanup journal/reservation counts as evidence before declaring an orphan empty. D:507's retired-record retention range does not name this separate route. |

Other file-only deletions in `choice.ts`, `arbitration.ts`, `hooks-bridge.ts`, `owned-file.ts`, `policy-store.ts`, `timing.ts`, and `cpu-watchdog.ts` do not select worker directories, Git registrations or branches. They need no checkout capture engine merely because they unlink a file. `local-state-gc.ts:94,114-149` already appears in D:519; its historical `storage-gate`/`preflight` directory removal must not accidentally become a location for captures. `tools/messaging.ts:267` updates a collection ref (not deletion), but belongs in the audit of the design's **every ref mutation** promise. `worker-git.ts:526-527` and `:649` are already within its broad retry/reconstruction rows; implementation must actually remove/convert those restores as well as deletion.

## Crash, restart and private placement

The following is the necessary recovery state machine. “Retain” includes a durable, user-visible reason; it is not success. The design mostly states the safe outcome, but the rows marked **gap** require a more exact protocol. All recovery first reacquires the operation lease with proven dead-holder rules; unknown/live holders block.

| Crash point | Durable state / safe restart |
|---|---|
| Before branch create | Intent only; no branch deletion authority. Existing branch retained. |
| After successful branch CAS, before creation receipt | Branch may exist but ownership is ambiguous; retain it. Never infer successful creation from its current value. |
| Before/after root creation and before add | **Gap:** add presently has no independent root receipt. Add exclusive root creation and its crash states; retain on ambiguous publication. |
| Add succeeded, before marker | Root/admin may exist; do not synthesize marker at restart. Retain, report and account for this incomplete creation. |
| Marker durable, worker record not updated | D:230-232 permits recovery only from a matching durable attempt identity and all root/admin facts. Missing, torn or mismatched marker retains everything. |
| Private envelope allocated, before cleanup intent publication | No payload should have moved. **Gap:** identify/report orphan envelopes and charge admission before allocation without treating arbitrary directory names as ownership. Do not recursively erase unknown contents. |
| Intent durable, before root rename | Named absent payload slot plus immutable witness. Recheck admission and capture at most once. If evidence is ambiguous, retain. |
| Root rename happened, before capture receipt | Payload at journaled slot is the candidate; verify it there. Public source is irrelevant and may be foreign. Source absent plus empty payload is not proof of successful deletion. |
| Root captured, admin still public | Root retained while exact recorded admin is checked/captured. Missing/mismatch/lock keeps payload. No fresh public-path admin discovery, global prune or reconstruction. |
| Admin rename happened, before receipt | Inspect the journaled private admin. Verify both saved identities; mismatch preserves both. Foreign admin is now hidden from enumeration but not erased. Never restore over a reused public admin name. |
| Pair verified in memory, before durable authorization | No deletion authority yet. Restart re-verifies; do not infer authority from the process having reached this step. |
| During gitfile, backlink or commondir rebind | **Gap:** record exact allowed old/new content and each write before mutation; restart must recognize partial owned rebinding, or retain. Original-marker/gitfile checks cannot simply be reapplied to rewritten bytes. No automatic public restoration. |
| During snapshot/patch/recovery-ref creation | Capture remains. Patch and recovery refs must be durable before erasure; their own CAS and receipts follow the same rules. Never re-import output merely because cleanup restarted. |
| Authorization receipt durable, before payload delete | Resume only authorized private slots. Never capture again. A new lock/output observation before authorization must already have caused retention. |
| Partway through payload delete | Keep pending operation with same root/container identity. Receipt must authorize the remainder even if `.git` was already deleted; otherwise stop and report. A recursive rm error is not completion. |
| Payload gone, admin partially/wholly present | Resume only that authorized private admin; no action on public registration names. Partial marker removal is not a reason to adopt new metadata. |
| Both gone, completion receipt absent | Durable deletion authorization plus private-slot absence makes this idempotent; write per-item outcomes. No public-path absence inference. |
| Ref deletion succeeded, outcome receipt absent | Absent means done; different tip retained; expected tip retry is allowed only by same-tip ABA boundary, using non-dereferencing CAS. Restores need analogous absent/expected/new classification. |
| Worker record update before manifest retirement | Immutable manifest survives record retirement and pins dependent evidence. Finish pending items only; never apply collected output again. |
| Manifest expiry | Only after every retained item/ref dependency is resolved. Corrupt/unreadable manifests and unexplained slots remain. Expiry is not deletion permission for foreign payload. |

The proposed private paths are a journal below `<common>/room/registry/checkout-cleanup/<operation-id>/`, and exclusive envelopes on each object's filesystem: preferentially the common-dir private tree, otherwise e.g. `.room/worker-cleanup/<nonce>/payload`; admin always stays on the common filesystem. The exact sibling location must be outside all cleanup candidates and retained nested checkout ancestors. Use the same durable operation to reserve slots; no public empty leaf is a safe rename destination.

Could anything else occupy a slot? Yes if the implementation reuses a name, crashes then allocates again, or a same-user actor deliberately enters it. The proposed proof excludes the last case but must prevent the first two. Unexpected occupancy is retain/report, never overwrite. Keep such envelopes out of the old JSON quarantine, generic `.tmp` expiry and preview LRU. Creating mode 0700 is useful privacy, not a capability revocation against same-user processes.

Across filesystems, rename must either use a slot on the source filesystem or fail closed on `EXDEV`; no copy/delete fallback. I did not test a second mounted filesystem. Windows open handles/antivirus/ACLs can make rename fail; the design correctly requires retention and preserves the existing process-visibility refusal. Actual Windows tests remain mandatory before activation. POSIX open file/cwd handles can survive a move; my Darwin open-file result confirms that moving does not establish quiescence. Ordinary nested-worktree/process admission is necessary separately from root ownership.

After a foreign capture, manual recovery must preserve both root and admin bytes, original locations, and the exact explanation of which Git pointers still reference old locations. The design offers no safe automatic undo, appropriately: ordinary rename can overwrite an empty destination. A user needs a documented inspection/restoration procedure; displaying only a private path is insufficient when the gitfile or registration no longer resolves.

## Upgrade and approved boundaries

- **Same-tip branch ABA:** D:22-27 states the authorized exception precisely. It does not cover different-name symbolic targets or adopting a different current value. Findings 2 and 3 must not become new exceptions.
- **Pre-change established records:** D:431-448 is appropriately bounded to recorded facts; any genuine mismatching witness refuses, unfinished records cannot become legacy, and base need not equal the worker's evolved HEAD. D:28-33 is shorthand; the detailed all-recorded-facts rule must govern. Upgrade should remain lazy/under lease and preserve every old fact. No marker may be manufactured to pretend a pre-existing root was witnessed at creation.
- **Post-add same-path/own-branch replacement:** D:40-49 describes the intended narrow exception. D:45-46's phrase “during its creation step” must not be used to include pre-add empty-root adoption, unrelated branches or post-witness replacement. Add explicit tests on both sides of the successful-add boundary.
- **Portable Node/Git only:** respected in the proposal. Refusing cleanup is acceptable when portable primitives cannot provide the required proof. No recommendation here requires native helper code.

Existing v1 workers should remain collectable/discardable under the bounded legacy path when recorded facts match, and otherwise be retained with a reason. New corrupt records must never fall back to that path. v1 marker-bearing unfinished records need their genuine creation witness handled explicitly; v1 markerless unfinished records leak safely. A downgrade has the concrete metadata consequences in finding 5; it is not covered merely by telling users to restart after an upgrade.

## Diagnostics, accumulation and minimality

D:535-560 proposes useful separate outcomes for import, worker retirement, checkout, admin and branch; normal `room_state`, `check=true`, tool refusals and deduplicated logs name retained locations. Those are required before any automatic capture. Include “foreign object relocated” and “registration no longer enumerated” distinctly. Diagnostics must survive the original worker record disappearing and a corrupt manifest; enumerate only the known private namespace for reporting, not for guessed deletion.

Retained foreign bytes have no safe time-based expiry. The 64-operation gate can bound future **admitted operations** only after the atomic accounting gaps in finding 7 are fixed. It cannot bound bytes, incomplete pre-capture creations, or arbitrarily many objects in a single operation without additional accounting. Prefer explicit count/size estimates and refusal of further allocations to silent growth. Manual resolution must identify actual remaining data and refs, not infer resolution from an absent original path or timeout.

This is not the smallest solution to the stated safety requirement: “retain and report” at every uncertain removal already meets it. A useful minimal implementation could first retain unmatched checkout/admin objects and all uncertain branches, remove global prune and broad reconstruction, and introduce exact-name CAS only where the old value is independently authorized. Automated cleanup is a product objective in addition to the safety guarantee.

If automatic cleanup is retained, keep a single capture engine and immutable journal rather than duplicate helpers by phase. Remove optional multi-ref batching initially; individual CAS with durable outcomes suffices for preservation. Omit missing-source borrower deletes rather than building authority for them. Unnecessary gitfile/backlink rewriting may be avoidable with a separate proven inspection context, but **do not remove** the durable receipt, full-life identity, dual root/admin verification, legacy classification, diagnostics or retention pins while using capture deletion.

New failure modes introduced by capture include a healthy checkout stranded at a private path, an admin hidden from Git enumeration, dangling original gitfiles, broken relative `commondir`, foreign empty paths overwritten by any attempted restoration, unusable workers after a disk-full journal write, leaked full trees after Windows move failure, and a clone blocked by unresolved captures. The two-object move is not atomic. These are acceptable only as visible preservation outcomes with durable recovery instructions; none justifies destructive repair. Capture's disruption is a reason to preflight and retain in place where possible.

## Staged-plan verdict and tests required first

| Stage | Independently correct? / prerequisite |
|---|---|
| 1: regressions, decoding and provenance | Correct as test groundwork; a production format migration is **not** independently releaseable without upgrade/downgrade and legacy compatibility gates. Unknown v2 ownership must refuse. Add failures for findings 1–3 and stdin borrower deletion before changing mechanisms. |
| 2: creation evidence | **Not correct as written:** post-add root discovery accepts foreign empty directories. Add exclusive root receipt plus boundary tests first; keep pre-witness ambiguity retained. Creation ref CAS must be non-dereferencing too. |
| 3: retain-only engine and CAS | Retain-only is safe from deletion but can strand worktrees; requires journaling, diagnostics and admission bounds immediately, not stage 5. CAS primitive needs exact-name/symref tests and independent expected values. |
| 4: route worker phases | Cannot activate deletion independently while indirect preview prune, retention erasure or old fallback survives. Route every descendant call or disable it first. Seven tests become ordinary passing tests only when injection actually occurs. |
| 5: adjacent routes and diagnostics | Necessary, but prerequisite parts belong before activation in 3/4. Separate unrelated private file cleanup from checkout ownership to avoid needless machinery. |
| 6: integrated checks/docs | Necessary final gate, not a substitute for earlier invariants. Run focused suites, typecheck/knip, full scrubbed and scale CI suite, web/plugin builds and supported-platform fault scenarios in the integrated tree. |

Additional failing tests before enabling erasure: foreign empty root before add; replacement at every root-receipt boundary; symbolic branch/ref substitution before CAS; different-tip recreation before captured-HEAD observation; borrower stdin delete race; root/admin independently replaced between their captures; same-tip ABA accepted; moved/locked/missing/corrupt admin; captured `commondir` inspection; metadata rebind crashes; partial recursive deletion after marker removal; fsync failure and unsupported identity semantics; simultaneous admission at 63/64; journal corruption and retention with no original record; downgrade writer quarantine and 30-day GC; preview cleanup of unrelated stale registrations; nested captures on another volume; Windows open-handle failures. Assert sentinel bytes, exact ref values and admin evidence, not just operation return codes.

## Decisions for the lead or user

1. **Automatic branch cleanup versus strict provenance:** recommend retain branches whose current tip lacks an independent authorized expectation. Do not widen same-tip ABA into permission to adopt any tip observed during cleanup.
2. **Foreign relocation usability:** the brief considers capture/quarantine, but explicitly confirm that a preserved foreign registration may temporarily disappear from Git enumeration and require manual restoration. Recommend preflight plus retain-in-place wherever possible, with precise recovery instructions when a race forces capture.
3. **Downgrade support:** recommend prohibit downgrade with v2/unresolved state and provide an inspected migration/export path. Supporting unrestricted v0.17.47 writers cannot be promised by new code alone.
4. **Storage/platform activation:** recommend retain-only on filesystems/platforms without demonstrated identity and durability semantics; keep existing Windows process refusal. Decide the supported matrix before claiming the universal guarantee.
5. **Operational capture limit:** recommend one atomic clone-level allocation budget covering all unresolved captures and incomplete creations, with a user-visible refusal and fair recovery scan. The exact threshold is policy; 64 is unvalidated, not a correctness constant.

No decision is needed to permit pre-add empty-root adoption or different-name ref deletion: those are outside the already settled boundaries and should be fixed. The design author was asked directly about branch-tip provenance and downgrade, but Room reported that worker finished; this review does not treat silence as assent.

not sound
