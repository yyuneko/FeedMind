import type { ExecutionContext, QueueMessageBatch, ScheduledController } from "../../shared/src/cloudflare";
import { UpstreamHttpError } from "../../shared/src/content-fetch";
import {
  backfillArticleContentBlocks,
  processArticle,
  processFeed,
  runDailyMaintenance,
  scheduleDueWork,
  type ArticleMessage,
  type FeedMessage,
  type PipelineEnv,
} from "./pipeline";
import { processSourceSync, type SourceSyncMessage } from "./source-sync";
import { processSourceSwitch, type SourceSwitchMessage } from "./source-switch";

export interface Env extends PipelineEnv {}

export const DAILY_MAINTENANCE_CRON = "0 0 * * *";

export function retryDelay(attempts: number, error?: unknown): number {
  const exponentialDelay = Math.min(3600, 15 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
  const upstreamDelay = error instanceof UpstreamHttpError ? error.retryAfterSeconds ?? 0 : 0;
  return Math.max(exponentialDelay, upstreamDelay);
}

export default {
  async fetch(): Promise<Response> {
    return new Response(JSON.stringify({ error: { code: "not_found", message: "No public endpoints" } }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  },

  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(controller.cron === DAILY_MAINTENANCE_CRON
      ? runDailyMaintenance(env)
      : scheduleDueWork(env));
  },

  async queue(batch: QueueMessageBatch<FeedMessage | ArticleMessage | SourceSyncMessage | SourceSwitchMessage>, env: Env): Promise<void> {
    const isFeedQueue = batch.queue === "feedmind-feed";
    for (const message of batch.messages) {
      try {
        if (isFeedQueue && "switchJobId" in (message.body as object)) {
          await processSourceSwitch(message.body as SourceSwitchMessage, {
            ...env, SOURCE_CREDENTIALS_KEY: env.SOURCE_CREDENTIALS_KEY ?? "",
          });
        }
        else if (isFeedQueue && "connectionId" in (message.body as object)) {
          await processSourceSync(message.body as SourceSyncMessage, {
            ...env, SOURCE_CREDENTIALS_KEY: env.SOURCE_CREDENTIALS_KEY ?? "",
          });
        }
        else if (isFeedQueue) await processFeed(message.body as FeedMessage, env);
        else if ((message.body as ArticleMessage).reason === "content_block_backfill") await backfillArticleContentBlocks(message.body as ArticleMessage, env);
        else await processArticle(message.body as ArticleMessage, env);
        message.ack();
      } catch (error) {
        console.error({
          service: "feedmind-pipeline",
          event: "queue_message_failed",
          queue: batch.queue,
          attempts: message.attempts,
          error: error instanceof Error ? error.message.slice(0, 500) : "unknown error",
        });
        if (isFeedQueue) message.retry({ delaySeconds: retryDelay(message.attempts, error) });
        else message.ack();
      }
    }
  },
};
