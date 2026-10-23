# FeedMind Cloudflare 生产部署状态

更新时间：2026-08-25（Asia/Shanghai）

## 已完成

- D1 `feedmind` 已应用 `0001` 至 `0006` 全部迁移；远程核验包含 8 个 Prompt 定义/版本、3 个文章类型和 3 组系统配置。
- R2 `feedmind-content`、Feed/Article Queues 与 DLQ、分类/正文翻译 Workflows 已配置。
- `feedmind-c-api`、`feedmind-admin-api` 和 `feedmind-ai-service` 均为内部 Worker，通过 Service Binding 调用，不暴露业务公网路由；Pipeline 直接抓取订阅源和文章页面。
- `app.feedmind.cc`、`admin.feedmind.cc` 和 `actions.feedmind.cc` 已部署；C/Admin Web 通过同源 `/api` 代理到各自内部 API。
- C/Admin Access 登录重定向已从公网验证，Audience 分别为：
  - C：`f657e874e6b31d81e7fdf718b688a37997f9e5a59b0ad7e0486ea06dc21a4acc`
  - Admin：`0fb1d330b27a750c38b95f813b38976cfcd497c37589612efdd0083bc9c73da9`
- ChatGPT 集成已迁移为 `https://actions.feedmind.cc/mcp`；`/openapi.json` 和 `/gpt-actions/v1/*` 不再公开，MCP 请求使用 OAuth access token 并按实际 `account_id` 隔离。
- C API 已提供 `/api/v1/me`、翻译状态、永久结果、图片翻译覆盖层和受限失败重试接口；Admin API 已按 `/api/admin/v1` 提供 Prompt changes/activate、AI Profile 版本 activate 与失败解析 `parse-retry`。
- 客户端不再保存 AI Key、Prompt、订阅、文章、状态或翻译事实，本地仅缓存阅读显示偏好。
- 根 TypeScript、全部 Worker 类型检查、74 个 Worker 测试、翻译 HTML 和思考模式验证通过；Expo Web 14 个静态路由导出与 Android 四架构 Release 构建均通过，本轮客户端改动另完成 arm64-v8a Release 重建。验收 APK 为仓库根目录 `FeedMind-arm64-v8a-release.apk`，已通过 v2 签名及生产域名检查，当前使用 Android Debug 证书，仅供验收安装。

## 当前部署版本

| Worker | Version ID |
| --- | --- |
| `feedmind-ai-service` | `2f8404f4-1f1c-49f1-bad1-f3b2629ceb9e` |
| `feedmind-translation-workflow` | `576a414c-1570-45e6-89b1-c57a26efd540` |
| `feedmind-pipeline` | `21a48ea6-03d3-4608-be95-80877a24951e` |
| `feedmind-c-api` | `1ebf889d-d168-4ec9-a467-35a751fc75e3` |
| `feedmind-admin-api` | `134f583b-b87f-4307-84d7-b7da34b347b0` |
| `feedmind-gpt-actions-api` | `25cf2c67-8e98-4f8a-aea8-5e28e5144f4a` |
| `feedmind-admin-web` | `759204c4-27c7-45ec-9771-ab66dfac3485` |
| `feedmind-c-web` | `9ee38558-ca14-4559-98c6-c580f1cb7eaf` |

## 完成生产验收前仍需的外部配置

1. C Access Application 的普通浏览器登录已生效，但 Managed OAuth 动态注册当前返回 `404`。需在 Advanced settings 开启 Managed OAuth 和 Dynamic Client Registration，允许精确回调 `feedmind://oauth`，Access token 设为 15 分钟、Grant session 设为 14 天。
2. AI Worker 尚无 `OPENROUTER_API_KEY`，D1 尚无 fast/quality OpenRouter Profile。需配置该 Secret，并为两个 Profile 选择 OpenRouter 模型。
3. 完成上述两项后，执行 Android 登录/刷新、真实 Feed 抓取分类、正文翻译永久恢复、Admin 配置发布，以及 GPT Action 在存在文章后的分段读取、首次翻译、轮询和失败重试全链路验收。
4. 若要分发正式 Android 版本，需提供并安全配置生产签名 keystore；当前 Debug 证书不得用于正式发布。

旧 `api.feedmind.cc` 仍指向原服务器，仅作为回滚入口；新客户端生产配置已改为 `https://app.feedmind.cc/api`。只有上述生产验收全部通过并结束回滚窗口后，才停止 Go、Docker Compose 和 PostgreSQL。
