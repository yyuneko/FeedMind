export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function requestId(request: Request): string {
  const candidate = request.headers.get("X-FeedMind-Request-ID")?.trim();
  if (candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) return candidate;
  return request.headers.get("CF-Ray")?.trim() || crypto.randomUUID();
}

function baseHeaders(id: string): Headers {
  return new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-FeedMind-Request-ID": id,
  });
}

export function json(data: unknown, id: string, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: baseHeaders(id) });
}

export function errorResponse(error: unknown, id: string): Response {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    messages.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  const databaseQuotaExceeded = messages.some((message) =>
    /(?:\b7500\b|exceeded D1(?:'s)? .*daily row (?:read|write) limit|D1.*daily.*limit)/iu.test(message)
  );
  const apiError =
    error instanceof ApiError
      ? error
      : databaseQuotaExceeded
      ? new ApiError(503, "database_quota_exceeded", "Database capacity is temporarily exhausted; please try again after the daily reset")
      : new ApiError(500, "internal_error", "Unexpected server error");
  if (!(error instanceof ApiError)) {
    console.error("Unhandled API error", { requestId: id, error: messages.join(" <- ") });
  }
  const body: ApiErrorBody = {
    error: { code: apiError.code, message: apiError.message },
    requestId: id,
  };
  return json(body, id, apiError.status);
}

export function withCors(response: Response, request: Request, allowedOrigin: string): Response {
  const origin = request.headers.get("Origin");
  if (!origin || origin !== allowedOrigin) return response;
  response.headers.set("Access-Control-Allow-Origin", origin);
  response.headers.set("Access-Control-Allow-Credentials", "true");
  response.headers.set("Vary", "Origin");
  return response;
}

export function preflight(request: Request, allowedOrigin: string): Response | undefined {
  if (request.method !== "OPTIONS") return undefined;
  const origin = request.headers.get("Origin");
  if (origin !== allowedOrigin) {
    throw new ApiError(403, "origin_not_allowed", "Origin is not allowed");
  }
  const headers = new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key, X-FeedMind-Request-ID",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  return new Response(null, { status: 204, headers });
}
