# Trying Room

Two ways in. Pick the one that matches you.

## Solo: one person, several agents, no server

1. Install the plugin once:
   ```sh
   claude plugin marketplace add rohanz/room && claude plugin install room@room   # Claude Code
   codex plugin marketplace add rohanz/room && codex plugin add room@room         # Codex
   ```
   Trust the hooks when asked.
2. Start your agent in any clone (`claude` or `codex`, interactively). It is already in a local room; nothing leaves your machine. The first time Claude Code loads the plugin it asks you to trust its hooks; say yes.
3. Ask in your own words: "use a couple of subagents for this" or "split this up". The agent handles the Room moves; no tool names needed. For example:
   > Split this up: add the endpoint in api.ts and its tests in api.test.ts.
4. Ask **"show room state"** at any point. Workers appear with their status, claims and last message. The browser link it prints works while a session is open. When a worker reports done, its work sits uncommitted on branch `room/<tag>`; the lead previews, commits in the worker worktree, and merges it unless you asked it not to. It also prints a browser link for the room; open it in a tab while your session is running. The local room lives only as long as a session is open, so the link from a one-shot `claude -p` run is gone once that run ends.

Room tools do not merge branches themselves: the lead follows the room-workers skill to preview and merge `room/<tag>` with Git, without pushing. Worktrees land in `.room/workers/<tag>`. Add `.room/` to your `.gitignore`.

Running Claude Code and Codex side by side under the same login? The second one to join is tagged automatically after its host (`rohanz+claude`, `rohanz+codex`), and that tag sticks to the clone across sessions so they remain distinct participants. Set `ROOM_TAG=<label>` if you want to name them yourself.

## Team: the hosted server

For `rohanz/room-playground` (Kieran, Hrishi) or any GitHub repo you can push to.

1. Install the plugin as above.
2. Start your agent in the clone (same commands as above) and say **"Join the room"**. "Join the team room", "join the web room", and "join the shared room" also work. No variables needed. The choice is remembered for that clone. Later sessions join the team room automatically; "work locally" switches back. The first time it replies:
   > Open https://github.com/login/device and enter the code XXXX-XXXX (valid 15 min).

   Do that in a browser, approve "room", then tell the agent "done" so it finishes the login and joins. Ninety days, per machine. Your participant name is your GitHub login. The agent also says, once, that uncommitted work in this clone is now visible to the repo's room members; that is the moment you are sharing. The choice is remembered for that clone, so later sessions join without being asked.
3. If the repo has no room yet, one person says **"open a room for this repo"**. Every branch of the repo then has a room and sessions join on their own.
4. Work as usual. Ask **"show room state"**, open the browser link it prints for the shared view.

By default the room sees the full text of files you change. If you'd rather share only the files you've declared you're working on, start with `ROOM_SHARE=declared`; `ROOM_SHARE=intent` shares only your plans and claims, no file text. You can change it live with "share declared" / "share full".

## What to expect

- Room stays silent while you are alone and starts coordinating when someone joins or you spawn workers.
- Before every edit, including edits made through the shell the agent is shown teammates' claims on that file and your unread room messages.
- If it edits inside someone's claim without claiming, it gets an interrupt within seconds. So does the holder.
- If your file and a teammate's stop merging cleanly, you are told, and told again when they merge cleanly.
- `room_preview_merge` runs your tests on the combined tree before anyone pushes.

## What to tell us

Anything that surprised you, and the moment you wanted to turn it off. Both are the point of the trial.

## Known issues

- Claude Code wake-ups need the channels flag (`claude-room` adds it). Without it, an idle Claude session does not react to questions or interrupts until your next message. Codex does not have this limitation. This is a Claude Code research-preview restriction, not a Room design choice; it goes away when Room is on the channel allowlist or channels leave preview.

- Codex occasionally hangs at startup before its MCP servers come up (seen twice in testing, never twice in a row). If `codex` shows nothing for a minute, quit and start it again.
- The local browser link is only reachable while a session is open; the relay stops with the last agent.
