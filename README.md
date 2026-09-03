# FeedMind

English | [中文](README.zh-CN.md)

FeedMind is an Expo RSS reader backed by Cloudflare. Cloudflare Access provides authentication, D1 stores business metadata, R2 stores article bodies and immutable translation results, and Queues/Workflows run fetching, parsing, classification, and translation jobs.

## Architecture

- Client Web: `https://app.feedmind.cc`, same-origin API prefix `/api/v1`.
- Admin Web: `https://admin.feedmind.cc`, same-origin API prefix `/api/admin/v1`.
- GPT Actions: `https://actions.feedmind.cc/openapi.json`, API prefix `/gpt-actions/v1`.
- Google Reader API: `https://reader.feedmind.cc/api/greader.php`; it is public, uses revocable application passwords, and always exposes the user's local FeedMind source.
- Android: Cloudflare Access Managed OAuth with dynamic client registration and Authorization Code + PKCE.
- AI: an internal Worker routes requests through active D1 `fast` and `quality` profiles; provider keys exist only as Worker Secrets.

The former Go, Docker Compose, and PostgreSQL stack is retained only as migration rollback material and is no longer required by the current client.

## Quick start

```powershell
corepack enable
corepack prepare pnpm@11.11.0 --activate
pnpm install
Copy-Item .env.example .env
pnpm start
```

Run Android with `pnpm android`, or start the local Web UI with `pnpm web`. Localhost Web is for UI development because it does not receive the production Access assertion or same-origin Worker Service Binding; use `https://app.feedmind.cc` for the complete Web flow.

See the [Chinese local development guide](CLOUDFLARE/LOCAL_DEVELOPMENT.zh-CN.md), [deployment runbook](CLOUDFLARE/DEPLOYMENT_RUNBOOK.zh-CN.md), and [deployment status](CLOUDFLARE/DEPLOYMENT_STATUS.zh-CN.md).

## Verification

```powershell
pnpm typecheck
pnpm workers:typecheck
pnpm workers:test
pnpm test:translation
pnpm test:thinking
npx expo export --platform web
```

Build the Android acceptance APK with `pnpm build:apk`.
