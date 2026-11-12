# Cross-process worktree registration: shipped with a process-lifetime limit

2026-11-13. **Shipped, with this limit:** the process-owned lease serializes live Room
sessions, but cannot hold exclusion for a Git subprocess that outlives its killed Room
parent. The lead accepted this contained improvement: it removes collisions between
live sessions; the residual requires killing the holder during registration and another
session entering while its orphaned Git child still runs. Recovery in that case has the
same lack of exclusion that all cross-process operations had before this change.

## Findings

The implementation keeps `RepoLocks` first, then acquires the asynchronous lease
guard at the canonical `<git-common-dir>/room/worktree-operation.guard`, holds it across
the callback, and releases it in `finally`. The existing active AsyncLocalStorage scope
preserves nested operations and synchronous verification/removal. Only commands selected
by `isGitWorktreeCommand` acquire it; ordinary Git commands do not. External Git commands
do not participate. `withGuardAsyncOperation` permits an awaited operation without
changing `withGuardAsync`'s synchronous decision contract for evidence publishers.
The state collector leaves this exact guard family owner-managed: asynchronous
acquisition recovers dead records on demand. Its generic dead-holder check followed
by a blind unlink could otherwise remove a live successor. No synchronous collector
guard acquisition or separate recovery mechanism is added.

This passed simultaneous preparations by two real processes (three preparations per
process per round, three rounds each of clean and carried work: 36 worktrees), a widened
empty-`commondir` window, and killing an idle holder while a linked-worktree process
waited. Removing just the cross-process acquisition made the widened-window test fail:
the contender exited 1 before the holder released its partial metadata. This is direct
failing-before evidence, rather than relying on an intermittently passing stress run.

**Idle-holder recovery does not establish child-lifetime exclusion.** A separate real-Git diagnostic installed a
15-second post-checkout hook, began `git worktree add` through the experimental guarded
helper, waited for the hook, killed only the Room parent with SIGKILL, then listed
worktrees from another process. The second process reclaimed and released the guard
while the first operation's hook was still alive:

```json
{"orphanHookStillAlive":true,"secondProcessAcquiredGuard":true,"guardRemoved":true}
```

The diagnostic ran on the lead side: macOS arm64, Node v22.23.4, Git 2.45.2. It establishes
an operation-lifetime gap; it does **not** reproduce corrupt registration during that
hook, because the hook runs after initial checkout. The unsafe inference to avoid is
that a dead Room PID proves its Git child stopped publishing registration metadata.
Neither async I/O, a longer acquisition deadline nor re-entrancy fixes that gap.

## Waiting, cost and scope

Waiting policy: a monotonic five-minute acquisition deadline after reaching
the front of the existing process-local queue; poll live/unknown holders read-only at
75 ms intervals, and report the guard path and holder PID on expiry. Never steal
from a live or unknown holder on elapsed time. Five minutes is a contention budget,
not an operation timeout or a fairness promise. Existing preview setup permits a
ten-minute Git command, so a waiter can legitimately expire first and retry later.

Lead-side checkout timings, three sequential fresh detached destinations per size:

| Tracked files | `git worktree add -q --detach <new-path> HEAD` (seconds) |
| --- | --- |
| 5,000 | 0.377, 0.468, 0.632 |
| 50,000 | 4.629, 4.418, 4.703 |

The fixture uses `src/<i/100 padded to two digits>/f<i padded to five digits>.txt`,
with `base <i>\n` per file, matching the scale fixtures' path/content shape. A single
`git fast-import --quiet` builds the commit and packed objects without materializing
the source checkout; HEAD points at that commit. Every measured add fully materializes
the files, and its worktree is removed before the next sample. Preparation/removal
are excluded from the timing. Same macOS/Node/Git versions as the diagnostic above;
local temporary filesystem, small files, warm object caches, no custom hooks or filters,
no controlled machine-wide contention. This is not a cold-disk or large-blob benchmark.
A preliminary packed-fixture trial measured 0.388 s / 5.182 s respectively. The first
filesystem-built fixture harness exceeded its 240-second overall budget both locally
and lead-side, without retained per-command timings; neither failed run establishes
a checkout-duration bound. The packed-fixture three-sample run completed in 28.6 s.
Five minutes leaves substantial margin over these samples, while still allowing
legitimate contention to fail explicitly rather than hanging indefinitely.

