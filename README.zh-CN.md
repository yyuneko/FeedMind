# FeedMind

[English](README.md) | 中文

FeedMind 是一个需要登录、以服务端为业务数据源的 Expo RSS 阅读器，支持 Android、iOS 和 Web。

## 架构

- Go 服务端负责 RSS/Atom 拉取、文章正文提取与清理、PostgreSQL 公共缓存和账号数据。
- 订阅、提示词、已读、收藏和阅读设置可跨设备恢复。
- 客户端仅保留展示/离线缓存和当前设备的 AI 设置。
- DeepSeek、OpenAI、Anthropic 和 Gemini 翻译均由客户端直接请求。FeedMind 服务端不会收到 AI 服务商 API Key、所选模型或自定义接口地址。
- Android/iOS 使用系统安全存储保存 API Key；Web 使用当前站点的浏览器本地存储。

## 本地开发

1. 参考 `server/.env.example` 配置服务端，并设置强随机 `FEEDMIND_JWT_SECRET`。
2. 使用 `docker compose up --build` 启动 PostgreSQL 和服务端。
3. 将 `.env.example` 复制为 `.env`，按需修改 `EXPO_PUBLIC_FEEDMIND_API_URL`（只填写服务根地址，不要附加 `/api/v1`），然后运行 `pnpm start`。

Go 二进制支持 `FEEDMIND_MODE=all`、`api`、`scheduler` 或 `worker`。服务端只依赖 PostgreSQL，不要求 Redis。

## 隐私

AI 凭证和翻译结果只保存在当前设备，不进入账号同步、服务端日志或 FeedMind API 请求。
