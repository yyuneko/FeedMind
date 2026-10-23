# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ARG DEBIAN_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.tuna.tsinghua.edu.cn/debian-security
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY} \
    NPM_CONFIG_DISTURL=${NODEJS_ORG_MIRROR} \
    npm_config_disturl=${NODEJS_ORG_MIRROR} \
    NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=10000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=600000
RUN sed -i \
    -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
    -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
    /etc/apt/sources.list.d/debian.sources

FROM base AS build
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=feedmind-build-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=feedmind-build-apt-cache,target=/var/cache/apt,sharing=locked \
  apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates python3
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate \
  && pnpm config set registry "${NPM_REGISTRY}" \
  && pnpm config set fetch-retries 5 \
  && pnpm config set fetch-retry-mintimeout 10000 \
  && pnpm config set fetch-retry-maxtimeout 120000 \
  && pnpm config set fetch-timeout 600000 \
  && pnpm config set network-concurrency 4 \
  && pnpm config set store-dir /pnpm/store
WORKDIR /app/server/local-runtime
COPY server/local-runtime/package.json ./package.json
COPY server/local-runtime/docker-pnpm-workspace.yaml ./pnpm-workspace.yaml
RUN --mount=type=cache,id=feedmind-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm install --no-frozen-lockfile --store-dir /pnpm/store
COPY workers /app/workers
COPY src /app/src
COPY server/local-runtime/build.mjs server/local-runtime/tsconfig.json ./
COPY server/local-runtime/src ./src
COPY server/local-runtime/migrations ./migrations
RUN --mount=type=cache,id=feedmind-pnpm-store,target=/pnpm/store,sharing=locked \
  pnpm build \
  && CI=true NPM_CONFIG_OFFLINE=true pnpm prune --prod

FROM base
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT=600000
ENV DEBIAN_FRONTEND=noninteractive
RUN rm -f /etc/apt/apt.conf.d/docker-clean
RUN --mount=type=cache,id=feedmind-runtime-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=feedmind-runtime-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=feedmind-npm-cache,target=/root/.npm,sharing=locked \
    --mount=type=cache,id=feedmind-playwright-cache,target=/root/.cache/ms-playwright,sharing=locked \
  apt-get -o Acquire::Retries=5 update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && npm install --global playwright@1.58.2 \
  && PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright playwright install --with-deps chromium \
  && mkdir -p /ms-playwright \
  && cp -a /root/.cache/ms-playwright/. /ms-playwright/ \
  && npm uninstall --global playwright
WORKDIR /app
COPY --from=build /app/server/local-runtime ./server/local-runtime
COPY --from=build /app/workers/migrations ./workers/migrations
COPY --from=build /app/server/local-runtime/migrations ./server/local-runtime/migrations
RUN mkdir -p /data/db /data/content \
  && chown -R node:node /data /ms-playwright
USER node
