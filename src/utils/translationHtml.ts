import { parseHTML } from "linkedom";
import type { StoredTranslationV2 } from "../types";
import { sanitizeArticleHtml } from "./html";

export type TranslationBlock = { id: string; markup: string };
export type TranslationPlan = {
  sourceHtml: string;
  sourceHash: string;
  blocks: TranslationBlock[];
};
export type TranslationBlockResult = [id: string, translatedMarkup: string];
export type TranslationMarkupErrorCode =
  | 'inline_marker_missing'
  | 'inline_marker_duplicate'
  | 'inline_marker_unknown'
  | 'protected_marker_missing'
  | 'protected_marker_duplicate'
  | 'protected_marker_unknown'
  | 'marker_cross_nested'
  | 'marker_unclosed';
export type TranslationMarkupDiagnostic = {
  code: TranslationMarkupErrorCode;
  blockId?: string;
  token?: string;
  expectedCount?: number;
  actualCount?: number;
  expectedTokens: string[];
  actualTokens: string[];
  sourcePreview: string;
  translatedPreview: string;
};
type Inline = {
  token: string;
  tag: string;
  attributes: Record<string, string>;
};
type Protected = { token: string; html: string; element: Element };
type Snapshot = {
  element: Element;
  markup: string;
  inline: Inline[];
  protected: Protected[];
};
const blocks = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "th",
  "td",
  "figcaption",
]);
const inlines = new Set([
  'sup',
  "strong",
  "b",
  "em",
  "i",
  "u",
  "mark",
  "del",
  "s",
  "a",
]);
const protectedTags = new Set(["code", "kbd", "samp", "feedmind-math"]);
const ignoredTags = new Set(["img", "video", "audio", "iframe", "hr", "pre", "script", "style", "svg"]);
const separator = /^\s*(?:[_\-=*·•]{3,}|[—–]{2,})\s*$/u;
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const translationMarkerPattern = /<\/?x\d+>|⟦p\d+⟧/g;
const diagnosticPreview = (value: string, max = 300) => {
  const normalized = value
    .split(String.fromCharCode(13)).join('')
    .split(String.fromCharCode(9)).join(' ')
    .trim();
  return normalized.length > max ? normalized.slice(0, max) + '…' : normalized;
};
const markerKind = (token: string) =>
  token.startsWith('⟦') ? '受保护内容' : '译文标记';
const blockPrefix = (blockId?: string) =>
  blockId ? '译文块 ' + blockId : '译文';
const diagnosticMessage = (diagnostic: TranslationMarkupDiagnostic) => {
  const prefix = blockPrefix(diagnostic.blockId);
  const token = diagnostic.token ?? '标记';
  const counts =
    diagnostic.expectedCount === undefined || diagnostic.actualCount === undefined
      ? ''
      : '（期望 ' + diagnostic.expectedCount + ' 次，实际 ' + diagnostic.actualCount + ' 次）';
  switch (diagnostic.code) {
    case 'inline_marker_missing':
    case 'protected_marker_missing':
      return prefix + '缺少' + markerKind(token) + ' ' + token + counts + '。';
    case 'inline_marker_duplicate':
    case 'protected_marker_duplicate':
      return prefix + '重复了' + markerKind(token) + ' ' + token + counts + '。';
    case 'inline_marker_unknown':
    case 'protected_marker_unknown':
      return prefix + '增加了未知' + markerKind(token) + ' ' + token + counts + '。';
    case 'marker_cross_nested':
      return prefix + '的译文标记 ' + token + ' 交叉嵌套。';
    case 'marker_unclosed':
      return prefix + '的译文标记 ' + token + ' 未闭合。';
  }
};
export class TranslationMarkupError extends Error {
  readonly diagnostic: TranslationMarkupDiagnostic;

  constructor(diagnostic: TranslationMarkupDiagnostic) {
    super(diagnosticMessage(diagnostic));
    this.name = 'TranslationMarkupError';
    this.diagnostic = diagnostic;
  }
}
const compactMarkupError = (error: TranslationMarkupError) => {
  const diagnostic = error.diagnostic;
  const block = diagnostic.blockId ?? '?';
  const token = diagnostic.token ? '【' + diagnostic.token + '】' : '标记';
  switch (diagnostic.code) {
    case 'inline_marker_missing':
    case 'protected_marker_missing':
      return block + ' 缺少 ' + token;
    case 'inline_marker_duplicate':
    case 'protected_marker_duplicate':
      return block + ' 重复 ' + token;
    case 'inline_marker_unknown':
    case 'protected_marker_unknown':
      return block + ' 增加未知标记 ' + token;
    case 'marker_cross_nested':
      return block + ' 标记 ' + token + ' 交叉嵌套';
    case 'marker_unclosed':
      return block + ' 标记 ' + token + ' 未闭合';
  }
};
export class TranslationBatchValidationError extends Error {
  readonly batchNumber: number;
  readonly errors: TranslationMarkupError[];

