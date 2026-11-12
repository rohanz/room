# Fresh MCP memory attribution, 2026-11-13

The reported **592 MB was not reproduced**. The committed plugin bundle used **260.1 MiB RSS at one minute** against a complete copy of the owner's local state. An instrumented build from current sources used about **264 MiB after GC**, peaking around **383 MiB while indexing**. Disabling the index reduced the copied-state process to **161.6 MiB**. There is no demonstrated unnecessary 300 MB JS cache to remove. No production behavior was changed.

All units below are MiB (1,048,576 bytes), including columns named external/ArrayBuffers. These counters overlap: ArrayBuffers are included in external; worker RSS is the entire process's RSS, not that thread's private RSS. Differential RSS measurements and heap dominator sizes are different kinds of evidence and must not be added together.

## Machine, fixtures and method

Darwin 25.5.0 arm64, Apple M2 Max, 32 GiB RAM; Node v22.23.4. Source HEAD `894bce9c39ef09a7f41fdcc0ad4690e7523f95ed`. Measurements ran through `room_preview_merge(people=["rohanz"], run=...)` on the lead's side, since this worker's sandbox denies both tsx CLI's Unix socket and MCP's loopback listener (`listen EPERM`). Measurements ran as foreground commands; no host background-lifetime assumption was made.

`scripts/measure-mcp-memory.mts` starts Node with the MCP entry bundle over stdio, exchanges initialize/initialized and calls `room_state`, like a host. The normal mode bundles the current checkout using the plugin's esbuild options, inserting probes at first sync, join, index completion, worker start/exit and grammar loads. A preload records `process.memoryUsage()` and V8 heap statistics every second in every isolate. Only the main process takes a heap snapshot, after the one-minute sample and explicit GC. `--shipped` copies the committed bundles unchanged except for a final sampling timer: it independently checks the actual distributed entry. The daemon is the committed standalone bundle, a separate process excluded from MCP RSS.

The harness clones the owner's repository into a private temporary directory with `git clone --no-hardlinks`, keeping the basename `aitinkerhackathon` so the saved local-room key matches. It copies **all** of `.git/room`, with no exclusions, before startup. Only in the scratch copy it renames `relay.json` to `relay.original-copy.json` and `hub/authority.lock` to `authority.lock.original-copy`, preserving their bytes while preventing adoption/blocking on the owner's live daemon. All records, retired names, logs, persistence, leases and registry data are copied. The source state is never opened for writing. Every successful fixture launches its own daemon. The final harness stops that daemon through its own discovery and the daemon CLI, verifies snapshot completion, and leaves private evidence under the printed temp directory.

The clone actually had **1,427 tracked files**, not 2,000; 885 source paths were considered by the graph, and 1,578 native filesystem watcher handles appeared in the heap. The saved document was about **3.34 MB decimal** at copy time. Each copy is live-file copying, not an atomic filesystem snapshot; independent runs can differ by a few messages. A fresh HOME and `ROOM_OWNER=MemoryProbe`, `ROOM_SHARE=intent` isolate user configuration. These are clean committed clones, not copies of the owner's uncommitted working tree or host session. Copied registry refs/worktree locations are not recreated. These differences limit comparison to the original doctor observation.

Reproduce each case separately to stay below the five-minute preview limit:

```sh
node --import tsx scripts/measure-mcp-memory.mts --owner /absolute/owner/clone --case small --seconds 60
node --import tsx scripts/measure-mcp-memory.mts --owner /absolute/owner/clone --case fresh --seconds 60
node --import tsx scripts/measure-mcp-memory.mts --owner /absolute/owner/clone --case state --seconds 60
node --import tsx scripts/measure-mcp-memory.mts --owner /absolute/owner/clone --case state --seconds 60 --no-index
node --import tsx scripts/measure-mcp-memory.mts --owner /absolute/owner/clone --case state --seconds 60 --shipped
```

`--native` also requests a macOS `vmmap -summary` before the inventory and heap snapshot. The script writes `fixture.json` with copy time, HEAD, tracked count and the saved document's byte size/SHA-256. Heap snapshots contain private source and messages and are deliberately not committed.

## Measurements

Entries are **RSS / main heapUsed / main external / main ArrayBuffers**. “Start” is the preload before the application module, not OS exec's first instruction. First sync happens before join returns. GC/snapshot creation is excluded from one-minute RSS comparisons.

