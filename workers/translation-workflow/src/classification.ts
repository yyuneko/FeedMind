export const TITLE_LOCALES = ["zh-CN", "en-US", "ja-JP"] as const;
export type TitleLocale = typeof TITLE_LOCALES[number];
export type SourceTitleLocale = TitleLocale | "other";
export type TranslatedTitles = Record<TitleLocale, string>;

export interface ClassificationResult {
  articleType: "technical" | "news" | "general";
  confidence: number;
  sourceTitleLocale: SourceTitleLocale;
  translatedTitles: TranslatedTitles;
  reason: string;
}

export interface LocalizedPreprocessingContent {
  title: string;
  summary: string;
  keyPoints: string[];
}

export interface PreprocessingTag {
  key: string;
  names: Record<TitleLocale, string>;
}

export interface ExistingTopicTag extends PreprocessingTag {
  aliases: string[];
  status: "active";
}

export interface ArticlePreprocessingResult {
  classification: Pick<ClassificationResult, "articleType" | "confidence" | "sourceTitleLocale" | "reason">;
  localizedContent: Record<TitleLocale, LocalizedPreprocessingContent>;
  informationScore: {
    total: number;
    dimensions: { specificity: number; technicalDetail: number; practicalExperience: number; evidence: number; novelty: number };
    reason: string;
  };
  tags: PreprocessingTag[];
}

const localizedContentSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    keyPoints: { type: "array", minItems: 3, maxItems: 5, items: { type: "string", minLength: 1 } },
  },
  required: ["title", "summary", "keyPoints"],
};

export const ARTICLE_PREPROCESSING_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    classification: {
      type: "object",
      additionalProperties: false,
      properties: {
        articleType: { type: "string", enum: ["technical", "news", "general"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        sourceTitleLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP", "other"] },
        reason: { type: "string", minLength: 1 },
      },
      required: ["articleType", "confidence", "sourceTitleLocale", "reason"],
    },
    localizedContent: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(TITLE_LOCALES.map((locale) => [locale, localizedContentSchema])),
      required: [...TITLE_LOCALES],
    },
    informationScore: {
      type: "object",
      additionalProperties: false,
      properties: {
        total: { type: "integer", minimum: 0, maximum: 100 },
        dimensions: {
          type: "object",
          additionalProperties: false,
          properties: Object.fromEntries(["specificity", "technicalDetail", "practicalExperience", "evidence", "novelty"]
            .map((key) => [key, { type: "integer", minimum: 0, maximum: 100 }])),
          required: ["specificity", "technicalDetail", "practicalExperience", "evidence", "novelty"],
        },
        reason: { type: "string", minLength: 1 },
      },
      required: ["total", "dimensions", "reason"],
    },
    tags: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,63}$" },
          names: {
            type: "object",
            additionalProperties: false,
            properties: Object.fromEntries(TITLE_LOCALES.map((locale) => [locale, { type: "string", minLength: 1 }])),
            required: [...TITLE_LOCALES],
          },
        },
        required: ["key", "names"],
      },
    },
  },
  required: ["classification", "localizedContent", "informationScore", "tags"],
};

const score = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 100;

