import { describe, expect, it } from "vitest";
import { parseArticlePreprocessing, parseClassification, reconcilePreprocessingTags } from "../src/classification";

describe("classification and multilingual title response", () => {
  it("accepts one classification with Chinese, English, and Japanese titles", () => {
    expect(parseClassification(JSON.stringify({
      articleType: "technical",
      confidence: 0.93,
      reason: "Engineering content",
      sourceTitleLocale: "en-US",
      translatedTitles: {
        "zh-CN": "构建可靠的工作流",
        "en-US": "A rewritten English title",
        "ja-JP": "信頼性の高いワークフローの構築",
      },
    }), "Building Reliable Workflows")).toEqual({
      articleType: "technical",
      confidence: 0.93,
      reason: "Engineering content",
      sourceTitleLocale: "en-US",
      translatedTitles: {
        "zh-CN": "构建可靠的工作流",
        "en-US": "Building Reliable Workflows",
        "ja-JP": "信頼性の高いワークフローの構築",
      },
    });
  });

  it("rejects a response that omits any required title locale", () => {
    expect(() => parseClassification(JSON.stringify({
      articleType: "general",
      confidence: 0.8,
      sourceTitleLocale: "zh-CN",
      translatedTitles: { "zh-CN": "标题", "en-US": "Title" },
    }), "标题")).toThrow("Classification response fields are invalid");
  });

  it("rejects a response without a supported source title locale", () => {
    expect(() => parseClassification(JSON.stringify({
      articleType: "general",
      confidence: 0.8,
      translatedTitles: { "zh-CN": "标题", "en-US": "Title", "ja-JP": "タイトル" },
    }), "Title")).toThrow("Classification response fields are invalid");
  });
});

describe("unified preprocessing response", () => {
  const valid = () => ({
    classification: { articleType: "technical", confidence: 0.91, sourceTitleLocale: "en-US", reason: "Implementation details" },
    localizedContent: Object.fromEntries(["zh-CN", "en-US", "ja-JP"].map((locale) => [locale, {
      title: `${locale} title`, summary: `${locale} summary`, keyPoints: ["one", "two", "three"],
    }])),
    informationScore: {
      total: 82,
      dimensions: { specificity: 80, technicalDetail: 90, practicalExperience: 70, evidence: 75, novelty: 85 },
      reason: "Detailed and reproducible",
    },
    tags: ["cloudflare", "rss-reader", "artificial-intelligence"].map((key) => ({
      key, names: { "zh-CN": key, "en-US": key, "ja-JP": key },
    })),
  });

  it("accepts one complete atomic result", () => {
    expect(parseArticlePreprocessing(JSON.stringify(valid()))).toMatchObject({
      classification: { articleType: "technical", sourceTitleLocale: "en-US" }, informationScore: { total: 82 },
    });
  });

  it("rejects the entire result when one locale is incomplete", () => {
    const value = valid();
    value.localizedContent["ja-JP"].keyPoints = ["one", "two"];
    expect(() => parseArticlePreprocessing(JSON.stringify(value))).toThrow(/ja-JP/);
  });

  it("reuses an existing tag when the model returns an alias or translated duplicate", () => {
    const result = parseArticlePreprocessing(JSON.stringify(valid()));
    result.tags[0] = {
      key: "financial-markets",
      names: { "zh-CN": "金融市场", "en-US": "Financial Markets", "ja-JP": "金融市場" },
    };
    const reconciled = reconcilePreprocessingTags(result, [{
      key: "finance",
      names: { "zh-CN": "金融", "en-US": "Finance", "ja-JP": "金融" },
      aliases: ["金融市场", "Financial Markets"],
      status: "active",
    }]);
    expect(reconciled.tags[0]).toEqual({
      key: "finance",
      names: { "zh-CN": "金融", "en-US": "Finance", "ja-JP": "金融" },
    });
  });

  it("rejects output when multiple generated tags resolve to one existing tag", () => {
    const result = parseArticlePreprocessing(JSON.stringify(valid()));
    result.tags[0] = { key: "finance", names: { "zh-CN": "金融", "en-US": "Finance", "ja-JP": "金融" } };
    result.tags[1] = { key: "financial-markets", names: { "zh-CN": "金融市场", "en-US": "Financial Markets", "ja-JP": "金融市場" } };
    expect(() => reconcilePreprocessingTags(result, [{
      key: "finance",
      names: { "zh-CN": "金融", "en-US": "Finance", "ja-JP": "金融" },
      aliases: ["金融市场", "Financial Markets"],
      status: "active",
    }])).toThrow(/duplicate vocabulary/);
  });
});
