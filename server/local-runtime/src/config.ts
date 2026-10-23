import { existsSync, readFileSync } from "node:fs";

function secret(name: string, required = true): string {
  const environment = process.env[name]?.trim();
  if (environment) return environment;
  const path = `/run/secrets/${name.toLowerCase()}`;
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8").trim();
    if (value) return value;
  }
  if (required) throw new Error(`Required secret ${name} is not configured`);
  return "";
}

function value(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export const runtimeConfig = {
  port: Number(value("PORT", "8787")),
  databasePath: value("DATABASE_PATH", "./.local-data/db/feedmind.sqlite"),
  contentRoot: value("CONTENT_ROOT", "./.local-data/content"),
  migrationMode: value("MIGRATION_MODE", "normal"),
  accessTeamDomain: value(
    "ACCESS_TEAM_DOMAIN",
    "steep-credit-754a.cloudflareaccess.com"
  ),
  clientAudience: value(
    "C_ACCESS_AUDIENCE",
    "f657e874e6b31d81e7fdf718b688a37997f9e5a59b0ad7e0486ea06dc21a4acc"
  ),
  adminAudience: value(
    "ADMIN_ACCESS_AUDIENCE",
    "0fb1d330b27a750c38b95f813b38976cfcd497c37589612efdd0083bc9c73da9"
  ),
  clientOrigin: value("C_ALLOWED_ORIGIN", "https://app.feedmind.cc"),
  adminOrigin: value("ADMIN_ALLOWED_ORIGIN", "https://admin.feedmind.cc"),
  sourceCredentialsKey: () => secret("SOURCE_CREDENTIALS_KEY"),
  readerCredentialsKey: () => secret("READER_CREDENTIALS_KEY"),
  openRouterApiKey: () => secret("OPENROUTER_API_KEY"),
  gptOauthClientSecret: () => secret("GPT_OAUTH_CLIENT_SECRET"),
  gptOauthRedirectUris: () => secret("GPT_OAUTH_REDIRECT_URIS"),
  gptOauthClientId: value("GPT_OAUTH_CLIENT_ID", "feedmind-chatgpt-action"),
  gptOauthAuthorizeUrl: value(
    "GPT_OAUTH_AUTHORIZE_URL",
    "https://app.feedmind.cc/oauth/authorize"
  ),
  feedIntervalMinutes: value("FEED_INTERVAL_MINUTES", "15"),
  feedFetchLeaseMinutes: value("FEED_FETCH_LEASE_MINUTES", "5"),
  articleParseLeaseMinutes: value("ARTICLE_PARSE_LEASE_MINUTES", "5"),
  maxCronBatch: value("MAX_CRON_BATCH", "100"),
  pollIntervalMs: Number(value("JOB_POLL_INTERVAL_MS", "1000")),
};

export function assertRuntimeSecrets(): void {
  runtimeConfig.sourceCredentialsKey();
  runtimeConfig.readerCredentialsKey();
  runtimeConfig.openRouterApiKey();
  runtimeConfig.gptOauthClientSecret();
  runtimeConfig.gptOauthRedirectUris();
}
