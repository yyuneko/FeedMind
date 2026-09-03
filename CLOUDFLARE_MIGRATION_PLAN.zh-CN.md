# FeedMind 全量迁移 Cloudflare 最终计划书

## 1. 项目目标

将现有 Go 通用服务端的全部职责迁移至 Cloudflare 平台，停止维护常驻服务端和 PostgreSQL。新系统面向单一逻辑用户设计，通过 Google 或 GitHub 登录，并由 Cloudflare 后台配置允许访问的身份。

迁移完成后应实现：

- C 端 Web/原生客户端与管理端 Web 分别通过独立的 Cloudflare Access Application 登录，并部署在不同域名。
- API、AI 请求、RSS 调度、文章抓取、正文解析和翻译任务全部运行于 Cloudflare Workers。
- D1 保存业务元数据、配置和任务状态，R2 永久保存文章正文及翻译结果。
- 独立管理端可增删改不同文章类型的翻译提示词、管理 AI Provider/模型配置并查看不可篡改的配置变更日志；管理人员名单仅在 Cloudflare Access 后台配置，不在应用内维护。
- 分类与标题翻译使用低成本 AI Profile，正文翻译使用高质量 AI Profile。
- Provider、模型和提示词可运行时切换，不需要发布新版客户端。
- 翻译任务不依赖客户端保持在线，完成结果永久保存，可在管理端查看进度并由管理人员重新发起。C 端在没有历史任务时可创建首次正文翻译，也可重试失败、已取消或已中止且当前没有完成结果和活跃任务的翻译；已有完成结果或任务正在进行时不能重试、重启或重新翻译。使用新配置重新翻译和正文重新解析只允许管理端操作。
- 提供符合 GPT Actions 要求的 OpenAPI 3.1 REST 接口，使个人自定义 GPT 可以添加订阅源；该接口不模拟 OpenAI 模型推理协议，也不开放任何管理能力。

本项目当前没有需要保留的用户和生产数据，因此不实施旧数据库数据迁移，也不兼容旧密码、会话及用户自定义 AI 配置。

## 2. 目标架构

```text
C 端应用：<C 端域名>       管理端应用：<管理端域名>       个人自定义 GPT
Expo Web / Android         Admin Web                         │
        │                       │                             │ GPT Action API Key
        │ C 端 Access           │ Admin Access                ▼
        │ Google / GitHub       │ Cloudflare 后台管理员   GPT Actions API Worker
        ▼                       ▼                         <GPT Actions API 域名>
C API Worker              Admin API Worker                   │
  ├─ C 端业务 API           ├─ Prompt / AI Profile 配置       │ 仅复用 C 端能力规则
  ├─ 首次翻译与失败重试     ├─ 任务监控、重试与重新执行        │
  ├─ 禁止重翻与重新解析     ├─ 正文重新解析                   │
  └──────────────┬─────────┴─────────────────────────────────┘
                 ▼
Internal Service Workers
  ├─ D1 元数据、配置和任务状态
  ├─ R2 文章正文与翻译结果
  ├─ AI Adapter：统一 Provider 协议与增量解析
  └─ Workflow / Queue Producer
        │
        ├─ Feed Queue → RSS 抓取与解析 Consumer
        ├─ Article Queue → 正文抽取与清洗 Consumer
        └─ Translation Workflow → 分类、标题翻译、正文翻译

Cron Trigger
  └─ 扫描到期 Feed → Feed Queue

Content Fetcher Worker
  └─ SSRF 防护、重定向复验、大小及 Content-Type 限制
```

部署上保留清晰的权限边界：

- C 端与管理端仍是仅有的两个前端应用，分别使用独立构建、域名、Access Application 和 API 权限面，不共享浏览器会话或 Access audience；GPT Actions API 是没有前端页面的第三个公开接口权限面。
- C API Worker 只暴露日常阅读、订阅、状态查询、首次翻译和符合条件的失败重试；Admin API Worker 独占配置变更、使用新配置重翻、强制重启和正文重新解析能力。
- GPT Actions API Worker 使用独立域名、Secret 和速率/费用保护，只暴露经过裁剪的 C 端能力，并将通过认证的调用统一映射为 `owner`；它不接受 C/Admin Access assertion，也不能通过 Service Binding 调用 Admin API。
- Content Fetcher Worker 仅通过 Service Binding 被内部调用，不直接暴露用户接口。
- AI 调用由内部 AI 服务执行，API Key 只存在于 Worker Secrets。
- Feed 和 Article 后台任务使用 Queues，翻译使用 Workflows；不在 HTTP 请求结束后依赖 `waitUntil()` 完成长任务。

## 3. 身份认证与单用户授权

### 3.1 Cloudflare Access

