# syntax=docker/dockerfile:1
# Node service image (PROJECT.md §5.4, NFR-15): multi-stage, non-root, read-only root FS at runtime (writable /tmp only),
# no package manager or build tooling in the final stage. Build from the repo root:
#   docker build -f deploy/docker/node-service.Dockerfile --build-arg SERVICE=ingestion --build-arg GIT_SHA=$(git rev-parse --short HEAD) .
ARG NODE_IMAGE=node:24.22.3-alpine3.24

FROM ${NODE_IMAGE} AS build
ARG SERVICE
RUN test -n "${SERVICE}" && corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@aegispulse/${SERVICE}..." \
 && pnpm --filter "@aegispulse/${SERVICE}..." run build \
 && pnpm --filter "@aegispulse/${SERVICE}" deploy --prod --legacy /out
ARG GIT_SHA=dev
RUN printf '{"gitSha":"%s"}\n' "${GIT_SHA}" > /out/build-info.json

FROM ${NODE_IMAGE}
ARG MAX_OLD_SPACE_MB=288
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=${MAX_OLD_SPACE_MB}"
WORKDIR /app
COPY --from=build /out /app
USER node
ENTRYPOINT ["node", "--import", "@aegispulse/ts-platform/telemetry/register", "dist/main.js"]
