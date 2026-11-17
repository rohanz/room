# Git-native local-worker conflict detection: feasibility study

2026-11-17. Baseline: `main` at `2152836ea8b5361ba631c81d4240c543224348a9`.
Study and disposable prototypes only; no production changes. Scope: one lead and
its own workers in a shared repository on one machine. Team comparisons retain
their publication-based method and sharing restrictions.

**Recommendation: build a reduced, observational version first.** Whole-tree Git
merges are a promising replacement for the local family's path enumeration and
text collision calculation. However, `snapshot(HEAD) + merge-base + merge-tree`
does not make delivery history appear in Git. It needs an explicit, durable
history protocol for spawn, partial delivery, user commits, adoption, reset and
refresh. Keep the current detector authoritative until that protocol agrees with
review scenarios and live sessions, including disagreement and failure cases.

## Evidence and reproduction

The scripts and raw outputs are in [2026-11-17-git-native/](2026-11-17-git-native/).
`correctness.test.ts` uses main's real spawn/carry, kept collection, refresh,
registry and `ConflictSet`. It reuses `worker-refresh-fixture.ts`: hosts and
publication transport are synthetic, files and Git operations are real, and all
test repositories are temporary. It does **not** launch actual coding workers.
It publishes complete text synchronously unless a row explicitly says otherwise.
This separates tree collision correctness from notice ownership and delivery.

Two native variants are evaluated:

- **HEAD parent:** each whole working-tree observation is a new commit parented
  only by that checkout's real HEAD. This is the attractive minimal proposal.
- **Event graph:** a private graph explicitly records a shared spawn snapshot,
  delivery merges and refresh anchors. The harness also maps controlled user
  commits and adoption into that graph. This is extra Room bookkeeping, encoded
  as commits rather than per-path JSON baselines. It is not an implementation of
  arbitrary real-world history reconciliation.

Rows are lifecycle-derived reproductions mapped to archived review case names;
they are not a claim that every archived test was rerun verbatim. Exact sequence
differences and untested transport cases are identified below. Main columns marked
**run** come from this harness against `2152836e`; **recorded** means the archived
author explicitly recorded the baseline behavior. An assertion aimed at a proposed
fix is not treated as a measured result on main.

Archive refs read for this study: `archive/own-baseline` at `9b0c203b`,
`archive/unchanged-proof` at `bd080f67`, and `archive/given` at `d25ded98`.
`rev22`, `rev27`, `rev28`, `rev29`, `rev32` and `rev33` below refer to the
reproducers under the lead's `.room/briefs/own-baseline-2026-11-16/` and
`.room/briefs/given-2026-11-17/` named in the task brief.

From the repository root:

```sh
python3 docs/archive/reports/2026-11-17-git-native/sandbox-probe.py
python3 docs/archive/reports/2026-11-17-git-native/measure.py > /tmp/git-native-measurements.json
GIT_NATIVE_RESULTS=/tmp/git-native-correctness.json node_modules/.bin/vitest run \
  --config docs/archive/reports/2026-11-17-git-native/vitest.config.ts
```

The normal main workspace tests are deliberately unchanged. There is no need to
rebuild the plugin or run release CI for this report and these isolated scripts.

## Correctness matrix

**Measured:** the event graph agrees with 50 of 51 expected collision outcomes;
one is a false negative requiring a partial-delivery rule. The HEAD-parent retrofit
agrees with 30/51. Twenty-one rows need the extra spawn/history rules to repair
that retrofit; merging a full skipped-scratch snapshot introduces the remaining
wrong answer. Main agrees in both directions on 37/51 (ten false positives and
four false negatives in this derived workload). These counts describe these
controlled sequences, not all archived tests or arbitrary Git histories.

The HEAD-parent column uses the current production branches, including distinct
carry commits. It does not install the idea's proposed common spawn commit. The
event graph installs that anchor and the additional lifecycle rules explicitly;
the difference is the cost of the required history protocol, not evidence against
Git's merge algorithm.

C = conflict; — = no conflict. Main shows both evaluator directions, all **run** against `2152836e`. “No conflict” includes absent slots; raw JSON retains slots and notice counts. This is collision evidence, not a claim that notice handoff/ownership was validated.

