# Conflict shadow: final pacing and mode fix (2026-11-23–24)

## Final change

One private job applies at most one completed lifecycle event, then yields
to the existing five-second schedule. The next job gets its own ten-second
deadline; comparisons wait until the lifecycle queue drains. Shutdown logs
name the stage. Incomplete or hung work still switches the family off,
without retry, and lifecycle tools never await diagnostics. The clock is checked before and after awaited lifecycle steps and before
checkpointing: an expired job shuts down the family with its stage before
worker-loss handling or checkpointing, including when no lead actor exists.
This covers returned, thrown and swallowed errors without matching error text.

Validation is restored to `f734bffa`: full per-pair `current()` calls, the
original final checks before journal rows, fingerprint and 32-entry comparison
cache. The larger cache, base-listing cache, batch object check, subset reads,
metadata reuse and their implementation/tests are removed. `shadow-graph.ts`
is identical to that baseline. Nothing depends on the discarded caches.

The only snapshot change records and rechecks each covered file's executable
bit alongside its bytes. Before the fix, two regressions failed against the
restored baseline: `current()` accepted chmod 0644→0755, and the coordinator
appended `today:"conflict", shadow:"clean"` even though fresh Git comparison
conflicted. Both now pass. A third test confirms that an unrelated edit,
restored after the per-pair check, resets the episode and emits no row.

## Measurements

The original first drain after two spawns exceeded ten seconds without
injected load. An extended baseline run took 14.725 s: 6.202 s in the two
spawn events and 8.521 s in observation. Quiet rounds took 8.119/8.099 s,
including about 6.7 s in 12 whole-tree scans. The cost repeated; model-startup
contention was not necessary. Earlier two-CPU-loop probes also reproduced it.

The final three-participant production-budget run completed every pair in
all three rounds and retained all actors:

| Stage / round | Wall time |
| --- | ---: |
| First spawn job | 3.131 s |
| Second spawn job | 2.996 s |
| First observation job | 8.589 s |
| First drain, excluding scheduler gaps | 14.715 s across the three jobs |
| Quiet round 1 | **8.505 s** |
| Quiet round 2 | **8.600 s** |

The quiet rounds still performed 12 whole-tree byte scans each (18,828
candidate paths); their scan stages totalled 6.856/6.918 s. This fixes startup
deadline aggregation, not repeated scan cost. Three fits with limited margin
on this machine. Larger families were not measured on the final code and are expected to
exceed the fixed ten-second job, which switches the comparator off with a
logged reason. No final larger-family scalability claim is made.

The fixture copies the repository's 1,567 tracked paths into the real-Git
worker fixture, producing 1,569 tracked paths with the same size/shape and
coverage gaps. It uses real preparation, linked worktrees, registry reads,
private Git and scheduling, but synthetic host launches and publications:
**no model processes run**. Conditions: macOS 26.5/Darwin arm64, local APFS,
Node v22.23.4, Git 2.45.2, inherited nice 10. The final measurement runs alone,
with one Vitest worker and no synthetic load; the machine is not otherwise
isolated. The normal fixture GraphIndex remains active.

`idle()` drains the scheduler gaps for measurement; production retains the
five-second gaps. Stage totals are nested, not additive. Raw CPU fields are
microseconds and exclude Git/load-child CPU. The adjacent [raw JSON](2026-11-23-shadow-pass-deadline-measurements.json)
keeps baseline, rejected, failed and final samples separately labelled.

```sh
TEST_SCALE=1 SHADOW_STARTUP_OUTPUT=/absolute/three.json npx vitest run packages/room-mcp/test/shadow-startup-measure.test.ts --maxWorkers=1
```

`SHADOW_STARTUP_UNBOUNDED=1` is fixture-only extended measurement mode;
`SHADOW_STARTUP_EXPECT_STOP=1` asserts a measured cutoff. No production limit
is raised. These measurements are samples, not portable participant limits
or latency percentiles. Larger families can exhaust the fixed job budget
and switch the comparator off with a stage-named reason.

## Rejected approach 1: metadata-only byte reuse

Matching device/inode/mode/size/mtimeNs/ctimeNs plus a race window did not
certify unchanged bytes. Native APFS `MAP_SHARED` writes changed bytes with
identical fields; the cache reused a stale blob while baseline byte reads
rejected it. A stale rename candidate outside result/slot paths could even
produce a wrong row at another path. Open idle mappings stayed timestamp-stale
for more than 120 real seconds; msync/munmap made timestamp changes visible.
The fast 408/413 ms (three participants) and 1,352/1,356 ms (ten) rounds were
therefore unsound. The mechanism and filesystem probes were removed.

## Rejected approach 2: final batch validation

Full-byte validation once per participant reduced quiet costs to 5.92/5.98 s
at three participants and 10.03/9.93 s at five (extended fixture mode). But a
file outside result/slot paths could change across its omitted per-pair
observation and be restored before final validation. Review reproduced an
episode/row that baseline's full per-pair validation reset. Final bytes
matched; continuity evidence was weaker. That sampling change and its caches
are removed. The inherited executable-bit gap was reproduced separately and
fixed without retaining the batching design.

## Fourth-review deadline correction

The prior error-prefix check missed a removal whose pin failure was swallowed
and an event rejecting with a Git-step error at the deadline. Both cases now
stop the family by the clock, with or without a lead. All ten new regressions
failed before the fix; the focused run then passed 19 tests across two files.
It also covers successful events, collection waiting and no-op factories.

The early-return audit covered missing participants, unfilled reservations,
ambiguous generations, collection waiting/expiry, closed-session catch and
the completed-event checkpoint. Awaited factories, events and loss handling
check the deadline before and after settling; reservation waits, collection
waits and checkpointing check it before returning. A closed session already
has cancellation and cannot proceed to a checkpoint.

## Validation and limits

- Default shadow suite: 20 files passed, 7 skipped; 140 tests passed,
  137 skipped (182.28 s).
- `TEST_SCALE=1` shadow suite: 17 files / 242 tests passed (1129.41 s).
- `npm run typecheck`: passed.
- Named `rohanz+claude` preview: 3 files / 22 tests passed (9.57 s),
  complete selected-peer coverage, no conflicts.
- The final scale pass measured 8.505/8.600 s at three participants.
  Earlier isolated normal-path measurements were 8.552/8.534 s and
  8.374/8.447 s. Larger final-code families were not measured.
- `git diff --check`: passed. No commit, CHANGELOG or bundle changes.

Two lifecycle deadline regressions also failed before the final catch fix
(with and without a lead actor): an event rejected at the deadline before
the timer fired, but the family stayed unhalted. Both now pass. Their assertions require family shutdown, no `lost()` call,
no applied checkpoint and no retry; the pacing/budget focused run passed all
nine cases across two files (1.46 s).

The mode assertions failed before the fix (two failures, one continuity test
passed; 8.98 s). Afterward, mode/continuity and pacing/budget checks passed
all 10 tests across three files (10.16 s). The episode clock uses the existing
fixture seam; this is not a 60-second live-host run.

No six-hour live stability, actual Codex spawn contention, live-host latency,
Linux/Windows performance or full historical replay was verified. This is
an opt-in record-only comparator; conflicts, notices, wakes and collection/
refresh results remain unchanged. No commit, CHANGELOG, dependency or plugin
bundle changes.
