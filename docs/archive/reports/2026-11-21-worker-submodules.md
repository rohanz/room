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
spawn/prompt notes. There is no size cutoff: large submodules remain eligible. Setup
runs asynchronous Git commands with an eight-second total command/inspection budget,
at most 64 configured submodules, and at most eight nested levels. It stages its own
clone beside the final destination, records creation refs and reflogs outside the
worker tree in the worktree Git admin directory, and publishes only complete setup.
Failed attempts are stopped and their staging removed before returning empty with
local commands. Removing staged files can add filesystem cleanup time after the
budget. Existing worker contents are not overwritten.

The preservation rule is creation refs (all refs plus symbolic HEAD), creation
reflogs, and clean status including untracked and ignored files. Any mismatch or
unverifiable state retains the clone, even on discard. This protects stashes, private
branches and commits preserved only by reflogs, and avoids scanning/hashing the
object store. Incidental index refreshes, `FETCH_HEAD` and `ORIG_HEAD` do not themselves
retain a clean clone. The lead explicitly scoped objects reachable from no ref or
reflog out of the preservation guarantee; that boundary is in the reference.

With no `.gitmodules` and no existing receipt, setup/cleanup run no Git command for
this feature. Configured paths alone are queried from the index. The ordinary
40,000-entry regression produced more than 5 MiB of stage listing on the old code;
now neither that listing nor any Git command is issued. Legacy or manually populated
mapped submodules without creation evidence are retained. Nonstandard gitlinks with
no `.gitmodules` entry keep previous handling, as agreed with the lead.

## Initial real repository trial (before review)

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

## Review regressions and real repository rerun

The added stash, reflog-only reset and ordinary 40,000-entry index assertions all
failed against the initial implementation. The corrected implementation passed those
cases, a real killed-child checkout timeout, private-branch retention, missing
creation evidence, unchanged incidental Git metadata, and broken-ref warnings. The
original lifecycle integration was split into collection and discard cases so each
finishes within the focused test deadline under concurrent load.

Repeated the same real bqst/JUCE fixture using throwaway clones. The source checkout
and original Git metadata were read only; every hash checked above stayed unchanged.
The fixture again required a one-time `--no-hardlinks` seed because of sandbox source
link restrictions; the tested worker object pack was hardlinked. A 20 ms interval
sampled the event loop during each setup. These are individual warm-filesystem runs,
not a production latency guarantee; the APFS volume reported 98% used / about 20 GiB
available, and concurrent validation load varied.

| Attempt | Outcome | Setup + cleanup | Maximum timer gap |
| --- | --- | ---: | ---: |
| Early private-admin staging, default 8 s | Empty, guided; timeout, no staging left | 8,701 ms | 39 ms |
| Early private-admin staging, candidate 15 s | Empty, guided; checkout timed out, no staging left | 20,936 ms | 28 ms |
| Destination-side staging, 8 s default | Ready, pack hardlinked, real stash retained | 1,399 ms | 22 ms |
| Same run, forced 1 s budget | Empty, guided; no staging left | 1,297 ms | 21 ms |
| Final source, destination-side staging, 8 s default | Ready, pack hardlinked, real stash retained | 973 ms | 21 ms |
| Final source, forced 1 s budget | Empty, guided; no staging left | 1,215 ms | 23 ms |

The final ready run spent 28 ms cloning the objects and 800 ms checking out JUCE;
its C++17 header syntax check passed in 473 ms. The earlier destination-side run's
header check passed in 663 ms. Both normal and forced-budget trials removed all
private staging, and explicit disposal of each throwaway worker succeeded after
verifying stash preservation. The destination-side location also guarantees rename
publication stays on the target filesystem; differences in load/cache conditions
prevent attributing the timing improvement solely to that location.

A stricter Git-stderr check briefly declined ordinary detached-source clone hints.
That regression was caught in tests and a throwaway real run (199 ms and 213 ms
empty outcomes); pinning the temporary default branch name suppresses those hints,
while an actual unverifiable-ref warning still retains the clone. The final-source
rows above include that correction.

Thus usable local objects, hardlink support, checkout I/O and current machine load
choose ready versus empty within the budget. Large size alone does not choose the
empty path, and a slow attempt cannot publish partial contents. No parallel checkout
policy was introduced. There was no rerun of a model-backed worker or full app build.

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
