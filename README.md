# FeedMind

English | [中文](README.zh-CN.md)

FeedMind is an authenticated, server-backed RSS reader for Expo Android, iOS, and Web.

## Architecture

- The Go server fetches RSS/Atom feeds, extracts and sanitizes articles, caches public content in PostgreSQL, and stores account data.
- Users can restore subscriptions, prompts, read/starred states, and reading preferences across devices.
- The client keeps only display/offline caches and device-specific AI settings.
- DeepSeek translation requests are sent directly from the client. The FeedMind server never receives the provider API key, model, or custom endpoint.
- Android and iOS store API keys in system secure storage. Web stores them in the current site's browser storage.

## Local development

1. Copy `server/.env.example` and set a strong `FEEDMIND_JWT_SECRET`.
2. Start PostgreSQL and the API with `docker compose up --build`.
3. Set `EXPO_PUBLIC_FEEDMIND_API_URL=http://localhost:8080` and run `pnpm start`.

The Go binary supports `FEEDMIND_MODE=all`, `api`, `scheduler`, or `worker`. PostgreSQL is the only required server dependency; Redis is not required.

## Privacy

AI credentials and translations remain on the current device and are never included in account sync, server logs, or FeedMind API requests.