- 在 Cloudflare Zero Trust 中配置 Google 和 GitHub Identity Provider。
- 为 C 端域名和管理端域名分别创建 Cloudflare Access Application，并使用不同 audience。
- C 端 Access Policy 仅允许 Cloudflare 后台配置的 C 端用户；Admin Access Policy 仅允许 Cloudflare 后台配置的管理人员。两类名单不在 D1、Worker env 或应用管理页中重复维护。
- 禁止按公共邮箱域名或“所有有效邮箱”放行；人员增删完全通过 Cloudflare Zero Trust 后台操作并由 Cloudflare 保留策略审计。
- C 端 Web 和管理端 Web 分别使用各自域名的 Access 浏览器 Cookie 登录流程。
- Android 只接入 C 端 Managed OAuth 授权码流程，通过系统浏览器登录，并安全保存 access token 和 refresh token；Android 不提供管理端入口。
- access token 建议有效期 15 分钟，授权会话建议 14 天；刷新时重新执行 Access Policy。
- C API Worker 与 Admin API Worker 分别校验 `Cf-Access-Jwt-Assertion` 的签名、issuer、对应 audience、有效期及 email，不因流量已经过 Access 而省略服务内校验，也不接受为另一个应用签发的 assertion。

### 3.2 逻辑用户映射

每个原 FeedMind 用户继续使用原用户 UUID 作为账户 ID。首次通过 Cloudflare Access 登录时，只允许使用原系统中已验证且唯一的邮箱完成一次性认领；认领后写入 `account_identities`，以后仅按身份提供方和 Access `sub` 解析账户。不同用户的数据始终通过 `owner_id` 隔离，不再映射到固定逻辑账户 `owner`。

管理人员身份不映射为应用内角色，也不写入管理员表；Admin Worker 仅信任通过 Admin Access Application 且 audience 正确的身份。管理操作审计记录使用 Access assertion 中的稳定 subject 和 email 标识操作者。

### 3.3 GPT Actions 身份认证

- GPT Actions 使用标准 OAuth 2.0 授权码流程；授权入口通过 C 端 Cloudflare Access 登录识别账户，授权码一次性使用且五分钟失效。
- token endpoint 使用独立 Client ID/Secret，签发一小时 access token 和可轮换的三十天 refresh token；服务端只保存 token hash，不保存明文。
- 每个 OAuth session 绑定唯一 `account_id` 和 scopes，Action 请求按 token 映射到对应账户；撤销任一 access/refresh token 会撤销整条 session。
- 不保留固定 API Key 兼容入口；所有 Action 业务请求必须使用 OAuth access token，并按 session 绑定的 `account_id` 隔离数据。

### 3.4 删除旧认证体系

移除注册、密码登录、邮箱验证、忘记密码、SMTP、Argon2、`users`、`auth_sessions`、`email_tokens` 及自签 JWT/refresh token 逻辑。客户端删除旧登录表单、密码存储和旧 token 刷新协议。

## 4. 数据与存储设计

### 4.1 D1 职责

D1 保存结构化、需要查询或事务控制的数据：

- Feed、订阅及抓取状态。
- Article 元数据、解析状态和 R2 内容引用。
- 已读、收藏、阅读进度。
- Prompt、偏好及思考训练数据。
- 文章分类结果。
- 翻译任务、批次、版本和错误状态。
- 提示词版本、AI Profile 版本和当前激活配置。

所有 ID 由 Worker 生成 UUID。时间统一保存为 UTC ISO 8601 字符串或 Unix 毫秒；JSON 保存为 TEXT 并在应用层校验。

### 4.2 R2 职责

R2 保存可能超过 D1 单行限制的大文本以及不可变结果：

```text
articles/{articleId}/{sourceHash}/source.html
articles/{articleId}/{sourceHash}/source.txt
translations/{articleId}/{translationId}/partial/{batch}.json
translations/{articleId}/{translationId}/result.json
translations/{articleId}/{translationId}/content.html
```

D1 只保存 R2 object key、hash、字节数和 MIME type。正文及翻译对象默认不公开，通过鉴权后的 API Worker 读取。最终翻译对象启用版本化命名，不原地覆盖。

### 4.3 核心表

主要表包括：

- `feeds`、`subscriptions`、`articles`、`article_states`
- `prompts`、`preferences`
- `thinking_sessions`、`thinking_events`
- `article_classifications`
- `article_parse_tasks`
- `translations`、`translation_attempts`、`translation_batches`
- `article_types`、`prompt_definitions`、`prompt_versions`、`prompt_change_logs`
- `ai_profile_versions`、`system_config_versions`
- `admin_audit_logs`

`translations` 至少保存：文章、目标语言、文章类型、状态、原文 hash、译文标题、Prompt 版本、AI Profile 版本、R2 result key、重试次数和完成时间。

`article_classifications` 至少保存：文章、分类、置信度、译文标题、原文 hash、分类 Prompt/Profile 版本、正文采样算法与配置版本、采样片段数、采样 manifest hash 和估算输入 token 数，以便在不持久化重复采样正文的前提下复现输入。

翻译任务状态至少包括 `pending`、`running`、`completed`、`failed`、`cancel_requested`、`cancelled` 和 `superseded`。失败重试不创建新的逻辑翻译版本，而是在 `translation_attempts` 中追加一次执行记录并复用原 translation ID、source hash、Prompt 版本和 AI Profile 版本。只有管理端使用新配置重新翻译时才创建新的 translation，并保存 `parent_translation_id`、触发原因和操作者。