The experiment's fsync-count test measured **14 asynchronous fsyncs, zero synchronous
fsyncs**, for a fresh acquisition/release at the test's ten-ancestor temporary path.
That is one flush per ancestor plus token, link, temporary-file removal and release.
Nested calls acquired once; ordinary Git used zero. Busy polling wrote nothing.
Creating a missing guard directory also needed its parent flush moved to the async
path; using the existing async function unchanged can still fsync synchronously there.
Process identity probes retain their existing platform costs; this count is not an
event-loop responsiveness guarantee for the entire operation.

The scope audit found no Room worker launch or awaited worker task under the existing
worktree scopes. `prepareWorktreeAttempt` holds around add and initial witnessing,
before launch; cleanup holds around adjacent verification/removal; registration cleanup
is synchronous. Preview's `gitSetup` holds around its tracked Git child, not the later
check command. A nested worker in a linked worktree resolves the same common directory.
User hooks are another dependency boundary: worker preparation disables hooks, whereas
preview add does not. Hooks stay enabled wherever the existing command runner enables
them, including repository post-checkout hooks such as Git LFS. **Unsupported hook
re-entry:** a hook that calls a Room operation registering a worktree while its parent
holds this guard waits on its parent's lease, then fails at the five-minute acquisition
deadline with the guard path and holder PID. The parent must not await worker work
inside the guard; no such Room-controlled path was found. This unsupported user-hook
cycle is bounded rather than resolved by changing repository hook behavior.

## Not built

Child-aware recovery would need a gated Git launcher that durably publishes the child's
PID and birth identity before allowing it to run, retains that identity through recovery,
and reclaims only after both holder and child are definitively dead. It would need POSIX
exec-transition handling and a supported Windows launch primitive, preserving adjacent
synchronous ownership verification/removal, with fault tests at every launch/recovery
boundary. The lead judged that machinery disproportionate to this residual and explicitly
chose the contained version. This guard is not child-lifetime or crash-safe exclusion.

## Alternatives

- **Git's own locking:** insufficient for the observed sibling-admin read window.
  The empty-`commondir` reproduction fails despite Git's ref/index locks; they do not
  serialize publication and every sibling registration reader. The diagnosis document
  named in the dispatch was absent at this checkout's HEAD and in the lead's Room
  publication, so its additional evidence could not be independently reviewed here.
- **Retry Git after failure:** reject as a coordination mechanism. A failed add may
  have created a root, branch or partial admin entry; repeating it requires ownership
  recovery and risks turning a real failure into an apparent success. A second process
  does not change that reasoning. Retry guard acquisition **before** executing Git.
- **`flock`-style advisory locking:** attractive OS-managed crash release on POSIX, but
  Node has no portable Windows equivalent without native support. Parent-owned OS
  locking alone also needs an answer for surviving Git children. Evaluate this with
  the runner, rather than adding shell-specific locking as a complete solution.

## Historical experiment validation

Experimental code, subsequently removed: local `npm run typecheck`, `npx knip`, six
roomd lock tests and three relay guard tests passed. The fsync count above came from
the local roomd test. No existing test expectation was weakened or changed.

Lead-side `room_preview_merge(people=["rohanz+viewer"])` ran the three cross-process
tests, existing concurrent-preparation tests and lease tests: **27 passed**. The
process-local mutation failed as expected; the orphan diagnostic returned the JSON
above. All identity-probing child tests ran on the lead side, not in the sandbox.
Every preview reported **PARTIAL: viewer has no manifest record**, so these runs verify
the experimental own tree only, not the current viewer combination. No socket suites
were attempted. No release checks or plugin build certify a shipped change.

