# Host survey: landscape, 2026-09-24

Written by a research agent from current docs, repos and release data only (the AGENTS.md rule). Inferences are marked [I]/[inf]. The lead session verified the repo moves and star counts (anomalyco/opencode 210k, earendil-works/pi 109k, google-gemini/gemini-cli 107k). The Gemini CLI retirement is partly corroborated (an issue of 2026-06-19 about an antigravity.google link in its error message) but was not found on the Google developers blog front page.

# Room host landscape beyond Claude Code, Codex, Gemini CLI, OpenCode, Cursor, Pi (2026-09-24)

What Room needs from a host: (a) MCP (stdio), (b) pre-edit hook that can block and inject context,
(c) headless worker with resume, (d) a way to wake/steer a running session, (e) packaging,
(f) instructions file. Sources were read on 2026-09-24. **[inf]** marks an inference.

## Adoption baseline

- JetBrains Developer Ecosystem Survey 2026 (15k+ devs, fieldwork May–Jul, published Aug 2026):
  Claude Code 39%, GitHub Copilot 21% (was 29%), Codex 16%, Cursor 12%, JetBrains AI/Junie 9%,
  OpenCode 7%, Google Antigravity 6%. No other harness in this list is broken out.
  https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/
- Roo Code shut down on 2026-05-15 (announced 2026-04-21). Its own advice to users was to move to Cline; a community fork (Zoo Code) continues. https://thenewstack.io/roo-code-cloud-ides-ai-coding/, https://nerova.ai/news/roo-code-shutting-down-may-15-2026-what-users-should-do-next
- Kilo: CLI 1.0 (2026-02-03) and the VS Code extension (GA 2026-04-02) are built on the OpenCode server. Anaconda acquired Kilo in July 2026. https://www.morphllm.com/comparisons/opencode-vs-kilo-code

## Candidates

