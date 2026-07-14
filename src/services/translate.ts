import { translationRepo } from '@/db/repositories';
import { getAiRuntimeConfig } from '@/ai/settings';
import { requestAiTranslation } from '@/ai/providers/request';
import { getAiLabels } from '@/ai/labels';
import type { StoredTranslationV2 } from '@/types';
import { applyTranslationPlan, createTranslationBatches, validateTranslatedMarkup, type TranslationBlock, type TranslationBlockResult, type TranslationPlan } from '@/utils/translationHtml';
import { buildTranslationInstructions } from './translationPrompt';

export type TranslateArticleInput = { articleId: string; title: string; blocks: TranslationBlock[]; sourceHash: string; sourceHtml: string; promptId: string; prompt: string; promptHash: string; signal?: AbortSignal };
const parseResponse = (raw: string, expected: TranslationBlock[], needsTitle: boolean) => {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('AI 服务商返回了无效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 服务商返回值不是对象。');
  const object = value as Record<string, unknown>;
  if (needsTitle && typeof object.title !== 'string') throw new Error('AI 服务商未返回有效标题。');
  if (!Array.isArray(object.blocks)) throw new Error('AI 服务商未返回有效 blocks。');
  const result: TranslationBlockResult[] = object.blocks.map((item, index) => { if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw new Error(`AI 服务商返回的第 ${index + 1} 个块结构无效。`); return [item[0], item[1]]; });
  if (result.length !== expected.length) throw new Error('AI 服务商返回的块数量不一致。');
  const seen = new Set<string>(); result.forEach(([id], index) => { if (seen.has(id)) throw new Error(`AI 服务商返回重复块 ID：${id}。`); seen.add(id); if (id !== expected[index].id) throw new Error(`AI 服务商返回未知或乱序块 ID：${id}。`); });
  return { title: typeof object.title === 'string' ? object.title : '', blocks: result };
};
export const translateArticle = async (input: TranslateArticleInput) => {
  const { providerId, provider, apiKey, model, endpoint } = await getAiRuntimeConfig();
  if (!apiKey) throw new Error(getAiLabels().apiKeyRequired(provider.name));
  const batches = createTranslationBatches(input.blocks); if (!batches.length) batches.push([]);
  let title = ''; const translated: TranslationBlockResult[] = [];
  for (let index = 0; index < batches.length; index += 1) {
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = batches[index]; const first = index === 0;
    let parsed: ReturnType<typeof parseResponse> | undefined;
    let candidate: ReturnType<typeof parseResponse> | undefined;
    let repairBlocks = batch;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3 && !parsed; attempt += 1) {
      try {
        const markerManifest = repairBlocks.map((block) => [
          block.id,
          block.markup.match(/<\/?x\d+>|⟦p\d+⟧/g) ?? [],
        ]);
        const retryNote = attempt
          ? `\n\n上一次返回校验失败：${lastError instanceof Error ? lastError.message : '排版标记错误'} 本次输入只包含校验失败的块。请逐块修正；以下数组中的每个标记都必须在对应块中原样且恰好出现一次，不能省略、重复、替换或移动到其他块：${JSON.stringify(markerManifest)}`
          : '';
        const needsTitle = first && !candidate;
        const raw = await requestAiTranslation({ providerId, apiKey, endpoint, model, prompt: buildTranslationInstructions(input.prompt) + retryNote, title: input.title, blocks: repairBlocks, first: needsTitle, signal: input.signal });
        const repaired = parseResponse(raw, repairBlocks, needsTitle);
        if (!candidate) candidate = repaired;
        else {
          const replacements = new Map(repaired.blocks);
          candidate = { ...candidate, blocks: candidate.blocks.map(([id, markup]) => [id, replacements.get(id) ?? markup]) };
        }
        const translatedById = new Map(candidate.blocks);
        const invalid: TranslationBlock[] = [];
        let validationError: unknown;
        for (const block of batch) {
          try {
            validateTranslatedMarkup(block.markup, translatedById.get(block.id) ?? '');
          } catch (error) {
            invalid.push(block);
            validationError ??= error;
          }
        }
        if (!invalid.length) parsed = candidate;
        else {
          repairBlocks = invalid;
          lastError = validationError;
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        const retryable = error instanceof Error && /无效 JSON|译文标记|受保护内容|未闭合标记|交叉嵌套|未知标记/.test(error.message);
        if (!retryable) throw error;
        lastError = error;
      }
    }
    if (!parsed) throw lastError;
    if (first) title = parsed.title; translated.push(...parsed.blocks);
  }
  const plan: TranslationPlan = { sourceHtml: input.sourceHtml, sourceHash: input.sourceHash, blocks: input.blocks };
  applyTranslationPlan(plan, translated);
  const stored: StoredTranslationV2 = { v: 2, title, sourceHash: input.sourceHash, promptHash: input.promptHash, blocks: translated };
  const content = JSON.stringify(stored); await translationRepo.save(input.articleId, input.promptId, content); return content;
};
