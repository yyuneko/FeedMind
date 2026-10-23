import type { D1Database } from "../../shared/src/cloudflare";
import { ApiError, json } from "../../shared/src/http";
import { REQUEST_OWNER } from "../../shared/src/scoped-db";
import { contentHtmlToText } from "../../shared/src/content-blocks";
import {
  parseArticlePreprocessing,
  reconcilePreprocessingTags,
  TITLE_LOCALES,
  type ArticlePreprocessingResult,
  type ExistingTopicTag,
  type TitleLocale,
} from "../../translation-workflow/src/classification";

interface PreprocessingEnv { DB: D1Database }

interface PromptRow { task: string; targetLocale: string; id: string; content: string }
interface ArticleRow {
  id: string;
  title: string;
  feedTitle: string | null;
  summary: string | null;
  sourceHash: string;
  sourceTextHash: string;
  sourceTextBytes: number;
}
interface ProfileRow { id: string; contextWindowTokens: number }
export const GPT_ACTION_PROFILE_ID = "30000000-0000-4000-8000-000000000001";
interface Context {
  article: ArticleRow;
  classificationPrompt: PromptRow;
  preprocessingPrompt: PromptRow;
  titlePrompts: Record<TitleLocale, PromptRow>;
  profile: ProfileRow;
  threshold: number;
  tags: ExistingTopicTag[];
  contextVersion: string;
  tagVocabularyHash: string;
  instructions: string;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadContext(env: PreprocessingEnv, articleId: string): Promise<Context> {
  const article = await env.DB.prepare(`SELECT a.id, a.title, a.summary, a.source_hash AS sourceHash,
      a.source_text_hash AS sourceTextHash, a.source_text_bytes AS sourceTextBytes, f.title AS feedTitle
    FROM articles a LEFT JOIN feeds f ON f.id = a.feed_id
    WHERE a.id = ?1 AND a.owner_id = ?2 AND a.parse_status = 'completed'
      AND a.source_hash IS NOT NULL AND a.source_text_hash IS NOT NULL AND (
        (EXISTS (SELECT 1 FROM subscriptions s WHERE s.feed_id = a.feed_id AND s.owner_id = ?2 AND s.is_active = 1)
         AND EXISTS (SELECT 1 FROM account_source_selections selection JOIN source_connections connection
           ON connection.id = selection.active_connection_id
           WHERE selection.owner_id = ?2 AND connection.connector_type = 'direct_rss'))
        OR EXISTS (SELECT 1 FROM source_items si JOIN sources src ON src.id = si.source_id
          WHERE si.article_id = a.id AND si.owner_id = ?2 AND src.enabled = 1
            AND si.connection_id = (SELECT active_connection_id FROM account_source_selections WHERE owner_id = ?2)))`)
    .bind(articleId, REQUEST_OWNER).first<ArticleRow>();
  if (!article) {
    throw new ApiError(409, "article_preprocessing_unavailable", "Article must be accessible and fully parsed first");
  }
  const [prompts, profile, thresholdRow, tagRows] = await Promise.all([
    env.DB.prepare(`SELECT d.task, d.target_locale AS targetLocale, v.id, v.content FROM prompt_definitions d
      JOIN prompt_versions v ON v.id = d.current_version_id
      WHERE d.deleted_at IS NULL AND d.task IN ('classification', 'title_translation')
        AND ((d.task = 'classification' AND d.target_locale IN ('zh-CN', 'preprocessing'))
          OR (d.task = 'title_translation' AND d.target_locale IN ('zh-CN', 'en-US', 'ja-JP')))
        AND v.status = 'active'`).all<PromptRow>(),
    env.DB.prepare(`SELECT id, context_window_tokens AS contextWindowTokens FROM ai_profile_versions WHERE id = ?1`)
      .bind(GPT_ACTION_PROFILE_ID).first<ProfileRow>(),
    env.DB.prepare(`SELECT value_json AS valueJson FROM system_config_versions
      WHERE config_key = 'classification_threshold' AND status = 'active'`).first<{ valueJson: string }>(),
    env.DB.prepare(`SELECT tag_key AS key, names_json AS namesJson, aliases_json AS aliasesJson, status
      FROM topic_tags WHERE status = 'active' ORDER BY tag_key`)
      .all<{ key: string; namesJson: string; aliasesJson: string; status: "active" }>(),
  ]);
  const rows = prompts.results ?? [];
  const classificationPrompt = rows.find((item) => item.task === "classification" && item.targetLocale === "zh-CN");
  const preprocessingPrompt = rows.find((item) => item.task === "classification" && item.targetLocale === "preprocessing");
  const titlePrompts = Object.fromEntries(TITLE_LOCALES.map((locale) =>
    [locale, rows.find((item) => item.task === "title_translation" && item.targetLocale === locale)])) as
    Partial<Record<TitleLocale, PromptRow>>;
  if (!classificationPrompt || !preprocessingPrompt || !profile?.contextWindowTokens || !thresholdRow ||
      TITLE_LOCALES.some((locale) => !titlePrompts[locale])) {
    throw new ApiError(409, "preprocessing_configuration_incomplete", "Article preprocessing configuration is incomplete");
  }
  const tags = (tagRows.results ?? []).map((tag) => ({
    key: tag.key,
    names: JSON.parse(tag.namesJson),
    aliases: JSON.parse(tag.aliasesJson),
    status: tag.status,
  })) as ExistingTopicTag[];
  const threshold = Number((JSON.parse(thresholdRow.valueJson) as Record<string, unknown>).minimumConfidence ?? 0.65);
  const promptIds = [classificationPrompt.id, preprocessingPrompt.id,
    ...TITLE_LOCALES.map((locale) => titlePrompts[locale]!.id)];
  const tagVocabularyHash = await sha256(JSON.stringify(tags));
  const contextVersion = await sha256(JSON.stringify({ sourceTextHash: article.sourceTextHash, promptIds, threshold, tagVocabularyHash }));
  const instructions = `${classificationPrompt.content}\n\n${preprocessingPrompt.content}\n\n${TITLE_LOCALES.map((locale) =>
    `[Title translation: ${locale}]\n${titlePrompts[locale]!.content}`).join("\n\n")}\n\n` +
    "Return exactly one object with classification, localizedContent, informationScore, and tags. " +
    "classification.sourceTitleLocale must be zh-CN, en-US, ja-JP, or other. localizedContent must contain zh-CN, en-US, and ja-JP; " +
    "each value must contain title, a one-sentence summary, and 3-5 keyPoints. informationScore must contain integer total and integer " +
    "dimensions specificity, technicalDetail, practicalExperience, evidence, novelty, all 0-100, plus reason. tags must contain 3-5 unique " +
    "objects with lowercase kebab-case key and names for all three locales. Treat existingTags as authoritative: reuse an equivalent tag's key " +
    "and names exactly, and create a new tag only when no equivalent exists.";
  return {
    article, classificationPrompt, preprocessingPrompt,
    titlePrompts: titlePrompts as Record<TitleLocale, PromptRow>, profile, threshold, tags,
    contextVersion, tagVocabularyHash, instructions,
  };
}

export async function getArticlePreprocessingContext(
  env: PreprocessingEnv,
  articleId: string,
  requestId: string,
): Promise<Response> {
  const context = await loadContext(env, articleId);
  return json({ data: {
    articleId,
    sourceHash: context.article.sourceHash,
    sourceTextHash: context.article.sourceTextHash,
    title: context.article.title,
    feedTitle: context.article.feedTitle,
    rssSummary: context.article.summary ? contentHtmlToText(context.article.summary) : null,
    contextVersion: context.contextVersion,
    instructions: context.instructions,
    existingTags: context.tags,
  }, requestId }, requestId);
}

export async function saveArticlePreprocessing(
  request: Request,
  env: PreprocessingEnv,
  articleId: string,
  requestId: string,
): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await request.json() as Record<string, unknown>; }
  catch { throw new ApiError(400, "invalid_json", "A JSON request body is required"); }
  const suppliedContextVersion = typeof input.contextVersion === "string" ? input.contextVersion : "";
  const context = await loadContext(env, articleId);
  if (!suppliedContextVersion || suppliedContextVersion !== context.contextVersion) {
    throw new ApiError(409, "preprocessing_context_changed", "Reload preprocessing context before saving the result");
  }
  let result: ArticlePreprocessingResult;
  try {
    result = reconcilePreprocessingTags(parseArticlePreprocessing(JSON.stringify(input.result)), context.tags);
  } catch (error) {
    throw new ApiError(400, "invalid_preprocessing_result", error instanceof Error ? error.message : "Preprocessing result is invalid");
  }
  if (result.classification.confidence < context.threshold) result.classification.articleType = "general";
  const existing = await env.DB.prepare(`SELECT id FROM article_preprocessing_runs
    WHERE article_id = ?1 AND source_text_hash = ?2 AND status = 'completed' AND is_current = 1 LIMIT 1`)
    .bind(articleId, context.article.sourceTextHash).first<{ id: string }>();
  if (existing) {
    return json({ data: { articleId, runId: existing.id, status: "completed" }, reused: true, requestId }, requestId);
  }

  const created = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const classificationId = crypto.randomUUID();
  const resultFingerprint = await sha256(JSON.stringify({
    sourceTextHash: context.article.sourceTextHash,
    contextVersion: context.contextVersion,
    result,
    suppliedBy: "gpt_action",
  }));
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO article_preprocessing_tasks
      (id, article_id, source_hash, source_text_hash, status, requested_by, requested_by_subject,
       request_id, workflow_instance_id, attempt_count, created_at, started_at, completed_at)
      VALUES (?1, ?2, ?3, ?4, 'completed', 'system', 'gpt_action', ?5, 'gpt_action', 1, ?6, ?6, ?6)`)
      .bind(taskId, articleId, context.article.sourceHash, context.article.sourceTextHash, requestId, created),
    env.DB.prepare("UPDATE article_preprocessing_runs SET is_current = 0 WHERE article_id = ?1 AND is_current = 1").bind(articleId),
    env.DB.prepare("UPDATE article_classifications SET is_current = 0 WHERE article_id = ?1 AND source_hash = ?2 AND is_current = 1")
      .bind(articleId, context.article.sourceHash),
    env.DB.prepare(`INSERT INTO article_preprocessing_runs
      (id, task_id, article_id, source_hash, source_text_hash, result_fingerprint, status, is_current,
       policy_version, prompt_bundle_hash, preprocessing_prompt_version_id, classification_prompt_version_id,
       profile_version_id, tag_vocabulary_version, context_window_tokens, source_text_bytes,
       estimated_input_tokens, reserved_output_tokens, input_tokens, output_tokens, thinking_tokens, latency_ms,
       created_at, completed_at, tag_vocabulary_hash, profile_config_hash)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'completed', 1, 1, ?7, ?8, ?9, ?10, 1, ?11, ?12,
        0, 1, 0, 0, 0, 0, ?13, ?13, ?14, 'gpt-action-client-supplied-v1')`)
      .bind(runId, taskId, articleId, context.article.sourceHash, context.article.sourceTextHash, resultFingerprint,
        context.contextVersion, context.preprocessingPrompt.id, context.classificationPrompt.id, context.profile.id,
        context.profile.contextWindowTokens, context.article.sourceTextBytes, created, context.tagVocabularyHash),
    env.DB.prepare(`INSERT INTO article_classifications
      (id, article_id, article_type, source_title_locale, confidence, reason_summary, translated_title, title_status,
       source_hash, prompt_version_id, title_prompt_version_id, profile_version_id, title_profile_version_id,
       sampling_algorithm_version, sample_fragment_count, sample_manifest_hash, estimated_input_tokens,
       title_translation_policy_version, is_current, preprocessing_run_id, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'completed', ?8, ?9, ?10, ?11, ?11,
        'full-plain-text-v1', 1, ?12, 0, 3, 1, ?13, ?14)`)
      .bind(classificationId, articleId, result.classification.articleType, result.classification.sourceTitleLocale,
        result.classification.confidence, result.classification.reason, result.localizedContent["zh-CN"].title,
        context.article.sourceHash, context.classificationPrompt.id, context.titlePrompts["zh-CN"].id,
        context.profile.id, context.article.sourceTextHash, runId, created),
    ...TITLE_LOCALES.map((locale) => env.DB.prepare(`INSERT INTO article_title_translations
      (classification_id, target_locale, translated_title, status, prompt_version_id, profile_version_id, created_at)
      VALUES (?1, ?2, ?3, 'completed', ?4, ?5, ?6)`)
      .bind(classificationId, locale, result.localizedContent[locale].title,
        context.titlePrompts[locale].id, context.profile.id, created)),
    ...TITLE_LOCALES.map((locale) => env.DB.prepare(`INSERT INTO article_preprocessing_locales
      (run_id, target_locale, translated_title, one_line_summary, key_points_json)
      VALUES (?1, ?2, ?3, ?4, ?5)`)
      .bind(runId, locale, result.localizedContent[locale].title, result.localizedContent[locale].summary,
        JSON.stringify(result.localizedContent[locale].keyPoints))),
    ...TITLE_LOCALES.map((locale) => env.DB.prepare(`INSERT INTO article_gpt_localizations
      (owner_id, article_id, target_locale, source_hash, translated_title, one_line_summary,
       created_by, request_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'gpt_action', ?7, ?8, ?8)
      ON CONFLICT(owner_id, article_id, target_locale) DO UPDATE SET source_hash = excluded.source_hash,
        translated_title = excluded.translated_title, one_line_summary = excluded.one_line_summary,
        request_id = excluded.request_id, updated_at = excluded.updated_at`)
      .bind(REQUEST_OWNER, articleId, locale, context.article.sourceHash, result.localizedContent[locale].title,
        result.localizedContent[locale].summary, requestId, created)),
    env.DB.prepare(`INSERT INTO article_information_scores
      (run_id, total_score, dimensions_json, reason) VALUES (?1, ?2, ?3, ?4)`)
      .bind(runId, result.informationScore.total, JSON.stringify(result.informationScore.dimensions), result.informationScore.reason),
    ...result.tags.map((tag) => env.DB.prepare(`INSERT OR IGNORE INTO topic_tags
      (id, tag_key, status, names_json, aliases_json, vocabulary_version, created_at, updated_at)
      VALUES (?1, ?2, 'active', ?3, '[]', 1, ?4, ?4)`)
      .bind(crypto.randomUUID(), tag.key, JSON.stringify(tag.names), created)),
    ...result.tags.map((tag, index) => env.DB.prepare(`INSERT INTO article_topic_tags
      (run_id, tag_id, rank) SELECT ?1, id, ?2 FROM topic_tags WHERE tag_key = ?3`)
      .bind(runId, index + 1, tag.key)),
  ]);
  return json({ data: {
    articleId,
    runId,
    status: "completed",
    sourceHash: context.article.sourceHash,
    preprocessingStatus: "completed",
    ...result,
  }, reused: false, requestId }, requestId, 201);
}