| Host | MCP | Hooks | Headless / resume | Push into a live session | Packaging | Momentum | Verdict |
|---|---|---|---|---|---|---|---|
| **GitHub Copilot CLI + VS Code agent mode** | Yes. Supports MCP 2026-07-28 | Claude-format hooks: `preToolUse` deny/modify, `userPromptSubmitted` additionalContext, `postToolUse`, `agentStop`. VS Code agent mode reads the same `~/.copilot/hooks/*.json` (Preview) | `copilot -p`, `--resume=<id>`, `--server`/`--headless`, `--acp` | **Yes.** Extensions call `joinSession()` to get session messaging. The CLI queues and steers prompts, and it delivers scheduled prompts as steering while the agent is busy (changelog). The CLI is at 1.0.88 (2026-09-22) | Agent Plugins 1.0 (2026-08-12): a single format for VS Code, the CLI and the Copilot app, bundling MCP, skills, hooks and agents. Installs from GitHub repos | 21% in the survey, the largest enterprise base | **Add first.** Close to a port of the Claude plugin **[inf]** |
| **Cline** (VS Code + CLI) | Yes | PreToolUse, PostToolUse, UserPromptSubmit, TaskStart, TaskResume. `contextModification` was being dropped and is now fixed (issue #13554) | CLI headless with `--json`/piped stdin; `--auto-approve` | Not documented | Hook bundles published through npm; on the ACP registry | 1M+ installs (secondary source), gaining Roo's users **[inf]** | **Add.** Largest open-source VS Code agent. Its hook names differ from Claude's, so this is a thin adapter |
| **Factory Droid** | Yes | Claude-identical event set: PreToolUse (deny), UserPromptSubmit/SessionStart/PostToolUse `additionalContext`, Stop, SubagentStop… | `droid exec` for CI and scripts | Not documented | `.factory-plugin/plugin.json` plugins bundling hooks, MCP, skills and droids; on the ACP registry | Enterprise niche; no survey number | **Add (cheap).** The plugin shape and hooks mirror Claude Code **[inf]** |
| **Amp** (Sourcegraph) | Yes | In-process TS Plugin API: `tool.call` (allow/reject/modify), `agent.start` (add context), `agent.end` (continue), `session.start` | `amp -x` execute mode; threads persist and are shareable; orbs run in the cloud | **Yes, the best in class.** `thread.appendUserMessage(…, {steer:true})` and `agent.end → {action:'continue'}` | `.amp/plugins/` or `~/.config/amp/plugins/`, run under Bun | Influential but small; no survey number | **Strong runner-up.** Its wake/steer is better than Claude's, but the plugin is a TS module |
| Kilo Code | Yes | Inherits OpenCode's hooks; no session lifecycle hooks yet (open request) | Kilo CLI (an OpenCode fork) | Same as OpenCode **[inf]** | VS Code, JetBrains, CLI | 2.2M+ devs historically | **Free rider** on the OpenCode work. Test it; don't build for it separately |
| Windsurf, now Devin Desktop (Cognition) | Yes | 12 events incl. `pre_write_code`, which blocks with exit 2. **No context injection** | No CLI/headless documented | No | `.windsurf/hooks.json` | Declining; not in the survey top list **[inf]** | **Skip.** Guardrail hooks only, no worker mode, and the product is mid-rebrand |
| Kiro (AWS) | Yes | Pre/post command hooks | CLI 2.0 headless (API key) and ACP | Not documented | Powers, steering files | AWS-centric | **Via ACP** only |
| JetBrains Junie | Yes (shared with the IDE) | Early Access in Sep 2026 (`hooks/hooks.json` in extensions). MCP-only as of May | Junie CLI headless (trusted by design) | Not documented | Extension marketplace | 9% (JetBrains AI total) | **Watch.** Revisit when hooks go GA |
| Goose (AAIF) | Yes (extensions are MCP) | Stop hook context (1.44) | Recipes; headless, but the scheduler is buggy (#11164) | Via its ACP client | Recipes | Foundation-backed, modest use | **Via ACP.** It has spoken only ACP since v1.51.0 (2026-09-19) |
| Continue `cn` | Yes | "Claude Code-compatible" hooks, 16+ events | `cn -p` | No | npm | Low | Only if nearly free: reuse the Claude hook scripts |
| Augment Auggie | Yes (also runs as a server) | PreToolUse (input update), PromptSubmit (0.27.0, May 2026) | `--print --quiet` | No | CLI | Niche | Skip for now |
| Zed native agent | Yes | **None** (discussion #57943 asks for them) | Not applicable | Not applicable | Extensions (MCP extensions deprecated in favour of the MCP registry) | Editor share is small, but Zed shapes ACP | **Target Zed as an ACP client**, not its agent |
| Warp | Yes (local and Oz cloud) | None for Room | `oz`, being replaced by the `warp` CLI | No | Not applicable | Growing terminal | **No work.** Warp runs Claude Code, Codex and OpenCode inside it, so Room already works there |
| Aider | **No native MCP** (PRs closed) | No | `--message` scripting | No | pip | Fading | **Skip** |
| Roo Code | Not applicable | Not applicable | Not applicable | Not applicable | Archived | Dead since 2026-05-15 | **Skip** |

## Protocol-level options

**AGENTS.md** is an AAIF project, read natively by Copilot, Cursor, Windsurf, Amp, Aider, Gemini CLI,
Zed, Junie, Devin and Codex (https://aaif.io/projects/agents-md). Copilot CLI also reads CLAUDE.md and
expands @-imports in both. This makes the instructions half of Room nearly universal. One
AGENTS.md block covers most hosts, and the per-host skills matter only where a host has skills.

**Claude-format hooks as a de facto standard.** Copilot CLI and VS Code agent mode (explicitly
compatible), Factory, and Continue `cn` all accept Claude Code's hook JSON shape and event names.
Cline and Auggie are close. One set of Room hook scripts, with a small field-name shim, covers the
pre-edit requirement on roughly five hosts **[inf]**. This pays off more than any formal protocol.

**MCP (2026-07-28 spec)** went stateless. Tasks and Apps moved into extensions, change notifications
moved to `subscriptions/listen`, and sampling, roots and logging were deprecated
(https://blog.modelcontextprotocol.io/posts/2026-07-28/). Room's tool surface already reaches every
host except Aider. MCP still gives **no way to wake the model**. No surveyed host turns a server
notification into an agent turn **[inf]**, and sampling, the nearest thing, is now deprecated.
Wake/steer therefore stays per host (Claude inbox, Copilot extension `joinSession`, Amp
`appendUserMessage`).

**ACP (Agent Client Protocol)** has a registry with 60+ agents, including Claude Code, Codex, Copilot
CLI, Gemini CLI, OpenCode, Cline, Goose, Kiro and Factory Droid. JetBrains IDEs and Zed are clients
(https://zed.dev/blog/acp-registry, https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/).
Its coverage splits two ways:
- **Workers: yes, cheaply.** Room can become an ACP *client* for `room_spawn`. That means
  `session/new`, `session/prompt` and `session/load` (for resume) against any registry agent.
  `session/request_permission`, and `fs/write_text_file` where the agent routes writes to the
  client, give Room a pre-edit gate for workers without per-host hooks **[inf; this depends on each
  agent routing edits through the client, so verify per agent]**. One integration replaces
  per-host headless glue (the `claude -p` and `codex exec` wrappers) for dozens of agents.
- **Interactive sessions: not yet.** A person's own session belongs to their editor, which is the
  ACP client. Room could sit in the middle only as an ACP *proxy*. The proxy-chains RFD allows
  prompt/context injection and message interception, which would give wake and steer. However, it
  is a working proposal with a Rust prototype (`sacp-conductor`), and no editor documents installing
  proxies yet (https://agentclientprotocol.com/rfds/proxy-chains). Watch it. If Zed or JetBrains
  ship proxy installation, Room-as-proxy would cover every ACP agent in those editors at once.

## Recommendation

**Top 3 after Gemini CLI, OpenCode, Cursor and Pi:**
1. **GitHub Copilot (CLI + VS Code agent mode, one Agent Plugin).** It is the second-largest user
   base and the enterprise default. It uses Claude-format hooks and has plugin marketplaces. It is
   one of only two candidates that can inject messages into a running session (via an extension).
   Highest value for the effort.
2. **Cline.** The largest open-source VS Code agent. It is taking Roo's users, its hooks can inject
   context (fixed recently), and it has a headless CLI. It needs a hook-name adapter and a
   wake-on-next-prompt fallback, because live push is not documented.
3. **Factory Droid.** Its hook events, plugin bundle and exec mode mirror Claude Code, so the port is
   the cheapest here **[inf]**. The audience is smaller but has enterprise buyers.
   *Swap in Amp* if live steering matters more than reach: its Plugin API gives the cleanest
   wake/steer of any host, but it needs an in-process TypeScript plugin.
   Kilo comes almost free with the OpenCode work; test it as part of that.

**Protocol vs per-host glue: a hybrid.** Adopt ACP now for the **worker** half. Room as an ACP client
spawns and resumes any registry agent, which covers Copilot, Cline, Factory, Kiro, Goose, Gemini and
OpenCode workers with one code path. Keep per-host glue for the **interactive** half: hooks, wake and
packaging. Minimise it by standardising on Claude-format hook scripts, which Copilot, Factory and cn
accept as-is, plus AGENTS.md for instructions. Revisit ACP proxies when an editor ships proxy
installation, because that could replace per-host wake glue in Zed and JetBrains.

## Key sources (read 2026-09-24)
- Copilot CLI changelog (1.0.88, 2026-09-22): https://github.com/github/copilot-cli/blob/main/changelog.md
- Agent Plugins 1.0: https://github.blog/changelog/2026-08-12-agent-plugins-1-0-in-vs-code-copilot-cli-and-the-copilot-app/
- VS Code agent hooks: https://code.visualstudio.com/docs/agent-customization/hooks
- Copilot extensions `joinSession`: https://htek.dev/articles/github-copilot-cli-extensions-complete-guide (secondary)
- Cline hooks: https://docs.cline.bot/features/hooks/hook-reference ; https://github.com/cline/cline/issues/13554
- Factory hooks/plugins/exec: https://docs.factory.ai/reference/hooks-reference ; https://docs.factory.ai/harness/plugins ; https://docs.factory.ai/droid-exec/overview
- Amp Plugin API: https://ampcode.com/manual/plugin-api
- Cascade hooks: https://docs.devin.ai/desktop/cascade/hooks
- Kiro: https://kiro.dev/docs/cli/acp/ ; https://kiro.dev/blog/cli-2-0/
- Junie: https://junie.jetbrains.com/docs/junie-headless.html
- Goose ACP: https://goose-docs.ai/blog/2026/04/08/goose-acp-and-new-tui/ ; https://github.com/aaif-goose/goose/releases
- Zed hooks request: https://github.com/zed-industries/zed/discussions/57943
- Warp third-party agents: https://docs.warp.dev/agents/cli-agents/overview/
- Continue cn: https://www.npmjs.com/package/@continuedev/cli
- Auggie 0.27.0: https://www.augmentcode.com/changelog/auggie-cli-0-27-0-release-notes
- Aider MCP: https://github.com/Aider-AI/aider/issues/3314
