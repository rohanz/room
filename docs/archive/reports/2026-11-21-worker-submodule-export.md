# Read-only worker submodule exports, 2026-11-21

This completes the replacement started in `4eae9f4d` ("WIP: submodules as
read-only exports"). The earlier [local-clone trial](2026-11-21-worker-submodules.md)
records a superseded design and its measurements.

## Implementation choices

Kept the WIP's asynchronous `ls-tree` / `cat-file --batch` implementation and
same-filesystem staged publication. Files contain stored blob bytes and are
read-only; directories stay writable. No private repository, object hardlinks,
creation receipt or submodule cleanup inspection remains. The existing spawn
integration already includes the helper's notes in both reply and worker prompt.

Completed the documentation and failure handling: initial filesystem/canonical-path
errors and staging cleanup errors now produce notes instead of rejecting spawn.
A failed stdin write kills the Git child and awaits its completion. Deadline checks
also cover file writes, symlink validation/publication and nested directory creation.
Symlink target decoding preserves a leading UTF-8 BOM; targets over 4 KiB are
rejected before reading them. Safe symlink-chain validation yields to the event loop.
Discovery only populates exact configured gitlinks, not unrelated gitlinks below a
misconfigured ordinary directory. The 64-module limit includes nested boundaries so
a large nested tree cannot produce an unbounded worker prompt. Nested empty folders now name their own pinned
commits and give local filling commands. The manual archive fallback intentionally
streams files and honors archive attributes; it does not promise the automatic
export's raw-byte or read-only behavior.

Preserved established gitlink lifecycle behavior. Ordinary exports/build output do
not prevent collection or discard; keep retains them. A staged gitlink change is a
preview gap and causes apply/keep collection to write nothing and retain selected
workers for manual handling. Discard can still remove that disposable worker.
No collection/preview mechanism was changed to hide pointer changes.

## Real repository measurement

Used a throwaway copy of the existing local bqt superproject and its JUCE object
database under `<temp>`. Fixture preparation used
`git clone --local --no-hardlinks --no-checkout`, checked out only the throwaway
superproject, and copied the submodule Git directory. The temporary lead submodule
contained only its `.git` pointer, demonstrating that no source working-tree files
are needed. No command ran in the original checkout or original submodule, and no
worker Git metadata or objects were linked back to them.

Host: macOS arm64, Node 22.23.4, Git 2.45.2; warm filesystem cache after fixture
preparation. Two Vitest workers were running during the first measurement. This
is an observed local run, not a cold-cache benchmark or production latency guarantee.

Superproject HEAD: `f27ed2cf8b43aa9daee4bd20a71b61cfa3c70efc`; JUCE gitlink:
`501c07674e1ad693085a7e7c398f205c2677f5da`.

| Trial | Outcome | Elapsed including cleanup | Maximum event-loop delay |
| --- | --- | ---: | ---: |
| First default 8 s run, two Vitest workers active | Ready | 1,277.95 ms | 12.52 ms |
| Before final nested guard, default 8 s run, concurrent validation | Timed out, empty with commands, no staging | 10,108.73 ms | 13.36 ms |
| Before final nested guard, default 8 s run, own test jobs stopped | Ready, no staging | 1,134.45 ms | 12.78 ms |
| Before final nested guard, forced 100 ms budget, own test jobs stopped | Timed out, empty with commands, no staging | 111.35 ms | 9.30 ms |
| Exact final source, default 8 s run, own test jobs stopped | Ready, no staging | 1,416.66 ms | 13.22 ms |
| Exact final source, forced 100 ms budget, own test jobs stopped | Timed out, empty with commands, no staging | 112.85 ms | 10.15 ms |

The loaded default-budget trial's harness exited nonzero because it expected a ready
copy. The helper itself returned its guided empty outcome correctly. Cleanup time
is included; this run demonstrates that the nominal eight-second budget is not a
hard filesystem cleanup deadline. Differences in load/cache prevent attributing
timing variation to an implementation change.

All three ready outputs contained **4,377 regular files**, **86,079,069 bytes**, no
writable regular files and no `.git` metadata; this commit contains no symlinks.
Independently hashed every exported file with Git's `blob <length>\0` prefix:
all **4,377 object IDs matched** the recorded tree, on all three ready outputs.
Snapshots around each quiet ready/forced-timeout pair showed no changes in either
the temporary source or original source Git directory: every file's size,
mtime/ctime, mode and link count matched, as did SHA-256 for files below 1 MiB.
Pack contents were not reread for that metadata comparison.

A C++17 probe including `juce_dsp/juce_dsp.h` and using
`juce::dsp::Gain<float>` compiled to an object in **1.37 s**. Compiling the first
export's `modules/juce_dsp/juce_dsp.cpp` took **1.98 s**. Both exited zero with
JUCE's warning that neither `DEBUG` nor `NDEBUG` had been defined. The quiet export's
same source compiled with `-DNDEBUG` in **2.09 s**; the exact final-source export
compiled again in **1.70 s**, writing its object to
`<export>/build/juce_dsp.o`; this confirms real in-tree build output works while the
input files remain read-only.

Compile commands, where `$JUCE` is the exported folder and `$TRIAL` is the
throwaway root:

```sh
c++ -std=c++17 -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 \
  -DJUCE_STANDALONE_APPLICATION=1 -DJUCE_WEB_BROWSER=0 -DJUCE_USE_CURL=0 \
  -I "$JUCE/modules" -c "$TRIAL/probe.cpp" -o "$TRIAL/probe.o"
c++ -std=c++17 -O0 -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 \
  -DJUCE_STANDALONE_APPLICATION=1 -DJUCE_WEB_BROWSER=0 -DJUCE_USE_CURL=0 \
  -I "$JUCE/modules" -c "$JUCE/modules/juce_dsp/juce_dsp.cpp" \
  -o "$TRIAL/juce_dsp.o"
```

## Checks and limits

The original failing different-commit fixture installed a side-effecting filter
before its own checkout, so its setup created the marker before export began.
Installing the filter after that checkout fixes the fixture without weakening the
no-lead-command/no-filter assertions. Added memory-ceiling, BOM-symlink, nested
command, exact-mapping, early-error, cleanup-error, zero-budget, keep and staged
pointer regressions. Missing-object and killed-batch cases verify that partial
read-only staging is removed; a FIFO Git HEAD verifies the event loop keeps ticking.
The 40,000-entry-index case still performs no Git command without `.gitmodules`.

Final source checks:

- Focused export and private-state suites: **26 passed** (2 files, including the final nested-limit regression).
- `npm run typecheck`: **passed** after the final source changes.
- `room_preview_merge(people=["rohanz+claude"])` with the same focused two-file
  command on the exact final source: complete coverage, no conflicts, **26 passed**, exit zero. The lead had
  no additional published file changes; this checked the worker's code in the
  preview environment. Preview source inputs:
  `1f4a6e6e283dac6cfe21b19bcf1353e19b58dcf5928cad0bcf93b62220776911`.
- The first complete worker pass: 32 files passed; only
  `worker-signal-fresh.test.ts` failed because this sandbox denies native process
  inspection (`ps` is denied, ownership becomes `unknown`). Its three tests passed
  when rerun with native process-inspection access. A duplicate sandboxed final
  pass was deliberately interrupted by its own runner PID before the full native
  pass; it is not counted as completed validation.
- Full native-access worker/private-state pass before the final nested-limit guard: **33 files passed; 464 passed, 1 expected failure, 2 skipped**, exit zero in 190.69 s.
- Exact final-source full pass: **33 files passed; 465 passed, 1 expected failure, 2 skipped**, exit zero in **177.75 s**. Command: `env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER node_modules/.bin/vitest run 'packages/room-mcp/test/worker-' packages/relay/test/private-state-writers.test.ts --maxWorkers=2`.

No full bqt application build, link/run of the compiled JUCE objects, model-backed
worker launch, remote fetch, real LFS download, Linux or native Windows live run was
performed. Filesystem operations and cleanup can exceed the nominal deadline on a
stalled filesystem; cleanup failures are explicitly reported. Read-only permission
bits protect against accidental edits, not deliberate replacement by the owner.
Release checks and bundle rebuilding remain the integrating lead's responsibility;
CHANGELOG and plugin assets were left untouched.
