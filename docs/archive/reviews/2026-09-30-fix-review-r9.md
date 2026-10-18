# Rehearsal fixes — review round 9, 2026-09-30

Reviewed `f036590..7438563` at HEAD `743856380693aef8431167f1f37ce15ac2c4b6bd`, with a final cumulative source read over `0aef465..7438563`. Read round 8 and the dated rehearsal rerun. Report only; no source/test edits, commits, or pushes.

**Verdict: not ready to sign off. Findings: 0 must-fix, 3 should-fix, 0 nits.** The three exact round-8 reproductions recover, and the new per-key generation bookkeeping behaves correctly. The checkout fingerprint is stable and its I/O is asynchronous, but it still omits effective attribute inputs and conflates case-sensitive filter names. Ordinary attribute changes can therefore leave a cached check passing while the fresh check fails. These retain round 8's V3 severity; no new missing-test inventory failure or destructive cleanup issue was established.

## V1–V3 reruns

Copied the scripts from `/tmp/astra-review-r8/` to `/tmp/astra-review-r9/`, changing their source imports to this worktree and scratch prefixes. Sparse scripts now inspect the tree during the check because a sparse source correctly creates no cache slot. The config-drift script makes one additional call to create the replacement generation before forcing its fresh fallback. Original round-8 scripts remain unchanged.

| Item | Result at 7438563 |
| --- | --- |
| V1: sparse cached tree omits a failing tracked test | **Resolved.** Both calls use fresh full trees, discover `regression/bad.test,tests/ok.test`, and return `passed: false`, exit 1. No slot is created. |
| V2: one clone's failure strands other clones' generations | **Resolved.** After six injected final-validation failures and ten maintenance passes, the faulty clone has zero slots / locked registrations. The healthy clone retains exactly one reusable generation `-0`, with one locked registration; its generation does not advance. |
| V3: stale worktree-local `core.autocrlf` | **Exact repro resolved; the broader checkout-policy guarantee remains incomplete (W1–W3).** Changing the source from `false` to `true` abandons the old slot. Fallback, replacement slot, and forced fresh fallback all read `base\r\n` and fail the CRLF-sensitive check. Replacement configuration is `true`. |

Logs: `/tmp/astra-review-r9-sparse-verdict.log`, `/tmp/astra-review-r9-multi-generation.log`, and `/tmp/astra-review-r9-config-drift.log`. The multi-generation fault is a one-shot injected EBUSY on the faulty slot's `.git` read; subsequent Git and filesystem operations are real. The forced-fallback symlink is intentionally left unauthenticated by cleanup and disappears with its disposable fixture repository.

## Findings

### W1 — should-fix: linked source worktrees fingerprint the wrong `info/attributes`

**Location:** `packages/room-mcp/src/tools/files.ts:685–691`, and the incorrect per-worktree assumption/copy at `:1073–1080`.

`--absolute-git-dir` returns a linked worktree's private administration directory. Git's effective `info/attributes` is in the common repository directory. Reading `<private-admin>/info/attributes` therefore usually hashes an empty buffer, including after the effective common attributes change. The new copy into a cache's private admin directory does not provide Git with a private attribute policy. Git documents the shared `info` directory; the scratch probe also resolves the effective path directly with `rev-parse --git-path info/attributes`. [Git repository layout](https://git-scm.com/docs/gitrepository-layout#Documentation/gitrepository-layout.txt-info)

**Concrete sequence:** `node --import tsx /tmp/astra-review-r9/policy-probes.mts commonattrs`, log `/tmp/astra-review-r9-policy-commonattrs.log`:

1. Commit `x` containing `base\n`; add an ordinary linked worktree and preview from it, warming its slot.
2. Write `x text eol=crlf` to the main repository's `.git/info/attributes`, without changing the ancestor or source file.
3. Preview the same ancestor again. Source `git check-attr` reports CRLF, but the saved fingerprint and slot are unchanged. The reply says `cached base`, reads `base\n`, and **passes**.
4. Materialize the same ancestor through `materializeGitTree` and run the same command: it reads `base\r\n` and **fails**, exit 1. The source file stays `base\n`.

**Suggested change:** resolve and hash the actual attribute path with Git (for example `rev-parse --path-format=absolute --git-path info/attributes`). Remove the assumption that these attributes are private per worktree. Since the slot already shares the common repository, invalidate/recreate it when those effective bytes change; do not “fix” the copy by writing into the common file from a preview. Add the linked-source fixture, not just a main-checkout fixture.

**Impact:** incorrect/stale **check results**, including a cached pass versus fresh failure; potentially incorrect passing-preview evidence. No other checkout or source index was mutated. This is not unused disk space.

