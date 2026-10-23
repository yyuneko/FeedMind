# FeedMind MCP 连接

FeedMind 的 ChatGPT 集成仅提供远程 MCP，不再提供 GPT Actions/OpenAPI 接口。

## 连接信息

- MCP 服务地址：`https://actions.feedmind.cc/mcp`
- 认证方式：OAuth 2.0 Authorization Code + PKCE
- 发现元数据：`https://actions.feedmind.cc/.well-known/oauth-protected-resource/mcp`
- 读取权限：`feedmind.read`
- 写入权限：`feedmind.write`

在 ChatGPT 的 MCP/连接器配置中添加服务地址后完成 OAuth 登录即可。授权由 FeedMind C Web 发起，数据始终按登录账户隔离。

## 图片翻译工作流

MCP 服务返回的 instructions 已包含以下约束，连接端无需添加 Actions Schema：

1. 用户要求翻译文章时，正文和图片是同一个任务。保存正文译文后必须继续处理文章图片，图片检查和必要翻译完成前不得宣告整篇文章翻译完成。
2. 调用 `listArticleImages` 获取当前正文的图片 ID、URL、文章上下文和图片附近文字；翻译必须参考文章语境并保持术语、人名和语气一致。正文摘录不足时，先用正文读取工具继续分段读取。
3. 优先直接查看 URL；无法访问时调用 `readArticleImage` 即时转发。
4. 只处理静态 JPEG、PNG、WebP，并跳过照片、装饰图、Logo、无意义文字和所有动图。
5. 以模型实际看到的图片尺寸填写 `referenceWidth`、`referenceHeight`，所有矩形和字号使用该基准上的像素值。客户端不设置文本对齐或内边距，文本左上角和占用范围完全由 `x/y/w/h` 决定。
6. 调用 `saveArticleImageTranslation` 保存非空覆盖层，并为每次逻辑写入提供幂等键。

图片转发不会写入 R2。客户端仍加载文章原图，并按渲染尺寸缩放翻译覆盖层。

## 已移除接口

`/openapi.json` 和 `/gpt-actions/v1/*` 均返回 404。Worker 目录、部署名和历史 Secret 名保持不变，便于现有基础设施平滑升级。
