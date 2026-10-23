/// <reference lib="dom" />
import { parseHTML } from "linkedom";

export const CONTENT_BLOCK_INDEX_VERSION = "content-block-index-v1";
export const BLOCK_ID_ATTRIBUTE = "data-feedmind-block-id";

export interface AnalyzedContentBlock {
  stableId: string;
  blockIndex: number;
  kind: string;
  position: number;
  normalizedLength: number;
  exactFingerprint: string;
}

const selector =
  "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,table,figcaption,img,video,audio,iframe,svg,feedmind-math";
const canonicalPunctuation = (value: string) =>
  value
    .replace(/[“”„‟]/gu, '"')
    .replace(/[‘’‚‛]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, "-")
    .replace(/[…]/gu, "...");

export const normalizeBlockText = (value: string) =>
  canonicalPunctuation(value.normalize("NFKC").toLocaleLowerCase())
    .replace(/\s+/gu, " ")
    .trim();

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function contentElements(body: Element): Element[] {
  return Array.from(body.querySelectorAll(selector)).filter(
    (element) =>
      !Array.from(element.querySelectorAll(selector)).some(
        (child) => child !== element
      )
  );
}

function fingerprintSource(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === "img")
    return `${tag}:${element.getAttribute("src") ?? ""}:${
      element.getAttribute("alt") ?? ""
    }`;
  if (["video", "audio", "iframe"].includes(tag))
    return `${tag}:${element.getAttribute("src") ?? ""}`;
  if (tag === "svg")
    return `${tag}:${element.getAttribute("viewBox") ?? ""}:${
      element.textContent ?? ""
    }`;
  return element.textContent ?? "";
}

export async function analyzeContentBlocks(
  html: string
): Promise<AnalyzedContentBlock[]> {
  const { document } = parseHTML(`<body>${html}</body>`);
  const body = document.querySelector("body");
  if (!body) return [];
  const elements = contentElements(body);
  return Promise.all(
    elements.map(async (element, blockIndex) => {
      const exact = normalizeBlockText(fingerprintSource(element));
      return {
        stableId: `n${blockIndex}`,
        blockIndex,
        kind: element.tagName.toLowerCase(),
        position: elements.length <= 1 ? 0 : blockIndex / (elements.length - 1),
        normalizedLength: Array.from(exact).length,
        exactFingerprint: await sha256(exact),
      };
    })
  );
}

/** Adds deterministic block IDs and optionally hides blocks removed by a newer source version. */
export function annotateAndHideContentBlocks(
  html: string,
  hiddenStableIds: Iterable<string> = []
): string {
  const hidden = new Set(hiddenStableIds);
  const { document } = parseHTML(`<body>${html}</body>`);
  const body = document.querySelector("body");
  if (!body) return html;
  contentElements(body).forEach((element, index) => {
    const stableId = element.getAttribute(BLOCK_ID_ATTRIBUTE) || `n${index}`;
    element.setAttribute(BLOCK_ID_ATTRIBUTE, stableId);
    if (hidden.has(stableId)) element.remove();
  });
  return body.innerHTML.trim();
}

export function contentHtmlToText(html: string): string {
  const { document } = parseHTML(`<body>${html}</body>`);
  const body = document.querySelector("body");
  if (!body) return "";
  for (const element of Array.from(body.querySelectorAll("br")))
    element.replaceWith(document.createTextNode("\n"));
  for (const element of Array.from(
    body.querySelectorAll(
      "p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr,div,section,article"
    )
  )) {
    element.append(document.createTextNode("\n\n"));
  }
  return (body.textContent ?? "")
    .replace(/[ \t\f\v\r]+/gu, " ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export interface AlignableContentBlock {
  stableId: string;
  kind: string;
  exactFingerprint: string;
  normalizedLength: number;
}

export interface ContentBlockAlignment {
  mapping: Array<{ fromStableId: string; toStableId: string }>;
  currentCoverage: number;
  ambiguous: boolean;
}

export function alignContentBlocks(
  from: AlignableContentBlock[],
  to: AlignableContentBlock[]
): ContentBlockAlignment {
  if (!to.length || from.length > 2500 || to.length > 2500)
    return { mapping: [], currentCoverage: 0, ambiguous: true };
  const key = (block: AlignableContentBlock) =>
    `${block.kind}\u0000${block.exactFingerprint}`;
  const left = from.map(key);
  const right = to.map(key);
  const columns = right.length + 1;
  const table = new Uint16Array((left.length + 1) * columns);
  for (let row = 1; row <= left.length; row++)
    for (let column = 1; column <= right.length; column++) {
      const offset = row * columns + column;
      table[offset] =
        left[row - 1] === right[column - 1]
          ? table[(row - 1) * columns + column - 1] + 1
          : Math.max(
              table[(row - 1) * columns + column],
              table[row * columns + column - 1]
            );
    }
  const pairs: Array<{ fromIndex: number; toIndex: number }> = [];
  let row = left.length;
  let column = right.length;
  while (row > 0 && column > 0) {
    if (left[row - 1] === right[column - 1]) {
      pairs.push({ fromIndex: row - 1, toIndex: column - 1 });
      row--;
      column--;
    } else if (
      table[(row - 1) * columns + column] >= table[row * columns + column - 1]
    )
      row--;
    else column--;
  }
  pairs.reverse();
  const counts = (items: string[]) =>
    items.reduce(
      (map, item) => map.set(item, (map.get(item) ?? 0) + 1),
      new Map<string, number>()
    );
  const leftCounts = counts(left);
  const rightCounts = counts(right);
  const ambiguous = pairs.some(({ fromIndex, toIndex }) => {
    const leftCount = leftCounts.get(left[fromIndex]) ?? 0;
    const rightCount = rightCounts.get(right[toIndex]) ?? 0;
    return (leftCount > 1 || rightCount > 1) && leftCount !== rightCount;
  });
  const totalWeight = to.reduce(
    (sum, block) => sum + Math.max(1, block.normalizedLength),
    0
  );
  const matchedWeight = pairs.reduce(
    (sum, pair) => sum + Math.max(1, to[pair.toIndex].normalizedLength),
    0
  );
  return {
    mapping: pairs.map((pair) => ({
      fromStableId: from[pair.fromIndex].stableId,
      toStableId: to[pair.toIndex].stableId,
    })),
    currentCoverage: totalWeight ? matchedWeight / totalWeight : 0,
    ambiguous,
  };
}