同一翻译版本的幂等键为：

```text
article_id + target_locale + source_hash + article_type
+ prompt_version + title_profile_version + body_profile_version
```

除结果版本幂等键外，再建立 `article_id + target_locale + source_hash` 的活跃任务唯一约束，仅约束 pending/running/cancel_requested 状态。C 端创建首次任务或重试失败任务时，必须在同一 D1 事务中确认不存在 completed 结果和活跃任务；Admin Worker 创建重试或重翻任务时也必须遵守活跃任务唯一约束。

## 5. 文章分类与提示词管理

### 5.1 文章类型

首版内置以下稳定枚举：

- `technical`：技术文章、开发文档、论文解读、工程实践。
- `news`：新闻、事件报道、行业动态、公告。
- `general`：无法可靠归入前两类的通用内容，也是默认回退类型。

分类结果保存分类、置信度、分类理由摘要、分类 Profile 版本及时间。置信度低于后台阈值或返回非法类别时回退到 `general`，不得阻断后续翻译。

### 5.2 Prompt 版本

提示词不存放在 Worker env。管理端允许新增、编辑和删除提示词；D1 使用“可变定义 + 不可变版本 + 变更日志”实现：

- `classification`
- `title_translation`
- `body_translation`
- `body_repair`

`classification` 和 `title_translation` 在得出文章类型之前执行，因此按“任务 + 目标语言”保存全局 Prompt，不绑定单一文章类型；其中包含三类文章的判断标准和标题翻译要求。`body_translation` 和 `body_repair` 在分类完成后按“文章类型 + 任务 + 目标语言”选择 Prompt。

具体规则：

- 新增提示词时创建 `prompt_definitions` 记录及第一个 `prompt_versions` 版本。
- 编辑提示词时不原地覆盖历史内容，而是创建新版本并更新 definition 的当前版本引用；管理端表现为正常编辑操作。
- 删除提示词采用软删除，definition 标记 `deleted_at`，其历史版本和已生成翻译的引用永久保留。被删除的当前提示词必须先指定同组合的替代版本，否则拒绝删除。
- 每个有效配置键最多有一个生效版本：分类/标题使用“任务 + 目标语言”，正文/修复使用“文章类型 + 任务 + 目标语言”；其余版本为 draft、archived 或 deleted。
- 每次新增、编辑、删除、发布和回滚都追加 `prompt_change_logs`，记录 action、definition、前后版本、操作者 subject/email、时间及可选变更说明；日志不可通过管理 API 修改或删除。
- 支持查看版本差异、回滚和基于指定文章的测试运行。回滚同样创建新的当前版本或重新指向历史不可变版本，并写入变更日志。

### 5.3 管理后台

部署独立的 Admin Web 与 Admin API Worker。访问权仅由 Cloudflare Zero Trust 中的 Admin Access Application 和管理员 Policy 决定，应用本身不提供管理员账号、邀请、角色或允许名单配置。管理端用于：

- 管理文章类型及分类说明。
- 新增、编辑、软删除、测试、发布和回滚 Prompt，并查看完整版本及变更日志。
- 配置分类置信度阈值。
- 配置分类与标题翻译使用的正文采样 token 预算、分段数量和采样算法版本。
- 管理 AI Profile 的 Provider、endpoint、model、token 上限和参数。
- 查看翻译任务、失败批次、Provider 错误和费用相关统计。
- 对单篇或选定文章触发重新分类、重翻标题或重翻正文。

所有配置和任务控制操作写入审计记录，包含 Access subject/email、动作、目标、旧值摘要、新值摘要、request ID 和时间。管理人员名单的变化由 Cloudflare Access 自身审计，不复制到应用审计表。

## 6. AI Provider 与功能路由

### 6.1 AI Profile

首版设置两个独立 Profile：

| Profile   | 功能                 | 目标                                 |
| --------- | -------------------- | ------------------------------------ |
| `fast`    | 文章分类、标题翻译   | 低成本、低延迟、稳定结构化 JSON      |
| `quality` | 正文翻译、失败块修复 | 长上下文、指令遵循、排版标记保持能力 |

`ai_profile_versions` 保存 Provider、endpoint、model、最大输出 token、协议类型及采样参数。运行时只支持 OpenRouter，Provider 固定为 `openrouter`，endpoint 固定为 `https://openrouter.ai/api/v1`。`fast` 与 `quality` 共享 OpenRouter Key，但可分别选择不同的 `vendor/model` 模型。

OpenRouter 通过 OpenAI-compatible Chat Completions 协议接入：

- 管理端只配置 model、最大输出 token 和允许的采样参数，不允许填写 Provider 或任意 endpoint。
- 发布 Profile 版本前执行轻量连通性和模型权限测试，Key 或模型权限不匹配时拒绝激活并返回明确诊断。
- 适配器统一处理 SSE 增量、非流式响应、usage、finish reason、限流和上游错误；上游扩展字段不得泄漏到业务 API。
- 当前翻译场景仅依赖文本模型，不纳入多模态、BYOK、供应商路由或 Responses API。带 `:batch` 后缀的模型通过 `/api/beta/batches` 异步提交和轮询，普通模型继续使用 Chat Completions。

