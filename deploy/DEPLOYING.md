# Operating the hosted server

The hosted Room server is the Fly app `room-rohanz` (https://room-rohanz.fly.dev, region `sin`).
Anyone with `flyctl` access to the app can do everything below. Nothing here needs SSH.

## What needs a deploy, and what does not

| Change in | Needs |
|---|---|
| `packages/server/**`, `Dockerfile`, `deploy/fly.toml` | server deploy (below) |
| `packages/web/**` | server deploy (the server serves the built view) AND plugin rebuild (the plugin ships a copy) |
| `packages/room-mcp`, `packages/roomd`, `packages/shared`, `plugins/room/**` | `npm run build:plugin`, commit the bundle, push; users reinstall the plugin |
| docs only | push |

## Deploy

For the **0.17 cutover**, step 0 is the [pre-upgrade snapshot](#017-cutover-snapshot-and-rollback) below. Do not deploy until its new snapshot ID is listed, and keep the matching Postgres dump if `DATABASE_URL` is configured.

```sh
cd <repo root>
npm run build -w @room/web            # the image copies packages/web/dist
flyctl deploy --config deploy/fly.toml --dockerfile Dockerfile --depot=false
flyctl releases -a room-rohanz | head -3
curl -s https://room-rohanz.fly.dev/health     # {"ok":true}
curl -s https://room-rohanz.fly.dev/auth/config  # {"github":"device","clientIdSet":true,...}
```

`--depot=false` uses Fly's classic remote builder. The default Depot builder has timed out from
this region before (Fly status page: "Depot builder failures"); the classic one has not. There is
no local Docker on the usual dev machine, so `--local-only` is not an option.

A deploy restarts the machine; expect one `502` for up to a minute, then `200` in under 100 ms.
Watch it: `for i in 1 2 3; do sleep 30; curl -s -o /dev/null -w "%{http_code}\n" https://room-rohanz.fly.dev/health; done`.

## 0.17 cutover snapshot and rollback

This procedure is documented and will be rehearsed on staging separately; it has **not yet been exercised**. Commands follow Fly's [volume snapshot](https://docs.fly.io/volumes/snapshots/) and [volume management](https://docs.fly.io/volumes/volume-manage/) documentation as fetched on 2026-09-30. Fly keeps snapshots for **5 days by default** (configurable from 1 to 60 days). Roll back within that window or raise retention before upgrading.

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

The script acquires the source `LOCK` through a hard link in a separate scratch database before copying, and holds it through inspection so a server starting mid-copy is refused. It copies LevelDB files to disposable scratch beside the source (needs free space equal to the database), leaving source files unchanged. `--scratch <new directory>` overrides its location; if another filesystem prevents the lock check, it warns and the operator must ensure the source server is stopped. `--json` emits structured output. Exit **0** is clean, **2** means flagged documents to review, **1** is an error. The [upgrade guide](../docs/upgrading.md) explains each kind and includes fixture output. Match the budget to `ROOM_LOAD_MAX_MB` (default 32 MB stored per document during migration); other cold loads and joins use the larger of that and twice `ROOM_DOC_MAX_MB` (default 128 MB), because the server compacts a live room's stored snapshots to within about 1.5 times its size. Sizing gates on native `leveldb.sstables` metadata before reading values, refusing any oversized table an iterator's initial seek or one-past-end read could touch; range estimates alone can hide a huge block. It then sums raw values with early exit. Memtable data is excluded and compression can undercount; reopening recovers old logs into SSTs. Table refusals report the table size, zero updates and `an oversized LevelDB table would be read`. Small documents sorting before an oversized level-0 table can be conservatively flagged until it is compacted. Adapters without table metadata fall back to the value scan.

The `tables over budget` section and JSON/admin `tables` list report each oversized table's level, file number, bytes and boundary document names; startup logs one line per table. Do not deploy onto that volume as-is: a level-0 final block may still be read when seeking a later document, and LevelDB compaction reads it too. Raise `ROOM_LOAD_MAX_MB` for the cutover on a larger VM; table flags produce exit 2.

Served GitHub keys have a literal `github.com/<owner>/<repo>` prefix (valid GitHub owner/repo, case-insensitive match): the bare name in any case, or `/` and any suffix, including an empty one and `%` escapes. Recorded `git/` and `local/` branches can also contain `%`. Encoded repository prefixes such as `github.com%2Fo%2Fr%2Fmain` were never served. Never-served/unregistered keys stay in place without loading; oversized served keys remain exportable archives, and served keys cannot be admin-purged. Exports use exact stored names from the registry's legacy list. Raw copies and exports ignore the websocket message cap; exports preflight the largest record and refuse **507 before headers** when it exceeds `ROOM_DOC_MAX_MB` or shared output reservations (`ROOM_MAX_TOTAL_QUEUED_MB`). Each record is read whole, so export and copy allocate up to the largest record, while the archive total can exceed the output budget. Failures after headers destroy the response. Check `migration quarantine:` logs and `GET /admin/inventory` after cutover; concurrent inventory requests share one scan and disconnected waiters release their response slots.

Deploy 0.17 using the command in [Deploy](#deploy), then update all clients together using [the upgrade guide](../docs/upgrading.md). A **0.16 server cannot safely serve a volume migrated by 0.17**. Putting the 0.16 image back on the migrated volume is not a rollback; legacy Markdown exports are not a rollback image.

**Rollback:** stop the 0.17 machine. Restore the pre-upgrade snapshot to a new `room_data` volume at least as large as the original (1 GB here), in `sin`. If `DATABASE_URL` was used, restore the matching pre-upgrade `pg_dump` while the server is stopped. Attach the restored volume at `/data` to a new machine, retire the old machine, then deploy the **0.16.40 image**. Alternatively, use Fly's scale command to create a machine and new volume from the snapshot. Reinstall 0.16.40 clients on Claude Code and Codex with the commands in [the upgrade guide](../docs/upgrading.md#roll-back-the-cutover), and restart their sessions. Check rooms and logins before destroying the old volume; destruction is permanent and has no undo.

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

After a server deploy that also changed the plugin bundle, refresh the local installs so tests
run against the shipped code:

```sh
claude plugin marketplace update room && claude plugin uninstall room@room && claude plugin install room@room --scope user
codex plugin remove room@room && codex plugin add room@room
```

## Configuration on the app

Secrets (`flyctl secrets list -a room-rohanz`):

- `GITHUB_CLIENT_ID` — the GitHub OAuth App (Device Flow enabled). Required: it is the only way
  into `github.com/…` rooms. Forwarded `gh` tokens are refused everywhere; without a client id
  nobody can join a GitHub room. `fake` is the test issuer and is refused under `NODE_ENV=production`.
- `ROOM_TOKEN` — unset on purpose. It only ever admits non-GitHub rooms (`local/…`, `git/…`).

Environment in `deploy/fly.toml`: `PORT=8080`, `YPERSISTENCE=/data` (volume `room_data`, 1 GB),
`ROOM_TRUST_PROXY=true`. The last one matters: Fly's proxy fronts every request, so without it the
per-address rate limits (login starts, websocket upgrades) would count every user as one address.
Any other Fly app running this image (staging) needs the same line.
Optional tuning, all with defaults in `.env.example`: `ROOM_IDLE_DAYS`, `ROOM_DOC_MAX_MB`,
`ROOM_LOAD_MAX_MB` (32 MB stored per migration document; other cold loads/joins use the larger of it and `ROOM_DOC_MAX_MB`), `ROOM_MAX_MESSAGE_MB`, `ROOM_SHARE_MAX`, `ROOM_ADMINS`, OIDC variables. The member identity guard
is observe-only unless `ROOM_IDENTITY_GUARD` is literally `enforce`: objected updates are applied
unchanged and their logs and `identity_violation` audits are limited to once per login per minute.
`enforce` is experimental because rejecting a causal update can desynchronise that client.
Read-only viewer document and awareness writes remain blocked in either mode.

Machine: 1 shared CPU, **512 MB** (`flyctl scale memory 512`). 256 MB was OOM-killed under a
large room. `auto_stop_machines = "stop"`, `min_machines_running = 0`: the machine stops when
idle and the next request or websocket wakes it. Set `min_machines_running = 1` in
`deploy/fly.toml` and redeploy for always-on.

## Rooms and repos

There is one room per repository, and a repository must be *opened* once before anyone can join it. The registry, sessions and
view keys live on the volume next to the LevelDB documents. Use the server's own API for
lifecycle work; a session token is in `~/.config/room/credentials.json` after `room_login`.

```sh
SESSION=$(python3 -c "import json;print(json.load(open('$HOME/.config/room/credentials.json'))['wss://room-rohanz.fly.dev']['session'])")
# open (idempotent)
curl -s -X POST https://room-rohanz.fly.dev/rooms -H 'content-type: application/json' -H "Authorization: Bearer $SESSION" -d '{"room":"github.com/<owner>/<repo>","schema":2}'
# list what I can see
curl -s -H "Authorization: Bearer $SESSION" "https://room-rohanz.fly.dev/rooms"
# close a repo: deletes its room document and archived 0.16 branch rooms, drops connections, invalidates its view links
curl -s -X DELETE https://room-rohanz.fly.dev/rooms -H 'content-type: application/json' -H "Authorization: Bearer $SESSION" -d '{"room":"github.com/<owner>/<repo>","schema":2}'
```

Both calls need `"schema":2` and the repository name without a branch: a request without the schema is a 0.16
client's and is refused with the upgrade text, and a branch-qualified GitHub name is a 400.

Repos idle for `ROOM_IDLE_DAYS` (30) close themselves.

## Purging quarantined documents

Only identities in `ROOM_ADMINS` can read `GET /admin/inventory` or call `POST /admin/purge`, using their own Room session as with `GET /audit`. Use the verified GitHub login or the full OIDC identity (`oidc:<issuer-host>:<sub>`), not an OIDC display name or email.

```sh
curl -sS https://room-rohanz.fly.dev/admin/inventory -H 'Authorization: Bearer <admin session>'
# Only after exporting anything needed and reviewing the exact stored name:
curl -sS -X POST https://room-rohanz.fly.dev/admin/purge \
  -H 'Authorization: Bearer <admin session>' -H 'content-type: application/json' \
  -d '{"name":"github.com%2Frohanz%2Froom%2Fenterprise","confirm":"github.com%2Frohanz%2Froom%2Fenterprise"}'
```

Purging is an explicit destructive admin action, never automatic. The `confirm` field must equal `name` exactly. Only `never-served` or `unregistered` documents can be purged; being over budget alone does not make a served document eligible. Export any needed archives with `room_export` before deleting data, and retain the pre-upgrade snapshot for quarantined keys that have no exportable registry owner.

## Logs, status, incidents

```sh
flyctl status -a room-rohanz
flyctl logs -a room-rohanz --no-tail | grep -vE "proxy\[|refused 401" | tail -40
flyctl machine restart <machine id> -a room-rohanz
```

Known failure shape: health passes at start, then fails ~35 s later, every restart. That was a
room document too large to load (a client wrote big values into it) or a stale browser tab
pushing a huge copy back. Both are now bounded server-side (`ROOM_DOC_MAX_MB`,
`ROOM_MAX_MESSAGE_MB`). If it recurs: identify the room from the last log line before the
health failure, restart the machine, and within its first 30 s close that repo with the
`DELETE /rooms` call above. Then find what wrote the large values.

Do not edit files on the volume over SSH while the server runs; LevelDB holds them open.

## Rotating the OAuth App

Create a new OAuth App (Device Flow enabled), `flyctl secrets set GITHUB_CLIENT_ID=<id>`, deploy.
Existing sessions keep working (they are server-side); new logins use the new app.
