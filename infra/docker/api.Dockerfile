# Canonical API Dockerfile used by CI. apps/api/Dockerfile is a working copy.
# This file is referenced from .github/workflows/ci.yaml.
#
# Build context: repo root.
#   docker build -f infra/docker/api.Dockerfile -t apex-api .

# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/shared-config/package.json packages/shared-config/
COPY packages/shared-errors/package.json packages/shared-errors/
COPY packages/shared-events/package.json packages/shared-events/
COPY packages/shared-logger/package.json packages/shared-logger/
COPY packages/shared-types/package.json packages/shared-types/
COPY packages/queue/package.json packages/queue/
COPY packages/realtime/package.json packages/realtime/
COPY packages/crypto/package.json packages/crypto/
COPY packages/vault-client/package.json packages/vault-client/
COPY tools/lint-rules/package.json tools/lint-rules/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/api/ apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @apex/db prisma:generate && \
    pnpm --filter @apex/api... build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=build /repo/apps/api/dist                       /app/apps/api/dist
COPY --from=build /repo/apps/api/package.json               /app/apps/api/
COPY --from=build /repo/packages                            /app/packages
COPY --from=build /repo/node_modules                        /app/node_modules
COPY --from=build /repo/package.json /repo/pnpm-workspace.yaml /app/

RUN useradd --system --uid 10001 --no-create-home apex && chown -R apex:apex /app
USER apex

EXPOSE 3000
ENV PORT=3000 HOST=0.0.0.0
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
