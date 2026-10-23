import { describe, expect, it, vi } from "vitest";
import { handleMcpRequest, mcpTools } from "../src/mcp";

function rpc(method: string, params?: unknown, headers?: HeadersInit): Request {
  return new Request("https://actions.feedmind.cc/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

describe("FeedMind MCP endpoint", () => {
  it("negotiates the protocol and exposes all public tools", async () => {
    const initialize = await handleMcpRequest(rpc("initialize", { protocolVersion: "2025-06-18" }), vi.fn());
    const initialized = await initialize.json() as { result: { protocolVersion: string; instructions: string; serverInfo: { name: string } } };
    expect(initialized).toMatchObject({ result: { protocolVersion: "2025-06-18",
      serverInfo: { name: "feedmind" } } });
    expect(initialized.result.instructions).toContain("正文翻译与图片翻译属于同一个不可分割的任务");
    const listed = await handleMcpRequest(rpc("tools/list"), vi.fn());
    const payload = await listed.json() as { result: { tools: Array<{ name: string; securitySchemes: unknown[] }> } };
    expect(payload.result.tools).toHaveLength(mcpTools.length);
    const toolNames = payload.result.tools.map((item) => item.name);
    expect(toolNames).toEqual(mcpTools.map((item) => item.name));
    expect(toolNames).not.toContain("retryTranslation");
    expect(toolNames.every((name) => !/delete|remove/i.test(name))).toBe(true);
    expect(payload.result.tools.every((item) => item.securitySchemes.length > 0)).toBe(true);
    expect(mcpTools.find((item) => item.name === "createArticleTranslation")?.description)
      .toContain("图片检查和必要翻译完成前，文章翻译任务不算完成");
  });

  it("maps untranslated article queries to the dedicated read endpoint", async () => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        "https://actions.feedmind.cc/internal/v1/articles/untranslated?targetLocale=zh-CN&page=2&pageSize=10"
      );
      expect(request.method).toBe("GET");
      return Response.json({ items: [], page: 2, pageSize: 10, hasMore: false, total: 0,
        targetLocale: "zh-CN", requestId: "request-1" });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "listUntranslatedArticles",
      arguments: { targetLocale: "zh-CN", page: 2, pageSize: 10 },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean } };
    expect(payload.result.isError).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("maps a tool call to the existing OAuth Action route", async () => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://actions.feedmind.cc/internal/v1/articles?feedId=feed-1&page=2&pageSize=5");
      expect(request.headers.get("Authorization")).toBe("Bearer token");
      return Response.json({ items: [], page: 2, pageSize: 5, hasMore: false, total: 0, requestId: "request-1" });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "searchArticles", arguments: { feedId: "feed-1", page: 2, pageSize: 5 },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
    expect(payload.result.isError).toBe(false);
    expect(JSON.parse(payload.result.content[0].text)).toMatchObject({ requestId: "request-1" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("returns proxied article images as standard MCP image content", async () => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://actions.feedmind.cc/internal/v1/articles/article-1/images/image-1");
      return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: {
        "Content-Type": "image/png",
        "X-FeedMind-MCP-Image": "1",
        "X-FeedMind-Image-Id": "image-1",
        "X-FeedMind-Image-Url": encodeURIComponent("https://example.com/image.png"),
        "X-FeedMind-Image-Width": "640",
        "X-FeedMind-Image-Height": "480",
      } });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "readArticleImage", arguments: { articleId: "article-1", imageId: "image-1" },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean; content: Array<Record<string, unknown>> } };
    expect(payload.result.isError).toBe(false);
    expect(payload.result.content[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "iVBORw==" });
    expect(JSON.parse(String(payload.result.content[1].text))).toMatchObject({
      imageId: "image-1", width: 640, height: 480,
    });
  });

  it("passes a supplied translation directly to the create translation route", async () => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://actions.feedmind.cc/internal/v1/articles/article-1/translations");
      expect(request.method).toBe("POST");
      await expect(request.json()).resolves.toEqual({
        targetLocale: "zh-CN",
        translatedTitle: "译文标题",
        translatedContent: "<p>完整译文</p>",
        promptVersionId: "prompt-1",
        idempotencyKey: "translation-1",
      });
      return Response.json({ data: { id: "translation-1", status: "completed" }, reused: false }, { status: 201 });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "createArticleTranslation",
      arguments: {
        articleId: "article-1",
        targetLocale: "zh-CN",
        translatedTitle: "译文标题",
        translatedContent: "<p>完整译文</p>",
        promptVersionId: "prompt-1",
        idempotencyKey: "translation-1",
      },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean } };
    expect(payload.result.isError).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it.each([
    ["createArticleTitleTranslation", "title-translation", { targetLocale: "zh-CN", translatedTitle: "译文标题", idempotencyKey: "title-1" }],
    ["createArticleSummary", "summary", { targetLocale: "zh-CN", summary: "一句话摘要。", idempotencyKey: "summary-1" }],
  ])("passes %s output directly to its save route", async (name: string, suffix: string, body: Record<string, unknown>) => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe(`https://actions.feedmind.cc/internal/v1/articles/article-1/${suffix}`);
      expect(request.method).toBe("POST");
      await expect(request.json()).resolves.toEqual(body);
      return Response.json({ data: { articleId: "article-1", ...body } }, { status: 201 });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name,
      arguments: { articleId: "article-1", ...body },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean } };
    expect(payload.result.isError).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("reads the classified translation prompt before translation", async () => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        "https://actions.feedmind.cc/internal/v1/articles/article-1/translation-prompt?targetLocale=zh-CN"
      );
      expect(request.method).toBe("GET");
      return Response.json({
        data: {
          articleId: "article-1",
          articleType: "technical",
          targetLocale: "zh-CN",
          promptVersionId: "prompt-1",
          prompt: "请准确翻译技术文章。",
        },
      });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "getArticleTranslationPrompt",
      arguments: { articleId: "article-1", targetLocale: "zh-CN" },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean } };
    expect(payload.result.isError).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("maps the complete assistant-supplied preprocessing flow", async () => {
    const requests: Request[] = [];
    const invoke = vi.fn(async (request: Request) => {
      requests.push(request);
      return Response.json({ data: { articleId: "article-1", status: "completed" } }, { status: request.method === "POST" ? 201 : 200 });
    });
    await handleMcpRequest(rpc("tools/call", {
      name: "getArticlePreprocessingContext", arguments: { articleId: "article-1" },
    }, { Authorization: "Bearer token" }), invoke);
    const result = {
      classification: { articleType: "technical", confidence: 0.9, sourceTitleLocale: "en-US", reason: "Technical article" },
      localizedContent: Object.fromEntries(["zh-CN", "en-US", "ja-JP"].map((locale) => [locale, {
        title: `${locale} title`, summary: `${locale} summary`, keyPoints: ["one", "two", "three"],
      }])),
      informationScore: { total: 80, dimensions: {
        specificity: 80, technicalDetail: 80, practicalExperience: 70, evidence: 70, novelty: 75,
      }, reason: "Useful" },
      tags: ["software", "web-development", "testing"].map((key) => ({
        key, names: { "zh-CN": key, "en-US": key, "ja-JP": key },
      })),
    };
    await handleMcpRequest(rpc("tools/call", {
      name: "createArticlePreprocessing",
      arguments: { articleId: "article-1", contextVersion: "context-1", result, idempotencyKey: "preprocess-1" },
    }, { Authorization: "Bearer token" }), invoke);
    expect(requests[0].url).toBe("https://actions.feedmind.cc/internal/v1/articles/article-1/preprocessing-context");
    expect(requests[0].method).toBe("GET");
    expect(requests[1].url).toBe("https://actions.feedmind.cc/internal/v1/articles/article-1/preprocessing");
    expect(requests[1].method).toBe("POST");
    await expect(requests[1].json()).resolves.toEqual({ contextVersion: "context-1", result, idempotencyKey: "preprocess-1" });
  });

  it("maps non-destructive subscription updates without leaking the path ID into the body", async () => {
    const invoke = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://actions.feedmind.cc/internal/v1/subscriptions/sub-1");
      expect(request.method).toBe("PATCH");
      await expect(request.json()).resolves.toEqual({
        title: "新标题",
        category: "技术",
        sortOrder: 3,
        enabled: false,
        idempotencyKey: "update-subscription-1",
      });
      return Response.json({ data: { id: "sub-1", enabled: false } });
    });
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "updateSubscription",
      arguments: {
        subscriptionId: "sub-1",
        title: "新标题",
        category: "技术",
        sortOrder: 3,
        enabled: false,
        idempotencyKey: "update-subscription-1",
      },
    }, { Authorization: "Bearer token" }), invoke);
    const payload = await response.json() as { result: { isError: boolean } };
    expect(payload.result.isError).toBe(false);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("returns an OAuth challenge when a tool call is unauthenticated", async () => {
    const response = await handleMcpRequest(rpc("tools/call", {
      name: "getArticle", arguments: { articleId: "article-1" },
    }), async () => Response.json({ error: { code: "invalid_access_token" } }, { status: 401 }));
    const payload = await response.json() as { result: { isError: boolean; _meta: Record<string, string[]> } };
    expect(payload.result.isError).toBe(true);
    expect(payload.result._meta["mcp/www_authenticate"][0]).toContain("oauth-protected-resource");
  });
});
