# FeedMind 本地运行与开发指南

本文适用于 Cloudflare 迁移后的 FeedMind。旧的 Go、Docker Compose 和 PostgreSQL 仅保留为回滚材料，不再是新客户端的本地运行依赖。

## 1. 三种运行方式

| 目标 | 推荐方式 | 是否能完整使用业务功能 |
| --- | --- | --- |
| 修改 React Native/Expo 界面 | `pnpm start` 或 `pnpm dev:web` | Android 可连接生产 Cloudflare；localhost Web 可通过开发代理调用远程 API |
| 修改 Admin Web 界面 | `pnpm dev:admin` | localhost:8083 热更新，并通过独立 Admin OAuth 调用远程 Admin API |
| 使用 C Web 或 Admin Web | 访问已部署域名 | 是，分别由对应 Cloudflare Access 保护 |
| 开发、测试 Worker | typecheck、Vitest、`wrangler dev` | 单个 Worker 可本地调试；完整 Access/Queues/Workflows 链路以远程环境验收 |

Web 客户端固定通过同源 `/api/v1` 调用 C API，Admin Web 固定通过同源 `/api/admin/v1` 调用 Admin API。生产环境由 Web Worker 的 Service Binding 转发，并由 Cloudflare Access 注入 assertion。本地 Expo 开发服务器通过 `metro.config.js` 把 `/api/*` 转发到远程 C Web；Cloudflare Access 会话值只保存在本机环境变量中，不进入浏览器 bundle。

## 2. 环境要求

- Windows 10/11 和 PowerShell；若 PowerShell 禁止执行 `pnpm.ps1`，在命令前使用 `cmd /c`。
- Node.js 20 或 22。
- pnpm 11.11.0；仓库通过 `packageManager` 固定版本。
- Android 开发还需要 Android Studio、Android SDK、JDK 17 和可用的模拟器或真机。
- Worker 本地开发或远程操作需要 Cloudflare Wrangler 登录。

在仓库根目录执行：

```powershell
corepack enable
corepack prepare pnpm@11.11.0 --activate
pnpm install
pnpm exec tsc --noEmit
pnpm workers:typecheck
pnpm workers:test
```

若 PowerShell 报执行策略错误：

```powershell
cmd /c corepack pnpm install
cmd /c pnpm workers:test
```

## 3. 配置客户端环境

从示例创建本地文件；`.env` 已被 Git 忽略：

```powershell
Copy-Item .env.example .env
```

Android 连接已部署的 Cloudflare 环境时使用：

```dotenv
EXPO_PUBLIC_FEEDMIND_API_URL=https://app.feedmind.cc/api
EXPO_PUBLIC_APP_ENV=production
```

本地 Web 调试直接运行：

```powershell
pnpm dev:web
```

Expo/Metro 继续提供 Fast Refresh；浏览器请求同源 `/api/v1`，开发服务器代理到 `EXPO_PUBLIC_FEEDMIND_API_URL`。登录使用 Cloudflare Managed OAuth 的动态客户端注册和 Authorization Code + S256 PKCE，无需复制远程 Cookie。token 只保存在 localhost 当前标签页的 `sessionStorage`。也可用仅服务端读取的 `FEEDMIND_DEV_API_PROXY_TARGET` 单独覆盖代理目标。

`dev:web` 会使用 Node 的环境代理支持启动 Expo，因此在设置了 `HTTP_PROXY`/`HTTPS_PROXY` 的开发机上，API 与 OAuth 元数据代理会沿用这些代理变量。该脚本要求项目推荐的 Node.js 22；未配置系统代理时行为与普通直连一致。

本地 Admin Web 使用独立端口和 Access Application：

```powershell
pnpm dev:admin
```

访问 `http://localhost:8083`。开发服务器直接提供 `workers/admin-web/public`，文件变化时通过 SSE 自动刷新浏览器，并把 `/api/admin/v1/*` 转发到 `https://admin.feedmind.cc/api`。登录使用 Admin Access Application 的 Managed OAuth + S256 PKCE；Admin Access 应用必须单独启用 Dynamic Client Registration 和 **Allow localhost clients**。需要覆盖远程地址时，可在 `.env.local` 设置：

