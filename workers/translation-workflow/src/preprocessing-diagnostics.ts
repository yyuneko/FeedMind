import type { D1Database, R2Bucket } from "../../shared/src/cloudflare";

interface DiagnosticEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
}

interface PreprocessingDiagnosticInput {
  articleId: string;
  taskId: string;
  runId?: string | null;
  system: string;
  user: string;
  responseStatus?: number | null;
  responseBody?: string | null;
  errorCode: string;
  error: unknown;
}

export async function persistPreprocessingDiagnostic(
  env: DiagnosticEnv,
  input: PreprocessingDiagnosticInput,
): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const key = `articles/${input.articleId}/preprocessing-diagnostics/${input.taskId}/${id}.json`;
  const errorMessage = (input.error instanceof Error ? input.error.message : "Article preprocessing failed").slice(0, 500);
  await env.CONTENT.put(key, JSON.stringify({
    articleId: input.articleId,
    taskId: input.taskId,
    runId: input.runId ?? null,
    input: { system: input.system, user: input.user },
    output: input.responseBody ?? null,
    responseStatus: input.responseStatus ?? null,
    errorCode: input.errorCode,
    errorMessage,
    capturedAt: createdAt,
  }), { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  await env.DB.prepare(`INSERT INTO article_preprocessing_diagnostics
    (id, task_id, run_id, diagnostic_object_key, response_status, error_code, error_message, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
    .bind(id, input.taskId, input.runId ?? null, key, input.responseStatus ?? null,
      input.errorCode, errorMessage, createdAt).run();
}

