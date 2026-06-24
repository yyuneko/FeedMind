# FeedMind

English | [中文](README.zh-CN.md)

FeedMind is an AI-powered RSS reader for collecting, reading, translating, and saving articles from RSS feeds. It helps you follow trusted sources, read in a focused interface, and keep your reading state in sync.

## Features

- RSS feed management and refresh
- Today, Feeds, Saved, and Settings sections
- Article content parsing and original-link opening
- DeepSeek AI translation
- Custom translation prompts
- Chinese, English, and Japanese UI languages
- Reading preferences such as theme, font size, and line height
- Sync for feeds, prompts, read states, and saved states

## App Configuration

Configure the following values in the app Settings screen:

- DeepSeek API Key: used for AI translation
- GitHub Token: used for sync
- GitHub Gist ID: used to identify the sync space

The GitHub Token should only have read/write access to Gists. The DeepSeek API Key and GitHub Token are stored in local secure storage and are not written to the Gist.
