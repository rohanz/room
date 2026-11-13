# Kept preview publication: benchmark audit and correction

Evidence: `/tmp/room-coupled-benchmark-2026-11-13-t3/control/evidence/room/`, plugin commit `94b243a3`.
Times below are UTC on 2026-11-12 (the benchmark is named for November 13).
Sources are `lead-0.jsonl`, `transcripts/*workers-*/*.jsonl`,
`mirror/room-mcp/room-mcp.log`, and `git-room/registry/workers/*.json`.

## Event order

1. lua-core's MCP stops at 22:46:59.651, worker's at 22:49:12.123
   (`room-mcp.log`, lines 762 and 824). Both are stopped before collection.
2. The lead calls `room_collect(keep=true)` at 22:49:57.868
   (`toolu_0135Y4Cycs66YyADrxTYk3wc`). Its 22:50:06.777 reply names
   flows, lua-core, api, worker and deadline, and explicitly reports
   `kept preview freshness pending`. One pending acknowledgement is assigned
   to all five records, then each record gets its own delivered baseline.
   This occurs in the lead process; worker uptime is irrelevant to writing it.
   Log line 856 records 8,903 ms total and 5,592 ms in cleanup, consistent
   with the acknowledgement's 5,000 ms deadline. The log does not record
   which awaited scan/settle/verification stage exhausted that deadline;
   an exact internal timeout stage cannot be recovered from these artifacts.
3. Tests-docs' preview at 22:50:54.271 and finish's at 22:51:37.575 include
   `benchmark`, but still report missing acknowledgements for all five.
   Later publication progress does not update a stored pending record.
4. The lead sends revision-1 follow-ups to api at 22:51:43.134, flows at
   22:51:46.436 and deadline at 22:51:49.534. `room_send`'s
   `retryPublication` updates only the addressed worker's record. The later
   retained records show all three acknowledged lead fence
   `3763387097939968`, revision 6. No revision-1 message targets lua-core
   or worker; neither is resumed for this revision. They retain pending
   bookkeeping despite the lead's publication becoming usable.
5. The lead-inclusive previews at api 22:53:18.452, deadline 22:53:17.673,
   flows 22:54:06.391 and tests-docs 22:53:19.369 / 22:53:48.395 therefore
   report only lua-core and worker. Nothing was lost by those workers:
   the acknowledgement never existed in their records, and no later lead
   scan alone could create it. This is selective message-triggered retry,
   not a publication-before-record-update race.
6. The second all-worker keep at 22:58:48.344–22:58:56.306 succeeds without
   a pending warning and rewrites the proofs. The final worker record has
   a successful revision-6 proof; lua-core is collected once more at
   23:08:43.066–23:08:45.202 and ends with revision 14. Thus the gap did
   not persist to the end of the entire run: it persisted through the
   revision-1 worker checks until another keep operation repaired it.

## The two reported reasons

Count by unique tool-use ID, since transcripts also contain repeated messages
without timestamps. There are 66 distinct worker previews, 65 with a command.
The supplied approximately 14 partial responses include replays; the timestamped
worker records contain 12 distinct partial calls.

| Worker | Result time | Lead included | Cause |
| --- | --- | --- | --- |
| tests-docs | 22:50:28.762 | no | different delivered versions |
| tests-docs | 22:50:54.271 | yes | five pending proofs |
| finish | 22:51:11.505 | no | different delivered versions |
| finish | 22:51:37.575 | yes | five pending proofs |
| deadline | 22:52:52.248 | no | different delivered versions |
| api | 22:53:01.174 | no | different delivered versions |
| deadline | 22:53:17.673 | yes | lua-core / worker proofs |
| api | 22:53:18.452 | yes | lua-core / worker proofs |
| tests-docs | 22:53:19.369 | yes | lua-core / worker proofs |
| flows | 22:53:23.576 | no | different delivered versions |
| tests-docs | 22:53:48.395 | yes | lua-core / worker proofs |
| flows | 22:54:06.391 | yes | lua-core / worker proofs |

No distinct call with the lead named returned the different-delivered-versions
reason. That check remains necessary when the lead is omitted: siblings can
have different delivered values, including intentional reverts, and neither
sibling's baseline determines the lead's integrated tree.

## Replacement proof

The delivery fact already exists on this machine: the local worker record's
baseline and its private `refs/room/collect-head/<tag>/<id>` value identify the
immutable delivered worker tree. The existing provenance checks still verify
that ref, the baseline commit and lineage. Keep no longer requests or persists
a publisher acknowledgement; messages no longer retry one for kept workers.
The same witness now covers carried spawn inputs; no acknowledgement mechanism remains.

