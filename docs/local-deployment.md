# FeedMind 本地 Docker 部署与迁移

本方案把 API、抓取、解析、AI、SQLite、内容对象、队列、Workflow、定时任务和 Chromium 全部运行在本机 Docker 中。Cloudflare 只保留 DNS、Access、Managed OAuth 和一条 Tunnel；四个业务 hostname 均通过 Tunnel 指向 `gateway`，数据库、worker 和 API 不发布主机端口。

## 运行结构

- `gateway`：Caddy，托管 C Web/Admin Web 并按原路径反向代理 API。
- `api`：C API、Admin API、Reader API 和 ChatGPT MCP 服务。
- `worker`：SQLite 持久化任务、Workflow checkpoint、Feed scheduler、维护任务和 Playwright Chromium。
- `cloudflared`：唯一公网入口。
- `adguard`：局域网 DNS；向 LAN 开放 TCP/UDP 53，管理界面仅绑定本机 `127.0.0.1:3000`。
- `server/local-runtime/.local-data/db/feedmind.sqlite`：SQLite 主库，启用 WAL、foreign keys 和 busy timeout。
- `server/local-runtime/.local-data/content`：保持原 R2 object key 的内容目录。

运行时密钥只从环境变量或 `/run/secrets` 的只读文件读取。示例配置见 `server/local-runtime/.env.local.example` 和 `server/local-runtime/.env.migration.local.example`，真实文件已经被 Git 忽略。

## 局域网域名分流

AdGuard Home 将 `app.feedmind.cc`、`admin.feedmind.cc`、`actions.feedmind.cc` 和 `reader.feedmind.cc` 重写为 FeedMind 主机的局域网地址 `192.168.2.7`。公网 DNS 不受影响，局域网之外仍通过 Cloudflare Tunnel 访问。

H3C RC3000 的“网络设置 → DHCP 服务器”中，将主 DNS 服务器设置为 `192.168.2.7`，备 DNS 留空；填写公网备 DNS 会让客户端随机绕过局域网重写。修改后让客户端重新获取 DHCP 租约，并关闭会绕过局域网 DNS 的手动 DoH/私人 DNS。

管理界面只允许从 FeedMind 主机打开：`http://127.0.0.1:3000`。DNS 分流只改变解析结果；局域网 HTTPS 和 Cloudflare Access 转接必须在 `gateway` 完成后，才可将路由器 DNS 切换到 AdGuard Home。

## 验证

```powershell
pnpm local:typecheck
pnpm local:build
pnpm local:test
pnpm workers:typecheck
pnpm workers:test
docker compose config --quiet
docker compose build api
```

Dockerfile 为 APT、pnpm、npm 和 Playwright Chromium 分别配置了持久化 BuildKit 缓存，`api` 负责构建本地镜像，`worker` 直接复用该镜像。普通源码改动只会重新执行编译和镜像组装；即使依赖层需要重建，已下载的软件包和浏览器文件也会从本机缓存读取。不要在日常构建中使用 `--no-cache`，也不要频繁执行 `docker builder prune`，否则会主动丢弃这些缓存。

空库初始化：

```powershell
$env:DATABASE_PATH = "server/local-runtime/.local-data/db/feedmind.sqlite"
node server/local-runtime/dist/migrate.mjs bootstrap
```

默认 Compose 以 `MIGRATION_MODE=paused` 启动 API/worker，避免在切流验收前创建新任务。正式开放写入时设置 `MIGRATION_MODE=normal` 后强制重建 API 和 worker 容器。

## 一次性迁移

1. 将 `server/local-runtime/.env.migration.local.example` 复制为 `.env.migration.local`，填入 Cloudflare API、Tunnel 和 R2 S3 凭证以及缺失的运行密钥。迁移脚本不会输出密钥值。
2. Cloudflare API token 至少要能读取 Access/Tunnel/Queues，并能修改 Tunnel 配置、Worker custom domains 和目标 zone DNS。
3. 先运行只读门禁：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migrate-cloudflare-to-local.ps1
```

门禁先通过 `d1 info` 检查最近 24 小时读取行数。默认警告阈值为 500 万；由于该值是滚动统计，而免费额度在 00:00 UTC 重置，达到阈值时脚本会发出警告并用最小 schema 查询探测真实可用性。若额度仍未恢复，Cloudflare 会拒绝查询，脚本会在维护模式前停止。若账户实际额度不同，可显式传入 `-D1DailyRowsReadLimit <额度>`；传入 `0` 可关闭该警告。

4. 门禁全部通过后立即执行迁移：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migrate-cloudflare-to-local.ps1 -Execute
```

脚本严格按以下顺序执行：代码与 Compose 验证 → D1/R2/磁盘/密钥/Access/Tunnel/Queue 门禁 → 云端只读 → 最长 60 分钟排空 → 云端 paused → D1 导出和业务数据筛选 → R2 下载及大小/哈希校验 → 本地 API（scheduler 暂停）→ Tunnel 切流 → 公网 smoke test → 启动 scheduler/worker。

门禁失败发生在维护模式之前。排空、导出、转换、对象校验或切流失败时，脚本会恢复 Worker hostname 和云端 `normal` 模式；本地开放写入以后不提供向旧 D1 的反向同步。

每次迁移的原始 D1 SQL、对象 manifest、下载哈希、数据库计数和校验报告保存在仓库根目录下的 `migration-archives/<时间戳>`，位于 Docker data volume 之外。至少保留 14 天。

## 人工验收清单

自动 smoke test 只能证明网络、Tunnel 和服务响应正常。结束维护窗口前仍需使用真实身份/客户端完成：

- C Web 的 Access 登录和文章读取；
- Admin Access 登录和配置读取；
- Android Managed OAuth 登录、token 刷新和 API 访问；
- Reader API 原凭证/session；
- ChatGPT MCP OAuth、文章查询和图片翻译；
- 历史 completed 翻译读取；
- 一条真实 Feed 抓取、解析、预处理和正文翻译；
- 翻译中重启 `worker`，确认从 SQLite checkpoint 恢复。

重启 worker：

```powershell
docker compose restart worker
```

检查状态：

```powershell
docker compose ps
docker compose logs --tail 200 api worker cloudflared
```

## 14 天后下线 Cloudflare 运行时

旧 Workers、D1、R2、Queues 和 Workflows 在 14 天内只读保留，不接收本地写入。确认归档可读且本地服务稳定后，再单独进行明确删除：删除 Workers、Queues/DLQ、Workflows、D1、R2，撤销 Worker/R2 token，并清理 Wrangler 部署配置和 Cloudflare runtime 依赖。删除不包含在迁移脚本中，避免提前破坏可恢复窗口。
