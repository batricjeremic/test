# Board API (BFF) and sync worker. One image, one process.
# The hub extension is packaged separately as a .vsix, not served from here.
#
# Build from the repository root:
#   docker build -f infra/Dockerfile -t eg-board-api .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Every workspace member's package.json must be present or --frozen-lockfile
# rejects the lockfile as out of date with the workspace, even for members the
# --filter excludes. apps/hub is copied for that reason alone; its dependencies
# are never installed.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/hub/package.json ./apps/hub/

FROM manifests AS deps
RUN pnpm install --frozen-lockfile \
    --filter @eg/board-api... --filter @eg/shared...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @eg/shared build && pnpm --filter @eg/board-api build

FROM manifests AS runtime
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod \
      --filter @eg/board-api... --filter @eg/shared... \
    && pnpm store prune
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/migrations ./apps/api/migrations

# Migrations are applied by the pipeline, never by this container on boot.
# There is no entrypoint script that could quietly start running them.
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]
