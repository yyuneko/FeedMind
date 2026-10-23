# FeedMind Cloudflare 部署运行手册

本地安装、Expo/Android 运行、Worker 测试和常见故障见 [`LOCAL_DEVELOPMENT.zh-CN.md`](LOCAL_DEVELOPMENT.zh-CN.md)。

## 通用数据源部署参数

Google Reader/FreshRSS 连接凭据使用 AES-256-GCM 加密。首次部署 `0024_generic_sources.sql` 前生成一个 32 字节随机值并以 Base64 保存，随后将同一个值分别配置为 `feedmind-c-api` 与 `feedmind-pipeline` 的 `SOURCE_CREDENTIALS_KEY` Secret。密钥不得提交到仓库；丢失后已有连接凭据无法解密。

从仓库根目录运行以下脚本即可生成符合要求的通用密钥。脚本使用系统密码学随机数生成器，默认生成 32 字节并编码为 Base64：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-secret.ps1
```

也可以按用途选择输出格式和长度：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-secret.ps1 -Format Base64Url -Bytes 48
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/generate-secret.ps1 -Format Hex -Bytes 32 -Count 3
```

第三方阅读器应用密码与会话令牌使用独立高熵 `READER_CREDENTIALS_KEY` 做 HMAC。必须把同一个值配置到 `feedmind-c-api` 和 `feedmind-reader-api`，但不得与 `SOURCE_CREDENTIALS_KEY` 共用。应用密码只在创建响应中展示一次，服务端不保存明文。

原 FeedMind 用户必须按原 UUID 导入 `accounts`，并且只有原系统中已验证且唯一的邮箱才填写 `normalized_email` 与 `email_verified_at`。用户第一次通过 Cloudflare Access 登录时，C API 会用该邮箱完成一次性认领，随后永久使用 `account_identities(provider, provider_subject)` 中的 Access `sub` 解析账户。不要配置或保存完整 Access JWT，也不再使用 `LEGACY_OWNER_SUBJECT`。

部署顺序固定为：应用 D1 迁移、导入并核验原用户账户及其业务数据、配置 Worker 参数、部署 Pipeline、部署 C API，最后在“数据源连接”页面执行 FreshRSS 连接测试和首次同步。账户导入必须发生在开放新版 C API 登录之前。

已验证旧账户的导入格式如下；`id` 必须沿用原 FeedMind 用户 UUID，未验证邮箱不得填写 `email_verified_at`：

```sql
INSERT INTO accounts (id, email, normalized_email, email_verified_at, created_at, updated_at)
VALUES (?1, ?2, lower(trim(?2)), ?3, ?4, ?4)
ON CONFLICT(id) DO UPDATE SET
  email = excluded.email,
  normalized_email = excluded.normalized_email,
  email_verified_at = excluded.email_verified_at,
  updated_at = excluded.updated_at;
```

导入后必须检查 `normalized_email` 无重复，并确认每条订阅、阅读状态、偏好和数据源连接的 `owner_id` 均指向对应的原用户 UUID。不要提前写入 `account_identities`；该表由用户首次 Access 登录时原子认领。

## 固定资源

- Account ID：`841c2769e1a55cd93c7e23470de8bff7`
- D1：`feedmind` / `a9c617e3-9f62-4eb3-99b0-1b5542ab0ca7`
- R2：`feedmind-content`
- Queues：`feedmind-feed`、`feedmind-feed-dlq`、`feedmind-article`、`feedmind-article-dlq`
- Access Team：`steep-credit-754a.cloudflareaccess.com`
- C Audience：`f657e874e6b31d81e7fdf718b688a37997f9e5a59b0ad7e0486ea06dc21a4acc`
- Admin Audience：`0fb1d330b27a750c38b95f813b38976cfcd497c37589612efdd0083bc9c73da9`

## 必需 Secrets

Secrets 只通过 `wrangler secret put` 写入，不写入仓库或 D1：

```powershell
pnpm --dir workers/ai-service exec wrangler secret put OPENROUTER_API_KEY
pnpm --dir workers/gpt-actions-api exec wrangler secret put SOURCE_CREDENTIALS_KEY
pnpm --dir workers/gpt-actions-api exec wrangler secret put GPT_OAUTH_CLIENT_SECRET
pnpm --dir workers/c-api exec wrangler secret put GPT_OAUTH_REDIRECT_URIS
pnpm --dir workers/c-api exec wrangler secret put SOURCE_CREDENTIALS_KEY
pnpm --dir workers/pipeline exec wrangler secret put SOURCE_CREDENTIALS_KEY
pnpm --dir workers/c-api exec wrangler secret put READER_CREDENTIALS_KEY
pnpm --dir workers/reader-api exec wrangler secret put READER_CREDENTIALS_KEY
```

