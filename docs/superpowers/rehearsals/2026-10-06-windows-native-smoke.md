# Windows smoke: source tests and an opt-in genuine Claude rehearsal

Starting point: `ef0b1f7935`, Room 0.17.8. Prepared 2026-10-06 by
`win-integration` in the Windows batch. No version, committed bundle, frozen
`plugins/room/hooks.json`, deployment, credentials, or paid host calls changed.

## Evidence boundaries

| Check | Environment | Evidence here |
| --- | --- | --- |
| Portable fake-host fixture and launch/stop/resume boundary | macOS, real executable/process, fabricated Claude stream | Passed; no model or MCP worker admission |
| Relay startup and addressed question/answer across spaced worktrees | Real source relay/WebSockets, macOS Room preview runner | Passed in combined preview; direct worker shell blocked `listen EPERM` |
| Source SessionStart, ancestor identity, durable worker binding after simulated `/clear` | Real Node hook subprocess; fabricated host event, macOS Room preview runner | Passed in combined preview; direct shell denies process inspection |
| Process identity and PowerShell environment suites from sibling workers | Offline fixtures plus native-only cases | See sibling reports; new CI runs these on `windows-latest` |
| Native Windows fake-host smoke | Real Windows OS, copied Node executable named `claude.exe`, fabricated host stream | Added CI gate; **not executed on native Windows here** |
| Genuine Claude + Room, idle wake, worker admission/resume, permission checks | Authenticated native Windows, actual model turns | **Not run; operator opt-in and authenticated Windows required** |

The existing eight durable-directory tests already passed Windows before this
batch. Their CI job remains; they are not new Windows fixes. Passing a source
test does not establish that an installed plugin bundle includes the change.

## Reproducible source checks

From the repo root, use these in either macOS/Linux or native PowerShell:

```text
npx vitest run --root packages/relay --config vitest.config.ts test/windows-process.test.ts --maxWorkers 1
npx vitest run --root packages/room-mcp --config vitest.config.ts test/windows-process.test.ts test/windows-process-native.test.ts test/worker-shell-env.test.ts --maxWorkers 1
npx vitest run --root packages/room-mcp --config vitest.config.ts test/windows-smoke.test.ts --maxWorkers 1
```

Vitest setup clears inherited Room/host identity and uses temporary config
directories. No real host executable is launched. `windows-smoke.test.ts` copies
the current Node binary to a spaced path, runs the portable fake host through
Room's real spawner, and observes exit before deleting its temporary files.
It covers argument preservation, worker launch environment, retained session
arguments, and a host-log acceptance event. It does **not** prove Claude's
transcript restore, model behavior, Room worker admission, or idle wake.

The native CI job records OS/runtime identity, runs one Vitest worker at a time,
and uploads JSON results as `windows-native-fake-host-results`. Native-only
sibling cases should execute on Windows; skips there need investigation. A
filtered local run skips the two unselected smoke cases; this is not a full
suite pass. GitHub Actions was not dispatched by this worker.

Package configs have package-relative include paths. Running
`--config packages/room-mcp/vitest.config.ts packages/room-mcp/test/...` from the
repo root finds no tests. With `--root`, Vitest 5 also resolves `--config` against
that root, so use `--config vitest.config.ts` as shown above.

## TDD and local results

Exact red and green command from the repo root:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run --config vitest.config.ts --root packages/room-mcp test/windows-smoke.test.ts --maxWorkers 1 -t 'launches, stops'
```

Before implementing `test/fixtures/windows-fake-host.mjs`: exit 1, one selected
test failed with `ENOENT` copying the missing fixture. After implementing it:
exit 0, one selected test passed, two unselected tests skipped. This is a
test-first **new harness** result, not a failing-before Windows runtime fix.

Full command, with the `-t` filter removed: exit 1, one passed and two failed.
Relay startup fails `listen EPERM: operation not permitted 127.0.0.1:<port>`;
SessionStart's `chain.length > 0` fails because the sandbox denies `ps`/`sysctl`
inspection. These assertions remain in the suite. Native Windows is absent,
so there is no native red/green proof in this record.

`nice -n 10` prints `setpriority: Operation not permitted` locally; runs remain
foreground, staggered, with `--maxWorkers 1`. The lead was notified of the
socket/inspection blocks and asked to run the full smoke outside the sandbox.

Room's combined-preview runner subsequently ran the unfiltered smoke outside
the worker shell sandbox on macOS: **exit 0, all three tests passed**, in 9.59 s.
Both siblings' runtime/test changes were fully shared and included, with no
merge conflicts. Exact preview command:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run --root packages/room-mcp --config vitest.config.ts test/windows-smoke.test.ts --maxWorkers 1
```