The guarantee is: every lead path used in a complete kept preview must come
from an authorized, complete shared publication, must match the observed local
lead version, and must remain that observed version while the preview is
certified. A private delivery ref alone never proves the lead's current bytes.
The preview locates the captured publisher's actual checkout through its
clone-local name lease and verifies the Git common directory and holder binding,
then reads only paths whose publication already permits text,
and compares their bytes. It merges the published text, never private disk
text. A missing/deleted mismatch, unreadable file, unsafe link, unavailable
checkout, stale publication, held or excluded path remains a gap. Committed
Git-clean files can use Git's clean representation; changed entries require
raw-byte equality. Witnesses are rechecked by the preview's freshness gate,
so unpublished lead edits invalidate a result. Replacement publishers need
valid current authority and matching bytes, without updating every worker.
The same rule applies to intermediate worker-leads in nested lineages.

This is a witnessed snapshot, not an atomic filesystem transaction. Other
processes can write between observations, as with the existing preview gates.
Paths excluded by the lead and unchanged by all contributors retain the
existing omission rule; local verification does not read their private bytes.

## Resumed worktree missing collected peer output

At 23:06:33.349 the lead receives lua-core’s question whether to edit old TS methods or have the lead
apply those edits. At 23:06:37.922 the lead takes the TS regions, and at
23:07:16.225 reports them done and tells lua-core to include `benchmark`.
A plain resume preserves the original worker copy and does not import peer
output. Current `refresh=true` rebases onto the lead's **HEAD** and therefore
requires the accumulated delivered output to have been committed there.
That restriction is inherent to this rebase operation, not inherent to Room
or Git. A simple correct merge rule exists: snapshot the uncommitted lead
tree as S, merge the worker's delta B→W since its delivered baseline B onto S,
refuse conflicts, install the combined tree uncommitted, and use S as its next
collection baseline. The next collection then returns only the worker's
changes relative to S. Such an explicit file-writing operation needs the same
ownership/recovery checks as collection and must preserve staged work; it is
not a safe one-line relaxation of refresh's containment check. Named peer
previews already provide the simple correct rule for testing combined live
work without rewriting the worker. Do not silently copy the lead tree or
weaken refresh's cumulative containment proof. No refresh behavior changes
are made in this slice.

## Validation and changed expectations

Baseline `bec10808be`, before changing production code: the new two-case
regression failed twice. A current lead publication plus pending records was
partial; a stale lead publication with existing acknowledgements was accepted.
The reproduction output is `/tmp/kept-repro.log` for this worker session.

The first focused lifecycle run finished with 42 passes and one failure: it
loaded the old malformed-ack expectation before that test was updated. The
corrected case subsequently passed in a 30-case focused run, alongside all
24 caller/order round-2 permutations, publisher replacement, held sharing,
real refresh and three-generation carry checks. The adversarial kept lifecycle
cases passed, including nested keep, second keep, resume, refresh, conflict,
scratch, discard and cleanup. No socket-related failure was observed here.

The named preview with `rohanz`, `rohanz+small`, `rohanz+discard` and
`rohanz+provenance` merged without conflicts, reported complete coverage, and
passed all nine new publication and local-witness checks. Its check took 66 s
on Darwin arm64 / Node 22.23.4, using linked dependencies and one Vitest worker.
A local run of those nine checks also passed. Typecheck and knip passed.
The lead still owns the full ordinary/scale suites and release bundle rebuild.

Changed expectations in existing tests:

- `collect-keep-adversarial`: a kept record has no persisted publisher
  acknowledgement; its version, baseline/ref, lifecycle and retention checks stay.
- `combined-kept-collect`: a replacement publisher is accepted directly after
  its current shared bytes are verified, rather than requiring every worker's
  acknowledgement to be rewritten.
- Its bookkeeping-only mutation now inserts pending obsolete metadata instead
  of incrementing the removed keep acknowledgement; it still cannot invalidate
  unchanged actual inputs.
- Malformed optional legacy acknowledgement metadata still preserves the worker
  and is decoded conservatively, but no longer makes a locally provable kept
  preview partial.
- The partial-sharing case keeps all refusal expectations and adds a check that
  the preview never opens the lead's local source files in that state.

No refresh semantics, sibling-only different-baseline refusal, delivery ref
semantics, sharing exclusions, conflict checks or carried-spawn acknowledgement
expectations were relaxed. The unavailable internal stage of the first five-
second acknowledgement attempt remains the audit's explicit uncertainty.

## Independent review follow-up

The review of c7555bef reproduced a missing location binding: a replacement
publisher under the lead's name could publish from another linked worktree or
separate clone while the witness still checked the old worker-parent checkout.
Both reviewer regressions were copied unchanged into
`test/review-kept-witness.test.ts`. Before this correction, both failed with
`complete=true, gaps=[]` (`/tmp/kept-review-before.log`).

