import { WorkflowEntrypoint, type WorkflowStep } from "cloudflare:workers";
import type { D1Database, Fetcher, R2Bucket } from "../../shared/src/cloudflare";
import {
  applyTranslationPlan,
  createTranslationBatches,
  createTranslationPlan,
  TranslationBatchValidationError,
  type TranslationBlockResult,
} from "../../../src/utils/translationHtml";
import { estimateTokens } from "./sampling";
import { annotateAndHideContentBlocks, contentHtmlToText } from "../../shared/src/content-blocks";
import { ARTICLE_PREPROCESSING_JSON_SCHEMA, parseArticlePreprocessing, reconcilePreprocessingTags, TITLE_LOCALES, type ExistingTopicTag, type TitleLocale } from "./classification";
import { persistTranslationDiagnostic } from "./diagnostics";
import { persistPreprocessingDiagnostic } from "./preprocessing-diagnostics";
import { translationBatchTokenBudget } from "./batching";
import {
  buildTranslationRepairRequest,
  failedTranslationBlocks,
  mergeTranslationRepairs,
  parseTranslationBatchJson,
  validateTranslationBatchResult,
} from "./translation-response";

interface Env {
  DB: D1Database;
  CONTENT: R2Bucket;
  AI_SERVICE: Fetcher;
}

interface ClassificationParams { articleId: string; sourceHash: string; requestId: string; taskId?: string }
interface TranslationParams { translationId: string; attemptId: string; requestId: string }

const PREPROCESSING_POLICY_VERSION = 2;

function now(): string { return new Date().toISOString(); }

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

class AiCallError extends Error {
  constructor(message: string, readonly responseStatus: number, readonly responseBody: string) {
    super(message);
    this.name = "AiCallError";
  }
}

class DiagnosticCapturedError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "Translation response failed");
    this.name = "DiagnosticCapturedError";
  }
}

async function ai(
  env: Env,
  profileVersionId: string,
  profile: "fast" | "quality",
  system: string,
  user: string,
  json = true,
  jsonSchema?: Record<string, unknown>,
): Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number; thinkingTokens: number };
  latencyMs: number;
  finishReason: string | null;
  responseStatus: number;
  responseBody: string;
}> {
  const response = await env.AI_SERVICE.fetch("https://feedmind-ai-service.internal/invoke-version", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileVersionId,
      input: { profile, system, messages: [{ role: "user", content: user }], json: jsonSchema ? undefined : json, jsonSchema },
    }),
  });
  const responseBody = await response.text();
  if (!response.ok) throw new AiCallError(`AI service failed with HTTP ${response.status}`, response.status, responseBody);
  let body: { data?: { text?: unknown; usage?: unknown; latencyMs?: unknown; finishReason?: unknown } };
  try {
    body = JSON.parse(responseBody) as typeof body;
  } catch {
    throw new AiCallError("AI service response is not valid JSON", response.status, responseBody);
  }
  if (typeof body.data?.text !== "string" || !body.data.text) {
    throw new AiCallError("AI service response is invalid", response.status, responseBody);
  }
  return {
    text: body.data.text,
    usage: body.data.usage as { inputTokens: number; outputTokens: number; thinkingTokens: number },
    latencyMs: Number(body.data.latencyMs ?? 0),
    finishReason: typeof body.data.finishReason === "string" ? body.data.finishReason : null,
    responseStatus: response.status,
    responseBody,
  };
}

