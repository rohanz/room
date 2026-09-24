# Host feature survey: codex, 2026-09-24

Written by a research agent from current documentation, changelogs and CLI help only (the AGENTS.md rule). Items marked [I] or [inferred] are the agent's inference. The lead session verified: claude --effort/--name/--max-budget-usd, claude plugin eval, CLAUDE_CODE_SESSION_ID in the MCP server environment, codex exec resume and exec --json.

# Codex host survey for Room (2026-09-24)

Sources: local `codex-cli 0.155.1` (`--help` on every subcommand, `codex features list`); latest release is 0.156.1 (2026-09-23). Also read: release notes 0.139–0.156.1 (`gh release view`), PR bodies on openai/codex, the app-server protocol schema on `main`, sdk/python/docs/api-reference.md, and learn.chatgpt.com/docs/{hooks,plugins,app-server,agent-configuration/subagents,permissions,cli/reference}. developers.openai.com/codex/* now 308-redirects to learn.chatgpt.com/docs/*. **[inferred]** marks conclusions I drew myself; the sources don't state them.

## Ranked features

**1. App-server external messages and steering (mid-turn delivery)**
- What: `turn/start` takes `toolOutput`. When a turn is already active, the message joins that turn. Otherwise it starts a new turn. Content arrives as a `functionCallOutput`, "untrusted… tool-level authority, below user and developer instructions". `turn/steer` (needs `expectedTurnId`) adds user input to an active turn.
- Arrived: Python SDK `ExternalMessage` in 0.155.0 (2026-09-17, PR #44086). It needs CLI 0.151 or later. `turn/steer` is older.
- Source: sdk/python/docs/api-reference.md, section "ExternalMessage". Schema: `TurnStartParams.ts`, `TurnSteerParams.ts`.
- Room part: `codex queue` wake-up (hooks-bridge.ts `defaultQueue`) and the roomagent.
- Verdict: **replace or complement**.
- Benefit: a supported way to deliver peer messages to a busy session in the middle of its turn, and at the right authority. `codex queue` sends them as user input.
- Risks: `app-server` is labelled [experimental] and its websocket transport is "unsupported". Only the Python SDK wraps this. The TS SDK that roomagent uses still shells out to `codex exec --experimental-json`, so it has no steer or external messages. Whether an outside client can post to a thread owned by an interactive TUI through the shared daemon (`codex app-server proxy`) is **[inferred]**. `codex queue` does route through that daemon, which suggests it can.
- **Recommendation: try.** Start with roomagent: generate bindings with `codex app-server generate-ts` and talk to the app-server directly. Then consider it for waking a lead.

**2. Worker fix-ups through `codex exec --json` and `codex exec resume <id>`**
- What: `--json` prints JSONL events, including the thread id. `exec resume` continues that session with a follow-up prompt. Both are documented as stable in the CLI reference.
- Room part: `workers.ts` spawn. Roadmap items: "A finished worker cannot take defects back" and "a collected worker cannot take a fix-up".
- Verdict: **complement**. Benefit: review findings go back to the worker that wrote the code, with its context intact. Low risk.
- **Recommendation: adopt now.** Record the worker's thread id and resume it in its retained worktree. `--output-schema` and `-o` would also give a structured final report.

**3. `session_id` in every hook's stdin**
- What: every command hook receives `session_id`, `transcript_path`, `model`, `turn_id`, `cwd` and `permission_mode` (hooks doc).
- Room part: `findThreadForDir` guesses the thread by scanning `~/.codex/sessions/**/rollout-*.jsonl`.
- Verdict: **replace**. Benefit: the exact thread id, with no mtime race. That storage is also changing: "paginated thread history" arrived in 0.145, and `codex migrate-rollouts` now exists.
- **Recommendation: adopt now.** The change goes in `session-start.mjs`, so the frozen hook definitions stay as they are.

**4. Worker sandbox: `--add-dir`, network access, permission profiles**
- What:
  - `codex exec --add-dir <DIR>` means "additional directories that should be writable".
  - `-c sandbox_workspace_write.network_access=true` turns on network (shown in the TS SDK README).
  - Permission profiles (`[permissions.<name>]` with filesystem rules, `network.domains` allow/deny, `unix_sockets` allowlist, `allow_local_binding`) are labelled Beta: "may change".
- Room part: `workers.ts` (`-s workspace-write`), and the known limits "no git dir outside cwd, no network".
- Verdict: **complement**. Benefit: workers could commit in their own worktree, whose git dir lives under the main repo's `.git/worktrees/`, and could install dependencies.
- Risks: nothing I read says the sandbox allows listening on a TCP socket. `allow_local_binding` covers hostnames that resolve to local addresses, not `listen` **[inferred]**. Whether `.git` stays protected inside added dirs is untested.
- **Recommendation: try.** First `--add-dir <main>/.git`, then network as an opt-in per spawn.

**5. Hook trust tooling**
- `--dangerously-bypass-hook-trust`:
  - On every command. 0.141 (2026-06-18) made it persist through `codex exec` thread start and resume (#26434).
  - Documented: "without requiring persisted hook trust for that invocation".
  - Benefit: Room-spawned headless workers would run Room's hooks even when the user never approved them. Today those hooks are silently skipped.
  - Risk: it bypasses trust for *all* enabled hooks, not just Room's.
  - **Recommendation: try, for workers only.**
- `hooks/list` (app-server):
  - Returns `HookTrustStatus = managed | untrusted | trusted | modified`.
  - Benefit: exact diagnosis instead of "Pre-edit coordination is not confirmed yet". `modified` shows a hash changed by an upgrade.
  - The docs name `/hooks` as the place to review and trust hooks, so Room's advice should point there.
  - **Recommendation: adopt** for diagnosis.
- Still true:
  - Trust is per hash, and a changed hook is "skipped until trusted".
  - Plugin hooks are not trusted by installing the plugin.
  - Automatic trust exists only for materialized *workspace* (remote) plugins (0.145, #32301).
  - Managed hooks (`requirements.toml`/MDM) skip review, but that route is only for organisations.
- Room's freeze is still right.

**6. Hook events Room lacks: `Stop`, `SessionEnd`, `Interrupt`, `SubagentStart`/`SubagentStop`, async hooks, `mcp_tool` hooks**
- What each does:
  - `Stop` returning `{"decision":"block","reason":…}` makes Codex continue, with `reason` as a new prompt.
  - `SessionEnd` (0.145, 2026-07-21) fires on close, or after 30 minutes idle with no client attached.
  - `Interrupt` arrived in 0.150 (2026-08-26).
  - Async command hooks and `type:"mcp_tool"` hooks arrived in 0.148 (2026-08-18). Async output lands "at the next safe point", which can be later in the same turn.
- Room part: hooks.json.
- Benefits:
  - `Stop` could stop a worker ending its turn with questions addressed to it unanswered.
  - `SessionEnd` could release claims or mark someone left.
  - An `mcp_tool` hook could call `room_state` without a node process.
- Cost: any new event changes the hook definitions and makes every user re-trust them. PreToolUse `additionalContext`, which Room already uses in before-edit.mjs, is documented and stays the cheap path.
- **Recommendation: watch.** Bundle these into one deliberate re-trust release if the value accumulates.

**7. Native subagents and multi-agent v2**
- What: subagents are enabled by default (`multi_agent` stable/true; `multi_agent_v2` stable but off). Configure them under `[agents]` (`max_concurrent_threads_per_session`, `default_subagent_model`, `default_subagent_reasoning_effort`) and in `~/.codex/agents/*.toml` or `.codex/agents/*.toml`. Each definition can set `model`, `model_reasoning_effort`, `sandbox_mode` and `mcp_servers`.
- Also: a `codex_tui` tool namespace (0.150, #40308) lets an agent list, create, message and wait on other local tasks.
- Room part: room_spawn, workers and the routing words.
- Verdict: **inform, no replace.** Subagents share the parent's checkout and inherit its sandbox. The docs mention no per-agent worktree, no cross-person coordination and no merge preview.
- Risk: these native tools compete with room_spawn for "get codex to do part of it". Rerun the human-phrasing check against a Codex host.
- **Recommendation: watch.**

**8. Managed worktrees (`--worktree`, `codex agents`)**
- What: 0.154 (2026-09-09) added them as experimental. 0.156.0 (2026-09-22) made them stable and on by default.
- Evidence: PR #44870. The installed 0.155.1 still reports `worktrees experimental false`.
- Room part: worker worktrees. Room's carry, base tracking and preview go well beyond this.
- **Recommendation: no.** Possibly pass `--thread-source` so Room workers are labelled in `codex agents`.

**9. `send_message_to_user_async`**
- What: a tool that lets an agent ask a question without ending its turn. Under development, flag off (#42354, #45124).
- **Recommendation: watch.** It could matter for workers asking their lead.

## What Room should stop doing
- **Scanning rollout files to find its thread.** Use hook `session_id` (item 3).
- **Telling users to "approve them once in an interactive Codex session".** Name `/hooks` instead, and use `hooks/list` status once Room reads it.
- **Assuming a running session keeps its original plugin version.** 0.154 says: "existing sessions pick up newly installed plugin tools and refresh skills and hooks after external plugin upgrades" (#42284, #42990, #42593).
  - The plugins doc still says to "start a new chat or CLI session", so the two sources conflict.
  - Whether a running Room MCP server process is restarted is not stated **[inferred: probably not]**.
  - Retest after 0.156 before changing the docs.

Nothing Room does is replaced outright. Codex has no cross-person or cross-machine coordination, claims or merge preview.

## Deprecated or changing things Room depends on
- **`codex queue`**:
  - Added 0.149 (2026-08-20, #39092). It is a thin CLI over `thread/queue/add` on the local app-server daemon.
  - It is **absent from the CLI reference docs**, so it shows up only in `--help` and release notes.
  - Semantics:
    - Items are queued *user submissions*: user authority, at most 100 pending per thread.
    - Idle threads are woken (0.149 "queued messages now wake idle sessions reliably").
    - Delivery to a busy thread waits for the turn boundary **[inferred from the queue design]**.
  - It needs the shared local daemon. `codex app-server daemon update` or a restart can interrupt work.
  - Stable for now, but undocumented. Plan to move to item 1.
- **Hook trust**: unchanged in principle (hash, per plugin key `room@room:hooks.json:<event>:<i>:<j>` in `[hooks.state]`). The 0.154 mid-session hook refresh means a hook change now shows up as `modified` in running sessions too.
- **Hook matchers**: the docs' canonical names are `Bash`, `apply_patch` (which also matches `Edit`/`Write`) and `mcp__…`. Room's extra aliases are harmless.
- **Project trust**:
  - Untrusted projects no longer load project `AGENTS.md` (0.150).
  - Linked worktrees are validated before inheriting project trust (0.149, #39616).
  - Worker worktrees could lose AGENTS.md or project hooks. **[inferred risk; verify]**
- **Removed**: `codex mcp-server` (0.154), `exec --full-auto` (0.147), the `untrusted` approval policy (0.149), `thread/rollback` (0.156). A grep found none of these used in Room.
- **Models**: 0.156.1 lists GPT-6 Sol and Luna. AGENTS.md still says "5.6 Sol / 6 Astra"; update after checking `model/list`. Hook stdin has `model` but not reasoning effort.
- **Local CLI**: 0.155.1 is one release behind 0.156.1.