### 6.2 密钥管理

API Key 只保存为 Worker Secrets：

```text
OPENROUTER_API_KEY
```

D1 不保存明文密钥，管理 API 不返回密钥。`fast` 与 `quality` 共享 `OPENROUTER_API_KEY`；若密钥不可用，任务失败为可重试状态。审计日志只记录固定 Provider、模型和 Profile 版本，不记录 Key。

### 6.3 分类与标题调用

分类和标题翻译默认合并为一次 `fast` Profile 请求。请求不得发送完整正文，只发送原始标题、Feed 标题/类别、文章摘要及经过确定性分散采样的部分正文，以降低输入 token 消耗。

正文采样规则：

- 采样基于正文解析完成后的纯文本和段落边界，不直接截取原始 HTML，也不在 Unicode 字符、HTML 标记或句子中间切断。
- 默认正文采样预算为约 3000 个模型输入 token，可在管理端配置，但必须受到系统级最小值和最大值约束。
- 预算的 25% 用于正文开头、15% 用于正文结尾，其余 60% 分配给正文中均匀分布的四个采样窗口；窗口按段落边界向外扩展并去除重叠内容。
- 标题、Feed 元数据和短摘要不占正文采样窗口数量，但计入该次 AI 请求的总输入上限。
- 短文章在预算内时使用完整纯文本；长文章只使用采样结果。
- 采样必须是确定性的：相同 source hash、采样配置和算法版本始终生成相同输入，不使用随机抽样。
- 采样文本使用带序号的片段结构，并明确标记其在文章中的相对位置，避免模型误认为片段彼此连续。
- 若正文为空或有效采样不足，只使用标题、Feed 元数据和摘要；分类低置信度时回退 `general`，不得为提高置信度自动发送完整正文。

请求返回严格 JSON：

```json
{
	"articleType": "technical",
	"confidence": 0.93,
	"translatedTitles": {
		"zh-CN": "中文标题",
		"en-US": "English title",
		"ja-JP": "日本語タイトル"
	}
}
```

Worker 校验枚举、置信度及中英日三个非空标题。无效响应最多修复重试一次；仍失败时分类回退 `general`，三个标题均保持原文并记录可单独重试状态。

分类记录同时保存 `source_hash`、采样算法版本、采样配置版本、采样片段数量、估算输入 token 数和采样 manifest hash。采样正文内容不重复写入 D1，也不记录到日志；需要复现时根据 R2 原文和 manifest 中的段落/字符范围重新生成。

### 6.4 正文翻译

正文使用 `quality` Profile，继续沿用现有结构化 block、受保护内容标记和 HTML 内联标记规则。每个批次独立校验，只重试失败块，最多三次。成功批次立即写入 R2 partial object 和 D1 批次状态。

## 7. 持久化翻译工作流

### 7.1 触发策略

- 文章抓取并解析完成后，自动执行分类和标题翻译。
- 正文翻译默认按需触发：用户第一次切换到译文或双语模式时创建任务。
- C 端请求翻译时，优先返回该文章和目标语言已有的最新 `completed` 结果；若存在 `pending/running` 任务，则返回该任务并等待完成。不得因为当前激活的 Prompt、模型或 Provider 版本与已有结果或任务不同而自动创建新任务。
- 只有文章和目标语言从未创建过正文翻译任务时，C 端请求才允许创建首次任务，并固定使用创建时的激活配置版本。
- 存在 `completed` 结果时，C 端始终复用结果且不显示重试；存在 `pending`、`running` 或 `cancel_requested` 活跃任务时，C 端等待该任务且不显示重试。
- 只有不存在 completed 结果和活跃任务，且最近逻辑翻译状态为 `failed`、`cancelled` 或 `superseded` 时，C 端才允许执行失败重试。重试复用原 translation ID 和创建时固定的 source hash、Prompt/Profile 版本，只新增 `translation_attempts` 记录，不切换到当前激活配置，也不构成重新翻译。
- C 端失败重试必须设置最大次数和退避时间；达到后台配置的重试上限后只展示失败状态，由管理人员处理。
- 使用当前新配置重新翻译、运行任务强制重启及批量重翻只能由 Admin API Worker 发起。管理操作创建的新翻译必须引用原任务并记录原因，不覆盖历史任务或结果。
- 客户端退出、断网或请求取消不取消服务端翻译任务。

### 7.2 工作流步骤

1. 读取 Article 元数据和 R2 原文，校验 `source_hash`。
2. 获取现有分类结果；不存在时按固定采样预算从正文头部、中间多个位置和尾部生成确定性片段，再执行分类与标题翻译。该步骤禁止发送完整长正文。
3. 固定本次任务使用的 Prompt 和 AI Profile 版本。
4. 创建翻译计划和批次记录。
5. 分批调用 `quality` Profile。
6. 增量解析并校验块 ID、顺序、HTML 标记和受保护 token。
7. 将成功批次写入 R2，失败块按修复 Prompt 重试。
8. 合并所有批次，重新执行完整文档校验。
9. 原子发布最终 R2 object，并将 D1 状态设为 `completed`。
10. 清理过期 partial object；失败任务保留诊断和重试入口。

