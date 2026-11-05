# SQLite state spec review — 2026-11-05

**Verdict: needs revision. Must-fix count: 3.**

Reviewed `docs/superpowers/specs/2026-11-05-sqlite-state.md` against checkout HEAD `9183d80c221d9ef99db893b60744b6f1eb4d99f5`, its cited source, plugin launch configuration, README, reference, roadmap, decisions, and `CLAUDE.md` (the `AGENTS.md` symlink). The spec is untracked in this checkout. This is a design/source review, not an implementation or crash-test result. An in-memory SQLite capability probe was run; no Room state was opened or migrated. No host session was restarted. This review task writes only the requested review file; other concurrent workspace changes are outside this review.

## Must-fix

### M1. Resolve the runtime prerequisite at the actual MCP launch boundary

The engine section identifies the API floor and WAL advisory, but leaves the usable runtime and rollout decision open. Neither host configuration supplies that runtime:

| Surface | Launch in this tree | Consequence |
|---|---|---|
| Claude MCP | `.claude-plugin/plugin.json`: `command: "node"`, `${CLAUDE_PLUGIN_ROOT}/server/room-mcp.mjs` | Resolves Node in the host's launch environment; no version pin or SQLite flag. |
| Codex MCP | `.codex-plugin/plugin.json` delegates to `codex-mcp.json`: `command: "node"`, `./server/room-mcp.mjs`, `cwd: "."` | Also an external Node; the host executable's runtime/version does not establish this child's capability. |
| Claude hooks | `hooks/claude.json`: `node` plus the two hook paths; SessionStart adds `--host claude` | Independently launched commands, five-second host timeout. |
| Codex hooks | Frozen `hooks.json`: `node` plus `${PLUGIN_ROOT}/hooks/session-start.mjs` or `before-edit.mjs` | No SQLite flag and no permission to solve this by changing the frozen manifest. |

All paths in this table are under `plugins/room/`. Both hook entry scripts import `common.mjs`, which uses Node built-ins and the file/loopback bridge, not SQLite. Retaining that boundary avoids imposing the MCP's new runtime requirement on hook SQL access; it does not establish which Node either host actually resolves.

**Concrete scenario:** a user meets today's Node 22+ requirement with 22.12, or a GUI host retains an older PATH after the terminal Node is upgraded. A static SQLite import prevents the MCP from reaching its proposed explanatory error. Alternatively, Node 22.14 loads SQLite successfully but still fails the proposed WAL gate. This checkout's shell probe actually returned `/usr/local/bin/node`, `v22.14.0`, and `SELECT sqlite_version() = 3.47.2`. That is shell evidence only, not a measurement inside Claude or Codex's MCP/hook children.

**Required revision:** select at least one qualified runtime/distribution and state how supported host launches obtain it. Require a pre-storage capability check with a catchable import before loading the SQLite-backed application, reporting the resolved executable, Node and SQLite versions with a restart remedy. Include a launch-context matrix for both MCP hosts and both hook commands; unknown launch contexts must remain unqualified, not inherit terminal results. Make the compatibility release perform this preflight before maintenance or conversion. Keep hooks dependency-free and `hooks.json` unchanged.

