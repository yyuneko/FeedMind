import { describe, expect, it, vi } from "vitest";
import {
  createHandler,
  validateTargetURL,
  type Env,
  type Resolver,
  type RuntimeDependencies,
} from "../src/index";

const env: Env = {
  FEEDMIND_HTML_WORKER_TOKEN: "test-secret-token",
  HTML_FETCH_TIMEOUT_MS: "15000",
  MAX_HTML_BYTES: "1024",
  MAX_REDIRECTS: "5",
};

function resolver(records: Record<string, { v4?: string[]; v6?: string[] }> = {}): Resolver {
  return {
    async resolve4(hostname) {
      const values = records[hostname]?.v4;
      if (!values) throw new Error("ENODATA");
      return values;
    },
    async resolve6(hostname) {
      const values = records[hostname]?.v6;
      if (!values) throw new Error("ENODATA");
      return values;
    },
  };
}

const publicResolver = resolver({
  "news.example.com": { v4: ["93.184.216.34"], v6: ["2606:4700::6810:85e5"] },
  "cdn.example.net": { v4: ["8.8.8.8"] },
  "private.example.com": { v4: ["10.0.0.2"] },
  "private-v6.example.com": { v6: ["fd00::1"] },
});

function request(
  url = "https://news.example.com/article",
  token = env.FEEDMIND_HTML_WORKER_TOKEN,
  kind: "html" | "feed" = "html",
): Request {
  return new Request("https://worker.example/html", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url, kind }),
  });
}

