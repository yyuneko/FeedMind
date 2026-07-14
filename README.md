# FeedMind

English | [中文](README.zh-CN.md)

FeedMind is an authenticated, server-backed RSS reader for Expo Android, iOS, and Web.

## Architecture

- The Go server fetches RSS/Atom feeds, extracts and sanitizes articles, caches public content in PostgreSQL, and stores account data.
- The optional Cloudflare HTML Fetcher provides a server-only fallback for article pages and RSS/Atom feeds that cannot be reached directly or return selected upstream statuses. Clients never access the Worker or receive its token.
- Users can restore subscriptions, prompts, read/starred states, and reading preferences across devices.
- The client keeps only display/offline caches and device-specific AI settings.
- DeepSeek, OpenAI, Anthropic, and Gemini translation requests are sent directly from the client. The FeedMind server never receives provider API keys, selected models, or custom endpoints.
- Android and iOS store API keys in system secure storage. Web stores them in the current site's browser storage.

## Local development

1. Copy `server/.env.example` and set a strong `FEEDMIND_JWT_SECRET`.
2. Start PostgreSQL and the API with `docker compose up --build`.
3. Copy `.env.example` to `.env`, adjust `EXPO_PUBLIC_FEEDMIND_API_URL` if needed (use the server root URL without `/api/v1`), and run `pnpm start`.

The Go binary supports `FEEDMIND_MODE=all`, `api`, `scheduler`, or `worker`. PostgreSQL is the only required server dependency; Redis is not required.

See [`workers/html-fetcher/README.md`](workers/html-fetcher/README.md) for Worker development, secret setup, deployment, and testing. When `FEEDMIND_HTML_WORKER_URL` and `FEEDMIND_HTML_WORKER_TOKEN` are unset, the server keeps its existing direct-fetch behavior.

## Privacy

AI credentials and translations remain on the current device and are never included in account sync, server logs, or FeedMind API requests.
