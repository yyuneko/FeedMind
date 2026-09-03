# FeedMind

[English](README.md) | 中文

FeedMind 是一个以 Cloudflare 为后端的 Expo RSS 阅读器，支持 Android 和 Web。系统使用 Cloudflare Access 登录，D1 保存业务元数据，R2 保存文章正文和永久翻译结果，Queues/Workflows 执行抓取、解析、分类和翻译任务。

## 当前架构

- C Web：`https://app.feedmind.cc`，同源 API 前缀 `/api/v1`。
- Admin Web：`https://admin.feedmind.cc`，同源 API 前缀 `/api/admin/v1`。
- GPT Actions：`https://actions.feedmind.cc/openapi.json`，业务前缀 `/gpt-actions/v1`。
- Android：Cloudflare Access Managed OAuth、动态客户端注册、Authorization Code + PKCE。
- AI：内部 Worker 根据 D1 中激活的 `fast`/`quality` Profile 调用 Provider；API Key 仅存储在 Worker Secrets。
- 客户端本地仅缓存阅读显示偏好；订阅、文章、状态、思考训练和翻译事实均以 Cloudflare 为准。

旧 Go、Docker Compose 和 PostgreSQL 只作为迁移回滚材料，不再是当前客户端运行依赖。

## 快速开始

```powershell
corepack enable
corepack prepare pnpm@11.11.0 --activate
pnpm install
Copy-Item .env.example .env
pnpm start
```

Android 模拟器或真机：

```powershell
pnpm android
```

本地 Web 界面开发：

```powershell
Copy-Item .env.example .env.local
pnpm dev:web
```

开发服务器支持 Expo Fast Refresh，并将浏览器的同源 `/api/*` 请求代理到 `EXPO_PUBLIC_FEEDMIND_API_URL`。localhost 使用 Cloudflare Managed OAuth、动态客户端注册和 Authorization Code + PKCE 登录；access/refresh token 仅保存在当前标签页的 `sessionStorage`，关闭标签页后清除。Cloudflare Access 应用需要启用 **Allow localhost clients**。

本地 Admin 管理台开发：

```powershell
pnpm dev:admin
```

打开 `http://localhost:8083`。Admin 静态文件修改后浏览器会自动刷新，`/api/admin/v1/*` 请求代理到 `https://admin.feedmind.cc/api`；登录使用 Admin Access Application 独立的 Managed OAuth 客户端。Admin Access 应用同样需要启用 **Allow localhost clients**。

## 文档

- [本地运行与开发指南](CLOUDFLARE/LOCAL_DEVELOPMENT.zh-CN.md)
- [Cloudflare 部署运行手册](CLOUDFLARE/DEPLOYMENT_RUNBOOK.zh-CN.md)
- [生产部署状态](CLOUDFLARE/DEPLOYMENT_STATUS.zh-CN.md)
- [完整迁移计划](CLOUDFLARE_MIGRATION_PLAN.zh-CN.md)

## 验证

```powershell
pnpm typecheck
pnpm workers:typecheck
pnpm workers:test
pnpm test:translation
pnpm test:thinking
npx expo export --platform web
```

生成 Android 验收 APK：

```powershell
pnpm build:apk
```

AI Profile 的 OpenRouter 模型与参数在 Admin Web 管理；`OPENROUTER_API_KEY` 必须使用 Wrangler 写入 Worker Secrets，不能放入 `.env`、D1 或 Git。
