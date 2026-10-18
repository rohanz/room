# Rehearsal fixes — review round 7, 2026-09-30

Reviewed `150f81e..ddef005` at HEAD `ddef005531652ee33bcf01f74da7a48ec9b8e329`, with a brief cumulative source read over `0aef465..ddef005`. Read round 6 and the dated rehearsal rerun. Report only; no source/test edits, commits, or pushes.

**Verdict: not ready to sign off. Findings: 1 must-fix, 3 should-fix, 0 nits.** The original T1–T4 reproductions recover, but a different starvation ordering remains and the new automatic fallback/retry paths have correctness and reporting problems.

## Round-6 reproduction results

Copied the scripts from `/tmp/astra-review-r6b/` to `/tmp/astra-review-r7/`, changed their imports and child cwd to this worktree, and ran them with `node --import tsx`. The original scripts remain unchanged. Logs are `/tmp/astra-review-r7-<name>.log`.

| Item | Result at ddef005 |
| --- | --- |
| T1: symlinked `.git` resets another checkout's index | **Resolved in the original reproduction.** `edge-probes.mts symlink`: preview passes on merged content; the unrelated live checkout retains `STAGED USER EDIT` in its index and `LIVE USER EDIT` on disk. The foreign slot is retained with a claim. The repository suite also passes the already-existing own-slot symlink case. Log: `symlink`. |
| T2: cleanup claim permanently blocks same-process checks | **Resolved for check availability.** `claim-restart.mts claim`: one injected `rm(ownSlot)` EBUSY produces a fresh passing preview immediately; the second same-process preview and the separate-process preview also pass. The original slot's claim remains. Log: `claim`. |
| T3: repair failure/interruption permanently blocks the current slot | **Resolved for check availability.** `repair-failure.mts`: after the one-shot repair fault, all three previews pass; first fallback is fresh, second uses a new generation, third is cached. `adoption-interrupt.mts`: after the actual rename followed by an injected interruption, first and second previews pass. Old source claims/registrations and abandoned destinations remain. Logs: `repair`, `interrupt`. |
| T4: 65 live entries in an early key starve a later key | **Original case resolved; fairness remains incomplete (U3).** `edge-probes.mts starvation`: 12 sweeps see 66 owners, including the later dead owner, and remove its slot (`laterProbed: true`, `laterExists: false`). Log: `starvation`. |

The cleanup, repair, and interruption failures above are explicitly injected; filesystem/Git behavior after each injection is real. The starvation probe injects deterministic owner liveness. The symlink/index-preservation observation does not inject Git or liveness results.

## Findings

### U1 — must-fix: automatic fallback can pass on a different tracked tree

**Location:** `packages/room-mcp/src/tools/files.ts:1066–1069`, `:1121`, `:1132`.

A normal cache is a Git checkout, but the new recovery path materializes its replacement with `git archive`. Archive attributes can remove tracked files (`export-ignore`) or rewrite their contents (`export-subst`). Applying only the merged paths afterward does not restore omitted unchanged paths. Thus the cache and fallback are not interchangeable representations of the stated ancestor plus merged changes.

**Concrete reproduction:** `/tmp/astra-review-r7/new-probes.mts archive`, log `/tmp/astra-review-r7-archive.log`:

1. Commit `tests/ok.test` with `PASS`, `tests/regression.test` with `FAIL`, and `.gitattributes` containing `tests/regression.test export-ignore`.
2. Run a check which discovers the files in `tests/`, exits 1 for a `FAIL` file, and otherwise prints the number passed. Apply the same unrelated merged edit to `x` throughout.
3. Normal cached-worktree setup finds the failing tracked test: `passed: false`, exit 1, `1 failed`.
4. Replace the own cache's `.git` with a symlink, so the new ownership check safely rejects it and chooses fresh fallback. Do not change the commit, merged map, or command.
5. Fallback omits the failing test and returns **`passed: true`, exit 0, `1 passed`** under the same ancestor and applied-file count.

The archive helper predates this diff; the new issue in `ddef005` is automatically substituting that non-equivalent tree after cache failure (and after a completed check through the cleanup retry). Previously this damaged-own-slot ordering refused the check. This is an integration defect in the new recovery path, not a claim that archive behavior itself was introduced here.

**Suggested change:** materialize a fresh tree from the complete Git tree/blob inventory, preserving checkout modes/symlinks and ignoring archive-only attributes, or use a separately owned fresh checkout with safe lifecycle handling. Make cache and fallback semantics explicit and equivalent. Add a regression asserting identical discovered files, contents, and verdict with `export-ignore` and `export-subst` in normal and forced-fallback runs.

