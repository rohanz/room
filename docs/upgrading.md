# Upgrade from Room 0.16 to 0.17

Room 0.17 is a **hard cutover**. It uses schema version 2 and hub protocol 1, and has one room per repository across branches. A 0.16 client cannot share a 0.17 room. Schedule the update with everyone using the repository.

## Team repositories

0. **Take a consistent pre-upgrade snapshot before deploying.** Stop the server first so LevelDB is not mid-write. Snapshot the entire `YPERSISTENCE` volume or directory. If `DATABASE_URL` is set, take a `pg_dump` of the registry database at the same stopped-server point. Keep both copies together. On Fly, follow [the hosted runbook](../deploy/DEPLOYING.md#017-cutover-snapshot-and-rollback). For Docker, stop the container and copy the named volume; for a bare host, stop the server and copy the `YPERSISTENCE` directory. Do not restart until the volume copy and matching database dump finish.
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

### Roll back the cutover

A **0.16 server cannot serve a volume that 0.17 has migrated**. Migration can move or clear the old canonical document, replace it with schema 2 and later purge legacy documents. Restoring only the 0.16 image against that volume is unsupported and can lose data. Legacy Markdown exports are for reading history; they are not a rollback image.

Stop the 0.17 server and restore the **pre-upgrade** `YPERSISTENCE` snapshot. If `DATABASE_URL` was used, restore the `pg_dump` taken at the same time; the registry and documents must match. For Docker, restore the saved named volume while the container is stopped. For a bare host, replace the stopped server's `YPERSISTENCE` directory with its saved copy. Deploy the 0.16.40 server only after restoring both stores. The hosted Fly volume and machine commands are in [the runbook](../deploy/DEPLOYING.md#017-cutover-snapshot-and-rollback).

Reinstall **0.16.40 clients on both hosts** and restart agent sessions. Commit `73866e6` is the 0.16.40 release; verify its plugin manifest says `0.16.40`. These plugin commands were checked against `claude plugin --help` and `codex plugin --help` on 2026-09-30:

```sh
git clone https://github.com/rohanz/room room-0.16.40
git -C room-0.16.40 checkout 73866e6
cat room-0.16.40/plugins/room/.claude-plugin/plugin.json  # verify version 0.16.40
ROOM_016_CHECKOUT="$(pwd)/room-0.16.40"
claude plugin uninstall room@room
claude plugin marketplace remove room
claude plugin marketplace add "$ROOM_016_CHECKOUT"
claude plugin install room@room
codex plugin remove room@room
codex plugin marketplace remove room
codex plugin marketplace add "$ROOM_016_CHECKOUT"
codex plugin add room@room
```

A `v0.16.40` tag on that commit would make this pin simpler if added later.

The snapshot and restore procedure is documented for this cutover and will be rehearsed on staging separately; it has not yet been exercised.

On a migrated team repository, a 0.16 client gets HTTP **403** or WebSocket close **4001** with: `update Room to 0.17 or later: this repository now has one room for all branches (<repo>)`. A 0.17 client pointed at an old server tells you the server needs Room 0.17. Upgrade both sides rather than retrying the old branch room.

## Local rooms and workers

End running 0.16 local sessions before joining with 0.17. The new local relay has a separate discovery file and generation. A 0.16 local session never finds the 0.17 relay: it can sit alone **without a warning**. The 0.17 relay can copy retained local messages, claims and scopes while the old relay is still present, then finish migration when that relay exits. Verify room state after closing the old session.

Update a lead and all its workers together. A mixed-version lead and worker may fail admission or miss addressed messages. Finish, collect or stop old workers before starting new ones; workers that were already collected or discarded cannot resume.

For any setup problem, ask **“is Room set up right?”** or run `room-doctor` from the installed plugin's `bin/` folder (paths in [the quickstart](../README.md#start-in-five-minutes)). See [the reference](reference.md#updating-plugins) for cache locations, sharing and diagnostics.