### W2 — should-fix: `core.attributesFile` and its contents are absent from the fingerprint

**Location:** `packages/room-mcp/src/tools/files.ts:677`, `:689–694`, and reuse acceptance at `:1089–1097`.

The allowlist excludes `core.attributesFile`, and the fingerprint reads only one `info/attributes` file. Global/user attribute files are normal checkout inputs, independent of committed `.gitattributes`. Hashing just the configured pathname would still miss edits to that file. Git also has default user and system attribute sources. [Git attributes documentation](https://git-scm.com/docs/gitattributes)

**Concrete sequence:** `/tmp/astra-review-r9/policy-probes.mts attrfile` and `attrpath`, logs `/tmp/astra-review-r9-policy-{attrfile,attrpath}.log`:

1. In an ordinary main checkout, commit `x = base\n` and configure `core.attributesFile` to an empty file under the scratch root.
2. Warm the cache. Either edit that file to contain `x text eol=crlf` (`attrfile`), or point `core.attributesFile` to another file containing that rule (`attrpath`).
3. Reuse the same ancestor. Both variants retain the same slot/fingerprint, read LF, and **pass** the CRLF-sensitive check.
4. Fresh materialization reads CRLF and the identical check **fails**, exit 1. Source bytes remain unchanged.

**Suggested change:** include the resolved effective external attribute sources and their contents in the checkout policy, including default user/system sources where enabled. Alternatively, make both materializers use an explicit consistent attribute policy or bypass caching where that policy cannot be established. Merely adding `core.attributesFile` to the key set handles only the path-switch variant. Add both content-change and path-change regressions.

**Impact:** **check results can differ** under ordinary configuration; no observed source/other-checkout mutation. This is not disk-only. The default user/system paths are a completeness requirement from Git's attribute rules; the two executable reproductions use an explicit scratch-local `core.attributesFile` and do not modify user configuration.

### W3 — should-fix: lowercasing an entire config key conflates distinct filter drivers

**Location:** `packages/room-mcp/src/tools/files.ts:683`, `:693–694`.

Git config section and variable names are case-insensitive, but subsection names are case-sensitive. Thus `filter.Upper.smudge` and `filter.upper.smudge` are distinct. The new parser lowercases both into the same map key, so the later driver's value hides changes to the earlier driver. [Git config syntax](https://git-scm.com/docs/git-config#_syntax)

**Concrete sequence:** `node --import tsx /tmp/astra-review-r9/policy-probes.mts filtercase`, log `/tmp/astra-review-r9-policy-filtercase.log`:

1. Commit `.gitattributes` with `x filter=Upper` and `x = base\n`.
2. Configure `filter.Upper.smudge=cat`, then the distinct `filter.upper.smudge=cat`; warm the cache.
3. Change only `filter.Upper.smudge` to `sed s/base/BAD/`.
4. The slot/fingerprint stays unchanged. Reuse reads `base\n` and **passes** a check rejecting `BAD`; fresh materialization reads `BAD\n` and **fails**, exit 1. Both commands are deterministic, location-independent filters.

**Suggested change:** preserve subsection case when parsing canonical Git keys. Normalize only the section/variable portions, and retain distinct drivers when selecting and sorting relevant settings. Add two driver names differing only in case to the config-drift regression.

**Impact:** stale **check results** and possible false passing-preview evidence; no other-checkout mutation observed. This is not unused disk space. Unlike the expected `pwd`-embedding filter difference below, this uses the same deterministic filter configuration for the compared trees.

## Sparse detection, stability, generations, and checkout edges

- **Effective sparse configuration:** `git config --null --list` without a scope restriction reads effective shared and enabled worktree-local configuration. The last-value map handles ordinary override ordering. `/tmp/astra-review-r9/sparse-matrix.mts` exercises linked-worktree sparse settings, shared `core.sparseCheckout`, non-cone patterns, and `--sparse-index`: both successive checks see the full tracked inventory; source configuration and `ls-files --stage --sparse` output remain unchanged. The repository regression also rejects an already-sparse cached slot while its source is full.
- **Cone and sparse index:** `core.sparseCheckoutCone=true` alone does not activate sparsity; the `coneonly` probe retains full inventory and reuses its slot. An actual cone sparse index takes the fresh route. Fresh materialization disables sparse checkout and cone mode explicitly and starts with a private full index. No separate sparse-index omission was found.
- **Conservative sparse fallback:** after `git sparse-checkout disable`, Git leaves the pattern file in this fixture. The existence guard still chooses fresh trees on every call despite the full source checkout. This is a cache/performance limitation, not a failing-test omission or source mutation; no separate correctness finding is claimed for the conservative fallback. The parser is not a complete Git boolean parser (for example bare true keys lack the parsed newline); the pattern-file guard covers the ordinary enabled fixtures tested here.
- **Stable fingerprint:** `/tmp/astra-review-r9/stability.mts` warms an ordinary slot, changes unrelated `user.name`, and runs twelve previews. All twelve report `cached base`; slot and fingerprint remain unchanged. Elapsed time is 1,356 ms, with 130 ten-millisecond timer ticks and maximum measured excess delay 2 ms. No per-call timestamp, random identifier, or cache path enters the fingerprint.
- **Blocking:** the new config/rev-parse commands use the asynchronous Git helper; attribute/stat/sidecar reads and writes use `fs.promises`. Parsing, sorting and SHA-256 hashing still execute synchronously on the returned config/attribute buffers, but no new synchronous child process or whole-tree materialization is introduced. The timing probe and repository responsiveness tests passed; this is not a bound for arbitrarily huge config/attribute files or slow filesystems. A normal reused preview adds two Git queries for the source and two for the slot.
- **Per-key generations:** the generation map uses the same canonical clone key as allocation. Stripping the optional `.slots` suffix recovers that key; one clone's abandonment no longer changes another's slot name. The failing slot is queued for owner cleanup, active turns remain protected, and metadata follows adoption/removal. The six-failure reproduction and cache race suite establish no new stranded healthy generation or unsafe deletion. The process-local generation map has lifetime retention per encountered key, a small bookkeeping cost rather than the former whole-tree retention.
- **Round-8 checkout modes:** `basic`, `attrs`, `gitlink`, `skip`, `sparse`, `split`, `nosymlinks`, and `worktreeconfig` all yield matching normal/fresh snapshots. This includes symlink target and executable mode, unchanged source manual skip flags, full sparse inventory, `eol=crlf`, `ident`, deterministic uppercase smudge, worktree-local autocrlf, and empty uninitialized submodule directories. Logs are `/tmp/astra-review-r9-edge-<mode>.log`.
- **Known environment differences:** `filtercwd` still embeds distinct absolute checkout paths, so its snapshots appropriately differ. Git-dependent commands, location-dependent filters, initialized submodules, and retained ignored compiler caches remain limitations of universal cache/fresh equivalence. W1–W3 demonstrate deterministic tracked-byte mismatches without relying on those limitations.

## Cumulative read and validation

The final cumulative source read covered fresh-room admission; push ancestry, rewrite notices and catch-up status; bounded turn-log scanning and wake receipts; display-name resolution, partial previews and evidence generations; asynchronous preview materialization, registration authority, adoption and cleanup; dependency relinking; graph readiness; conflict and landed-claim freshness; shutdown; plugin selection; and shared-checkout collection/retirement. The final collection destination identity gate still follows source-ref publication, with no await through destination writes. Retained-owner cleanup still preserves late edits and commits. No additional concrete finding was established outside W1–W3.

The full rehearsal fix set is **not ready for an unconditional ship/sign-off** while cached checks can use stale tracked bytes under current Git attributes/filter policy. Default stable-config fixtures and the original three round-8 scripts now work. The remaining findings concern check correctness, not destructive cleanup. Host behavior is supported only by the supplied dated rehearsal record; this review did not rerun live host wake/routing sessions.

- Focused cache/materialization/import suites: **50 tests / 7 files passed**, `/tmp/astra-review-r9-cache-tests.log`.
- Broader cumulative suites: **447 tests / 16 files passed**, `/tmp/astra-review-r9-regression.log` (collection, conflicts, carried work, preview names/manifest, wake turns, lifecycle/cleanup, shutdown, tool budget/tools, hub admission, base branch/resolution, areas and base messages). Total: **497 tests / 23 files passed**.
- Both test batches use `--maxWorkers=1` with `ROOM_TAG`, `ROOM_OWNER`, and `ROOM_SERVER` unset; the first batch finished before the second began. Scratch probes use real Git 2.45.2 on Darwin. No agents were spawned. The sandbox rejected the attempted `nice -n 10` adjustment with `setpriority: Operation not permitted`.
- Scratch scripts/logs remain under `/tmp/astra-review-r9*`; fixture repositories are removed by each script. All script adaptations and new probes are outside the repository.
- No socket integration suite was attempted; those require listeners unavailable in this sandbox. No full CI, typecheck, plugin rebuild, host eval, or Windows/Linux execution claim is made.

- Required `room_preview_merge(people:["rohanz"])` completed **without conflicts**, common ancestor `7438563806`; only this report differed. No test command was requested for the document-only combined tree.
- `git diff --check` passed. This report is the only changed repository path. No source/test edits, commits, or pushes.

**Final verdict: not ready to sign off.**
