import {
  TranslationBatchValidationError,
  TranslationMarkupError,
  validateTranslatedMarkup,
  type TranslationBlock,
  type TranslationBlockResult,
} from "../../../src/utils/translationHtml";

const translationMarkerPattern = /<\/?x\d+>|⟦p\d+⟧/g;

type StructuredPart = { text: string; protected: string; inline: string[] };
type StructuredBlock = { parts: StructuredPart[]; inlineIds: string[]; protectedIds: string[] };

function structureBlockMarkup(markup: string): StructuredBlock {
  const parts: StructuredPart[] = [];
  const inlineIds: string[] = [];
  const protectedIds: string[] = [];
  const stack: string[] = [];
  let cursor = 0;
  for (const match of markup.matchAll(translationMarkerPattern)) {
    const index = match.index ?? 0;
    const text = markup.slice(cursor, index);
    if (text) parts.push({ text, protected: "", inline: [...stack] });
    const token = match[0];
    if (token.startsWith("⟦")) {
      const id = token.slice(1, -1);
      if (!protectedIds.includes(id)) protectedIds.push(id);
      parts.push({ text: "", protected: id, inline: [...stack] });
    } else {
      const id = token.match(/x\d+/)?.[0];
      if (!id) throw new Error("Translation marker is invalid");
      if (token.startsWith("</")) {
        if (stack.pop() !== id) throw new Error("Translation source markers are cross-nested");
      } else {
        if (!inlineIds.includes(id)) inlineIds.push(id);
        stack.push(id);
      }
    }
    cursor = index + match[0].length;
  }
  const trailing = markup.slice(cursor);
  if (trailing) parts.push({ text: trailing, protected: "", inline: [...stack] });
  if (stack.length) throw new Error("Translation source marker is unclosed");
  return { parts, inlineIds, protectedIds };
}

function inlineSpans(structured: StructuredBlock): Record<string, string> {
  return Object.fromEntries(structured.inlineIds.map((id) => [
    id,
    structured.parts.filter((part) => part.inline.includes(id)).map((part) => part.text).join(""),
  ]));
}

function reconstructMarkup(parts: StructuredPart[]): string {
  let result = "";
  let previous: string[] = [];
  for (const part of parts) {
    let common = 0;
    while (common < previous.length && common < part.inline.length && previous[common] === part.inline[common]) common += 1;
    for (let index = previous.length - 1; index >= common; index--) result += `</${previous[index]}>`;
    for (let index = common; index < part.inline.length; index++) result += `<${part.inline[index]}>`;
    result += part.protected ? `⟦${part.protected}⟧` : part.text;
    previous = part.inline;
  }
  for (let index = previous.length - 1; index >= 0; index--) result += `</${previous[index]}>`;
  return result;
}

/** Builds a strict schema that permits natural target-language reordering without accepting model-authored HTML. */
export function buildTranslationBatchJsonSchema(expected: TranslationBlock[]): Record<string, unknown> {
  const blockProperties: Record<string, unknown> = {};
  for (const block of expected) {
    const { inlineIds, protectedIds } = structureBlockMarkup(block.markup);
    blockProperties[block.id] = {
      type: "object",
      additionalProperties: false,
      properties: {
        parts: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              protected: { type: "string", enum: ["", ...protectedIds] },
              inline: {
                type: "array",
                items: { type: "string", enum: inlineIds.length ? inlineIds : ["__none__"] },
              },
            },
            required: ["text", "protected", "inline"],
          },
        },
      },
      required: ["parts"],
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      blocks: {
        type: "object",
        additionalProperties: false,
        properties: blockProperties,
        required: expected.map((block) => block.id),
      },
    },
    required: ["blocks"],
  };
}

export const STRUCTURED_TRANSLATION_INSTRUCTIONS = `
输出格式由本批正文结构动态生成，并且优先于上方提示词中关于 JSON 格式的旧说明。
输入 blocks 中的每个 block 都提供 sourceParts、inlineSpans 和 protectedTokens。输出自然、完整的目标语言译文 parts：
- text 是普通译文；protected 只能是空字符串或原样引用的受保护内容 ID；inline 是应用到该 part 的内联语义 ID，外层在前。
- inlineSpans 明确每个链接或样式在原文中对应的语义。该 ID 必须跟随这段语义的译文，绝不能仅停留在原文词序位置。
- 为适应不同语言语序，可以重排、拆分或合并普通文本 part；例如英文后置修饰语翻成中文前置修饰语时，应移动带 inline ID 的译文 part。
- 每个 inline ID 必须恰好形成一个连续区域，每个 protected ID 必须恰好出现一次。不得在 text 中输出 HTML 或任何标记。
必须返回 Schema 要求的全部 block 和字段，不得增加字段或说明。`;

