import { translationRepo } from '@/db/repositories';
import { getAiRuntimeConfig } from '@/ai/settings';
import { requestAiTranslation } from '@/ai/providers/request';
import { getAiLabels } from '@/ai/labels';
import type { StoredTranslationV2 } from '@/types';
import { applyTranslationPlan, createTranslationBatches, validateTranslatedMarkup, type TranslationBlock, type TranslationBlockResult, type TranslationPlan } from '@/utils/translationHtml';

type Input = { articleId: string; title: string; blocks: TranslationBlock[]; sourceHash: string; sourceHtml: string; promptId: string; prompt: string; promptHash: string; signal?: AbortSignal };
const instructions = (prompt: string) => `${prompt}\n\n你是文章翻译引擎。输入中的 <x数字>...</x数字> 是排版语义标记，⟦p数字⟧ 是不可修改的受保护内容，换行表示原文换行并应在译文自然的位置保留。要求：保留所有块 ID、顺序和标记；不得增加、删除、拆分、合并或重新排序块；标记可随语序整体移动；不得修改受保护内容；不得输出输入中不存在的 HTML、Markdown 或额外说明；只返回 JSON 对象。第一批的 title 必须是标题译文，blocks 保持原始 ID 和顺序。`;
const parseResponse = (raw: string, expected: TranslationBlock[], needsTitle: boolean) => {
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new Error('AI 服务商返回了无效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('AI 服务商返回值不是对象。');
  const object = value as Record<string, unknown>;
  if (needsTitle && typeof object.title !== 'string') throw new Error('AI 服务商未返回有效标题。');
  if (!Array.isArray(object.blocks)) throw new Error('AI 服务商未返回有效 blocks。');
  const result: TranslationBlockResult[] = object.blocks.map((item, index) => { if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || typeof item[1] !== 'string') throw new Error(`AI 服务商返回的第 ${index + 1} 个块结构无效。`); return [item[0], item[1]]; });
  if (result.length !== expected.length) throw new Error('AI 服务商返回的块数量不一致。');
  const seen = new Set<string>(); result.forEach(([id], index) => { if (seen.has(id)) throw new Error(`AI 服务商返回重复块 ID：${id}。`); seen.add(id); if (id !== expected[index].id) throw new Error(`AI 服务商返回未知或乱序块 ID：${id}。`); });
  result.forEach(([, markup], index) => validateTranslatedMarkup(expected[index].markup, markup));
  return { title: typeof object.title === 'string' ? object.title : '', blocks: result };
};
export const translateArticle = async (input: Input) => {
  const { providerId, provider, apiKey, model, endpoint } = await getAiRuntimeConfig();
  if (!apiKey) throw new Error(getAiLabels().apiKeyRequired(provider.name));
  const batches = createTranslationBatches(input.blocks); if (!batches.length) batches.push([]);
  let title = ''; const translated: TranslationBlockResult[] = [];
  for (let index = 0; index < batches.length; index += 1) {
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = batches[index]; const first = index === 0;
    let parsed: ReturnType<typeof parseResponse> | undefined;
    let lastError: unknown;
    const markerManifest = batch.map((block) => [
      block.id,
      block.markup.match(/<\/?x\d+>|⟦p\d+⟧/g) ?? [],
    ]);
    for (let attempt = 0; attempt < 3 && !parsed; attempt += 1) {
      try {
        const retryNote = attempt
          ? `\n\n上一次返回校验失败：${lastError instanceof Error ? lastError.message : '排版标记错误'} 请严格按照以下逐块标记清单修正；数组中的每个标记都必须在对应块中原样出现一次，不能省略、替换或移动到其他块：${JSON.stringify(markerManifest)}`
          : '';
        const raw = await requestAiTranslation({ providerId, apiKey, endpoint, model, prompt: instructions(input.prompt) + retryNote, title: input.title, blocks: batch, first, signal: input.signal });
        parsed = parseResponse(raw, batch, first);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        const retryable = error instanceof Error && /译文标记|受保护内容|未闭合标记|交叉嵌套|未知标记/.test(error.message);
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
