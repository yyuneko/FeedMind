const allowedTags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'img', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'br']);

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
    .replace(/\s(?:bgcolor|color)=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\sstyle=(["'])([\s\S]*?)\1/gi, (_match, quote: string, style: string) => {
      const next = style
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item && !/^(?:color|background|background-color)\s*:/i.test(item))
        .join('; ');
      return next ? ` style=${quote}${next}${quote}` : '';
    });

export const sanitizeArticleHtml = (value: string) => {
  const html = hasHtmlTag(value) ? value : textToHtml(value);
  return removeInlineColors(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|iframe|form|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(script|iframe|form|style)\b[^>]*\/?>/gi, '')
    .replace(/<\/?([a-z][\w:-]*)\b[^>]*>/gi, (match, tag: string) => {
      const normalized = tag.toLowerCase();
      if (allowedTags.has(normalized)) return match;
      return '';
    })
    .trim();
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

export const splitParagraphs = (content: string) =>
  content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

export const getArticleSummary = (html: string) => stripHtml(html);
