import { describe, expect, it } from "vitest";
import { TranslationBatchValidationError } from "../../../src/utils/translationHtml";
import {
  buildTranslationRepairRequest,
  failedTranslationBlocks,
  mergeTranslationRepairs,
  parseTranslationBatchJson,
  validateTranslationBatchResult,
} from "../src/translation-response";

describe("translation response repair", () => {
  const source = [
    { id: "b1", markup: "High-quality evaluations help teams." },
    {
      id: "b2",
      markup: "As we described in <x0>building effective agents</x0>, agents operate over multiple turns.",
    },
  ];

  it("isolates a block whose link markers were omitted and merges its repair", () => {
    const response = JSON.stringify({ blocks: [
      ["b1", "高质量的评估能帮助团队。"],
      ["b2", "正如我们在《构建有效的 agent》中所描述的，agent 会跨越多轮运行。"],
    ] });
    const results = parseTranslationBatchJson(response, source);

    let failure: TranslationBatchValidationError | undefined;
    try {
      validateTranslationBatchResult(results, source, 1);
    } catch (error) {
      if (error instanceof TranslationBatchValidationError) failure = error;
      else throw error;
    }
    expect(failure?.errors).toHaveLength(1);
    expect(failure?.errors[0].diagnostic.token).toBe("<x0>");
    expect(failedTranslationBlocks(source, failure!)).toEqual([source[1]]);

    const request = JSON.parse(buildTranslationRepairRequest(source, results, failure!));
    expect(request.failedBlocks).toEqual([expect.objectContaining({
      id: "b2",
      source: source[1].markup,
      previousTranslation: results[1][1],
    })]);

    const repaired = parseTranslationBatchJson(JSON.stringify({ blocks: [[
      "b2",
      "正如我们在《<x0>构建有效的 agent</x0>》中所描述的，agent 会跨越多轮运行。",
    ]] }), [source[1]]);
    validateTranslationBatchResult(repaired, [source[1]], 1);
    expect(mergeTranslationRepairs(results, repaired)[1][1]).toContain("《<x0>构建有效的 agent</x0>》");
  });

  it("rejects reordered block IDs before markup validation", () => {
    const response = JSON.stringify({ blocks: [["b2", "译文"], ["b1", "译文"]] });
    expect(() => parseTranslationBatchJson(response, source)).toThrow("order or ID");
  });
});