This resolves the macOS relay/hook verification block. It provides neither
native Windows nor genuine Claude-session evidence. The earlier partial
preview excluded two unshared shell-worker files; its filtered pass is not
counted as combined verification.

After removing duplicate session teardown, the final full combined preview
again passed **3/3** in 11.18 s (17 paths including the sibling's retained-worker
argument regression). No conflicts, excluded files, or native evidence were
reported. `ruby -e 'require "yaml"; puts YAML.load_file(ARGV[0]).fetch("jobs").keys'
.github/workflows/ci.yml`, `node --check` on the fake host, and
`git diff --check` also passed. No generated bundle build was run by this worker.

Independent observer: interactive lead **`rohanz`** separately ran the full
smoke outside the sandbox in `win-integration/packages/room-mcp`, using:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run --config vitest.config.ts test/windows-smoke.test.ts --maxWorkers 1
```

Result: **3/3 passed on macOS, 10.58 s**, captured in
`/tmp/room-windows-integration-outside.log`. Integration read that log and
confirmed its test count and duration. This is distinct from integration's
combined Room-preview run and `win-batch`'s broader combined checks; it still
does not establish native Windows or genuine Claude evidence.

## Batch receipts: reported versus observed

The following compact receipts were supplied by `win-batch` during the
retained-worker follow-up; `win-shell` also supplied its receipts directly.
Integration did not independently rerun these process/shell cases. “Lead
observed” means `win-batch` says it directly ran the check; the other rows are
worker reports. Counts are separate runs and must not be added into one suite
total.

| Check | Receipt | Evidence source |
| --- | --- | --- |
| Guarded process baseline, relay | Red: 4 failed / 1 passed | `win-process` reported |
| Guarded process baseline, room-mcp | Red: 3 failed / 1 native-only skip | `win-process` reported |
| Unreadable status cache | Red: 1 failed / 5 passed; 100 spawns | `win-process` reported |
| Reused parent, birth differs by 100 ns | Red: 1 failed / 4 passed | `win-process` reported |
| Process final combined sibling preview | Green: 13 relay + 162 room-mcp passed / 2 skipped | `win-process` reported |
| Shell baseline | Red: 6 failed / 7 passed / 1 native-only skip | `win-shell` reported |
| Shell focused suite | Green: 15 passed / 1 skipped | `win-shell` reported |
| Comment-separated PowerShell declaration | Red: 1 failed / 14 passed / 1 skipped; then fixed | `win-shell` reported |
| Shell pre-guard sibling preview | Green: 21 passed / 1 skipped | `win-shell` reported |
| Native shell infrastructure selector | Red: 1 failed / 15 passed / 1 skipped; green: 16 passed / 1 skipped | `win-shell` reported in retained correction |
| Shell final sibling preview after guard | Green: 22 passed / 1 skipped | `win-shell` reported in retained correction |
| Filtered launch/channel/resume checks | Green: 22 passed across 4 files | `win-shell` report forwarded by lead |
| Shell typecheck | Green | `win-shell` reported |
| Targeted complete combined preview | Green: 66 passed / 2 skipped | Lead directly observed; reported to integration |
| `npm run typecheck` | Exit 0 | Lead directly observed; reported to integration |

The initial **unsafe baseline quiesce attempt exited 143** and is excluded
from valid red evidence. The process worker corrected the synthetic guards
before the guarded baseline failures above. An interrupted or unsafe fixture
run is not a successful reproduction or green result.

Exact shell red/green command, with cwd `packages/room-mcp`:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run --config vitest.config.ts test/worker-shell-env.test.ts
```

