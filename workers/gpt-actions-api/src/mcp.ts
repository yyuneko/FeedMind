type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  securitySchemes: Array<{ type: "oauth2"; scopes: string[] }>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

type InvokeAction = (request: Request) => Promise<Response>;

const readSecurity = [{ type: "oauth2" as const, scopes: ["feedmind.read"] }];
const writeSecurity = [{ type: "oauth2" as const, scopes: ["feedmind.write"] }];
const text = (description: string, maxLength = 100) => ({
  type: "string",
  minLength: 1,
  maxLength,
  description,
});
const integer = (minimum: number, maximum: number, defaultValue?: number) => ({
  type: "integer",
  minimum,
  maximum,
  ...(defaultValue == null ? {} : { default: defaultValue }),
});
const localizedPreprocessing = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 1000 },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    keyPoints: { type: "array", minItems: 3, maxItems: 5, items: { type: "string", minLength: 1, maxLength: 4000 } },
  },
  required: ["title", "summary", "keyPoints"],
};
const preprocessingResult = {
  type: "object",
  additionalProperties: false,
  properties: {
    classification: {
      type: "object", additionalProperties: false,
      properties: {
        articleType: { type: "string", enum: ["technical", "news", "general"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        sourceTitleLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP", "other"] },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      required: ["articleType", "confidence", "sourceTitleLocale", "reason"],
    },
    localizedContent: {
      type: "object", additionalProperties: false,
      properties: { "zh-CN": localizedPreprocessing, "en-US": localizedPreprocessing, "ja-JP": localizedPreprocessing },
      required: ["zh-CN", "en-US", "ja-JP"],
    },
    informationScore: {
      type: "object", additionalProperties: false,
      properties: {
        total: integer(0, 100),
        dimensions: {
          type: "object", additionalProperties: false,
          properties: Object.fromEntries(["specificity", "technicalDetail", "practicalExperience", "evidence", "novelty"]
            .map((key) => [key, integer(0, 100)])),
          required: ["specificity", "technicalDetail", "practicalExperience", "evidence", "novelty"],
        },
        reason: { type: "string", minLength: 1, maxLength: 1000 },
      },
      required: ["total", "dimensions", "reason"],
    },
    tags: {
      type: "array", minItems: 3, maxItems: 5,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          key: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,63}$" },
          names: {
            type: "object", additionalProperties: false,
            properties: { "zh-CN": text("中文标签名"), "en-US": text("English tag name"), "ja-JP": text("日本語タグ名") },
            required: ["zh-CN", "en-US", "ja-JP"],
          },
        },
        required: ["key", "names"],
      },
    },
  },
  required: ["classification", "localizedContent", "informationScore", "tags"],
};
const imageSegment = {
  type: "object",
  additionalProperties: false,
  properties: {
    x: { type: "number", minimum: 0, description: "文本左上角基于实际视觉输入宽度的像素坐标；客户端不做文本对齐或额外偏移。" },
    y: { type: "number", minimum: 0, description: "文本左上角基于实际视觉输入高度的像素坐标；客户端不做文本对齐或额外偏移。" },
    w: { type: "number", exclusiveMinimum: 0, description: "文本覆盖框像素宽度。" },
    h: { type: "number", exclusiveMinimum: 0, description: "文本覆盖框像素高度。" },
    text: { type: "string", minLength: 1, maxLength: 2000 },
    bg: { type: "string", pattern: "^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$" },
    color: { type: "string", pattern: "^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$" },
    fontSize: { type: "number", exclusiveMinimum: 0, description: "基准图片上的像素字号。" },
  },
  required: ["x", "y", "w", "h", "text", "bg", "color", "fontSize"],
};

function tool(
  name: string,
  title: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  write = false
): ToolDefinition {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      ...(required.length ? { required } : {}),
    },
    securitySchemes: write ? writeSecurity : readSecurity,
    annotations: {
      readOnlyHint: !write,
      destructiveHint: false,
      idempotentHint: !write,
      openWorldHint:
        write && ["addArticle", "addSubscriptionFeed"].includes(name),
    },
  };
}

