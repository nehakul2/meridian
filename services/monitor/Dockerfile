# Monitor image (ops tier, spec 3.4): alert rules over Postgres, Redis, RPC and the WS gateways. Build from the repo root:
#   docker build -f services/monitor/Dockerfile -t meridian-monitor .
FROM node:24-slim AS build
WORKDIR /repo/services/monitor
COPY services/monitor/package.json services/monitor/package-lock.json ./
RUN npm ci
COPY services/automation/src/time.ts /repo/services/automation/src/time.ts
COPY programs/meridian/idl/meridian.json /repo/programs/meridian/idl/meridian.json
COPY services/monitor/ ./
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /repo
COPY --from=build /repo/services/monitor /repo/services/monitor
COPY --from=build /repo/programs/meridian/idl/meridian.json /repo/programs/meridian/idl/meridian.json
USER node
WORKDIR /repo/services/monitor
CMD ["node", "dist/monitor/src/main.js"]
