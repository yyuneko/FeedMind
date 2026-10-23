import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import clientApi from "../../../workers/c-api/src/index";
import adminApi from "../../../workers/admin-api/src/index";
import actionsApi from "../../../workers/gpt-actions-api/src/index";
import readerApi from "../../../workers/reader-api/src/index";
import { runtimeConfig } from "./config";
import { adminEnv, createRuntime } from "./runtime";

const runtime = createRuntime();
const admin = adminEnv(runtime);

function hostname(request: IncomingMessage): string {
  return String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "").split(":", 1)[0].toLowerCase();
}

function webRequest(request: IncomingMessage): Request {
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost");
  const protocol = String(request.headers["x-forwarded-proto"] ?? "https");
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (raw == null) continue;
    if (Array.isArray(raw)) raw.forEach((value) => headers.append(name, value));
    else headers.set(name, raw);
  }
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(`${protocol}://${host}${request.url ?? "/"}`, init);
}

function migrationResponse(): Response {
  return Response.json({ error: { code: "migration_in_progress", message: "FeedMind is temporarily read-only during migration" } }, {
    status: 503, headers: { "Retry-After": "300", "Cache-Control": "no-store" },
  });
}

async function dispatch(request: Request, host: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health/live") return Response.json({ data: { status: "ok" } });
  if (url.pathname === "/health/ready") {
    runtime.database.native.prepare("SELECT 1").get();
    return Response.json({ data: { status: "ready" } });
  }
  if (runtimeConfig.migrationMode !== "normal" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) return migrationResponse();
  if (host === "app.feedmind.cc") {
    if (url.pathname.startsWith("/api/")) url.pathname = url.pathname.slice(4);
    return clientApi.fetch(new Request(url, request), runtime.env as never);
  }
  if (host === "admin.feedmind.cc") {
    if (url.pathname.startsWith("/api/")) url.pathname = url.pathname.slice(4);
    return adminApi.fetch(new Request(url, request), admin as never);
  }
  if (host === "actions.feedmind.cc") return actionsApi.fetch(request, runtime.env as never);
  if (host === "reader.feedmind.cc") return readerApi.fetch(request, runtime.env as never);
  return Response.json({ error: { code: "not_found", message: "Unknown FeedMind host" } }, { status: 404 });
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const response = await dispatch(webRequest(incoming), hostname(incoming));
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    if (!response.body) return void outgoing.end();
    Readable.fromWeb(response.body as never).pipe(outgoing);
  } catch (error) {
    console.error(JSON.stringify({ service: "feedmind-local-api", event: "request_failed",
      error: error instanceof Error ? error.message : String(error) }));
    outgoing.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    outgoing.end(JSON.stringify({ error: { code: "internal_error", message: "Internal server error" } }));
  }
});

server.listen(runtimeConfig.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ service: "feedmind-local-api", event: "listening", port: runtimeConfig.port }));
});
