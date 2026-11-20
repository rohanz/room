# Worker submodules: local setup trial, 2026-11-21

## Choice

Populate clean, matching submodules with an explicit `git clone --local --no-checkout`
and a detached checkout of the worker's recorded gitlink. Git metadata and working
files are independent. The clone's origin remote is removed so a normal worker push
cannot target the lead's submodule. Object files are hardlinked: no full object-store copy, no
network, and no dependency on the source retaining its object filenames during GC.
The lead accepted object link-count changes; its object contents, refs, index and
configuration must stay unchanged. `--shared` was declined because source GC can
corrupt alternate-backed borrowers.

Dirty or mismatched checkouts, missing initialization, object alternates, linked paths,
missing objects, unavailable hardlinks, and bounded setup failures get explicit
spawn/prompt notes. Empty destinations get local clone commands pinned to the worker
commit. Existing or partial output is preserved. Setup has a 30-second total budget,
at most 64 submodules, and at most eight nested levels. It never switches to an
unbounded copy or remote clone. Submodule contents/gitlink changes remain outside
Room collection; cleanup retains submodule edits, commits and ignored files even on
discard because a superproject recovery ref cannot recover nested repository work.

## Real repository trial

Host: macOS 26.5 / Darwin 25.5.0 arm64, Git 2.45.2, Node 22.23.4; other batch workers
were active, so these are single observed timings, not a latency benchmark.

- Repository: `rohanz/bqst`, main checkout commit
  `d928fae82b10eb625382960bfec55a1a01865c77`.
- Large submodule: `external/JUCE`, recorded commit
  `501c07674e1ad693085a7e7c398f205c2677f5da`.
- Source objects: 275,736 packed objects; one 284,059,189-byte pack. The source
  checkout occupied approximately 91 MiB, and the object store approximately 279 MiB.
- Created a throwaway superproject clone, then seeded its JUCE clone from the existing
  local repository with `--no-hardlinks`. This one-time fixture preparation copied the
  objects because the Codex filesystem sandbox forbids creating hardlinks to files
  outside its writable roots. The first fixture attempt using `--local` alone failed
  with `Operation not permitted`; it was not counted as a successful run.
- All tested worker setup and removal ran between throwaway checkouts inside the
  temporary root. The final `prepareWorkerSubmodules` populated JUCE in **6,442 ms**
  (an earlier run took **16,554 ms**, with different concurrent load). Source
  and worker pack device/inode pairs matched, proving the worker pack was hardlinked.
- A C++17 translation unit including `juce_core/juce_core.h` passed
  `c++ -std=c++17 -fsyntax-only -I<worker>/external/JUCE/modules probe.cpp`
  in **2,102 ms** on the final run (**2,357 ms** earlier). This verifies usable
  headers; it is not a complete bqst/JUCE build.
- The clean-submodule cleanup guard passed. `git worktree remove --force` removed
  the populated worker. SHA-256 hashes of the existing source's `HEAD`, index,
  configuration and packed refs were identical before/after. All throwaway output
  was removed. No command initialized, updated or checked out the existing source.

## Verification limits

Focused fixtures exercise actual spawn/prompt notes, nested population, local WIP,
different gitlinks, uninitialized sources, linked paths, object alternates/missing
objects, object unlink survival, collection, preview, discard and submodule-work
retention. An injected cross-device hardlink failure checks that setup reports empty
with guidance and never retries a copying clone. Current combined-preview and
typecheck results are recorded in the worker's completion report.

Linux and native Windows were not run live. An actual second filesystem or filesystem
without hardlinks was not available; that failure boundary is injected. No actual
Codex/Claude worker model was launched for the JUCE trial, and the full application
build, remote fetching and LFS object population were not tested. Automatic setup
deliberately does not fetch missing or LFS objects. The lead owns full release checks
and the plugin bundle rebuild.
