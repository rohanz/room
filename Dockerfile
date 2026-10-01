# Room server (GitHub/OIDC login, LevelDB persistence, optional Postgres store).
# docker build -t room-server .  or  docker compose -f deploy/docker-compose.yml up -d
# Build the browser view first: npm run build -w @room/web. See deploy/self-hosting.md.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hub-core/package.json packages/hub-core/
COPY packages/server/package.json packages/server/
COPY packages/roomd/package.json packages/roomd/
COPY packages/room-mcp/package.json packages/room-mcp/
COPY packages/relay/package.json packages/relay/
COPY packages/agent/package.json packages/agent/
COPY packages/web/package.json packages/web/
# The lockfile pins the root esbuild to 0.28.2; build tools stay in this stage.
RUN npm ci --include=dev --no-audit --no-fund
COPY tsconfig.base.json ./
COPY scripts/build-server.mjs scripts/
COPY packages/shared/src packages/shared/src
COPY packages/hub-core/src packages/hub-core/src
COPY packages/server/src packages/server/src
RUN npm run build:server

FROM node:22-slim AS runtime
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/hub-core/package.json packages/hub-core/
COPY --from=build /app/packages/server/package.json packages/server/
COPY --from=build /app/packages/roomd/package.json packages/roomd/
COPY --from=build /app/packages/room-mcp/package.json packages/room-mcp/
COPY --from=build /app/packages/relay/package.json packages/relay/
COPY --from=build /app/packages/agent/package.json packages/agent/
COPY --from=build /app/packages/web/package.json packages/web/
RUN npm ci --omit=dev --no-audit --no-fund -w @room/server
COPY --from=build /app/packages/server/dist packages/server/dist
# ROOM_STATIC defaults to ./public.
COPY packages/web/dist ./public
# glibc's per-thread malloc arenas fragment under native addons' threadpool I/O
# (such as LevelDB); freed allocations otherwise leave more memory resident.
ENV MALLOC_ARENA_MAX=2
# Production refuses the test issuer; a local demo overrides NODE_ENV=development.
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["node", "packages/server/dist/server.mjs"]
