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
| `ROOM_ADMINS` | Comma list of logins allowed to read `GET /audit`. | nobody |
| `ROOM_TOKEN` | Shared secret: `?token=<value>` admits non-GitHub rooms (`local/...`, `git/...`). It never admits a `github.com/...` room. | — |
| `ROOM_SHARE_MAX` | Ceiling on what clients may share into a room: `intent`, `declared` or `full`. | `full` |
| `ROOM_IDLE_DAYS` | Repos nobody connected to for this many days are closed and their shared work deleted. `0` disables. | `30` |
| `ROOM_STATIC` | Directory with the built browser view. | `./public` |

Which rooms a login can enter:

| Room name | Who is admitted |
| --- | --- |
| `github.com/<owner>/<repo>/<branch>` | A GitHub device-flow login with push access to the repo. Nothing else: `ROOM_TOKEN` is refused, a GitHub token forwarded by a client is refused (401 pointing at `room_login`), and OIDC logins are refused because the server cannot check GitHub permissions for them. |
| `git/<host>/<owner>/<repo>/<branch>` (self-hosted GitLab, Gitea, Bitbucket, ...) | A client presenting the configured `ROOM_TOKEN` is admitted, including when a login provider is configured. Without a matching token, a configured provider requires a valid login (GitHub or OIDC). With no provider, the token is required when set; with neither, the room is open. |
| `local/<dir>/<branch>` (filesystem remotes) | Same as `git/`. |

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
curl "https://room.example.com/audit?session=<session id>&since=$(($(date +%s%3N) - 86400000))"
```

The session id is in `~/.config/room/credentials.json` on a machine that ran `room_login`.

## Backup

Everything is on the `room_data` volume (`/data` in the container): LevelDB room documents,
`rooms.json`, `sessions.json` (0600, holds GitHub tokens: treat the backup as secret),
`view-tokens.json`, `audit.log`.

```sh
docker compose -f deploy/docker-compose.yml stop room
docker run --rm -v deploy_room_data:/data -v "$PWD":/backup alpine tar czf /backup/room-data.tgz -C /data .
docker compose -f deploy/docker-compose.yml start room
```

With `DATABASE_URL`, back up Postgres with `pg_dump` as usual; the volume then holds only the
documents. Stopping the container first keeps LevelDB consistent; a hot copy usually works but
is not guaranteed.

## Upgrading

```sh
git pull
npm ci && npm run build -w @room/web
docker compose -f deploy/docker-compose.yml build room
docker compose -f deploy/docker-compose.yml up -d room
```

State on the volume is forward-compatible: sessions written before OIDC support load as
GitHub sessions; Postgres tables are created with `IF NOT EXISTS`. Clients reconnect on their
own; rooms show a brief "disconnected" while the container restarts. The `docker compose`
healthcheck hits `/health`.

Running without Docker is the same server: `YPERSISTENCE=/var/lib/room PORT=8080 npm run server`
under systemd, with the same environment.