  constructor(batchNumber: number, errors: TranslationMarkupError[]) {
    const details = errors.slice(0, 5).map(compactMarkupError).join('；');
    const remainder = errors.length > 5 ? '；另有 ' + (errors.length - 5) + ' 个失败块' : '';
    super('批次 ' + batchNumber + ' 翻译校验失败：' + details + remainder + '。');
    this.name = 'TranslationBatchValidationError';
    this.batchNumber = batchNumber;
    this.errors = errors;
  }
}
export const hashText = (value: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};
const bodyOf = (html: string) => {
  const { document } = parseHTML(`<body>${html}</body>`);
  const body = document.querySelector("body");
  if (!body) throw new Error("无法解析文章 HTML。");
  return body;
};
const encode = (element: Element): Snapshot => {
  const inline: Inline[] = [];
  const protectedContent: Protected[] = [];
  const walk = (node: Node): string => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "")
        .replace(/[\t\f\v\r ]+/g, " ")
        .replace(/ *\n+ */g, "\n");
      return text.trim() ? text : "";
    }
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return "\n";
    if (ignoredTags.has(tag)) return "";
    if (protectedTags.has(tag)) {
      if (!(el.textContent ?? "").trim()) return "";
      const token = `⟦p${protectedContent.length}⟧`;
      protectedContent.push({ token, html: el.outerHTML, element: el });
      return token;
    }
    if (!inlines.has(tag)) return Array.from(el.childNodes).map(walk).join("");
    const content = Array.from(el.childNodes).map(walk).join("");
    if (!content.trim()) return "";
    const token = `x${inline.length}`;
    const attributes: Record<string, string> = {};
    if (tag === "a")
      for (const name of ["href", "title"]) {
        const value = el.getAttribute(name);
        if (value !== null) attributes[name] = value;
      }
    inline.push({ token, tag, attributes });
    return `<${token}>${content}</${token}>`;
  };
  return {
    element,
    markup: Array.from(element.childNodes).map(walk).join(""),
    inline,
    protected: protectedContent,
  };
};
const snapshots = (body: Element) =>
  Array.from(body.querySelectorAll("*"))
    .filter(
      (el) =>
        blocks.has(el.tagName.toLowerCase()) &&
        !Array.from(el.querySelectorAll("*")).some((child) =>
          blocks.has(child.tagName.toLowerCase())
        )
    )
    .map(encode);
const dateOnly =
  /^(?:\d{1,4}(?:[-/.年]\d{1,2}){1,2}(?:日)?|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})$/iu;
const needed = (markup: string) => {
  const plain = markup
    .replace(/<\/?x\d+>/g, "")
    .replace(/⟦p\d+⟧/g, "")
    .trim();
  return (
    /[\p{L}\p{N}]/u.test(plain) &&
    !separator.test(plain) &&
    !dateOnly.test(plain)
  );
};
const wrapLegacyText = (root: Element) => {
  const visit = (container: Element) => {
    for (const child of Array.from(container.children)) {
      const tag = child.tagName.toLowerCase();
      if (ignoredTags.has(tag)) continue;
      if (
        !blocks.has(tag) &&
        !inlines.has(tag) &&
        !protectedTags.has(tag) &&
        tag !== "br"
      )
        visit(child);
    }
    if (blocks.has(container.tagName.toLowerCase())) return;
    let run: Node[] = [];
    let breakCount = 0;
    const flush = () => {
      while (
        run.length &&
        run[run.length - 1].nodeType === 1 &&
        (run[run.length - 1] as Element).tagName.toLowerCase() === "br"
      )
        run.pop();
      const text = run
        .map((node) => node.textContent ?? "")
        .join("")
        .trim();
      if (text && !separator.test(text)) {
        const p = container.ownerDocument.createElement("p");
        container.insertBefore(p, run[0]);
        run.forEach((node) => p.appendChild(node));
      }
      run = [];
      breakCount = 0;
    };
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === 8) {
        node.parentNode?.removeChild(node);
        continue;
      }
      if (node.nodeType === 1) {
        const tag = (node as Element).tagName.toLowerCase();
        if (
          blocks.has(tag) ||
          (!inlines.has(tag) && !protectedTags.has(tag) && tag !== "br")
        ) {
          flush();
          continue;
        }
        if (tag === "br") {
          breakCount += 1;
          if (breakCount >= 2) {
            flush();
            node.parentNode?.removeChild(node);
          } else run.push(node);
          continue;
        }
      }
      breakCount = 0;
      run.push(node);
    }
    flush();
  };
  visit(root);
};
export const validateTranslationBlocks = (items: TranslationBlock[]) => {
  for (const block of items) {
    const protectedCount = block.markup.match(/⟦p\d+⟧/g)?.length ?? 0;
    const inlineCount = block.markup.match(/<x\d+>/g)?.length ?? 0;
    const plain = block.markup
      .replace(/<\/?x\d+>/g, "")
      .replace(/⟦p\d+⟧/g, "")
      .trim();
    let reason = "";
    if (!plain) reason = "is empty";
    else if (protectedCount > 12) reason = "contains too many protected tokens";
    else if (inlineCount > 12) reason = "contains too many inline markers";
    else if (block.markup.length > 12000) reason = "is unexpectedly large";
    else if (dateOnly.test(plain)) reason = "contains only a date";
    else if (separator.test(plain)) reason = "contains only a separator";
    else if ((plain.match(/(?:_{3,}|-{3,}|={3,})/g)?.length ?? 0) > 1)
      reason = "contains multiple separators";
    else if (/<(x\d+)>[\s\S]*\n\s*\n[\s\S]*<\/\1>/.test(block.markup))
      reason = "has an inline marker spanning paragraphs";
    if (reason) {
      if (typeof __DEV__ !== "undefined" && __DEV__)
        console.warn(
          `Rejected translation block ${block.id}: ${block.markup.slice(
            0,
            300
          )}`
        );
      throw new Error(`Translation block ${block.id} ${reason}`);
    }
  }
};

