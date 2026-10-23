import { describe, expect, it } from "vitest";
import { extractReadableArticleHtml, sanitizeArticleHtml } from "../../../src/utils/html";

describe("readable article media", () => {
  it("removes source-site layout attributes from images", () => {
    const sanitized = sanitizeArticleHtml(
      `<figure><img class="remote-image" style="height:auto" width="1024" height="0"
        loading="lazy" decoding="async" data-nimg="1" data-src="/cover.jpg"
        srcset="/cover-small.jpg 320w, /cover-large.jpg 1280w" alt="Article cover"></figure>`,
      "https://example.com/posts/demo",
    );

    expect(sanitized).toBe(
      '<figure><img src="https://example.com/cover.jpg" alt="Article cover"></figure>',
    );
  });

  it("restores native video sources that Readability removes", () => {
    const paragraph = "A detailed article paragraph with enough meaningful prose for readability extraction. ".repeat(8);
    const html = `<html><body><article>
      <h1>Feature walkthrough</h1>
      <p>${paragraph}</p>
      <div class="video-wrapper"><video controls>
        <source src="/media/demo.webm" type="video/webm">
        <source src="https://cdn.example.com/demo.mp4" type="video/mp4">
      </video></div>
      <p>${paragraph}</p>
    </article></body></html>`;

    const extracted = extractReadableArticleHtml(html, "https://example.com/posts/demo");

    expect(extracted).toContain("<video>");
    expect(extracted).toContain('<source src="https://example.com/media/demo.webm" type="video/webm">');
    expect(extracted).toContain('<source src="https://cdn.example.com/demo.mp4" type="video/mp4">');
    expect(extracted).not.toContain("FEEDMIND_PRESERVED_MEDIA");
  });
});