That investigation delivered only the original version of this note; typecheck and
knip passed again after removing its experiment. Its final preview included the lead
and viewer, with no merge conflicts, but coverage remained partial because viewer had
no manifest and the lead excluded files.

## Shipped implementation validation

The restored tests include real processes preparing 36 clean/carried worktrees,
linked-worktree lookup during the widened empty-`commondir` window (with an unguarded
negative control that fails in the same window), idle-holder death and recovery, and
reclamation while a killed holder's Git hook is still alive. A fifth real-hook test
keeps hooks enabled and verifies the unsupported re-entry's PID-bearing timeout using
a 160 ms test acquisition deadline. Those five tests passed on the lead side through
`room_preview_merge(people=["rohanz", "rohanz+viewer-fix"])`, on macOS arm64 and Node
v22.23.4. They were not run with mocked identity probes inside the Codex sandbox.

Local tests count asynchronous flushes per operation (one per ancestor plus four),
zero synchronous flushes even for a newly created guard directory, one acquisition
for re-entry, zero for ordinary Git, and read-only bounded waiting for live, unknown,
malformed and nested recovery holders. Existing lock and worker-preparation assertions
remain intact. The private-state writer audit now recognizes exactly one additional
async Windows ancestor mkdir, still restricted to ancestors holding no private file;
duplicate, missing and broadened exemptions remain failures.

Initial peer-only process previews failed at fixture import because the peer's carried
base omitted a new untracked hub-core module. Including the lead supplied it. The
requested rewritten note initially conflicted add/add with the lead's original;
code-only checks temporarily omitted the worker's note, then restored it. The lead
removed its original publication, allowing current previews to include this note.
Previews remain partial for excluded/oversized generated plugin assets and publication
acknowledgment, so they are focused source evidence, not a full release certification.

Local full-suite attempts are not passing evidence: roomd (excluding the process file)
had 337 passes, two socket tests in `negotiation.test.ts` refused by `listen EPERM`, and
the promotion test in `follower-watchers.test.ts` reported `EMFILE` while opening its
watcher. The relay attempt had 210 passes, 65 socket/process-environment failures across
`daemon-lifetime` (12), `credentials` (7), `daemon-compaction` (13), `relay` (4), `hub`
(8), `daemon-authority` (6), `doc-cap` (4), `final-save` (3), `negotiation-buffer` (2),
`browser-interop` (1), `health-probe` (4) and `http-hardening` (1), plus six uncaught
`listen EPERM` errors. All names here refer to `.test.ts` files. Three writer-audit
failures prompted the exact async mkdir audit update above. One null-holder unit case
was added while that long suite had already loaded the old lease module; its result
is superseded by the focused run against matching inputs. The focused guard/audit
files now pass, as do local worker-preparation/validation/lease checks (48 passes,
one skip) and collector checks (seven passes). Typecheck and root knip passed.

A lead-side preparation/lease run caught one real scheduling regression introduced
by pre-reading guards for all async callers. Preserving the original create-first
scheduling of fail-fast decision guards fixed it; polling operations alone inspect
holders read-only before attempting creation. The existing exclusion assertion was
retained unchanged.

Final lead-side source evidence: the full relay suite passed. A single full roomd
preview reached the MCP `tools/call` 300-second response timeout without a completion
result, which is not a pass. Four completed, non-overlapping narrower previews then
covered all 49 roomd test files: **345 passed, two skipped** (31 + 114 + 97 + 103
passes). Their recorded source-input hash was identical
(`96713f0ce4fd516a8f5b42178b95d0f108646e054f2496659ee70c407264a66d`), despite
publication/Git metadata moving during one check. The socket/watcher failures above
all passed on the lead side. The combined concurrent-preparation, preparation,
validation, lease and collector check passed **57 tests, one skipped**. Those final
runs named the lead after `viewer-fix` had been collected into its snapshot; earlier
runs named both peers. These remain partial source previews because generated plugin
assets are excluded or exceed Room's text limit. The integrating lead still runs the
required ordinary and scale release passes on the collected tree.