export function buildTranslationBatchRequest(expected: TranslationBlock[]): string {
  return JSON.stringify({
    blocks: Object.fromEntries(expected.map((block) => {
      const structured = structureBlockMarkup(block.markup);
      return [block.id, {
        sourceParts: structured.parts,
        inlineSpans: inlineSpans(structured),
        protectedTokens: structured.protectedIds,
      }];
    })),
  });
}

export function parseTranslationBatchJson(
  raw: string,
  expected: TranslationBlock[],
): TranslationBlockResult[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Translation response is not valid JSON");
  }
  const blocks = value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).blocks
    : undefined;
  if (!blocks || typeof blocks !== "object" || Array.isArray(blocks)) {
    throw new Error("Translation blocks shape is invalid");
  }
  const blockRecord = blocks as Record<string, unknown>;
  const expectedIds = expected.map((block) => block.id);
  if (Object.keys(blockRecord).length !== expectedIds.length ||
      Object.keys(blockRecord).some((id) => !expectedIds.includes(id))) {
    throw new Error("Translation block count or ID is invalid");
  }
  return expected.map((block) => {
    const output = blockRecord[block.id];
    if (!output || typeof output !== "object" || Array.isArray(output)) {
      throw new Error(`Translation block ${block.id} shape is invalid`);
    }
    const outputBlock = output as Record<string, unknown>;
    if (Object.keys(outputBlock).length !== 1 || !Array.isArray(outputBlock.parts) || !outputBlock.parts.length) {
      throw new Error(`Translation block ${block.id} parts are invalid`);
    }
    if (outputBlock.parts.length > 64) {
      throw new Error(`Translation block ${block.id} has too many parts`);
    }
    const structured = structureBlockMarkup(block.markup);
    const parts = outputBlock.parts.map((part): StructuredPart | null => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw new Error(`Translation block ${block.id} part is invalid`);
      }
      const record = part as Record<string, unknown>;
      if (Object.keys(record).length !== 3 || typeof record.text !== "string" ||
          typeof record.protected !== "string" || !Array.isArray(record.inline) ||
          record.inline.some((id) => typeof id !== "string")) {
        throw new Error(`Translation block ${block.id} part is invalid`);
      }
      const inline = record.inline as string[];
      if (new Set(inline).size !== inline.length || inline.some((id) => !structured.inlineIds.includes(id)) ||
          !["", ...structured.protectedIds].includes(record.protected) ||
          (record.protected ? record.text !== "" : record.text === "" && inline.length > 0)) {
        throw new Error(`Translation block ${block.id} part references are invalid`);
      }
      if (!record.protected && record.text === "") return null;
      return { text: record.text, protected: record.protected, inline };
    }).filter((part): part is StructuredPart => part !== null);
    if (!parts.length) {
      throw new Error(`Translation block ${block.id} parts are invalid`);
    }
    return [block.id, reconstructMarkup(parts)];
  });
}

export function validateTranslationBatchResult(
  results: TranslationBlockResult[],
  expected: TranslationBlock[],
  batchNumber: number,
): void {
  const errors: TranslationMarkupError[] = [];
  for (let index = 0; index < expected.length; index++) {
    try {
      validateTranslatedMarkup(expected[index].markup, results[index][1], expected[index].id);
    } catch (error) {
      if (!(error instanceof TranslationMarkupError)) throw error;
      errors.push(error);
    }
  }
  if (errors.length) throw new TranslationBatchValidationError(batchNumber, errors);
}

export function buildTranslationRepairRequest(
  expected: TranslationBlock[],
  results: TranslationBlockResult[],
  error: TranslationBatchValidationError,
): string {
  const resultById = new Map(results);
  const errorsById = new Map<string, string[]>();
  for (const item of error.errors) {
    const id = item.diagnostic.blockId;
    if (!id) throw new Error("Translation validation error has no matching block");
    errorsById.set(id, [...(errorsById.get(id) ?? []), item.message]);
  }
  const failed = expected.filter((block) => errorsById.has(block.id));
  return JSON.stringify({
    failedBlocks: failed.map((block) => {
      const structured = structureBlockMarkup(block.markup);
      return {
        id: block.id,
        sourceParts: structured.parts,
        inlineSpans: inlineSpans(structured),
        protectedTokens: structured.protectedIds,
        previousTranslation: resultById.get(block.id),
        validationErrors: errorsById.get(block.id),
      };
    }),
  });
}

export function failedTranslationBlocks(
  expected: TranslationBlock[],
  error: TranslationBatchValidationError,
): TranslationBlock[] {
  const ids = new Set(error.errors.map((item) => item.diagnostic.blockId));
  return expected.filter((block) => ids.has(block.id));
}

export function mergeTranslationRepairs(
  original: TranslationBlockResult[],
  repairs: TranslationBlockResult[],
): TranslationBlockResult[] {
  const replacements = new Map(repairs);
  return original.map(([id, value]) => [id, replacements.get(id) ?? value]);
}
