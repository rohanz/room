# Room server (y-websocket + GitHub/OIDC login + LevelDB persistence + optional Postgres store).
#   docker build -t room-server .    or    docker compose -f deploy/docker-compose.yml up -d
# See deploy/self-hosting.md.
FROM node:22-slim
WORKDIR /app
# The server runs each room's hub from the workspace packages @room/hub-core and @room/shared:
# install the three as a workspace (manifests first, for layer caching), then their sources.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hub-core/package.json packages/hub-core/
COPY packages/server/package.json packages/server/
COPY packages/roomd/package.json packages/roomd/
COPY packages/room-mcp/package.json packages/room-mcp/
COPY packages/relay/package.json packages/relay/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev --no-audit --no-fund -w @room/server
COPY packages/shared/src packages/shared/src
COPY packages/hub-core/src packages/hub-core/src
COPY packages/server/src packages/server/src
# Built browser view (run `npm run build -w @room/web` before building the image); ROOM_STATIC defaults to ./public.
COPY packages/web/dist ./public
# production refuses the test login issuer; a local demo overrides it with -e NODE_ENV=development
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["node_modules/.bin/tsx", "packages/server/src/index.ts"]