### 7.3 配置和原文变化

- 已完成结果永久保留，不因 Prompt、模型或 Provider 变化自动覆盖。
- 发布新的 Prompt、模型或 Provider 配置时，不扫描历史文章，不创建翻译任务，不取消、重启或修改 `pending/running` 任务，也不将已完成结果自动标记为过期。
- 发布新的正文采样预算、窗口数量或采样算法配置时，同样不重新分类、不重翻标题，也不影响已有或运行中的任务；仅用于之后新创建的分类任务和管理人员显式重新分类。
- 已有任务始终使用创建时固定的 Prompt 和 AI Profile 版本执行至结束；配置发布不会改变任务中途使用的模型或提示词。
- 新配置仅用于没有现有结果时正常创建的新任务，以及 owner 在管理后台显式发起的重新翻译任务。
- C 端继续使用最新已完成结果，不根据当前激活配置版本判断是否需要重新翻译。
- 原文 hash 改变后旧翻译成为历史版本，新请求生成新任务。
- 管理端可显式执行单篇或批量重翻；新结果完成前继续提供旧结果。C API 只暴露受状态和次数约束的失败 retry，不暴露使用新配置的 retranslate 或运行任务 restart 能力。

### 7.4 正文解析权限

- 新文章入库后由 Article Queue 自动创建一次初始正文解析任务。
- C 端只能查询解析状态和读取成功结果，不能主动 reparse、retry、restart 或改变解析器版本。
- 初始解析失败时，C 端展示失败状态；只有管理人员可在管理域名查看诊断并执行解析重试。
- 对已经成功解析的文章重新解析、指定新解析器版本或批量重解析，只能通过 Admin API 发起。
- 同一文章同时最多存在一个活跃解析任务；管理端重启运行中任务时必须先将旧任务标记为取消请求，并在安全批次边界结束后创建新任务。
- 解析任务及结果保留 parser version、触发来源、父任务、操作者和 request ID，重新解析不得覆盖历史正文对象。

## 8. 对外 API

C 端和管理端两个应用使用不同域名和 Access audience。C 端接口保留 `/api/v1` 前缀，管理端使用 `/api/admin/v1` 前缀；另设没有 UI 的 GPT Actions API 域名及 Worker，使用 `/gpt-actions/v1` 前缀。三个公开接口面独立部署和鉴权，不以运行时角色判断复用同一个公开路由。

新增或调整的主要接口：

```text
GET  /api/v1/me

POST /api/v1/articles/{id}/translations
GET  /api/v1/articles/{id}/translations
GET  /api/v1/translations/{id}
GET  /api/v1/translations/{id}/result
POST /api/v1/translations/{id}/retry

GET  /openapi.json
GET  /gpt-actions/v1/articles
POST /gpt-actions/v1/articles
POST /gpt-actions/v1/subscriptions
POST /gpt-actions/v1/library/categories
GET  /gpt-actions/v1/articles/{id}
GET  /gpt-actions/v1/articles/{id}/content
GET  /gpt-actions/v1/articles/{id}/translations
POST /gpt-actions/v1/articles/{id}/translations
GET  /gpt-actions/v1/translations/{id}
GET  /gpt-actions/v1/translations/{id}/result
POST /gpt-actions/v1/translations/{id}/retry

GET    /api/admin/v1/article-types
GET    /api/admin/v1/prompts
POST   /api/admin/v1/prompts
PATCH  /api/admin/v1/prompts/{id}
DELETE /api/admin/v1/prompts/{id}
GET    /api/admin/v1/prompts/{id}/versions
GET    /api/admin/v1/prompts/{id}/changes
POST   /api/admin/v1/prompts/{id}/test
POST   /api/admin/v1/prompts/{id}/activate
GET    /api/admin/v1/ai-profiles
POST   /api/admin/v1/ai-profile-versions
POST   /api/admin/v1/ai-profile-versions/{id}/activate
GET    /api/admin/v1/tasks
GET    /api/admin/v1/tasks/{id}
POST   /api/admin/v1/translations/{id}/retry
POST   /api/admin/v1/translations/{id}/restart
POST   /api/admin/v1/articles/{id}/retranslate
POST   /api/admin/v1/articles/{id}/reparse
POST   /api/admin/v1/articles/{id}/parse-retry
```

C 端首次创建翻译或成功接受失败重试时返回 `202 Accepted` 和同一个逻辑翻译 ID；已有完成结果返回 `200 OK`；已有运行任务返回 `202 Accepted` 和同一个任务 ID。对 completed 或活跃任务调用 retry 返回 `409 translation_not_retryable`；超过 C 端重试上限返回 `409 retry_limit_reached`。客户端轮询任务状态并按已完成 block 展示进度；最终结果通过鉴权接口读取。所有写接口接受幂等键，错误统一返回 `code`、`message` 和 `requestId`。

