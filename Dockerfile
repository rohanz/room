# Room server only (stock y-websocket + token + optional LevelDB persistence).
#   docker build -t room-server .    or    gcloud run deploy room --source .
FROM node:22-slim
WORKDIR /app
COPY packages/server/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm install --no-audit --no-fund tsx@4
COPY packages/server/src ./src
ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080
CMD ["npx", "tsx", "src/index.ts"]