The witness now requires Room's existing clone-local name lease at
`room/names/<hash-of-room-key-and-publisher-name>.json`. Its room/server key,
terminal publisher name, holder session ID, PID, process start time and executable
must match the captured publisher; its canonical worktree must match the root
being witnessed. This local fact connects the snapshot's current publisher to
the actual checkout on this machine. A common Git directory or name alone never
grants that proof. The lease is rechecked after byte verification by the
preview's freshness checks, so a location change without a new manifest also
invalidates the result. Unknown location remains partial, advising a preview
from the publishing lead checkout. In particular, a borrower or a moved lead is witnessed at the actual checkout
named by that lease, rather than inferring a location from the worker directory.
Without a local lease matching the captured publisher, the publishing lead must
perform the preview from its own checkout.

The remaining carried-spawn acknowledgement no longer accepts collection
after-images: that parameter and override branch have no production callers
after the keep handshake was removed. The exclusive fixed-after-image test was
removed; binary, CRLF, stale-scan and pending-retry tests still cover the live
carried-spawn path without collection-specific arguments or keep wording. Knip's
configured test entry points included those callers; its issue types concern
symbols/dependencies, not value-sensitive production call-argument reachability.
It therefore did not detect this unreachable argument-value branch.

The first corrected focused run passed all 36 checks across the unchanged
reviewer file, kept-preview regressions, local byte/location tests and remaining
carried-spawn acknowledgement tests. Both replacement cases now return partial.
No message acknowledgement was restored, and these follow-up changes remain
uncommitted as requested.

## One publication proof for carry and keep

No carry-spawn case was found where the old acknowledgement can prove a
current-checkout fact that the witness cannot. The acknowledgement's revision
floor can remain pending after the required publication exists, and it cannot
prove later unpublished edits in another checkout. The same facts apply to
tracked carry commits, separately carried untracked blobs, and kept baselines.
A focused carried-publication regression failed before unification solely
because no acknowledgement existed (`/tmp/carry-witness-before.log`); it now
uses the publisher's local location and byte witnesses without a message.

The final implementation deletes `kept-publication.ts`, its unused API tests,
all explicit record writers/adoption copies, the message retry and pending-gap
advice, and the optional-field shape validator. The legacy field is accepted
as ignored unknown data, including malformed old values; it has no authority
and is not part of any preview freshness input. New spawns do not create it.
The local name lease remains the single location fact for both mechanisms,
and a published path's current bytes plus the existing sharing gates remain
the single content proof.

Resolving the checkout directly from the matching name lease also removes
the worker-directory layout assumption. A lead in another linked worktree can
be verified there if its bytes are current; its unpublished edits invalidate
that witness. A separate-clone publisher cannot borrow a local clone's lease.
The retained reviewer replacements still must fail, while a current moved
lead has an explicit positive regression.

Final source delta: **+55 / −237 = −182 lines** against `c7555bef`, or
**+131 / −232 = −101 lines** against the original `bec10808` baseline, counting
only `packages/room-mcp/src`. Changes remain uncommitted.

After unification, 59 local publication/carry/baseline/exclusion cases and three
focused spawn/refresh cases passed. Complete all-peer previews passed 22
publication/location/reviewer checks and 12 carry/refresh/spawn checks on the
same source snapshot (`22c14e415ecf2174ec94e262c6581846117f9d033ebd182a7a52b7d70e7fd53d`).
Typecheck and knip passed. A borrower retry test initially expected an explicit
copy of the retired acknowledgement key (even when its value was undefined);
that expectation now requires no acknowledgement, while preserving all existing
baseline, incremental-collection and ref-inheritance assertions.

Further changed expectations from removing the mechanism: spawn no longer
reports a pending publication or creates that metadata; refresh messaging does
not request reconciliation; malformed legacy metadata is accepted as ignored
raw data rather than normalized into a pending proof. The carry tests use
current publisher/location facts instead of acknowledged revisions. Stale
frames, missing location facts, unpublished edits, exclusions, replacement
publishers, carried-untracked input and nested lineages retain their substantive
coverage. The removed standalone acknowledgement API tests describe behavior
that no longer exists; the location/byte witness tests cover the live proof.

## Full-suite fixture follow-up

The five `combined-excluded-carried.test.ts` cases reproduced unchanged on the
collected pre-0.17.49 tree. The synthetic lead had neither a manifest nor its
join-time local publisher binding: the fixture expected keep to invoke its
mock scan, which the removed acknowledgement handshake previously did. The
fixture now explicitly publishes after keep and calls `stampLocalPublisher`.
That helper supplies process identity on the published holder and stamps the
matching clone-local name lease. No production code or assertion changed.

