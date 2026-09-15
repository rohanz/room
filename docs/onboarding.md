# Trying Room

Two ways in. Pick the one that matches you.

## Solo: one person, several agents, no server

1. Install the plugin once:
   ```sh
   claude plugin marketplace add rohanz/room && claude plugin install room@room   # Claude Code
   codex plugin marketplace add rohanz/room && codex plugin add room@room         # Codex
   ```
   Trust the hooks when asked.
2. Start your agent in any clone. It is already in a local room; nothing leaves your machine.
3. Ask it to fan out:
   > Spawn a worker tagged `api` for the endpoint and one tagged `tests` for the tests, wait for both, preview the merges and report.
4. Ask **"show room state"** at any point. Workers appear with their status, claims and last message.

Worktrees land in `.room/workers/<tag>` on branch `room/<tag>`. Add `.room/` to your `.gitignore`.

## Team: the hosted server

For `rohanz/room-playground` (Kieran, Hrishi) or any GitHub repo you can push to.

1. Install the plugin as above.
2. Point it at the server, once per shell (or in your shell profile):
   ```sh
   export ROOM_SERVER=hosted
   ```
3. Start your agent in the clone. The first time it says:
   > Open https://github.com/login/device and enter the code XXXX-XXXX

   Do that, approve "room". Ninety days, per machine. Your participant name is your GitHub login.
4. If the repo has no room yet, one person says **"open a room for this repo"**. Every branch of the repo then has a room and sessions join on their own.
5. Work as usual. Ask **"show room state"**, open the browser link it prints for the shared view.

Two agents from the same account on the same branch need a tag so they are distinct: `ROOM_TAG=codex codex`.

By default the room sees the full text of files you change. If you'd rather share only the files you've declared you're working on, start with `ROOM_SHARE=declared`; `ROOM_SHARE=intent` shares only your plans and claims, no file text. You can change it live with "share declared" / "share full".

## What to expect

- Before every edit the agent is shown teammates' claims on that file and your unread room messages.
- If it edits inside someone's claim without claiming, it gets an interrupt within seconds. So does the holder.
- If your file and a teammate's stop merging cleanly, you are told, and told again when they merge cleanly.
- `room_preview_merge` runs your tests on the combined tree before anyone pushes.

## What to tell us

Anything that surprised you, and the moment you wanted to turn it off. Both are the point of the trial.
