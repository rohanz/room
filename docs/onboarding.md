# Trying Room

## Start locally

1. [Install Room](../README.md#getting-started) for your agent and trust its hooks when asked.
2. Start Codex in your clone as usual. For Claude Code, use the [launcher setup](../README.md#claude-code).
   With no server configured or team choice remembered, nothing leaves your machine.
3. Ask for your feature. To split a substantial task, try:

   > Use a couple of subagents: add the endpoint in api.ts and its tests in api.test.ts.

Your agent handles coordination and brings finished output into your working tree, uncommitted
and unstaged, preserving your existing edits. All finished work is collected together; any
conflict leaves your files untouched. Running or failed work is skipped. Collection never
commits. If you ask for a commit, your agent uses plain Git for one normal task commit. Full
successful collection of an exited worker cleans up its worktree and branch, plus logs after a
successful exit. Failed or partial collection preserves work for recovery. Stopping without
collecting also preserves a dirty worktree. You do not need to
maintain ignore rules for Room. See [collection](../README.md#dispatching-workers) and
[what Room writes](../README.md#what-room-writes) for the details.

Ask **“show room state”** if you want to inspect progress, or ask for the browser link.
The browser is optional. A local link works while a session is running; local history survives
in the clone’s common Git directory. Live file text is rebuilt when sessions reconnect.

Claude Code and Codex can run side by side. A second session under the same login gets a
participant tag such as `rohanz+claude` or `rohanz+codex`; `ROOM_TAG` chooses your own label.

## Work with teammates

Use a GitHub repo you can push to. **Teammates must be on the same branch:** team rooms are
currently per branch. Removing that boundary is planned next.

1. Start your agent and say **“join the room”**.
2. On first login, open the GitHub device page, enter the code your agent gives you, and approve
   Room. Tell the agent when that is done so it can finish joining. Your participant name is
   your GitHub login; Room does not forward your `gh` token.
3. If the repo has no room, one participant asks **“open a room for this repo”**.
4. Work as usual. Your agent relays the [sharing disclosure](../README.md#getting-started) once
   per worktree and destination, including when you are first into the room.

The destination choice is remembered for the clone and its worktrees. Later sessions reuse it;
**“work locally”** switches back. Explicit environment settings can override the choice.

By default, eligible changed-file text is shared. `ROOM_SHARE=declared` limits text to your
agent’s declared paths; `ROOM_SHARE=intent` shares plans without file text. Ask to change the
sharing level at any time. Invalid levels fall back to plans only and report the invalid value.

## When something needs attention

Your agent coordinates when another participant’s task, claim or changed file overlaps its work.
It receives actionable conflicts and addressed questions. If hooks are not running, a session
cannot be woken, or changed files exceed sharing limits, Room reports the missing coverage.
A missing file in the room is not proof that nobody changed it.

After a plugin update, [start a new session](../README.md#updating-the-plugin): a running session
keeps the tools and instructions it started with. Trust hooks again if your host asks.

Tell us what surprised you, and when you wanted to turn Room off.