The comment-separated declaration red used the same command with
`--maxWorkers=2`. The final native-infrastructure selector red/green command,
also with cwd `packages/room-mcp`, was:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run --config vitest.config.ts --maxWorkers=2 test/worker-shell-env.test.ts
```

The shell worker's combined-preview command before and after that guard, with
cwd `packages/room-mcp`, was:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run --config vitest.config.ts --maxWorkers=2 test/worker-shell-env.test.ts test/worker-lifecycle.test.ts test/worker-modules-characterization.test.ts
```

The final retained preview reported 17 files, no conflicts, **22 passed / 1
skipped**, and exit 0, superseding the pre-guard 21/1 count. Shell-worker
`npm run typecheck` and `git diff --check` also exited 0. These are
macOS/offline/fake-spawn receipts; native PowerShell was unavailable and
skipped. The worker reports that disabled, failed, or timed-out hooks can
proceed without the scrub and that its conservative text check can produce
false positives. Real Claude deny-rule behavior remains unverified.

The retained correction now skips an absent shell only on non-Windows;
Windows absence or a blocked shell fails an explicit infrastructure assertion.
The added native case starts without `ROOM_*` and requires exit status 0,
empty stderr, exact JSON, and preserved `PORT`, caps, and user values. The
final skip is macOS without PowerShell: those native execution assertions
remain Windows gates, not locally demonstrated passes. Native CI skips need
investigation, and unsupported Windows PowerShell infrastructure fails clearly.
No runtime edits were made by the shell worker in this retained correction.
Genuine Claude-session, inbox-wake, admission/resume and permission-revalidation checks
remain **NOT RUN** here.

The shell worker's final official-doc review also reports that matching hooks
run in parallel, with permission-decision precedence documented but no
specified winner for competing `updatedInput` rewrites. A custom rewriting
hook can defeat the scrub; Room's inbox hook emits context only. No runtime
ordering workaround or new PowerShell preapproval was added. Include the
actual hook configuration in the authenticated Windows record.

## Official host documentation read before design

