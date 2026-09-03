import { describe, expect, it } from "vitest";
import { parseFeed } from "../src/feed-parser";

describe("feed parser", () => {
  it("parses RSS and resolves relative article links", () => {
    const parsed = parseFeed(`<?xml version="1.0"?>
      <rss version="2.0"><channel><title>工程周刊</title><link>https://example.com/</link>
      <description>摘要</description><item><guid>post-1</guid><title>第一篇</title>
      <link>/posts/1#comments</link><dc:creator>作者</dc:creator><pubDate>Mon, 24 Aug 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[文章摘要]]></description></item></channel></rss>`, "application/rss+xml", "https://example.com/feed.xml");
    expect(parsed).toMatchObject({ title: "工程周刊", siteUrl: "https://example.com/" });
    expect(parsed.items[0]).toEqual({
      externalId: "post-1",
      url: "https://example.com/posts/1",
      title: "第一篇",
      author: "作者",
      summary: "文章摘要",
      publishedAt: "2026-08-24T10:00:00.000Z",
    });
  });

  it("parses Atom alternate links", () => {
    const parsed = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Feed</title>
      <link rel="alternate" href="https://example.net/"/><entry><id>tag:example,1</id><title>Entry</title>
      <link rel="alternate" href="https://example.net/entry"/><author><name>Alice</name></author>
      <updated>2026-08-24T12:00:00Z</updated><summary>Summary</summary></entry></feed>`,
    "application/atom+xml", "https://example.net/feed");
    expect(parsed.items[0]).toMatchObject({ url: "https://example.net/entry", author: "Alice" });
  });

  it("parses RSS descriptions containing more than 1,000 escaped HTML entities", () => {
    const escapedHtml = "&lt;p&gt;内容&lt;/p&gt;".repeat(300);
    const parsed = parseFeed(`<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
      <channel><title>Full-text feed</title><link>https://example.com/</link>
      <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
      <item><guid>entity-heavy</guid><title>Entity-heavy entry</title>
      <link>https://example.com/entity-heavy</link><description>${escapedHtml}</description></item>
      </channel></rss>`, "application/rss+xml", "https://example.com/feed.xml");

    expect(parsed.siteUrl).toBe("https://example.com/");
    expect(parsed.items[0].summary).toBe("<p>内容</p>".repeat(300));
  });

  it("parses JSON Feed and skips entries without HTTP URLs", () => {
    const parsed = parseFeed(JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JSON Feed",
      home_page_url: "https://json.example/",
      items: [
        { id: "one", url: "https://json.example/one", title: "One", authors: [{ name: "Bob" }] },
        { id: "local-only", title: "No URL" },
      ],
    }), "application/feed+json", "https://json.example/feed.json");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ externalId: "one", author: "Bob" });
  });

  it("decodes HTML character references in feed and article titles", () => {
    const parsed = parseFeed(JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Research &amp; Development",
      home_page_url: "https://json.example/",
      items: [{ id: "one", url: "https://json.example/one", title: "Why it doesn&apos;t work &mdash; yet" }],
    }), "application/feed+json", "https://json.example/feed.json");

    expect(parsed.title).toBe("Research & Development");
    expect(parsed.items[0]?.title).toBe("Why it doesn't work — yet");
  });
});
