# Operating Rohan’s Fly server

This is the maintainer-specific runbook for the existing `room-rohanz` deployment. For your own server, follow [self-hosting](self-hosting.md). The checked-in `fly.toml` contains this deployment’s app name and operator settings; it is not a ready-to-use configuration for another account.

The operator’s Room server is the Fly app `room-rohanz` (https://room-rohanz.fly.dev, region `sin`).
Room clients no longer default to this server. `deploy/fly.toml` sets `ROOM_MANAGED_REPOS=true` and `ROOM_ADMINS=rohanz`: only Rohan can open or close repository rooms. Existing open rooms remain available to their GitHub collaborators with push access. Review the registered rooms before enabling this on a previously public server. Browser view links remain shareable bearer capabilities.

Anyone with `flyctl` access to the app can do everything below. Nothing here needs SSH.

## What needs a deploy, and what does not

| Change in | Needs |
|---|---|
| `packages/server/**`, `Dockerfile`, `deploy/fly.toml` | server deploy (below) |
| `packages/web/**` | server deploy (the server serves the built view) AND plugin rebuild (the plugin ships a copy) |
| `packages/shared`, `packages/hub-core` | server deploy (the server bundles both) AND plugin rebuild |
| `packages/room-mcp`, `packages/roomd`, `packages/relay`, `plugins/room/**` | `npm run build:plugin`, commit the bundle, push; users reinstall the plugin |
| docs only | push |

## Deploy

```sh
cd <repo root>
flyctl deploy --config deploy/fly.toml --dockerfile Dockerfile --depot=false
flyctl releases -a room-rohanz | head -3
curl -s https://room-rohanz.fly.dev/health     # {"ok":true,"schema":2,"hub":1}
curl -s https://room-rohanz.fly.dev/auth/config  # {"github":"device","clientIdSet":true,...}
```

Each release is also published as `ghcr.io/rohanz/room:<version>` by the publish-image workflow; `flyctl deploy --config deploy/fly.toml --image ghcr.io/rohanz/room:<version>` deploys that exact image without a remote build, once the tag's workflow run has finished.

`--depot=false` uses Fly's classic remote builder. The default Depot builder has timed out from
this region before (Fly status page: "Depot builder failures"); the classic one has not. Use the remote builder for production; the local Docker engine can run isolated self-hosting checks.

A deploy restarts the machine; expect one `502` for up to a minute, then `200` in under 100 ms.
Watch it: `for i in 1 2 3; do sleep 30; curl -s -o /dev/null -w "%{http_code}\n" https://room-rohanz.fly.dev/health; done`.

## 0.17 cutover

The stopped-machine snapshot, inventory pre-flight and restored-volume rollback for the 0.16 to 0.17 cutover are in [the upgrade guide](../docs/upgrading.md#hosted-fly-deployment). Nobody is known to run a 0.16 server any more; the procedure is kept for the record.

After a server deploy that also changed the plugin bundle, refresh the local installs so tests
run against the shipped code:

```sh
claude plugin marketplace update room && claude plugin update room@room --scope user
codex plugin marketplace upgrade room && codex plugin add room@room
```

Codex's marketplace upgrade command applies to Git marketplaces. For a local-directory
marketplace, update the source checkout and run `codex plugin add room@room` directly.
These update commands were verified with Codex 0.160.0 and Claude Code 2.1.289 on
2026-10-04. Finish active worker batches before updating, then restart the host app/sessions:
an already-running session can retain an old versioned hook path after the installer
removes that cache directory, producing repeated hook failures. Do not work around that
by disabling hooks or changing trust. In a fresh session, `room_state(check=true)` verifies
installed versions, hook trust and whether its running bundle matches the installation.

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
