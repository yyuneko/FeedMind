import type { TranslationBlockResult } from '@/utils/translationHtml';

const quote = String.fromCharCode(34);
const stringToken = quote + '(?:\\\\.|[^' + quote + '\\\\])*' + quote;
const blockPattern = new RegExp('\\[\\s*(' + stringToken + ')\\s*,\\s*(' + stringToken + ')\\s*\\]', 'gu');
const valueStart = (raw: string, key: string) => {
  const property = raw.indexOf(quote + key + quote);
  if (property < 0) return -1;
  const colon = raw.indexOf(':', property + key.length + 2);
  return colon < 0 ? -1 : colon + 1;
};

const completedString = (raw: string, start: number) => {
  if (start < 0) return undefined;
  while (start < raw.length && (raw[start] ?? '').trim() === '') start += 1;
  if (raw.charCodeAt(start) !== 34) return undefined;
  let escaped = false;
  for (let index = start + 1; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (escaped) { escaped = false; continue; }
    if (code === 92) { escaped = true; continue; }
    if (code !== 34) continue;
    try { return JSON.parse(raw.slice(start, index + 1)) as string; } catch { return undefined; }
  }
  return undefined;
};
export const parseStreamingTranslationResponse = (raw: string) => {
  const title = completedString(raw, valueStart(raw, 'title'));
  const blocks: TranslationBlockResult[] = [];
  const blocksStart = valueStart(raw, 'blocks');
  if (blocksStart <= 0) return { title, blocks };
  for (const match of raw.slice(blocksStart).matchAll(blockPattern)) {
    try {
      const id: unknown = JSON.parse(match[1]);
      const markup: unknown = JSON.parse(match[2]);
      if (typeof id === 'string' && typeof markup === 'string') blocks.push([id, markup]);
    } catch { /* The final parser reports malformed items. */ }
  }
  return { title, blocks };
};