| Scenario (archived case mapping) | Expected | HEAD parent | Event graph | Main, both directions |
|---|---|---|---|---|
| 1. tracked: D edits, siblings untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 2. tracked: keep D, sibling untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 3. tracked: keep U unrelated output too<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 4. tracked: D edits again after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 5. tracked: lead commits kept output<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 6. tracked: both edit before keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 7. tracked: both edit after D keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 8. tracked: two keeps, D third round/U edit<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 9. tracked: disjoint edits<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 10. tracked: disjoint edits after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 11. untracked: D edits, siblings untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 12. untracked: keep D, sibling untouched<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 13. untracked: keep U unrelated output too<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 14. untracked: D edits again after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 15. untracked: lead commits kept output<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 16. untracked: both edit before keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 17. untracked: both edit after D keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 18. untracked: two keeps, D third round/U edit<br><small>archive/given:stale-carried-conflict.test.ts</small> | C | C | C | C / C |
| 19. untracked: disjoint edits<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | — / — |
| 20. untracked: disjoint edits after keep<br><small>archive/given:stale-carried-conflict.test.ts</small> | — | C | — | C / C |
| 21. lead reverts delivered text; D changes again<br><small>stale-carried-conflict:revert</small> | C | C | C | C / C |
| 22. lead reverts; unchanged D versus U edit<br><small>unchanged-kept:republish then lead reverts</small> | C | C | C | C / C |
| 23. kept worker commits later edit<br><small>own-baseline:committed post-keep edits</small> | C | C | C | C / C |
| 24. both adopt C by fast-forward, D reverts<br><small>rev32/rev33:common adoption</small> | C | C | C | C / C |
| 25. both adopt C by merge, D reverts<br><small>rev32/rev33:common adoption</small> | C | C | C | C / C |
| 26. only D adopts C<br><small>rev33:only adopter</small> | — | — | — | C / C |
| 27. only U adopts C<br><small>rev33:only adopter</small> | C | C | C | C / C |
| 28. D resets away C after both adopt<br><small>rev33:reset</small> | C | C | C | C / C |
| 29. both adopt C, committed revert<br><small>rev33:committed revert</small> | C | C | C | C / C |
| 30. both adopt merge resolution C<br><small>rev33:merge resolution</small> | C | C | C | C / C |
| 31. committed tracked deletion<br><small>rev22:committed deletion</small> | C | C | C | C / C |
| 32. committed rename versus sibling edit<br><small>roadmap:F5 rename</small> | C | C | C | C / C |
| 33. untracked draft committed then deleted<br><small>own-baseline:F5 untracked deletion</small> | C | — | C | — / — |
| 34. scratch add/add remains after keep skipped it<br><small>unchanged-scratch:results.log</small> | C | C | C | C / C |
| 35. refresh accepted with disjoint worker edit<br><small>stale-carried-conflict:refresh</small> | — | C | — | C / C |
| 36. refresh conflicting, unchanged on refusal<br><small>given-baseline:conflicting refresh</small> | C | C | C | C / C |
| 37. shared adoption revert without keep<br><small>rev29:cold</small> | C | C | C | C / C |
| 38. shared adoption revert, prior conflict existed<br><small>rev29:existing conflict</small> | C | C | C | C / C |
| 39. later worker same bytes after lead commits and reverts<br><small>rev33:late U</small> | — | C | — | — / — |
| 40. equal current blobs after distinct histories<br><small>given-adoption:equal blob</small> | — | — | — | — / — |
| 41. adopt common unrelated commit, untracked draft survives<br><small>rev22:untracked common ancestor</small> | — | C | — | — / — |
| 42. supplement: scratch skipped, lead later adds competing log<br><small>unchanged-scratch:results.log, extended to lead</small> | C | C | — **needs rule** | C / C |
| 43. supplement: kept D reverts to given G, U edits<br><small>stale-carried-conflict:kept worker uses revert</small> | — | C | — | C / C |
| 44. supplement: committed revert to O without adoption<br><small>given-adoption:committed revert without adoption</small> | C | — | C | — / — |
| 45. supplement: adopted addition deleted versus edit<br><small>given-adoption:adopted addition</small> | C | C | C | — / — |
| 46. supplement: actual later spawn after lead change/revert, only U adopts<br><small>rev33:U given X after lead change and revert</small> | C | C | C | C / C |
| 47. supplement: merge adoption after independent commits<br><small>given-adoption:merge adoption</small> | C | C | C | C / C |
| 48. supplement: carried staged addition, committed deletion<br><small>own-baseline:committed deletion of carried staged addition</small> | C | — | C | — / — |
| 49. adopted 1000 files both delete, conflict survives<br><small>rev33:candidate cap</small> | C | C | C | C / C |
| 50. supplement: common unrelated adoption after keep<br><small>given-adoption:unrelated adoption</small> | C | C | C | C / C |
| 51. supplement: successful refresh after keep, then both edit<br><small>stale-carried-conflict:successful refresh (extended)</small> | C | C | C | C / C |

All 51 rows have measured output after focused reruns. The initial 42-case run
had 40 passing harness cases and two setup failures: one accidentally committed
an untracked draft before adoption, and the 1,000-path publisher hit the imported
fixture's 30-second timeout. The corrected untracked setup leaves the draft out
of real HEAD; the publisher now batches `ls-tree`, and the test has an explicit
120-second limit. Both were rerun successfully. A staged-add deletion initially
used same-second identical carry commits, masking the reviewed case; its focused
rerun uses distinct dates and reproduces the missed deletion. A final focused
run uses an actual two-parent C resolution. Raw failed and successful runs are
retained, and `summarize.py` documents which focused result supersedes each row.
One test-name filter matched zero cases; that skipped run is retained and was
not counted as validation. No final full 51-case run was claimed: the union of
completed cases and relevant reruns supplies the table.

The earlier “later worker same bytes” row uses a reset onto the later lead commit
as an ancestry surrogate. The supplementary “actual later spawn” row exercises
the real later spawn and only-U adoption sequence. The scratch/lead follow-up,
post-refresh second edits and some repeated-keep rows extend the review sequences
to isolate the proposed event rules. The test runner records collision results;
its own passing status is not an assertion that every proposed rule is correct.


### Review coverage outside the tree collision calculation

These remain explicit cases; a Git merge result cannot certify them. “Untested”
means this study did not measure the exact review sequence on main.

| Archived review case | Required result / concern | Git-native result | Main evidence |
|---|---|---|---|
| `own-baseline.test.ts`, retained listed/omitted pre-keep publication, with/without late edit (four cases) | Do not bind old publication bytes to a later delivered snapshot; preserve a real overlap | Requires generation-bound snapshots and atomic delivery publication; disk-only comparison bypasses this transport question | Archive/given asserts conflict/possible; exact four transport sequences untested here |
| `rev27-unchanged-review.test.ts`, listed/omitted keep then resumed live edit before lead publication | At least one responsible pair and active notice must survive handoff | Requires authority and notice transaction, beyond `merge-tree` | Reviewer reproducers target unchanged-proof fix; main exact notice sequence untested here |
| `rev28-handoff.test.ts`, republish before lead scan / then lead reverts / lead publishes before lead-U evaluation | Real D/U overlap cannot become silent because evaluation order changed | Local tree read can find overlap, but cannot assign/clear notices atomically | Exact ordering untested; tree-equivalent lifecycle rows are measured |
| `rev27-unchanged-review.test.ts`, real resumed daemon publication delay | Publication is asynchronous (300 ms default debounce) | Needs dirty notifications plus rescan/freshness protocol | Timing test not rerun; no new latency claim |
| `rev28-lead-identity.test.ts`, unrelated holder reusing lead name | Never accept a different checkout/session as delivery witness | Still needs incarnation, checkout ownership and lease fences | Review helper exists only on proposed branch; no comparable main helper |
| `own-baseline.test.ts`, raw wrong-fence manifest entry | Unknown, never certify omission as unchanged | Preserve fence/coverage checks wherever publications are consumed | Marked pre-existing F6 in archived test; exact sequence untested here |
| `own-baseline.test.ts`, earlier-change claim notice clears while claim stays open | Old owed notice must withdraw | Keep claim/ledger lifecycle; merge-tree returns no notice IDs | Archived test marks pre-existing F7; exact ledger sequence untested here |
| `unchanged-bridge.test.ts`, never-kept untouched worker versus another family's worker | No false possible-conflict from inherited draft | Keep team projection and per-family/private routing | Review describes pre-existing team projection defect; out of local-only prototype |
| `unchanged-worker.test.ts`, missing/deleted/hashless/wrong-fence/incomplete/excluded/unreadable proof inputs | Absence of proof must not mean clean | Unknown on missing snapshot, policy gap or lost authority | Proposed helper unit cases; not a main tree-merge API |
| `given-baseline.test.ts`, immutable given refs, old records, failed refresh registry write then pruning | Retain reachable authoritative history or refuse comparison | Durable ref/journal transaction and restart reconciliation required | Proposed schema is not on main; fault injection not rerun |
| `stale-carried-conflict.test.ts`, old record / missing given commit / missing given blob | Conservative compatibility fallback | Never infer ancestry from unavailable objects; fall back or unknown | Proposed given schema only; not measured as native success |
| `given-adoption.test.ts`, current blob before given adoption, U text held by scope | Conflict or possible, not a quiet current-blob proof | Raw local trees bypass the held publication; preserve policy gaps and the correct adopted ancestor | Archived `it.fails` explicitly records the same quiet result on `2152836e`; exact held transport case not rerun |
| Contracts and claim impact across these sequences | Signature/consumer warnings and claimed line overlap remain useful | No contract/claim analysis from merge-tree | Existing behavior stays; no replacement proposed |

