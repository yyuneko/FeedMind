# FeedMind

[English](README.md) | 中文

FeedMind 是一个 AI 驱动的 RSS 阅读器，用于收集、阅读、翻译和收藏 RSS 文章。它可以帮助你持续关注可信来源，在专注的阅读界面中浏览内容，并同步阅读状态。

## 功能

- RSS 订阅源管理与刷新
- 今日、订阅源、收藏、设置等功能区
- 文章正文解析与原文链接打开
- DeepSeek AI 翻译
- 自定义翻译 Prompt
- 中文、英文、日文界面语言
- 主题、字号、行高等阅读设置
- 同步订阅源、Prompt、已读状态和收藏状态

## App 配置

App 内设置页需要配置：

- DeepSeek API Key：用于 AI 翻译
- GitHub Token：用于同步
- GitHub Gist ID：用于识别同步空间

建议 GitHub Token 只授予 Gists 的读写权限。DeepSeek API Key 和 GitHub Token 保存在本机安全存储中，不会写入 Gist。
