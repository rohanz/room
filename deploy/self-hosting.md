# Self-hosting the room server

One container, one volume. Login with a GitHub OAuth App, with your company identity provider
(OIDC), or both. This page is the whole runbook.

## Prerequisites

- A host with Docker (Compose v2) and a DNS name, e.g. `room.example.com`.
- A reverse proxy terminating TLS (Caddy, nginx, Traefik, a cloud load balancer). Rooms are
  websockets, so the proxy must forward `Upgrade` (see below).
- Node 22 is only needed if you run without Docker (`npm ci && npm run server`).

## Quick start

```sh
git clone https://github.com/rohanz/room.git && cd room
npm ci && npm run build -w @room/web          # the browser view baked into the image
cp deploy/.env.example deploy/.env             # fill in PUBLIC_URL and a login provider
docker compose -f deploy/docker-compose.yml up -d
curl https://room.example.com/health           # {"ok":true}
curl https://room.example.com/auth/config      # {"github":"device","providers":["github","oidc"],...}
```

Clients point at it with `ROOM_SERVER=wss://room.example.com`, run `room_login` once per
machine, then `room_create` once per repo.

## Environment

Every variable the server reads. All are optional; without any login provider or token the
server is open (fine on a laptop, not on the internet).

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT`, `HOST` | Listen address. | `1234`, `0.0.0.0` (image: `8080`) |
| `PUBLIC_URL` | External https URL of this server. Required for OIDC: the redirect URI is `<PUBLIC_URL>/auth/callback`. | — |
| `YPERSISTENCE` | Directory for room documents (LevelDB) plus `rooms.json`, `sessions.json`, `view-tokens.json` and `audit.log`. Unset: everything is in memory and lost on restart. | — (image: `/data`) |
| `DATABASE_URL` | Postgres connection string. Moves the repo registry, sessions and audit log into three tables (`room_repos`, `room_sessions`, `room_audit`, created on start). Documents stay in LevelDB. | — |
| `GITHUB_CLIENT_ID` | OAuth App client id: enables GitHub device-flow login, the only way into `github.com/...` rooms (accounts with push access). Without it those rooms are refused. The value `fake` is a test issuer for local development (refused with `NODE_ENV=production`): any `fakeLogin` posted to `/auth/poll` becomes a session. | — |
| `OIDC_ISSUER` | OIDC issuer URL; discovery is read from `<issuer>/.well-known/openid-configuration`. Enables OIDC login. | — |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The OIDC client registered at the issuer. Required with `OIDC_ISSUER`. | — |
| `OIDC_ALLOWED_DOMAINS` | Comma list of email domains allowed to log in (`example.com,example.org`). Empty: anyone the issuer authenticates. | any |
| `ROOM_ADMINS` | Comma list of identities allowed to read `GET /audit`: a GitHub login for GitHub sessions, `oidc:<issuer-host>:<sub>` for OIDC sessions. An OIDC display name or email never matches. | nobody |
| `ROOM_TRUST_PROXY` | Set to `true` only when a reverse proxy fronts every request. Rate limits and per-address budgets then key on `Fly-Client-IP`, else the last `X-Forwarded-For` entry; without it they key on the socket address, which behind a proxy is the proxy for everyone. | off |
| `ROOM_MAX_BODY_KB`, `ROOM_MAX_BODY_READS`, `ROOM_BODY_TIMEOUT_MS` | HTTP request bodies: size limit read while streaming (413), concurrent body reads (503), and read deadline (408). | `64`, `32`, `10000` |
| `ROOM_MAX_PR_NOTE_MB` | Body limit for `POST /github/pr-note`, applied only when the `Authorization` header is a live session. | `4` |
| `ROOM_MAX_ROOMS` | Open repositories this server holds; opening another is refused with 503. | `100` |
| `ROOM_MAX_CONNECTIONS`, `ROOM_MAX_CONNECTIONS_PER_ROOM`, `ROOM_MAX_CONNECTIONS_PER_PRINCIPAL` | Live websockets overall, per room, and per login (per address for view links). Every session, worker and browser view is one connection. | `4000`, `200`, `100` |
| `ROOM_MAX_PENDING_LOGINS` | Login attempts awaiting completion. | `1000` |
| `ROOM_MAX_PENDING_ADMISSIONS`, `ROOM_MAX_PENDING_PER_ADDRESS` | Websocket upgrades still being admitted (permission check, document load), overall and per address; more are answered 429 and clients retry. | `256`, `16` |
| `ROOM_MAX_QUEUED_MB`, `ROOM_MAX_TOTAL_QUEUED_MB` | Bytes that may wait unsent for one websocket (default: the document cap plus 4) and for all of them. A consumer already behind is disconnected with 1013 and reconnects. The total is checked before every send: the largest queues are dropped first, and when nothing more can be dropped the new message's socket is asked to retry (1013). | `68`, `256` |
| `ROOM_AWARENESS_MAX_MESSAGE_KB`, `ROOM_AWARENESS_MAX_STATE_KB`, `ROOM_AWARENESS_MESSAGES_PER_MINUTE`, `ROOM_AWARENESS_IDS_PER_CONNECTION`, `ROOM_AWARENESS_IDS_PER_ROOM` | Presence budgets per connection and per room. | `64`, `16`, `6000`, `16`, `4096` |
| `ROOM_VIEW_TTL_MS`, `ROOM_VIEW_MAX_PER_PRINCIPAL`, `ROOM_VIEW_MAX_PER_ROOM`, `ROOM_VIEW_MAX_TOTAL`, `ROOM_VIEW_ISSUE_PER_HOUR` | Browser view keys: lifetime, how many one login holds per room, per room, on the server, and how many one login may mint an hour. Asking again returns the key you already hold while more than half its life remains. | 7 days, `5`, `200`, `10000`, `20` |
| `ROOM_MIGRATION_MAX_SOURCES`, `ROOM_MIGRATION_MAX_READ_MB`, `ROOM_MIGRATION_MAX_RECORDS`, `ROOM_MIGRATION_MAX_RECORD_KB`, `ROOM_MIGRATION_MAX_REBUILDS` | Work budget of the 0.16 cutover, across all its phases: branch rooms considered, megabytes read, records processed, size of one record, and how many times the migrated room may be rebuilt to fit the document cap. The byte budget is a stopping threshold: LevelDB cannot report a document's size without reading it, so the cutover stops after the read that crosses it (one document of overshoot at most). What is not migrated stays in the archive, exportable. | `1000`, `128`, `100000`, `64`, `4` |
| `ROOM_MAX_EXPORTS`, `ROOM_MAX_EXPORTS_PER_PRINCIPAL`, `ROOM_EXPORT_DEADLINE_MS`, `ROOM_EXPORT_CHUNK_KB` | Archive exports and listings in flight on the server and per identity (a slot is held until the load has finished, whether or not the client is still there), how long one may take, and its streaming chunk size. An export's bytes are reserved against the same output budget as websockets before it is loaded. | `2`, `1`, `120000`, `64` |
| `ROOM_MAX_HTTP_RESPONSES`, `ROOM_MAX_HTTP_RESPONSES_PER_PRINCIPAL`, `ROOM_HTTP_RESPONSE_DEADLINE_MS`, `ROOM_MAX_ROOM_LISTS`, `ROOM_LISTS_PER_MINUTE`, `ROOM_ARCHIVE_LIST_MAX_KEYS`, `ROOM_GH_DENIAL_CACHE_MS` | Responses built from room or registry state (`/rooms`, `/archive`, `/audit`): in flight overall and per identity, each with its bytes reserved and a deadline; room listings in flight and per identity a minute (one at a time per identity); unresolved names returned by an archive listing (with `unresolvedTotal` and `truncated`); how long a definite GitHub denial is remembered (at most 60 s). | `32`, `4`, `120000`, `8`, `10`, `1000`, `60000` |
| `ROOM_MAX_PR_OPERATIONS`, `ROOM_MAX_PR_NOTES_PER_PRINCIPAL`, `ROOM_MAX_PR_LISTS_PER_PRINCIPAL`, `ROOM_PR_OPERATIONS_PER_MINUTE` | GitHub pull-request proxy calls in flight overall and per identity, and per identity a minute; past them the server answers 429. A disconnect aborts the GitHub call; identical list requests share one. | `8`, `2`, `4`, `30` |
| `ROOM_TOKEN` | Shared secret sent as `X-Room-Token: <value>` on HTTP and websocket upgrades; admits non-GitHub rooms (`local/...`, `git/...`). It never admits a `github.com/...` room. | — |
| `ROOM_REVALIDATE_MINUTES` | Recheck each live GitHub session's push access, bypassing the positive cache. `0` disables periodic checks; logout and expiry still close sockets. | `10` |
| `ROOM_WS_TICKET_TTL_MS` | Browser websocket ticket lifetime, clamped to 1–60,000 ms. Shorter values are useful in tests. | `60000` |
| `ROOM_SHARE_MAX` | Ceiling on what clients may share into a room: `intent`, `declared` or `full`. | `full` |
| `ROOM_IDENTITY_GUARD` | Member identity-guard mode. Only literal `enforce` blocks objected document packets; every other value observes them, rate-limits logs and `identity_violation` audits to once per login per minute, and applies the packet unchanged. `enforce` is experimental and can desynchronise a client's causal stream. Read-only viewer document and awareness writes remain blocked in either mode. | observe-only |
| `ROOM_IDLE_DAYS` | Repos nobody connected to for this many days are closed and their shared work deleted. `0` disables. | `30` |
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
open for hours). `PUBLIC_URL` must be the URL users reach through the proxy.

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

## Backup

Everything is on the `room_data` volume (`/data` in the container): LevelDB room documents,
`rooms.json`, `sessions.json` (0600, holds GitHub tokens: treat the backup as secret),
`view-tokens.json`, `audit.log`.

```sh
docker compose -f deploy/docker-compose.yml stop room
docker run --rm -v deploy_room_data:/data -v "$PWD":/backup alpine tar czf /backup/room-data.tgz -C /data .
# If DATABASE_URL is configured, run while the container is still stopped:
pg_dump "$DATABASE_URL" --format=custom --file=room-registry.dump
docker compose -f deploy/docker-compose.yml start room
```

With `DATABASE_URL`, keep `room-registry.dump` beside the volume archive; the volume then holds only the documents. Restore that dump with `pg_restore --clean --if-exists --dbname="$DATABASE_URL" room-registry.dump` while the server is stopped. Stopping the container first keeps LevelDB consistent; a hot copy usually works but is not guaranteed.

For a **0.16 → 0.17 cutover**, keep a pre-upgrade copy of the entire stopped-server volume and a matching `pg_dump` if `DATABASE_URL` is set. A 0.16 server cannot serve a volume that 0.17 has migrated. To roll back, stop 0.17, restore both pre-upgrade stores, run the 0.16.40 image, and reinstall 0.16.40 clients on both hosts as shown in [the upgrade guide](../docs/upgrading.md#roll-back-the-cutover). Legacy Markdown exports are not a rollback image.

## Upgrading

```sh
git pull
npm ci && npm run build -w @room/web
docker compose -f deploy/docker-compose.yml build room
docker compose -f deploy/docker-compose.yml up -d room
```

For the 0.17 cutover, take the stopped-server snapshot described above **before** these commands. Earlier session records load as GitHub sessions, and Postgres tables are created with `IF NOT EXISTS`; this does not make a migrated 0.17 volume backward-compatible with 0.16. Clients must update together as described in [the upgrade guide](../docs/upgrading.md). The `docker compose` healthcheck hits `/health`.

Running without Docker is the same server: `YPERSISTENCE=/var/lib/room PORT=8080 npm run server`
under systemd, with the same environment.

## Local path boundary

Room reads and collects paths inside the user's checkout and Room worktrees, which only the user's own processes write. Each operation captures its canonical roots once, and a root that has become a symlink is refused. A directory swap racing between a check and its use is not closed because Node's fs has no openat/O_NOFOLLOW directory-relative operations. A process able to swap those directories already has the user's write access.

## Limits the server applies on its own

These have no setting. Per address and minute: 10 login starts, 120 login polls, 30 OIDC callbacks, 600 websocket
upgrade attempts, 60 browser tickets, 30 failed admissions; past a limit the server answers 429 with `Retry-After`. A device-flow poll
earlier than GitHub's interval is answered `pending` without calling GitHub. Per room, the hub allows 512 live name
leases (64 per login), keeps at most 1,024 ended names, accepts hub frames up to 96 KiB with holder fields up to 512
characters, and takes 250 posts a second per lease, 500 per login and 1,000 per room; past those it answers
`room-full` or `rate-limited` and clients retry. Hub frames are measured before they are parsed, and one connection may send 500 hub frames a second. One connection may ask for the room's state 10 times a minute. A room whose document cannot be written to disk refuses new
coordination writes (`unavailable`, websocket close 4507, `"storage":"failing"` in `/health`) and retries the full
state with backoff until the disk accepts it; at most 16 rooms may be in that state before further writes are refused.

A 0.17 server creates nothing for a 0.16 client: repositories and branch rooms recorded by 0.16 stay usable by 0.16
clients until the first 0.17 client cuts the repository over, but a 0.16 client can no longer open a repository or
add a branch. The hub keeps its leases in its own files (`<YPERSISTENCE>/hub/leases/`, one per room, removed when the room is closed): after a restart it resumes only those, never a holder record found in a room document. Hub leases, quotas and rate limits are keyed by the login's provider-qualified identity
(`github:<login>`, `oidc:<issuer-host>:<sub>`), so two OIDC users who share a display name are different principals.
