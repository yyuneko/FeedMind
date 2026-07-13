import type { Locale } from '@/i18n';

export const helpMarkdown: Record<Locale, string> = {
  zh: `# FeedMind 使用说明

## 账号与同步

FeedMind 需要登录。订阅源、提示词、已读、收藏和阅读设置保存在 FeedMind 服务端，并可在多台设备恢复。RSS 拉取和文章正文解析均由服务端完成。

## AI 服务商 API Key

AI 翻译由当前设备直接请求所选的 DeepSeek、OpenAI、Anthropic 或 Gemini。FeedMind 服务端不会代理请求，也不会收到或保存 API Key、模型和自定义接口地址。

Android 和 iOS 使用系统安全存储；Web 使用当前站点的浏览器本地存储。界面不会完整回显 Key。请勿在截图、日志或公开仓库中暴露 Key。

升级时，旧 DeepSeek Key 会在本机迁移到新的 Provider 凭证结构；确认写入成功后才删除旧值。迁移失败不会阻止应用启动。

## 数据边界

翻译结果和 AI 配置属于设备级缓存，不跨设备同步。退出或切换账号会清理账号相关的内存缓存，避免不同账号的数据混用。`,
  en: `# FeedMind Help

## Account and sync

FeedMind requires an account. Subscriptions, prompts, read/starred states, and reading preferences are stored by the FeedMind server and restored across devices. RSS fetching and article extraction run on the server.

## AI provider API key

Translation requests go directly from this device to the selected DeepSeek, OpenAI, Anthropic, or Gemini service. The FeedMind server never proxies the request and never receives or stores API keys, models, or custom endpoints.

Android and iOS use system secure storage. Web uses this site's browser storage. The app never displays the complete key.

Legacy DeepSeek keys are migrated locally and removed only after the new credential is verified. A failed migration never blocks startup.

## Data boundary

Translations and AI settings are device-only caches and do not sync. Signing out or switching accounts clears account-scoped memory caches.`,
  ja: `# FeedMind ヘルプ

## アカウントと同期

FeedMind の利用にはログインが必要です。購読、Prompt、既読、スター、閲覧設定は FeedMind サーバーに保存され、複数端末で復元できます。RSS の取得と記事本文の解析はサーバーで行います。

## AI プロバイダー API Key

翻訳リクエストは端末から選択した DeepSeek、OpenAI、Anthropic、Gemini へ直接送信されます。FeedMind サーバーはリクエストを中継せず、API Key、モデル、カスタム Endpoint を受信・保存しません。

Android と iOS はシステムの安全なストレージを使用し、Web はこのサイトのブラウザストレージを使用します。旧 Key は新しい保存先を確認してから削除され、移行失敗は起動を妨げません。

翻訳結果と AI 設定は端末限定で、同期されません。`,
};