All five cases pass: unchanged oversized carried output can be omitted; edited,
deleted, renamed and unreadable output still leaves a gap. Every case still
requires `new.txt` to contain `next edit\n`, omits the oversized `file.txt`, and
the rename still requires `renamed.txt`; the unreadable case still checks that
the failed baseline comparison ran. Nothing was removed.

The session audit found no supported live publisher path that omits the local
name lease or holder. `joinSession` uses `startAutoTaggedRoomd` for team rooms;
`joinLocal` uses the same function for local rooms. It constructs the process
holder and calls `chooseName` before `startRoomd`. `chooseName` calls
`acquireName`, which takes the clone-local lease before asking the hub for the
name; the hub's grant writes the holder mirror before replying. A failed local
lease stops the join. An unreachable hub retains the local lease but leaves
publication paused, so it cannot supply a complete current publication.
Headless leads have no bypass: `createSessionBinding.id()` supplies a synthetic
process session ID if no host session is bound. Missing process identity or an
unavailable lease remains unprovable, rather than authority to read another
checkout. A team publisher in a separate clone legitimately has no lease in the
worker's clone; a partial preview there is intentional, with the publishing
lead's checkout providing the supported alternative. The proof stays unchanged.

During this follow-up Room emitted `CONFLICT on
docs/superpowers/2026-11-13-kept-preview-publication.md:
docs/superpowers/2026-11-13-kept-preview-publication.md conflicts with rohanz's
version at lines 254` and `CONFLICT on
docs/superpowers/2026-11-13-kept-preview-publication.md: rohanz's earlier change
to docs/superpowers/2026-11-13-kept-preview-publication.md overlaps your new
claim`. The lead confirmed it was not editing the document and requested this
evidence. Its checkout held the untracked 252-line document copied at spawn;
the worker held those exact bytes followed by this new section (283 lines at
comparison time). The original bytes and the worker's corresponding prefix
both had SHA-256
`07944201e45165b5601a2680bbd19ec78ef13e4eb7ade64ca53b59f9cafb8df1`.
No carried line was edited. This notice did not describe a divergent edit;
the current combined preview is the integration check.

Follow-up validation on Darwin arm64 / Node 22.23.4, linked dependencies,
inherited scheduling priority 10: all 57 matching test files were run separately
from `packages/room-mcp`, each with `npx vitest run test/<file> --maxWorkers=1`.
The ordinary pass recorded 548 passes, one existing expected failure, ten skips
and one environmental failure. The four matching files containing scale cases
were then run separately with `TEST_SCALE=1`: `manifest-preview` (20 passes),
`preview-gate-scale` (6), `preview-run-cache` (8) and `preview-scale` (3), all
passing. The measured final synchronous gates at 1,000 and 2,000 files were
48.6 ms and 83.8 ms respectively. Ordinary sequential wall time was 916.5 s;
the four scale-file runs took 187.8 s. This is local evidence for this tree,
not a release-wide suite result.

The sole ordinary failure was `shell-publication`'s native-watch case:
`RoomdError: cannot watch <temporary checkout>: EMFILE: too many open files,
watch`, at `Daemon.startWatcher`, before publication assertions. Its polling
case passed. A fresh standalone Node process performing only recursive
`fs.watch` on an empty temporary directory reproduced the same `EMFILE` while
`ulimit -n` was 1,048,576. This isolates native watching in this environment
from the carried/kept proof; the test and production watcher are unchanged.
The lead must rerun native watching outside this sandbox. No socket failure
occurred in the requested sweep. `npm run typecheck` passed.

`npx knip` passed. The named preview with `rohanz` and
`rohanz+fix-discard` merged both workers' changes without conflicts and passed
all 38 checks (the five corrected exclusion cases, then all 33 `carry-wip`
cases, one file at a time). It was explicitly PARTIAL because the generated
`plugins/room/server/room-mcp.mjs` was excluded by the lead and exceeded the
historical read limit. That pass does not verify the omitted bundle or the
full combined tree. The peer completed during this preview, changing merge
order/publisher authority; a final current preview follows rather than treating
that moved snapshot as current evidence.

The final current named preview again merged without conflicts and passed
all 38 checks (5 + 33) on source snapshot
`83b19a51b9b53b6e60a77e809bc100c43445915427e3963e70af19fd39d62cd1`.
It reported no moved inputs. Coverage remained PARTIAL solely for the omitted
generated bundle, so this is evidence for the included sources and checks,
not complete combined-code verification. This final evidence paragraph changes
no input consumed by those tests. The follow-up leaves only the fixture edit
and appended audit/evidence, uncommitted; no expectations or proof code changed.
