import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

const allowedTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'figure', 'figcaption', 'img', 'video', 'audio', 'source', 'iframe', 'svg', 'feedmind-math', 'pre', 'code', 'kbd', 'samp', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a', 'br', 'hr', 'strong', 'b', 'em', 'i', 'u', 'mark', 'span', 'del', 's', 'sup', 'sub']);
const allowedAttributes: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  video: new Set(['src', 'poster', 'width', 'height']),
  audio: new Set(['src']),
  source: new Set(['src', 'type']),
  iframe: new Set(['src', 'title', 'width', 'height']),
  'feedmind-math': new Set(['data-format', 'data-display']),
  code: new Set(['class']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan']),
};

const svgTags = new Set([
  'svg', 'g', 'defs', 'symbol', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'text', 'tspan', 'lineargradient', 'radialgradient', 'stop', 'pattern',
  'clippath', 'mask', 'marker', 'filter', 'fegaussianblur', 'feoffset', 'feblend', 'fecolormatrix', 'use',
]);
const svgAttributes = new Set([
  'id', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'd', 'points', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity', 'transform', 'gradientunits',
  'gradienttransform', 'offset', 'stop-color', 'stop-opacity', 'patternunits', 'patterntransform',
  'preserveaspectratio', 'clip-path', 'clip-rule', 'mask', 'marker-start', 'marker-mid', 'marker-end',
  'filter', 'stddeviation', 'dx', 'dy', 'in', 'in2', 'result', 'values', 'font-family', 'font-size',
  'font-weight', 'text-anchor', 'dominant-baseline', 'role', 'aria-label', 'href', 'xmlns',
]);
const mathMlTags = new Set([
  'math', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'mglyph', 'mfrac', 'msqrt', 'mroot',
  'mstyle', 'merror', 'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub', 'msup', 'msubsup',
  'munder', 'mover', 'munderover', 'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr', 'mtd',
  'maligngroup', 'malignmark', 'semantics', 'annotation',
]);
const mathMlAttributes = new Set([
  'display', 'xmlns', 'mathvariant', 'mathsize', 'mathcolor', 'mathbackground', 'displaystyle',
  'scriptlevel', 'stretchy', 'symmetric', 'fence', 'separator', 'lspace', 'rspace', 'minsize', 'maxsize',
  'accent', 'accentunder', 'align', 'columnalign', 'rowalign', 'columnspan', 'rowspan', 'encoding',
]);

