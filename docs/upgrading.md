# Upgrading Room

**From 0.17.33 on, upgrades are rolling.** Servers, relays and sessions advertise and select a shared contract before syncing (see docs/reference.md, "negotiate a contract"); the supported window is the current release plus three minor releases back, never below 0.17.0. Deploy the server first, then let people restart sessions when convenient; a session outside the window is refused with the exact side that must change. The local daemon cutover is the exception: follow the per-clone drain below before starting daemon clients. Wire compatibility alone does not permit mixed local runtimes.

## Storage compatibility release

This release raises the runtime requirement to the **official nodejs.org Node.js 22.22.3 or later in the 22.x line**, and introduces a shared storage admission gate while existing lifecycle files remain authoritative. It does not convert a clone to SQLite. Wire compatibility does not prove storage compatibility or make an older writer participate in the gate.

1. Finish active worker batches and inventory every host, MCP, daemon, helper and worker using the clone or its linked worktrees. Preserve unfinished outputs and prevent older plugin launch/reconnect loops before any maintenance. Complete the [local daemon cutover](#local-daemon-cutover) too if it is still pending; its record does not replace the storage gate.
2. Put the official Node installation first on the host launch PATH (`bin` on POSIX; the directory containing `node.exe` on Windows), update the plugins, then fully stop and restart both the hosts and any persistent daemon that launches MCPs. GUI applications can inherit a different PATH from a shell. Check the executable reported by each actual launch; a terminal's `node --version` is insufficient.
3. Run `node "<plugin>/server/room-state.mjs" preflight --common-dir "<absolute Git common directory>" --json` and inspect its runtime/filesystem evidence. A runtime failure refuses startup before legacy state is opened; follow the printed setup/restart remedy. An unqualified filesystem is reported but does not prevent legacy operation in this release. It has not been qualified for SQL activation.
4. Run `node "<plugin>/server/room-state.mjs" status --common-dir "<absolute Git common directory>" --json`. If pre-registry import is required, use the printed `import-legacy` command during the stopped-writer maintenance window. Startup no longer performs this import automatically. Stable assignment checkpoints survive retries. A newly empty registry can initialize its legacy gate after proving that no activation evidence exists.
5. If maintenance is interrupted, keep old binaries stopped and inspect status and the outstanding operation records. Live and unknown holders block; a timeout leaves admission closed. Reconcile a verified-dead holder's effects before `resolve-ticket`, then complete `import-legacy` or explicitly `reopen` as appropriate. With no pending legacy import, `reopen` cancels a legacy-only drain and abandons that maintenance attempt; it does not certify completed reconciliation. Live work continues, and dead or unknown evidence remains for later maintenance. Do not remove gate, ticket, lock or worker files to force startup. The [storage maintenance reference](reference.md#storage-maintenance) lists exact flags and exit behavior.

The gate cannot fence unmodified older binaries. Returning to an older plugin during a drain would bypass admission and is not a recovery procedure. No live SQL migration is authorized or performed by installing this compatibility release; conversion requires a later activation release and an explicit operator window.

## Local daemon cutover

The standalone-daemon release changes who owns local transport. Upgrade **one clone and all its linked worktrees together**, including the local workers room of a team session. Separate clones drain independently. The daemon reuses `room/relay.json`, the clone key, authority lock, schema-2 selective snapshots, incarnation and private leases under the Git common directory; this is not a snapshot-schema migration. Never delete those files to get past a refusal.

On use, Room repairs legacy directories only from the `room/` state root through the requested directory, logging each repair and requiring real directories owned by the current user (0700 on POSIX, a protected private DACL on Windows); symlinks, other owners and non-directories remain refused. On Windows, Room protects the `room/` folder itself, once per process, with an owner-only access list that everything inside inherits; anything a hook wrote there before Room first ran is covered by the same change.

1. Inventory every old local client in the clone and linked worktrees: Claude and Codex leads, dispatched workers, nested host sessions, local/team bridges and browser viewers. Ask **“is Room set up right?”** (`room_state check=true`) for the cutover rows. The rows show recorded session/MCP/worker processes, stale/dead evidence, owner PID and port, unknown liveness and unreadable records. A record claiming a launch or host process with missing or malformed identity blocks as unknown; the row names the record and reason. A binding-only record with no process claim does not block by itself. An unknown owner always blocks. The rows cannot enumerate every viewer or unrecorded host: check these yourself too. Stop old-plugin launch and reconnect loops, and retain workers' worktrees, results and recovery patches.
2. Quiesce publication and establish preservation **while a current replica remains alive**. For 0.17.31–0.17.32, observe successful final save and owner exit, then validate the resulting reloadable selective snapshots and private authority files. For 0.17.25–0.17.30, successful stop alone does not establish preservation: obtain a quiescent checkpoint while the replica still lives, load it through the selective snapshot loader in isolation, and compare required claims, mail, receipts and completed-publication revisions with the live room. A human-readable export is supplementary; it may not be reloadable selective memory. If validation or storage recovery is unavailable, keep the owner/replica alive and postpone the cutover. Never kill the sole replica to upgrade.
3. Finish stopping **all** old clients and close viewers. Verify the old owner's process has exited using its recorded process birth identity. Unknown liveness, including an unavailable Windows identity query, blocks startup; a timeout is not proof of death. Update installed plugins on both hosts and restart updated clients only after the drain finishes. Installation alone does not replace tools loaded in a running session.
4. The first updated bound client verifies the recorded owner and clients, writes a private `room/daemon-cutover.json` drain record automatically, and starts the daemon under the existing authority lock. This record is process-drain evidence, not approval of a checkpoint or a guarantee that an unrecorded old process cannot return. Subsequent launches still detect old-owner takeover. Run `room_state check=true` again to verify the authenticated daemon runtime and cutover rows.

A D client finding a live session-owned relay refuses normal use and names its PID, port, release when available, and the **drain/save/exit, then restart updated clients** remedy. A relay without the old `lead` flag is still a legacy runtime. The client does not evict it, force shutdown, take another lock or start a parallel listener. Unreadable records and unknown process identity require inspection, not deletion or an assumed clean drain. PID reuse is checked against the recorded birth identity rather than trusting the number alone.

If a client remains blocked with unknown liveness, check any process whose working directory is in its worker worktree, the host's session transcript for the recorded `hostSessionId`, and the worker log file. Process listings may hide overwritten arguments; absence of a session ID proves nothing. After a person has verified the client is no longer running, use the exact `FIX` command printed by diagnostics, for example:

```sh
node "<plugin>/server/room-mcp.mjs" cutover-resolve --dir "<checkout>" --record "room/registry/workers/<id>.json" --confirm-not-running --note "Checked worktree processes, transcript and log"
```

`--record` is relative to the Git common directory; `--dir` defaults to the current directory and `--note` is optional. The command refuses missing confirmation, a client that is not currently blocking, or live-process evidence. It appends a private `room/daemon-cutover-resolutions.json` entry without deleting or modifying the source record. Diagnostics show `INFO resolved by operator at <time>` for the same fingerprint, including worker report evidence. Changed records or evidence are judged again, and live evidence always blocks even after resolution. This does not resolve an unknown owner or unreadable inventory and does not replace preservation checks.

An old or negotiation-only writer that reconnects to the daemon is refused before document sync because it lacks the daemon lifecycle contract, even when schema 2/proto 1 matches. This batch retains the existing encrypted read-only viewer route; it does not enforce the proposed viewer negotiation gate. Close old viewers during the drain and reopen with updated assets. Writer runtime enforcement must not be taken as evidence that all viewers negotiated a daemon profile. If an old lead starts an in-session relay after a daemon crash, updated clients retain their replicas, refuse that runtime and require another old-owner drain before daemon restart. The drain record cannot fence old binaries.

**Rehearse first.** `npx tsx scripts/cutover-rehearsal.mts --old <pre-daemon plugin dir>` runs two sessions on the old plugin's real bundle in a throwaway clone, leaves unread mail, drains them, cuts over with this checkout's plugin and checks the health rows, the daemon runtime, the drain record, mail delivery and the documented stop. Add `--from-clone <git common dir>` to rehearse with a read-only copy of an existing clone’s `room/` state. The copy excludes keys, locks, symlinks and the source clone's drain record and operator resolutions (both are bound to that clone), replaces relay discovery with an inert rehearsal entry, and lives in a private temporary directory deleted on success or failure. No objects or worktrees are copied. A real clone can hold records the cutover cannot prove gone (for example a worker whose launch was never confirmed); the rehearsal then stops at them, as the live cutover would. Add `--resolve-blocked` to have the rehearsal play the operator in its scratch copy with the printed `cutover-resolve` command, so the rest of the path is exercised; on the live clone, run that command yourself only after the checks it names. Run it on each platform before cutting over a live clone.

### Roll back the local daemon

Stop new launches/reconnect loops, disconnect all daemon writers and close viewers. From the clone, run the installed standalone bundle (replace `<installed-plugin>` with that plugin's directory):

```sh
node "<installed-plugin>/server/room-daemon.mjs" stop --common-dir "$(git rev-parse --path-format=absolute --git-common-dir)"
```

The command authenticates the discovery PID and instance nonce, checks its process birth identity, and refuses active writers or an existing drain. It requests a save-first stop and succeeds only after final snapshot/lease persistence and verified process exit. A failed save exits nonzero with the cause, while the daemon retains memory, listener and authority and reopens repair admission. Inspect the private `room/daemon.log` and authenticated `/daemon/status`, resolve storage and retry after disconnecting writers. Capacity failure requires an explicitly reviewed deletion-only repair; this release has no operator repair/export tool, so postpone rollback until a verified repair or reloadable checkpoint is available. A timeout or unverified exit is not a completed stop; keep older binaries stopped. Do not force termination to roll back. After success, validate the reloadable schema-2 snapshots and private authority files and preserve a private backup. `room_close` forgets room memory; it does not stop the daemon.

Stop every daemon client before starting the older plugin. Reinstall the selected compatible pre-daemon release on both hosts and restart its sessions only after the drained daemon stop is verified. Preserve the existing schema-2 memory, key and authority files. Never run old and daemon owners concurrently; a durable drain record does not authorize runtime coexistence. This procedure does not roll back a separate future schema migration.

## Upgrade from Room 0.16 to 0.17

Room 0.17 is a **hard cutover**. It uses schema version 2 and hub protocol 1, and has one room per repository across branches. A 0.16 client cannot share a 0.17 room. Schedule the update with everyone using the repository.

### Team repositories

0. **Take a consistent pre-upgrade snapshot before deploying.** Stop the server first so LevelDB is not mid-write. Snapshot the entire `YPERSISTENCE` volume or directory. If `DATABASE_URL` is set, take a `pg_dump` of the registry database at the same stopped-server point. Keep both copies together. On Fly, follow [the hosted deployment steps](#hosted-fly-deployment) below. For Docker, stop the container and copy the named volume; for a bare host, stop the server and copy the `YPERSISTENCE` directory. Do not restart until the volume copy and matching database dump finish.

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
4. Join from each clone and ask **“show room state”**. It should show `room: github.com/<owner>/<repo>` and each participant's own branch and base. A name used on several branches migrates under that name only when the server's audit log is complete (an audit file or Postgres, within 100,000 entries and 32 MB, every line readable) and shows that every branch room was written only through GitHub logins, with the GitHub login that owns the name among them. A branch room that any writer joined without a GitHub login (an open or `ROOM_TOKEN` server, or OIDC) keeps placeholders for every name in it. This does not detect a GitHub login renamed and taken by someone else between two joins, or a 0.16 writer using a name their login did not own (0.16's identity guard only observed): placeholders never defended against either in 0.16. Room state lists any other name used on several branches as `N messages for an unresolved name (ben on main or ben on feature): ask them to rejoin`: each original owner must join from their old clone to reclaim their claims and addressed questions. Migrated 0.16 messages are left out of `room_state`'s recent list; `room_state all=true` shows them. When the archives expire (below), the server also drops the claims and scope still held for unresolved names.

The server archives the old branch rooms during migration. To read one, use `room_export room=<legacy name>` from 0.17. Archives remain for `ROOM_LEGACY_DAYS` after migration (default **30 days**), then the server removes them. Export any history you need before then. A registered branch room that was never stored has nothing to export: `room_export` says `nothing to export from <room>: no stored document for <room>` and writes no file.

Upgrading never widens sharing. A clone that chose `intent` or `declared` in 0.16 starts every 0.17 session and worker from that clone at that level instead of the `full` default, including linked worktrees and new name tags; an unreadable old choice starts at `intent`. Ask for **“share all changed files”** (`room_share`) to change it.

### Roll back the cutover

A **0.16 server cannot serve a volume that 0.17 has migrated**. Migration can move or clear the old canonical document, replace it with schema 2 and later purge legacy documents. Restoring only the 0.16 image against that volume is unsupported and can lose data. Legacy Markdown exports are for reading history; they are not a rollback image.

Stop the 0.17 server and restore the **pre-upgrade** `YPERSISTENCE` snapshot. If `DATABASE_URL` was used, restore the `pg_dump` taken at the same time; the registry and documents must match. For Docker, restore the saved named volume while the container is stopped. For a bare host, replace the stopped server's `YPERSISTENCE` directory with its saved copy. Deploy the 0.16.40 server only after restoring both stores. The hosted Fly volume and machine commands are [below](#hosted-fly-deployment).

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

The volume snapshot and restore procedure was [exercised on staging on 2026-10-03](superpowers/rehearsals/2026-10-03-rc14-live.md): real GitHub authentication, synthetic branch rooms, migration to rc14, and restoration under 0.16.40 preserved the login, claims, scopes and messages. The Postgres variant was not exercised.

On a migrated team repository, a 0.16 client gets HTTP **403** or WebSocket close **4001** with: `update Room to 0.17 or later: this repository now has one room for all branches (<repo>)`. A 0.17 client pointed at an old server tells you the server needs Room 0.17. Upgrade both sides rather than retrying the old branch room.

### Server settings for the cutover

These settings exist only for the 0.16 migration; a server that never held 0.16 data can leave them alone. `ROOM_LOAD_MAX_MB` (default 32 MB stored per document) is described with the other [advanced limits](../deploy/self-hosting.md#advanced-limits).

| Setting | Meaning | Default |
| --- | --- | --- |
| `ROOM_LEGACY_DAYS` | Days after a repository's 0.17 migration before its archived 0.16 branch rooms are removed. | `30` |
| `ROOM_MIGRATION_MAX_SOURCES`, `ROOM_MIGRATION_MAX_READ_MB`, `ROOM_MIGRATION_MAX_RECORDS` | Work budget of the cutover across all phases: branch rooms considered, megabytes read and records processed. The fixed limits are 64 KiB per record and 4 rebuilds to fit the document cap. The per-document `ROOM_LOAD_MAX_MB` gate checks native SST table metadata before values are read, then sums raw update bytes with early exit before decoding. A table refusal may conservatively flag small documents whose iterator would touch another document's oversized table, especially earlier names in level 0. Memtables and compression can undercount; reopen legacy data before pre-flight. What is not migrated stays in the archive, exportable. | `1000`, `128`, `100000` |
| `ROOM_EXPORT_MAX_FRAME_MB` (client) | Largest length-prefixed archive record the exporting agent accepts, in MB. Positive finite values override the default; invalid values fall back to 64. Raise it in the agent environment alongside server export limits for larger snapshots. | `64` |

A 0.17 server creates nothing for a 0.16 client: repositories and branch rooms recorded by 0.16 stay usable by 0.16
clients until the first 0.17 client cuts the repository over, but a 0.16 client can no longer open a repository or
add a branch.

### Hosted Fly deployment

The volume snapshot, 0.17 migration and restored-volume rollback to 0.16.40 were [exercised on staging on 2026-10-03](superpowers/rehearsals/2026-10-03-rc14-live.md) with real GitHub authentication and synthetic room data. The Postgres variant was not exercised. Commands follow Fly's [volume snapshot](https://docs.fly.io/volumes/snapshots/) and [volume management](https://docs.fly.io/volumes/volume-manage/) documentation as fetched on 2026-09-30. Fly keeps snapshots for **5 days by default** (configurable from 1 to 60 days). Roll back within that window or raise retention before upgrading.

**Step 0, before deploying 0.17:** stop the machine for a quiescent snapshot, since LevelDB may otherwise be mid-write. Record the machine and volume IDs, then create a snapshot of `room_data` in `sin`; wait until the new snapshot appears and record its ID. If `DATABASE_URL` is configured, take a `pg_dump` at the same stopped-machine point and retain it with the volume snapshot.

```sh
fly machine stop <machine id> -a room-rohanz
fly volumes list -a room-rohanz
fly volumes snapshots create <volume id> -a room-rohanz
fly volumes snapshots list <volume id> -a room-rohanz
# If DATABASE_URL is set, take and retain a matching dump now:
pg_dump "$DATABASE_URL" --format=custom --file=room-registry-pre-017.dump
```

**Inventory pre-flight, still before deploying:** restore that snapshot onto a staging volume/machine with the Room server stopped, or copy its LevelDB directory to an operator machine. Run `npm ci` in a 0.17 development checkout and run the script against the restored/copied directory:

```sh
npx tsx scripts/room-inventory.mts <snapshot directory> --budget-mb 32
# If DATABASE_URL supplies the registry, export it at the snapshot's stopped-server point:
psql "$DATABASE_URL" -Atc "SELECT COALESCE(jsonb_object_agg(repo, data), '{}'::jsonb) FROM room_repos" > rooms-pre-017.json
npx tsx scripts/room-inventory.mts <snapshot directory> --registry rooms-pre-017.json --budget-mb 32
```

The root `Dockerfile` does not ship `scripts/`; the command runs in a development checkout, not the server image. A staging machine needs that checkout and its dependencies, or transfer the snapshot directory out first. Keep the matching exported registry with the snapshot; default registry is `<directory>/rooms.json`.

The script acquires the source `LOCK` through a hard link in a separate scratch database before copying, and holds it through inspection so a server starting mid-copy is refused. It copies LevelDB files to disposable scratch beside the source (needs free space equal to the database), leaving source files unchanged. `--scratch <new directory>` overrides its location; if another filesystem prevents the lock check, it warns and the operator must ensure the source server is stopped. `--json` emits structured output. Exit **0** is clean, **2** means flagged documents to review, **1** is an error. The [upgrade guide](#team-repositories) explains each kind and includes fixture output. Match the budget to `ROOM_LOAD_MAX_MB` (default 32 MB stored per document during migration); other cold loads and joins use the larger of that and twice `ROOM_DOC_MAX_MB` (default 128 MB), because the server compacts a live room's stored snapshots to within about 1.5 times its size. Sizing gates on native `leveldb.sstables` metadata before reading values, refusing any oversized table an iterator's initial seek or one-past-end read could touch; range estimates alone can hide a huge block. It then sums raw values with early exit. Memtable data is excluded and compression can undercount; reopening recovers old logs into SSTs. Table refusals report the table size, zero updates and `an oversized LevelDB table would be read`. Small documents sorting before an oversized level-0 table can be conservatively flagged until it is compacted. Adapters without table metadata fall back to the value scan.

The `tables over budget` section and JSON/admin `tables` list report each oversized table's level, file number, bytes and boundary document names; startup logs one line per table. Do not deploy onto that volume as-is: a level-0 final block may still be read when seeking a later document, and LevelDB compaction reads it too. Raise `ROOM_LOAD_MAX_MB` for the cutover on a larger VM; table flags produce exit 2.

Served GitHub keys have a literal `github.com/<owner>/<repo>` prefix (valid GitHub owner/repo, case-insensitive match): the bare name in any case, or `/` and any suffix, including an empty one and `%` escapes. Recorded `git/` and `local/` branches can also contain `%`. Encoded repository prefixes such as `github.com%2Fo%2Fr%2Fmain` were never served. Never-served/unregistered keys stay in place without loading; oversized served keys remain exportable archives, and served keys cannot be admin-purged. Exports use exact stored names from the registry's legacy list. Raw copies and exports ignore the websocket message cap; exports preflight the largest record and refuse **507 before headers** when it exceeds `ROOM_DOC_MAX_MB` or shared output reservations (`ROOM_MAX_TOTAL_QUEUED_MB`). Each record is read whole, so export and copy allocate up to the largest record, while the archive total can exceed the output budget. Failures after headers destroy the response. Check `migration quarantine:` logs and `GET /admin/inventory` after cutover; concurrent inventory requests share one scan and disconnected waiters release their response slots.

Deploy 0.17 using the command in [the Fly runbook](../deploy/DEPLOYING.md#deploy), then update all clients together using this guide. A **0.16 server cannot safely serve a volume migrated by 0.17**. Putting the 0.16 image back on the migrated volume is not a rollback; legacy Markdown exports are not a rollback image.

**Rollback:** stop the 0.17 machine. Restore the pre-upgrade snapshot to a new `room_data` volume at least as large as the original (1 GB here), in `sin`. If `DATABASE_URL` was used, restore the matching pre-upgrade `pg_dump` while the server is stopped. Attach the restored volume at `/data` to a new machine, retire the old machine, then deploy the **0.16.40 image**. Alternatively, use Fly's scale command to create a machine and new volume from the snapshot. Reinstall 0.16.40 clients on Claude Code and Codex with the commands in [Roll back the cutover](#roll-back-the-cutover), and restart their sessions. Check rooms and logins before destroying the old volume; destruction is permanent and has no undo.

```sh
fly machine stop <old machine id> -a room-rohanz
fly volumes create room_data --snapshot-id <snapshot id> -s 1 -r sin -a room-rohanz
fly machine clone <old machine id> --region sin --attach-volume <new volume id>:/data -a room-rohanz
fly machine destroy <old machine id> -a room-rohanz
# Alternative to create and attach via clone: fly scale count --with-new-volumes --from-snapshot <snapshot id> 1 -a room-rohanz
# If DATABASE_URL was used, restore its matching dump while the server is stopped:
pg_restore --clean --if-exists --dbname="$DATABASE_URL" room-registry-pre-017.dump
cd <room-0.16.40-checkout>  # commit 73866e6; see the upgrade guide
flyctl deploy --config deploy/fly.toml --dockerfile Dockerfile --depot=false
fly volumes destroy <old volume id> -a room-rohanz  # only after verifying the rollback
```

### Local rooms and workers

End running 0.16 local sessions before joining with 0.17. The new local relay has a separate discovery file and generation. A 0.16 local session never finds the 0.17 relay: it can sit alone **without a warning**. The 0.17 relay can copy retained local messages, claims and scopes while the old relay is still present, then finish migration when that relay exits. Verify room state after closing the old session.

A clone that remembered a 0.16 local room `local/<main worktree folder>/<branch>` joins the repository room `local/<main worktree folder>` instead. The first 0.17 join rewrites the remembered choice and says so once. Any other remembered local name, such as `local/experiments`, is a custom room and is kept. So is a local room chosen with 0.17.0-rc7 or later, whatever its shape. 0.16's branch notices (`you switched to <branch>; the room is for <branch>; …`) are not copied into the new room, and any already copied are never delivered.

Update a lead and all its workers together. A mixed-version lead and worker may fail admission or miss addressed messages. Finish, collect or stop old workers before starting new ones; workers that were already collected or discarded cannot resume.

For any setup problem, ask **“is Room set up right?”** or run `room-doctor` from the installed plugin's `bin/` folder (paths in [the quickstart](../README.md#start-in-five-minutes)). See [the reference](reference.md#updating-plugins) for cache locations, sharing and diagnostics.

### 0.17.7 team destinations

Room no longer supplies a default public server. Existing explicit server URLs remain remembered. Old `team`/`hosted` choices with no actual URL start locally; say “join the room at wss://your-server.example” to select a server. An explicit team join without a configured URL asks for one and makes no network request. See [self-hosting](../deploy/self-hosting.md). Operators can restrict repository registration with `ROOM_MANAGED_REPOS=true` and `ROOM_ADMINS`; existing rooms remain approved and collaborators keep their usual admission rules. Restart after changing it.