| Phase | Tiny fresh repo (one TS file) | Room repo, fresh state | Room repo, copied state |
|---|---:|---:|---:|
| Start | 41.8 / 4.2 / 1.7 / 0.01 | 41.8 / 4.2 / 1.7 / 0.01 | 41.7 / 4.2 / 1.7 / 0.01 |
| Bundle loaded (~0.1 s) | 85.2 / 19.2 / 3.5 / 0.09 | 85.4 / 19.2 / 3.5 / 0.09 | 85.5 / 19.2 / 3.5 / 0.09 |
| First sync (~0.4–0.6 s) | 92.3 / 20.6 / 3.7 / 0.12 | 92.6 / 20.7 / 3.7 / 0.12 | 134.3 / 40.6 / 22.8 / 19.2 |
| Joined (~6 s) | before parser: RSS 97.2 | before parser: RSS 130.1 | 157.9 / 39.4 / 13.4 / 9.8 |
| Index ready (~6.3 / 9.3 / 10.5 s) | 125.8 / 25.2 / 3.8 / 0.18 | 294.9 / 47.9 / 5.7 / 2.04 | 383.2 / 106.1 / 20.3 / 16.7 |
| Parser exited (~36 / 39 / 40 s) | RSS 100.0 | RSS 207.6 | RSS 265.1 |
| One minute | 100.7 / 20.2 / 3.7 / 0.13 | 208.3 / 34.0 / 3.7 / 0.13 | ~264 RSS, ~58 heap before inventory; see note |
| After explicit GC | 100.7 / 19.3 / 3.7 / 0.12 | 208.3 / 32.7 / 3.7 / 0.12 | 263.8 / 52.3 / 3.8 / 0.12 |

The first copied-state probe computed the inventory before recording its “minute” sample: it reported 271.0 MiB RSS / 69.4 heapUsed, including that transient allocation. Its preceding tick was 264.4 MiB RSS / 58.1 heapUsed. The harness now samples **before** inventory generation. No conclusion uses the inventory-inflated number as an idle measurement.

Additional independent controls:

| Case, copied state at one minute | RSS | heapUsed | external | ArrayBuffers |
|---|---:|---:|---:|---:|
| Index disabled (no parser threads) | 161.6 | 49.6 | 3.9 | 0.25 |
| Same, after explicit GC and inventory | 166.8 | 41.8 | 3.9 | 0.12 |
| Shipped bundle | 260.1 | 59.6 | 3.9 | 0.25 |
| Shipped, after explicit GC | 260.3 | 52.2 | 3.9 | 0.12 |

**Native follow-up:** `7lcmn1` independently measured **260.9 MiB RSS / 59.6 MiB heapUsed / 3.86 MiB external / 0.246 MiB ArrayBuffers** at 60 s. `vmmap -summary` then reported physical footprint **139.9 MiB** (peak 342.9), malloc zone **126.0 MiB resident**, **8.46 MiB allocated**, **34.5 MiB dirty fragmentation (81%)**, and **82.8 MiB resident in empty MALLOC_SMALL regions**. V8/other Memory Tag 255 regions were 79.7 MiB resident. `vmmap` totals include shared mapped libraries and do not equal Node RSS; do not sum the mapping totals into RSS. This is direct evidence of substantial resident allocator high-water beyond live JS, not an allocation-stack attribution or proof of a leak. No portable Node API here releases those malloc-zone pages. This favors profiling batching/allocation behavior over deleting small retained graphs. Snapshot creation later raised RSS by another ~80–170 MiB in earlier runs; that measurement artifact is excluded.

**Threads:** exactly one parser worker was created per instrumented indexing run, with Python, TypeScript and JavaScript grammars loaded lazily; zero parser threads remained at one minute. At JS grammar load in the copied-state run, the worker isolate reported **13.0 MiB heapUsed, 38.2 MiB external and 3.3 MiB ArrayBuffers**, while process RSS was 341.5 MiB. External includes the runtime's roughly 32 MiB WASM linear memory; it is not all resident. Worker exit reduced process RSS by about **118 MiB** in the copied-state run and **87 MiB** in the fresh-state run. Other allocations/GC occur simultaneously, so these are lifecycle deltas, not private-thread RSS measurements.