`GPT_OAUTH_REDIRECT_URIS` 填写 ChatGPT MCP 连接配置显示的完整 OAuth 回调地址；如同时显示 `chatgpt.com` 与 `chat.openai.com` 地址，用英文逗号连接。`GPT_OAUTH_CLIENT_SECRET` 必须与 MCP 连接配置中的 Client Secret 完全一致。为兼容历史授权数据，OAuth Client ID 仍固定为 `feedmind-chatgpt-action`。

从固定密钥版本切换到 OAuth 后，确认新版 Worker 已部署，再删除线上遗留的固定 Action 密钥和固定账户 Secret。新版代码不会读取它们，`0029_gpt_actions_oauth.sql` 也会删除旧密钥到账户的映射表：

```powershell
pnpm --dir workers/gpt-actions-api exec wrangler secret delete GPT_ACTION_API_KEY
pnpm --dir workers/gpt-actions-api exec wrangler secret delete GPT_ACTION_ACCOUNT_ID
```

fast/quality Profile 共享该 OpenRouter Key，并可分别选择不同的 OpenRouter 模型。

## 部署顺序

推荐从仓库根目录使用批量脚本。脚本会先执行全部 Worker 的类型检查和测试、应用远程 D1 迁移，再按 Service Binding/Workflow 依赖顺序检查全部 9 个 Worker 的部署输入指纹，仅部署相对线上当前版本有变更的 Worker；部署 C Web 前会自动导出 Expo Web 静态资源：

```powershell
pnpm deploy:workers
```

发布前可以先执行不修改 Cloudflare 远端资源的构建检查：

```powershell
pnpm deploy:workers:dry
```

首次使用新版脚本时，线上旧版本没有部署输入指纹，因此会安全地全量部署一次。之后没有变化的 Worker 会自动跳过。紧急发布时可通过 `-SkipChecks` 跳过类型检查与测试，通过 `-SkipMigrations` 跳过 D1 迁移；需要忽略指纹强制全量部署时使用 `-Force`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-workers.ps1 -SkipChecks -SkipMigrations
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/deploy-workers.ps1 -Force
```

等价的手动部署顺序如下：

```powershell
pnpm --dir workers/c-api exec wrangler d1 migrations apply feedmind --remote
pnpm --dir workers/ai-service deploy
pnpm --dir workers/translation-workflow deploy
pnpm --dir workers/pipeline deploy
pnpm --dir workers/c-api deploy
pnpm --dir workers/reader-api deploy
pnpm --dir workers/admin-api deploy
pnpm --dir workers/gpt-actions-api deploy
npx expo export --platform web
pnpm --dir workers/c-web deploy
pnpm --dir workers/admin-web deploy
```

## Cloudflare Access

C 端只公开 `app.feedmind.cc`，浏览器与 Android 均通过同源 `/api/v1` 调用 C API；Admin 端只公开 `admin.feedmind.cc`，通过同源 `/api/admin/v1` 调用 Admin API。两个 API Worker 仅由各自 Web Worker 的 Service Binding 调用，不分配公网域名。C 与 Admin 必须使用不同的 Access Application、Policy 和 Audience，不得合并。

- C Policy：只允许明确列出的本人 Google/GitHub 身份；禁止“所有有效邮箱”和公共域名放行。
- Admin Policy：只允许明确管理员身份；名单只在 Zero Trust 中维护。
- C Application：开启 Managed OAuth、动态客户端注册，允许回调 `feedmind://oauth`；Access token 15 分钟，grant session 14 天。
- Android 先读取 `https://app.feedmind.cc/.well-known/cloudflare-access-protected-resource/`，再读取其中授权服务器的 `/.well-known/oauth-authorization-server`；动态注册请求必须携带 RFC 8707 `resource=https://app.feedmind.cc`，随后使用 Authorization Code + S256 PKCE。
- Web 由 Access Cookie 保护；Worker 仍验证 `Cf-Access-Jwt-Assertion` 的签名、issuer、audience、时间、subject 和 email。
- `actions.feedmind.cc` 不放在 C/Admin Access Application 中；除 OAuth 授权、换令牌、撤销、健康检查和 OpenAPI 文档外，所有 Action 业务接口只接受 OAuth access token。
- `reader.feedmind.cc` 是独立公开 Worker，不能放在 Cloudflare Access 后；它只接受应用密码换取的 `GoogleLogin` 会话，且固定读写本地 `direct_rss` 数据，不代理当前选中的外部源。

## 上线验收

先在 Admin Web 发布 fast 与 quality Profile，然后添加一个 Feed。确认 Queue 完成抓取、R2 出现正文、分类记录完成，再从 C Web 创建正文翻译并关闭页面，稍后重连读取永久结果。最后导入 GPT OpenAPI 完成相同的检索、分段读取和受限翻译流程。

Go、Docker Compose 与 PostgreSQL 只在上述验收全部通过、正式域名已切换且回滚窗口结束后停止；删除旧文件属于独立的不可逆清理步骤。
