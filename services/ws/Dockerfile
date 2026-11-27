# WebSocket gateway image (public tier, spec 3.7): fans the Redis read model out to clients. Build from the repo root:
#   docker build -f services/ws/Dockerfile -t meridian-ws .
FROM node:24-slim AS build
WORKDIR /repo/services/ws
COPY services/ws/package.json services/ws/package-lock.json ./
RUN npm ci
COPY services/shared /repo/services/shared
COPY services/ws/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo/services/ws /repo/services/ws
USER node
WORKDIR /repo/services/ws
CMD ["node", "dist/ws/src/main.js"]
