# Room — submission answers (AI Tinkerers Singapore, Agents Everywhere)

Historical hackathon draft (September 2026). For current behavior and setup, see the [README](../README.md) and [onboarding](onboarding.md).

Copy each section into the matching form field. Deadline: today 4:30 PM SGT.

**Before submitting: the repo must be public.** Run `gh repo edit rohanz/room --visibility public --accept-visibility-change-consequences` (or Settings → Danger zone on GitHub).

---

## Project Name

Room

---

## Project Description

**Room puts your coding agent in the same room as your teammates' agents.**

Two people, two laptops, one repo, each running their own OpenAI Codex. Today those agents are blind to each other: both rewrite the same function and you find out at merge time. Room is a Codex plugin that gives every agent a live view of what everyone else is working on, what they plan to change, and what they have changed, so agents declare intent, claim what they edit, ask each other questions, and negotiate when plans overlap. Same Codex, same prompts. The agent simply knows more before it acts.

**The environment is the team's live repository**, not a chat window. That is what makes the agent more useful here than any standalone chatbot could be: a chatbot cannot know that a teammate is halfway through renaming the function you are about to call, or that someone else has already claimed the lines you want. Room can, because it sits inside the developer's real Codex session and real git clone.

**How it works.** A push-only daemon publishes each person's uncommitted files into a shared room as a per-person overlay; live sharing does not apply teammates’ edits to your working tree. Fourteen MCP tools (`room_*`) let the agent declare a scope, read a teammate's live version of a file, claim a function or line range with declared plans (for example "rename validate_token to verify_token"), release, announce changes, ask and answer questions, block until a claim is released or a question is answered, and preview a three-way merge of both people's uncommitted work, running the test suite on the merged tree without touching either clone. Messages carry priorities: fyi is read on the next action, notify is flagged at the top of the next tool reply, interrupt preempts. A live symbol graph (definitions and references per file over the base commit plus every overlay) routes a declared plan to whoever uses that symbol, powers an impact query, and tells an agent what it is waiting on. When a plan is cancelled or replaced mid-implementation, everyone who was shown the original is interrupted. The room base commit advances when someone pushes and teammates are told to pull.

**Deep Codex integration.** The plugin ships an etiquette skill and two Codex hooks: a PreToolUse hook injects the agent's unread room messages and any teammate claims on the file it is about to edit, right before every edit; a SessionStart hook records the thread so that a teammate's question or an interrupt wakes an idle Codex session through `codex queue`. Joining is zero-config: open Codex in any clone of a GitHub repo and the plugin derives the room from the git remote and branch, proves repo access with the user's GitHub login, and joins.

**A read-only browser view** shows people and their state (editing, waiting on someone, done, behind base), each file merged three-way with every person's lines tinted in their colour and only genuine conflicts marked, a timeline grouped into episodes per task with questions threaded under answers, and a network of declared contract changes and the files they impact.

**Verified in live runs.** In repeated two- and three-agent sessions on the hosted server, agents asked each other the right question ("which field holds the total?"), split a shared function by line without a conflict, coded against a teammate's declared interface before it existed, verified on the merged tree, and produced clean git merges with all tests passing. When a real line-level overlap occurred, the room reported it as resolvable because one agent had built on the other's change.

**User control.** Nothing commits or pushes without the human saying yes; the agent reports what landed, the test count and the merge preview result, then asks. Claims are advisory and visible; humans can watch every negotiation in the browser and step in.

