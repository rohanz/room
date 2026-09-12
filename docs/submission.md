# Submission checklist

Deadline and timezone: **confirm in the hackathon portal**.
Event partner handles: **confirm before publishing the social post**.

## Deliverables

- [ ] Title: **Room — coding agents that coordinate before merge time**
- [ ] Written description (draft below; reconcile with the recorded demo)
- [ ] Public GitHub repository: https://github.com/rohanz/room
- [ ] Two-minute demo video; add its public link near the top of README.md
- [ ] Public social post tagging the event partners; add its link here
- [ ] Submit through the portal before the deadline

These boxes track submission readiness, not whether an implementation exists.

## Written description draft

Room helps developers work in parallel with coding agents that know what their teammates’
agents are doing. It runs inside existing Codex sessions and Git clones, where changes
are still uncommitted and implementation plans are still evolving.

Each agent publishes its current work, claims the lines it intends to edit, and declares
changes to shared interfaces. Room uses a live symbol index to identify relevant
consumers and route updates to the agents that depend on them. When a plan is replaced
or cancelled, affected agents receive an interrupt. The plugin can also wake an idle
session for a teammate’s question.

A browser view makes this coordination visible: current edits, declared contract changes,
upstream dependencies, potential downstream impact, and a timeline of agent activity.
Agents can preview their combined changes and run tests before developers approve commits
and pushes. Room never copies a teammate’s edits into your working tree.

The environment is essential: live files, Git history, shared plans, and teammate activity
supply context that an isolated coding conversation does not have. The prototype combines
Codex plugins and MCP tools, file watching, Yjs over WebSocket, and a TypeScript browser UI.

## Two-minute demo: show one dependency changing

Use the small working Python playground for behavioral proof. Use the 168-file commerce
sample only for a brief scale illustration, clearly labeled as synthetic.

| Time | On screen | Point to establish |
|---|---|---|
| 0:00–0:15 | Two Codex terminals on the same repo and branch. One changes the order model; the other adds coupons. | Different tasks still depend on the same contract. |
| 0:15–0:30 | Room state and the network: model plan, consumer, owners. | The agents receive live context from the actual workspace. |
| 0:30–1:05 | Change the model plan midway: keep customer as a string. Show the affected agent receiving the superseded-plan interrupt and responding. | Context changes the agent’s next action. |
| 1:05–1:25 | Address a question to the idle coupon agent; show it waking and answering. | Coordination continues without a human copying messages between chats. |
| 1:25–1:45 | Merge preview/test result, human approval, push, teammate seeing the new base. | Useful action with visible user control. |
| 1:45–2:00 | Combined tests passing, final UI, repository URL. | The workflow ends in working code. |

Rehearse first. If all beats do not fit, shorten setup and keep the plan-change reaction
and final test result. Label time compression. Do not present test doubles, staged sample
activity, or an unobserved wake-up as a live end-to-end result.

## Evidence to capture before recording

- [ ] Clean installation → automatic join in the intended repo/branch → browser link works.
- [ ] Both agents declare relevant plans before implementation.
- [ ] A superseded plan reaches the affected agent during work; record its response.
- [ ] An addressed question wakes an idle agent and receives an answer.
- [ ] A pushed commit advances the room base; the teammate detects it and pulls.
- [ ] Both clones finish with `git pull --ff-only && uv run pytest -q` passing.
- [ ] Repeat the chosen demo path three times; record any limitations.
- [ ] Capture one recovery path, such as a conflict or timeout, if it fits the video.
- [ ] Review recording and screenshots for credentials, private code, and access keys.

Unit tests of routing and hooks support the implementation; they do not substitute for
observing delivery in two real Codex sessions.

## Tune the submission to the rubric

| Criterion | Evidence to foreground |
|---|---|
| Core functionality | Two real sessions, an actual changed plan, an observed reaction, passing combined tests. |
| Innovation and theme | Teammates’ uncommitted work and intent alter the agent’s behavior inside its coding environment. |
| Technical execution | File watcher → overlay → symbol impact → targeted message → hook/session delivery; show recovery where possible. |
| Usefulness and control | Less manual relay between developers; visible claims and previews; human approval before commit/push. |

Avoid claims such as “prevents merge conflicts” or “detects every breaking change.” State
what is demonstrated: earlier awareness, targeted coordination, and compatibility checks.

## Social post draft

> We built Room: your coding agent, aware of your teammates’ agents.
>
> Live edits, shared plans, and dependency context help agents coordinate before merge
> time—inside the Codex sessions developers already use.
>
> Watch the demo: [VIDEO LINK]
> Code: https://github.com/rohanz/room
>
> Built for [EVENT NAME] with [CONFIRMED PARTNER TAGS].

Replace placeholders and attach a short clip showing an observed agent reaction. Publish
only after checking the actual partner handles and final demo claims.