export const mcpTools: ToolDefinition[] = [
  tool(
    "searchArticles",
    "搜索文章",
    "搜索或分页列出当前 FeedMind 账户中的文章。",
    {
      query: { type: "string", maxLength: 200 },
      feedId: { type: "string", maxLength: 100 },
      page: integer(1, 10000, 1),
      pageSize: integer(1, 100, 20),
      unread: { type: "boolean" },
      starred: { type: "boolean" },
    },
    []
  ),
  tool(
    "listUntranslatedArticles",
    "查询未翻译文章",
    "分页列出当前 FeedMind 账户中尚无目标语言完整正文译文的文章，包括尚未进行 AI 预处理的文章；返回预处理状态以及当前是否可直接翻译。translationReady 为 false 时先完成文章 AI 预处理。",
    {
      targetLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP"], default: "zh-CN" },
      query: { type: "string", maxLength: 200 },
      feedId: { type: "string", maxLength: 100 },
      page: integer(1, 10000, 1),
      pageSize: integer(1, 100, 20),
    },
    []
  ),
  tool(
    "addArticle",
    "添加文章",
    "按网页 URL 添加一篇文章并排队抓取。",
    {
      url: { type: "string", format: "uri", maxLength: 2000 },
      title: { type: "string", maxLength: 500 },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["url", "idempotencyKey"],
    true
  ),
  tool(
    "addSubscriptionFeed",
    "添加订阅源",
    "添加 RSS 或 Atom 订阅源并排队执行首次抓取。",
    {
      url: { type: "string", format: "uri", maxLength: 2000 },
      title: { type: "string", maxLength: 500 },
      categoryId: { type: "string", maxLength: 100 },
      category: { type: "string", maxLength: 200 },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["url", "idempotencyKey"],
    true
  ),
  tool(
    "listSubscriptions",
    "查询订阅",
    "搜索或分页列出当前 FeedMind 账户中的订阅。",
    {
      query: { type: "string", maxLength: 200 },
      page: integer(1, 10000, 1),
      pageSize: integer(1, 100, 20),
    },
    []
  ),
  tool(
    "getSubscription",
    "获取订阅",
    "读取一个订阅的标题、分类、排序、启用状态和抓取状态。",
    { subscriptionId: text("订阅 ID。") },
    ["subscriptionId"]
  ),
  tool(
    "updateSubscription",
    "更新订阅",
    "更新订阅的自定义标题、分类、排序和启用状态。此操作不会删除订阅。",
    {
      subscriptionId: text("订阅 ID。"),
      title: { type: "string", maxLength: 500 },
      category: { type: "string", maxLength: 200 },
      sortOrder: integer(0, 1000000),
      enabled: { type: "boolean" },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["subscriptionId", "title", "category", "sortOrder", "enabled", "idempotencyKey"],
    true
  ),
  tool(
    "refreshSubscription",
    "刷新订阅",
    "立即排队刷新一个已启用的订阅。",
    {
      subscriptionId: text("订阅 ID。"),
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["subscriptionId", "idempotencyKey"],
    true
  ),
  tool(
    "refreshSubscriptionTitle",
    "刷新订阅标题",
    "立即排队刷新一个订阅的远端标题。",
    {
      subscriptionId: text("订阅 ID。"),
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["subscriptionId", "idempotencyKey"],
    true
  ),
  tool(
    "importOpmlSubscriptions",
    "导入 OPML 订阅",
    "从一个可访问的 OPML 文件 URL 批量导入订阅，可选择放入指定分类。",
    {
      url: { type: "string", format: "uri", maxLength: 2000 },
      category: { type: "string", maxLength: 200 },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["url", "idempotencyKey"],
    true
  ),
  tool(
    "getLibraryTree",
    "获取订阅库",
    "读取当前账户的订阅分类树、订阅源和未读数量。",
    {},
    []
  ),
  tool(
    "createLibraryCategory",
    "创建分类",
    "创建一个 FeedMind 订阅分类。",
    {
      name: text("分类名称。", 200),
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["name", "idempotencyKey"],
    true
  ),
  tool(
    "updateLibraryCategory",
    "更新分类",
    "重命名或重新排序一个订阅分类。此操作不会删除分类。",
    {
      categoryId: text("分类 ID。"),
      name: { type: "string", minLength: 1, maxLength: 200 },
      sortOrder: integer(0, 1000000),
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["categoryId", "idempotencyKey"],
    true
  ),
  tool(
    "updateLibraryFeed",
    "更新订阅源",
    "更新订阅源的标题、URL、分类、排序或启用状态。此操作不会删除订阅源。",
    {
      feedId: text("订阅库中的订阅源 ID。"),
      customTitle: { type: "string", maxLength: 500 },
      url: { type: "string", format: "uri", maxLength: 2000 },
      categoryId: { type: ["string", "null"], maxLength: 100 },
      sortOrder: integer(0, 1000000),
      enabled: { type: "boolean" },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["feedId", "idempotencyKey"],
    true
  ),
  tool(
    "getArticle",
    "获取文章",
    "读取一篇文章的元数据。",
    {
      articleId: text("文章 ID。"),
    },
    ["articleId"]
  ),
  tool(
    "readArticleContentChunk",
    "读取文章正文",
    "按 Unicode 字符游标读取一段受保护的文章正文。",
    {
      articleId: text("文章 ID。"),
      format: { type: "string", enum: ["html", "text"], default: "text" },
      cursor: integer(0, 20000000, 0),
      limit: integer(1, 50000, 20000),
    },
    ["articleId"]
  ),
  tool(
    "listArticleImages",
    "列出文章图片",
    "列出当前文章中的静态图片，同时返回文章标题、摘要、正文摘录和每张图片附近的 contextText。翻译图片文字时必须结合这些文章内容；摘录不足时继续分段读取正文。先尝试直接查看 imageUrl，只有无法访问时才调用读取文章图片工具。",
    { articleId: text("文章 ID。") },
    ["articleId"]
  ),
  tool(
    "readArticleImage",
    "读取文章图片",
    "仅当无法直接访问 imageUrl 时调用。通过 FeedMind 即时转发一张文章静态图片并作为视觉输入返回；不缓存图片，不支持任何动图。",
    { articleId: text("文章 ID。"), imageId: text("列出文章图片工具返回的图片 ID。", 128) },
    ["articleId", "imageId"]
  ),
  tool(
    "getArticleImageTranslation",
    "读取图片翻译",
    "读取一张文章图片已有的文字覆盖翻译。",
    {
      articleId: text("文章 ID。"),
      imageId: text("图片 ID。", 128),
      targetLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP"], default: "zh-CN" },
    },
    ["articleId", "imageId"]
  ),
  tool(
    "saveArticleImageTranslation",
    "保存图片翻译",
    "仅当图片含有值得翻译的文字时调用。译文必须参考 listArticleImages 返回的文章上下文和图片附近文字，保持术语、人名、语气与正文一致；上下文不足时先读取更多正文。referenceWidth/referenceHeight 必须是你实际看到的图片尺寸；所有坐标和字号必须是该基准图片上的像素值。客户端不设置水平或垂直文本对齐、不增加内边距，文本左上角及占用区域完全由 x/y/w/h 决定。不要为照片、装饰图、Logo、无文字图片或动图保存结果。",
    {
      articleId: text("文章 ID。"),
      imageId: text("图片 ID。", 128),
      targetLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP"], default: "zh-CN" },
      referenceWidth: integer(1, 20000),
      referenceHeight: integer(1, 20000),
      segments: { type: "array", minItems: 1, maxItems: 200, items: imageSegment },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["articleId", "imageId", "referenceWidth", "referenceHeight", "segments", "idempotencyKey"],
    true
  ),
  tool(
    "getArticlePreprocessingContext",
    "读取文章预处理上下文",
    "完整预处理文章前必须调用。返回与 FeedMind 内部预处理工作流相同的提示词、版本和标签词表；随后读取完整正文并调用保存文章预处理工具。",
    { articleId: text("文章 ID。") },
    ["articleId"]
  ),
  tool(
    "createArticlePreprocessing",
    "保存文章完整预处理",
    "使用当前对话模型完成分类、三语标题/摘要/要点、信息评分和标签后一次性保存。此操作写入 FeedMind 正式预处理数据，不调用 FeedMind 配置的付费 LLM API。",
    {
      articleId: text("文章 ID。"),
      contextVersion: text("读取文章预处理上下文工具返回的 contextVersion。", 128),
      result: preprocessingResult,
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["articleId", "contextVersion", "result", "idempotencyKey"],
    true
  ),
  tool(
    "createArticleTitleTranslation",
    "翻译文章标题",
    "用户要求翻译文章标题时，由你生成标题译文并调用本工具保存；此操作不会调用 FeedMind 的 LLM API。",
    {
      articleId: text("文章 ID。"),
      targetLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP"], default: "zh-CN" },
      translatedTitle: { type: "string", minLength: 1, maxLength: 1000 },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["articleId", "translatedTitle", "idempotencyKey"],
    true
  ),
  tool(
    "createArticleSummary",
    "总结文章",
    "用户要求总结文章时，完整读取正文，由你生成一句话摘要并调用本工具保存；此操作不会调用 FeedMind 的 LLM API。",
    {
      articleId: text("文章 ID。"),
      targetLocale: { type: "string", enum: ["zh-CN", "en-US", "ja-JP"], default: "zh-CN" },
      summary: { type: "string", minLength: 1, maxLength: 4000 },
      idempotencyKey: text("本次逻辑写请求的唯一幂等键。", 128),
    },
    ["articleId", "summary", "idempotencyKey"],
    true
  ),
  tool(
    "getArticleTranslations",
    "查询文章翻译",
    "查询一篇文章已有的翻译版本与状态。",
    {
      articleId: text("文章 ID。"),
      targetLocale: { type: "string", maxLength: 35, default: "zh-CN" },
    },
    ["articleId"]
  ),
  tool(
    "getArticleTranslationPrompt",
    "读取文章翻译提示词",
    "翻译文章前必须调用。根据文章当前分类和目标语言返回生效的正文翻译提示词及版本。",
    {
      articleId: text("文章 ID。"),
      targetLocale: { type: "string", maxLength: 35, default: "zh-CN" },
    },
    ["articleId"]
  ),
  tool(
    "getTranslationStatus",
    "查询翻译状态",
    "查询一个翻译任务的当前状态。",
    {
      translationId: text("翻译 ID。"),
    },
    ["translationId"]
  ),
  tool(
    "readTranslationResultChunk",
    "读取翻译结果",
    "按 Unicode 字符游标读取一段已完成的翻译结果。",
    {
      translationId: text("翻译 ID。"),
      cursor: integer(0, 20000000, 0),
      limit: integer(1, 50000, 20000),
    },
    ["translationId"]
  ),
  tool(
    "createArticleTranslation",
    "创建文章翻译",
    "用户要求翻译文章时，必须同时处理正文和图片：保存正文译文后立即调用 listArticleImages，逐张检查静态图片，并为所有含有意义文字的图片保存同一目标语言的翻译；图片检查和必要翻译完成前，文章翻译任务不算完成。仅在对话中展示译文不算完成。译文必须通过参数传入；此操作不会调用 FeedMind 的 LLM API，也不会启动翻译工作流。",
    {
      articleId: text("文章 ID"),
      targetLocale: {
        type: "string",
        maxLength: 35,
        default: "zh-CN",
      },
      translatedTitle: {
        type: "string",
        maxLength: 1000,
      },
      translatedContent: {
        type: "string",
        minLength: 1,
        maxLength: 5000000,
        description: "完整的翻译后 HTML，保留原文结构与必要标签。",
      },
      promptVersionId: text("调用读取文章翻译提示词工具后返回的提示词版本 ID。"),
      idempotencyKey: text("幂等键", 128),
    },
    ["articleId", "translatedTitle", "translatedContent", "promptVersionId", "idempotencyKey"],
    true
  ),
];

const toolsByName = new Map(mcpTools.map((item) => [item.name, item]));

function rpc(id: JsonRpcId, result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function rpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }),
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
}

function value(input: Record<string, unknown>, key: string): string {
  const result = input[key];
  if (typeof result !== "string" || !result)
    throw new Error(`${key} is required`);
  return result;
}

function actionRequest(
  name: string,
  args: Record<string, unknown>,
  source: Request
): Request {
  const base = new URL(source.url);
  let method = "GET";
  let path = "";
  let body: Record<string, unknown> | undefined;
  const query = new URLSearchParams();
  const addQuery = (...keys: string[]) =>
    keys.forEach((key) => {
      const item = args[key];
      if (item !== undefined) query.set(key, String(item));
    });
  switch (name) {
    case "searchArticles":
      path = "/internal/v1/articles";
      addQuery("query", "feedId", "page", "pageSize", "unread", "starred");
      break;
    case "listUntranslatedArticles":
      path = "/internal/v1/articles/untranslated";
      addQuery("targetLocale", "query", "feedId", "page", "pageSize");
      break;
    case "addArticle":
      method = "POST";
      path = "/internal/v1/articles";
      body = args;
      break;
    case "addSubscriptionFeed":
      method = "POST";
      path = "/internal/v1/subscriptions";
      body = args;
      break;
    case "listSubscriptions":
      path = "/internal/v1/subscriptions";
      addQuery("query", "page", "pageSize");
      break;
    case "getSubscription":
      path = `/internal/v1/subscriptions/${encodeURIComponent(value(args, "subscriptionId"))}`;
      break;
    case "updateSubscription": {
      method = "PATCH";
      path = `/internal/v1/subscriptions/${encodeURIComponent(value(args, "subscriptionId"))}`;
      const { subscriptionId: _subscriptionId, ...payload } = args;
      body = payload;
      break;
    }
    case "refreshSubscription":
    case "refreshSubscriptionTitle": {
      method = "POST";
      const action = name === "refreshSubscriptionTitle" ? "refresh-title" : "refresh";
      path = `/internal/v1/subscriptions/${encodeURIComponent(value(args, "subscriptionId"))}/${action}`;
      const { subscriptionId: _subscriptionId, ...payload } = args;
      body = payload;
      break;
    }
    case "importOpmlSubscriptions":
      method = "POST";
      path = "/internal/v1/opml/import";
      body = args;
      break;
    case "getLibraryTree":
      path = "/internal/v1/library/tree";
      break;
    case "createLibraryCategory":
      method = "POST";
      path = "/internal/v1/library/categories";
      body = args;
      break;
    case "updateLibraryCategory": {
      method = "PATCH";
      path = `/internal/v1/library/categories/${encodeURIComponent(value(args, "categoryId"))}`;
      const { categoryId: _categoryId, ...payload } = args;
      body = payload;
      break;
    }
    case "updateLibraryFeed": {
      method = "PATCH";
      path = `/internal/v1/library/feeds/${encodeURIComponent(value(args, "feedId"))}`;
      const { feedId: _feedId, ...payload } = args;
      body = payload;
      break;
    }
    case "getArticle":
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}`;
      break;
    case "readArticleContentChunk":
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/content`;
      addQuery("format", "cursor", "limit");
      break;
    case "listArticleImages":
      path = `/internal/v1/articles/${encodeURIComponent(value(args, "articleId"))}/images`;
      break;
    case "readArticleImage":
      path = `/internal/v1/articles/${encodeURIComponent(value(args, "articleId"))}/images/${encodeURIComponent(value(args, "imageId"))}`;
      break;
    case "getArticleImageTranslation":
      path = `/internal/v1/articles/${encodeURIComponent(value(args, "articleId"))}/image-translations/${encodeURIComponent(value(args, "imageId"))}`;
      addQuery("targetLocale");
      break;
    case "saveArticleImageTranslation": {
      method = "POST";
      path = `/internal/v1/articles/${encodeURIComponent(value(args, "articleId"))}/image-translations/${encodeURIComponent(value(args, "imageId"))}`;
      const { articleId: _articleId, imageId: _imageId, ...payload } = args;
      body = payload;
      break;
    }
    case "getArticlePreprocessingContext":
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/preprocessing-context`;
      break;
    case "createArticlePreprocessing": {
      method = "POST";
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/preprocessing`;
      const { articleId: _articleId, ...payload } = args;
      body = payload;
      break;
    }
    case "createArticleTitleTranslation": {
      method = "POST";
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/title-translation`;
      const { articleId: _articleId, ...payload } = args;
      body = payload;
      break;
    }
    case "createArticleSummary": {
      method = "POST";
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/summary`;
      const { articleId: _articleId, ...payload } = args;
      body = payload;
      break;
    }
    case "getArticleTranslations":
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/translations`;
      addQuery("targetLocale");
      break;
    case "getArticleTranslationPrompt":
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/translation-prompt`;
      addQuery("targetLocale");
      break;
    case "getTranslationStatus":
      path = `/internal/v1/translations/${encodeURIComponent(
        value(args, "translationId")
      )}`;
      break;
    case "readTranslationResultChunk":
      path = `/internal/v1/translations/${encodeURIComponent(
        value(args, "translationId")
      )}/result`;
      addQuery("cursor", "limit");
      break;
    case "createArticleTranslation": {
      method = "POST";
      path = `/internal/v1/articles/${encodeURIComponent(
        value(args, "articleId")
      )}/translations`;
      const { articleId: _articleId, ...payload } = args;
      body = payload;
      break;
    }
    default:
      throw new Error("Unknown tool");
  }
  base.pathname = path;
  base.search = query.toString();
  const headers = new Headers();
  const authorization = source.headers.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  if (body) headers.set("Content-Type", "application/json");
  return new Request(base, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function authChallenge(request: Request, description: string): string {
  const metadata = new URL(
    "/.well-known/oauth-protected-resource",
    request.url
  ).toString();
  return `Bearer resource_metadata="${metadata}", error="invalid_token", error_description="${description.replaceAll(
    '"',
    "'"
  )}"`;
}

async function callTool(
  id: JsonRpcId,
  params: unknown,
  request: Request,
  invoke: InvokeAction
): Promise<Response> {
  if (!params || typeof params !== "object" || Array.isArray(params))
    return rpcError(id, -32602, "Invalid tools/call parameters");
  const input = params as { name?: unknown; arguments?: unknown };
  if (typeof input.name !== "string" || !toolsByName.has(input.name))
    return rpcError(id, -32602, "Unknown tool");
  const args = input.arguments == null ? {} : input.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args))
    return rpcError(id, -32602, "Tool arguments must be an object");
  let action: Request;
  try {
    action = actionRequest(
      input.name,
      args as Record<string, unknown>,
      request
    );
  } catch (error) {
    return rpcError(
      id,
      -32602,
      error instanceof Error ? error.message : "Invalid tool arguments"
    );
  }
  const response = await invoke(action);
  if (response.headers.get("X-FeedMind-MCP-Image") === "1" && response.ok) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    const metadata = {
      imageId: response.headers.get("X-FeedMind-Image-Id"),
      imageUrl: decodeURIComponent(response.headers.get("X-FeedMind-Image-Url") ?? ""),
      width: Number(response.headers.get("X-FeedMind-Image-Width")) || null,
      height: Number(response.headers.get("X-FeedMind-Image-Height")) || null,
      instruction: "Use the dimensions of the image you actually see as referenceWidth/referenceHeight when saving coordinates.",
    };
    return rpc(id, {
      content: [
        { type: "image", data: btoa(binary), mimeType: response.headers.get("Content-Type") ?? "image/jpeg" },
        { type: "text", text: JSON.stringify(metadata) },
      ],
      isError: false,
    });
  }
  const raw = await response.text();
  let payload: unknown = raw;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    /* keep text */
  }
  const result: Record<string, unknown> = {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload),
      },
    ],
    isError: !response.ok,
  };
  if (response.status === 401) {
    result._meta = {
      "mcp/www_authenticate": [
        authChallenge(request, "Connect FeedMind to continue"),
      ],
    };
  }
  return rpc(id, result);
}

export async function handleMcpRequest(
  request: Request,
  invoke: InvokeAction
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: {
        Allow: "POST",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
  }
  let message: JsonRpcRequest;
  try {
    message = (await request.json()) as JsonRpcRequest;
  } catch {
    return rpcError(null, -32700, "Parse error");
  }
  if (
    !message ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    return rpcError(message?.id ?? null, -32600, "Invalid Request");
  }
  if (!("id" in message))
    return new Response(null, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  const id = message.id ?? null;
  if (message.method === "initialize") {
    const requested =
      message.params &&
      typeof message.params === "object" &&
      !Array.isArray(message.params)
        ? (message.params as { protocolVersion?: unknown }).protocolVersion
        : undefined;
    const supported = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
    const protocolVersion =
      typeof requested === "string" && supported.has(requested)
        ? requested
        : "2025-06-18";
    return rpc(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: "feedmind",
        title: "FeedMind 阅读助手",
        version: "1.0.0",
      },
      instructions: "用户要求翻译文章时，正文翻译与图片翻译属于同一个不可分割的任务：保存正文译文后必须继续调用 listArticleImages，检查全部静态图片，并为所有含有意义文字的图片保存相同 targetLocale 的翻译；完成图片检查和必要翻译前不得宣告文章翻译完成。处理图片时，阅读 listArticleImages 返回的 articleContext、正文摘录和图片 contextText；翻译必须结合文章语境并保持术语、人名、语气一致，摘录不足时先通过文章正文工具继续分段读取。优先尝试直接访问 imageUrl，只有无法访问时才调用 readArticleImage。仅为静态且含有意义文字的图片保存结果。保存时必须使用模型实际看到的图片宽高作为 referenceWidth/referenceHeight，坐标和字号均使用该基准图片上的像素值。客户端不设置文本对齐或内边距，文本左上角和占用范围必须完全由 x/y/w/h 表达。",
    });
  }
  if (message.method === "ping") return rpc(id, {});
  if (message.method === "tools/list") return rpc(id, { tools: mcpTools });
  if (message.method === "tools/call")
    return callTool(id, message.params, request, invoke);
  return rpcError(id, -32601, "Method not found");
}
