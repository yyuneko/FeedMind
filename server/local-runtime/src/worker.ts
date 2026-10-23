import {
  backfillArticleContentBlocks,
  processArticle,
  processFeed,
  runDailyMaintenance,
  scheduleDueWork,
  type ArticleMessage,
  type FeedMessage,
} from "../../../workers/pipeline/src/pipeline";
import { processSourceSync, type SourceSyncMessage } from "../../../workers/pipeline/src/source-sync";
import { processSourceSwitch, type SourceSwitchMessage } from "../../../workers/pipeline/src/source-switch";
import { ClassificationWorkflow, TranslationWorkflow } from "../../../workers/translation-workflow/src/index";
import { runtimeConfig } from "./config";
import { createRuntime } from "./runtime";
import {
  failWorkflow,
  finishWorkflow,
  LocalWorkflowStep,
  startWorkflow,
  workflowPayload,
  type LocalJob,
} from "./jobs";

const runtime = createRuntime();
const environment = runtime.env as never;
let stopping = false;
let scheduling = false;
let maintaining = false;

runtime.jobs.recoverAllLeasesAfterRestart();

async function runWorkflow(job: LocalJob<{ workflowId: string }>): Promise<void> {
  const workflow = workflowPayload(runtime.database, job.payload.workflowId);
  if (workflow.status === "cancelled" || workflow.status === "completed") return;
  startWorkflow(runtime.database, job.payload.workflowId);
  const step = new LocalWorkflowStep(runtime.database, job.payload.workflowId);
  try {
    const Constructor = (workflow.kind === "classification" ? ClassificationWorkflow : TranslationWorkflow) as unknown as
      new (context: unknown, env: unknown) => { run(event: { payload: unknown; instanceId: string }, step: LocalWorkflowStep): Promise<unknown> };
    const instance = new Constructor(undefined, environment);
    const result = await instance.run({ payload: workflow.params, instanceId: job.payload.workflowId }, step);
    finishWorkflow(runtime.database, job.payload.workflowId, result);
  } catch (error) {
    failWorkflow(runtime.database, job.payload.workflowId, error);
    throw error;
  }
}

async function execute(job: LocalJob): Promise<void> {
  if (job.kind === "workflow:classification" || job.kind === "workflow:translation") {
    await runWorkflow(job as LocalJob<{ workflowId: string }>);
    return;
  }
  if (job.kind === "article") {
    const message = job.payload as ArticleMessage;
    if (message.reason === "content_block_backfill") await backfillArticleContentBlocks(message, environment);
    else await processArticle(message, environment);
    return;
  }
  if (job.kind === "feed") {
    const body = job.payload as FeedMessage | SourceSyncMessage | SourceSwitchMessage;
    if ("switchJobId" in body) await processSourceSwitch(body, environment);
    else if ("connectionId" in body) await processSourceSync(body, environment);
    else await processFeed(body, environment);
    return;
  }
  throw new Error(`Unsupported local job kind: ${job.kind}`);
}

function prepareArticleRetry(job: LocalJob): void {
  if (job.kind !== "article" || job.attemptCount >= job.maxAttempts) return;
  const message = job.payload as ArticleMessage;
  if (!message.articleId || message.reason === "content_block_backfill") return;
  const timestamp = new Date().toISOString();
  runtime.database.native.transaction(() => {
    const reset = runtime.database.native.prepare(`UPDATE article_parse_tasks
      SET status = 'pending', started_at = NULL, heartbeat_at = NULL, completed_at = NULL
      WHERE id = (SELECT id FROM article_parse_tasks
        WHERE article_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1)`)
      .run(message.articleId);
    if (reset.changes > 0) {
      runtime.database.native.prepare(`UPDATE articles SET parse_status = 'pending', parse_error = NULL, updated_at = ?
        WHERE id = ? AND parse_status = 'failed'`).run(timestamp, message.articleId);
    }
  })();
}

async function poll(kinds: string[]): Promise<void> {
  while (!stopping) {
    if (runtimeConfig.migrationMode !== "normal") {
      await new Promise((resolve) => setTimeout(resolve, runtimeConfig.pollIntervalMs));
      continue;
    }
    runtime.jobs.recoverExpiredLeases();
    const job = runtime.jobs.lease(kinds);
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, runtimeConfig.pollIntervalMs));
      continue;
    }
    try {
      await execute(job);
      runtime.jobs.complete(job.id);
    } catch (error) {
      prepareArticleRetry(job);
      console.error(JSON.stringify({ service: "feedmind-local-worker", event: "job_failed",
        jobId: job.id, kind: job.kind, attempt: job.attemptCount,
        error: error instanceof Error ? error.message : String(error) }));
      runtime.jobs.fail(job, error);
    }
  }
}

async function schedule(): Promise<void> {
  if (scheduling || runtimeConfig.migrationMode !== "normal") return;
  scheduling = true;
  try { await scheduleDueWork(environment); }
  catch (error) { console.error(JSON.stringify({ service: "feedmind-local-worker", event: "schedule_failed",
    error: error instanceof Error ? error.message : String(error) })); }
  finally { scheduling = false; }
}

async function maintain(): Promise<void> {
  if (maintaining || runtimeConfig.migrationMode !== "normal") return;
  maintaining = true;
  try { await runDailyMaintenance(environment); }
  catch (error) { console.error(JSON.stringify({ service: "feedmind-local-worker", event: "maintenance_failed",
    error: error instanceof Error ? error.message : String(error) })); }
  finally { maintaining = false; }
}

const scheduleTimer = setInterval(() => void schedule(), 5 * 60_000);
const maintenanceTimer = setInterval(() => void maintain(), 24 * 60 * 60_000);
void schedule();
void poll(["feed", "article"]);
void poll(["workflow:classification"]);
void poll(["workflow:translation"]);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(scheduleTimer);
    clearInterval(maintenanceTimer);
  });
}
