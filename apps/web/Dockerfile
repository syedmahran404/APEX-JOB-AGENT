# apps/web Dockerfile (multi-stage). Final image serves the SPA via nginx.

# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile=false

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/web/ apps/web/
RUN pnpm --filter @apex/web build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
RUN { \
  echo 'server {'; \
  echo '  listen 8080;'; \
  echo '  root /usr/share/nginx/html;'; \
  echo '  index index.html;'; \
  echo '  add_header X-Frame-Options DENY always;'; \
  echo '  add_header X-Content-Type-Options nosniff always;'; \
  echo '  add_header Referrer-Policy same-origin always;'; \
  echo '  location / { try_files $uri $uri/ /index.html; }'; \
  echo '}'; \
} > /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