## Five contributors, evidence and proposed reductions

Ranked by practical memory impact. Sizes in this table deliberately identify their measurement type.

| Contributor | Measured size | Needed? Bounded? | What would reduce it |
|---|---|---|---|
| Repository indexing and its native/allocation high-water | With copied state, indexing enabled vs disabled costs roughly **100 MiB RSS** at one minute, but only **10.5 MiB additional live main heap** after GC. A separate native map found **126 MiB resident in the malloc zone**, including **82.8 MiB resident in empty MALLOC_SMALL regions**, and 34.5 MiB dirty fragmentation. Allocation stacks are not attributed. | Index needed for contract analysis. Its inputs/concurrency are bounded; OS resident allocation high-water has no Room-enforced byte bound. | Profile allocation stacks behind the empty/fragmented malloc regions; then test smaller parse/read batches or platform-supported reclamation. Do not equate this remainder with a retained text cache. |
| Fixed Node + loaded plugin + small session floor | **41.8 MiB RSS** before bundle; **85.3 MiB** after module load; **100.7 MiB** tiny-repo idle. Tiny heap snapshot: code 8.3 MiB, strings 6.7 MiB (including a 5.6 MiB UTF-16 module source string). | Runtime/bundle needed. Fixed per process for this version, not proportional to worker count in the registry. | Host/process consolidation or smaller/lazier imports; measure startup and maintenance costs before changing packaging. |
| Active parser isolate/WASM and parsing allocations | One worker; **13.0 heap / 38.2 external MiB** at the observed grammar load; **~87–118 MiB RSS lifecycle drop** on idle retirement. | Needed during parsing, already process-shared, lazy and retired after 30 s idle. No oversized pool. Inputs capped at 256 KiB; crash restarts bounded. | Profile worker native/WASM growth on the largest accepted sources. Existing retirement already removes it before one-minute idle; shrinking a nonexistent pool cannot help. |
| Replicated room data and registry state | Copied vs fresh live heap adds **~19.6 MiB** after GC. Snapshot exclusive dominators: Y.Doc **9.43 MiB**; decoded `_FileWorkerStore` **2.35 MiB**; cached registry text is also retained separately. | Coordination history needed within retention policy. Snapshot has 2,000 bus, 2,000 mail, 2,000 outcomes, 5,006 archive, 200 retired-worker entries. Text read cache is bounded to 4,096 entries, not bytes; document has a serialized-size cap, not a JS-heap cap. | Resolve owed notices and their retention with the owning peer; byte-bound registry caches if later measurements justify it. Do not delete the owner's saved state. |
| Retained symbol graph and repository watcher bookkeeping | GraphIndex exclusively dominates **9.84 MiB** (SymbolGraph beneath it 6.56 MiB); **77,064 symbols**, 885 cache entries, estimate 8.66 MiB, serialized cache 0.94 MiB. Main Chokidar FSWatcher dominates ~0.44 MiB; 1,578 FSWatcher/FSEvent pairs have ~0.17 MiB combined shallow size. | Graph needed. Limits: 3,000 paths, 400k retained symbols, 64 MiB estimated symbol budget, 4,000 symbols/file. Watcher size scales with accepted repository tree; no claim that handle count alone bounds native bytes. | Graph budget or path-priority tuning affects coverage; watcher/backend changes need independent native measurements and responsiveness tests. |

Heap dominators above come from an offline strong-edge dominator traversal of V8 snapshots (weak edges ignored); they are **exclusive retained lower bounds**, not a partition of all process RSS. Shared payloads can be retained through several roots. Fresh vs copied snapshots total about 35.3 vs 54.6 MiB shallow node bytes; those include V8 code/native nodes and need not equal `heapUsed`.

Specific exclusions established by counts: copied replica **9,452 Yjs items, eight deleted**; no overlay roots with text, no owned base texts, no completed publications, no retired-worker source text left in this sample. Live root JSON is dominated by bus (~1.32 MB decimal) and mail (~1.24 MB), then archive (~0.44 MB), outcomes (~0.27 MB) and retired worker summaries (~0.20 MB). Further compaction cannot eliminate a large deleted-history pile that is absent here.

