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

export const validateTranslatedMarkup = (source: string, translated: string) => {
  const pattern = /<\/?x\d+>|⟦p\d+⟧/g;
  const expected = source.match(pattern) ?? [];
  const actual = translated.match(pattern) ?? [];
  const counts = (tokens: string[]) => {
    const result = new Map<string, number>();
    for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
    return result;
  };
  const expectedCounts = counts(expected);
  const actualCounts = counts(actual);
  for (const [token, count] of expectedCounts) {
    if (actualCounts.get(token) !== count) {
      const name = token.match(/x\d+/)?.[0] ?? token;
      throw new Error(`译文标记 ${name} 缺失或重复。`);
    }
    actualCounts.delete(token);
  }
  if (actualCounts.size) throw new Error('译文增加了未知标记。');
  const plain = translated.replace(pattern, '');
  if (/[<>]/.test(plain)) throw new Error('译文包含不允许的 HTML 标签。');
  const stack: string[] = [];
  for (const token of actual) {
    const name = token.match(/x\d+/)?.[0];
    if (!name) continue;
    if (token.startsWith('</')) {
      if (stack.pop() !== name) throw new Error(`译文标记 ${name} 交叉嵌套。`);
    } else stack.push(name);
  }
  if (stack.length) throw new Error('译文存在未闭合标记。');
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
const restore = (source: Snapshot, value: string) => {
  const pattern = /<\/?x\d+>|⟦p\d+⟧/g;
  const plain = value.replace(pattern, "");
  if (/[<>]/.test(plain)) throw new Error("译文包含不允许的 HTML 标签。");
  const stack: string[] = [];
  const counts = new Map<string, [number, number]>();
  const pc = new Map<string, number>();
  for (const token of value.match(pattern) ?? []) {
    if (token.startsWith("⟦")) {
      pc.set(token, (pc.get(token) ?? 0) + 1);
      continue;
    }
    const close = token.startsWith("</");
    const name = token.match(/x\d+/)?.[0] ?? "";
    const count = counts.get(name) ?? [0, 0];
    if (close) {
      count[1] += 1;
      if (stack.pop() !== name) throw new Error(`译文标记 ${name} 交叉嵌套。`);
    } else {
      count[0] += 1;
      stack.push(name);
    }
    counts.set(name, count);
  }
  if (stack.length) throw new Error("译文存在未闭合标记。");
  for (const item of source.inline) {
    const count = counts.get(item.token);
    if (count?.[0] !== 1 || count[1] !== 1)
      throw new Error(`译文标记 ${item.token} 缺失或重复。`);
    counts.delete(item.token);
  }
  if (counts.size) throw new Error("译文增加了未知标记。");
  for (const item of source.protected) {
    if (pc.get(item.token) !== 1)
      throw new Error(`受保护内容 ${item.token} 缺失或重复。`);
    pc.delete(item.token);
  }
  if (pc.size) throw new Error("译文增加了未知受保护内容。");
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
    element.innerHTML = restore(encode(element), value);
    element.removeAttribute("data-translation-id");
  }
  if (body.querySelector("[data-translation-id]"))
    throw new Error("存在未应用的译文块。");
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
