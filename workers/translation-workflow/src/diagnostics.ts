import type { D1Database, R2Bucket } from "../../shared/src/cloudflare";

interface DiagnosticEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
}

interface DiagnosticInput {
  translationId: string;
  attemptId: string;
  requestId: string;
}

export async function persistTranslationDiagnostic(
  env: DiagnosticEnv,
  input: DiagnosticInput,
  batchIndex: number,
  failureStage: "api_response" | "response_parse" | "workflow_failure",
  responseStatus: number,
  responseBody: string,
  error: unknown,
): Promise<void> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const key = `translations/${input.translationId}/diagnostics/${input.attemptId}/${id}.json`;
  const errorMessage = (error instanceof Error ? error.message : "Translation response failed").slice(0, 500);
  const diagnostic = JSON.stringify({
    translationId: input.translationId,
    attemptId: input.attemptId,
    batchIndex,
    failureStage,
    responseStatus,
    responseBody,
    errorMessage,
    capturedAt: createdAt,
  });
  await env.CONTENT.put(key, diagnostic, { httpMetadata: { contentType: "application/json; charset=utf-8" } });
  await env.DB.prepare(`INSERT INTO translation_diagnostics
    (id, translation_id, attempt_id, batch_index, failure_stage, provider_response_key,
     error_code, error_message, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`)
    .bind(id, input.translationId, input.attemptId, batchIndex, failureStage, key,
      failureStage === "response_parse" ? "response_parse_failed"
        : failureStage === "api_response" ? "ai_api_failed" : "workflow_failed_after_ai_response",
      errorMessage, createdAt).run();
}
