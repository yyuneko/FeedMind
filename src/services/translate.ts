import { translationRepo } from '@/db/repositories';
import { getAiRuntimeConfig } from '@/ai/settings';
import { requestAiTranslation } from '@/ai/providers/request';
import { getAiLabels } from '@/ai/labels';
import { parseAiJsonResponse } from '@/ai/parseJson';
import type { StoredTranslationV2 } from '@/types';
import { TranslationBatchValidationError, TranslationMarkupError, applyTranslationPlan, createTranslationBatches, validateTranslatedMarkup, type TranslationBlock, type TranslationBlockResult, type TranslationMarkupDiagnostic, type TranslationPlan } from '@/utils/translationHtml';
import { buildTranslationInstructions } from './translationPrompt';
import { parseStreamingTranslationResponse } from './streamingTranslationJson';

export type TranslationProgress = { title: string; blocks: TranslationBlockResult[]; totalBlocks: number };
export type TranslateArticleInput = { articleId: string; title: string; blocks: TranslationBlock[]; sourceHash: string; sourceHtml: string; promptId: string; prompt: string; promptHash: string; signal?: AbortSignal; onProgress?: (progress: TranslationProgress) => void };
const maxTranslationAttempts = 3;
type TranslationFailureLog = {
  articleId: string;
  providerId: string;
  provider: string;
  model: string;
  batch: number;
  totalBatches: number;
  attempt: number;
  maxAttempts: number;
  failedBlocks?: string[];
  diagnostics?: TranslationMarkupDiagnostic[];
  error?: string;
};
const validationFailureLog = (
  context: Omit<TranslationFailureLog, 'failedBlocks' | 'diagnostics' | 'error'>,
  error: TranslationBatchValidationError
): TranslationFailureLog => ({
  ...context,
  failedBlocks: error.errors.map((item) => item.diagnostic.blockId ?? '?'),
  diagnostics: error.errors.map((item) => item.diagnostic),
});
const parseResponse = (raw: string, expected: TranslationBlock[], needsTitle: boolean) => {
  const value = parseAiJsonResponse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 服务商返回值不是对象。');
  const object = value as Record<string, unknown>;
  if (needsTitle && typeof object.title !== 'string') throw new Error('AI 服务商未返回有效标题。');
  if (!Array.isArray(object.blocks)) throw new Error('AI 服务商未返回有效 blocks。');
  const result: TranslationBlockResult[] = object.blocks.map((item, index) => {
    if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string') return [item[0], item[1]];
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const block = item as Record<string, unknown>;
      const text = typeof block.text === 'string' ? block.text : block.markup;
      if (typeof block.id === 'string' && typeof text === 'string') return [block.id, text];
    }
    throw new Error(`AI 服务商返回的第 ${index + 1} 个块结构无效。`);
  });
  if (result.length !== expected.length) throw new Error('AI 服务商返回的块数量不一致。');
  const seen = new Set<string>(); result.forEach(([id], index) => { if (seen.has(id)) throw new Error(`AI 服务商返回重复块 ID：${id}。`); seen.add(id); if (id !== expected[index].id) throw new Error(`AI 服务商返回未知或乱序块 ID：${id}。`); });
  return { title: typeof object.title === 'string' ? object.title : '', blocks: result };
};
export const translateArticle = async (input: TranslateArticleInput) => {
  const { providerId, provider, apiKey, model, endpoint } = await getAiRuntimeConfig();
  if (!apiKey) throw new Error(getAiLabels().apiKeyRequired(provider.name));
  const batches = createTranslationBatches(input.blocks); if (!batches.length) batches.push([]);
  let title = ''; const translated: TranslationBlockResult[] = [];
  input.onProgress?.({ title, blocks: translated, totalBlocks: input.blocks.length });
  for (let index = 0; index < batches.length; index += 1) {
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = batches[index]; const first = index === 0;
    let parsed: ReturnType<typeof parseResponse> | undefined;
    let candidate: ReturnType<typeof parseResponse> | undefined;
    let repairBlocks = batch;
    let lastError: unknown;
    const validatedById = new Map<string, string>();
    let progressTitle = title;
    let publishedSignature = '';
    const publishValidated = (nextTitle?: string) => {
      if (nextTitle !== undefined) progressTitle = nextTitle;
      const currentBlocks = batch.flatMap((block) => {
        const markup = validatedById.get(block.id);
        return markup === undefined ? [] : [[block.id, markup] as TranslationBlockResult];
      });
      const progressBlocks = [...translated, ...currentBlocks];
      const signature = progressTitle + ':' + JSON.stringify(progressBlocks);
      if (signature === publishedSignature) return;
      publishedSignature = signature;
      input.onProgress?.({ title: progressTitle, blocks: progressBlocks, totalBlocks: input.blocks.length });
    };
    for (let attempt = 0; attempt < maxTranslationAttempts && !parsed; attempt += 1) {
      try {
        const markerManifest = repairBlocks.map((block) => [
          block.id,
          block.markup.match(/<\/?x\d+>|⟦p\d+⟧/g) ?? [],
        ]);
        const retryNote = attempt
          ? `\n\n上一次返回校验失败：${lastError instanceof Error ? lastError.message : '排版标记错误'} 本次输入只包含校验失败的块。请逐块修正；以下数组中的每个标记都必须在对应块中原样且恰好出现一次，不能省略、重复、替换或移动到其他块：${JSON.stringify(markerManifest)}`
          : '';
        const needsTitle = first && !candidate;
        const onTextDelta = (_delta: string, accumulated: string) => {
          const partial = parseStreamingTranslationResponse(accumulated);
          const expectedById = new Map(batch.map((block) => [block.id, block]));
          for (const [id, markup] of partial.blocks) {
            if (validatedById.has(id)) continue;
            const source = expectedById.get(id);
            if (!source) continue;
            try {
              validateTranslatedMarkup(source.markup, markup, id);
              validatedById.set(id, markup);
            } catch { /* Publish only complete, valid translated blocks. */ }
          }
          publishValidated(partial.title ?? candidate?.title);
        };
        const raw = await requestAiTranslation({ providerId, apiKey, endpoint, model, prompt: buildTranslationInstructions(input.prompt) + retryNote, title: input.title, blocks: repairBlocks, first: needsTitle, signal: input.signal, onTextDelta });
        const repaired = parseResponse(raw, repairBlocks, needsTitle);
        if (!candidate) candidate = repaired;
        else {
          const replacements = new Map(repaired.blocks);
          candidate = { ...candidate, blocks: candidate.blocks.map(([id, markup]) => [id, replacements.get(id) ?? markup]) };
        }
        const translatedById = new Map(candidate.blocks);
        const invalid: TranslationBlock[] = [];
        const validationErrors: TranslationMarkupError[] = [];
        for (const block of batch) {
          try {
            const markup = translatedById.get(block.id) ?? '';
            validateTranslatedMarkup(block.markup, markup, block.id);
            if (!validatedById.has(block.id)) validatedById.set(block.id, markup);
          } catch (error) {
            if (!(error instanceof TranslationMarkupError)) throw error;
            invalid.push(block);
            validationErrors.push(error);
          }
        }
        publishValidated(candidate.title || undefined);
        if (!invalid.length) parsed = candidate;
        else {
          repairBlocks = invalid;
          const validationError = new TranslationBatchValidationError(index + 1, validationErrors);
          lastError = validationError;
          console.warn('翻译响应标记校验失败', validationFailureLog({
            articleId: input.articleId,
            providerId,
            provider: provider.name,
            model,
            batch: index + 1,
            totalBatches: batches.length,
            attempt: attempt + 1,
            maxAttempts: maxTranslationAttempts,
          }, validationError));
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        const retryable = error instanceof TranslationMarkupError || (error instanceof Error && /无效 JSON|译文标记|受保护内容|未闭合标记|交叉嵌套|未知标记|HTML 标签/.test(error.message));
        if (!retryable) throw error;
        lastError = error;
        console.warn('翻译响应解析或校验失败', {
          articleId: input.articleId,
          providerId,
          provider: provider.name,
          model,
          batch: index + 1,
          totalBatches: batches.length,
          attempt: attempt + 1,
          maxAttempts: maxTranslationAttempts,
          error: error.message,
        } satisfies TranslationFailureLog);
      }
    }
    if (!parsed) {
      const finalError = lastError instanceof TranslationBatchValidationError
        ? lastError
        : new Error('批次 ' + (index + 1) + ' 翻译失败（已重试 ' + maxTranslationAttempts + ' 次）：' + (lastError instanceof Error ? lastError.message : '未知错误'));
      const context = {
        articleId: input.articleId,
        providerId,
        provider: provider.name,
        model,
        batch: index + 1,
        totalBatches: batches.length,
        attempt: maxTranslationAttempts,
        maxAttempts: maxTranslationAttempts,
      };
      console.error('翻译最终失败', finalError instanceof TranslationBatchValidationError
        ? validationFailureLog(context, finalError)
        : { ...context, error: finalError.message });
      throw finalError;
    }
    if (first) title = parsed.title; translated.push(...parsed.blocks);
    input.onProgress?.({ title, blocks: [...translated], totalBlocks: input.blocks.length });
  }
  const plan: TranslationPlan = { sourceHtml: input.sourceHtml, sourceHash: input.sourceHash, blocks: input.blocks };
  applyTranslationPlan(plan, translated);
  const stored: StoredTranslationV2 = { v: 2, title, sourceHash: input.sourceHash, promptHash: input.promptHash, blocks: translated };
  const content = JSON.stringify(stored); await translationRepo.save(input.articleId, input.promptId, content); return content;
};
