import { describe, expect, it } from "vitest";
import { alignContentBlocks, analyzeContentBlocks, annotateAndHideContentBlocks } from "../../shared/src/content-blocks";
import { applyTranslationPlan, createTranslationPlan } from "../../../src/utils/translationHtml";

describe("translation content block integration", () => {
  it("keeps every parsed block in a new translation plan", () => {
    const annotated = annotateAndHideContentBlocks(
      "<p>Main article paragraph.</p><p>Template-looking paragraph remains unless the feed rule removes it.</p>",
    );
    const plan = createTranslationPlan(annotated);
    expect(plan.blocks).toHaveLength(2);
    expect(plan.sourceHtml).toContain("Template-looking paragraph");
    expect(plan.sourceHtml).toContain('data-feedmind-block-id="n0"');
    expect(plan.sourceHtml).toContain('data-feedmind-block-id="n1"');
  });

  it("keeps stable IDs in translated HTML", () => {
    const annotated = annotateAndHideContentBlocks("<p>Main body.</p><p>Second body block.</p>");
    const plan = createTranslationPlan(annotated);
    const translated = applyTranslationPlan(plan, plan.blocks.map((block, index) => [block.id, `译文 ${index + 1}`]));
    expect(translated).toContain('data-feedmind-block-id="n0"');
    expect(translated).toContain('data-feedmind-block-id="n1"');
  });

  it("indexes deterministic fingerprints without classifying blocks as noise", async () => {
    const blocks = await analyzeContentBlocks("<p>First paragraph.</p><blockquote>Quoted text.</blockquote><pre>code()</pre>");
    expect(blocks.map((block) => ({ id: block.stableId, kind: block.kind }))).toEqual([
      { id: "n0", kind: "p" }, { id: "n1", kind: "blockquote" }, { id: "n2", kind: "pre" },
    ]);
    expect(blocks.every((block) => /^[a-f0-9]{64}$/.test(block.exactFingerprint))).toBe(true);
  });

  it("aligns unchanged blocks across parser versions", () => {
    const block = (stableId: string, exactFingerprint: string, normalizedLength = 100) => ({
      stableId, kind: "p", exactFingerprint, normalizedLength,
    });
    const aligned = alignContentBlocks(
      [block("n0", "intro"), block("n1", "body"), block("n2", "old-tail")],
      [block("n0", "intro"), block("n1", "body")],
    );
    expect(aligned).toMatchObject({ currentCoverage: 1, ambiguous: false });
    expect(aligned.mapping).toEqual([
      { fromStableId: "n0", toStableId: "n0" },
      { fromStableId: "n1", toStableId: "n1" },
    ]);
  });
});
