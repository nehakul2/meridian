# Indexer image (private tier, spec 3.4: one active + one hot standby). Build from the repo root:
#   docker build -f services/indexer/Dockerfile -t meridian-indexer .
FROM node:24-slim AS build
WORKDIR /repo/services/indexer
COPY services/indexer/package.json services/indexer/package-lock.json ./
RUN npm ci
COPY services/shared /repo/services/shared
COPY services/indexer/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo/services/indexer /repo/services/indexer
COPY programs/meridian/idl/meridian.json /repo/programs/meridian/idl/meridian.json
USER node
WORKDIR /repo/services/indexer
CMD ["node", "dist/indexer/src/main.js"]
