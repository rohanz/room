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

   The default registry is `<directory>/rooms.json`. The script acquires the source `LOCK` through a hard link in a separate scratch database before copying any LevelDB files, and holds it through inspection so a server cannot start mid-copy. It then lists names and counts stored update bytes in the disposable copy without loading a Y.Doc. It needs free space equal to the database; `--scratch <new directory>` selects another location. With scratch on another filesystem the script warns that it cannot check the lock: ensure the server is stopped or use the snapshot copy. Source document files remain unchanged. `--json` emits `{budgetBytes, docs}`. Exit codes: **0** clean, **2** flagged documents, **1** error. Inspect flags before deploying; this command never purges data.

   Kinds: `canonical` is the repository room; `served` is a 0.16 branch room with a literal `github.com/<owner>/<repo>` prefix (valid GitHub owner/repo, case-insensitive match), bare or followed by `/` and any suffix, including empty, or a recorded `git/` or `local/` branch; `archive` is a migration archive recorded by its owner; `never-served` is a key whose decoded repository matches but whose literal prefix was unreachable by 0.16.40; `unregistered` has no registry owner (or is not a room name). For example, `github.com/o/r/feature%2Fx` and `github.com/o/r/a%252Fb` were served and remain exportable by those exact stored names; `github.com%2Fo%2Fr%2Fmain` was never served. `!` marks the last two kinds or a document over budget. Before reading values, sizing gates on native `leveldb.sstables` metadata: it refuses when an iterator could read a table larger than the load limit, including its initial seeks and one-past-end read. Range estimates alone can hide a huge block, so the gate uses whole table sizes. Memtable data is excluded and compressed records can undercount; reopening recovers legacy logs into SSTs. Below the gate it sums raw bytes with early exit. A table rejection reports its size, zero updates and `an oversized LevelDB table would be read`. This is conservative: small documents sorting before an oversized level-0 table can be flagged until that table is compacted. Other adapters without table metadata fall back to the value scan; flagged sizes are table estimates or raw-byte lower bounds. Example from the test fixture with a 1 MB budget:

   ```text
   budget: 1.0 MB stored per document
   github.com/o/r
     ! never-served    >1.1 MB      3 upd  "github.com%2Fo%2Fr%2Fenterprise"  (encoded or invalid literal repository prefix; 0.16.40 could not admit this stored key)
     ! never-served     0.0 MB      1 upd  "github.com%2Fo%2Fr%2Fmain"  (encoded or invalid literal repository prefix; 0.16.40 could not admit this stored key)
     ! served          >1.1 MB      3 upd  "github.com/o/r/big"  (over the per-document load budget: kept as an archive without loading)
       served           0.0 MB      1 upd  "github.com/o/r/main"
   (unregistered)
     ! unregistered     0.0 MB      1 upd  "github.com/q/quantlab/main"  (no registry entry for this repository)
     ! unregistered     0.0 MB      1 upd  "local%2Fdemo%2Fmain"  (no registry entry for this repository)
     ! unregistered     0.0 MB      1 upd  "x"  (not a room name)
   7 document(s); 6 flagged
   ```

   The `tables over budget` section and JSON `tables` list show each oversized SST's level, file number, bytes and boundary document names; the server logs each and `/admin/inventory` reports the same list. **If any table is over budget, do not deploy onto that volume as-is:** a level-0 final block can still be read while seeking a later document, and LevelDB's own compaction also reads it. Raise `ROOM_LOAD_MAX_MB` for the cutover on a larger VM. Table flags also produce exit **2**.

   In 0.17, never-served and unregistered documents stay in place and are never loaded. Oversized served documents are kept as archives without loading and remain exportable with `room_export`. Quarantines appear in server `migration quarantine:` log lines and `GET /admin/inventory` (requires `ROOM_ADMINS`; concurrent requests share one scan). `ROOM_LOAD_MAX_MB` bounds stored bytes per document during migration, default **32 MB**; match `--budget-mb` to that setting. Other cold loads and joins use the larger of `ROOM_LOAD_MAX_MB` and twice `ROOM_DOC_MAX_MB` (default 128 MB). Purging is a separate, explicit [admin action](../deploy/DEPLOYING.md#purging-quarantined-documents).

   Raw migration copies and archive exports ignore the websocket `ROOM_MAX_MESSAGE_MB` cap. Exports first scan for the total and largest record, then refuse with **507** before streaming headers if that record cannot fit `ROOM_DOC_MAX_MB` and the shared output reservations (`ROOM_MAX_TOTAL_QUEUED_MB`); raise the named setting and retry. The client frame ceiling is `ROOM_EXPORT_MAX_FRAME_MB` (default **64 MB**, positive finite values); raise it in the exporting agent’s environment when increasing server export limits. Each stored record is read whole, so export and copy allocate up to the largest record, while the total archive can exceed the output budget. A failure after headers destroys the response; retry a partial export.

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
4. Join from each clone and ask **“show room state”**. It should show `room: github.com/<owner>/<repo>` and each participant's own branch and base. A name used on several branches migrates under that name only when the server's audit log is complete (an audit file or Postgres, within 100,000 entries and 32 MB, every line readable) and shows that every branch room was written only through GitHub logins, with the GitHub login that owns the name among them. A branch room that any writer joined without a GitHub login (an open or `ROOM_TOKEN` server, or OIDC) keeps placeholders for every name in it. This does not detect a GitHub login renamed and taken by someone else between two joins, or a 0.16 writer using a name their login did not own (0.16's identity guard only observed): placeholders never defended against either in 0.16. Room state lists any other name used on several branches as `N messages for an unresolved name (ben on main or ben on feature): ask them to rejoin`: each original owner must join from their old clone to reclaim their claims and addressed questions.

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

A clone that remembered a 0.16 local room `local/<main worktree folder>/<branch>` joins the repository room `local/<main worktree folder>` instead. The first 0.17 join rewrites the remembered choice and says so once. Any other remembered local name, such as `local/experiments`, is a custom room and is kept. So is a local room chosen with 0.17.0-rc7 or later, whatever its shape. 0.16's branch notices (`you switched to <branch>; the room is for <branch>; …`) are not copied into the new room, and any already copied are never delivered.

Update a lead and all its workers together. A mixed-version lead and worker may fail admission or miss addressed messages. Finish, collect or stop old workers before starting new ones; workers that were already collected or discarded cannot resume.

For any setup problem, ask **“is Room set up right?”** or run `room-doctor` from the installed plugin's `bin/` folder (paths in [the quickstart](../README.md#start-in-five-minutes)). See [the reference](reference.md#updating-plugins) for cache locations, sharing and diagnostics.
