import { describe, expect, it } from "vitest";
import { listArticleImages } from "../src/image-translations";

describe("image translation article context", () => {
  it("returns article-level and image-adjacent context with the image list", async () => {
    const DB = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          async first() {
            return sql.includes("FROM articles") ? {
              id: "article-1",
              sourceHash: "source-1",
              sourceHtmlKey: "articles/article-1/source.html",
              canonicalUrl: "https://example.com/article",
              title: "Deployment architecture",
              summary: "How the service routes image translation requests.",
            } : null;
          },
          async all() { return { success: true, results: [] }; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return statement;
      },
      async batch() { return []; },
    };
    const CONTENT = {
      async get() {
        return {
          async text() {
            return '<p>The proxy preserves article terminology.</p><figure><img src="/diagram.png"><figcaption>Request routing diagram</figcaption></figure>';
          },
        };
      },
    };
    const response = await listArticleImages({ DB, CONTENT } as never, "article-1", "request-1");
    const payload = await response.json() as {
      data: { articleContext: { title: string; summary: string; contentExcerpt: string }; images: Array<{ contextText: string }> };
    };
    expect(payload.data.articleContext).toMatchObject({
      title: "Deployment architecture",
      summary: "How the service routes image translation requests.",
    });
    expect(payload.data.articleContext.contentExcerpt).toContain("proxy preserves article terminology");
    expect(payload.data.images[0].contextText).toBe("Request routing diagram");
  });
});
