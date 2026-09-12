# Room server: stock y-websocket + token + LevelDB persistence. Build from the repo root:
#   docker build -f deploy/Dockerfile -t room-server .
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @room/server --include-workspace-root=false 2>/dev/null || npm ci --omit=dev
COPY packages/server/src packages/server/src
ENV PORT=8080 HOST=0.0.0.0 YPERSISTENCE=/data
VOLUME ["/data"]
EXPOSE 8080
CMD ["npx", "tsx", "packages/server/src/index.ts"]
