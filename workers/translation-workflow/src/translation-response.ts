import {
  TranslationBatchValidationError,
  TranslationMarkupError,
  validateTranslatedMarkup,
  type TranslationBlock,
  type TranslationBlockResult,
} from "../../../src/utils/translationHtml";

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
  if (!Array.isArray(blocks) || blocks.length !== expected.length) {
    throw new Error("Translation block count is invalid");
  }
  return blocks.map((block, index) => {
    if (!Array.isArray(block) || block.length !== 2 ||
        typeof block[0] !== "string" || typeof block[1] !== "string") {
      throw new Error("Translation block shape is invalid");
    }
    if (block[0] !== expected[index].id) {
      throw new Error("Translation block order or ID is invalid");
    }
    return [block[0], block[1]];
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
  const expectedById = new Map(expected.map((block) => [block.id, block.markup]));
  const resultById = new Map(results);
  const errorsById = new Map<string, string[]>();
  for (const item of error.errors) {
    const id = item.diagnostic.blockId;
    if (!id) throw new Error("Translation validation error has no matching block");
    errorsById.set(id, [...(errorsById.get(id) ?? []), item.message]);
  }
  return JSON.stringify({
    failedBlocks: [...errorsById].map(([id, validationErrors]) => {
      if (!expectedById.has(id) || !resultById.has(id)) {
        throw new Error("Translation validation error has no matching block");
      }
      return {
        id,
        source: expectedById.get(id),
        previousTranslation: resultById.get(id),
        validationErrors,
      };
    }),
    responseFormat: { blocks: [["原 block id", "修复后的完整译文"]] },
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
