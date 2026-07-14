ARG NODE_IMAGE=m.daocloud.io/docker.io/library/node:22-alpine
ARG GOLANG_IMAGE=m.daocloud.io/docker.io/library/golang:1.26-alpine

FROM ${NODE_IMAGE} AS web-build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# Worker 单独部署；这里只复制清单供 pnpm 解析 workspace，不构建或打包 Worker。
COPY workers/html-fetcher/package.json workers/html-fetcher/package.json
RUN pnpm --filter feedmind install --frozen-lockfile
COPY app.json babel.config.js tsconfig.json ./
COPY app app
COPY assets assets
COPY src src
ARG EXPO_PUBLIC_FEEDMIND_API_URL=
ARG EXPO_PUBLIC_APP_ENV=production
ENV EXPO_PUBLIC_FEEDMIND_API_URL=${EXPO_PUBLIC_FEEDMIND_API_URL}
ENV EXPO_PUBLIC_APP_ENV=${EXPO_PUBLIC_APP_ENV}
RUN pnpm exec expo export --platform web --output-dir /web

FROM ${GOLANG_IMAGE} AS server-build
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src/server
COPY server/go.mod server/go.sum* ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -o /feedmind ./cmd/feedmind

FROM scratch
COPY --from=server-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server-build /feedmind /feedmind
COPY --from=web-build /web /web
ENV FEEDMIND_WEB_DIR=/web
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/feedmind"]
