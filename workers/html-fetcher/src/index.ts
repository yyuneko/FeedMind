import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const HTML_ACCEPT =
  "text/html,application/xhtml+xml;q=0.9,application/xml;q=0.2,*/*;q=0.1";
const FEED_ACCEPT =
  "application/rss+xml,application/atom+xml,application/rdf+xml,application/feed+json,application/xml,text/xml;q=0.9,*/*;q=0.1";
const USER_AGENT = "FeedMind-HTML-Fetcher/1.0 (+https://github.com/yyuneko/FeedMind)";
const MAX_REQUEST_BYTES = 4096;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".lan",
  ".home",
  ".internal",
  ".localdomain",
  ".home.arpa",
];

export interface Env {
  FEEDMIND_HTML_WORKER_TOKEN: string;
  HTML_FETCH_TIMEOUT_MS: string;
  MAX_HTML_BYTES: string;
  MAX_REDIRECTS: string;
}

export interface Resolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

export interface RuntimeDependencies {
  fetch: typeof fetch;
  resolver: Resolver;
  log?: (level: "info" | "error", entry: Record<string, unknown>) => void;
}

interface FetchMetrics {
  redirectCount: number;
  upstreamStatus?: number;
  finalHost?: string;
  responseBytes?: number;
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    upstreamStatus?: number;
  };
}

type ContentKind = "html" | "feed";

const ACCEPTED_MEDIA_TYPES: Record<ContentKind, ReadonlySet<string>> = {
  html: new Set(["text/html", "application/xhtml+xml"]),
  feed: new Set([
    "application/rss+xml",
    "application/atom+xml",
    "application/rdf+xml",
    "application/feed+json",
    "application/xml",
    "text/xml",
  ]),
};

class WorkerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

const defaultDependencies: RuntimeDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  resolver: {
    resolve4: (hostname) => dns.resolve4(hostname),
    resolve6: (hostname) => dns.resolve6(hostname),
  },
  log: (level, entry) => {
    if (level === "error") {
      console.error(entry);
    } else {
      console.log(entry);
    }
  },
};

function emitLog(
  dependencies: RuntimeDependencies,
  level: "info" | "error",
  entry: Record<string, unknown>,
): void {
  dependencies.log?.(level, {
    service: "feedmind-content-fetcher",
    ...entry,
  });
}

function securityHeaders(contentType: string): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  return headers;
}

function jsonError(error: WorkerError): Response {
  const body: ErrorBody = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.upstreamStatus === undefined
        ? {}
        : { upstreamStatus: error.upstreamStatus }),
    },
  };
  return new Response(JSON.stringify(body), {
    status: error.status,
    headers: securityHeaders("application/json; charset=utf-8"),
  });
}

