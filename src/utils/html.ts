import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const allowedTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'figure', 'figcaption', 'img', 'video', 'iframe', 'pre', 'code', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'mark', 'span', 'del', 's', 'sup']);
const allowedAttributes: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  video: new Set(['src', 'poster', 'width', 'height']),
  iframe: new Set(['src', 'title', 'width', 'height']),
  code: new Set(['class']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

const codeLanguageClass = (className: string) => className
  .split(/\s+/)
  .find((name) => /^(?:language|lang)-[a-z0-9_+#.-]+$/i.test(name));

const videoEmbedHosts = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'player.vimeo.com',
  'player.bilibili.com',
  'player.youku.com',
  'v.qq.com',
  'dailymotion.com',
  'dai.ly',
];

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

export const resolveArticleUrl = (value: string, baseUrl?: string) => {
  if (!baseUrl || !value.trim()) return value;
  try {
    const base = new URL(baseUrl);
    const resolved = new URL(value, base);
    // HTTPS pages sometimes still publish same-origin HTTP media URLs. Those
    // requests are blocked as mixed content in browsers and as cleartext
    // traffic on Android, even when the host serves the same asset over HTTPS.
    if (base.protocol === 'https:' && resolved.protocol === 'http:' && resolved.hostname === base.hostname) {
      resolved.protocol = 'https:';
    }
    return resolved.href;
  } catch {
    return value;
  }
};

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const isVideoEmbedUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const hostname = url.hostname.toLowerCase();
    return videoEmbedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
};

export const sanitizeArticleHtml = (value: string, baseUrl?: string) => {
  const html = hasHtmlTag(value) ? value : textToHtml(value);
  try {
    const { document } = parseHTML(`<body>${html}</body>`);
    const body = document.querySelector('body');
    if (!body) return '';
    for (const element of Array.from(body.querySelectorAll('*'))) {
      const tag = element.tagName.toLowerCase();
      if (['script', 'form', 'style', 'nav', 'header', 'footer', 'aside', 'svg', 'math'].includes(tag)) { element.remove(); continue; }
      if (!allowedTags.has(tag)) { element.replaceWith(...Array.from(element.childNodes)); continue; }
      const whitelist = new Set([...(allowedAttributes[tag] ?? []), 'id']);
      if (tag === 'pre') {
        const languageClass = codeLanguageClass(element.getAttribute('class') ?? '');
        const code = element.querySelector('code');
        if (languageClass && code && !codeLanguageClass(code.getAttribute('class') ?? '')) {
          code.setAttribute('class', languageClass);
        }
      }
      if (tag === 'img') {
        const srcset = element.getAttribute('srcset') || element.getAttribute('data-srcset');
        const src = element.getAttribute('src')
          || element.getAttribute('data-src')
          || element.getAttribute('data-original')
          || srcset?.split(',')[0]?.trim().split(/\s+/)[0];
        if (src) element.setAttribute('src', resolveArticleUrl(src, baseUrl));
      }
      if (tag === 'video') {
        const source = element.querySelector('source');
        const src = element.getAttribute('src')
          || element.getAttribute('data-src')
          || source?.getAttribute('src')
          || source?.getAttribute('data-src');
        const resolvedSrc = src ? resolveArticleUrl(src, baseUrl) : '';
        if (!isHttpUrl(resolvedSrc)) { element.remove(); continue; }
        element.setAttribute('src', resolvedSrc);
        const poster = element.getAttribute('poster') || element.getAttribute('data-poster');
        if (poster) {
          const resolvedPoster = resolveArticleUrl(poster, baseUrl);
          if (isHttpUrl(resolvedPoster)) element.setAttribute('poster', resolvedPoster);
          else element.removeAttribute('poster');
        }
      }
      if (tag === 'iframe') {
        const src = resolveArticleUrl(element.getAttribute('src') || element.getAttribute('data-src') || '', baseUrl);
        if (!isVideoEmbedUrl(src)) { element.remove(); continue; }
        element.setAttribute('src', src);
      }
      for (const attribute of Array.from(element.attributes)) if (!whitelist.has(attribute.name.toLowerCase())) element.removeAttribute(attribute.name);
      if (tag === 'code') {
        const languageClass = codeLanguageClass(element.getAttribute('class') ?? '');
        if (languageClass) element.setAttribute('class', languageClass);
        else element.removeAttribute('class');
      }
      if (tag === 'a') {
        const href = element.getAttribute('href');
        if (element.closest('h1, h2, h3, h4, h5, h6')) element.removeAttribute('href');
        else if (href && !href.trim().startsWith('#')) element.setAttribute('href', resolveArticleUrl(href, baseUrl));
      }
    }
    return body.innerHTML.trim();
  } catch { return textToHtml(stripHtml(html)); }
};

export const extractReadableArticleHtml = (html: string, baseUrl?: string) => {
  try {
    const { document } = parseHTML(html);
    const content = new Readability(document as unknown as Document).parse()?.content;
    if (content) return sanitizeArticleHtml(content, baseUrl);
  } catch {
    // Fall back to the lightweight extraction below.
  }
  const article = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
  if (article) return sanitizeArticleHtml(article, baseUrl);
  const pgEssay = html.match(/<font[^>]*face=["']?verdana["']?[^>]*>([\s\S]*?)<\/font>\s*<\/td>\s*<\/tr>\s*<\/table>/i)?.[1];
  if (pgEssay) return sanitizeArticleHtml(pgEssay, baseUrl);
  return sanitizeArticleHtml(html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html, baseUrl);
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

export const hasArticleMedia = (html: string) => /<(?:video|iframe)\b/i.test(html);

export type ArticleHeading = { id: string; level: number; title: string };

export const addArticleHeadingIds = (html: string) => {
  try {
    const { document } = parseHTML(`<body>${html}</body>`);
    const body = document.querySelector('body');
    if (!body) return html;
    Array.from(body.querySelectorAll('h1, h2, h3, h4, h5, h6')).forEach((element, index) => {
      element.setAttribute('id', `feedmind-heading-${index}`);
    });
    return body.innerHTML.trim();
  } catch { return html; }
};

export const extractArticleHeadings = (html: string): ArticleHeading[] => {
  try {
    const { document } = parseHTML(`<body>${html}</body>`);
    return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6')).flatMap((element) => {
      const id = element.getAttribute('id') ?? '';
      const title = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return id && title ? [{ id, level: Number(element.tagName.slice(1)), title }] : [];
    });
  } catch { return []; }
};

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
  if (/^<(?:img|video|iframe|pre|table)\b/i.test(html)) return [html];
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
  const pattern = /<(p|h[1-6]|li|blockquote|pre|table|video|iframe)\b[^>]*>[\s\S]*?<\/\1>|<img\b[^>]*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    blocks.push(match[0].trim());
  }
  if (blocks.length) return blocks.flatMap(splitHtmlBlock);
  return content
    .split(/(<(?:img|video|iframe)\b[^>]*\/?>(?:<\/(?:video|iframe)>)?)/gi)
    .flatMap((item) => {
      const part = item.trim();
      if (!part) return [];
      if (/^<(?:img|video|iframe)\b/i.test(part)) return [part];
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

const noiseImagePattern = /(?:^|[\/_\-.])(avatar|author|badge|button|emoji|icon|logo|pixel|spacer|sprite|tracking|advert|ads?)(?:[\/_\-.]|$)/i;

/** Returns the first likely editorial image from already-sanitized article content. */
export const extractFirstContentImage = (html: string) => {
  try {
    const { document } = parseHTML(`<body>${html}</body>`);
    for (const image of Array.from(document.querySelectorAll('img'))) {
      const src = image.getAttribute('src')?.trim() ?? '';
      if (!src || !/^https?:\/\//i.test(src) || noiseImagePattern.test(src)) continue;
      const width = Number.parseInt(image.getAttribute('width') ?? '', 10);
      const height = Number.parseInt(image.getAttribute('height') ?? '', 10);
      if ((Number.isFinite(width) && width > 0 && width < 80)
        || (Number.isFinite(height) && height > 0 && height < 80)) continue;
      const alt = image.getAttribute('alt')?.trim() ?? '';
      if (alt && noiseImagePattern.test(alt)) continue;
      return src;
    }
  } catch {
    // A missing thumbnail is handled by the list placeholder.
  }
  return null;
};

export const getFeedIconUrl = (siteUrl?: string | null, feedUrl?: string | null) => {
  for (const value of [siteUrl, feedUrl]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'http:' || url.protocol === 'https:') return `${url.origin}/favicon.ico`;
    } catch {
      // Try the next URL.
    }
  }
  return null;
};
