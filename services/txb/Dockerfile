# Tx Builder image (public tier, spec 3.6): builds unsigned transactions, never holds a key. Build from the repo root:
#   docker build -f services/txb/Dockerfile -t meridian-txb .
FROM node:24-slim AS build
WORKDIR /repo/services/txb
COPY services/txb/package.json services/txb/package-lock.json ./
RUN npm ci
COPY services/shared /repo/services/shared
COPY services/txb/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo/services/txb /repo/services/txb
COPY programs/meridian/idl/meridian.json /repo/programs/meridian/idl/meridian.json
USER node
WORKDIR /repo/services/txb
CMD ["node", "dist/txb/src/main.js"]
