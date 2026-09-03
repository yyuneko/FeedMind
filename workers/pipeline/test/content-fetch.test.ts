import { describe, expect, it, vi } from "vitest";
import { fetchContent, UpstreamHttpError } from "../../shared/src/content-fetch";
import { retryDelay } from "../src/index";

describe("direct content fetch", () => {
  it("follows bounded redirects and reports the final URL", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { Location: "https://example.com/final" } }))
      .mockResolvedValueOnce(new Response("<html>ok</html>", { headers: { "Content-Type": "text/html" } }));
    const result = await fetchContent("http://example.com/start", "html", { fetcher });
    expect(result.finalUrl).toBe("https://example.com/final");
    expect(result.body).toBe("<html>ok</html>");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects unsupported response types", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { headers: { "Content-Type": "application/json" } }));
    await expect(fetchContent("https://example.com/article", "html", { fetcher }))
      .rejects.toThrow("unsupported_content_type");
  });

  it("enforces the response size limit", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("123456", { headers: { "Content-Type": "text/html" } }));
    await expect(fetchContent("https://example.com/article", "html", { fetcher, maximumBytes: 5 }))
      .rejects.toThrow("response_too_large");
  });

  it("preserves Retry-After for rate-limited upstream responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, {
      status: 429,
      headers: { "Retry-After": "120" },
    }));

    const request = fetchContent("https://example.com/feed.xml", "feed", { fetcher });
    await expect(request).rejects.toMatchObject({
      message: "upstream_http_429",
      status: 429,
      retryAfterSeconds: 120,
    });
  });

  it("uses an upstream retry delay when it is longer than exponential backoff", () => {
    expect(retryDelay(1, new UpstreamHttpError(429, 120))).toBe(120);
    expect(retryDelay(1, new UpstreamHttpError(429, null))).toBe(15);
  });
});