export const validateTranslatedMarkup = (
  source: string,
  translated: string,
  blockId?: string
) => {
  const expected = source.match(translationMarkerPattern) ?? [];
  const actual = translated.match(translationMarkerPattern) ?? [];
  const counts = (tokens: string[]) => {
    const result = new Map<string, number>();
    for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
    return result;
  };
  const expectedCounts = counts(expected);
  const actualCounts = counts(actual);
  const fail = (
    code: TranslationMarkupErrorCode,
    details: {
      token?: string;
      expectedCount?: number;
      actualCount?: number;
    } = {}
  ): never => {
    throw new TranslationMarkupError({
      code,
      blockId,
      expectedTokens: expected,
      actualTokens: actual,
      sourcePreview: diagnosticPreview(source),
      translatedPreview: diagnosticPreview(translated),
      ...details,
    });
  };
  for (const [token, actualCount] of actualCounts) {
    if (expectedCounts.has(token)) continue;
    fail(
      token.startsWith('⟦')
        ? 'protected_marker_unknown'
        : 'inline_marker_unknown',
      { token, expectedCount: 0, actualCount }
    );
  }
  for (const [token, expectedCount] of expectedCounts) {
    const actualCount = actualCounts.get(token) ?? 0;
    if (actualCount === expectedCount) continue;
    const protectedToken = token.startsWith('⟦');
    if (actualCount < expectedCount) {
      const name = token.match(/x\d+/)?.[0];
      if (token.startsWith('</') && name && actualCounts.get('<' + name + '>'))
        fail('marker_unclosed', { token, expectedCount, actualCount });
      fail(
        protectedToken ? 'protected_marker_missing' : 'inline_marker_missing',
        { token, expectedCount, actualCount }
      );
    }
    fail(
      protectedToken ? 'protected_marker_duplicate' : 'inline_marker_duplicate',
      { token, expectedCount, actualCount }
    );
  }
  const stack: string[] = [];
  for (const token of actual) {
    const name = token.match(/x\d+/)?.[0];
    if (!name) continue;
    if (token.startsWith('</')) {
      if (stack.pop() !== name) fail('marker_cross_nested', { token });
    } else stack.push(name);
  }
  if (stack.length)
    fail('marker_unclosed', { token: stack[stack.length - 1] });
};
export const createTranslationPlan = (html: string): TranslationPlan => {
  const body = bodyOf(sanitizeArticleHtml(html));
  wrapLegacyText(body);
  const list = snapshots(body).filter((x) => needed(x.markup));
  const result = list.map((x, i) => {
    const id = `b${i}`;
    x.element.setAttribute("data-translation-id", id);
    return { id, markup: x.markup };
  });
  validateTranslationBlocks(result);
  const sourceHtml = body.innerHTML;
  return { sourceHtml, sourceHash: hashText(sourceHtml), blocks: result };
};
const restore = (source: Snapshot, value: string, blockId?: string) => {
  validateTranslatedMarkup(source.markup, value, blockId);
  const pattern = translationMarkerPattern;
  const im = new Map(source.inline.map((x) => [x.token, x]));
  const pm = new Map(
    source.protected.map((x) => [x.token, x.element.outerHTML || x.html])
  );
  let out = "";
  let cursor = 0;
  const escapeText = (text: string) => escapeHtml(text).replace(/\n/g, "<br>");
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    out += escapeText(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith("⟦")) out += pm.get(token) ?? "";
    else {
      const close = token.startsWith("</");
      const name = token.match(/x\d+/)?.[0] ?? "";
      const item = im.get(name)!;
      const attrs = Object.entries(item.attributes)
        .map(([k, v]) => ` ${k}="${escapeHtml(v)}"`)
        .join("");
      out += close ? `</${item.tag}>` : `<${item.tag}${attrs}>`;
    }
    cursor = index + token.length;
  }
  return out + escapeText(value.slice(cursor));
};
export const applyTranslationPlan = (
  plan: TranslationPlan,
  results: TranslationBlockResult[]
) => {
  if (hashText(plan.sourceHtml) !== plan.sourceHash)
    throw new Error("文章正文哈希不匹配。");
  if (results.length !== plan.blocks.length)
    throw new Error("译文块数量不一致。");
  const seen = new Set<string>();
  const body = bodyOf(plan.sourceHtml);
  for (const [id, value] of results) {
    if (seen.has(id)) throw new Error(`译文块 ID 重复：${id}。`);
    seen.add(id);
    if (!plan.blocks.some((x) => x.id === id))
      throw new Error(`未知译文块 ID：${id}。`);
    const element = body.querySelector(`[data-translation-id=${id}]`);
    if (!element) throw new Error(`找不到译文块：${id}。`);
    element.innerHTML = restore(encode(element), value, id);
    element.removeAttribute("data-translation-id");
  }
  if (body.querySelector("[data-translation-id]"))
    throw new Error("存在未应用的译文块。");
  return sanitizeArticleHtml(body.innerHTML);
};
export const applyPartialTranslationPlan = (plan: TranslationPlan, results: TranslationBlockResult[]) => {
  if (hashText(plan.sourceHtml) !== plan.sourceHash) throw new Error('文章正文哈希不匹配。');
  const seen = new Set<string>();
  const body = bodyOf(plan.sourceHtml);
  for (const [id, value] of results) {
    if (seen.has(id)) throw new Error(`译文块 ID 重复：${id}。`);
    seen.add(id);
    if (!plan.blocks.some((block) => block.id === id)) throw new Error(`未知译文块 ID：${id}。`);
    const element = body.querySelector(`[data-translation-id=${id}]`);
    if (!element) throw new Error(`找不到译文块：${id}。`);
    element.innerHTML = restore(encode(element), value, id);
    element.removeAttribute('data-translation-id');
  }
  body.querySelectorAll('[data-translation-id]').forEach((element) => {
    element.innerHTML = '';
    element.removeAttribute('data-translation-id');
  });
  return sanitizeArticleHtml(body.innerHTML);
};
export const splitTopLevelHtml = (html: string) =>
  Array.from(bodyOf(sanitizeArticleHtml(html)).childNodes).flatMap((node) =>
    node.nodeType === 1
      ? [(node as Element).outerHTML]
      : node.textContent?.trim()
      ? [`<p>${escapeHtml(node.textContent.trim())}</p>`]
      : []
  );
