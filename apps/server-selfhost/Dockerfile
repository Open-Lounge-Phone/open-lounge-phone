# Build from the repository root:  docker build -f apps/server-selfhost/Dockerfile -t opentincan .
FROM node:22-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build -w @opentincan/device-web -w @opentincan/companion \
  && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=8787
WORKDIR /app
COPY --from=build /app /app
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server-selfhost/src/main.ts"]
