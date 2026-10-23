import { requireAccessIdentity, type AccessIdentity } from "./auth";
import { ApiError, errorResponse, json, preflight, requestId, withCors } from "./http";
import type { D1Database } from "./cloudflare";
import { resolveAccount } from "./accounts";

export interface AccessApiEnv {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  ALLOWED_ORIGIN: string;
  DB?: D1Database;
  MIGRATION_MODE?: string;
}

type AccessKind = "client" | "admin";
export type AccessRouteHandler<E extends AccessApiEnv> = (
  request: Request,
  env: E,
  requestId: string,
  identity: AccessIdentity,
  accountId?: string,
) => Promise<Response | undefined>;

function accessPayload(kind: AccessKind, identity: AccessIdentity, id: string, accountId?: string): unknown {
  return kind === "client"
    ? { data: { ownerId: accountId, identity: { email: identity.email } }, requestId: id }
    : { data: { identity: { subject: identity.subject, email: identity.email } }, requestId: id };
}

export function createAccessApiHandler<E extends AccessApiEnv>(
  kind: AccessKind,
  route?: AccessRouteHandler<E>,
) {
  return async (request: Request, env: E): Promise<Response> => {
    const id = requestId(request);
    try {
      const optionsResponse = preflight(request, env.ALLOWED_ORIGIN);
      if (optionsResponse) {
        optionsResponse.headers.set("X-FeedMind-Request-ID", id);
        return optionsResponse;
      }
      const url = new URL(request.url);
      if (url.pathname !== "/health" && (env.MIGRATION_MODE === "paused" || (env.MIGRATION_MODE === "read_only" &&
          (!(["GET", "HEAD", "OPTIONS"].includes(request.method)) || url.pathname === "/oauth/authorize")))) {
        const response = json({ error: { code: "migration_in_progress", message: "FeedMind is temporarily read-only during migration" }, requestId: id }, id, 503);
        response.headers.set("Retry-After", "300");
        return withCors(response, request, env.ALLOWED_ORIGIN);
      }
      if (url.pathname === "/health" && request.method === "GET") {
        return withCors(json({ data: { status: "ok", service: `${kind}-api` }, requestId: id }, id), request, env.ALLOWED_ORIGIN);
      }
      const identity = await requireAccessIdentity(request, {
        teamDomain: env.ACCESS_TEAM_DOMAIN,
        audience: env.ACCESS_AUDIENCE,
      });
      const accountId = kind === "client" && env.DB ? await resolveAccount(env.DB, identity) : undefined;
      if ((url.pathname === "/v1/session" || (kind === "client" && url.pathname === "/v1/me")) && request.method === "GET") {
        return withCors(json(accessPayload(kind, identity, id, accountId), id), request, env.ALLOWED_ORIGIN);
      }
      const routed = await route?.(request, env, id, identity, accountId);
      if (!routed) throw new ApiError(404, "not_found", "Endpoint not found");
      return withCors(routed, request, env.ALLOWED_ORIGIN);
    } catch (error) {
      return withCors(errorResponse(error, id), request, env.ALLOWED_ORIGIN);
    }
  };
}
