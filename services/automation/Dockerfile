# Automation service image (ops tier, spec 3.4). Build from the repo root:
#   docker build -f services/automation/Dockerfile -t meridian-automation .
# Keys are mounted at runtime (never baked in); only payer, market_creator and settler.
FROM node:22-slim AS build
WORKDIR /repo/services/automation
COPY services/automation/package.json services/automation/package-lock.json ./
RUN npm ci
COPY services/automation/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /repo
COPY --from=build /repo/services/automation /repo/services/automation
COPY programs/meridian/idl/meridian.json /repo/programs/meridian/idl/meridian.json
COPY db/migrations /repo/db/migrations
USER node
WORKDIR /repo/services/automation
CMD ["node", "dist/src/main.js"]