function dependencies(fetchImplementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): RuntimeDependencies {
  return { fetch: fetchImplementation as typeof fetch, resolver: publicResolver };
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

describe("validateTargetURL", () => {
  it("accepts a normal HTTPS URL with only public DNS answers", async () => {
    const result = await validateTargetURL("https://news.example.com/article", publicResolver);
    expect(result.toString()).toBe("https://news.example.com/article");
  });

  it.each([
    "http://localhost/page",
    "http://intranet/page",
    "http://service.local/page",
    "http://127.0.0.1/page",
    "http://[::1]/page",
    "file:///etc/passwd",
    "https://user:password@news.example.com/page",
    "https://news.example.com:8443/page",
  ])("rejects unsafe URL %s", async (value) => {
    await expect(validateTargetURL(value, publicResolver)).rejects.toThrow();
  });

  it("rejects hostnames resolving to private addresses", async () => {
    for (const value of [
      "https://private.example.com/page",
      "https://private-v6.example.com/page",
    ]) {
      await expect(validateTargetURL(value, publicResolver)).rejects.toThrow("non-public");
    }
  });

  it("rejects hostnames without an A or AAAA answer", async () => {
    await expect(
      validateTargetURL("https://missing.example.com/page", publicResolver),
    ).rejects.toThrow("no public addresses");
  });
});

describe("POST /html", () => {
  it("emits structured routing logs without secrets or full URLs", async () => {
    const logs: Array<{ level: string; entry: Record<string, unknown> }> = [];
    const handler = createHandler({
      ...dependencies(async () =>
        new Response("<html>logged</html>", {
          headers: { "Content-Type": "text/html" },
        }),
      ),
      log(level, entry) {
        logs.push({ level, entry });
      },
    });
    const loggedRequest = request(
      "https://news.example.com/private/article?token=do-not-log",
    );
    loggedRequest.headers.set("CF-Ray", "cloudflare-ray-id");
    loggedRequest.headers.set("X-FeedMind-Request-ID", "feedmind-request-id");
    const response = await handler(loggedRequest, env);
    expect(response.headers.get("X-FeedMind-Request-ID")).toBe("feedmind-request-id");
    expect(logs.map(({ entry }) => entry.event)).toEqual([
      "worker_request_received",
      "worker_fetch_started",
      "worker_request_completed",
    ]);
    expect(logs[2]).toMatchObject({
      level: "info",
      entry: {
        requestId: "feedmind-request-id",
        outcome: "success",
        kind: "html",
        targetHost: "news.example.com",
        finalHost: "news.example.com",
        upstreamStatus: 200,
        responseBytes: 19,
      },
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("do-not-log");
    expect(serialized).not.toContain(env.FEEDMIND_HTML_WORKER_TOKEN);
    expect(serialized).not.toContain("/private/article");
  });

  it("ignores an invalid correlation ID", async () => {
    const logs: Array<Record<string, unknown>> = [];
    const handler = createHandler({
      ...dependencies(async () =>
        new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
      ),
      log(_level, entry) {
        logs.push(entry);
      },
    });
    const loggedRequest = request();
    loggedRequest.headers.set("CF-Ray", "safe-ray-id");
    loggedRequest.headers.set("X-FeedMind-Request-ID", "invalid request id");
    const response = await handler(loggedRequest, env);
    expect(response.headers.get("X-FeedMind-Request-ID")).toBe("safe-ray-id");
    expect(logs[0]?.requestId).toBe("safe-ray-id");
  });

  it("rejects missing or incorrect authentication before fetching", async () => {
    const fetcher = vi.fn();
    const response = await createHandler(dependencies(fetcher))(request(undefined, "wrong"), env);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe("authentication_failed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns HTML bytes and upstream metadata without forwarding sensitive headers", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Cookie")).toBeNull();
      expect(headers.get("User-Agent")).toContain("FeedMind-HTML-Fetcher");
      expect(init?.redirect).toBe("manual");
      return new Response("<html>ok</html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });
    const response = await createHandler(dependencies(fetcher))(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-FeedMind-Final-URL")).toBe(
      "https://news.example.com/article",
    );
    expect(response.headers.get("X-FeedMind-Upstream-Status")).toBe("200");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).toBe("<html>ok</html>");
  });

  it("keeps legacy URL-only HTML requests compatible but rejects unknown fields", async () => {
    const handler = createHandler(
      dependencies(async () =>
        new Response("<html>legacy</html>", { headers: { "Content-Type": "text/html" } }),
      ),
    );
    const headers = {
      Authorization: `Bearer ${env.FEEDMIND_HTML_WORKER_TOKEN}`,
      "Content-Type": "application/json",
    };
    const legacy = await handler(
      new Request("https://worker.example/html", {
        method: "POST",
        headers,
        body: JSON.stringify({ url: "https://news.example.com/article" }),
      }),
      env,
    );
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toBe("<html>legacy</html>");

    const unknown = await handler(
      new Request("https://worker.example/html", {
        method: "POST",
        headers,
        body: JSON.stringify({
          url: "https://news.example.com/article",
          headers: { Cookie: "secret" },
        }),
      }),
      env,
    );
    expect(unknown.status).toBe(400);
    expect(await errorCode(unknown)).toBe("invalid_request");
  });

  it("fetches RSS/Atom/XML only in feed mode and preserves validators", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Accept")).toContain("application/rss+xml");
      expect(headers.get("If-None-Match")).toBeNull();
      expect(headers.get("If-Modified-Since")).toBeNull();
      return new Response('<rss version="2.0"></rss>', {
        status: 200,
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          ETag: '"feed-v2"',
          "Last-Modified": "Wed, 15 Jul 2026 00:00:00 GMT",
        },
      });
    });
    const response = await createHandler(dependencies(fetcher))(
      request("https://news.example.com/feed.xml", undefined, "feed"),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-FeedMind-Upstream-ETag")).toBe('"feed-v2"');
    expect(response.headers.get("X-FeedMind-Upstream-Last-Modified")).toBe(
      "Wed, 15 Jul 2026 00:00:00 GMT",
    );
    expect(await response.text()).toBe('<rss version="2.0"></rss>');
  });

  it("does not accept HTML when the request declares feed mode", async () => {
    const response = await createHandler(
      dependencies(async () =>
        new Response("<html></html>", { headers: { "Content-Type": "text/html" } }),
      ),
    )(request("https://news.example.com/feed", undefined, "feed"), env);
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("unsupported_content_type");
  });

  it("revalidates every hostname in a cross-domain redirect", async () => {
    const resolved: string[] = [];
    const recordingResolver: Resolver = {
      async resolve4(hostname) {
        resolved.push(hostname);
        return hostname === "news.example.com" ? ["93.184.216.34"] : ["8.8.8.8"];
      },
      async resolve6() {
        throw new Error("ENODATA");
      },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: "https://cdn.example.net/final" } }),
      )
      .mockResolvedValueOnce(
        new Response("<html>final</html>", { headers: { "Content-Type": "text/html" } }),
      );
    const response = await createHandler({ fetch: fetcher as typeof fetch, resolver: recordingResolver })(
      request(),
      env,
    );
    expect(response.status).toBe(200);
    expect(resolved).toEqual(["news.example.com", "cdn.example.net"]);
    expect(response.headers.get("X-FeedMind-Final-URL")).toBe("https://cdn.example.net/final");
  });

  it("blocks a redirect to a private destination", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(null, { status: 301, headers: { Location: "https://private.example.com/secret" } }),
    );
    const response = await createHandler(dependencies(fetcher))(request(), env);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("blocked_destination");
  });

  it("enforces the redirect limit", async () => {
    const fetcher = vi.fn(async () =>
      new Response(null, { status: 302, headers: { Location: "/again" } }),
    );
    const response = await createHandler(dependencies(fetcher))(
      request(),
      { ...env, MAX_REDIRECTS: "2" },
    );
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("too_many_redirects");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("cancels a streaming response as soon as the size limit is exceeded", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = vi.fn(async () =>
      new Response(body, { headers: { "Content-Type": "text/html" } }),
    );
    const response = await createHandler(dependencies(fetcher))(
      request(),
      { ...env, MAX_HTML_BYTES: "10" },
    );
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("upstream_response_too_large");
    expect(cancelled).toBe(true);
  });

  it("reads a streaming HTML response without Content-Length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<html>"));
        controller.enqueue(new TextEncoder().encode("stream</html>"));
        controller.close();
      },
    });
    const response = await createHandler(
      dependencies(async () => new Response(body, { headers: { "Content-Type": "text/html" } })),
    )(request(), env);
    expect(await response.text()).toBe("<html>stream</html>");
  });

  it("aborts a target request when the total timeout expires", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    );
    const response = await createHandler(dependencies(fetcher))(
      request(),
      { ...env, HTML_FETCH_TIMEOUT_MS: "5" },
    );
    expect(response.status).toBe(504);
    expect(await errorCode(response)).toBe("upstream_timeout");
  });

  it("rejects non-HTML responses with an explicit error", async () => {
    const response = await createHandler(
      dependencies(async () =>
        new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    )(request(), env);
    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("unsupported_content_type");
  });

  it.each([403, 404, 429, 500, 503])("preserves HTML upstream status %d", async (status) => {
    const response = await createHandler(
      dependencies(async () =>
        new Response(`<html>${status}</html>`, {
          status,
          headers: { "Content-Type": "text/html" },
        }),
      ),
    )(request(), env);
    expect(response.status).toBe(status);
    expect(response.headers.get("X-FeedMind-Upstream-Status")).toBe(String(status));
    expect(await response.text()).toBe(`<html>${status}</html>`);
  });

  it.each([
    [403, "upstream_forbidden"],
    [404, "upstream_not_found"],
    [429, "upstream_rate_limited"],
    [503, "upstream_server_error"],
  ])("distinguishes non-HTML upstream status %d", async (status, code) => {
    const response = await createHandler(
      dependencies(async () =>
        new Response("failure", { status, headers: { "Content-Type": "text/plain" } }),
      ),
    )(request(), env);
    expect(response.status).toBe(status);
    expect(await errorCode(response)).toBe(code);
  });
});