### What history must mean

**Reasoning, supported by the lifecycle experiments:** a content-addressed tree is
an observation, not evidence that either party received it. Equal content at two
spawn times is not a common ancestor. Sharing one spawn snapshot for workers
actually started from the same state is valid; identifying unrelated spawn
events by tree ID alone is not.

For a complete successful keep, let `L0` be the lead's pre-collection observation,
`W1` the delivered worker observation, and `T` the resulting lead tree. Create a
private commit `M = commit(T, parents=[L0,W1])`. The next lead observation descends
from `M`; the next worker observation descends from `W1`, **not M**. That keeps
lead-only edits out of the worker's starting point. An untouched sibling retains
its original spawn ancestor. Neither repeated observations nor a new keep moves
that sibling's parent just because its contents happen to match.

Do not put these commits on the user's branch or touch their index. The current
working tree and ordinary user commits remain under their control. Consequently
ordinary commits do not automatically inherit this private history. A coordinator
must record the relationship between observed real HEAD transitions and private
events. A user merge/fast-forward which both workers adopt must advance their
common starting point to that adopted implementation; an intentional revert after
adoption is a change. A one-sided adoption advances only that side. A reset must
drop the adopted parent, rather than chaining its new snapshot to the last
observation and accidentally preserving an adoption that Git history abandoned.
The harness controls these transitions explicitly; automatic recognition of
arbitrary external operations is an unimplemented, high-risk part of the design.