function parsePositiveInteger(value: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

function parseIPv4(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  return (
    ((octets[0] << 24) >>> 0) +
    (octets[1] << 16) +
    (octets[2] << 8) +
    octets[3]
  );
}

function ipv4InRange(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function isPublicIPv4(address: string): boolean {
  const value = parseIPv4(address);
  if (value === undefined) return false;
  const blockedRanges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blockedRanges.some(([base, prefix]) =>
    ipv4InRange(value, parseIPv4(base)!, prefix),
  );
}

function parseIPv6(address: string): bigint | undefined {
  if (isIP(address) !== 6) return undefined;
  let input = address.toLowerCase();
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = parseIPv4(input.slice(lastColon + 1));
    if (ipv4 === undefined) return undefined;
    input = `${input.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(
      ipv4 & 0xffff
    ).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8) return undefined;
  let value = 0n;
  for (const group of groups) {
    const parsed = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/.test(group) || parsed > 0xffff) return undefined;
    value = (value << 16n) | BigInt(parsed);
  }
  return value;
}

function ipv6InRange(value: bigint, base: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return value >> shift === base >> shift;
}

function isPublicIPv6(address: string): boolean {
  const value = parseIPv6(address);
  if (value === undefined) return false;
  const globalUnicast = parseIPv6("2000::")!;
  if (!ipv6InRange(value, globalUnicast, 3)) return false;
  const blockedRanges: Array<[string, number]> = [
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
  ];
  return !blockedRanges.some(([base, prefix]) =>
    ipv6InRange(value, parseIPv6(base)!, prefix),
  );
}

function isPublicAddress(address: string): boolean {
  return isIP(address) === 4 ? isPublicIPv4(address) : isPublicIPv6(address);
}

export async function validateTargetURL(
  rawURL: string,
  resolver: Resolver,
): Promise<URL> {
  if (rawURL.length > MAX_REQUEST_BYTES) {
    throw new WorkerError(400, "invalid_url", "Target URL is too long");
  }
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    throw new WorkerError(400, "invalid_url", "Target URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WorkerError(400, "invalid_url", "Only HTTP and HTTPS URLs are allowed");
  }
  if (url.username || url.password) {
    throw new WorkerError(400, "invalid_url", "Target URL must not contain credentials");
  }
  if ((url.protocol === "http:" && url.port && url.port !== "80") ||
      (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new WorkerError(400, "invalid_url", "Only default HTTP and HTTPS ports are allowed");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0) {
    throw new WorkerError(400, "blocked_destination", "IP address targets are not allowed");
  }
  if (
    !hostname.split(".").every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    throw new WorkerError(400, "invalid_url", "Target hostname is invalid");
  }
  if (
    !hostname.includes(".") ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(suffix))
  ) {
    throw new WorkerError(400, "blocked_destination", "Local hostnames are not allowed");
  }

  const results = await Promise.allSettled([
    resolver.resolve4(hostname),
    resolver.resolve6(hostname),
  ]);
  const addresses = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  if (addresses.length === 0) {
    throw new WorkerError(400, "dns_resolution_failed", "Target hostname has no public addresses");
  }
  if (addresses.some((address) => !isPublicAddress(address))) {
    throw new WorkerError(400, "blocked_destination", "Target hostname resolves to a non-public address");
  }
  url.hostname = hostname;
  return url;
}

async function readLimited(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
  tooLarge: WorkerError,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("response size limit exceeded");
        throw tooLarge;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function upstreamErrorCode(status: number): string {
  if (status === 403) return "upstream_forbidden";
  if (status === 404) return "upstream_not_found";
  if (status === 429) return "upstream_rate_limited";
  if (status >= 500) return "upstream_server_error";
  return "unsupported_content_type";
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!secret || !supplied) return false;
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function fetchContent(
  rawURL: string,
  kind: ContentKind,
  env: Env,
  dependencies: RuntimeDependencies,
  metrics: FetchMetrics,
): Promise<Response> {
  const timeoutMs = parsePositiveInteger(env.HTML_FETCH_TIMEOUT_MS, 15_000, 120_000);
  const maxBytes = parsePositiveInteger(env.MAX_HTML_BYTES, 8 << 20, 32 << 20);
  const maxRedirects = parsePositiveInteger(env.MAX_REDIRECTS, 5, 10);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort("target request timed out");
      reject(new WorkerError(504, "upstream_timeout", "Target request timed out"));
    }, timeoutMs);
  });
  let current = rawURL;
  try {
    for (let redirectCount = 0; ; redirectCount++) {
      const url = await Promise.race([
        validateTargetURL(current, dependencies.resolver),
        timeoutFailure,
      ]);
      let response: Response;
      try {
        response = await Promise.race([
          dependencies.fetch(url.toString(), {
            method: "GET",
            redirect: "manual",
            cache: "no-store",
            signal: controller.signal,
            headers: {
              Accept: kind === "html" ? HTML_ACCEPT : FEED_ACCEPT,
              "Accept-Encoding": "identity",
              "User-Agent": USER_AGENT,
            },
          }),
          timeoutFailure,
        ]);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new WorkerError(504, "upstream_timeout", "Target request timed out");
        }
        throw new WorkerError(502, "upstream_fetch_failed", "Unable to fetch target URL");
      }
      metrics.upstreamStatus = response.status;
      metrics.finalHost = url.hostname;

      if (REDIRECT_STATUSES.has(response.status)) {
        metrics.redirectCount++;
        if (redirectCount >= maxRedirects) {
          await response.body?.cancel();
          throw new WorkerError(502, "too_many_redirects", "Target exceeded the redirect limit");
        }
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location) {
          throw new WorkerError(502, "invalid_redirect", "Target redirect is missing a Location header", response.status);
        }
        current = new URL(location, url).toString();
        continue;
      }

      const contentType = response.headers.get("Content-Type") ?? "";
      const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
      if (!ACCEPTED_MEDIA_TYPES[kind].has(mediaType)) {
        await response.body?.cancel();
        throw new WorkerError(
          response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500
            ? response.status
            : 502,
          upstreamErrorCode(response.status),
          `Target returned unsupported Content-Type${contentType ? `: ${contentType}` : ""}`,
          response.status,
        );
      }
      const declaredLength = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel();
        throw new WorkerError(502, "upstream_response_too_large", "Target content exceeds the size limit", response.status);
      }
      let body: Uint8Array;
      try {
        body = await Promise.race([
          readLimited(
            response.body,
            maxBytes,
            new WorkerError(502, "upstream_response_too_large", "Target content exceeds the size limit", response.status),
          ),
          timeoutFailure,
        ]);
      } catch (error) {
        if (error instanceof WorkerError) throw error;
        if (controller.signal.aborted) {
          throw new WorkerError(504, "upstream_timeout", "Target request timed out", response.status);
        }
        throw new WorkerError(502, "upstream_read_failed", "Unable to read target content", response.status);
      }
      const headers = securityHeaders(contentType);
      if (kind === "html") {
        headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
      }
      headers.set("X-FeedMind-Final-URL", url.toString());
      headers.set("X-FeedMind-Upstream-Status", response.status.toString());
      const etag = response.headers.get("ETag");
      if (etag && etag.length <= 1024) headers.set("X-FeedMind-Upstream-ETag", etag);
      const lastModified = response.headers.get("Last-Modified");
      if (lastModified && lastModified.length <= 256) {
        headers.set("X-FeedMind-Upstream-Last-Modified", lastModified);
      }
      const responseBody = new Uint8Array(body.byteLength);
      responseBody.set(body);
      metrics.responseBytes = responseBody.byteLength;
      const responseInit = { status: response.status, headers };
      if (response.status === 204 || response.status === 205 || response.status === 304) {
        return new Response(null, responseInit);
      }
      return new Response(responseBody.buffer, responseInit);
    }
  } finally {
    clearTimeout(timeout!);
  }
}

export function createHandler(dependencies: RuntimeDependencies = defaultDependencies) {
  return async (request: Request, env: Env): Promise<Response> => {
    const correlationID = request.headers.get("X-FeedMind-Request-ID")?.trim();
    const requestID =
      correlationID && /^[A-Za-z0-9._:-]{1,128}$/.test(correlationID)
        ? correlationID
        : (request.headers.get("CF-Ray") ?? crypto.randomUUID());
    const startedAt = Date.now();
    const requestURL = new URL(request.url);
    let kind: ContentKind | undefined;
    let targetHost: string | undefined;
    const metrics: FetchMetrics = { redirectCount: 0 };
    emitLog(dependencies, "info", {
      event: "worker_request_received",
      requestId: requestID,
      method: request.method,
      path: requestURL.pathname,
    });
    try {
      if (requestURL.pathname !== "/html") {
        throw new WorkerError(404, "not_found", "Endpoint not found");
      }
      if (request.method !== "POST") {
        throw new WorkerError(405, "method_not_allowed", "Only POST is allowed");
      }
      if (!(await authorized(request, env.FEEDMIND_HTML_WORKER_TOKEN))) {
        throw new WorkerError(401, "authentication_failed", "Bearer token is invalid or missing");
      }
      const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        throw new WorkerError(415, "unsupported_media_type", "Content-Type must be application/json");
      }
      const declaredLength = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
        throw new WorkerError(413, "request_too_large", "Request body is too large");
      }
      const bytes = await readLimited(
        request.body,
        MAX_REQUEST_BYTES,
        new WorkerError(413, "request_too_large", "Request body is too large"),
      );
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new WorkerError(400, "invalid_request", "Request body must be valid JSON");
      }
      if (
        typeof input !== "object" ||
        input === null ||
        Array.isArray(input) ||
        (Object.keys(input).length !== 1 && Object.keys(input).length !== 2) ||
        Object.keys(input).some((key) => key !== "url" && key !== "kind") ||
        typeof (input as { url?: unknown }).url !== "string" ||
        !(input as { url: string }).url.trim() ||
        ((input as { kind?: unknown }).kind !== undefined &&
          (input as { kind?: unknown }).kind !== "html" &&
          (input as { kind?: unknown }).kind !== "feed")
      ) {
        throw new WorkerError(
          400,
          "invalid_request",
          "Request body must contain only a non-empty url string and kind set to html or feed",
        );
      }
      const typedInput = input as { url: string; kind?: ContentKind };
      kind = typedInput.kind ?? "html";
      try {
        targetHost = new URL(typedInput.url.trim()).hostname.toLowerCase();
      } catch {
        targetHost = undefined;
      }
      emitLog(dependencies, "info", {
        event: "worker_fetch_started",
        requestId: requestID,
        kind,
        targetHost,
      });
      const response = await fetchContent(
        typedInput.url.trim(),
        kind,
        env,
        dependencies,
        metrics,
      );
      response.headers.set("X-FeedMind-Request-ID", requestID);
      emitLog(dependencies, "info", {
        event: "worker_request_completed",
        requestId: requestID,
        outcome: "success",
        kind,
        targetHost,
        finalHost: metrics.finalHost,
        redirectCount: metrics.redirectCount,
        upstreamStatus: metrics.upstreamStatus,
        responseBytes: metrics.responseBytes,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const workerError =
        error instanceof WorkerError
          ? error
          : new WorkerError(500, "internal_error", "Unexpected Worker error");
      emitLog(dependencies, "error", {
        event: "worker_request_completed",
        requestId: requestID,
        outcome: "error",
        errorCode: workerError.code,
        responseStatus: workerError.status,
        kind,
        targetHost,
        finalHost: metrics.finalHost,
        redirectCount: metrics.redirectCount,
        upstreamStatus: workerError.upstreamStatus ?? metrics.upstreamStatus,
        durationMs: Date.now() - startedAt,
      });
      const response = jsonError(workerError);
      response.headers.set("X-FeedMind-Request-ID", requestID);
      return response;
    }
  };
}

const handler = createHandler();

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handler(request, env);
  },
};
