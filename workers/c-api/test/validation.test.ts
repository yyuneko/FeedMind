import { describe, expect, it } from "vitest";
import { contentWindow, normalizeHttpUrl, pagination, sliceCodePoints } from "../src/validation";

describe("C API request validation", () => {
  it("normalizes safe HTTP URLs deterministically", () => {
    expect(normalizeHttpUrl(" HTTPS://Example.COM:443/feed#section ")).toBe("https://example.com/feed");
  });

  it.each(["file:///etc/passwd", "https://user:pass@example.com/feed", "not a url"])(
    "rejects invalid external URL %s",
    (value: string) => expect(() => normalizeHttpUrl(value)).toThrow(),
  );

  it("enforces pagination limits", () => {
    expect(pagination(new URL("https://api.example/v1/articles?page=2&pageSize=100"))).toEqual({
      page: 2,
      pageSize: 100,
      offset: 100,
    });
    expect(() => pagination(new URL("https://api.example/v1/articles?pageSize=101"))).toThrow();
  });

  it("enforces bounded content windows", () => {
    expect(contentWindow(new URL("https://api.example/content?cursor=3&limit=50000"))).toEqual({ cursor: 3, limit: 50_000 });
    expect(() => contentWindow(new URL("https://api.example/content?limit=50001"))).toThrow();
  });

  it("slices Unicode by code point without splitting surrogate pairs", () => {
    expect(sliceCodePoints("甲🙂乙丙", 1, 2)).toEqual({
      content: "🙂乙",
      nextCursor: 3,
      totalCharacters: 4,
    });
  });
});