```dotenv
FEEDMIND_DEV_ADMIN_API_PROXY_TARGET=https://admin.feedmind.cc/api
```

说明：

- 地址填写 API 根路径 `/api`，不要再追加 `/v1`。
- Android 会从 `https://app.feedmind.cc/.well-known/cloudflare-access-protected-resource/` 发现 Managed OAuth，并使用 `feedmind://oauth` 回调。
- C Access Application 必须启用 Managed OAuth 和 Dynamic Client Registration；为了让 localhost Web 登录，还必须在 Managed OAuth settings 中启用 **Allow localhost clients**。
- Web 浏览器始终使用同源 `/api/v1`；本地开发服务器使用上述地址作为代理目标，生产环境仍由 C Web Worker 同源转发。

## 4. 本地运行 Android

先启动 Android 模拟器，或用 USB 连接已开启调试的真机，然后执行：

```powershell
pnpm android
```

也可以先启动 Expo，再按 `a`：

```powershell
pnpm start
```

首次运行会通过系统浏览器打开 Cloudflare Access。登录成功后 token 与 refresh token 保存到 Android SecureStore，应用业务数据从 Cloudflare D1/R2/API 读取。

如果只需要生成验收 APK：

```powershell
pnpm build:apk
```

默认输出：

```text
FeedMind-arm64-v8a-release.apk
```

该脚本使用短路径 `C:\tmp\FeedMindBuild` 规避 Windows CMake 路径长度问题。当前默认签名是 Android Debug 证书，只能用于开发和验收，不用于应用商店发布。

## 5. 本地运行 Expo Web

启动开发服务器：

```powershell
pnpm web
```

终端会显示 localhost 地址。此模式适合检查布局、路由和静态资源；需要订阅、文章、翻译和登录数据时，请使用：

```text
https://app.feedmind.cc
```

原因是生产 Web 的 `/api/*` 由 `feedmind-c-web` 转发到内部 `feedmind-c-api`，并依赖 C Access assertion。Expo localhost 没有这层同源 Worker 和 Access 保护，业务请求出现 `404` 或 `401` 属于预期行为。

生成与生产部署相同的静态产物：

```powershell
npx expo export --platform web
```

输出目录为 `dist/`。只想验证产物时不需要部署；发布命令见部署运行手册。

## 6. Admin Web

完整管理功能直接使用：

```text
https://admin.feedmind.cc
```

管理员身份只在 Cloudflare Zero Trust 的 Admin Access Policy 中维护。Admin Web 可配置 Prompt、OpenRouter model 和 Profile 参数，但 API Key 不会进入页面或 D1。

远程 AI Secrets 必须在终端设置：

```powershell
pnpm --dir workers/ai-service exec wrangler secret put OPENROUTER_API_KEY
```

设置 Secret 后，在 Admin Web 中创建 `fast`、`quality` Profile，填写 OpenRouter `vendor/model` 模型标识；支持 Batch 模型，例如 `google/gemini-3.6-flash:batch`。Batch Profile 的连通测试以成功提交 `/api/beta/batches` 为通过条件，正式工作流会去掉 `:batch` 后提交任务并轮询最多 30 分钟。执行连通测试并激活。普通模型固定使用 `https://openrouter.ai/api/v1`，无需填写 Provider 或 endpoint。

若只修改 Admin Web 的 HTML/CSS/JavaScript，可运行：

```powershell
pnpm --dir workers/admin-web exec wrangler dev --port 8790
```

本地页面不具备生产 Admin Access assertion，因此本地管理 API 操作不会被当作已登录管理员；完整操作仍在生产 Admin 域名验收。

## 7. Worker 本地测试

最常用的验证命令：

```powershell
pnpm workers:typecheck
pnpm workers:test
pnpm test:translation
pnpm test:thinking
```

只测试一个 Worker：

