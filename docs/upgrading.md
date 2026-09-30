# Upgrade from Room 0.16 to 0.17

Room 0.17 is a **hard cutover**. It uses schema version 2 and hub protocol 1, and has one room per repository across branches. A 0.16 client cannot share a 0.17 room. Schedule the update with everyone using the repository.

## Team repositories

0. **Take a consistent pre-upgrade snapshot before deploying.** Stop the server first so LevelDB is not mid-write. Snapshot the entire `YPERSISTENCE` volume or directory. If `DATABASE_URL` is set, take a `pg_dump` of the registry database at the same stopped-server point. Keep both copies together. On Fly, follow [the hosted runbook](../deploy/DEPLOYING.md#017-cutover-snapshot-and-rollback). For Docker, stop the container and copy the named volume; for a bare host, stop the server and copy the `YPERSISTENCE` directory. Do not restart until the volume copy and matching database dump finish.

   **Run the inventory pre-flight before cutover**, against the snapshot copy or the stopped server's directory, from a 0.17 development checkout with `npm ci` installed:

   ```sh
   npx tsx scripts/room-inventory.mts <snapshot directory> --budget-mb 32
   # Postgres registry: export at the same stopped-server point as the snapshot.
   psql "$DATABASE_URL" -Atc "SELECT COALESCE(jsonb_object_agg(repo, data), '{}'::jsonb) FROM room_repos" > rooms-pre-017.json
   npx tsx scripts/room-inventory.mts <snapshot directory> --registry rooms-pre-017.json --budget-mb 32
   ```

   The default registry is `<directory>/rooms.json`. The script copies LevelDB files into disposable scratch beside the source, then lists names and counts stored update bytes without loading a Y.Doc. It needs free space equal to the database; `--scratch <new directory>` selects another location. A hard link to `LOCK` detects a running server on the same filesystem. With scratch on another filesystem the script warns that it cannot check the lock: ensure the server is stopped or use the snapshot copy. Source document files remain unchanged. `--json` emits `{budgetBytes, docs}`. Exit codes: **0** clean, **2** flagged documents, **1** error. Inspect flags before deploying; this command never purges data.

   Kinds: `canonical` is the repository room; `served` is a decoded 0.16 branch room; `archive` is a migration archive recorded by its owner; `never-served` is an encoded key unreachable by 0.16.40; `unregistered` has no registry owner (or is not a room name). `!` marks the last two kinds or a document over budget. Sizing stops after crossing the budget, so `>` sizes and update counts are lower bounds. Example from the test fixture with a 1 MB budget:

   ```text
   budget: 1.0 MB stored per document
   github.com/o/r
     ! never-served    >1.1 MB      3 upd  "github.com%2Fo%2Fr%2Fenterprise"  (encoded key from before 0.16.40; 0.16.40 served only decoded names)
     ! never-served     0.0 MB      1 upd  "github.com%2Fo%2Fr%2Fmain"  (encoded key from before 0.16.40; 0.16.40 served only decoded names)
     ! served          >1.1 MB      3 upd  "github.com/o/r/big"  (over the per-document load budget: kept as an archive without loading)
       served           0.0 MB      1 upd  "github.com/o/r/main"
   (unregistered)
     ! unregistered     0.0 MB      1 upd  "github.com/q/quantlab/main"  (no registry entry for this repository)
     ! unregistered     0.0 MB      1 upd  "local%2Fdemo%2Fmain"  (no registry entry for this repository)
     ! unregistered     0.0 MB      1 upd  "x"  (not a room name)
   7 document(s); 6 flagged
   ```

   In 0.17, never-served and unregistered documents stay in place and are never loaded. Oversized served documents are kept as archives without loading and remain exportable with `room_export`. Quarantines appear in server `migration quarantine:` log lines and `GET /admin/inventory` (requires `ROOM_ADMINS`). `ROOM_LOAD_MAX_MB` bounds stored bytes per loaded document, default **32 MB**; match `--budget-mb` to that setting. Purging is a separate, explicit [admin action](../deploy/DEPLOYING.md#purging-quarantined-documents).

1. The operator deploys the **0.17 server first** using [the deploy runbook](../deploy/DEPLOYING.md).
   From that moment, 0.16 clients are limited: they keep using the branch rooms 0.16 recorded for a repository until the first 0.17 client joins it, but they cannot open a repository or add a branch. A 0.16 client that authenticates with `ROOM_TOKEN` puts the token in the URL, which 0.17 refuses at once with “update Room to 0.17 or later”: update those clients together with the server.
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