The API dates are supported: SQLite was added in [Node 22.5](https://nodejs.org/download/release/v22.14.0/docs/api/sqlite.html), and the flag was removed in [22.13.0](https://nodejs.org/en/blog/release/v22.13.0). The [SQLite WAL advisory](https://sqlite.org/wal.html#walreset) identifies 3.51.3 and the named fixed backports. Merely checking `>=22.13` does not implement that gate. This is Engineering priorities 2 and 4: supported-host behavior and evidence before shipping.

### M2. Specify one migration/activation owner and a barrier that covers whole operations

The spec says concurrent migrators serialize via SQLite and describes DB completion followed by marker publication. It does not define the owner across staging, backup, DDL, source revalidation and marker publication; nor how ordinary connections and compatible old writers remain excluded throughout that interval. `BEGIN IMMEDIATE` serializes SQL transactions, not the surrounding asynchronous filesystem work or Git operations. A `min-reader` version alone is not a rule for older writers.

**Concrete scenario:** a compatibility MCP admits a collect after checking that no activation marker exists, then waits on Git. A migrator scans the old files and commits the imported snapshot. The collect completes and updates legacy pending-cleanup/retirement state before or after marker publication. Checking the marker only at startup or before the individual write does not make this admission-to-effect interval quiescent. A second migrator can also stage an older manifest and publish a marker unless completion and generation are rechecked after acquiring migration ownership. The stated maintenance requirement forbids these outcomes, but currently provides no protocol that enforces it.

**Required revision:** define the maintenance entry point, eligible owner (MCP or explicit offline migrator), durable migration generation and recovery after owner death. Specify the lock order with legacy collection/operation locks and preview helpers; how compatibility processes register, drain and refuse new operations; and what proves that unmodified 0.17.32 writers cannot still run. Unknown evidence must stop conversion as the spec already requires. All openers must check migration/version state under the same serialization boundary before preparing writable repositories. Define DDL/version updates, minimum writer compatibility, loser behavior, startup/import deadlines, marker contents and durable publication, and reopening after each crash boundary. Apply the equivalent barrier separately across all clones for ports, or defer that conversion.

Existing `worker-registry.ts:1283` has an explicit migration lock, identity-based recovery, a wait deadline and stable import assignments. The replacement must state who inherits those responsibilities, including future SQL-to-SQL migrations while other MCP connections exist. Add forced interleavings for the scenarios above. This is priorities 1, 2 and 3: file preservation, recovery and clear ownership.

### M3. Make quarantine barriers representable and enforceable in the schema

Migration step 4 requires blocked/tombstone entries even without a valid worker row. The logical schema instead describes required worker phase/identity/payload fields, worker references from tags/runs/shared owners, and generic `invalid_records` diagnostics. It never identifies the relational target for an invalid worker or the queries that must consult its blocking reservation. A generic error row is not a tag, capacity or checkout constraint.

**Concrete scenario:** `workers/W.json` has already been renamed to `quarantine/W.json.bad-…`; `tags/build.json` still reserves W, and a valid borrower still names W as its shared owner. Today's `hasQuarantinedRecord`/`writeIntent` retains that tag rather than interpreting a missing worker as reusable (`worker-registry.ts:449`, `:693`). Importing only valid workers makes the proposed references impossible to satisfy. Dropping the reservation or borrower link to satisfy them permits tag/checkout reuse; fabricating a normal worker row can create capabilities unsupported by evidence. Quarantined run facts also lose parent-directory context because quarantine stores only the basename (`worker-registry.ts:441`); `1.report.json.bad-…` need not identify which worker it came from.

**Required revision:** choose an explicit identity/tombstone parent representation, or separate reservation/blocker tables with documented referential rules. Define how tags, shared owners, runs, operations, capacity accounting and cleanup behave for each blocked state. Where original evidence cannot establish the affected worker/path, specify the conservative scope of the block and the human recovery route; do not guess from a basename. Preserve raw bytes and source provenance independently of valid payloads. Import fixtures must cover an already-quarantined worker, a valid borrower pointing to it, a reservation without a valid payload, ambiguous quarantined reports, and malformed holds/policies. The assertion is that the same actions remain blocked after import and restart, not merely that import reports an error. This is priorities 1 and 4.

## Should-fix

1. **Separate consolidation from demonstrated race repair.** Add a table-to-invariant/test mapping and a deletion budget. The recent releases do not justify every proposed table as a race fix; the assessment below identifies the gaps. Defer independent domains if their only rationale is that they are JSON today. Moving storage while retaining every existing semantic mechanism can increase total maintenance work.
2. **Define bounded SQL maintenance.** The `changes`, `imports`, `invalid_records`, instance history and observation tables need retention limits and batch budgets, not only a future retention question. Choose the passive-checkpoint owner, cadence and `wal_autocheckpoint` policy. Default automatic checkpoints can still execute on a committing synchronous connection; `busy_timeout=0` does not bound query, fsync or checkpoint time. State pressure behavior when a long reader pins WAL. Measure hook-facing latency before deciding about a worker thread. See [SQLite WAL checkpoint behavior](https://sqlite.org/wal.html#ckpt) and [PRAGMA configuration](https://sqlite.org/pragma.html).
3. **Document semantic lease ordering and cancellation.** A DB write lock does not prevent cycles between committed destination, worker, owner and maintenance leases. Specify acquisition/release order, nested discard→stop behavior and cancellation cleanup, including post-effect failures. Preserve the distinction between a one-second SQL retry budget and a 30-second destination-lane wait.
4. **Correct citation precision and hook timing language.** Corrections are listed below. The 700/300 ms values bound connection/default request timing, not the entire hook: both scripts explicitly allow a separate 1,000 ms confirmation. `openMcp.request(body, ms)` can override the original deadline. Describe these as selection budgets, with the five-second manifest timeout separately.
5. **Do not call hook files single-writer without qualification.** A per-session pathname separates sessions, not concurrent invocations within one session. SessionStart and before-edit both update `hook.json`; MCP fallback can write `session.json`. Parallel hooks can publish older timestamps last. Define observation ordering (including clock rollback and equal timestamps), acceptable loss for diagnostic/suppression records, and ensure stale observations never become identity or delivery authority. Retaining the current best-effort bridge is different from making it a durable event journal.

## Table-by-table necessity against 0.17.26–0.17.32

“Preserve” below means a required existing invariant when moving that domain, not evidence that SQLite fixes the cited incident.

| Proposed tables | Release connection and justification |
|---|---|
| `schema_meta`, `imports` | New migration machinery; no race in this release range justifies it independently. Necessary only because conversion/versioning is chosen. M2 governs it. |
| `instances` | Preserve identity and unknown-liveness handling. 0.17.30 zombie and 0.17.32 cwd evidence are process-probe fixes; storing identities does not implement those probes. |
| `workers` | 0.17.31 pending collected-worktree cleanup supplies a concrete recovery invariant. Atomic phase/intent/history updates are a storage rationale; keep the cleanup state machine. |
| `tag_reservations`, `adoptions` | Existing incarnation and legacy-ownership contracts, not new races fixed in these releases. Preserve them with M3; justify separate normalization by constraints/queries. |
| `runs`, `run_reports`, `exit_observations` | Preserve admission and witnessed/unwitnessed exit ordering underlying 0.17.28 signal reporting and 0.17.31 cleanup. SQLite cannot supply the missing host identity or an unwitnessed exit code. |
| `leases` | Existing operation/destination/writer/publisher lanes. 0.17.30 duplicate-lead graph suppression uses publisher ownership, but the fix was respecting that ownership. Transactions can consolidate admission; they cannot replace long-lived semantic leases. |
| `review_holds` | Pre-existing checkpoint contract, not a 0.17.26–32 fix. If collection admission moves, holds must share its serialization domain. This is an invariant-based reason to move together. |
| `room_cleanup` | Preserve per-room retirement and the 0.17.31 completion/retirement recovery. Atomic archive plus cleanup intent has a concrete use. |
| `discard_steps`, `patches` | Existing replay and recovery-byte contracts; no identified new race in this range. Splitting them from the worker payload needs an explicit query/constraint benefit. Bytes and fsync remain external. |
| `choices`, `checkout_tags` | 0.17.30 made failed remember/forget visible. SQL does not supply error propagation. Transactional choice/tag updates are plausible consolidation, not evidence that those diagnostic failures need a database. |
| `sharing_policies` | Preserve revocation and conservative import. 0.17.30's `.roomignore` failure fix concerns a file deliberately left outside SQL. No new sharing-table race demonstrated by that fix. |
| `session_cursors`, `cursor_routes` | Existing routing/frontier contract. No specific race in this range demonstrates that two normalized tables are needed. State query and transaction requirements. |
| `notice_receipts`, `wake_attempts` | Preserve distinct handoff and uncertainty evidence. 0.17.28 startup binding and 0.17.31 malformed-reply handling are not solved by storing these rows. |
| `idle_release_jobs` | Existing crash-replay journal and participant fencing; no specific 0.17.26–32 race. SQL counter/journal consistency can justify consolidation. |
| `hook_observations` | New derived index while source files remain. 0.17.31 fixed bounded reads/pruning in hooks, which stay unchanged in principle. Require a reader/query benefit before adding another durable copy. |
| `preview_entries` | 0.17.26 orphan reclaim, 0.17.27 ordering, 0.17.30 zombies, 0.17.31 bounded cleanup and 0.17.32 quarantine evidence are relevant. None removes OS locks, Git registration checks or process inspection. SQL can atomically record lifecycle/metadata, not solve external deletion races by itself. |
| `invalid_records` | Needed for conversion diagnostics/barriers, but the safety semantics must be explicit (M3). The 0.17.30 corrupt-store incidents largely concerned credentials and hosted stores left outside this DB. |
| `changes` | New cross-process invalidation mechanism replacing scans/stringification. No direct race fix in the range; require measured scan savings and retention-gap tests. |
| `port_reservations` | 0.17.31 repaired release when a worker stops/retires. A user-wide unique key helps allocation but does not repair a missing release callback. Keep token compensation and reconciliation; separate DB is necessary only if this domain moves. |

0.17.29 changes exports only. The 0.17.26 login-capability cache, 0.17.28 conflict notice grouping, 0.17.30 mode comparisons and hosted fixes do not justify local tables. No table should claim to fix those incidents.

## Notes: concurrency, crashes and state left outside SQL

Several MCPs need independent connections to the same canonical common-dir database. Hooks remain concurrent file writers and IPC clients, not additional SQLite connections. WAL still has a single writer; short snapshots, whole-transaction asynchronous BUSY retries, `BEGIN IMMEDIATE`, seq checks and token/generation-checked leases address different parts of that concurrency. BUSY can also occur during open/recovery/close, so the retry policy must include bootstrap. None of this makes arbitrary filesystem effects transactional.

Today's registry files are not plain unsafe overwrites: `packages/relay/src/leases.ts:78` fsyncs exclusive temporary files; `:93` publishes with an exclusive hard link; `:104` renames and syncs the directory. Guards serialize replacement and stale recovery. SQLite's improvement is atomic updates across related facts and constraints, not discovering atomic publication. Hooks at `common.mjs:223`, preview metadata at `preview-cache.ts:251`, and remembered-tag writes in `choice.ts:91` have lighter temp/rename semantics without those fsync guarantees. Do not flatten these into one baseline.

WAL/FULL preserves committed SQL facts subject to filesystem guarantees; losing one database can affect far more domains than losing one JSON record. Keep backups with WAL-aware handling and retain the external-effect journals. Patch publication must still durably order recorded hash, bytes and acknowledgement. A restored old DB cannot undo collection, restore deleted worktrees or revoke already-published text. The spec's no-reset/no-silent-fallback requirements remain acceptance criteria.

Leave collaborative Y.Doc state, shared message receipts, relay memory/discovery/key authority, Git state/worktrees, carry/collection refs, patch bytes, raw worker logs/env files, profiles, ledger exports, browser files, `room.json`, ignore/link rules and Git excludes outside this change. Global credentials and hosted LevelDB/File/Pg state have different ownership and failure boundaries. The 0.17.31 relay final-save fix belongs to that separate persistence lifecycle. `run-log-facts.ts` is a bounded derived in-memory cache, not a hidden durable store. Preview OS locks/helpers must outlive MCP crashes; metadata rows cannot substitute for them. Temporary timing markers remain disposable diagnostics.

The priorities also require measured resource use and useful diagnostics: no performance gain has been demonstrated here, and unknown/quarantined state must be visible without logging private payloads. The proposed test plan is a future requirement, not completed evidence.

## Citation audit

All **123 distinct local file:line targets** in the spec exist, including abbreviated references expanded to their enclosing file. Repeated targets are counted once. The inventory below records every target; function-entry citations were checked against their enclosing bodies, not just the named line. Most support the associated claim with that context. These qualifications/corrections prevent treating existence as exact support:

- `CHANGELOG.md:19` is blank. Cite `:22` for zombies and `:27`/`:28` for credentials/hosted registry read errors. `:3`, `:7` and `:34` are headings; their sections support the summary.
- `preview-cache.ts:67` is blank; use `:68` for `tryPreviewLock`. `:259` ranks entries and calls a supplied remover; it does **not itself acquire a lock**. The “eviction locks before removal” claim requires `packages/room-mcp/src/tools/files.ts:1415`–`:1428` (lock, metadata recheck, quarantine, registration and removal). The behavior exists, but the citation alone is incomplete.
- `owned-file.ts:38` is blank; recursive guard recovery starts at `:39`/`:41`. `:19` is the containing acquisition function.
- `before-edit.mjs:77` declares `confirm`; the 700 ms selection connection is `:78`. `:164` handles coordination receipts; the relevant stdout and message-confirm sequence is `:162`–`:168`. Startup's 300 ms is at `session-start.mjs:41`, with separate confirmation at `:62`. The “total request time” characterization needs the qualification in should-fix 4.
- `worker-registry.ts:441` quarantines; the tag-reuse barrier is `:449` and its use in `writeIntent`. The claim is supported across those functions, not by the rename alone. `:681` reads reports; writer/exit behavior is supported by the separately cited `:1131` and `:1160`.
- `docs/reference.md:89` covers checkpoints; `:97` covers retention/workers. The spec lists them in the opposite narrative order, but both subjects are present. `:121` is a section heading, with the contract at `:123`/`:125`.
- `policy-store.ts:61` keys current files by room and participant. Server origin is considered in legacy disclosure/import matching, not an explicit dimension of that file key. “Preserve server-origin distinctions” is a proposed requirement that needs a key definition, not proof that today's primary key already contains it.
- `package.json:35` is the engines object; its Node range is `:36`. `run-log-facts.ts:50` starts the constants, with the bounded Map at `:54`–`:56`. These nearby anchors support their claims in context.

## Three questions the maintainer must answer

1. **Which exact Node distributions/patches and native filesystem combinations will this release support, and how will both hosts' actual MCP launch environments pass the SQLite gate while frozen, dependency-free hooks continue working?**
2. **Will migration require a compatibility release and an explicit stopped-writer window; who owns and proves that barrier, including future schema upgrades and the separate all-clones port cutover?**
3. **What is the minimum migration scope worth shipping: which tables have a demonstrated invariant/query benefit, and what blocked-record, backup/importer retention and human-recovery contract must survive conversion and any rollback?**

## Complete local citation inventory

| File | Cited lines checked | Result |
|---|---|---|
| `docs/roadmap.md` | 25, 36 | Exists; claim supported in surrounding code/text. |
| `CHANGELOG.md` | 3, 7, 19, 34, 40, 41, 48, 52, 59 | Exists; qualifications above. |
| `packages/room-mcp/src/worker-registry.ts` | 73, 428, 441, 465, 493, 541, 563, 607, 654, 681, 693, 733, 749, 755, 771, 913, 921, 939, 979, 1130, 1131, 1147, 1159, 1160, 1270, 1276, 1283, 1303, 1327 | Exists; qualifications above. |
| `packages/relay/src/leases.ts` | 33, 93, 104, 157 | Exists; claim supported in surrounding code/text. |
| `plugins/room/hooks/common.mjs` | 26, 217, 223, 239, 304, 684, 694, 710, 737 | Exists; qualifications above. |
| `docs/superpowers/reviews/2026-11-04-cleanliness-room-mcp.md` | 3, 73 | Exists; claim supported in surrounding code/text. |
| `docs/reference.md` | 89, 93, 95, 97, 109, 121, 123, 125 | Exists; qualifications above. |
| `packages/room-mcp/src/collection-review.ts` | 9 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/presence-end.ts` | 21 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/publisher-lease.ts` | 1, 20, 83 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/choice.ts` | 26, 40, 54, 55, 91 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/policy-store.ts` | 28, 61, 96, 138, 192 | Exists; qualifications above. |
| `packages/room-mcp/src/retire.ts` | 20, 80, 131, 220 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/ledger.ts` | 47, 144, 295, 313 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/wake-reconciler.ts` | 385 | Exists; claim supported in surrounding code/text. |
| `plugins/room/hooks/session-start.mjs` | 29, 41, 56 | Exists; qualifications above. |
| `plugins/room/hooks/before-edit.mjs` | 26, 34, 77, 103, 164 | Exists; qualifications above. |
| `packages/room-mcp/src/session.ts` | 151, 726 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/hooks-bridge.ts` | 96, 168, 179, 209 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/arbitration.ts` | 99 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/port-reservations.ts` | 10, 28, 42 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/owned-file.ts` | 19, 38 | Exists; qualifications above. |
| `packages/room-mcp/src/preview-cache.ts` | 67, 109, 175, 213, 225, 251, 259 | Exists; qualifications above. |
| `packages/room-mcp/src/timing.ts` | 152 | Exists; claim supported in surrounding code/text. |
| `packages/room-mcp/src/run-log-facts.ts` | 39, 50, 110, 145, 159 | Exists; qualifications above. |
| `README.md` | 9 | Exists; claim supported in surrounding code/text. |
| `package.json` | 35 | Exists; qualifications above. |
| `packages/room-mcp/src/local-migration.ts` | 1 | Exists; claim supported in surrounding code/text. |

Must-fix count: **3**.