Read-only snapshots fetched 2026-10-06 are in
`/tmp/room-windows-host-docs-2026-10-06/`: `hooks.html`, `messaging.html`, and
`CHANGELOG.md`. They correspond to the official
[hooks reference](https://code.claude.com/docs/en/hooks),
[cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging),
and [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md).

Before final collection, `rohanz` supplied additional official snapshots fetched
on the same date: `cli-reference.html`, `settings.html`, `tools-reference.html`,
and `plugins-install.html`. Integration read the relevant CLI, installation,
settings-scope and PowerShell sections. Sources:
[CLI reference](https://code.claude.com/docs/en/cli-reference),
[plugin installation](https://code.claude.com/docs/en/plugins/install),
[settings](https://code.claude.com/docs/en/settings), and
[tools reference](https://code.claude.com/docs/en/tools-reference).

SessionStart was introduced in **1.0.62**. The current schema supplies
`session_id`, `cwd`, and a `source` such as `startup`, `resume`, or `clear`.
Room's source hook uses those fields to persist a session record; the smoke
supplies fabricated inputs and does not observe Claude emitting them.

Cross-session messaging shipped on macOS/Linux in **2.1.224**. The current
messaging page states native Windows requires **2.1.234+**, while the saved
changelog announces Windows messaging in **2.1.239**. Preserve that discrepancy;
do not claim 2.1.234 is the independently established introduction version.
The installed **2.1.291** is newer than both. The page says messaging is enabled
when provider requirements are met and starts a new turn for an idle recipient;
it also documents inbound controls and availability limits. Configuration alone
does not establish delivery. PowerShell preview arrived in **2.1.84**;
Windows SessionStart environment-file support was fixed in **2.1.111**.

The batch's Codex installation is **0.160.0**. This worker does not infer new
Codex flags. The supplied Claude CLI reference confirms ordinary `claude`
interactive startup and `--version`; the installation reference confirms local
marketplace paths and `claude plugin install <plugin>@<marketplace>`. The
genuine steps below remain manual and use those documented commands.

## Opt-in genuine native Windows rehearsal

This is a manual harness for a future operator who explicitly authorizes the
model usage. CI and the source tests above never perform these steps. Use an
already authenticated native Windows installation; do not copy login files,
tokens, sockets, or environment credentials between machines. WSL is a
different environment and must be reported separately.

1. Record Windows edition/build, architecture, PowerShell version, Node/Git
   versions, `claude --version`, candidate Git SHA, and the Room manifest
   version. Confirm `node -p process.platform` says `win32`. Record whether
   Claude resolves to a native executable or an npm shim; run both installation
   forms separately if available. Use a candidate bundle built and reviewed by
   the lead; record its SHA-256 and installation path. An old 0.17.8 bundle with
   the same version string is not candidate evidence. Follow the current
   [installation instructions](../../../README.md) and supplied official CLI
   and installation references. For a locally built candidate in a spaced
   path, use `claude plugin marketplace add 'C:\path with spaces\room'`, then
   `claude plugin install room@room`, and start fresh sessions after installation.
   Record the loaded candidate path/hash; do
   not use bypass-permission flags or enable the optional channel fallback to
   conceal a failed inbox path.
2. Create a disposable repo with a commit under a path containing spaces,
   for example `C:\Users\<user>\AppData\Local\Temp\Room Windows Smoke\checkout with spaces`.
   Set a local Git identity and ignore `.room/`. Create a second worktree named
   `peer worktree`. Keep all test files and any sentinel inside this checkout.
   Start ordinary `claude` terminals A and B in these two directories. Join a
   local room explicitly, with distinct tags. Record `room_state(check=true)`
   in each, actual session IDs, and verified process identities. State should
   identify the same local relay and room. Inspect source hooks' durable
   `session.json` records locally; never publish inbox tokens or discovery keys.
3. In A ask: “Use Room to send B an addressed question with nonce WIN-Q-1.
   Ask B to answer WIN-A-1 through Room.” Let B finish its current turn and
   become idle before delivery. Observe B begin a new turn without typing or
   `room_wait`, and observe the answer in A. Save ordered message IDs, session
   IDs and timestamps. If B remains idle, record failure and inspect
   `room_state(check=true)` and `room-mcp.log`; a visible bus message by itself
   does not count as a wake. Repeat in the opposite direction.
4. In A run `/clear`, then send a new addressed nonce from B. Observe a new
   host session record and Room rebinding to that ID; only A should consume
   its new inbox. Do not count a fabricated hook event as this check.
5. Explicitly request one **Room** worker, `native-resume`, `host: claude`,
   one thread, in the disposable repo. Ask it to write a nonce to `result.txt`,
   report `room_done`, and exit. Record the real worker registry's admission,
   original host session ID, process birth/executable, branch/worktree, and
   final exit evidence. Send it a follow-up through `room_send` before
   collection. Ask it to append a second nonce and finish. Verify the retained
   session ID and worktree match, run number increments, and both nonces exist.
   A startup log alone is insufficient: capture the actual assistant turn and
   Room admission/report. Keep the worktree until review is complete.
6. Request a separate short worker task that checks its inbox between bounded
   foreground operations. Address an interrupt asking it to finish now.
   Verify `room_done` and **observed process exit**, and distinguish these from
   an unconfirmed stop request. Inspect the preserved worktree; do not discard
   it to simulate resumability. A PID alone is insufficient identity evidence.
   If the lead session is restarted, verify recovery separately. Windows
   cannot prove arbitrary descendant working directories through CIM; an
   explicitly unconfirmed cleanup is acceptable evidence of the conservative
   limitation, not successful cleanup.
7. In a Claude Room worker, run an actual **PowerShell tool** command that lists
   only environment **names** and these nonsecret values: `PORT`, thread/memory
   caps, and a test variable `WIN_SMOKE_KEEP=fixture`. The shell child should
   have no `ROOM_*` variables, while the worker's MCP remains admitted and can
   deliver a Room answer. Verify those non-Room values survive. Separately test
   a shell child launching a nested fake CLI; it must not inherit the parent's
   Room identity. Verify a harmless prefixed command runs under the worker's
   unchanged `acceptEdits`/`--allowedTools` configuration: Bash preapproval does
   not approve PowerShell. Record any permission prompt or block without adding
   a new allow rule. Do not dump the complete host environment.
8. In the disposable session, configure an ordinary deny rule for a sentinel
   deletion through the supported permissions UI. Attempt that exact denied
   PowerShell command and observe that it remains blocked after the scrub
   prefix is added; the sentinel must survive. If the model refuses to attempt
   the tool, record this as untested host revalidation. Stop immediately on any
   unauthorized deletion. This requires real Claude permission mediation;
   source-hook JSON or a fake process cannot establish it.
9. Capture results before collection. Preview worker edits and collect only
   after review; stop genuine hosts and inspect any unconfirmed processes
   before deleting the disposable checkout. Keep nonsecret receipts and logs
   with the candidate SHA. Do not commit/push this rehearsal's generated state.

Record each row as PASS / FAIL / BLOCKED / NOT RUN, with OS, real versus fake
host, command or prompt, message order, session/run identity, and observed
result. No overall “Windows supported” claim follows from the local filtered
pass or the pre-existing durable-directory job.

## Batch lead final verification and collection

`win-batch` reviewed the final diffs and retained-worker corrections, then
previewed all three finished workers together. One earlier preview was rejected
because integration moved during the check; it is not counted as validation.
The stable final preview had no conflicts: **191 passed / 2 skipped across 15
files**, followed by **3 passed / 146 unselected** in the channel/resume filter.
`room_collect()` brought all three workers' 17 changed files into the root
checkout, unstaged and uncommitted, and cleaned up their owned worktrees.

After collection, the same 15-file focused suite passed in the root checkout
on macOS: **191 passed / 2 skipped, 38.10 s**. It covers Windows parser/cache
fixtures, worker process safety, real relay and fake-host smoke, shell env,
fresh signals, process naming, session/launch binding, lifecycle cleanup,
hooks/hook fixes, worker lifecycle and module characterization. The two skips
are native Windows process execution and real PowerShell execution, unavailable
here. Root verification used the interactive lead's authorized OS/loopback
test execution; no host permission configuration was relaxed.

The root channel/resume check also passed: **3 passed / 146 unselected, 6.91 s**:

```sh
env -u ROOM_TAG -u ROOM_OWNER -u ROOM_SERVER npx vitest run packages/room-mcp/test/workers.test.ts --maxWorkers 1 -t 'passes ROOM_CLAUDE_CHANNEL only|records a Claude UUID'
```

Root `npm run typecheck` and `git diff --check` passed. HEAD remains
`ef0b1f79353b7182265a55542400d077fcfc46b1`; nothing is staged or committed.
Release manifests, committed generated assets, and frozen `hooks.json` are
unchanged. Native Windows CI and authenticated Windows Claude rehearsal remain
pending; this batch does not establish installed-candidate Windows support.

## Final review follow-up

Astra found that the unsupported Windows cwd guard covered registry replay but not ordinary collection/discard. The default cwd enumerator now throws on unsupported platforms, and both live and retired discard paths abort on inspection failure before writing a recovery snapshot. Collection can apply edits but retains the checkout when cleanup cannot inspect processes.

Three public `room_collect` regressions simulate unavailable inspection. Before the fix, both discard tests failed because a recovery patch had already been published; the collection retention test passed. After the fix all three passed. Command: `npx vitest run --root packages/room-mcp --config vitest.config.ts test/collect.test.ts -t "cwd inspection fails"`. Native Windows CI also runs these cases and asserts that the real default process cleanup refuses unsupported inspection.

Feng Kai reported the original Windows startup bug; the release commit and changelog credit that report.

Final local validation: typecheck, knip, full plugin build, and diff-check passed. An initial full run was invalidated by changing release metadata while it ran (0.17.8 remained loaded while disk became 0.17.9). The stable-build rerun passed 3,576 tests, skipped two native-only checks, and hit one 30-second timeout in the existing 3,000-file bridge test. That test passed independently in 24.73 seconds including setup. Its timeout was scoped to 60 seconds without changing the yielding/atomic-read assertions; full CI remains the release gate.

After the scoped deadline change, the complete bridge suite passed: 30/30, 15.86 seconds. Astra independently approved the lifecycle follow-up after its three public regressions passed. The frozen hook manifest remains byte-identical.
