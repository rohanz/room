# Rehearsal: the Codex CLI repository (Rust), 2026-09-28

This was the first non-Python codebase and the largest repository so far. It ran on Room 0.16.31 at full sharing.

## Setup

- **Repository:** private `rohanz/codex-rehearsal`, a snapshot of openai/codex at f908e5a (2026-09-22), 86 MB with CI workflows removed. Rust 1.95.0 was installed with rustup.
- **Check:** `cd codex-rs && cargo test -p codex-agent-message-board-extension`. The first build takes 163 s, later runs about 48 s.
- **Cards:** upstream PRs #47236, #47257 and #47259, merged within 91 minutes of each other:
  - #1: an agent message board notified authors of their own posts.
  - #2: a post undid an explicit unsubscribe.
  - #3: creating a channel by posting did not subscribe the author.
- **Overlap:** all three edit `LocalAgentMessageBoard::post()` in `local.rs` and the same test function. #2 changes a helper that #3 calls.
- **Sessions:** Ana (Claude Code) #1, Ben (Claude Code) #2, Cy (Codex) #3.

## What happened

- **Big-repo costs.** The symbol index covered 3,000 of 5,705 source files in 56 s. Joins took 40 s to 2 min 20 s, including the agents' own reading.
- **The first real textual conflict** came between #2 and #3: adjacent edits in `post()`.
  - Ben checked the combined result in a scratch copy.
  - The two agents agreed both edits stay, and Cy moved its block below Ben's so they no longer touched.
  - The crate's 15 tests passed on the combined code.
- **Pushing at the same moment:**
  - Ana pushed first.
  - Cy caught up with `--ff-only --autostash` *before* committing, then pushed. That is correct, and no rewrite was needed.
  - Ben's push was rejected. He stopped and asked, and found a **semantic** interaction: Ana's fix changed what two of his tests expected.
  - On yes he rebased, fixed the two expectations and pushed.
- **Result:**
  - `rehearsal` = 93ab6ab (#1), e688851 (#3), 1469113 (#2).
  - The agents' tests pass (9 of 9), and **upstream's final crate tests pass on the combined code (6 of 6)**.
  - All issues are closed.

## Findings

1. **Name collision, fixed in 0.16.32.**
   - Ana and Ben, the same user in two clones on one machine, both joined as `rohanz`.
   - Name locks were per clone, and the presence check did not see Ana.
   - Team-room name locks are now per user and machine-wide.
   - **Open:** why the presence check missed a peer who had joined 42 s earlier. The server uses the standard y-websocket connection handler, which should send existing presence before sync completes. This only matters for one user on two machines. It needs a reproduction against a running server with two separate joins.
2. **A three-way merge preview timed out on git** in the 86 MB repository, so no agent tested all three fixes together before pushing. The answer key did so afterwards. Previews on large repositories need a longer or adaptive git timeout. This is for after the trial.
3. **Dependabot and Actions fired in the snapshot repository.** Rehearsal repos now have Actions disabled and Dependabot PRs closed.
