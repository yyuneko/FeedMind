import { describe, expect, it, vi } from "vitest";
import { googleReaderConnector } from "../src/connectors/google-reader";
import { decryptCredentials, encryptCredentials } from "../../shared/src/credentials";

const context = (fetcher: typeof fetch) => ({
  baseUrl: "https://rss.example/api/greader.php",
  credentials: { username: "alice", password: "api-password" },
  fetcher,
});

function fakeFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/accounts/ClientLogin")) return new Response("SID=x\nAuth=token-1\n", { status: 200 });
    const entry = Object.entries(responses).find(([suffix]) => url.includes(suffix));
    return entry ? Response.json(entry[1]) : new Response("missing", { status: 404 });
  }) as typeof fetch;
}

describe("Google Reader connector", () => {
  it("keeps query parameters outside the endpoint pathname", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/accounts/ClientLogin")) return new Response("SID=x\nAuth=token-1\n", { status: 200 });
      if (url.pathname.endsWith("/reader/api/0/user-info") && url.searchParams.get("output") === "json") {
        return Response.json({ userId: "alice" });
      }
      return new Response("bad request", { status: 400 });
    }) as typeof fetch;

    await expect(googleReaderConnector.testConnection(context(fetcher))).resolves.toEqual(expect.objectContaining({ categories: true }));
    const userInfoUrl = new URL(String(vi.mocked(fetcher).mock.calls[1]?.[0]));
    expect(userInfoUrl.pathname).not.toContain("%3F");
    expect(userInfoUrl.search).toBe("?output=json");
  });

  it("discovers categorized sources and normalizes article state", async () => {
    const fetcher = fakeFetch({
      "subscription/list": { subscriptions: [{ id: "feed/https://example.com/rss", title: "Example", htmlUrl: "https://example.com", categories: [{ label: "Tech" }] }] },
      "stream/contents/reading-list": { items: [{ id: "tag:example,1", title: "Post", author: "Alice", published: 1_700_000_000,
        origin: { streamId: "feed/https://example.com/rss" }, alternate: [{ href: "https://example.com/post" }],
        content: { content: "<p>Full upstream body</p>" }, categories: ["user/-/state/com.google/read", "user/-/state/com.google/starred"] }] },
    });
    await expect(googleReaderConnector.discoverSources(context(fetcher))).resolves.toEqual([expect.objectContaining({
      externalId: "feed/https://example.com/rss", categories: ["Tech"], url: "https://example.com/rss",
    })]);
    const result = await googleReaderConnector.pullItems(context(fetcher), {});
    expect(result.items).toEqual([expect.objectContaining({ externalItemId: "tag:example,1", canonicalUrl: "https://example.com/post",
      upstreamHtml: "<p>Full upstream body</p>", isRead: true, isSaved: true })]);
    expect(result.hasMore).toBe(false);
  });

  it("uses the FreshRSS subscription URL instead of its numeric feed id", async () => {
    const fetcher = fakeFetch({
      "subscription/list": { subscriptions: [{ id: "feed/1", title: "Example", url: "https://example.com/rss", categories: [] }] },
    });
    await expect(googleReaderConnector.discoverSources(context(fetcher))).resolves.toEqual([
      expect.objectContaining({ externalId: "feed/1", url: "https://example.com/rss" }),
    ]);
  });

  it("writes read and saved state through the Google Reader edit-tag API", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/accounts/ClientLogin")) return new Response("SID=x\nAuth=token-1\n");
      if (url.endsWith("/reader/api/0/token")) return new Response("action-token\n");
      if (url.endsWith("/reader/api/0/edit-tag")) {
        requests.push({ url, body: String(init?.body ?? "") });
        return new Response("");
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;
    await googleReaderConnector.pushStates(context(fetcher), [{ externalItemId: "item-1", isRead: true, isSaved: false }]);
    const body = new URLSearchParams(requests[0]?.body);
    expect(body.get("i")).toBe("item-1");
    expect(body.getAll("a")).toContain("user/-/state/com.google/read");
    expect(body.getAll("r")).toContain("user/-/state/com.google/starred");
    expect(body.get("T")).toBe("action-token");
  });

  it("encrypts credentials with authenticated encryption", async () => {
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    const encrypted = await encryptCredentials(key, { username: "alice", password: "secret" });
    expect(encrypted).not.toContain("secret");
    await expect(decryptCredentials(key, encrypted)).resolves.toEqual({ username: "alice", password: "secret" });
    await expect(decryptCredentials(btoa("x".repeat(32)), encrypted)).rejects.toThrow("credentials_decryption_failed");
  });
});