**Impact:** **wrong-tree check results, including false passes**; can become passing preview evidence. No other checkout modification was observed. This is not a disk-only issue.

### U2 — should-fix: cleanup failure silently reruns the command and erases the first result and timings

**Location:** `packages/room-mcp/src/tools/files.ts:1091–1094`, `:1104–1121`.

The `return` from the recursive scratch attempt in `finally` replaces the already-computed result. The reply describes only the second command execution, including only its setup/check time. A transient cleanup failure therefore turns one requested check into two executions without disclosing the retry, and can hide a failed first run behind a successful second run.

**Concrete reproduction:** `/tmp/astra-review-r7/new-probes.mts retry`, log `/tmp/astra-review-r7-retry.log`:

1. Run a deterministic two-attempt fixture command: record an invocation count in an external scratch marker, print `1 failed`/exit 1 on the first invocation, and `1 passed`/exit 0 on the second. This models a retry-sensitive or flaky check; the marker deliberately demonstrates repeated side effects.
2. Inject one `fs.promises.open(ownSlot/.git)` EBUSY during final validation, delayed 250 ms. Setup and the first check have already completed; there is no fault on the scratch attempt.
3. The marker says **`2`**, but the returned result says only **`passed: true`**, `setup 22ms (fresh base), check 32ms`. Total wall time was **405 ms**. The first failure, its output/time, and the recovery delay are absent. A console warning says the cache was abandoned, but does not preserve the first command verdict in the tool response.

**Suggested change:** if a completed check's tree was valid, return that result with a cleanup/cache-abandonment warning and use the next generation for the next request. If a rerun is required because the first tree is uncertain, retain both attempts, disclose why it ran twice, report total elapsed setup/recovery/check costs, and do not present a prior failure as an unqualified single-run pass.

**Impact:** **check-result/reporting integrity and duplicate command side effects**. This probe does not demonstrate another checkout being reset. Fresh/cached wording is accurate for the final attempt, but incomplete for the request as a whole. Setup-time fallback within the first attempt correctly includes the failed cache setup in its setup clock; the lost timing is specifically the recursive post-check fallback.

### U3 — should-fix: the new slice cursor and probe cursor can permanently skip half a key

**Location:** `packages/room-mcp/src/tools/files.ts:857–879`, `:883–901`.

The per-root cursor advances when entries are gathered, while the global candidate cursor advances only for probed entries. Its index is then applied to a different candidate list on the next pass. These rotations can synchronize so a repeatedly scanned subset is never probed.

**Concrete reproduction:** `/tmp/astra-review-r7/new-probes.mts fairness`, log `/tmp/astra-review-r7-fairness.log`:

1. Sorted-first key `00000000000000000000` has 16 slot directories, `600000-live` through `600015-live`. Sorted-later key `ffffffffffffffffffff` has eight enduring slots, `700000-live` through `700007-live`.
2. Inject owner liveness: all live except `600015`, which is dead. No Git result or deletion result is injected; the dead slot is an ordinary removable partial directory.
3. Request and await **40 sweeps**. They probe only `600000..600007` and `700000..700007`; **`targetProbed: false`, `targetExists: true`**.
4. Every odd pass gathers the first eight entries of the first key and probes that part of the candidate list. Every even pass gathers its second eight but starts probing at index eight, consuming the budget on the later key. The same state repeats indefinitely.

This is distinct from T4's fixed key-level starvation: the earlier key is visited and scanned, but some of its slots never reach a liveness check.

**Suggested change:** keep traversal progress tied to slots actually processed, or queue the gathered candidates and drain that stable queue before rotating their source slices. A single bounded round-robin traversal through keys/entries/probes is simpler than two independent modulo cursors over changing arrays. Add the 16-plus-8 ordering alongside the existing 65-plus-1 case.

**Impact:** **unused disk and registration retention only** in this reproduction; no wrong check result or mutation of another checkout.

### U4 — should-fix: abandoned generations are immortal while their process lives

**Location:** `packages/room-mcp/src/tools/files.ts:629–647`, `:1061`, `:1106`, `:894`.

Generation changes restore availability, but liveness treats every generation of the same process as active. There is no record that an older generation has finished and was abandoned, nor a bounded owner-only retry/cleanup path. Even wholly valid slots abandoned after a transient read failure cannot be reclaimed by ordinary or explicit sweeps until process exit.

**Concrete reproduction:** `/tmp/astra-review-r7/new-probes.mts generations`, log `/tmp/astra-review-r7-generations.log`:

