import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import aiService from "../../../workers/ai-service/src/index";
import type { Fetcher } from "../../../workers/shared/src/cloudflare";
import { LocalContentBucket } from "./content";
import { runtimeConfig } from "./config";
import { applyMigrations, LocalDatabase } from "./db";
import { LocalJobStore, LocalQueue, LocalWorkflowBinding } from "./jobs";

const here = dirname(fileURLToPath(import.meta.url));

export interface Runtime {
  database: LocalDatabase;
  content: LocalContentBucket;
  jobs: LocalJobStore;
  env: Record<string, unknown>;
}

export function createRuntime(options: { migrate?: boolean; requireSecrets?: boolean } = {}): Runtime {
  const database = new LocalDatabase(runtimeConfig.databasePath);
  if (options.migrate !== false) {
    applyMigrations(database, [
      resolve(here, "../../../workers/migrations"),
      resolve(here, "../migrations"),
    ]);
  }
  const content = new LocalContentBucket(runtimeConfig.contentRoot);
  const jobs = new LocalJobStore(database);
  const feedQueue = new LocalQueue(jobs, "feed");
  const articleQueue = new LocalQueue(jobs, "article");
  const classificationWorkflow = new LocalWorkflowBinding(database, jobs, "classification");
  const bodyTranslationWorkflow = new LocalWorkflowBinding(database, jobs, "translation");
  const required = options.requireSecrets !== false;
  const get = (loader: () => string) => required ? loader() : "test-secret";
  const aiEnv = { DB: database, OPENROUTER_API_KEY: get(runtimeConfig.openRouterApiKey) };
  const aiFetcher: Fetcher = {
    fetch(input, init) {
      const request = input instanceof Request ? input : new Request(input, init);
      return aiService.fetch(request, aiEnv);
    },
  };
  const env = {
    DB: database,
    CONTENT: content,
    FEED_QUEUE: feedQueue,
    ARTICLE_QUEUE: articleQueue,
    CLASSIFICATION_WORKFLOW: classificationWorkflow,
    BODY_TRANSLATION_WORKFLOW: bodyTranslationWorkflow,
    AI_SERVICE: aiFetcher,
    BROWSER: {},
    ACCESS_TEAM_DOMAIN: runtimeConfig.accessTeamDomain,
    ACCESS_AUDIENCE: runtimeConfig.clientAudience,
    ALLOWED_ORIGIN: runtimeConfig.clientOrigin,
    SOURCE_CREDENTIALS_KEY: get(runtimeConfig.sourceCredentialsKey),
    READER_CREDENTIALS_KEY: get(runtimeConfig.readerCredentialsKey),
    OPENROUTER_API_KEY: get(runtimeConfig.openRouterApiKey),
    GPT_OAUTH_CLIENT_ID: runtimeConfig.gptOauthClientId,
    GPT_OAUTH_CLIENT_SECRET: get(runtimeConfig.gptOauthClientSecret),
    GPT_OAUTH_REDIRECT_URIS: get(runtimeConfig.gptOauthRedirectUris),
    GPT_OAUTH_AUTHORIZE_URL: runtimeConfig.gptOauthAuthorizeUrl,
    FEED_INTERVAL_MINUTES: runtimeConfig.feedIntervalMinutes,
    FEED_FETCH_LEASE_MINUTES: runtimeConfig.feedFetchLeaseMinutes,
    ARTICLE_PARSE_LEASE_MINUTES: runtimeConfig.articleParseLeaseMinutes,
    MAX_CRON_BATCH: runtimeConfig.maxCronBatch,
  };
  return { database, content, jobs, env };
}

export function adminEnv(runtime: Runtime): Record<string, unknown> {
  return {
    ...runtime.env,
    ACCESS_AUDIENCE: runtimeConfig.adminAudience,
    ALLOWED_ORIGIN: runtimeConfig.adminOrigin,
  };
}
