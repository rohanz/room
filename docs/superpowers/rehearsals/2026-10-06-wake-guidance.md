# Worker wake guidance: before and after

An interactive Claude lead inferred from “notes from your own workers do not wake you” that Room could not wake it for questions or completion, and installed a shell loop watching a worker PID. The old skills did not explain that distinction and instructed leads to loop `room_wait` without distinguishing interactive and headless sessions.

This change updates agent instructions and reference documentation only. It adds a regression test for existing behavior, with no runtime or transport changes.

## Comprehension check

On 6 October 2026, ran one paired evaluation using Claude Code 2.1.289 and `claude-fable-5-1`. Each run used `-p --safe-mode --tools '' --no-session-persistence --output-format json`, with the original or revised worker and etiquette skills in the system prompt. No tools, working-agent messages or repository edits were available to the evaluation. The initial external model call was blocked by automatic approval review; both runs proceeded only after Rohan explicitly approved sending both skill versions to Claude.

The same user prompt was used in both runs:

> You are advising a lead agent using Room in an interactive Claude Code session. Two workers are still running. The user asks: "Can Room notify you when a worker finishes or asks a question, or do you need a shell watcher and repeated room_wait calls? Your skill says notes from your own workers do not wake you." Explain the distinction, what you must check about this session, and what to do if wake is unavailable. Do not assume an observed wake failure. Keep your answer under 180 words.

The system instruction was: “Use only the supplied Room instructions to answer. Be explicit about uncertainty.” Both runs completed successfully in one turn.

| Check | Original skills | Revised skills |
| --- | --- | --- |
| Own-worker notes versus questions/completion | Said question/completion wakes were unspecified | Correctly distinguished quiet routine notes from addressed questions, completion and eligible interrupts |
| Interactive lead needs polling? | Inferred polling was expected | Said polling and PID watching are unnecessary with an available wake path |
| Diagnose this session | Said the skills gave no test | Named the Claude inbox, host settings and `room_state(check=true)` |
| Unavailable wake fallback | Correctly recommended short `room_wait` calls | Correctly recommended waits and other tool/hook delivery, and explained why exit watchers miss mid-task questions |

### Original response

**What the instructions actually say**

- Notes from my own workers do not wake me. That is the only wake rule stated explicitly, and it covers notes only.
- Whether a worker's question or its `room_done` wakes me is not stated. The instructions tell me to answer questions and to loop `room_wait`, which suggests polling is the expected way to see them.
- The phrase "when this session cannot be woken" implies some sessions can be woken, but nothing says which ones or how to tell.

**What I must check**

I need to confirm whether this session is wakeable. The instructions give no test for this, so I won't claim either way. `room_state` may show it, but that is unconfirmed.

**If wake is unavailable or unknown**

- I loop short `room_wait` calls, at most 100 seconds each, and read state only when I need more context.
- No shell watcher is needed; the instructions never mention one.
- With only two workers, I lead them myself. The background-lead offer applies to three or more workers or a long batch.

### Revised response

Yes, Room can notify me. The "do not wake you" rule is narrower than it sounds.

**The distinction**
- Routine progress notes from my own workers don't wake me.
- Addressed questions, worker completion (`room_done`), and eligible interrupts can.

So that rule alone doesn't mean Room can't wake this session.

**What I must check**
Whether a wake path is actually available here. I haven't verified it yet.
- Claude Code uses its inbox, which needs version 2.1.224+ on macOS (this machine), or a channels fallback.
- Host settings can still block delivery.
- `room_state(check=true)` is the way to inspect this.

If a wake path is available, I can keep working or wait, with no polling and no PID watching.

**If wake is unavailable or disabled**
- I supervise with short `room_wait` calls, at most 100 seconds each.
- Messages also arrive on other Room tool replies and eligible before-edit hooks.
- A shell process-exit watcher is not a substitute: it can't surface mid-task questions.

If an expected wake later goes missing, I'd inspect `room_state(check=true)` and `room-mcp.log` before concluding anything.

## Runtime evidence

The new regression in `packages/room-mcp/test/socket-wake.test.ts` appends an own-worker progress note, question and completion event to the ledger. The existing reconciler writes to a real temporary Unix socket without a `room_wait` call: the progress note stays quiet, while question and completion each produce a content-free wake pointer. All 20 socket-wake tests passed before the guidance changes.

After final edits, all 26 tests in the socket-wake, wake-note and tool-budget suites passed. Typecheck and the full plugin/web build passed; generated assets had no changes before release versioning.

The broad suite started before the scope was narrowed and had loaded a temporary runtime status line, which was subsequently removed. That run finished with 318 suites passing and six output-layout assertions failing across four suites (3,531 tests passed, six failed). All four affected suites were then rerun against the final code: 60 tests passed. This was a targeted recheck of every failed suite, not a second complete run.

## Limits

This is one paired comprehension check, not an adherence rate. Codex comprehension was not separately evaluated. The response's claim that this is a macOS machine comes from the evaluation host, not a Room diagnostic; neither run inspected a real lead session. The socket regression uses a fake host inbox, so it proves Room sends the selected events, not that an actual idle host starts a turn. No user sessions were restarted. These checks preceded packaging and installation.

## 0.17.6 packaging

Both plugin manifests, marketplace metadata, hook version metadata and doctor fixtures advance to 0.17.6. The regenerated bundle differs only in its embedded version. Typecheck, plugin/web build and all 149 release-focused tests passed. The trusted `hooks.json` remains byte-identical (SHA-256 `336c0b90c935ff627f9988ceb92e21c887b44c9b6e904b2c2ddd9a188db4b777`). This is a plugin-only update; no hosted server deployment is needed. Existing sessions must restart to load the revised instructions.