const sanitizeSvg = (root: Element) => {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const tag = element.tagName.toLowerCase();
    if (!svgTags.has(tag)) { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (!svgAttributes.has(name)
        || name.startsWith('on')
        || (name === 'href' && !value.trim().startsWith('#'))
        || /url\s*\((?!\s*#)|(?:javascript|data):/i.test(value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
};

const sanitizeMathMl = (root: Element) => {
  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    const tag = element.tagName.toLowerCase();
    if (!mathMlTags.has(tag)) { element.remove(); continue; }
    for (const attribute of Array.from(element.attributes)) {
      if (!mathMlAttributes.has(attribute.name.toLowerCase()) || /(?:javascript|data):/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }
};

const createFormulaElement = (document: Document, format: 'tex' | 'mathml', display: boolean, source: string) => {
  const formula = document.createElement('feedmind-math');
  formula.setAttribute('data-format', format);
  formula.setAttribute('data-display', display ? 'block' : 'inline');
  formula.textContent = source.trim();
  return formula;
};

const unwrapTexDelimiters = (value: string) => {
  const source = value.trim();
  for (const [open, close, display] of [['\\[', '\\]', true], ['\\(', '\\)', false], ['$$', '$$', true]] as const) {
    if (source.startsWith(open) && source.endsWith(close)) {
      return { source: source.slice(open.length, -close.length).trim(), display };
    }
  }
  return { source, display: false };
};

const normalizeFormulaElements = (document: Document, body: Element) => {
  for (const object of Array.from(body.querySelectorAll('object'))) {
    const className = ` ${object.getAttribute('class')?.toLowerCase() ?? ''} `;
    const dataUrl = object.getAttribute('data')?.toLowerCase() ?? '';
    const mediaType = object.getAttribute('type')?.toLowerCase() ?? '';
    const isLatexSvg = mediaType === 'image/svg+xml'
      && (className.includes(' latex-math ') || (/\/images\/math\//.test(dataUrl) && /\.svg(?:\?|$)/.test(dataUrl)));
    if (!isLatexSvg) continue;
    const formula = unwrapTexDelimiters(object.textContent ?? '');
    object.replaceWith(createFormulaElement(document, 'tex', className.includes(' align-center ') || formula.display, formula.source));
  }
  for (const script of Array.from(body.querySelectorAll('script'))) {
    const type = (script.getAttribute('type') ?? '').toLowerCase();
    if (!/^math\/tex(?:\s*;\s*mode=display)?$/.test(type)) continue;
    script.replaceWith(createFormulaElement(document, 'tex', /mode=display/.test(type), script.textContent ?? ''));
  }
  for (const math of Array.from(body.querySelectorAll('math'))) {
    sanitizeMathMl(math);
    math.replaceWith(createFormulaElement(document, 'mathml', math.getAttribute('display') === 'block', math.outerHTML));
  }
};

const looksLikeDollarMath = (value: string) => /[A-Za-z\\_^{}=+\-*/<>]/.test(value);
const texDelimiterPattern = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(^|[^\\$])\$([^\s$\n](?:[^$\n]*?[^\s$\n])?)\$/g;

const normalizeTextFormulas = (document: Document, body: Element) => {
  const visit = (node: Node, blocked: boolean) => {
    if (node.nodeType === 1) {
      const tag = (node as Element).tagName.toLowerCase();
      blocked = blocked || ['pre', 'code', 'kbd', 'samp', 'feedmind-math', 'svg'].includes(tag);
    }
    if (node.nodeType === 3 && !blocked && node.parentNode) {
      const value = node.textContent ?? '';
      const matches = Array.from(value.matchAll(texDelimiterPattern));
      if (!matches.length) return;
      let offset = 0;
      for (const match of matches) {
        const index = match.index ?? 0;
        const prefix = match[4] ?? '';
        const source = match[1] ?? match[2] ?? match[3] ?? match[5] ?? '';
        if (match[5] !== undefined && !looksLikeDollarMath(source)) continue;
        const beforeEnd = index + prefix.length;
        if (beforeEnd > offset) node.parentNode.insertBefore(document.createTextNode(value.slice(offset, beforeEnd)), node);
        node.parentNode.insertBefore(createFormulaElement(document, 'tex', Boolean(match[1] ?? match[2]), source), node);
        offset = index + match[0].length;
      }
      if (offset) {
        if (offset < value.length) node.parentNode.insertBefore(document.createTextNode(value.slice(offset)), node);
        node.parentNode.removeChild(node);
      }
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child, blocked);
  };
  visit(body, false);
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

const isHttpsUrl = (value: string) => {
  try { return new URL(value).protocol === 'https:'; } catch { return false; }
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

export const isSafeIframeUrl = (value: string) => isHttpsUrl(value) || isVideoEmbedUrl(value);

export const sanitizeArticleHtml = (value: string, baseUrl?: string) => {
  const html = hasHtmlTag(value) ? value : textToHtml(value);
  try {
    const { document } = parseHTML(`<body>${html}</body>`);
    const body = document.querySelector('body');
    if (!body) return '';
    normalizeFormulaElements(document as unknown as Document, body);
    normalizeTextFormulas(document as unknown as Document, body);
    for (const svg of Array.from(body.querySelectorAll('svg'))) sanitizeSvg(svg);
    for (const element of Array.from(body.querySelectorAll('*'))) {
      const tag = element.tagName.toLowerCase();
      if (element.closest('svg')) continue;
      if (['script', 'form', 'style', 'nav', 'header', 'footer', 'aside', 'math'].includes(tag)) { element.remove(); continue; }
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
        const resolvedSrc = src ? resolveArticleUrl(src, baseUrl) : '';
        if (!isHttpUrl(resolvedSrc)) { element.remove(); continue; }
        element.setAttribute('src', resolvedSrc);
      }
      if (tag === 'source') {
        const src = element.getAttribute('src') || element.getAttribute('data-src') || '';
        const resolvedSrc = resolveArticleUrl(src, baseUrl);
        if (!isHttpUrl(resolvedSrc) || !element.closest('audio, video')) { element.remove(); continue; }
        element.setAttribute('src', resolvedSrc);
      }
      if (tag === 'video' || tag === 'audio') {
        const src = element.getAttribute('src') || element.getAttribute('data-src') || '';
        const resolvedSrc = src ? resolveArticleUrl(src, baseUrl) : '';
        if (resolvedSrc && isHttpUrl(resolvedSrc)) element.setAttribute('src', resolvedSrc);
        else element.removeAttribute('src');
        if (!element.getAttribute('src') && !element.querySelector('source')) { element.remove(); continue; }
      }
      if (tag === 'video') {
        const poster = element.getAttribute('poster') || element.getAttribute('data-poster');
        if (poster) {
          const resolvedPoster = resolveArticleUrl(poster, baseUrl);
          if (isHttpUrl(resolvedPoster)) element.setAttribute('poster', resolvedPoster);
          else element.removeAttribute('poster');
        }
      }
      if (tag === 'iframe') {
        const src = resolveArticleUrl(element.getAttribute('src') || element.getAttribute('data-src') || '', baseUrl);
        if (!isSafeIframeUrl(src)) { element.remove(); continue; }
        element.setAttribute('src', src);
      }
      if (tag === 'feedmind-math') {
        const format = element.getAttribute('data-format');
        if (format !== 'tex' && format !== 'mathml') { element.remove(); continue; }
        if (format === 'mathml') {
          const parsed = parseHTML(`<body>${element.textContent ?? ''}</body>`).document.querySelector('math');
          if (!parsed) { element.remove(); continue; }
          sanitizeMathMl(parsed);
          element.textContent = parsed.outerHTML;
        }
        element.setAttribute('data-display', element.getAttribute('data-display') === 'block' ? 'block' : 'inline');
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
    for (const media of Array.from(body.querySelectorAll('video, audio'))) {
      if (!media.getAttribute('src') && !media.querySelector('source')) media.remove();
    }
    return body.innerHTML.trim();
  } catch { return textToHtml(stripHtml(html)); }
};

export const extractReadableArticleHtml = (html: string, baseUrl?: string) => {
  try {
    const { document } = parseHTML(html);
    const body = document.querySelector('body');
    if (body) {
      // Readability deliberately removes scripts. Preserve MathJax's inert
      // math/tex sources and delimiter-based formulas before extraction.
      normalizeFormulaElements(document as unknown as Document, body);
      normalizeTextFormulas(document as unknown as Document, body);
    }
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

export const hasArticleMedia = (html: string) => /<(?:img|video|audio|iframe|svg|feedmind-math)\b/i.test(html);
export const hasRenderableArticleContent = hasArticleMedia;

const renderHtmlDomNodeText = (node: any): string => {
  if (node?.nodeType === 3) return String(node.data ?? node.nodeValue ?? '');
  return Array.from(node?.childNodes ?? []).map(renderHtmlDomNodeText).join('');
};

/** Reads decoded text from react-native-render-html's domhandler-backed TNode. */
export const renderHtmlNodeText = (node: any): string => {
  if (node?.domNode) return renderHtmlDomNodeText(node.domNode);
  if (typeof node?.data === 'string') return node.data;
  return Array.isArray(node?.children) ? node.children.map(renderHtmlNodeText).join('') : '';
};

const formulaBlockSelector = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,figcaption';

/** Wraps formula-containing text blocks so native WebView can preserve true inline math layout. */
export const wrapFormulaBlocksForRendering = (html: string) => {
  try {
    const { document } = parseHTML(`<body>${html}</body>`);
    const body = document.querySelector('body');
    if (!body) return html;
    const targets = new Set<Element>();
    for (const formula of Array.from(body.querySelectorAll('feedmind-math'))) {
      targets.add(formula.closest(formulaBlockSelector) ?? formula);
    }
    for (const target of Array.from(targets)) {
      if (!target.parentNode || Array.from(targets).some((other) => other !== target && other.contains(target))) continue;
      const rich = document.createElement('feedmind-rich');
      rich.textContent = target.outerHTML;
      target.replaceWith(rich);
    }
    return body.innerHTML.trim();
  } catch { return html; }
};

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
  if (/^<(?:img|video|audio|iframe|svg|feedmind-math|pre|table)\b/i.test(html)) return [html];
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
  const pattern = /<(p|h[1-6]|li|blockquote|pre|table|video|audio|iframe|svg|feedmind-math)\b[^>]*>[\s\S]*?<\/\1>|<img\b[^>]*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    blocks.push(match[0].trim());
  }
  if (blocks.length) return blocks.flatMap(splitHtmlBlock);
  return content
    .split(/(<(?:img|video|audio|iframe|svg|feedmind-math)\b[^>]*\/?>(?:<\/(?:video|audio|iframe|svg|feedmind-math)>)?)/gi)
    .flatMap((item) => {
      const part = item.trim();
      if (!part) return [];
      if (/^<(?:img|video|audio|iframe|svg|feedmind-math)\b/i.test(part)) return [part];
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
