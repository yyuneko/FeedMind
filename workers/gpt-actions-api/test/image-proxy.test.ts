import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchImage } from "../src/image-translations";

function png(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.buffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("article image proxy", () => {
  it("sends FeedMind headers and accepts a signed static image", async () => {
    const mockedFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Referer")).toBe("https://example.com/article");
      expect(headers.get("User-Agent")).toContain("FeedMind");
      expect(headers.get("Accept")).toContain("image/webp");
      expect(init?.redirect).toBe("manual");
      return new Response(png(320, 200), { headers: { "Content-Type": "image/png" } });
    });
    vi.stubGlobal("fetch", mockedFetch);
    await expect(fetchImage("https://cdn.example.com/image.png", "https://example.com/article"))
      .resolves.toMatchObject({ mimeType: "image/png", width: 320, height: 200 });
  });

  it("rejects redirects to private addresses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302, headers: { Location: "http://127.0.0.1/private.png" },
    })));
    await expect(fetchImage("https://example.com/image.png", "https://example.com/article"))
      .rejects.toMatchObject({ code: "image_unavailable" });
  });

  it("rejects declared responses larger than 10 MB", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(png(1, 1), { headers: {
      "Content-Type": "image/png", "Content-Length": String(10 * 1024 * 1024 + 1),
    } })));
    await expect(fetchImage("https://example.com/image.png", "https://example.com/article"))
      .rejects.toMatchObject({ code: "image_too_large" });
  });

  it("aborts image requests after 15 seconds", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })));
    const pending = fetchImage("https://example.com/image.png", "https://example.com/article");
    const rejection = expect(pending).rejects.toMatchObject({ code: "image_fetch_failed", status: 504 });
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;
  });
});
