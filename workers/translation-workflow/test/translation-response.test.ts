import { describe, expect, it } from "vitest";
import {
  applyTranslationPlan,
  createTranslationPlan,
  TranslationBatchValidationError,
} from "../../../src/utils/translationHtml";
import {
  buildTranslationRepairRequest,
  buildTranslationBatchJsonSchema,
  buildTranslationBatchRequest,
  failedTranslationBlocks,
  mergeTranslationRepairs,
  parseTranslationBatchJson,
  validateTranslationBatchResult,
} from "../src/translation-response";

describe("structured translation response", () => {
  const source = [
    { id: "b1", markup: "High-quality evaluations help teams." },
    {
      id: "b2",
      markup: "As we described in <x0>building effective agents</x0>, agents use ⟦p0⟧ over multiple turns.",
    },
  ];

  it("builds a schema with exact block IDs and safe reorderable parts", () => {
    expect(buildTranslationBatchJsonSchema(source)).toEqual(expect.objectContaining({
      additionalProperties: false,
      properties: { blocks: expect.objectContaining({
        additionalProperties: false,
        required: ["b1", "b2"],
        properties: expect.objectContaining({
          b1: expect.objectContaining({ required: ["parts"] }),
          b2: expect.objectContaining({ required: ["parts"] }),
        }),
      }) },
      required: ["blocks"],
    }));
  });

  it("describes source semantics without asking the model to reproduce markup", () => {
    const request = JSON.parse(buildTranslationBatchRequest(source));
    expect(request.blocks.b2).toEqual({
      sourceParts: [
        { text: "As we described in ", protected: "", inline: [] },
        { text: "building effective agents", protected: "", inline: ["x0"] },
        { text: ", agents use ", protected: "", inline: [] },
        { text: "", protected: "p0", inline: [] },
        { text: " over multiple turns.", protected: "", inline: [] },
      ],
      inlineSpans: { x0: "building effective agents" },
      protectedTokens: ["p0"],
    });
  });

  it("reconstructs every source marker from trusted structure", () => {
    const response = JSON.stringify({ blocks: {
      b1: { parts: [{ text: "高质量的评估能帮助团队。", protected: "", inline: [] }] },
      b2: { parts: [
        { text: "正如我们在《", protected: "", inline: [] },
        { text: "构建有效的智能体", protected: "", inline: ["x0"] },
        { text: "》中所述，智能体会在多轮中使用 ", protected: "", inline: [] },
        { text: "", protected: "p0", inline: [] },
        { text: "。", protected: "", inline: [] },
      ] },
    } });
    const results = parseTranslationBatchJson(response, source);
    expect(results[1][1]).toBe("正如我们在《<x0>构建有效的智能体</x0>》中所述，智能体会在多轮中使用 ⟦p0⟧。");
    expect(() => validateTranslationBatchResult(results, source, 1)).not.toThrow();
  });

  it("ignores empty unreferenced parts emitted by the model", () => {
    const response = JSON.stringify({ blocks: {
      b1: { parts: [
        { text: "", protected: "", inline: [] },
        { text: "高质量的评估能帮助团队。", protected: "", inline: [] },
      ] },
      b2: { parts: [
        { text: "", protected: "", inline: [] },
        { text: "构建有效的智能体", protected: "", inline: ["x0"] },
        { text: "会在多轮中使用 ", protected: "", inline: [] },
        { text: "", protected: "p0", inline: [] },
        { text: "。", protected: "", inline: [] },
      ] },
    } });

    expect(parseTranslationBatchJson(response, source)).toEqual([
      ["b1", "高质量的评估能帮助团队。"],
      ["b2", "<x0>构建有效的智能体</x0>会在多轮中使用 ⟦p0⟧。"],
    ]);
  });

  it("rejects an empty part that claims an inline reference", () => {
    expect(() => parseTranslationBatchJson(JSON.stringify({ blocks: {
      b1: { parts: [{ text: "译文", protected: "", inline: [] }] },
      b2: { parts: [{ text: "", protected: "", inline: ["x0"] }] },
    } }), source)).toThrow("references are invalid");
  });

  it("moves a link with its meaning when English and Chinese word order differ", () => {
    const plan = createTranslationPlan(
      '<p>where I led alignment safety for the <a href="https://example.com/basketball">official ChatGPT basketball</a></p>',
    );
    const response = JSON.stringify({ blocks: { b0: { parts: [
      { text: "在那里，我为", protected: "", inline: [] },
      { text: "ChatGPT 官方篮球", protected: "", inline: ["x0"] },
      { text: "负责对齐安全工作", protected: "", inline: [] },
    ] } } });

    const results = parseTranslationBatchJson(response, plan.blocks);
    const html = applyTranslationPlan(plan, results);

    expect(results[0][1]).toBe("在那里，我为<x0>ChatGPT 官方篮球</x0>负责对齐安全工作");
    expect(html).toContain('<a href="https://example.com/basketball">ChatGPT 官方篮球</a>负责对齐安全工作');
    expect(html).not.toContain('篮球</a>的对齐安全工作');
    expect(() => validateTranslationBatchResult(results, plan.blocks, 1)).not.toThrow();
  });

  it("allows literal tag examples already present in technical article text and escapes them on output", () => {
    const plan = createTranslationPlan(
      "<p>Organize prompts into &lt;background&gt;, &lt;instructions&gt;, &lt;tools&gt;, and &lt;output_format&gt; sections.</p>",
    );
    const response = JSON.stringify({ blocks: { b0: { parts: [{
      text: "把提示词组织为 <background>、<instructions>、<tools> 和 <output_format> 等章节。",
      protected: "",
      inline: [],
    }] } } });

    const results = parseTranslationBatchJson(response, plan.blocks);
    expect(() => validateTranslationBatchResult(results, plan.blocks, 1)).not.toThrow();
    expect(applyTranslationPlan(plan, results)).toContain(
      "把提示词组织为 &lt;background&gt;、&lt;instructions&gt;、&lt;tools&gt; 和 &lt;output_format&gt; 等章节。",
    );
  });

  it("rejects a missing block, malformed part, or extra field", () => {
    expect(() => parseTranslationBatchJson(JSON.stringify({ blocks: {
      b1: { parts: [{ text: "译文", protected: "", inline: [] }] },
    } }), source)).toThrow("count or ID");

    expect(() => parseTranslationBatchJson(JSON.stringify({ blocks: {
      b1: { parts: [{ text: "译文", protected: "", inline: [] }] },
      b2: { parts: [{ text: "错误链接", protected: "", inline: ["x9"] }] },
    } }), source)).toThrow("references are invalid");

    expect(() => parseTranslationBatchJson(JSON.stringify({ blocks: {
      b1: { parts: [{ text: "译文", protected: "", inline: [] }], unexpected: "不允许" },
      b2: { parts: [{ text: "译文", protected: "", inline: [] }] },
    } }), source)).toThrow("parts are invalid");
  });

  it("keeps the repair path for reserved-marker validation failures", () => {
    const results = parseTranslationBatchJson(JSON.stringify({ blocks: {
      b1: { parts: [{ text: "含有 <x9> 未知保留标记", protected: "", inline: [] }] },
      b2: { parts: [
        { text: "前", protected: "", inline: [] },
        { text: "中", protected: "", inline: ["x0"] },
        { text: "后", protected: "", inline: [] },
        { text: "", protected: "p0", inline: [] },
        { text: "末", protected: "", inline: [] },
      ] },
    } }), source);
    let failure: TranslationBatchValidationError | undefined;
    try {
      validateTranslationBatchResult(results, source, 1);
    } catch (error) {
      if (error instanceof TranslationBatchValidationError) failure = error;
      else throw error;
    }
    expect(failedTranslationBlocks(source, failure!)).toEqual([source[0]]);
    expect(JSON.parse(buildTranslationRepairRequest(source, results, failure!)).failedBlocks[0])
      .toEqual(expect.objectContaining({ id: "b1", sourceParts: [
        { text: source[0].markup, protected: "", inline: [] },
      ] }));

    const repaired = parseTranslationBatchJson(JSON.stringify({ blocks: {
      b1: { parts: [{ text: "高质量的评估能帮助团队。", protected: "", inline: [] }] },
    } }), [source[0]]);
    expect(mergeTranslationRepairs(results, repaired)[0]).toEqual(["b1", "高质量的评估能帮助团队。"]);
  });
});