The **2.95 MB built MCP file is loaded once as this process's code**, accounting for its 5.6 MiB source string. Roomd's disk scan does not read oversized working-tree text into Node: it retains metadata/hash and delegates hashing of same-size oversized blobs to Git (`disk-scan.ts`). As repository input, the graph rejects that bundle, the daemon bundle and the web JS bundle at the 512 KiB historical-read limit, before reading body text. The parser additionally refuses text over 256 KiB. At ready/idle the graph's `baseTexts` map has **zero entries**, publishedCache has zero, and no source string of bundle size appears as a second retained baseline in the heap. Its batched base texts are removed in refresh `finally`. Thus the baseline does not retain a second 3 MB copy of the checked-in bundle.

## Evidence, earlier work and limits

Private raw run directories are under the machine's `.../T/room-mcp-memory-*` temp root:

- `iDDwDf`: valid tiny/fresh minute samples and complete snapshots; copied-state startup failed on the preserved live authority lock. Overall command failed; it is not a passing three-case run.
- `VTi4Ym`: successful named preview with rohanz and stale-conflicts rev 17; completed `after-snapshot` marker and verified daemon stop. Minute **259.0 / 59.3 / 3.86 / 0.245 MiB** (RSS/heap/external/ArrayBuffers), post-GC heap 52.3 MiB. Conflicts root empty; graph unchanged. This is an interim snapshot: the peer moved during the run, so it does not validate its latest implementation.
- `7lcmn1`: successful native follow-up; input snapshot 3,336,309 bytes, SHA-256 `eb13f66734848bdc82c04de69ac6b952dbff32012ad635b28dfc63810ca04d4e`. Its native mapping and pre-snapshot samples are valid; its snapshot used the older completion rule.
- `ceD2Bh`: successful copied-state join/index/worker retirement and complete main heap snapshot; first inventory-order caveat above.
- `FquQzA`: index-disabled control; `2uU8DT`: shipped control. Both have valid pre-snapshot measurements. Their older controller could close before snapshot completion, so **those snapshots are not evidence**. The final harness waits for `after-snapshot`, not file existence.

Read `scripts/measure-idle-rss.mts`: it measures hosted server startup against synthetic 40–80 MiB LevelDB state, not this MCP, parser thread or repository. Earlier October soak reports explain native allocation versus live JS-heap differences, but cannot establish this run's native cause. The task's named November 9 daemon RSS-slope rehearsal was absent from both worker and main clone's `docs/superpowers/rehearsals/` and from a content search of main's docs. I asked the lead (addressed send refused because mail is full; broadcast fallback sent); no location was supplied during this investigation. This measures first-minute MCP memory, not long-running daemon slope.

Final harness smoke `LpFZCn` completed join, index, main heap snapshot and verified daemon CLI shutdown on a named lead/stale-conflicts preview; all seven older probe daemon PIDs were independently checked and had exited. The peer changed only a test file while that smoke ran; that file is not an input to the probe bundle. Lead coverage still excluded one path. This 12-second smoke is lifecycle validation, not another one-minute memory measurement.

Validation: `npm run typecheck` passed; root `npx knip` passed; `npx vitest run test/graph-base-batch.test.ts test/graph-retention.test.ts test/parse-worker.test.ts --maxWorkers=1` from room-mcp passed **28 tests in 3 files**. No production tests or expectations were changed. The initial knip run caught the probe's root-workspace SDK import; the final harness uses direct stdio JSON-RPC and needs no new dependency. No production code, built assets, release files or owner state were changed; no commit/push was made.

The stale-conflicts peer confirmed no edit overlap and reports its separate in-memory retirement cleanup recognizes 562 notices, leaving five pending messages. That changes message retention in combined runs, so the baseline copied-state byte counts above are pre-cleanup evidence, not a benchmark of its change.

The exact 592 MB process was not sampled, nor was the 33-hour session, native thread-private RSS, native allocator stack ownership, worker-isolate heap snapshot, long-term memory slope, original host configuration, worker previews, or all full/scale/release suites. Some later lead previews reported partial coverage due one excluded lead path; they validate the probe's execution on the materialized tree, not the complete combined product. This investigation does not establish an RSS ceiling or explain the missing ~300 MiB in the original observation. Next: run the same counters plus native mapping on that exact host session/bundle and its dirty tree before making a memory-policy change.