```powershell
pnpm --filter @feedmind/c-api test
pnpm --filter @feedmind/admin-api test
pnpm --filter @feedmind/ai-service test
pnpm --filter @feedmind/pipeline test
pnpm --filter @feedmind/translation-workflow test
pnpm --filter @feedmind/gpt-actions-api test
```

测试不会调用真实 Provider，也不会修改远程 D1/R2。

## 8. 本地 D1 与 Worker Secrets

创建共享的本地 D1 状态并应用迁移：

```powershell
pnpm --dir workers/c-api exec wrangler d1 migrations apply feedmind --local --persist-to ../../.wrangler/state
```

本地 Worker Secret 使用 `.dev.vars`，不要执行 `wrangler secret put`。按需复制示例：

```powershell
Copy-Item workers/ai-service/.dev.vars.example workers/ai-service/.dev.vars
Copy-Item workers/gpt-actions-api/.dev.vars.example workers/gpt-actions-api/.dev.vars
Copy-Item workers/pipeline/.dev.vars.example workers/pipeline/.dev.vars
Copy-Item workers/reader-api/.dev.vars.example workers/reader-api/.dev.vars
```

启动单个 Worker：

```powershell
pnpm --dir workers/ai-service dev
pnpm --dir workers/pipeline dev
pnpm --dir workers/translation-workflow dev
pnpm --dir workers/c-api dev
pnpm --dir workers/reader-api dev
pnpm --dir workers/admin-api dev
pnpm --dir workers/gpt-actions-api dev
```

这些命令适合调试单个入口。C/Admin API 依赖其他 Service Bindings、D1、R2、Queues 和 Workflows；若未同时提供依赖，相关业务接口会失败。生产级完整链路使用远程 Cloudflare 环境验收。

## 9. Wrangler 登录与远程只读检查

检查登录状态：

```powershell
pnpm --dir workers/c-api exec wrangler whoami
```

查看远程 D1 迁移状态：

```powershell
pnpm --dir workers/c-api exec wrangler d1 migrations list feedmind --remote
```

查看 Worker Secret 名称（不会显示值）：

```powershell
pnpm --dir workers/ai-service exec wrangler secret list
pnpm --dir workers/gpt-actions-api exec wrangler secret list
```

远程部署、写入 Secret、执行远程迁移都会改变生产环境；执行前确认当前 Cloudflare 账户为 `841c2769e1a55cd93c7e23470de8bff7`。

## 10. 常见问题

### PowerShell 无法执行 pnpm.ps1

使用 `cmd /c pnpm ...`，不需要修改系统执行策略。

### localhost Web 返回 404 或 401

这是同源 `/api` 和 Cloudflare Access 缺失导致的预期行为。界面开发继续使用 localhost；完整业务功能访问 `https://app.feedmind.cc`。

### Android 登录时报“无法注册 OAuth 客户端”

检查 C Access Application 是否同时启用了 Managed OAuth 和 Dynamic Client Registration，并精确允许 `feedmind://oauth`。

### Admin 后台没有 API Key 输入框

这是安全设计。使用 `wrangler secret put OPENROUTER_API_KEY`，页面只保存不敏感的 Profile 配置。

### AI Profile 无法激活

确认 `OPENROUTER_API_KEY` 已写入 AI Worker、模型标识采用 OpenRouter `vendor/model` 格式，并且该 Key 具备所选模型的调用权限。

### APK 构建提示找不到 expo-sqlite 或 CMake 路径过长

使用 `pnpm build:apk`，不要直接复制旧的 Gradle 命令。脚本会使用短路径和当前 pnpm `.p` 虚拟仓库布局。

## 11. 推荐日常流程

```powershell
pnpm install
pnpm workers:typecheck
pnpm workers:test
pnpm start
```

修改 Worker 后先运行对应测试和 dry-run；修改客户端后运行根 TypeScript 检查、Web 导出和 Android 构建。部署流程参见 [`DEPLOYMENT_RUNBOOK.zh-CN.md`](DEPLOYMENT_RUNBOOK.zh-CN.md)。