export function parseArticlePreprocessing(raw: string): ArticlePreprocessingResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Preprocessing response is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preprocessing response is invalid");
  const root = value as Record<string, unknown>;
  const classification = root.classification as Record<string, unknown> | undefined;
  const localized = root.localizedContent as Record<string, unknown> | undefined;
  const information = root.informationScore as Record<string, unknown> | undefined;
  const dimensions = information?.dimensions as Record<string, unknown> | undefined;
  if (!classification || !["technical", "news", "general"].includes(String(classification.articleType)) ||
      typeof classification.confidence !== "number" || classification.confidence < 0 || classification.confidence > 1 ||
      ![...TITLE_LOCALES, "other"].includes(String(classification.sourceTitleLocale)) ||
      typeof classification.reason !== "string" || !classification.reason.trim() || !localized || !information ||
      !score(information.total) || typeof information.reason !== "string" || !information.reason.trim() || !dimensions ||
      !["specificity", "technicalDetail", "practicalExperience", "evidence", "novelty"].every((key) => score(dimensions[key]))) {
    throw new Error("Preprocessing response fields are invalid");
  }
  const localizedContent = {} as ArticlePreprocessingResult["localizedContent"];
  for (const locale of TITLE_LOCALES) {
    const item = localized[locale] as Record<string, unknown> | undefined;
    if (!item || typeof item.title !== "string" || !item.title.trim() || typeof item.summary !== "string" ||
        !item.summary.trim() || !Array.isArray(item.keyPoints) || item.keyPoints.length < 3 || item.keyPoints.length > 5 ||
        item.keyPoints.some((point) => typeof point !== "string" || !point.trim())) {
      throw new Error(`Preprocessing ${locale} content is invalid`);
    }
    localizedContent[locale] = {
      title: item.title.trim(), summary: item.summary.trim(), keyPoints: item.keyPoints.map((point) => String(point).trim()),
    };
  }
  if (!Array.isArray(root.tags) || root.tags.length < 3 || root.tags.length > 5) throw new Error("Preprocessing tags are invalid");
  const seen = new Set<string>();
  const tags = root.tags.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preprocessing tag is invalid");
    const item = value as Record<string, unknown>;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    const names = item.names as Record<string, unknown> | undefined;
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key) || seen.has(key) || !names ||
        TITLE_LOCALES.some((locale) => typeof names[locale] !== "string" || !String(names[locale]).trim())) {
      throw new Error("Preprocessing tag fields are invalid");
    }
    seen.add(key);
    return { key, names: Object.fromEntries(TITLE_LOCALES.map((locale) => [locale, String(names[locale]).trim()])) as Record<TitleLocale, string> };
  });
  return {
    classification: {
      articleType: classification.articleType as ClassificationResult["articleType"],
      confidence: Number(classification.confidence),
      sourceTitleLocale: classification.sourceTitleLocale as SourceTitleLocale,
      reason: classification.reason.trim().slice(0, 500),
    },
    localizedContent,
    informationScore: {
      total: Number(information.total),
      dimensions: dimensions as ArticlePreprocessingResult["informationScore"]["dimensions"],
      reason: information.reason.trim().slice(0, 1000),
    },
    tags,
  };
}

const normalizedTagTerm = (value: string) => value.normalize("NFKC").toLocaleLowerCase()
  .replace(/[\s\-_.\/·・、，,；;：:'"“”‘’（）()\[\]【】]+/g, "");

export function reconcilePreprocessingTags(
  result: ArticlePreprocessingResult,
  vocabulary: ExistingTopicTag[],
): ArticlePreprocessingResult {
  const byKey = new Map(vocabulary.map((tag) => [tag.key, tag]));
  const byTerm = new Map<string, ExistingTopicTag>();
  for (const tag of vocabulary) {
    for (const term of [...Object.values(tag.names), ...tag.aliases]) {
      const normalized = normalizedTagTerm(term);
      if (normalized && !byTerm.has(normalized)) byTerm.set(normalized, tag);
    }
  }
  const tags = result.tags.map((tag) => {
    const existing = byKey.get(tag.key) ?? Object.values(tag.names)
      .map((name) => byTerm.get(normalizedTagTerm(name))).find(Boolean);
    return existing ? { key: existing.key, names: existing.names } : tag;
  });
  if (new Set(tags.map((tag) => tag.key)).size !== tags.length) {
    throw new Error("Preprocessing tags collapse to duplicate vocabulary entries");
  }
  if (tags.length < 3 || tags.length > 5) throw new Error("Preprocessing reconciled tags are invalid");
  return { ...result, tags };
}

export function parseClassification(raw: string, sourceTitle: string): ClassificationResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Classification response is not valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Classification response is invalid");
  const item = value as Record<string, unknown>;
  const titles = item.translatedTitles;
  const sourceTitleLocale = String(item.sourceTitleLocale);
  if (!["technical", "news", "general"].includes(String(item.articleType)) ||
      typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1 ||
      ![...TITLE_LOCALES, "other"].includes(sourceTitleLocale) ||
      !titles || typeof titles !== "object" || Array.isArray(titles) ||
      TITLE_LOCALES.some((locale) => typeof (titles as Record<string, unknown>)[locale] !== "string" ||
        !(titles as Record<string, string>)[locale].trim())) {
    throw new Error("Classification response fields are invalid");
  }
  const translatedTitles = Object.fromEntries(TITLE_LOCALES.map((locale) =>
    [locale, (titles as Record<string, string>)[locale].trim()])) as TranslatedTitles;
  if (TITLE_LOCALES.includes(sourceTitleLocale as TitleLocale)) {
    translatedTitles[sourceTitleLocale as TitleLocale] = sourceTitle.trim();
  }
  return {
    articleType: item.articleType as ClassificationResult["articleType"],
    confidence: item.confidence,
    sourceTitleLocale: sourceTitleLocale as SourceTitleLocale,
    translatedTitles,
    reason: typeof item.reason === "string" ? item.reason.slice(0, 500) : "",
  };
}
