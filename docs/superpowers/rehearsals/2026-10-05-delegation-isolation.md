# Delegation isolation checks — 2026-10-05

Follow-up to the [retained-trace investigation](2026-10-04-routing-investigation.md). The original failure is still not reproduced. No product instructions or tool descriptions were changed, and the original whole-run grader was retained.

Claude Code 2.1.289, current Room plugin source at `3ac335f0`, pinned shop scaffold, mocked tools, no baseline arm. Every run retained its trace with `--keep-temp`; reports were kept local with `--no-publish`. These measure observed delegation decisions, not completed worker implementations.

| Check | Passed | Direct trace observations |
|---|---:|---|
| Unchanged original `codex-half` workflow | 8/8 | Every run spawned Codex through Room; no native Agent/Task calls. |
| Dispatch only, explicit Room request | 3/3 | One Codex Room worker per run; no native agent. |
| Generic background review | 3/3 | One native Agent per run; no Room worker. |
| Resume a failed Room worker | 3/3 | Sent a follow-up to the same retained worker; no native agent. |
| Read-only research plus implementation, explicit Room | 3/3 | Two Room workers per run, including Codex; no native agent. |

The recovery case overrides `room_state` and `room_send` with consistent state for `ada+money`, which failed because its test command was unavailable. This separates follow-up routing from the unrelated-worker state in the shared mocks. Dispatch-only and auxiliary-research cases stop after dispatch, so they do not depend on a simulated worker finishing. Generic delegation is a negative control: Room must not take over unrequested coordination.

Artifacts:

- `/tmp/room-delegation-original-repro/`: 8 runs, 379 seconds, $3.49 reported estimate; concurrency 2.
- `/tmp/room-delegation-isolated/`: 9 runs, 115 seconds, $1.73; concurrency 3.
- `/tmp/room-delegation-research/`: 3 runs, 29 seconds, $0.39; concurrency 3.
- `/tmp/room-delegation-research-final/`: a separate final 3/3 check after adding an exact-two-Room-workers grader, 21 seconds, $0.37. This confirms both requested jobs were dispatched; it is not added to the table's original 20 trials.

Commands use `claude plugin eval . --case <case or glob> --runs <count> --ablation none --scaffold --trust-plugin --allow-tools Edit Write --keep-temp --no-publish --concurrency <n> --output-dir <artifact directory>`. New diagnostic cases are under `evals/routing/delegation-*`.

## What this establishes

The intended explicit/generic boundary, retained-worker recovery, and read-only helper routing all worked in these samples. Together with the previous six repetitions, the original workflow has now passed fourteen additional unchanged trials. This does not erase its original extra-native-call failure or establish a universal success rate.

The original trace was not retained, so its extra call's purpose and order remain unknown. There is currently insufficient evidence to attribute it to initial routing, timeout recovery, or an auxiliary review. Further prompt changes would be speculative. The practical improvement is diagnostic coverage and retained failure evidence, rather than a claimed product fix.

The evaluator's current [documentation](https://code.claude.com/docs/en/plugin-evals) describes nondeterministic repeated trials and opt-in trace preservation. Evaluations have been available since Claude Code 2.1.269; the installed version was checked with `claude --version` and its current `plugin eval --help`.
