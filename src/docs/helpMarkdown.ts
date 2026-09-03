import type { Locale } from '@/i18n';

export const helpMarkdown: Record<Locale, string> = {
  zh: `# FeedMind 使用说明

## 登录与同步

FeedMind 通过 Cloudflare Access 登录。Web 使用受保护的 Access Cookie；Android 使用系统浏览器完成 Google 或 GitHub 登录，并以 OAuth 授权码 + PKCE 安全交换短期令牌。获准的身份统一映射到同一个阅读账户。

订阅、文章状态、阅读偏好、思考训练记录与翻译任务保存在 Cloudflare D1，文章正文和永久译文保存在私有 R2，可跨设备恢复。

## 翻译

分类、标题翻译和正文翻译都在后台 Worker 中运行。切换到译文或双语模式会创建首次翻译；退出应用不会中断任务。已有完成结果会直接复用，失败任务可在退避时间和次数限制内重试。

Provider、模型、API Key 和提示词只由独立管理台维护。客户端不会保存或直接调用第三方 AI Key，也不提供重新解析、强制重启或使用新配置重翻入口。`,
  en: `# FeedMind Help

## Sign-in and sync

FeedMind uses Cloudflare Access. Web uses the protected Access cookie. Android opens the system browser for Google or GitHub sign-in and uses OAuth Authorization Code with PKCE. Every allowed identity maps to the same reader account.

Subscriptions, article state, preferences, thinking sessions, and translation jobs are stored in Cloudflare D1. Article bodies and permanent translations are stored in private R2 and can be restored on another device.

## Translation

Classification, title translation, and body translation run in background Workers. Opening translation or bilingual mode creates the first job, and closing the app does not interrupt it. Completed results are reused; failed jobs can be retried within backoff and attempt limits.

Providers, models, API keys, and prompts are managed only in the separate Admin Web. The client neither stores provider keys nor calls AI providers directly.`,
  ja: `# FeedMind ヘルプ

## ログインと同期

FeedMind は Cloudflare Access を使用します。Web は Access Cookie、Android はシステムブラウザと OAuth Authorization Code + PKCE で Google または GitHub にログインします。許可された ID は同じ閲覧アカウントに対応します。

購読、記事状態、設定、思考トレーニング、翻訳ジョブは D1 に、本文と永続翻訳は非公開 R2 に保存され、端末間で復元できます。

## 翻訳

分類、タイトル翻訳、本文翻訳はバックグラウンド Worker で実行されます。アプリを閉じても処理は継続し、完了済み結果は再利用されます。Provider、モデル、API Key、Prompt は独立した管理画面だけで管理され、クライアントは AI Provider を直接呼び出しません。`,
};