1. In one process, run six previews. For each, inject exactly one EBUSY opening `.git` during final validation; restore ordinary behavior immediately after that read. Each preview succeeds through scratch fallback.
2. All six old worktrees remain reciprocally registered and locked, with generation suffixes `-0` through `-5`.
3. Restore the real filesystem implementation and request/await ten explicit cleanup passes. **Six directories and six locked registrations still remain.** Their process is alive, so each is excluded by the dead-owner gate.
4. Further such failures produce further generations without a cap. Because the generation counter is process-wide, a failure for one clone also strands otherwise healthy older-generation slots for other clone keys used by that process.

**Suggested change:** track abandoned slots owned by this process and enqueue bounded cleanup after their active turn is released. Retry only after authenticating their current registration; quarantine uncertain foreign/claimed state. Alternatively bound caching after repeated failures and stay on fresh scratch until safe cleanup succeeds. Do not broaden other processes' authority to reclaim live owners.

**Impact:** **unused disk/locked-registration retention**, potentially substantial for warm compiler caches; no incorrect check or other-checkout mutation demonstrated. Existing ambiguous dead claims/interrupted adoptions may still require manual inspection independently of this owner-cleanup improvement.

## Generation parsing and path checks

- `/tmp/astra-review-r7/generation-names.mts` passed all eight observed expectations (log `names`): old two-part kernel names; generated `-0` and `-9` names; Linux birth markers containing hyphens; a legacy marker ending `-12`; both plausible interpretations of that ambiguous legacy suffix; a stale known birth marker; and live/dead opaque markers. Accepting either interpretation is conservative and can retain an ambiguous stale slot; it did not delete a live one.
- Re-ran `path-aliases.mts` (log `path`): `/tmp`, `/private/tmp`, and a separate clone symlink produce exactly one cache path. All three checks pass; the latter two report cached reuse.
- The new `.git` `lstat`, no-follow open, and handle regular-file check close the reproduced leaf-symlink hole. Comparing the backlink to `realpath(slot) + '/.git'` avoids authenticating another checkout through that leaf. Existing-own-slot, pre-reset, and pre-clean validation now use this check.
- Exact backlink-string equality can conservatively reject an otherwise equivalent noncanonical spelling in manually moved/rewritten metadata; the result is fallback/quarantine rather than authority to reset another registration. No destructive canonicalization regression was established on this Darwin host. Windows path spelling/no-follow behavior was not executed here.
- I found no additional wrong-registration check execution in the rerun T1 paths. U1 concerns a different tree-content boundary: the fallback is legitimately private but lacks tracked content that the normal checkout includes.

## Cumulative read and validation

The brief cumulative source pass covered fresh-room admission, push ancestry/history and catch-up status, turn scanning/wake receipts, display-name and partial-preview evidence handling, dependency relinking, graph-readiness shortcuts, conflict/landed-claim freshness, shutdown, plugin selection, and shared-checkout collection/retirement. Collection still places its final destination identity gate after async source-ref publication and has no await through its write loop; retained-owner cleanup preserves late work and commits. No additional concrete finding was established outside U1–U4.

The full rehearsal fix set is **not ready to ship** with U1's false-pass path. T1's unrelated-index corruption is fixed in the exercised cases. Host behavior remains supported only by the supplied dated rehearsal/survey evidence: this review did not run a live host wake/routing experiment, rebuild the plugin, or perform model-based host evals.

- Focused cache suite: **37 tests / 4 files passed** (cache races, cache slots, run cache, worker preview cache). Log: `/tmp/astra-review-r7-cache-tests.log`.
- Broader cumulative suite: **447 tests / 16 files passed** (collection, conflicts, carried work, preview names/manifest, wake turns, lifecycle/worker cleanup, shutdown, tool budget/tools, hub admission, base branch/resolution, areas and base messages). Log: `/tmp/astra-review-r7-regression.log`.
- Total: **484 tests / 20 files passed**. Batches were staggered and each used `--maxWorkers=1`; `ROOM_TAG`, `ROOM_OWNER`, and `ROOM_SERVER` were unset. `nice -n 10` was attempted for the cache batch, but the sandbox denied `setpriority`.
- Scratch probes ran on Darwin with Git 2.45.2. New scripts and adaptations are under `/tmp/astra-review-r7/`; their logs name the explicit fault/liveness injections. They print observations, including reproduced defects, rather than claiming all probes are passing assertions.
- No local-network socket integration suite was run; those listeners are unavailable in this sandbox. No full CI/typecheck/build claim is made.
- Required `room_preview_merge(people:["rohanz"])` completed without conflicts at common ancestor `ddef005531`. Only this report differed; no tests were requested for that document-only combined tree.
- `git diff --check` passed. This report is the only changed repository path; no source/test edits, commits, or pushes.

**Final verdict: not ready to sign off.**
