# FeedMind HTML Fetcher

这是一个只供 FeedMind Go 服务端调用的 Cloudflare Worker。它从 Cloudflare 网络获取经过安全校验的公开 HTML 页面或 RSS/Atom/XML 订阅源；FeedMind 客户端不应直接调用该服务。

## 本地开发

1. 在仓库根目录运行 `pnpm install`。
2. 将 `.dev.vars.example` 复制为 `.dev.vars`，设置一个足够长的随机 `FEEDMIND_HTML_WORKER_TOKEN`。不要提交该文件。
3. 运行 `pnpm --filter @feedmind/html-fetcher dev`，默认地址通常为 `http://localhost:8787`。
4. 在 Go 服务端配置：

   ```dotenv
   # Go 服务运行在宿主机：使用 http://localhost:8787/html
   # Go 服务运行在 Docker Compose：使用 http://host.docker.internal:8787/html
   FEEDMIND_HTML_WORKER_URL=http://host.docker.internal:8787/html
   FEEDMIND_HTML_WORKER_TOKEN=<与 .dev.vars 相同的值>
   FEEDMIND_HTML_WORKER_TIMEOUT=20s
   FEEDMIND_HTML_WORKER_MAX_BYTES=8388608
   ```

本地请求示例：

```powershell
$headers = @{ Authorization = "Bearer <token>"; "Content-Type" = "application/json" }
$body = @{ url = "https://example.com/"; kind = "html" } | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri "http://localhost:8787/html" -Headers $headers -Body $body
```

`kind` 只能为 `html` 或 `feed`；为兼容旧版 HTML 调用，省略时默认为 `html`。Feed 模式只接受 RSS、Atom、RDF、XML 和 JSON Feed 对应的 Content-Type，不会放宽为任意文件代理。部署时应先部署 Worker，再重启新版 Go 服务端。

## 测试与检查

```sh
pnpm --filter @feedmind/html-fetcher types
pnpm --filter @feedmind/html-fetcher typecheck
pnpm --filter @feedmind/html-fetcher test
pnpm --filter @feedmind/html-fetcher check:deploy
```

测试使用注入式 DNS、fetch 和本地 Workers runtime，不依赖真实外部网站。

## 查看日志

部署后可在 Cloudflare Dashboard 的 Worker → Observability → Logs 中查看持久化日志，或在仓库根目录实时跟踪：

```sh
pnpm --filter @feedmind/html-fetcher logs
```

日志事件包括 `worker_request_received`、`worker_fetch_started` 和 `worker_request_completed`。Go 服务端会把 FeedMind API 请求 ID 通过 `X-FeedMind-Request-ID` 传入 Worker，因此可直接使用客户端看到的请求 ID 检索；定时任务等没有 API 请求 ID 的调用会使用 `CF-Ray`。还可按 `kind`、`targetHost`、`outcome`、`upstreamStatus` 或 `errorCode` 筛选。日志不会记录 Bearer Token、完整 URL、查询参数、请求正文或响应正文；响应头 `X-FeedMind-Request-ID` 可用于关联请求。

Go 服务端仅在直连发生网络错误，或目标返回 403、429、5xx 时调用 Worker；直连成功以及 404 等确定性 4xx 不会出现在 Worker 日志中。Go 服务端在触发兜底时会记录 `routing content fetch through HTML worker`，并带上相同的 `request_id`。

## 部署

1. 按需修改 `wrangler.jsonc` 中的 Worker 名称和非敏感限制。若修改 `MAX_HTML_BYTES`，同步调整 Go 服务端的 `FEEDMIND_HTML_WORKER_MAX_BYTES`。
2. 登录 Cloudflare：`pnpm --filter @feedmind/html-fetcher exec wrangler login`。
3. 保存生产密钥：`pnpm --filter @feedmind/html-fetcher exec wrangler secret put FEEDMIND_HTML_WORKER_TOKEN`。
4. 部署：`pnpm --filter @feedmind/html-fetcher deploy`。
5. 将部署后的 HTTPS `/html` 地址和同一 Token 配置到 Go 服务端，然后重启服务端。

成功响应直接返回目标 HTML 或订阅源字节，HTTP 状态与目标站一致，并包含 `X-FeedMind-Final-URL` 和 `X-FeedMind-Upstream-Status`。订阅源响应还会保留受控的 ETag 与 Last-Modified 元数据。Worker 自身的验证、鉴权、网络、超时、大小或 Content-Type 错误使用统一 JSON 结构返回。所有响应都禁止缓存，接口不提供 CORS。

## 安全边界与限制

- 只允许默认端口的公开 HTTP/HTTPS 域名；每次重定向都会重新解析并校验全部 A/AAAA 地址。
- Worker 只发送固定的 GET 请求头，不接受 Cookie、Authorization 或调用方自定义上游请求头。
- DNS 预校验与实际连接之间仍存在理论上的 DNS rebinding 时间窗口。该 Worker 不配置 VPC binding，并通过公网路由、逐跳复验以及私有/保留地址拦截降低风险。
- 部分网站会封锁 Cloudflare 数据中心 IP，或要求登录、验证码、JavaScript/浏览器执行；此 Worker 不绕过这些限制，也不使用 Browser Rendering。
