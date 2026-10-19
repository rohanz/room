# Self-hosting the room server

Team rooms are self-hosted; Room has no default public server. One container, one volume. Login with a GitHub OAuth App, with your company identity provider (OIDC), or both. This page is the whole runbook: [quick start](#quick-start), [settings](#settings), [login](#github-login-oauth-app), [reverse proxy](#reverse-proxy), [backup](#backup) and [upgrading](#upgrading). The limits the server applies on its own are listed at the end under [advanced limits](#advanced-limits).

The separate [Fly runbook](DEPLOYING.md) and `deploy/fly.toml` describe Rohan's existing deployment. They are not required for this setup. Upgrading from Room 0.16 has its own [upgrade guide](../docs/upgrading.md).

## Prerequisites

- A host with Docker (Compose v2) and a DNS name, e.g. `room.example.com`.
- A reverse proxy terminating TLS (Caddy, nginx, Traefik, a cloud load balancer). Rooms are websockets, so the proxy must forward `Upgrade` (see [reverse proxy](#reverse-proxy)).
- Node 22 is only needed if you run [without Docker](#running-without-docker).

## Quick start

The server image is published as `ghcr.io/rohanz/room:<version>` for every release, with `latest` following the newest one. You need two files from the repository, not a checkout:

```sh
mkdir room && cd room
curl -fsSLO https://raw.githubusercontent.com/rohanz/room/main/deploy/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/rohanz/room/main/deploy/.env.example -o .env
# edit .env: PUBLIC_URL and one login provider (GitHub OAuth App or OIDC)
docker compose up -d
curl https://room.example.com/health           # {"ok":true,"schema":2,"hub":1}
curl https://room.example.com/auth/config      # {"github":"device","providers":["github","oidc"],...}
```

Pin a release with `ROOM_IMAGE_TAG=0.17.18` in `.env`. To build the image from source instead, clone the repository and add the build override:

```sh
git clone https://github.com/rohanz/room.git && cd room
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml up -d --build
```

Clients say “join the room at wss://room.example.com”. The agent logs in to that server and asks before opening the repository with `room_create`; teammates use the same URL. The destination is remembered per clone. Alternatively launch with `ROOM_SERVER=wss://room.example.com`; Codex requires `codex --no-daemon` for shell environment variables to reach the plugin. Explicit tool URLs also work with the shared daemon.

## Operator-approved repositories

For a personal or demo server, set `ROOM_ADMINS=your-github-login` and `ROOM_MANAGED_REPOS=true` in `.env`, then recreate the container. As that account, log in and open each repository with `room_create`. You still need GitHub push access to open a GitHub repo. Its collaborators can then log in and join using their own GitHub accounts and push access; they cannot open unrelated rooms or close yours. Ask your agent to list open rooms to review the hosting list. Closing a room removes it for everyone, so close only repositories you intend to retire.

This controls repository registration, not who can visit the login page. Existing rooms stay approved. Browser view links remain bearer capabilities: anyone you give a link to can read that room until the key expires or the room closes. Non-GitHub rooms retain their configured token/OIDC admission rules; they do not infer GitHub collaborators.

## Settings

Everything is optional. Without any login provider or token the server is open (fine on a laptop, not on the internet). These are the settings most servers set; the many resource limits with sensible defaults are under [advanced limits](#advanced-limits).

| Setting | Meaning | Default |
| --- | --- | --- |
| `PUBLIC_URL` | External https URL of this server. Required for OIDC: the redirect URI is `<PUBLIC_URL>/auth/callback`. | — |
| `GITHUB_CLIENT_ID` | OAuth App client id: enables GitHub device-flow login, the only way into `github.com/...` rooms (accounts with push access). Without it those rooms are refused. The value `fake` is a test issuer for local development (refused with `NODE_ENV=production`): any `fakeLogin` posted to `/auth/poll` becomes a session. | — |
| `OIDC_ISSUER` | OIDC issuer URL; discovery is read from `<issuer>/.well-known/openid-configuration`. Enables OIDC login. | — |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The OIDC client registered at the issuer. Required with `OIDC_ISSUER`. | — |
| `OIDC_ALLOWED_DOMAINS` | Comma list of email domains allowed to log in (`example.com,example.org`). Empty: anyone the issuer authenticates. | any |
| `ROOM_ADMINS` | Comma list of identities allowed to read `GET /audit` and `GET /admin/inventory`, call confirmed `POST /admin/purge`, and manage repos when `ROOM_MANAGED_REPOS=true`: a GitHub login for GitHub sessions, `oidc:<issuer-host>:<sub>` for OIDC sessions. An OIDC display name or email never matches. | nobody |
| `ROOM_MANAGED_REPOS` | `true` lets only identities in `ROOM_ADMINS` open or close repository rooms. Existing rooms remain open; collaborators still need normal room admission. With no admins configured, nobody can open or close rooms. Restart after changes. | off |
| `ROOM_TOKEN` | Shared secret sent as `X-Room-Token: <value>` on HTTP and websocket upgrades; admits non-GitHub rooms (`local/...`, `git/...`). It never admits a `github.com/...` room. | — |
| `ROOM_TRUST_PROXY` | Set to `true` only when a reverse proxy fronts every request. Rate limits and per-address budgets then key on `Fly-Client-IP`, else the last `X-Forwarded-For` entry; without it they key on the socket address, which behind a proxy is the proxy for everyone. | off |
| `ROOM_SHARE_MAX` | Ceiling on what clients may share into a room: `intent`, `declared` or `full`. | `full` |
| `ROOM_IDLE_DAYS` | Repos nobody connected to for this many days are closed and their shared work deleted. `0` disables. | `30` |
| `DATABASE_URL` | Postgres connection string. Moves the repo registry, sessions and audit log into three tables (`room_repos`, `room_sessions`, `room_audit`, created on start). Documents stay in LevelDB. | — |
| `YPERSISTENCE` | Directory for room documents (LevelDB) plus `rooms.json`, `sessions.json`, `view-tokens.json` and `audit.log`. Unset: everything is in memory and lost on restart. | — (image: `/data`) |
| `PORT`, `HOST` | Listen address. | `1234`, `0.0.0.0` (image: `8080`) |
| `ROOM_STATIC` | Directory with the built browser view. | `./public` |

Which rooms a login can enter:

| Room name | Who is admitted |
| --- | --- |
| `github.com/<owner>/<repo>` | A GitHub device-flow login with push access to the repo. Nothing else: `ROOM_TOKEN` is refused, a GitHub token forwarded by a client is refused (401 pointing at `room_login`), and OIDC logins are refused because the server cannot check GitHub permissions for them. |
| `git/<host>/<path>` (self-hosted GitLab, Gitea, Bitbucket, ...) | A client presenting the configured `ROOM_TOKEN` is admitted, including when a login provider is configured. Without a matching token, a configured provider requires a valid login (GitHub or OIDC). With no provider, the token is required when set; with neither, the room is open. |
| `local/<name>` (filesystem remotes, explicit names) | Same as `git/`. |

One room per repository: the name has no branch. Any other name (a bare `github.com`, `github.com/<owner>`, an unknown namespace, an `archive:` key) is refused with 400 before admission.

## GitHub login (OAuth App)

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
   Homepage URL: your `PUBLIC_URL`. Authorization callback URL: anything (the device flow does
   not use it, but the form requires one).
2. Tick **Enable Device Flow**. No client secret is needed.
3. Set `GITHUB_CLIENT_ID` to the app's client id.
4. Clients run `room_login` (or `room_login provider=github`): they show a one-time code, the
   user enters it at github.com/login/device. The server keeps the GitHub token; clients hold
   only an opaque session id.

For GitHub Enterprise Server rooms use the `git/<host>/...` scheme (the origin is normalised to
that automatically for any non-github.com host) together with OIDC or `ROOM_TOKEN`.

## OIDC login

The server runs the authorization-code flow with PKCE and a confidential client. Register a
**web application** at your identity provider with:

- Sign-in redirect URI: `https://room.example.com/auth/callback` (your `PUBLIC_URL` + `/auth/callback`)
- Grant type: authorization code. Scopes: `openid email profile`.

Then set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `PUBLIC_URL` and usually
`OIDC_ALLOWED_DOMAINS`. The login name is the token's `email` (lower-cased), else
`preferred_username`, else `sub`.

**Okta:** Applications → Create App Integration → OIDC, Web Application. Copy Client ID and
Client secret. Issuer is `https://<org>.okta.com` (or your custom authorization server,
`https://<org>.okta.com/oauth2/default`). Assign the app to the users or groups who may use rooms.

**Google Workspace:** Google Cloud console → APIs & Services → Credentials → Create OAuth
client ID → Web application; add the redirect URI. Issuer is `https://accounts.google.com`.
Set `OIDC_ALLOWED_DOMAINS` to your Workspace domain: Google will authenticate any Google
account otherwise.

Keycloak, Entra ID (`https://login.microsoftonline.com/<tenant>/v2.0`), Auth0 and Dex work the
same way: any issuer with a discovery document and RS256-signed ID tokens.

Clients run `room_login provider=oidc` (or plain `room_login` on a server whose only provider
is OIDC): the agent prints a URL, the user opens it, signs in, and lands on a "Logged in as
..." page on the room server. The agent's next `room_login` call picks the session up.

## Reverse proxy

The proxy must pass websocket upgrades and keep idle connections alive (rooms hold a socket
open for hours). `PUBLIC_URL` must be the URL users reach through the proxy, and `ROOM_TRUST_PROXY=true` makes rate limits count real client addresses.

Caddy (does everything by default):

```
room.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx:

```
location / {
    proxy_pass         http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   Host $host;
    proxy_read_timeout 1h;
}
```

## Audit log

Every login, logout, room opened/closed, websocket accepted (`join`: login + room) and refused
(`refused`: reason) is appended as one JSON line to `<YPERSISTENCE>/audit.log` (or the
`room_audit` table). Admins listed in `ROOM_ADMINS` read it over HTTP with their own session:

```sh
curl -H "Authorization: Bearer <session id>" "https://room.example.com/audit?since=$(($(date +%s%3N) - 86400000))"
```

The session id is in `~/.config/room/credentials.json` on a machine that ran `room_login`.

`GET /admin/inventory` lists stored room documents with their sizes for the same admins; an unlisted caller receives `403`. `scripts/room-inventory.mts` in a checkout is the offline alternative over a stopped server's `YPERSISTENCE` directory. Both matter mostly for the [0.16 upgrade](../docs/upgrading.md).

## Backup

Everything is on the `room_data` volume (`/data` in the container): LevelDB room documents,
`rooms.json`, `sessions.json` (0600, holds GitHub tokens: treat the backup as secret),
`view-tokens.json`, `audit.log`.

```sh
docker compose stop room
docker run --rm -v room_room_data:/data -v "$PWD":/backup alpine tar czf /backup/room-data.tgz -C /data .
# If DATABASE_URL is configured, run while the container is still stopped:
pg_dump "$DATABASE_URL" --format=custom --file=room-registry.dump
docker compose start room
```

The volume name is `<project>_room_data`; `docker volume ls` shows it (`room_room_data` for a project directory named `room`, `deploy_room_data` when run from a checkout's `deploy/`). With `DATABASE_URL`, keep `room-registry.dump` beside the volume archive; the volume then holds only the documents. Restore that dump with `pg_restore --clean --if-exists --dbname="$DATABASE_URL" room-registry.dump` while the server is stopped. Stopping the container first keeps LevelDB consistent; a hot copy usually works but is not guaranteed.

## Upgrading

```sh
docker compose pull room
docker compose up -d room
```

With the build override, `git pull` then add `-f deploy/docker-compose.build.yml --build`. Clients update the plugin on their own schedule unless a release says otherwise; the `docker compose` healthcheck hits `/health`. Moving a server from Room 0.16 is a one-way data migration: follow [the upgrade guide](../docs/upgrading.md) and take its snapshot first.

## Running without Docker

The image runs the same server as compiled JavaScript. From a checkout, build it once per upgrade and run it under systemd with the same environment:

```sh
npm ci
npm run build:server && npm run build -w @room/web
ROOM_STATIC=packages/web/dist MALLOC_ARENA_MAX=2 YPERSISTENCE=/var/lib/room PORT=8080 npm run server
```

`npm run server:dev` runs the source. `MALLOC_ARENA_MAX=2` matters: glibc's per-thread malloc arenas fragment under native addons' threadpool I/O, LevelDB included, and keep freed memory resident. The image sets it already.

## Advanced limits

Resource limits with defaults that suit a small team. Change them only for a reason you have measured.

| Setting | Meaning | Default |
| --- | --- | --- |
| `ROOM_MAX_ROOMS` | Open repositories this server holds; opening another is refused with 503. | `100` |
| `ROOM_MAX_CONNECTIONS`, `ROOM_MAX_CONNECTIONS_PER_ROOM`, `ROOM_MAX_CONNECTIONS_PER_PRINCIPAL` | Live websockets overall, per room, and per principal: a login, or for browser views each view key (different view keys have separate allowances; the overall and per-room limits still apply). Every session, worker and browser view is one connection. | `4000`, `200`, `100` |
| `ROOM_DOC_MAX_MB` | Live room document cap: once a room is over it, writers are closed with 4413 and reads continue. | `64` |
| `ROOM_MAX_MESSAGE_MB` | Largest websocket message accepted. | `16` |
| `ROOM_LOAD_MAX_MB` | Stored-byte ceiling per document when loading it cold during the 0.16 migration. Other cold loads and joins use the larger of this and twice `ROOM_DOC_MAX_MB`. | `32` |
| `ROOM_COMPACT_MIN_DELETED` | Deleted Yjs structs a stored room needs before its first load after a server start rebuilds it from its values (a new document generation; clients rejoin with a fresh copy). `0` or `off` disables. | `10000` |
| `ROOM_MAX_QUEUED_MB`, `ROOM_MAX_TOTAL_QUEUED_MB` | Bytes that may wait unsent for one websocket (default: the document cap plus 4) and for all of them. A consumer already behind is disconnected with 1013 and reconnects. The total is checked before every send: the largest queues are dropped first, and when nothing more can be dropped the new message's socket is asked to retry (1013). | `68`, `256` |
| `ROOM_AWARENESS_MESSAGES_PER_MINUTE`, `ROOM_AWARENESS_IDS_PER_ROOM` | Presence messages per connection a minute and IDs per room. The fixed limits are 64 KiB per message, 16 KiB per state and 16 IDs per connection. | `6000`, `4096` |
| `ROOM_VIEW_TTL_MS`, `ROOM_VIEW_MAX_PER_ROOM`, `ROOM_VIEW_MAX_TOTAL` | Browser view-key lifetime, keys per room and keys on the server. The fixed limits are 5 keys per login and room, and 20 issued per login an hour. Asking again returns the key you already hold while more than half its life remains. | 7 days, `200`, `10000` |
| `ROOM_MAX_PENDING_LOGINS` | Login attempts awaiting completion. | `1000` |
| `ROOM_MAX_PENDING_ADMISSIONS`, `ROOM_MAX_PENDING_PER_ADDRESS` | Websocket upgrades still being admitted (permission check, document load), overall and per address; more are answered 429 and clients retry. | `256`, `16` |
| `ROOM_MAX_BODY_READS` | Concurrent HTTP body reads; past the limit the server answers 503. Bodies are fixed at 64 KiB while streaming (413), with a fixed 10 s read deadline (408). `POST /github/pr-note` accepts up to 4 MiB with a live session. | `32` |
| `ROOM_MAX_HTTP_RESPONSES`, `ROOM_MAX_ROOM_LISTS`, `ROOM_ARCHIVE_LIST_MAX_KEYS` | Responses built from room or registry state (`/rooms`, `/archive`, `/audit`) in flight overall, room listings in flight, and unresolved names returned by an archive listing (with `unresolvedTotal` and `truncated`). Each response reserves its bytes; per identity the response limit is fixed at 4 and the deadline at 120 s. Room listings are fixed at one at a time and 10 a minute per identity. Definite GitHub denials are cached for a fixed 60 s. | `32`, `8`, `1000` |
| `ROOM_MAX_PR_OPERATIONS` | GitHub pull-request proxy calls in flight overall. The fixed limits per identity are 2 notes in flight, 4 lists in flight and 30 operations a minute; past them the server answers 429. A disconnect aborts the GitHub call; identical list requests share one. | `8` |
| `ROOM_MAX_EXPORTS` | Archive exports and listings in flight on the server; per identity the limit is fixed at 1. A slot is held until the load has finished. The export deadline is fixed at 120 s and streaming chunks at 64 KiB; an export's bytes are reserved against the same output budget as websockets before it is loaded. The exporting agent's own frame ceiling is `ROOM_EXPORT_MAX_FRAME_MB` (default 64). | `2` |
| `ROOM_REVALIDATE_MINUTES` | Recheck each live GitHub session's push access, bypassing the positive cache. `0` disables periodic checks; logout and expiry still close sockets. | `10` |
| `ROOM_IDENTITY_GUARD` | Member identity-guard mode. Only literal `enforce` blocks objected document packets; every other value observes them, rate-limits logs and `identity_violation` audits to once per login per minute, and applies the packet unchanged. `enforce` is experimental and can desynchronise a client's causal stream. Read-only viewer document and awareness writes remain blocked in either mode. | observe-only |
| `ROOM_LEGACY_DAYS`, `ROOM_MIGRATION_*` | Budgets of the 0.16 cutover; see [the upgrade guide](../docs/upgrading.md#server-settings-for-the-cutover). | |

Fixed limits with no setting. Per address and minute: 10 login starts, 120 login polls, 30 OIDC callbacks, 600 websocket
upgrade attempts, 60 browser tickets, 30 failed admissions; past a limit the server answers 429 with `Retry-After`. A device-flow poll
earlier than GitHub's interval is answered `pending` without calling GitHub. A browser websocket ticket, exchanged from a session or view key, lasts 60 s and is used once. Per room, the hub allows 512 live name
leases (64 per login), keeps at most 1,024 ended names, accepts hub frames up to 96 KiB with holder fields up to 512
characters, and takes 250 posts a second per lease, 500 per login and 1,000 per room; past those it answers
`room-full` or `rate-limited` and clients retry. Hub frames are measured before they are parsed, and one connection may send 500 hub frames a second. One connection may ask for the room's state 10 times a minute. A room whose document cannot be written to disk refuses new
coordination writes (`unavailable`, websocket close 4507, `"storage":"failing"` in `/health`) and retries the full
state with backoff until the disk accepts it; at most 16 rooms may be in that state before further writes are refused.

The hub keeps its leases in its own files (`<YPERSISTENCE>/hub/leases/`, one per room, removed when the room is closed): after a restart it resumes only those, never a holder record found in a room document. Hub leases, quotas and rate limits are keyed by the login's provider-qualified identity
(`github:<login>`, `oidc:<issuer-host>:<sub>`), so two OIDC users who share a display name are different principals.

**Local path boundary.** Room reads and collects paths inside the user's checkout and Room worktrees, which only the user's own processes write. Each operation captures its canonical roots once, and a root that has become a symlink is refused. A directory swap racing between a check and its use is not closed because Node's fs has no openat/O_NOFOLLOW directory-relative operations. A process able to swap those directories already has the user's write access.

**Memory.** The server reads no stored documents at startup. Each load is size-checked first, and
`GET /admin/inventory` (for `ROOM_ADMINS`) sizes documents on request from LevelDB table metadata
alone: `bytes` is the size of the SST files overlapping the document and `updates: 0` means
uncounted. A document is flagged `possibly over` when those bytes × 24 (above snappy's best
compression ratio, about 21×) plus memtable slack could exceed the load budget, or when metadata is
missing; the estimate never calls an oversized document safe. `scripts/room-inventory.mts` is the
exact pre-flight over a stopped server's directory. To compare idle memory on synthetic persisted data, run `npx tsx scripts/measure-idle-rss.mts --mb 60`
(add `--cmd 'node --import tsx packages/server/src/index.ts'` for the source runtime); it prints the
server's RSS after startup and 60 seconds idle.
