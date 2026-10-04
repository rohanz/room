# Collection checkpoint validation — 2026-10-04

The [Zod trial](2026-10-04-zod-historical.md) demonstrated a delivered interrupt immediately followed by collection. That establishes an agent instruction-following failure; the transcript cannot establish the model's internal reason. The old collect handler had no durable review policy to enforce.

The follow-up adds an opt-in, destination-checkout review hold. It uses the existing cross-process collection lease, survives MCP restarts, and blocks new apply/copy/discard calls, including force. Multiple reviewers release independently. Host-session ownership and a private recovery token let the reviewer release without giving the collecting lead an ordinary override. Messages alone remain advisory. This does not freeze other lifecycle operations or undo collection already underway.

## Review and checks

Independent Codex Astra review signed off after finding and correcting an unknown-argument validation bypass in checkpoint calls. It also requested that identity lookup occur only for hold/release, which was corrected. The reviewer checked persistence, ownership, recovery, canonical checkout identity, serialization and the documented lifecycle limits.

- Targeted integration run: 150 tests passed; the tool-description budget initially failed. The descriptions were shortened without raising the 9,500-character cap. The final definitions occupy **9,493 characters**; the separate final budget and hold-state run passed all 9 tests.
- Integration covers hold → apply/copy/discard/force refused with work preserved → wrong-session release refused → reviewer release → normal unstaged collection and cleanup. Unit tests cover restart persistence, private-token recovery, multiple holders, malformed saved state, canonical path aliases and two registry instances racing for the collection lease.
- Typecheck and full plugin/web build passed. The frozen `plugins/room/hooks.json` SHA256 remains `336c0b90c935ff627f9988ceb92e21c887b44c9b6e904b2c2ddd9a188db4b777`.
- New natural-language checkpoint routing case passed **3/3 runs**, each establishing a hold and making no collection/release call. Its first grader incorrectly rejected an additional status query; a retained trace proved the calls were hold then status. The corrected grader permits status, still requires hold and reason, and rejects release or actual collection. Original failed evaluation results remain preserved.

Artifacts: `/tmp/room-collection-hold-routing/`, `/tmp/room-collection-hold-routing-inspect/` (retained trace), `/tmp/room-collection-hold-routing-final/`, `/tmp/room-collection-checkpoint-tests.log`, `/tmp/room-collection-checkpoint-evals/`.

## Broader validation

The first full suite ran all **3,536 tests across 322 files**: 3,534 passed, with timeouts in the existing large-tree rejoin and nested lead discard tests (60 s and 20 s limits). Both suites passed unchanged in a one-worker rerun: **9/9 tests, 34.59 s**. No assertion or timeout was weakened. The first run overlapped model-based evaluation; scheduling pressure is a plausible explanation, not a proven root cause. Its full failed log is retained. The final full run with `--maxWorkers 1` passed **3,536/3,536 tests across all 322 files**, in **1,492.72 seconds**.

The existing natural-language evaluation ran 20 cases × three repetitions × with/without-plugin arms. **59/60 plugin-enabled runs passed**. One `codex-half` run failed its no-built-in-subagent grader while still spawning the requested Codex Room worker. A separate unchanged diagnostic rerun with retained trace passed, so this remains a nondeterministic routing finding, not a claimed fix or a fully green evaluation. The baseline arms are comparisons, not Room pass/fail counts. The new checkpoint's 3/3 runs are separate from these 60.

A real bundled-MCP smoke used two separate local processes in a disposable Git repository. A reviewer established the hold; the other process's apply/copy/discard-force calls were blocked, and it could not release the hold. The hold survived reviewer shutdown, status did not expose its token, and a replacement unbound reviewer recovered it using the private token. Ordinary collection then worked. Evidence: `/tmp/room-collection-checkpoint-smoke-result.json` and `room-collection-checkpoint-smoke.log`. The first smoke incorrectly assumed setting `CODEX_THREAD_ID` alone established a real host binding; the old owner's release was correctly refused. The corrected harness exercises unbound recovery rather than bypassing host binding. Same-bound-thread restart ownership is covered by the state tests.

Additional artifacts: `/tmp/room-collection-checkpoint-timeout-recheck.log`, `/tmp/room-collection-checkpoint-tests-final.log`, `/tmp/room-collection-routing-diagnostic/`. The built MCP bundle SHA256 is `dded5055edc9301d666a81245fdf56f103db91b3dd3a42bdd9a52a5c4b49f2c3`.

This is an unreleased plugin change; neither installed plugin nor the hosted server has been updated by this work. Every collecting session must load the updated bundle before relying on a hold; an older plugin process does not implement the gate.

Follow-up: the [routing investigation](2026-10-04-routing-investigation.md) passed six unchanged repetitions with retained traces and identified inconsistent static worker mocks. The original failure was an extra native call alongside a correctly spawned Codex Room worker; its exact cause remains unproven.