**Technical execution.** TypeScript monorepo (npm workspaces, vitest, 98 tests). OpenAI Codex CLI 0.154 as the agent runtime: Codex plugin (skills, MCP server, hooks), Codex SDK for an optional "on duty" runner, `codex queue` for wake-ups. Model Context Protocol server with tool annotations. Yjs CRDT over a stock y-websocket server with LevelDB persistence, GitHub-verified access (the server checks the user's token can read the repo) and room-scoped view links for the browser. Python AST plus regex symbol extraction, node-diff3 for three-way merges, chokidar file watching, Vite and CodeMirror for the view, Fly.io hosting.

---

## Products & Tools Used

Tick: **OpenAI** (Codex CLI, Codex plugins and hooks, Codex SDK, MCP integration).

Other products: Yjs, y-websocket, Model Context Protocol SDK, Fly.io, GitHub CLI, node-diff3, Vite, CodeMirror, Vitest, uv.

---

## Project Video

Not yet recorded. Suggested 2-minute script: two terminals below, browser view above. Both agents join by opening Codex. Give overlapping tasks. Show the claim with a declared plan reaching the other agent, the question and answer, the merged view with both colours and no conflict, both agents finishing with a merged-tree test run, then the push offer and the "behind base, git pull" message on the other side.

---

## Team Contributions

**Rohan Kulshrestha (Lead)** — Architecture and protocol design: per-person overlays, scopes, claims with declared plans, priorities, ledgers, plan cancellation routing. Built the Codex plugin (room-etiquette and room-join skills, MCP server with the fourteen `room_*` tools, PreToolUse and SessionStart hooks, wake via `codex queue`), the push-only sync daemon with base-commit tracking, the symbol graph and impact analysis, the merged-tree test runner, GitHub-verified access and room-scoped view tokens, the Fly.io deployment, the read-only browser view's merged/diff/file panels, timeline and people cards. Ran the two- and three-agent live sessions and fixed what they surfaced.

**Kieran Ho Cheng Hong (Member)** — Dependency network view in the browser: participants' changes, upstream dependencies, declared contract changes and their downstream impact, with focus, search and zoom; graph snapshot publishing from the agent's symbol index into the room; README and submission write-ups.

**Hrishikesh Sathyian (Member)** — Live multi-agent testing as the second and third developer: drove the coupon, audit and item-limit tasks against the other agents across three sessions on the hosted server, surfaced the onboarding failures (GitHub access refusal reported as a timeout, stale room after a branch switch, ghost scopes after exit) that led to the preflight check, branch following and clean-exit fixes.

*(Adjust Hrishi's and Kieran's lines if they contributed anything else.)*

---

## Additional Links

1. https://github.com/rohanz/room — Source code, Codex plugin, docs (make public first)
2. https://room-rohanz.fly.dev — Hosted room server and browser view
3. https://github.com/rohanz/room-playground — Playground repo used for the live multi-agent runs

---

## Prior Work

The team confirmed with an organiser on 9 September that building before the event day was acceptable. On 9 and 10 September we wrote the design spec and a first version (a CRDT room that synced teammates' edits onto each other's disks, with an agent runner). During the hackathon day we rebuilt the core into what is submitted: per-person overlays without applying teammates’ edits, one-step join with GitHub-verified access, the intent-first protocol (scopes, claims with plans, priorities, ledgers, plan cancellation), the symbol graph and impact analysis, the merged-tree test runner, the Codex hooks and wake mechanism, the redesigned browser view including the network graph, the hosted deployment, and all live multi-agent testing. Everything is in the public git history with timestamps.

---

## Social Media Post (draft)

**X / Twitter:**

We built Room at #AgentsEverywhere: a Codex plugin that puts your coding agent in the same room as your teammates' agents. They declare what they'll change, claim what they edit, ask each other questions, and test the merged result before anyone pushes. Same Codex, no more merge surprises. @AITinkerers @OpenAI @CopilotKit @openrouter @exaailabs @auth0 @ambiguousio @triggerdotdev @mozillaAI @googlecloud

github.com/rohanz/room

**LinkedIn:**

At the AI Tinkerers "Agents, Everywhere" hackathon we built Room: an OpenAI Codex plugin that lets coding agents on different laptops coordinate on the same repo. Each agent sees what teammates' agents are working on, declares the changes it plans to make, claims the code it edits, asks the other agent when it depends on their work, and runs the tests on a merged preview of everyone's uncommitted changes before a human decides to push. Live sharing does not apply teammates’ edits to your working tree; Git stays Git. In our live three-agent runs, agents split a shared function by line, coded against a teammate's declared interface before it existed, and produced clean merges every time.

Thanks to AI Tinkerers, OpenAI, CopilotKit, OpenRouter, Exa, Auth0, Ambiguous AI, Trigger.dev, Mozilla.ai and Google Cloud. #AgentsEverywhere

https://github.com/rohanz/room
