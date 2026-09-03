# FeedMind GPT Builder 配置

## 导入 Action

1. 在 GPT Builder 的 Actions 中导入 `https://actions.feedmind.cc/openapi.json`，或上传仓库内的 `openapi.json`。
2. Authentication 选择 **OAuth**。
3. OAuth 字段填写：
   - Client ID：`feedmind-chatgpt-action`
   - Client Secret：与 Worker Secret `GPT_OAUTH_CLIENT_SECRET` 完全相同的值
   - Authorization URL：`https://actions.feedmind.cc/oauth/authorize`
   - Token URL：`https://actions.feedmind.cc/oauth/token`
   - Scope：`feedmind.read feedmind.write offline_access`
   - Token Exchange Method：默认（POST 请求）
4. 将 Builder 显示的 OAuth 回调 URL 原样加入 C API Worker Secret `GPT_OAUTH_REDIRECT_URIS`；多个地址用英文逗号分隔。
5. 保存后先执行登录授权，再分别测试新建分类、添加订阅源、添加单篇文章、文章搜索、正文分段读取、首次翻译、状态轮询和译文分段读取。

## 推荐 Instructions

```text
你可以使用 FeedMind Action 管理内容入口，并检索和阅读我的 FeedMind 文章。
用户要求添加分类时，调用 createLibraryCategory；添加 RSS/Atom 订阅源时调用 addSubscriptionFeed；添加普通网页文章时调用 addArticle。
添加订阅源时可以传已有 categoryId；如果用户只提供分类名，也可以通过 category 创建或复用分类。不要把普通文章 URL 当成 RSS 源。
每次写操作在 JSON 请求体的 `idempotencyKey` 字段生成一个新值；仅在重试同一逻辑请求时复用，不能把同一个值用于不同请求。不要尝试发送自定义请求头，因为 GPT Actions 不支持自定义请求头。
列表和正文必须遵循分页：当 nextCursor 不为空时，只有确有必要才继续读取下一段。
请求翻译前先查询该文章的翻译状态。创建翻译后不要等待长连接；按 pollAfterSeconds 建议轮询状态。
completed 结果直接复用。failed、cancelled 或 superseded 只能通过对应 translationId 的 retry 操作尝试受限重试。
不要声称能够编辑或删除订阅与分类，也不要声称能够管理提示词、模型、Provider、重新解析文章、强制重启或使用新配置重翻，因为 Action 没有这些权限。
遇到 409 或 429 时向用户解释 error.code 和 message，不要循环重试。
```

## 能力边界

- 可用：新建分类、添加 RSS/Atom 订阅源、添加单篇网页文章、分页检索文章、读取文章元数据、分段读取正文、查看翻译状态、首次创建翻译、符合 C 端状态机的失败重试、分段读取完成译文。
- 不可用：编辑或删除订阅与分类、Prompt/Profile 管理、管理审计、重新解析、重新分类、强制重启、取消任务、使用新配置重翻。
- 每位用户通过 OAuth 登录后映射到自己的 FeedMind `account_id`，数据、幂等记录和每日限额彼此隔离。

## OAuth Client Secret 轮换

1. 生成新的高熵随机值。
2. 执行 `pnpm --dir workers/gpt-actions-api exec wrangler secret put GPT_OAUTH_CLIENT_SECRET` 并输入新值。
3. 立即在 GPT Builder 更新 Client Secret 并重新登录测试。
4. 旧值更新后无法再交换或刷新 token；现有 access token 最长还可使用一小时，如需立即全部失效，应在 D1 撤销现有 OAuth sessions。

## 费用与循环保护

Worker 默认限制为每分钟 60 次请求、每天 1000 次请求、50 次写操作、10 次翻译以及最多 2 个并发翻译。达到限制返回 `429`，GPT 不应自动循环规避。
