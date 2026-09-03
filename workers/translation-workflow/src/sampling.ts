export interface SamplingConfig {
  algorithmVersion: string;
  bodyTokenBudget: number;
  headRatio: number;
  middleRatio: number;
  tailRatio: number;
  middleWindows: number;
}

export interface SampleFragment {
  index: number;
  position: "head" | "middle" | "tail" | "full";
  paragraphStart: number;
  paragraphEnd: number;
  text: string;
}

export interface SamplingResult {
  fragments: SampleFragment[];
  estimatedTokens: number;
  manifestHash: string;
}

export function estimateTokens(value: string): number {
  let count = 0;
  for (const character of value) {
    count += /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(character) ? 1 : 0.25;
  }
  return Math.ceil(count);
}

function paragraphs(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
}

function takeForward(items: string[], start: number, budget: number, used: Set<number>): number[] {
  const indexes: number[] = [];
  let tokens = 0;
  for (let index = Math.max(0, start); index < items.length; index++) {
    if (used.has(index)) {
      if (indexes.length) break;
      continue;
    }
    const size = estimateTokens(items[index]);
    if (indexes.length && tokens + size > budget) break;
    indexes.push(index); used.add(index); tokens += size;
    if (tokens >= budget) break;
  }
  return indexes;
}

function takeBackward(items: string[], budget: number, used: Set<number>): number[] {
  const indexes: number[] = [];
  let tokens = 0;
  for (let index = items.length - 1; index >= 0; index--) {
    if (used.has(index)) {
      if (indexes.length) break;
      continue;
    }
    const size = estimateTokens(items[index]);
    if (indexes.length && tokens + size > budget) break;
    indexes.unshift(index); used.add(index); tokens += size;
    if (tokens >= budget) break;
  }
  return indexes;
}

async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sampleArticleText(value: string, config: SamplingConfig): Promise<SamplingResult> {
  const items = paragraphs(value);
  const total = estimateTokens(items.join("\n\n"));
  let fragments: SampleFragment[];
  if (total <= config.bodyTokenBudget) {
    fragments = items.length ? [{ index: 1, position: "full", paragraphStart: 0, paragraphEnd: items.length - 1, text: items.join("\n\n") }] : [];
  } else {
    const used = new Set<number>();
    const head = takeForward(items, 0, Math.floor(config.bodyTokenBudget * config.headRatio), used);
    const tail = takeBackward(items, Math.floor(config.bodyTokenBudget * config.tailRatio), used);
    const middleBudget = Math.floor(config.bodyTokenBudget * config.middleRatio / config.middleWindows);
    const middle: number[][] = [];
    for (let window = 1; window <= config.middleWindows; window++) {
      const center = Math.floor(window * (items.length - 1) / (config.middleWindows + 1));
      middle.push(takeForward(items, center, middleBudget, used));
    }
    const groups: Array<{ position: SampleFragment["position"]; indexes: number[] }> = [
      { position: "head", indexes: head },
      ...middle.map((indexes) => ({ position: "middle" as const, indexes })),
      { position: "tail", indexes: tail },
    ];
    fragments = groups.filter((group) => group.indexes.length).map((group, index) => ({
      index: index + 1,
      position: group.position,
      paragraphStart: group.indexes[0],
      paragraphEnd: group.indexes[group.indexes.length - 1],
      text: group.indexes.map((item) => items[item]).join("\n\n"),
    }));
  }
  const manifest = {
    algorithmVersion: config.algorithmVersion,
    sourceParagraphs: items.length,
    ranges: fragments.map(({ index, position, paragraphStart, paragraphEnd }) => ({ index, position, paragraphStart, paragraphEnd })),
  };
  return {
    fragments,
    estimatedTokens: estimateTokens(fragments.map((item) => item.text).join("\n\n")),
    manifestHash: await hash(JSON.stringify(manifest)),
  };
}

export function formatSample(fragments: SampleFragment[]): string {
  return fragments.map((fragment) =>
    `[片段 ${fragment.index}；位置=${fragment.position}；段落=${fragment.paragraphStart}-${fragment.paragraphEnd}]\n${fragment.text}`,
  ).join("\n\n---\n\n");
}
