import { describe, expect, it } from "vitest";
import { formatSample, sampleArticleText, type SamplingConfig } from "../src/sampling";

const config: SamplingConfig = {
  algorithmVersion: "paragraph-dispersed-v1",
  bodyTokenBudget: 120,
  headRatio: 0.25,
  middleRatio: 0.6,
  tailRatio: 0.15,
  middleWindows: 4,
};

describe("deterministic article sampling", () => {
  it("uses the complete body for short articles", async () => {
    const result = await sampleArticleText("第一段。\n\n第二段。", { ...config, bodyTokenBudget: 3000 });
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({ position: "full", paragraphStart: 0, paragraphEnd: 1 });
  });

  it("creates head, dispersed middle and tail ranges without duplicate paragraphs", async () => {
    const source = Array.from({ length: 30 }, (_, index) => `第 ${index} 段。${"内容".repeat(15)}`).join("\n\n");
    const first = await sampleArticleText(source, config);
    const second = await sampleArticleText(source, config);
    expect(first).toEqual(second);
    expect(first.fragments[0].position).toBe("head");
    expect(first.fragments.at(-1)?.position).toBe("tail");
    expect(first.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(formatSample(first.fragments)).toContain("[片段 1；位置=head");
    const ranges = first.fragments.flatMap((fragment) =>
      Array.from({ length: fragment.paragraphEnd - fragment.paragraphStart + 1 }, (_, offset) => fragment.paragraphStart + offset));
    expect(new Set(ranges).size).toBe(ranges.length);
  });
});