export const removeImagesFromHtml = (html: string) => {
  const body = bodyOf(sanitizeArticleHtml(html));
  body.querySelectorAll("img, video, audio, iframe").forEach((x) => x.remove());
  return body.innerHTML;
};
export const parseStoredTranslation = (
  content: string
): StoredTranslationV2 | null => {
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object") return null;
    const x = value as Record<string, unknown>;
    if (
      x.v !== 2 ||
      typeof x.title !== "string" ||
      typeof x.sourceHash !== "string" ||
      typeof x.promptHash !== "string" ||
      !Array.isArray(x.blocks) ||
      !x.blocks.every(
        (b) =>
          Array.isArray(b) &&
          b.length === 2 &&
          typeof b[0] === "string" &&
          typeof b[1] === "string"
      )
    )
      return null;
    return x as StoredTranslationV2;
  } catch {
    return null;
  }
};
export const isStoredTranslationValid = (
  x: StoredTranslationV2,
  input: { sourceHash: string; promptHash: string }
) =>
  x.v === 2 &&
  x.sourceHash === input.sourceHash &&
  x.promptHash === input.promptHash;
export const estimateTokens = (value: string) => {
  let count = 0;
  for (const char of value)
    count += /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(char) ? 1 : 0.25;
  return Math.ceil(count);
};
export const createTranslationBatches = (
  items: TranslationBlock[],
  max = 6000
) => {
  validateTranslationBlocks(items);
  const result: TranslationBlock[][] = [];
  let batch: TranslationBlock[] = [];
  let count = 0;
  for (const item of items) {
    const size = estimateTokens(JSON.stringify([item.id, item.markup]));
    if (batch.length && count + size > max) {
      result.push(batch);
      batch = [];
      count = 0;
    }
    batch.push(item);
    count += size;
  }
  if (batch.length) result.push(batch);
  return result;
};
