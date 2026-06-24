import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const allowedTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'img', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'br', 'strong', 'b', 'em', 'i', 'u', 'mark', 'span', 'del', 's']);

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const hasHtmlTag = (value: string) => /<\/?[a-z][\s\S]*>/i.test(value);

const textToHtml = (value: string) =>
  value
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `<p>${escapeHtml(item).replace(/\n/g, '<br>')}</p>`)
    .join('');

const removeInlineColors = (html: string) =>
  html
    .replace(/\scolor=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (_match, quote: string, style: string) => {
      const next = style
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item && !/^color\s*:/i.test(item))
        .join('; ');
      return next ? ` style=${quote}${next}${quote}` : '';
    });

export const sanitizeArticleHtml = (value: string) => {
  const html = hasHtmlTag(value) ? value : textToHtml(value);
  return removeInlineColors(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|iframe|form|style|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|form|style|nav|header|footer|aside)\b[^>]*\/?>/gi, '')
    .replace(/<\/?([a-z][\w:-]*)\b[^>]*>/gi, (match, tag: string) => {
      const normalized = tag.toLowerCase();
      if (allowedTags.has(normalized)) return match;
      return '';
    })
    .trim();
};

export const extractReadableArticleHtml = (html: string) => {
  try {
    const { document } = parseHTML(html);
    const content = new Readability(document as unknown as Document).parse()?.content;
    if (content) return sanitizeArticleHtml(content);
  } catch {
    // Fall back to the lightweight extraction below.
  }
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (article) return sanitizeArticleHtml(article);
  const pgEssay = html.match(/<font[^>]*face=["']?verdana["']?[^>]*>([\s\S]*?)<\/font>\s*<\/td>\s*<\/tr>\s*<\/table>/i)?.[1];
  if (pgEssay) return sanitizeArticleHtml(pgEssay);
  return sanitizeArticleHtml(html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html);
};

export const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

export const htmlToParagraphText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|li|blockquote|pre|tr|div|section|article)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export const splitParagraphs = (content: string) =>
  content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

const splitHtmlBlock = (html: string) => {
  if (/^<(?:img|pre|table)\b/i.test(html)) return [html];
  const match = html.match(/^<([a-z][\w:-]*)([^>]*)>([\s\S]*)<\/\1>$/i);
  if (!match || !/(?:<br\s*\/?>\s*){2,}/i.test(match[3])) return [html];
  return match[3]
    .split(/(?:<br\s*\/?>\s*){2,}/gi)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => `<${match[1]}${match[2]}>${item}</${match[1]}>`);
};

export const htmlToBlocks = (html: string) => {
  const blocks: string[] = [];
  const content = sanitizeArticleHtml(html);
  const pattern = /<(p|h[1-6]|li|blockquote|pre|table)\b[^>]*>[\s\S]*?<\/\1>|<img\b[^>]*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    blocks.push(match[0].trim());
  }
  if (blocks.length) return blocks.flatMap(splitHtmlBlock);
  return content
    .split(/(<img\b[^>]*\/?>)/gi)
    .flatMap((item) => {
      const part = item.trim();
      if (!part) return [];
      if (/^<img\b/i.test(part)) return [part];
      return part
        .split(/(?:<br\s*\/?>\s*){2,}/gi)
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => `<p>${text}</p>`);
    });
};

export const htmlBlocksToText = (html: string) =>
  htmlToBlocks(html)
    .map((item) => stripHtml(item))
    .filter(Boolean);

export const normalizeParagraphs = (items: string[], length: number) => {
  return Array.from({ length }, (_item, index) => items[index] ?? '');
};

const normalizeText = (value: string) => value.replace(/\s+/g, ' ').trim();

export const isTranslationAligned = (source: string[], original: string[]) =>
  source.length === original.length && source.every((item, index) => normalizeText(item) === normalizeText(original[index] ?? ''));

export const parseTranslationContent = (content: string) => {
  const fallback = splitParagraphs(content);
  try {
    const parsed = JSON.parse(content) as { title?: unknown; content?: unknown; original?: unknown; translate?: unknown };
    if (typeof parsed.content === 'string') {
      return {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        original: [],
        translate: splitParagraphs(parsed.content),
      };
    }
    if (Array.isArray(parsed.original) && Array.isArray(parsed.translate)) {
      return {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        original: parsed.original.map(String),
        translate: parsed.translate.map(String),
      };
    }
  } catch {
    return { title: '', original: [], translate: fallback };
  }
  return { title: '', original: [], translate: fallback };
};

export const getArticleSummary = (html: string) => stripHtml(html);