C API 不提供文章 reparse、解析 retry、翻译 restart 或 retranslate 路由；只提供严格受状态、退避和次数限制的失败翻译 retry。即使调用者同时具备管理员身份，强制重启、使用新配置重翻和正文重新解析也必须通过管理域名和 Admin Access Application 执行。

### 8.1 GPT Actions 兼容约束

这里的“兼容 OpenAI”具体指兼容自定义 GPT 的 GPT Actions：提供可由 GPT Builder 导入的 OpenAPI 3.1 文档和普通 HTTPS JSON REST API，而不是实现 `/v1/chat/completions`、`/v1/responses` 或伪装成模型 Provider。

- `/openapi.json` 作为版本控制内的接口事实来源，声明唯一且稳定的 `operationId`、清晰的自然语言描述、OAuth 2.0 安全方案、请求/响应 schema、枚举、错误码和服务器域名；在 CI 中执行语法、引用和破坏性变更检查。
- Action 提供分类创建、订阅源添加、单篇文章添加、文章检索、文章详情、分段正文读取、翻译状态/结果读取、首次翻译创建和符合 C 端规则的失败重试。它与 C API 调用同一业务用例层和状态机，不能复制一套较宽松的判断逻辑。
- 不在 Action schema 中声明订阅源或分类的编辑/删除、Prompt/Profile 管理、重翻、强制重启、正文重新解析或其他管理操作。GPT Actions API Worker 不绑定管理端专属 Service Binding 和 Secrets，从部署权限上阻止越权。
- 列表必须分页；正文和翻译结果按有上限的 `cursor`/`limit` 分段返回，不提供公开 R2 URL，不在单次响应中返回不可控长度的大正文。接口只返回 JSON，不依赖 SSE、HTML 页面或长连接。
- 创建或重试翻译为异步操作，沿用 C API 的 `200`/`202`/`409` 状态语义并立即返回 translation/task ID、状态和建议轮询间隔；自定义 GPT 通过状态接口轮询，不等待 Worker 内完成 AI 调用。
- 所有写操作要求 `Idempotency-Key`；所有响应包含 `requestId`，错误使用稳定的机器可读 `code`。文章搜索和读取结果应提供适合模型理解的字段说明，不把内部 Prompt、Provider Key、原始 AI 响应或管理审计信息暴露给 Action。
- 仓库交付一份可直接导入 GPT Builder 的 OpenAPI 文件和一份配置说明，说明服务器地址、API Key 设置、推荐的 GPT Instructions、能力范围及密钥轮换步骤。

## 9. 客户端改造

- 将现有前端拆分为两个独立应用和构建产物：C 端应用部署到 C 端域名，Admin Web 部署到管理域名；两者使用独立环境配置、Access audience、路由和 API client。
- 将现有邮箱密码页面替换为 Google/GitHub 登录入口。
- C 端 Web 与 Admin Web 分别适配各自 Access Cookie；Android 只适配 C 端 Managed OAuth、PKCE、系统浏览器回调和安全 token 存储。
- 删除用户自定义 Provider、API Key、endpoint 和 model 的设置 UI及缺少 API Key 弹窗。
- 删除客户端直接调用第三方 AI Provider 的代码。
- 翻译服务改为创建远程任务、查询进度和读取永久结果。
- C 端删除使用新配置重翻、运行任务重启和正文重新解析入口；仅在翻译状态为 failed/cancelled/superseded、没有完成结果或活跃任务且未超过重试上限时显示“重试”。
- Admin Web 提供 Prompt 增删改与变更日志、Provider/Profile 配置、任务进度、翻译重试/重启/重翻以及正文解析重试/重解析功能。
- 本地数据库只保留结果缓存，不再作为翻译事实来源；缓存可随时从服务端恢复。
- 保留现有翻译 block 渲染、双语模式、标记校验和部分进度展示体验。
- 自定义 GPT 不作为第三个前端项目；其集成产物仅为 GPT Actions API、OpenAPI 3.1 文件和 GPT Builder 配置说明。

## 10. 安全、可靠性与可观测性

- Content Fetcher 继续执行逐跳 DNS/IP 检查、SSRF 防护、默认端口限制、请求超时和响应大小限制。
- AI、R2、D1、Queue 和管理能力使用最小权限 bindings；不同 Worker 不共享无关 Secrets。
- 日志禁止记录 access token、OAuth token、API Key、完整 Prompt、完整文章正文和完整 AI 响应。
- 所有请求、Workflow 和 Queue message 使用统一 request ID / trace ID。
- Queue 配置有限重试和 Dead Letter Queue；翻译批次具备幂等写入能力。
- 为 AI Provider 记录调用次数、延迟、输入输出 token、错误类型和 Profile 版本，但不记录敏感正文。
- 首版不启用按用户限流；仍应配置任务并发上限和每日费用告警，防止错误循环消耗 AI 额度。
- GPT Actions API 单独配置请求速率、单日写操作次数、翻译并发和费用上限，防止模型循环调用；达到限制时返回明确的 `429` 及可重试时间。该机器调用入口不适用“首版不按 C 端用户限流”的豁免。
- C 端与管理端分别拒绝 audience 不匹配的 assertion；C 端凭证不能调用 Admin API，Admin 操作也不通过 C API 暴露。
- 管理人员名单仅存在于 Cloudflare Access Policy；Admin Web 和 D1 不提供修改管理员名单的能力。
- C/Admin 页面、各自业务 API 和经它们读取的 R2 内容全部拒绝未通过对应 Access Application 的请求；GPT Actions API 及其受限内容读取只接受由本服务签发且未撤销的 OAuth access token。
- GPT Actions API 拒绝固定 API Key 和 C/Admin Access 凭证。Action 请求不得访问 Admin Worker、管理端 R2 路径或配置管理用例。

