# Upgrade from Room 0.16 to 0.17

Room 0.17 is a **hard cutover**. It uses schema version 2 and hub protocol 1, and has one room per repository across branches. A 0.16 client cannot share a 0.17 room. Schedule the update with everyone using the repository.

## Team repositories

1. The operator deploys the **0.17 server first** using [the deploy runbook](../deploy/DEPLOYING.md).
2. Every teammate updates the plugin at the same time:

   ```sh
   claude plugin marketplace update room
   claude plugin update room@room
   ```

   ```sh
   codex plugin marketplace upgrade room
   codex plugin add room@room
   ```

3. End or restart running 0.16 agent sessions. A running session keeps its old MCP tools and instructions; reconnecting MCP with `/mcp` may load the new bundle. In Codex, accept the hooks prompt again if it appears.
4. Join from each clone and ask **“show room state”**. It should show `room: github.com/<owner>/<repo>` and each participant's own branch and base. Resolve any `unresolved from <old room>` names in room state: the original owner must join to reclaim their claims and addressed questions.

The server archives the old branch rooms during migration. To read one, use `room_export room=<legacy name>` from 0.17. Archives remain for `ROOM_LEGACY_DAYS` after migration (default **30 days**), then the server removes them. Export any history you need before then.

On a migrated team repository, a 0.16 client gets HTTP **403** or WebSocket close **4001** with: `update Room to 0.17 or later: this repository now has one room for all branches (<repo>)`. A 0.17 client pointed at an old server tells you the server needs Room 0.17. Upgrade both sides rather than retrying the old branch room.

## Local rooms and workers

End running 0.16 local sessions before joining with 0.17. The new local relay has a separate discovery file and generation. A 0.16 local session never finds the 0.17 relay: it can sit alone **without a warning**. The 0.17 relay can copy retained local messages, claims and scopes while the old relay is still present, then finish migration when that relay exits. Verify room state after closing the old session.

Update a lead and all its workers together. A mixed-version lead and worker may fail admission or miss addressed messages. Finish, collect or stop old workers before starting new ones; workers that were already collected or discarded cannot resume.

For any setup problem, ask **“is Room set up right?”** or run `bin/room-doctor` from a checkout or installed plugin. See [the reference](reference.md#updating-plugins) for cache locations, sharing and diagnostics.
