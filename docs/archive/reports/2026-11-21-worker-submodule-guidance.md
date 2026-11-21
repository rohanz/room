# Worker submodule guidance trial — 2026-11-21

Room no longer populates submodules. Startup reads bounded worker metadata and
prints local clone/checkout commands for the worker to run if needed. It never
opens the lead's submodule or writes dependency contents. The export engine,
export-only tests and directory-writer audit allowance are removed. Supplied
`dir=` checkouts retain the creation-only boundary, confirmed by the lead.

## Real repository trial

On macOS arm64 with Node 22.23.4 and Git 2.45.2, made a throwaway local clone of
`bqt` at `f27ed2cf8b43aa9daee4bd20a71b61cfa3c70efc`, seeded its lead-side JUCE
repository from the existing local copy using `--local --no-hardlinks --no-checkout`,
then created an empty worker worktree. JUCE's recorded gitlink was
`501c07674e1ad693085a7e7c398f205c2677f5da`; its object pack was 284,059,189 bytes.
No model worker was launched. All mutable trial data lived in a temporary root,
which was removed after each run.

Called `workerSubmoduleNotes(lead, worker)`, verified that the dependency folder was
still empty, extracted its two printed command lines, and executed each unchanged
with `/bin/sh -ec`. The worker path contained an apostrophe. The final commands had
this form (only the temporary root is abbreviated here):

```sh
git -c protocol.allow=never -c protocol.file.allow=always clone --local --no-hardlinks --no-checkout --template= -- '<lead>/external/JUCE' '<worker>/external/JUCE'
git --git-dir='<worker>/external/JUCE/.git' --work-tree='<worker>/external/JUCE' -c protocol.allow=never -c core.hooksPath='/dev/null' -c submodule.recurse=false -c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false checkout --detach '501c07674e1ad693085a7e7c398f205c2677f5da'
```

Confirmed the checked-out commit matched the gitlink and the copied object pack's
inode differed from the lead's pack. Compiled a C++17 translation unit including
`juce_core/juce_core.h` and constructing a `juce::String`, using:

```sh
c++ -std=c++17 -DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1 -c -I'<worker>/external/JUCE/modules' probe.cpp -o probe.o
```

Compilation succeeded and produced a 1,608-byte object. SHA-256 hashes of the
original JUCE repository's HEAD, index, config and packed refs stayed unchanged.
No command ran with its current directory in the original JUCE checkout.

| Final-source operation | Observed time |
| --- | ---: |
| Read-only guidance discovery | 15.8 ms |
| Largest 5 ms timer gap during discovery | 5.3 ms |
| Printed local clone | 286.7 ms |
| Printed detached checkout | 670.0 ms |
| C++ compilation | 542.6 ms |

These are individual warm-filesystem observations with other validation active,
not a latency guarantee. An earlier trial, before checkout was hardened to use
explicit Git/worktree paths and disable LFS downloads, also passed: discovery
16.7 ms, clone 1,147.3 ms, checkout 6,502.2 ms, compilation 695.4 ms. The final
commands were rerun after that change; their results are the table above.

## Validation and limits

Focused regression coverage includes exact command execution with shell syntax,
spaces and apostrophes in paths; independent copied objects; unchanged lead state;
missing lead repositories; failed-clone checkout refusing parent-repository
fallback; configured LFS filters disabled; linked/existing destinations; no Git
without `.gitmodules` beside a 40,000-entry index; bounded config/output; FIFO and
killed-child handling; once-only spawn/prompt notes; nonfatal spawn failure paths;
and empty dependency folders after a worker base refresh.

`npm run typecheck`, `npx knip`, and all 18 focused guidance tests passed. The first
required worker/relay run passed 32 files but failed `worker-signal-fresh.test.ts`
because the sandbox denies `ps`; its real process probe returned `unknown`.
The required set was rerun with process-probe access: all 33 files passed (461
passed tests, one expected failure and two skipped). The final combined preview
with `rohanz+claude` also passed the 18 guidance tests plus four writer-audit tests.
No lead changes overlapped this work.

Native Windows/PowerShell and Linux were not run live. This compiles a translation
unit; it does not link or build the full application. No remote fetch, LFS payload
download or nested-submodule initialization was attempted. Custom user checkout
filters retain Git's normal behavior. The plugin bundle and CHANGELOG were not
changed; the lead owns release integration.
