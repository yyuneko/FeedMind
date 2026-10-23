import { describe, expect, it } from "vitest";
import { extractArticleImages, inspectStaticImage } from "../../shared/src/article-images";

function png(width: number, height: number, animated = false): Uint8Array {
  const bytes = new Uint8Array(animated ? 53 : 33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  if (animated) bytes.set([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c], 33);
  return bytes;
}

describe("article image discovery", () => {
  it("resolves lazy and srcset URLs, removes duplicates, and filters animation and trackers", async () => {
    const images = await extractArticleImages(`
      <figure><img src="placeholder.gif" data-src="../hero.png" alt="Hero" width="800" height="600"><figcaption>Architecture overview for the article workflow.</figcaption></figure>
      <img srcset="small.jpg 320w, /large.webp 1280w" alt="Large">
      <img src="../hero.png">
      <img src="pixel.png" width="1" height="1">
      <img src="animated.gif" width="640" height="480">
    `, "https://example.com/articles/post", "source-a");
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.imageUrl)).toEqual([
      "https://example.com/hero.png",
      "https://example.com/large.webp",
    ]);
    expect(images[0]).toMatchObject({
      alt: "Hero",
      contextText: "Architecture overview for the article workflow.",
      declaredWidth: 800,
      declaredHeight: 600,
      formatHint: "png",
    });
  });

  it("changes the stable image ID when the article source changes", async () => {
    const first = await extractArticleImages('<img src="/image.png">', "https://example.com/a", "source-a");
    const second = await extractArticleImages('<img src="/image.png">', "https://example.com/a", "source-b");
    expect(first[0].imageId).not.toBe(second[0].imageId);
  });
});

describe("static image validation", () => {
  it("accepts static PNG and reads its dimensions", () => {
    expect(inspectStaticImage(png(640, 480), "image/png")).toEqual({
      mimeType: "image/png", width: 640, height: 480,
    });
  });

  it("rejects APNG, GIF, and forged MIME", () => {
    expect(() => inspectStaticImage(png(640, 480, true), "image/png")).toThrow("unsupported_image_type");
    expect(() => inspectStaticImage(new TextEncoder().encode("GIF89a........"), "image/gif")).toThrow("unsupported_image_type");
    expect(() => inspectStaticImage(png(640, 480), "text/html")).toThrow("unsupported_image_type");
  });

  it("rejects animated WebP", () => {
    const bytes = new Uint8Array(30);
    bytes.set(new TextEncoder().encode("RIFF"), 0);
    bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
    bytes[20] = 0x02;
    expect(() => inspectStaticImage(bytes, "image/webp")).toThrow("unsupported_image_type");
  });
});
