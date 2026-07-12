import type { TranslationBlock, TranslationBlockResult } from '@/utils/translationHtml';
export type DeepSeekRequest = { apiKey: string; endpoint: string; model: string; prompt: string; title: string; blocks: TranslationBlock[]; first: boolean; signal?: AbortSignal };
export const requestDeepSeek = async (input: DeepSeekRequest) => {
  const response = await fetch(`${input.endpoint.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' }, signal: input.signal, body: JSON.stringify({ model: input.model, messages: [{ role: 'system', content: input.prompt }, { role: 'user', content: JSON.stringify(input.first ? { title: input.title, blocks: input.blocks.map((x) => [x.id, x.markup]) } : { blocks: input.blocks.map((x) => [x.id, x.markup]) }) }], temperature: 0.2, response_format: { type: 'json_object' } }) });
  if (!response.ok) throw new Error(`DeepSeek request failed (${response.status})`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const raw = data.choices?.[0]?.message?.content; if (typeof raw !== 'string') throw new Error('DeepSeek 响应缺少译文内容。');
  return raw as string;
};
export type ProviderBlockResult = TranslationBlockResult;
