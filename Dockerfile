# Room server (y-websocket + GitHub/OIDC login + LevelDB persistence + optional Postgres store).
#   docker build -t room-server .    or    docker compose -f deploy/docker-compose.yml up -d
# See deploy/self-hosting.md.
FROM node:22-slim
WORKDIR /app
COPY packages/server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm install --no-audit --no-fund tsx@4
COPY packages/server/src ./src
# Built browser view (run `npm run build -w @room/web` before building the image).
COPY packages/web/dist ./public
# production refuses the test login issuer; a local demo overrides it with -e NODE_ENV=development
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
