# PG Writer image (private tier, spec 3.4). Build from the repo root:
#   docker build -f services/pg-writer/Dockerfile -t meridian-pg-writer .
FROM node:24-slim AS build
WORKDIR /repo/services/pg-writer
COPY services/pg-writer/package.json services/pg-writer/package-lock.json ./
RUN npm ci
COPY services/shared /repo/services/shared
COPY services/pg-writer/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo/services/pg-writer /repo/services/pg-writer
USER node
WORKDIR /repo/services/pg-writer
CMD ["node", "dist/pg-writer/src/main.js"]