## 11. 实施阶段

### 阶段一：Cloudflare 基础设施与认证

- 建立 C API、Admin API、Content Fetcher Worker、D1、R2、Queues/Workflows 和 Service Bindings。
- 建立 C 端与 Admin Web 两个独立前端构建、域名和 Access Application。
- 建立 GPT Actions API Worker、独立域名和最小权限 Service Bindings，配置 OAuth Client Secret 与严格回调地址白名单。
- 配置 Google/GitHub Access、C 端用户 Policy、管理员 Policy、各自 Web Cookie 和 C 端 Android Managed OAuth。
- 实现 audience 隔离、GPT OAuth session 到 `account_id` 的映射、管理操作身份提取、CORS、错误结构和请求追踪。

### 阶段二：D1/R2 业务 API

- 创建全新 D1 schema 和迁移脚本。
- 移植 Feed、Article、状态、Prompt、偏好和思考训练 API。
- 实现 R2 原文读写及受保护下载接口。
- 部署 Workers Static Assets，替代 Go 静态文件服务。
- 实现 GPT Actions 的分类创建、订阅源添加、单篇文章添加、文章检索、受限分段读取、翻译查询/创建/失败重试接口，生成并校验可直接导入 GPT Builder 的 OpenAPI 3.1 文件。

### 阶段三：抓取与后台任务

- 将 Go scheduler 替换为 Cron Trigger。
- 将 PostgreSQL jobs 替换为 Feed/Article Queues 和 DLQ。
- 移植 RSS 解析、Readability、HTML 清洗、公式、SVG、媒体和代码块处理。
- 使用固定样本对 Go 与 Worker 解析结果进行双跑比较。

### 阶段四：AI 配置和永久翻译

- 实现 OpenRouter 单 Provider 适配器和 `fast`/`quality` Profile 路由，统一处理 OpenAI-compatible 流式响应和参数白名单。
- 建立文章类型、Prompt 增删改、不可变版本、变更日志、Profile 版本及独立 Admin Web。
- 实现分类、标题翻译、正文翻译 Workflow、R2 partial/final 结果和 D1 状态机。
- 改造 C 端首次翻译、受限失败重试、进度查询和结果缓存，并移除使用新配置重翻、强制重启与正文重解析入口。

### 阶段五：验证和下线

- 完成 Web/Android 端到端测试、故障注入、安全测试和费用压测。
- 在测试用自定义 GPT 中导入 OpenAPI 文档，完成检索、分段读取、首次翻译、状态轮询和受限失败重试的端到端验收。
- 验证任务恢复、重复请求幂等、Provider 切换、Prompt 回滚及永久结果恢复。
- 删除旧认证、旧 AI 配置和客户端本地事实来源。
- 切换正式域名后下线 Go 服务、Docker Compose 和 PostgreSQL。

## 12. 测试与验收标准

必须覆盖：

