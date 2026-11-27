# REST API image (public tier, spec 3.5): stateless, horizontally scaled behind the load balancer. Build from the repo root:
#   docker build -f services/api/Dockerfile -t meridian-api .
FROM node:24-slim AS build
WORKDIR /repo/services/api
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci
COPY services/shared /repo/services/shared
COPY services/api/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo/services/api /repo/services/api
COPY programs/meridian/idl/meridian.json /repo/programs/meridian/idl/meridian.json
USER node
WORKDIR /repo/services/api
CMD ["node", "dist/api/src/main.js"]
