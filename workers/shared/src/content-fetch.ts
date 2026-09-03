export type ContentKind = "feed" | "html";

export interface FetchedContent {
  status: number;
  body: string;
  contentType: string;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
}

export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`upstream_http_${status}`);
    this.name = "UpstreamHttpError";
  }
}

const ACCEPT: Record<ContentKind, string> = {
  html: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  feed: "application/rss+xml,application/atom+xml,application/rdf+xml,application/feed+json,application/xml,text/xml;q=0.9,*/*;q=0.1",
};
const MEDIA_TYPES: Record<ContentKind, ReadonlySet<string>> = {
  html: new Set(["text/html", "application/xhtml+xml"]),
  feed: new Set(["application/rss+xml", "application/atom+xml", "application/rdf+xml", "application/feed+json", "application/xml", "text/xml"]),
};
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "Mozilla/5.0 (compatible; FeedMind/1.0; +https://github.com/yyuneko/FeedMind)";

function retryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = /^\d+$/.test(value.trim())
    ? Number.parseInt(value, 10)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(43_200, Math.max(1, seconds));
}

function targetUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_url");
  if (url.username || url.password) throw new Error("invalid_url");
  if ((url.protocol === "http:" && url.port && url.port !== "80")
    || (url.protocol === "https:" && url.port && url.port !== "443")) throw new Error("invalid_url");
  return url;
}

async function limitedText(response: Response, maximum: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) throw new Error("response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel("response size limit exceeded");
      throw new Error("response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function fetchContent(
  rawUrl: string,
  kind: ContentKind,
  options: {
    timeoutMs?: number;
    maximumBytes?: number;
    maximumRedirects?: number;
    conditionalHeaders?: { ifNoneMatch?: string; ifModifiedSince?: string };
    fetcher?: typeof fetch;
  } = {},
): Promise<FetchedContent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("request timed out"), options.timeoutMs ?? 15_000);
  const fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
  let current = rawUrl;
  try {
    for (let redirects = 0; ; redirects++) {
      const url = targetUrl(current);
      let response: Response;
      try {
        response = await fetcher(url, {
          method: "GET",
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            Accept: ACCEPT[kind],
            "Accept-Encoding": "identity",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": USER_AGENT,
            ...(kind === "feed" && options.conditionalHeaders?.ifNoneMatch
              ? { "If-None-Match": options.conditionalHeaders.ifNoneMatch } : {}),
            ...(kind === "feed" && options.conditionalHeaders?.ifModifiedSince
              ? { "If-Modified-Since": options.conditionalHeaders.ifModifiedSince } : {}),
          },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("request_timeout");
        throw error;
      }
      if (REDIRECTS.has(response.status)) {
        if (redirects >= (options.maximumRedirects ?? 5)) throw new Error("too_many_redirects");
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location) throw new Error("invalid_redirect");
        current = new URL(location, url).toString();
        continue;
      }
      if (kind === "feed" && response.status === 304) {
        return { status: 304, body: "", contentType: "", etag: response.headers.get("ETag"), lastModified: response.headers.get("Last-Modified"), finalUrl: url.toString() };
      }
      if (!response.ok) {
        const retryAfter = retryAfterSeconds(response.headers.get("Retry-After"));
        await response.body?.cancel();
        throw new UpstreamHttpError(response.status, retryAfter);
      }
      const contentType = response.headers.get("Content-Type") ?? "";
      const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
      if (!MEDIA_TYPES[kind].has(mediaType)) {
        await response.body?.cancel();
        throw new Error(`unsupported_content_type: ${contentType || "missing"}`);
      }
      return {
        status: response.status,
        body: await limitedText(response, options.maximumBytes ?? 8 << 20),
        contentType,
        etag: response.headers.get("ETag"),
        lastModified: response.headers.get("Last-Modified"),
        finalUrl: url.toString(),
      };
    }
  } finally {
    clearTimeout(timeout);
  }
}