- Google、GitHub 登录成功；未获对应 Access Policy 允许的身份始终被拒绝；获准的两种 C 端身份读取同一 `owner` 数据。
- C 端与管理端使用不同域名、Access Application 和 audience；C 端 assertion 不能调用 Admin API，管理人员名单只能在 Cloudflare 后台变更。
- C 端 Web、Admin Web Cookie 和 Android C 端 access/refresh token 均能在过期后按各自会话策略恢复。
- GPT Builder 可以直接导入 `/openapi.json`；所有 `operationId` 唯一稳定，schema 校验通过，Action 使用有效 API Key 可映射到 `owner`，缺失、错误或已轮换 Key 均被拒绝。
- GPT Actions API 只能调用约定的 C 端能力；不能访问 Prompt/Profile、管理任务、重翻、强制重启、reparse 或 parse-retry，且 OAuth access token 对 C API 和 Admin API 无效。
- 文章正文和翻译结果按上限分页/分段返回；Action 的翻译创建与重试立即返回异步任务信息，重复写请求保持幂等，轮询可最终取得永久结果。
- GPT Actions API 的速率、每日写次数、并发和费用限制生效，循环调用返回可解释的 `429`，不会重复创建翻译任务或绕过 C 端不可重试状态。
- Feed 定时抓取、手动刷新、重复调度、重试和 DLQ 行为正确。
- SSRF、重定向到私网、大响应、错误 Content-Type 和超时均被拦截。
- 技术、新闻、通用分类正确处理；低置信度和非法输出回退 `general`。
- 分类与标题翻译不发送超出配置预算的完整长正文；长文章按头部、四个均匀中间窗口和尾部确定性采样，短文章使用完整正文，相同输入始终生成相同 manifest hash。
- 采样窗口按段落和 Unicode 边界生成、无重叠；正文为空、片段不足及预算边界均按规定回退，日志和 D1 不包含完整采样正文。
- `fast` 与 `quality` Profile 独立切换，密钥不出现在 API、日志或 D1。
- `fast` 与 `quality` 均可选择阿里云百炼 Qwen；正确地域、Workspace、模型和 Key 能完成流式及非流式调用，地域不匹配、无模型权限、非法 endpoint 和不支持的模型会在测试或激活阶段被明确拒绝。
- Qwen thinking 默认关闭；显式启用时参数只发送给支持的模型，thinking token 纳入用量统计，专属扩展字段不会改变内部统一响应或泄漏到 C/GPT Actions API。
- Prompt 新增、编辑、软删除、发布和回滚正确；每次操作生成不可修改的版本及变更日志，被翻译结果引用的历史版本不会被删除。
- Prompt、模型或 Provider 配置发布后，不自动创建、取消或重启翻译任务；运行中任务继续使用创建时版本，C 端继续复用已有完成结果。
- 客户端退出后正文翻译继续执行，重连后可以恢复进度并读取最终结果。
- C 端可创建首次翻译，并可在没有 completed 结果或活跃任务时重试 failed/cancelled/superseded 翻译；重试沿用同一 translation ID 和原配置版本，只追加 attempt，且受最大次数与退避约束。
- completed、pending、running、cancel_requested 状态下 C 端重试均返回明确的不可重试错误；C 端不能调用翻译 restart/retranslate 或文章 reparse/parse-retry，对应操作只有 Admin API 可执行并写入审计日志。
- 重复创建相同翻译只产生一个有效任务和一个最终结果；管理端重翻生成关联的新版本而不覆盖旧结果。
- 原文、Prompt 或 Profile 版本变化会生成新结果，旧版本仍可恢复。
- 标题、正文块、受保护 token、HTML 标签、公式、代码块、图片及双语排版通过现有校验。
- D1 不保存超过限制的正文；R2 对象默认不可公开访问。
- 根项目 TypeScript、Worker typecheck、Vitest、集成测试和 Android 构建全部通过。

上线验收完成的定义：C 端与管理端已拆分为独立域名、应用和权限面；自定义 GPT 可通过独立、受限且通过 OpenAPI 描述的 GPT Actions API 完成约定的 C 端操作；客户端日常使用不再依赖 Go 服务或 PostgreSQL；所有文章和翻译可从 Cloudflare 持久层恢复；Provider、模型和 Prompt 均可在 Admin Web 变更且无需发布客户端；管理人员仅通过 Cloudflare Access 后台配置。

## 13. 默认决策与非目标

- 系统为单一逻辑用户，但 schema 保留 `owner_id` 以降低未来扩展成本。
- C 端与管理端是两个独立应用、独立域名和独立 Cloudflare Access Application；Android 仅提供 C 端。
- GPT Actions API 是无 UI 的独立 Worker/域名，不计作第三个前端应用；首版使用只供本人自定义 GPT 使用的独立 API Key，并固定映射到 `owner`。
- 管理人员完全由 Cloudflare Access Policy 配置，应用不实现管理员用户表、管理员邀请或 RBAC 管理界面。
- 不迁移任何现有服务端数据、用户、密码、会话或客户端 AI 密钥。
- 正文翻译按需执行；分类和标题翻译在文章解析完成后自动执行。
- 已完成翻译永久保存；Prompt、模型或 Provider 配置变化不自动触发任何历史重翻，也不影响运行中的任务。只有通过 Admin Access Application 授权的管理人员显式重新翻译时才使用新配置生成新版本。
- C 端可创建首次正文翻译，也可在没有完成结果和活跃任务时有限重试失败、已取消或已中止的翻译；不得重试已完成或进行中的翻译，不得使用新配置重翻或强制重启。正文解析重试和重新解析仍仅限管理端。
- 首版文章类型固定为 technical、news、general。
- 分类与标题翻译只使用标题、Feed 元数据、摘要和部分分散正文；默认正文采样预算约 3000 输入 token，采用头部 25%、四个中间窗口合计 60%、尾部 15% 的确定性采样。采样配置变化不自动重新分类或重翻标题。
- 首版 AI Profile 固定为 fast、quality，OpenRouter 模型与参数可配置并版本化。
- 首版只支持 OpenRouter，两个 Profile 共享 Worker Secret `OPENROUTER_API_KEY`，endpoint 固定为 `https://openrouter.ai/api/v1`。
- 首版不实现公开注册、多租户、用户自带 API Key、按用户计费或应用内管理员/RBAC 管理。
- GPT Actions 兼容目标是 OpenAPI 3.1 REST Action，不实现 OpenAI Chat Completions/Responses 兼容层；Action 权限不超过 C 端，且不提供订阅修改与任何管理能力。
- 首版不以 Worker env 保存长 Prompt，也不在 D1 中保存明文 AI API Key。