export class ClassificationWorkflow extends WorkflowEntrypoint<Env, ClassificationParams> {
  async run(event: { payload: ClassificationParams }, step: WorkflowStep) {
    const input = event.payload;
    const context = await step.do("load article and frozen configuration", async () => {
      const article = await this.env.DB.prepare(`SELECT a.id, a.title, a.summary, a.source_text_key AS sourceTextKey,
        a.source_hash AS sourceHash, a.source_text_hash AS sourceTextHash, a.source_text_bytes AS sourceTextBytes,
        f.title AS feedTitle
        FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id WHERE a.id = ?1`).bind(input.articleId)
        .first<{ id: string; title: string; summary: string | null; sourceTextKey: string; sourceHash: string;
          sourceTextHash: string; sourceTextBytes: number; feedTitle: string | null }>();
      if (!article || article.sourceHash !== input.sourceHash || !article.sourceTextKey || !article.sourceTextHash) {
        throw new Error("Article source text version is unavailable");
      }
      const task = input.taskId
        ? await this.env.DB.prepare("SELECT id FROM article_preprocessing_tasks WHERE id = ?1 AND article_id = ?2")
          .bind(input.taskId, input.articleId).first<{ id: string }>()
        : await this.env.DB.prepare(`SELECT id FROM article_preprocessing_tasks
          WHERE article_id = ?1 AND source_text_hash = ?2 AND status IN ('pending', 'running')
          ORDER BY created_at DESC LIMIT 1`).bind(input.articleId, article.sourceTextHash).first<{ id: string }>();
      if (!task) throw new Error("Article preprocessing task is unavailable");
      const prompts = await this.env.DB.prepare(`SELECT d.task, d.target_locale AS targetLocale, v.id, v.content FROM prompt_definitions d
        JOIN prompt_versions v ON v.id = d.current_version_id
        WHERE d.deleted_at IS NULL AND d.task IN ('classification', 'title_translation')
          AND ((d.task = 'classification' AND d.target_locale IN ('zh-CN', 'preprocessing'))
            OR (d.task = 'title_translation' AND d.target_locale IN ('zh-CN', 'en-US', 'ja-JP')))
          AND v.status = 'active'`).all<{ task: string; targetLocale: string; id: string; content: string }>();
      const classificationPrompt = prompts.results?.find((item) => item.task === "classification" && item.targetLocale === "zh-CN");
      const preprocessingPrompt = prompts.results?.find((item) => item.task === "classification" && item.targetLocale === "preprocessing");
      const titlePrompts = Object.fromEntries(TITLE_LOCALES.map((locale) =>
        [locale, prompts.results?.find((item) => item.task === "title_translation" && item.targetLocale === locale)])) as
        Record<TitleLocale, { task: string; targetLocale: string; id: string; content: string } | undefined>;
      const profile = await this.env.DB.prepare(`SELECT id, provider, model,
        context_window_tokens AS contextWindowTokens, max_output_tokens AS maxOutputTokens,
        thinking_enabled AS thinkingEnabled, parameters_json AS parametersJson
        FROM ai_profile_versions WHERE profile = 'fast' AND provider = 'openrouter' AND status = 'active'`)
        .first<{ id: string; provider: string; model: string; contextWindowTokens: number | null;
          maxOutputTokens: number | null; thinkingEnabled: number; parametersJson: string }>();
      const limitsRow = await this.env.DB.prepare(`SELECT value_json AS valueJson FROM system_config_versions
        WHERE config_key = 'article_preprocessing_limits' AND status = 'active'`).first<{ valueJson: string }>();
      const thresholdRow = await this.env.DB.prepare(`SELECT value_json AS valueJson FROM system_config_versions
        WHERE config_key = 'classification_threshold' AND status = 'active'`).first<{ valueJson: string }>();
      const tags = await this.env.DB.prepare(`SELECT tag_key AS key, names_json AS namesJson,
        aliases_json AS aliasesJson, status FROM topic_tags
        WHERE status = 'active' ORDER BY tag_key`)
        .all<{ key: string; namesJson: string; aliasesJson: string; status: "active" }>();
      if (!classificationPrompt || !preprocessingPrompt || TITLE_LOCALES.some((locale) => !titlePrompts[locale]) ||
          !profile || !profile.contextWindowTokens || !limitsRow || !thresholdRow) {
        throw new Error("Article preprocessing configuration is incomplete");
      }
      await this.env.DB.prepare(`UPDATE article_preprocessing_tasks SET status = 'running',
        started_at = COALESCE(started_at, ?1), attempt_count = attempt_count + 1,
        error_code = NULL, error_message = NULL WHERE id = ?2`).bind(now(), task.id).run();
      return { article, task, classificationPrompt, preprocessingPrompt, titlePrompts, profile, limitsRow, thresholdRow,
        tags: tags.results ?? [] };
    });

    const setup = await (async () => {
      try {
    const sourceText = await step.do("read article source text", async () => {
      const object = await this.env.CONTENT.get(context.article.sourceTextKey);
      if (!object) throw new Error("Article source text object is missing");
      const text = await object.text();
      if (!text.trim() || await sha256(text) !== context.article.sourceTextHash) throw new Error("Article source text hash is invalid");
      return text;
    });

    const prepared = await step.do("prepare full text invocation", async () => {
      const system = `${context.classificationPrompt.content}\n\n${context.preprocessingPrompt.content}\n\n${TITLE_LOCALES.map((locale) =>
        `[Title translation: ${locale}]\n${context.titlePrompts[locale]!.content}`).join("\n\n")}\n\n` +
        `Return exactly one JSON object with classification, localizedContent, informationScore, and tags. ` +
        `classification.sourceTitleLocale must identify the original title language as zh-CN, en-US, ja-JP, or other. ` +
        `localizedContent must contain zh-CN, en-US, and ja-JP; each value must contain title, summary, and keyPoints (3-5 strings). ` +
        `informationScore must contain integer total and integer dimensions specificity, technicalDetail, practicalExperience, evidence, novelty, all 0-100, plus reason. ` +
        `tags must contain 3-5 unique objects with lowercase kebab-case key and names for zh-CN, en-US, ja-JP. ` +
        `Treat existingTags as the authoritative topic vocabulary. For every topic, first find a semantically equivalent existing tag, ` +
        `including synonyms and aliases; when one exists, copy its key and names exactly. Create a new key only when no existing tag ` +
        `has the same meaning. Do not create spelling, pluralization, translation, abbreviation, broader, or narrower variants of an existing tag.`;
      const existingTags = context.tags.map((tag) => ({
        key: tag.key,
        names: JSON.parse(tag.namesJson),
        aliases: JSON.parse(tag.aliasesJson),
        status: tag.status,
      })) as ExistingTopicTag[];
      const user = JSON.stringify({
        title: context.article.title,
        feedTitle: context.article.feedTitle,
        rssSummary: context.article.summary ? contentHtmlToText(context.article.summary) : null,
        existingTags,
        fullPlainText: sourceText,
      });
      const limits = JSON.parse(context.limitsRow.valueJson) as { reservedOutputTokens?: number; tokenSafetyMultiplier?: number };
      const reservedOutputTokens = Math.max(1, Math.floor(Number(limits.reservedOutputTokens ?? 1800)));
      if (context.profile.maxOutputTokens !== null && context.profile.maxOutputTokens < reservedOutputTokens) {
        throw new Error("Fast profile max output tokens is smaller than the preprocessing output reservation");
      }
      const multiplier = Math.max(1, Number(limits.tokenSafetyMultiplier ?? 1.2));
      const estimatedInputTokens = Math.ceil(estimateTokens(`${system}\n${user}`) * multiplier);
      const required = estimatedInputTokens + reservedOutputTokens;
      if (required > Number(context.profile.contextWindowTokens)) {
        const error = new Error(`content_too_large:${required}:${context.profile.contextWindowTokens}`);
        error.name = "ContentTooLargeError";
        await persistPreprocessingDiagnostic(this.env, {
          articleId: input.articleId, taskId: context.task.id, system, user,
          errorCode: "content_too_large", error,
        });
        await this.env.DB.prepare(`UPDATE article_preprocessing_tasks SET status = 'failed',
          error_code = 'content_too_large', error_message = ?1, completed_at = ?2 WHERE id = ?3`)
          .bind(`Required ${required} tokens exceeds context window ${context.profile.contextWindowTokens}`, now(), context.task.id).run();
        throw error;
      }
      const promptBundleHash = await sha256(JSON.stringify({
        classification: context.classificationPrompt.id,
        preprocessing: context.preprocessingPrompt.id,
        titles: TITLE_LOCALES.map((locale) => context.titlePrompts[locale]!.id),
      }));
      const tagVocabularyHash = await sha256(JSON.stringify(existingTags));
      const outputSchemaHash = await sha256(JSON.stringify(ARTICLE_PREPROCESSING_JSON_SCHEMA));
      const profileConfigHash = await sha256(JSON.stringify({ model: context.profile.model,
        contextWindowTokens: context.profile.contextWindowTokens, maxOutputTokens: context.profile.maxOutputTokens,
        thinkingEnabled: context.profile.thinkingEnabled === 1,
        parameters: JSON.parse(context.profile.parametersJson || "{}") }));
      const fingerprint = await sha256([input.articleId, context.article.sourceTextHash,
        String(PREPROCESSING_POLICY_VERSION), outputSchemaHash, promptBundleHash,
        context.profile.id, profileConfigHash, tagVocabularyHash].join(":"));
      return { system, user, reservedOutputTokens, estimatedInputTokens, promptBundleHash, tagVocabularyHash,
        profileConfigHash, outputSchemaHash, fingerprint };
    });

    const claim = await step.do("claim preprocessing result fingerprint", async () => {
      const existing = await this.env.DB.prepare(`SELECT id FROM article_preprocessing_runs
        WHERE result_fingerprint = ?1 AND status = 'completed' LIMIT 1`).bind(prepared.fingerprint).first<{ id: string }>();
      if (existing) {
        await this.env.DB.prepare(`UPDATE article_preprocessing_tasks SET status = 'completed', completed_at = ?1
          WHERE id = ?2`).bind(now(), context.task.id).run();
        return { id: existing.id, reused: true };
      }
      const id = crypto.randomUUID();
      await this.env.DB.prepare(`INSERT INTO article_preprocessing_runs
        (id, task_id, article_id, source_hash, source_text_hash, result_fingerprint, status, policy_version,
         prompt_bundle_hash, preprocessing_prompt_version_id, classification_prompt_version_id, profile_version_id,
         tag_vocabulary_version, tag_vocabulary_hash, profile_config_hash, context_window_tokens,
         source_text_bytes, estimated_input_tokens,
         reserved_output_tokens, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`)
        .bind(id, context.task.id, input.articleId, input.sourceHash, context.article.sourceTextHash, prepared.fingerprint,
          PREPROCESSING_POLICY_VERSION, prepared.promptBundleHash, context.preprocessingPrompt.id,
          context.classificationPrompt.id, context.profile.id,
          prepared.tagVocabularyHash, prepared.profileConfigHash, context.profile.contextWindowTokens,
          context.article.sourceTextBytes, prepared.estimatedInputTokens, prepared.reservedOutputTokens, now()).run();
      return { id, reused: false };
    });
        return { prepared, claim };
      } catch (error) {
        await step.do("record preprocessing setup failure", async () => {
          const message = (error instanceof Error ? error.message : "Article preprocessing setup failed").slice(0, 500);
          const code = error instanceof Error && error.name === "ContentTooLargeError"
            ? "content_too_large" : "preprocessing_setup_failed";
          await this.env.DB.prepare(`UPDATE article_preprocessing_tasks SET status = 'failed',
            error_code = ?1, error_message = ?2, completed_at = ?3
            WHERE id = ?4 AND status IN ('pending', 'running')`)
            .bind(code, message, now(), context.task.id).run();
        });
        throw error;
      }
    })();
    const { prepared, claim } = setup;
    const runId = claim.id;
    if (claim.reused) return { articleId: input.articleId, sourceHash: input.sourceHash, runId, reused: true };

    let lastProviderResponse: { responseStatus: number; responseBody: string } | null = null;
    try {
      const completed = await step.do("preprocess complete article", {
        retries: { limit: context.profile.model.endsWith(":batch") ? 0 : 2, delay: "10 seconds", backoff: "exponential" },
        timeout: context.profile.model.endsWith(":batch") ? "30 minutes" : "2 minutes",
      }, async () => {
        const result = await ai(this.env, context.profile.id, "fast", prepared.system, prepared.user,
          true, ARTICLE_PREPROCESSING_JSON_SCHEMA);
        lastProviderResponse = { responseStatus: result.responseStatus, responseBody: result.responseBody };
        const parsed = parseArticlePreprocessing(result.text);
        const existingTags = context.tags.map((tag) => ({ key: tag.key, names: JSON.parse(tag.namesJson),
          aliases: JSON.parse(tag.aliasesJson), status: tag.status })) as ExistingTopicTag[];
        return { result: reconcilePreprocessingTags(parsed, existingTags), usage: { ...result.usage, latencyMs: result.latencyMs } };
      });
      const threshold = Number((JSON.parse(context.thresholdRow.valueJson) as Record<string, unknown>).minimumConfidence ?? 0.65);
      if (completed.result.classification.confidence < threshold) completed.result.classification.articleType = "general";
      await step.do("persist unified preprocessing result", async () => {
        const created = now();
        const classificationId = crypto.randomUUID();
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE article_preprocessing_runs SET is_current = 0 WHERE article_id = ?1 AND is_current = 1")
            .bind(input.articleId),
          this.env.DB.prepare("UPDATE article_classifications SET is_current = 0 WHERE article_id = ?1 AND source_hash = ?2 AND is_current = 1")
            .bind(input.articleId, input.sourceHash),
          this.env.DB.prepare(`INSERT INTO article_classifications
            (id, article_id, article_type, source_title_locale, confidence, reason_summary, translated_title, title_status, source_hash,
             prompt_version_id, title_prompt_version_id, profile_version_id, title_profile_version_id,
             sampling_algorithm_version, sample_fragment_count, sample_manifest_hash, estimated_input_tokens,
             title_translation_policy_version, is_current, preprocessing_run_id, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'completed', ?8, ?9, ?10, ?11, ?11,
              'full-plain-text-v1', 1, ?12, ?13, 3, 1, ?14, ?15)`)
            .bind(classificationId, input.articleId, completed.result.classification.articleType,
              completed.result.classification.sourceTitleLocale, completed.result.classification.confidence,
              completed.result.classification.reason, completed.result.localizedContent["zh-CN"].title,
              input.sourceHash, context.classificationPrompt.id,
              context.titlePrompts["zh-CN"]!.id, context.profile.id, context.article.sourceTextHash,
              prepared.estimatedInputTokens, runId, created),
          ...TITLE_LOCALES.map((locale) => this.env.DB.prepare(`INSERT INTO article_title_translations
            (classification_id, target_locale, translated_title, status, prompt_version_id, profile_version_id, created_at)
            VALUES (?1, ?2, ?3, 'completed', ?4, ?5, ?6)`)
            .bind(classificationId, locale, completed.result.localizedContent[locale].title,
              context.titlePrompts[locale]!.id, context.profile.id, created)),
          ...TITLE_LOCALES.map((locale) => this.env.DB.prepare(`INSERT INTO article_preprocessing_locales
            (run_id, target_locale, translated_title, one_line_summary, key_points_json)
            VALUES (?1, ?2, ?3, ?4, ?5)`)
            .bind(runId, locale, completed.result.localizedContent[locale].title,
              completed.result.localizedContent[locale].summary,
              JSON.stringify(completed.result.localizedContent[locale].keyPoints))),
          this.env.DB.prepare(`INSERT INTO article_information_scores
            (run_id, total_score, dimensions_json, reason) VALUES (?1, ?2, ?3, ?4)`)
            .bind(runId, completed.result.informationScore.total,
              JSON.stringify(completed.result.informationScore.dimensions), completed.result.informationScore.reason),
          ...completed.result.tags.map((tag) => this.env.DB.prepare(`INSERT OR IGNORE INTO topic_tags
            (id, tag_key, status, names_json, aliases_json, vocabulary_version, created_at, updated_at)
            VALUES (?1, ?2, 'active', ?3, '[]', 1, ?4, ?4)`)
            .bind(crypto.randomUUID(), tag.key, JSON.stringify(tag.names), created)),
          ...completed.result.tags.map((tag, index) => this.env.DB.prepare(`INSERT INTO article_topic_tags
            (run_id, tag_id, rank) SELECT ?1, id, ?2 FROM topic_tags WHERE tag_key = ?3`)
            .bind(runId, index + 1, tag.key)),
          this.env.DB.prepare(`UPDATE article_preprocessing_runs SET status = 'completed', is_current = 1,
            input_tokens = ?1, output_tokens = ?2, thinking_tokens = ?3, latency_ms = ?4, completed_at = ?5 WHERE id = ?6`)
            .bind(completed.usage.inputTokens, completed.usage.outputTokens, completed.usage.thinkingTokens,
              completed.usage.latencyMs, created, runId),
          this.env.DB.prepare(`UPDATE article_preprocessing_tasks SET status = 'completed', completed_at = ?1,
            error_code = NULL, error_message = NULL WHERE id = ?2`).bind(created, context.task.id),
          this.env.DB.prepare(`INSERT INTO ai_usage_events
            (id, purpose, profile_version_id, provider, model, status, article_id, preprocessing_run_id,
             input_tokens, output_tokens, thinking_tokens, latency_ms, request_id, created_at)
            VALUES (?1, 'article_preprocessing', ?2, ?3, ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
            .bind(crypto.randomUUID(), context.profile.id, context.profile.provider, context.profile.model,
              input.articleId, runId, completed.usage.inputTokens, completed.usage.outputTokens,
              completed.usage.thinkingTokens, completed.usage.latencyMs, input.requestId, created),
        ]);
      });
      return { articleId: input.articleId, sourceHash: input.sourceHash, runId, ...completed.result };
    } catch (error) {
      await step.do("record preprocessing failure", async () => {
        const message = (error instanceof Error ? error.message : "Article preprocessing failed").slice(0, 500);
        const code = error instanceof Error && error.name === "ContentTooLargeError" ? "content_too_large" : "preprocessing_failed";
        const failedResponse = error instanceof AiCallError
          ? { responseStatus: error.responseStatus, responseBody: error.responseBody }
          : lastProviderResponse;
        await persistPreprocessingDiagnostic(this.env, {
          articleId: input.articleId, taskId: context.task.id, runId,
          system: prepared.system, user: prepared.user,
          responseStatus: failedResponse?.responseStatus,
          responseBody: failedResponse?.responseBody,
          errorCode: code, error,
        });
        await this.env.DB.batch([
          this.env.DB.prepare(`UPDATE article_preprocessing_runs SET status = 'failed',
            result_fingerprint = CASE WHEN status <> 'failed' THEN result_fingerprint || ':failed:' || id ELSE result_fingerprint END,
            error_code = ?1, error_message = ?2, completed_at = ?3
            WHERE id = ?4 AND status <> 'completed'`).bind(code, message, now(), runId),
          this.env.DB.prepare(`UPDATE article_preprocessing_tasks SET status = 'failed', error_code = ?1,
            error_message = ?2, completed_at = ?3 WHERE id = ?4`).bind(code, message, now(), context.task.id),
          this.env.DB.prepare(`INSERT INTO ai_usage_events
            (id, purpose, profile_version_id, provider, model, status, article_id, preprocessing_run_id,
             error_code, request_id, created_at)
            VALUES (?1, 'article_preprocessing', ?2, ?3, ?4, 'failed', ?5, ?6, ?7, ?8, ?9)`)
            .bind(crypto.randomUUID(), context.profile.id, context.profile.provider, context.profile.model,
              input.articleId, runId, code, input.requestId, now()),
        ]);
      });
      throw error;
    }
  }
}

export class TranslationWorkflow extends WorkflowEntrypoint<Env, TranslationParams> {
  async run(event: { payload: TranslationParams }, step: WorkflowStep) {
    const input = event.payload;
    let lastProviderResponse: { batchIndex: number; responseStatus: number; responseBody: string } | null = null;
    try {
      const context = await step.do("load translation version", async () => {
        const row = await this.env.DB.prepare(`SELECT t.id, t.status, t.source_hash AS sourceHash,
          t.prompt_version_id AS promptVersionId, t.body_profile_version_id AS bodyProfileVersionId,
          t.translated_title AS translatedTitle,
          a.source_html_key AS sourceHtmlKey, p.content AS prompt, rp.content AS repairPrompt,
          q.provider, q.model, q.max_output_tokens AS maxOutputTokens, l.value_json AS limitsJson
          FROM translations t JOIN articles a ON a.id = t.article_id
          JOIN prompt_versions p ON p.id = t.prompt_version_id
          JOIN prompt_definitions d ON d.id = p.definition_id AND d.task = 'body_translation'
            AND d.article_type = t.article_type AND d.target_locale = t.target_locale
          JOIN prompt_definitions rd ON rd.task = 'body_repair'
            AND rd.article_type = t.article_type AND rd.target_locale = t.target_locale
            AND rd.deleted_at IS NULL
          JOIN prompt_versions rp ON rp.id = rd.current_version_id AND rp.status = 'active'
          JOIN ai_profile_versions q ON q.id = t.body_profile_version_id
          JOIN system_config_versions l ON l.config_key = 'translation_limits' AND l.status = 'active'
          WHERE t.id = ?1`).bind(input.translationId).first<{
            id: string; status: string; sourceHash: string; promptVersionId: string; bodyProfileVersionId: string;
            translatedTitle: string | null; sourceHtmlKey: string; prompt: string; provider: string; model: string;
            repairPrompt: string; maxOutputTokens: number | null; limitsJson: string;
          }>();
        if (!row || !row.sourceHtmlKey) throw new Error("Translation source is unavailable");
        if (row.status === "cancel_requested") {
          await this.env.DB.prepare("UPDATE translations SET status = 'cancelled', completed_at = ?1 WHERE id = ?2")
            .bind(now(), input.translationId).run();
          return { ...row, cancelled: true };
        }
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE translations SET status = 'running', started_at = COALESCE(started_at, ?1) WHERE id = ?2")
            .bind(now(), input.translationId),
          this.env.DB.prepare("UPDATE translation_attempts SET status = 'running', started_at = COALESCE(started_at, ?1) WHERE id = ?2")
            .bind(now(), input.attemptId),
        ]);
        return { ...row, cancelled: false };
      });
      if (context.cancelled) return { translationId: input.translationId, status: "cancelled" };

      const plan = await step.do("build structured translation plan", async () => {
        const object = await this.env.CONTENT.get(context.sourceHtmlKey);
        if (!object) throw new Error("Translation source object is missing");
        const source = annotateAndHideContentBlocks(await object.text());
        const plan = createTranslationPlan(source);
        const limits = JSON.parse(context.limitsJson) as { batchTokenBudget?: number; maxRetries?: number; baseRetrySeconds?: number };
        const batchTokenBudget = translationBatchTokenBudget(
          Number(limits.batchTokenBudget ?? 6000),
          context.maxOutputTokens == null ? null : Number(context.maxOutputTokens),
        );
        return { plan, batches: createTranslationBatches(plan.blocks, batchTokenBudget), limits };
      });
      const allResults: TranslationBlockResult[] = [];
      let inputTokens = 0, outputTokens = 0, thinkingTokens = 0, latencyMs = 0;
      for (let index = 0; index < plan.batches.length; index++) {
        const batch = plan.batches[index];
        const result = await step.do(`translate batch ${index + 1}`, {
          retries: { limit: context.model.endsWith(":batch") ? 0 : Number(plan.limits.maxRetries ?? 3), delay: `${Number(plan.limits.baseRetrySeconds ?? 30)} seconds`, backoff: "exponential" },
          timeout: context.model.endsWith(":batch") ? "30 minutes" : "10 minutes",
        }, async () => {
          let response: Awaited<ReturnType<typeof ai>>;
          try {
            response = await ai(this.env, context.bodyProfileVersionId, "quality", context.prompt,
              JSON.stringify({ blocks: batch.map((item) => [item.id, item.markup]) }), true);
          } catch (error) {
            const failed = error instanceof AiCallError ? error : null;
            await persistTranslationDiagnostic(this.env, input, index, "api_response",
              failed?.responseStatus ?? 0, failed?.responseBody ?? "", error);
            throw new DiagnosticCapturedError(error);
          }
          try {
            if (response.finishReason?.toUpperCase() === "MAX_TOKENS") {
              throw new Error(`Translation response was truncated (MAX_TOKENS): output=${response.usage.outputTokens}, thinking=${response.usage.thinkingTokens}`);
            }
            let blocks = parseTranslationBatchJson(response.text, batch);
            try {
              validateTranslationBatchResult(blocks, batch, index + 1);
            } catch (error) {
              if (!(error instanceof TranslationBatchValidationError)) throw error;
              const repairExpected = failedTranslationBlocks(batch, error);
              const repair = await ai(
                this.env,
                context.bodyProfileVersionId,
                "quality",
                context.repairPrompt,
                buildTranslationRepairRequest(batch, blocks, error),
                true,
              );
              if (repair.finishReason?.toUpperCase() === "MAX_TOKENS") {
                throw new Error(`Translation repair response was truncated (MAX_TOKENS): output=${repair.usage.outputTokens}, thinking=${repair.usage.thinkingTokens}`);
              }
              const repairedBlocks = parseTranslationBatchJson(repair.text, repairExpected);
              validateTranslationBatchResult(repairedBlocks, repairExpected, index + 1);
              blocks = mergeTranslationRepairs(blocks, repairedBlocks);
              response.usage.inputTokens += repair.usage.inputTokens;
              response.usage.outputTokens += repair.usage.outputTokens;
              response.usage.thinkingTokens += repair.usage.thinkingTokens;
              response.latencyMs += repair.latencyMs;
            }
            return {
              blocks, usage: response.usage, latencyMs: response.latencyMs,
              responseStatus: response.responseStatus, responseBody: response.responseBody,
            };
          } catch (error) {
            await persistTranslationDiagnostic(this.env, input, index, "response_parse",
              response.responseStatus, response.responseBody, error);
            throw new DiagnosticCapturedError(error);
          }
        });
        lastProviderResponse = {
          batchIndex: index,
          responseStatus: result.responseStatus,
          responseBody: result.responseBody,
        };
        allResults.push(...result.blocks);
        inputTokens += result.usage.inputTokens; outputTokens += result.usage.outputTokens;
        thinkingTokens += result.usage.thinkingTokens; latencyMs += result.latencyMs;
        await step.do(`persist batch ${index + 1}`, async () => {
          const key = `translations/${input.translationId}/partial/${index}.json`;
          const serialized = JSON.stringify({ batch: index, blocks: result.blocks });
          await this.env.CONTENT.put(key, serialized, { httpMetadata: { contentType: "application/json" } });
          await this.env.DB.prepare(`INSERT INTO translation_batches
            (id, attempt_id, batch_index, status, partial_key, partial_hash, created_at, completed_at)
            VALUES (?1, ?2, ?3, 'completed', ?4, ?5, ?6, ?6)
            ON CONFLICT(attempt_id, batch_index) DO UPDATE SET status = 'completed', partial_key = excluded.partial_key,
              partial_hash = excluded.partial_hash, completed_at = excluded.completed_at`)
            .bind(crypto.randomUUID(), input.attemptId, index, key, plan.plan.sourceHash, now()).run();
        });
      }
      const completed = await step.do("assemble and persist final translation", async () => {
        const html = applyTranslationPlan(plan.plan, allResults);
        const resultKey = `translations/${input.translationId}/result.json`;
        const htmlKey = `translations/${input.translationId}/content.html`;
        const result = JSON.stringify({
          v: 2, title: context.translatedTitle ?? "", sourceHash: context.sourceHash,
          promptVersionId: context.promptVersionId, blocks: allResults,
        });
        await Promise.all([
          this.env.CONTENT.put(resultKey, result, { httpMetadata: { contentType: "application/json" } }),
          this.env.CONTENT.put(htmlKey, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } }),
        ]);
        const finishedAt = now();
        await this.env.DB.batch([
          this.env.DB.prepare(`UPDATE translations SET status = 'completed', result_key = ?1,
            result_hash = ?2, result_bytes = ?3, content_html_key = ?4, completed_at = ?5 WHERE id = ?6`)
            .bind(resultKey, plan.plan.sourceHash, new TextEncoder().encode(result).byteLength, htmlKey, finishedAt, input.translationId),
          this.env.DB.prepare(`UPDATE translation_attempts SET status = 'completed', input_tokens = ?1,
            output_tokens = ?2, thinking_tokens = ?3, provider_latency_ms = ?4, completed_at = ?5 WHERE id = ?6`)
            .bind(inputTokens, outputTokens, thinkingTokens, latencyMs, finishedAt, input.attemptId),
          this.env.DB.prepare(`INSERT INTO ai_usage_events
            (id, purpose, profile_version_id, provider, model, status, translation_id, input_tokens, output_tokens,
             thinking_tokens, latency_ms, request_id, created_at)
            VALUES (?1, 'body_translation', ?2, ?3, ?4, 'completed', ?5, ?6, ?7, ?8, ?9, ?10, ?11)`)
            .bind(crypto.randomUUID(), context.bodyProfileVersionId, context.provider, context.model,
              input.translationId, inputTokens, outputTokens, thinkingTokens, latencyMs, input.requestId, finishedAt),
        ]);
        return { resultKey, htmlKey, blockCount: allResults.length };
      });
      return { translationId: input.translationId, status: "completed", ...completed };
    } catch (error) {
      if (!(error instanceof DiagnosticCapturedError) && lastProviderResponse) {
        try {
          await persistTranslationDiagnostic(this.env, input, lastProviderResponse.batchIndex, "workflow_failure",
            lastProviderResponse.responseStatus, lastProviderResponse.responseBody, error);
        } catch {
          // Diagnostic persistence must not replace the workflow's original terminal error.
        }
      }
      await step.do("record terminal translation failure", async () => {
        const message = (error instanceof Error ? error.message : "Translation workflow failed").slice(0, 500);
        await this.env.DB.batch([
          this.env.DB.prepare("UPDATE translations SET status = 'failed' WHERE id = ?1 AND status <> 'completed'").bind(input.translationId),
          this.env.DB.prepare(`UPDATE translation_attempts SET status = 'failed', error_code = 'workflow_failed',
            error_message = ?1, completed_at = ?2 WHERE id = ?3`).bind(message, now(), input.attemptId),
        ]);
      });
      throw error;
    }
  }
}

export default {
  fetch(): Response {
    return new Response(JSON.stringify({ error: { code: "not_found", message: "No public endpoints" } }), {
      status: 404, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  },
};