**Partial keep needs a different rule.** Collection skips some scratch output
(the review's `results.log` is normally publishable). A merge parent containing
that output falsely acknowledges its delivery even when the resulting lead tree
does not contain it. Build a delivery commit whose tree contains exactly the
accepted output and the relevant prior tree, then parent the next worker
observation on that delivery commit while retaining its undelivered scratch as a
delta. Merge that delivery commit into the lead's private line. The accepted path
mask already exists during collection, but must be captured atomically with its
tree and journal. Merely merging the full worker observation and overriding its
scratch paths in the lead result is insufficient.

For **successful refresh**, anchor the post-refresh observation to the lead's
accepted committed state plus the actual rebased worker delta. Do not merge the
worker's pre-rebase line as another parent merely to preserve history: rebasing
rewrites that ancestry. A refused or conflicted refresh must leave snapshot refs
and the working tree unchanged. Serialize the existing refresh transaction with
the private history transaction; its existing safety/containment tests still
apply. Refreshing an unchanged HEAD, which main treats as a no-op, must not invent
delivery. Test restart between Git writes and registry writes explicitly.

**Carried untracked drafts need care during adoption.** A common ordinary commit
may omit a draft both workers actually received. Using that real commit directly
as the snapshot parent loses the draft ancestor and turns disjoint edits into an
add/add conflict. The event graph must preserve the shared draft in the mapped
adoption tree, or apply an explicit carried-input rule. The prototype's full-tree
shadow mapping represents this fact; it does not prove that arbitrary carried
drafts can be mapped globally without context.

## Who can snapshot

**Measured, un-escalated in this worker's actual worktree:** Git 2.45.2 resolves
the common directory outside this worktree, to the lead repository's `.git`.
The complete command results are in `sandbox-results.jsonl`.

| Probe | Result |
|---|---|
| `git hash-object -w --stdin` with new bytes | Exit 128: `error: unable to create temporary file: Operation not permitted`; `fatal: Unable to add (null) to database` |
| `GIT_INDEX_FILE=/tmp/... git read-tree HEAD` | Success: private index is writable |
| Private-index `git write-tree`, unchanged HEAD tree | Success: existing tree object reused |
| `update-index --add --cacheinfo` followed by `write-tree` for a new tree | Index update succeeds; write-tree exits 128: same temporary-file error; `fatal: git-write-tree: error building trees` |
| `git commit-tree HEAD^{tree} -p HEAD ...` | Exit 1: temporary-file error, `Operation not permitted` |
| Same worktree with temporary `GIT_OBJECT_DIRECTORY` and common objects as read-only alternate | New blob, changed tree and commit all succeed |

These plumbing invocations cannot produce **shared-store** snapshots here. A
private object store is possible, but needs an explicit object transfer/alternate
lifecycle; its temporary success is not a shared Git graph. All correctness and
cost snapshots were made in writable temporary repositories, not in the live
shared object store. No escalation was used for these probes.

**Execution-surface caveat observed while preparing the authorized report commit:**
ordinary top-level `git add` successfully staged the new report and scripts in
this worktree. Immediately afterward, both direct-shell `hash-object -w` and
`commit-tree`, and the Python-driven probe again, still returned the same sandbox
errors. Thus “the worker cannot write any Git objects” is too broad: sanctioned
Git editing commands can write objects here, while the snapshot plumbing tested
cannot. This study did not establish the host's permission mechanism, permission
portability, or that a worker daemon can inherit the normal-command permission.
Do not design unattended snapshot writes around an unverified exception. A
lead-side snapshotter with explicit shared-directory authority avoids depending
on that exception. The probe transcript records the original plumbing tests;
these final command observations are reported separately, not substituted for
those errors.

**Lead-side implementation sketch (reasoning):** reuse the private-index pattern
already used by `saveDiscardRecovery` in `worker-git.ts`, but apply coordination
policy rather than the broader recovery policy. A lead with Git-directory write
authority uses a separate reusable index per verified worker incarnation:

```sh
GIT_INDEX_FILE=<private-index> git --git-dir=<common-git-dir> \
  --work-tree=<verified-worker-root> read-tree <accepted-anchor>
# Enumerate/filter eligible paths; feed a NUL-delimited literal pathspec file.
GIT_INDEX_FILE=<private-index> git --git-dir=<common-git-dir> \
  --work-tree=<verified-worker-root> add -A --pathspec-from-file=<paths> --pathspec-file-nul
# write-tree, commit-tree with protocol parents, CAS-update only owned refs.
```

Do not use unfiltered `add -A .` as a production implementation. The benchmark and
toy fixture do that deliberately and claim only Git's cost, not policy parity.
Include allowed untracked paths explicitly (`ls-files --others --exclude-standard`
or the existing bounded disk scan), include tracked deletions, and remove excluded
paths from the private index without reading their current bytes. Gitignore does
not exclude a tracked `.env` or enforce `.roomignore`.

Reuse `roomd`'s current checks: `.gitignore`, `.roomignore`, default ignored
directories/extensions and private `.env` paths, tracked-only lockfile rule,
unsafe-link/nested-repository protection, binary treatment, 512 KiB per-file and
8 MiB changed-text/base budgets. Unreadable, over-64-KiB or over-2,000-pattern
`.roomignore` fails closed or keeps last valid rules. Carry/collection's 5 MiB
per-file / 50 MiB carry limits are different: do not silently widen conflict
snapshot permission to match them. The lead's local read authority does not grant
permission to publish those bytes into a team room.

Excluded paths must be carried forward as unchanged anchors **with an explicit
coverage gap**, or omitted consistently from all eligible comparison trees.
Omitting a changed excluded path from just one tree falsely represents deletion.
Never let an empty filtered result mean “all clean.” Preserve digest-only/possible
and unknown behavior where policy prevents an exact comparison. Policy version is
part of snapshot identity and comparison validity.

## Cost

**Measured conditions:** Apple M2 Max, Mac14,5, 12 logical CPUs, 32 GiB RAM;
macOS 26.5 (25F71), Git 2.45.2. Worker budget: three threads and about 8 GiB;
Git commands were serial. This checkout actually has **1,492 tracked files**, not
about 1,900. Its fixture is an archive of exactly `2152836e`, reinitialized with
all archived tracked files (including tracked ignored assets). The generated
fixture has 20,000 small text files in 100 directories. No other repository was
read or copied. Every fixture and linked worktree was deleted afterward.

Five repetitions per case; medians below in milliseconds, with all samples in
`measurements.json`. Snapshot timings include `add -A`, `write-tree`, `commit-tree`
and, on first use, `read-tree`; an unchanged clean initial tree is still hashed
through a fresh private index. No user index is used. Repeat samples edit the
same single file to different bytes each time. Merge inputs are prepared outside
the timer. Filesystem/object caches are warm from setup; there is no cold-cache
or fsync durability benchmark. The final pass ran after this worker's correctness
jobs ended; the machine itself was shared and not isolated. An initial requested
`nice -n 10` adjustment was denied (`setpriority: Operation not permitted`); no
claim is made about effective scheduler priority. Peak RSS was not measured.

| Operation | Repository (1,492 files) | Generated (20,000 files) |
|---|---:|---:|
| First snapshot (new private index) | 663.140 | 802.355 |
| One changed file, private index reused | 55.213 | 69.194 |
| Family, 7 snapshots + 21 merges | 389.813 | 664.704 |
| Dirty worker cache, 1 snapshot + 6 merges | 88.950 | 131.320 |
| Identical peer inputs, 1 snapshot + 1 merge | 42.378 | 89.092 |
| merge-tree, 0 differing paths (clean) | 12.448 | 8.039 |
| merge-tree, 10 differing paths (add/add collisions) | 20.268 | 8.724 |
| merge-tree, 200 differing paths (add/add collisions) | 93.961 | 23.563 |
| merge-tree, 4000 differing paths (add/add collisions) | 1113.798 | 282.801 |
| merge-tree, 10 paths each side, disjoint clean additions | 11.826 | 9.554 |
| merge-tree, 200 paths each side, disjoint clean additions | 8.201 | 8.326 |

The family fixture has seven actual linked worktrees, each with its own reused
private index; one worker edits one file, and otherwise all seven begin with the
same tree and ancestor. It does **not** reproduce main's 200-path workload.
Without caching it performs seven snapshots and 21 unordered merges: **42 Git
commands** after index initialization. Reusing unchanged participant snapshots and
pair results leaves one snapshot and six affected pairs: **9 commands**. In this
special identical-peer fixture those six comparisons have identical inputs, so
one cached collision-path result serves all six: **4 commands**. General peers
with distinct trees/bases still need six merges. Seven private indexes must be
initialized once (four commands per initial snapshot). Rebuilding all seven
indexes on every event would discard most of the gain.

“Cache by tree ID” alone is unsafe. Two equal trees may have different shared
ancestors, and adopted/reverted history can change a collision without changing
those trees. Include the input snapshot/anchor identities, relevant merge bases,
policy/coverage version, Git attributes/configuration and algorithm options in
the key. This fixture's one-merge optimization is valid because both peer trees
**and ancestry** are identical. It caches symmetric collision paths only; an
orientation-sensitive merged tree, stages, labels or line coordinates require
an orientation-aware key. The prototype simulates dirty notifications rather
than implementing a daemon cache. Add actual rescan, policy planning, ref/CAS,
freshness, notice/claim/contract and event-journal work to obtain product latency.

The brief supplies main's six-worker / 200-path result: approximately **2,464 Git
commands, 16 seconds without pacing, about 50 minutes with pacing**. That was not
rerun here. The budget-fix owner subsequently clarified the workload directly:
only the changed worker's owner reconciles against its five siblings and lead
(six peers), **not all seven owners or all 21 unordered pairs**. Setup is excluded;
the repository Git observer and merge-helper counts are separate. This further
limits comparison with the all-pair family measurements above.

**Peer-reported evidence, not measurements by this worker:** `rohanz+budget`
identified `packages/room-mcp/test/merge-budget.test.ts:142`, failing-test commit
`d19313dc` on `2152836e`, ported from `9c7ab354`. With only the pacing delay mocked,
its pre-fix cold/warm runs used **2,464 / 2,061 repository commands**, **1,200 /
1,200 budget admissions and merge-helper calls**, and **zero actual three-way
Git subprocesses**: the helper returns early for these unchanged versions. Its
elapsed times were **25.936 / 19.206 seconds**; it could not source the brief's
16-second figure. The roughly 50-minute figure is **inferred**, not an observed
wait: 1,200 admissions at four per ten seconds. Do not describe all 2,464 calls
as `merge-file` subprocesses or the 50 minutes as a completed measurement.

The peer's fix `d0881064` removes those admissions/helper calls while leaving
conflict Git-read counts unchanged; its warm count included 17 housekeeping
commands consistent with an automatic retirement sweep. That fix addresses
pacing separately from a Git-native architecture. Whole-tree comparison can
reduce the remaining process count, but different fixtures, evaluator counts
and setup mean a wall-clock product speedup ratio would be misleading.

There was substantial run-to-run variability. The retained initial run overlapped
this worker's correctness jobs and used a slower fixture-building loop; the
second and final runs did not. Repository first-snapshot medians were 333, 864
and 663 ms; generated first-snapshot medians were 5,198, 2,059 and 802 ms. The
second run also measured content-line recovery, while the final run added the
identical-peer result-cache case. All raw runs are retained. These five-sample
medians establish a plausible scale, not a tight latency bound; investigate cache
state and shared-machine contention before setting a service target.

Reading the already-created conflicted blob took **8.161 ms** median; fetching three inputs and rerunning `merge-file --diff3` with temporary-file creation/removal took **30.738 ms** for the tiny content conflict. Batched blob reads could reduce that latter overhead; that optimization was not measured.


## What merge-tree reports

Git added the modern two-commit merge-tree mode in 2.38.0. The 2.45 documentation
describes content, rename and directory/file merging, including virtual merge-base
construction. It does not update a checkout or index, but **does write objects**;
“in memory” must not be read as “no Git-directory writes.”
[Git 2.38 release notes](https://raw.githubusercontent.com/git/git/v2.38.0/Documentation/RelNotes/2.38.0.txt),
[Git 2.45 merge-tree manual](https://git-scm.com/docs/git-merge-tree/2.45.0).

**Measured output (Git 2.45.2):** each default stdout starts with the result tree
OID, followed by the stage entries and messages shown below. Exact OIDs, complete
messages, stderr and one `-z` output are in the raw JSON, rather than shortened or
normalized away. The table describes those observed outputs, including conflict
cases where there is no meaningful text line number.

| Inputs | Exit / stages / message | Observation |
|---|---|---|
| Both modify the middle line | 1; stages 1/2/3 for `f.txt`; `CONFLICT (content)` | Conflicted result blob contains markers |
| Different additions of `new.txt` | 1; stages 2/3, no stage 1; `CONFLICT (add/add)` | No base file to number |
| Delete `f.txt` / modify it | 1; stages 1/3; `CONFLICT (modify/delete)` | Modified version left in result tree |
| Same `old.txt` renamed to two names | 1; stage 1 old path, stage 2 `new-a.txt`, stage 3 `new-b.txt`; `CONFLICT (rename/rename)` | Conflict involves three paths, not just a single source filename |
| Rename / disjoint content modification | 0; result tree OID only | Rename detection combines the content edit cleanly |
| NUL-containing binary modified on both sides | 1; stages 1/2/3; warning `Cannot merge binary files`, then `CONFLICT (content)` | Reports collision; no text hunk/line report |
| Executable bit on one side, content on other | 0; result tree OID only | Inspected result is mode `100755` and contains the other side's edited text |
| Symlink/file type change versus content edit | 1; symlink at `f.txt` plus synthetic suffixed file path; `CONFLICT (distinct types)` | Preserve all affected paths; not just the original path |
| Two 8 MiB text additions | 1; stages 2/3; `CONFLICT (add/add)` | Raw Git merges beyond Room's policy caps; this does not authorize including them in coordination snapshots |
| 4,000 simultaneous add/add collisions | 1, all 4,000 unique paths reported | A separate one-base-file probe counted `--name-only -z` output (654,492 bytes); no Room-style 2,000-path cap in this tested invocation |

For example, the content conflict's exact stage lines are:

```text
100644 ed61fcea92607a5d5bb4610d9bd5b3f11802db1a 1	f.txt
100644 e7881154c61d5627ecf7fa43e0cca0aa40ce9006 2	f.txt
100644 42b8e7ae1e2844a32bba4efa973528fbf7907b9b 3	f.txt

Auto-merging f.txt
CONFLICT (content): Merge conflict in f.txt
```

The 8 MiB add/add merge took **419.668 ms** median (five runs). The 4,000-path merge took **1113.798 ms** on the repository fixture and **282.801 ms** on the generated fixture. These are bounded examples, not an upper bound for arbitrary file sizes, pathological diffs or rename searches. Production should keep byte/path/output/time budgets and return unknown on exhaustion.


The raw exact stdout/stderr, including tree and blob IDs, are retained in
`measurements.json`; do not parse English human messages in production. Use
`--write-tree -z` and the structured stages/path list plus typed information
records. Exit 0 is clean, 1 is conflict, other exits are failure/unknown. An
explicit prior `merge-base` invocation is unnecessary for the normal two-commit
mode; merge-tree finds and consolidates bases itself. Do not pass an arbitrary
single result from `merge-base` when multiple bases exist.

There are no source line ranges in that structured result. Reading a conflict
blob from the returned tree gives markers, but ordinary markers omit the base,
and positions in marker-laden merged output are not automatically Room's existing
`GitMergeResult.conflicts[].from` coordinates. Preserve current notices by fetching
the relevant three inputs and running existing `gitMergeFile` **only for actual
text-conflicted paths**; batch object reads instead of one subprocess per blob.
Rename/type/binary conflicts need path-level explanations; fabricated line 1 is
not an exact line location. Legitimate marker-looking user text and custom merge
drivers need tests before reusing a marker parser.

Git's clean result proves a syntactic merge under its attributes/configuration,
not semantic compatibility, claim compliance, public API compatibility or safe
collection. Custom merge drivers, clean filters, `.gitattributes`, renormalization,
LFS, submodules, symlinks, sparse checkouts, case-only renames and Windows remain
unverified by this prototype. A production snapshot must explicitly choose and
test raw-byte versus Git-clean-filtered semantics rather than changing what users
are warned about accidentally.

## Replacement boundary and evaluation ownership

**Source review at main:** `conflict-set.ts` is 1,456 lines. Roughly lines 854–1133
contain the principal pair/path merge loop; it also invokes contracts and claims.
Other sections handle slot state, notice replay, publisher/lease fencing,
incarnation-bound retirement and bridge routing. A whole-tree engine replaces a
local **input/merge provider**, not that entire file.

| Component | Proposed disposition |
|---|---|
| Local-family `carriedPass`, `pairBaseline`, shared-carried-blob reconstruction and candidate intersection | Replace for the new local provider only; team/compatibility callers still need the old path |
| Local per-path historical reads, identical/unchanged rules, hundreds of `merge-file` launches | Replace with snapshot trees and one whole-tree merge per affected pair; retain line rendering for conflicted text |
| Claims, claimed ranges, earlier-change attribution and auto-release of landed claims | Keep; adapt their changed-path/ancestor input, preserving their own semantics |
| Observed contracts, graph consumers and bounded contract cache | Keep; a clean Git merge says nothing about API use |
| Slots, notice IDs, episode join/clear/replay, recipient priority, worker retirement | Keep; feed evidence through existing guarded settlement rather than posting duplicate notices |
| Publication authority, identity, policy/coverage and clone-local checkout verification | Keep; coordinator snapshot authority needs equal care |
| Team-room comparisons and two-lead bridge | Keep manifest comparisons; replace only internal local-family evidence source |
| Worker collect/refresh journals, recovery pins, branch/worktree ownership | Keep; add private graph event writes atomically to these transactions |

**Proposed ownership, not implemented:** one elected/fenced lead coordinator per
worker family owns snapshot writes and unordered pair evaluation. Workers'
existing daemon watchers publish an incarnation-bound dirty sequence and real
HEAD observation into their private local room; no file text need cross a team
boundary. The coordinator debounces/coalesces, verifies the exact worker checkout,
captures bounded trees, and confirms dirty sequence/HEAD/policy stability before
settling. File reads during `add` are not an atomic multi-file snapshot: retry on
changed inputs and retain unknown/stale evidence rather than certify a torn scan.
Use periodic reconciliation to recover lost dirty events and offline workers.

A worker event needs at most its six affected unordered pairs in a family of
seven. Worker processes consume the existing local-room slots/notices; they must
not independently rerun the entire family computation or fight over slot owners.
Claims/contracts can remain per-session initially. A lead-only evaluator requires
an explicit authority rule for writing both recipients' evidence; current
per-owner fence checks cannot simply be bypassed. Retain notify/fyi priorities and
incarnation-bound notice retirement.

On lead restart, main currently stops managed workers and retains their sessions.
Load the private refs and journal under the same verified family identity, rebuild
disposable indexes/caches, revalidate real HEADs and checkout identity, and rescan
before publishing fresh results. Old refs are not proof that current disk matches.
Another session taking the same human-readable name must not adopt the graph.
Missing/corrupt snapshots are unknown/fallback, never an empty conflict set.

The bridge still needs policy-filtered changed paths, hashes, sizes, claims and
worker identity so remote families can evaluate possible conflicts. Feed those
from existing worker publication, or a policy-equivalent snapshot-to-manifest
projection, guarded by the lead's live fence. Do not project private snapshot refs
or Git object bytes. Local exact results settle only the family's private pairs;
cross-family team pairs keep manifest handling and both leads' responsibilities.

**Planning estimate, not measured implementation size:** an observational initial
provider could touch 4–7 production/test files and add about 300–600 lines plus
focused tests, retaining the old authority. A replacement with durable history,
lifecycle transactions, restart/GC, policy parity and bridge integration is more
plausibly 12–20 files and 1,000–2,000 added/changed lines plus regression tests;
perhaps 150–300 old lines become removable once compatibility permits. The risks
are ancestry mapping after external Git operations, partial delivery, atomic
keep/refresh/ref recovery, snapshot authorization, torn scans and notice handoff.
This is not a 1,456-line deletion justified by a fast merge benchmark.

## Snapshot retention and garbage

**Proposed protocol:** private refs under a family/incarnation namespace such as
`refs/room/conflict/<family-id>/<worker-id>/anchor` and `/current` pin authoritative
events and latest observations. Use verified ownership receipts and expected-OID
CAS writes/deletes; do not use a tag as identity. Repeated unchanged trees and
unchanged ancestry should reuse the same observation, avoiding timestamp-only
commit churn. Keep disposable private indexes under clone-local Room state with
bounded ownership/lifetime; workers never touch the real index.

Replace current observation refs after stable scans. Old leaf observations then
become unreachable unless a delivery event references them. Event ancestors
remain reachable through the latest ref: dropping old ref names alone does not
bound the history. When a family ends, delete only its verified private refs and
indexes; Git's ordinary grace-period GC eventually reclaims unreachable objects.
Do not run `prune --expire=now` in a shared live repository. Snapshot cleanup must
not remove ordinary user refs, carry/collection refs still used by the old method,
or the separate recovery pins that protect work during discard.

Collection that ends a worker and explicit discard can remove that worker's
current ref, cache entries and index **after** successful preserved cleanup and
notice retirement. A kept worker retains its delivery anchor and observation.
If the lead's merged event still parents the worker event, those objects remain
reachable until lead-family graph retirement or safe compaction. Crash journals
must distinguish an intended write, a committed delivery and a failed operation;
cleanup never infers authorization from a missing worker view.

Long-lived families need a measured retention budget and a safe checkpoint
protocol: coordinate a new shared anchor only when all retained participants'
relationship to it is proven. Rebasing the private graph to cap depth without
that proof recreates the original baseline problem. A separate temporary object
store offers deterministic whole-store deletion, but requires stable access to
base objects, transfer/pinning guarantees against the main repository's GC and
its own restart identity. That alternative was probed for write access, not
validated as a complete retention system.

## Smallest useful increment

Start with a lead-side **shadow comparator**, on demand and then debounced, for
verified local family pairs with a proved common starting snapshot and complete
eligible coverage. Keep ordinary Git history and user files untouched. On a stable
capture, compare whole-tree Git collision paths with the authoritative main
provider; record only pair incarnation, input OIDs/policy versions, timings,
status and differing path sets in local bounded diagnostics. No extra user-facing
notices and no content export. On unsupported lifecycle/history/policy inputs,
report “not comparable” and keep the existing result.

This first increment is useful as a cost/correctness oracle for ordinary work and
avoids pretending a history protocol has already been solved. Extend comparison
to kept/partial collection and refresh only after their private event protocol is
implemented and passes the counterexamples here. Require zero unexplained false
negatives, explicit error/unknown behavior, and live restart/recovery evidence
before switching local notices. Keep team rooms on the current method.

## Limits of the evidence

This is one macOS/Git/sandbox configuration and temporary fixture runs, not a
production integration or cross-platform guarantee. The study did not validate
arbitrary external Git transition discovery, crash atomicity, six actual coding
workers, watcher-to-notice latency, bridge/claim/contract equivalence, GC under
concurrent writers, or a full policy-equivalent snapshotter. Main's reported
2,464-command / 16-second unpaced / roughly 50-minute paced workload is supplied
baseline evidence from the brief, not independently rerun here; the peer's more
specific measurements and the inferred nature of the paced figure are stated
above. Timing raw Git establishes feasibility, not a like-for-like product speedup.

Final artifact checks parse Python/JSON, recompute timing medians, verify all 51
scenario IDs are represented, and verify the documented native counterexample.
The same lightweight checks run in a Room preview with `rohanz` and
`rohanz+budget`; this checks document/data integration, not the production change
or a fresh collision benchmark against their newer code.

## Imported evidence

Raw result files longer than 200 lines were omitted from this checkout. Their exact originals remain on local branch `archive/gitnative` at `7806c05b`, under `docs/archive/reports/2026-11-17-git-native/`. The report above describes those archived measurements; importing it does not rerun them. Omitted files: `correctness-results.json`, `measurements-initial.json`, `measurements-second.json`, `measurements.json`, `results.json`, `supplement-results.json`.

## Shadow implementation

The opt-in implementation keeps today's detector authoritative. `conflict-shadow.ts` owns the lead-only queue, verified family membership through a read-only registry (no lifecycle recovery, shared watcher or registry writes), lifecycle events and local diagnostics; `shadow-snapshot.ts` reuses roomd's `readDisk` and publication `plan`, including per-file and changed/base text budgets; `shadow-graph.ts` owns the disposable bare repository, private indexes, expected-value refs and structured `merge-tree --write-tree -z` parsing. Hooks reserve constant-time in-memory generations at the prepared result before the prepare-finish await, at synchronous collection materialization, and before refresh mutation. Completed payloads fill those slots; the private queue drains reservation order, never completion-arrival order. Lead anchors are retained by generation (32 cuts, matching the queue ceiling). Missing or unreconstructible generations skip the worker, overlapping mutations are unmodelled, refused/no-op reservations release without a Git event, and abandoned reservations expire after ten seconds and invalidate dependent history. No snapshot entries or bytes are copied on the reservation path. Publication changes and a five-second reconciliation timer coalesce into one pass. The timeout context in roomd applies only inside that asynchronous work, disables optional index writes and fsmonitor, and cancels its reads on leave. Ordinary callers retain their defaults.

All objects and refs are private to `<common>/room/shadow/<session>/repo.git`; its alternate is the main object store. No shadow ref or object is written into the user's repository. Spawn anchors are keyed by the lead's real pre-carry HEAD, carry mode, exact tracked tree and carried-untracked set, within one observed lead generation. Different housekeeping carry commits of that same state share an anchor. A `carry=false` worker branches only from the private projection of its prepared real HEAD, never from a carried event. Different real HEADs or an observed intervening lead state have distinct anchors even when trees are equal. Working observations chain from each participant's current event. Event commits include unique nonces so independent identical edits in the same second cannot accidentally become shared ancestry; shared spawn anchors are reused explicitly. A focused frozen-timestamp regression covers a later revert after independent identical observations. Collection reconstructs the accepted lead footprint from the immutable before/after plan, builds each delivery from its prior anchor with only its accepted source paths, then merges delivery events into the lead's line. Skipped scratch is absent from the delivery mask; the worker's next observation descends from its delivery. Successful refresh creates a lead target anchor and the worker's new prepared baseline; refusals enqueue nothing.

The lead reads both directions of sibling slots in the replicated local `conflicts` Y.Map, including status, settlement, opaque input hash and owner fence. That map carries **no publication provenance**: an evaluator on a lagging replica can settle old inputs after the lead has seen a new publication, with a later `checkedAt` and the same fence. The first-seen/timestamp rule introduced at `07706ae4` was therefore unsound and has been removed entirely. The authoritative detector and its schema remain unchanged.

One rule now governs every disagreement class: the same pair/path, today's status (or absence), shadow status, both exact publication identities and both covered shadow observations must remain stable for 60 seconds and be re-read unchanged before append. Unknown results, input movement, aggregate status changes and agreement reset the episode. Timestamp, opaque input/fact keys and other metadata-only slot rewrites preserve pending and already-recorded episodes. A persistent unchanged episode is recorded exactly once. Each line explicitly says `observation: "60-second-stable-heuristic"` and reports `stableForMs`; **none is a proof of evaluator completion or input freshness**. A lagging evaluator that catches up during the window resets the wait. Current fences, complete full publications, covered bytes matching those publications, and comparison/end-of-pass witnesses are still required. Team projections suppress internal-family comparisons; only the local family is read. Retired or unverified participants are not compared.

Unsupported history is skipped, never reconciled by guessing:

- A worker HEAD differing from its prepared HEAD: commits, merges, fast-forwards, adoption and resets are rejected by HEAD reads before and after capture, also matched to the stable capture's own HEAD. Successful Room refresh alone replaces the expected HEAD. A commit/reset detour that returns exactly to the prepared HEAD before observation stays modelled: the starting point is unchanged, and remaining working edits are ordinary observations (tested for hard and mixed reset).
- Borrowed/supplied (`dir=`), outside or shared checkouts: spawn facts, current registry ownership, matching room/lead/name, checkout witness, branch and concurrent checkout users are checked. Nested leads are detected from `ROOM_WORKER_ID`, accepted worker views and registry parent/checkout relationships.
- Partial/copy delivery: its successful copy hook invalidates the family's history. Incomplete carry and non-full sharing are skipped. Previously existing/recovered workers have no spawn event in a fresh session and are not adopted.
- Missing source/private objects, lost ref races and failed event writes: no answer. A lost worker-only reservation removes that participant; lost lead history stops the family with one plain reason log. Retirement/discard removal is ordered after earlier reservations, then drops the actor, all pair/path episodes involving it, publication identities, later owned reservations and the private index. Final collection needs no ended-worker delivery: it removes that worker and records a fresh, stable lead observation for that generation. A later lead mutation makes an unreconstructible generation unmodelled. Retained workers still use the existing delivery capture/HEAD gates. Leave clears every participant and private session state. Dead-session state needs a valid dead process receipt; unverifiable/live state is preserved.
- Effective covered-path attributes are checked in one NUL-delimited `git check-attr` batch: `filter` (content conversion), `merge` (non-default merge semantics), `text`/`eol`/legacy `crlf` (line-ending conversion), `working-tree-encoding` (re-encoding), and `ident` (expansion). Unsupported effects, including per-path `core.autocrlf` and `merge.default` fallbacks, are refused with the attribute and one example path logged once. Unused filter/driver definitions, irrelevant attributes and rules affecting only coverage gaps are harmless. Raw-byte scans reuse the disk policy with an enumerated inventory so `git diff` cannot invoke clean filters before the decision. The private graph disables system and default global attribute files, so checkout overrides cannot expose a different private merge driver. Sparse checkout and partial-clone/promisor configuration remain repository-wide refusals. `.roomignore` uncertainty, unsafe links, nested repositories, private/default/git ignores, held/binary files and size/text-budget omissions are gaps; a gap is never deletion or clean evidence, and remains excluded from that participant's comparison history. A previously covered path becoming a gap invalidates that participant's history instead of committing it as a deletion; collection also checks current lead/worker coverage before constructing any delivery footprint.

Passes have a ten-second deadline that also bounds hung promises, not only Git commands, and a 2,000-path ceiling; Git output is capped at 4 MiB and individual private commands at three seconds. Observations create no commit for an unchanged covered tree. A 200 MiB private-directory ceiling uses conservative allocation reservations (including a 32 MiB merge reserve), so observation may stop before reaching the nominal ceiling. Diagnostic staging is capped at 4 MiB per pass and the shared journal stops at an observed 200 MiB, checked before each append record. This is deliberately approximate by at most one bounded record per concurrent writer between its last size check and append; no cross-family lock is used. Over-budget passes publish no partial staged disagreements. Identical commit-pair results are cached, with a reachable-object check before reuse so loss of an alternate object invalidates the answer. Failures are logged once and swallowed; no notices are posted. A deadline cancels and closes the private family, including owned subprocesses and any open journal handle. A failed journal close also seals the family and retries that owned close, so repeated failures cannot accumulate open handles. Cleanup has its own bounded, unreferenced timer. Leaving cancels owned Git subprocesses and queues deletion; a dead-session receipt supports recovery if the process exits first. The comparator never runs GC/prune.

### Review regression coverage

The third review's two reproducers are retained in `shadow-participant-lifetime.test.ts`. Its matrix also covers all registry terminal phases, real discard, real final collect in both completion/retirement orders, a mixed batch with one cleanup-kept worker, scoped reservation expiry, late payload disposal, leave, permanent lead/worker rejection, unreconstructible final generations, and metadata-neutral pending/recorded episodes. Collection hooks pass an ID-only ownership accessor; spawn/refresh pass scalar IDs. None enumerates or copies participant data on the existing lifecycle path. The statically imported shadow module performs no top-level I/O or fallible environment parsing.

The first review's four independent reproducers are preserved in `shadow-freshness.test.ts`. Additional cases cover shared anchors despite distinct housekeeping SHAs, carried versus later HEAD-only workers, HEAD-only workers at equal/different real HEADs, an observed draft change/restoration, both sides of the capture HEAD fence, and resetting the uniform stability window when a publication revision changes even if the ordinary slot input key does not. The second review's lagging-replica and real prepare-finish/keep interleaving reproducers are preserved in `shadow-stability-order.test.ts`, alongside expiry, no-op release, overlap/missing-generation and no-copy reservation cases. Cancellation and deadline-expiry tests in roomd use real children that ignore SIGTERM; default-option tests assert exact e2a60241 option objects. Node 22.23.4's execFile does not forward killSignal to its internal spawn AbortSignal handler, so a deadline-only listener hard-kills that exact child and removes itself on close. Both private graph command forms use SIGKILL as well, and stale locks are cleared only within private indexes/ref paths. `shadow-failures.test.ts`, `shadow-failures-lifecycle.test.ts` and `shadow-journal-cleanup.test.ts` run 26 reachable private stages × throw/reject/hang, plus the collection closure with a missing head and an unset-flag baseline in each file (82 cases). The split preserves the existing 15-minute per-file watchdog. Every cell performs real spawn → kept collection → refresh → final collection using the existing fixtures, compares user files/index/status, replies, launches and messages with the baseline and asserts its injection was reached. Default hang cells assert the next real lifecycle operation settles while the injected private promise remains pending, then explicitly cancel/release it; they make no wall-clock latency assertion. Default logical suites inject the shadow clock and Git timing. Fake-timer unit cases cover the real budget implementation; measurements and real-child cancellation/deadline timing probes run only in the separately discovered scale pass. The production deadline remains ten seconds. Journal faults use the legitimate stable-absence window with conflicting observations. No ordinary conflict answer is fabricated for that matrix. The weak early-fault loop was replaced; pre-existing expectations were not changed.

### Measured shadow cost

The following saved figures describe the pre-review implementation at `be210d0b`; rerunning the measurement tests after the review is validation, not a replacement for those saved samples.

Git 2.45.2 on this macOS sandbox; one lead and six actual temporary Git worktrees; 100 tracked 1 KiB files. Six workers each edit one different approximately 1 KiB text file per five simulated seconds, for 12 rounds / 72 observations. Each round includes six policy-checked snapshots and all 21 unordered pair comparisons, serially. The median was **1,399 ms per round**. From the initialized private directory, 60 simulated seconds added **156,258 bytes total**, including **107,856 object bytes**: linear projections are **9,375,480 bytes/hour total** and **6,471,360 object bytes/hour**. Main `count-objects -v` was unchanged. These are logical file sizes, not allocated filesystem blocks; metadata/index setup affects the short-run projection. The measurement does not run real coding hosts, publication transport, conflict settlement, journal writes or production ref pins, and is not an hour-long soak or a production latency bound. See `shadow-measurement.json` and `packages/room-mcp/test/shadow-measure.test.ts` for inputs/reproduction.

An initial timing run was rejected after inspection showed a noncanonical temporary root made every path a coverage gap. The corrected fixture canonicalizes its roots and asserts exactly 100 covered entries and zero gaps on every snapshot. Its output above supersedes the empty-coverage timings. The archived study's faster figures above are a different implementation/workload and are not a measured speedup for this policy-complete shadow.

The complete coordinator wrapper was separately measured over 103 base files with six workers each editing a different 1,008-byte file. Three passes, each including seven captures, publication checks and all 21 pairs with disk revalidation, took 3,700 / 3,694 / 3,640 ms: **3,694 ms median**. Every pass completed within the production deadline, and main object counts stayed unchanged. Host/publication transport remained synthetic. See `shadow-coordinator-measurement.json`; this and the engine/object-growth workload above are different fixtures.
