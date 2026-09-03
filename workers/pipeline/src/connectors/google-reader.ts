import type {
  ConnectorCapabilities, ConnectorContext, DiscoveredSource, NormalizedSourceItem,
  PullItemsResult, SourceConnector, StateMutation, SubscriptionMutation,
} from "./types";

const READ = "user/-/state/com.google/read";
const STARRED = "user/-/state/com.google/starred";

function endpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("invalid_connection_url");
  if (base.username || base.password) throw new Error("invalid_connection_url");
  const requested = new URL(path, "https://connector.invalid");
  const normalized = base.pathname.replace(/\/$/, "");
  base.pathname = `${normalized}${requested.pathname}`;
  base.search = requested.search;
  base.hash = "";
  return base;
}

function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

async function auth(context: ConnectorContext): Promise<string> {
  const username = context.credentials.username?.trim();
  const password = context.credentials.password;
  if (!username || !password) throw new Error("credentials_required");
  const response = await (context.fetcher ?? fetch)(endpoint(context.baseUrl, "/accounts/ClientLogin"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: new URLSearchParams({ Email: username, Passwd: password }),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "connection_auth_failed" : `connection_http_${response.status}`);
  const match = (await response.text()).match(/^Auth=(.+)$/m);
  if (!match) throw new Error("connection_auth_invalid");
  return match[1].trim();
}

async function request(context: ConnectorContext, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth(context);
  const response = await (context.fetcher ?? fetch)(endpoint(context.baseUrl, path), {
    ...init,
    headers: { Authorization: `GoogleLogin auth=${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "connection_auth_failed" : `connection_http_${response.status}`);
  return response;
}

async function json(context: ConnectorContext, path: string): Promise<Record<string, unknown>> {
  return object(await (await request(context, path)).json());
}

function alternateUrl(item: Record<string, unknown>): string | null {
  for (const link of array(item.alternate)) {
    const href = string(object(link).href);
    if (href) return href;
  }
  return null;
}

function originStreamId(item: Record<string, unknown>): string {
  const origin = object(item.origin);
  return string(origin.streamId) || string(origin.feedId);
}

function content(item: Record<string, unknown>): string {
  return string(object(item.content).content) || string(object(item.summary).content);
}

function normalizeItem(raw: unknown): NormalizedSourceItem | null {
  const item = object(raw);
  const externalItemId = string(item.id);
  const sourceExternalId = originStreamId(item);
  if (!externalItemId || !sourceExternalId) return null;
  const categories = array(item.categories).map(string);
  const published = Number(item.published ?? 0);
  const updated = Number(item.updated ?? 0);
  return {
    externalItemId,
    sourceExternalId,
    canonicalUrl: alternateUrl(item),
    title: string(item.title),
    author: string(item.author),
    summary: string(object(item.summary).content),
    upstreamHtml: content(item),
    publishedAt: published > 0 ? new Date(published * 1000).toISOString() : null,
    updatedAt: updated > 0 ? new Date(updated * 1000).toISOString() : null,
    isRead: categories.includes(READ),
    isSaved: categories.includes(STARRED),
  };
}

const capabilities: ConnectorCapabilities = { categories: true, incrementalCursor: true, readState: true, writeState: true };

export const googleReaderConnector: SourceConnector = {
  type: "google_reader",
  capabilities,
  async testConnection(context) {
    await json(context, "/reader/api/0/user-info?output=json");
    return capabilities;
  },
  async discoverSources(context): Promise<DiscoveredSource[]> {
    const response = await json(context, "/reader/api/0/subscription/list?output=json");
    return array(response.subscriptions).map((raw) => {
      const value = object(raw);
      const id = string(value.id);
      const idUrl = id.startsWith("feed/") ? id.slice(5) : "";
      return {
        externalId: id,
        kind: "feed" as const,
        title: string(value.title) || id,
        url: string(value.url) || (/^https?:\/\//i.test(idUrl) ? idUrl : null),
        siteUrl: string(value.htmlUrl) || null,
        categories: array(value.categories).map((category) => string(object(category).label)).filter(Boolean),
      };
    }).filter((source) => Boolean(source.externalId));
  },
  async pullItems(context, cursor): Promise<PullItemsResult> {
    const params = new URLSearchParams({ output: "json", n: "1000" });
    const continuation = string(cursor.continuation);
    const newerThan = Number(cursor.newerThan ?? 0);
    if (continuation) params.set("c", continuation);
    else if (newerThan > 0) params.set("ot", String(newerThan));
    const response = await json(context, `/reader/api/0/stream/contents/reading-list?${params}`);
    const items = array(response.items).map(normalizeItem).filter((item): item is NormalizedSourceItem => item !== null);
    const nextContinuation = string(response.continuation);
    const maximumTimestamp = items.reduce((maximum, item) => Math.max(maximum, item.updatedAt ? Math.floor(Date.parse(item.updatedAt) / 1000) : 0), newerThan);
    return {
      items,
      cursor: nextContinuation ? { newerThan, continuation: nextContinuation } : { newerThan: maximumTimestamp },
      hasMore: Boolean(nextContinuation),
    };
  },
  async pullStates(context, externalItemIds) {
    const states = new Map<string, { isRead: boolean; isSaved: boolean }>();
    for (let index = 0; index < externalItemIds.length; index += 50) {
      const ids = externalItemIds.slice(index, index + 50);
      const body = new URLSearchParams();
      ids.forEach((id) => body.append("i", id));
      const response = object(await (await request(context, "/reader/api/0/stream/items/contents?output=json", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body,
      })).json());
      for (const raw of array(response.items)) {
        const item = object(raw); const id = string(item.id); const categories = array(item.categories).map(string);
        if (id) states.set(id, { isRead: categories.includes(READ), isSaved: categories.includes(STARRED) });
      }
    }
    return states;
  },
  async pushStates(context, mutations: StateMutation[]) {
    if (mutations.length === 0) return;
    const token = await (await request(context, "/reader/api/0/token")).text();
    for (const mutation of mutations) {
      const body = new URLSearchParams({ T: token.trim(), i: mutation.externalItemId, async: "true" });
      if (mutation.isRead !== undefined) body.set(mutation.isRead ? "a" : "r", READ);
      if (mutation.isSaved !== undefined) body.append(mutation.isSaved ? "a" : "r", STARRED);
      await request(context, "/reader/api/0/edit-tag", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body,
      });
    }
  },
  async pushSubscriptions(context, mutations: SubscriptionMutation[]) {
    if (mutations.length === 0) return;
    const token = (await (await request(context, "/reader/api/0/token")).text()).trim();
    for (const mutation of mutations) {
      const stream = mutation.action === "subscribe" ? `feed/${mutation.url ?? ""}` : mutation.externalId ?? "";
      if (!stream) throw new Error("subscription_identifier_required");
      const body = new URLSearchParams({ T: token, ac: mutation.action, s: stream });
      if (mutation.title) body.set("t", mutation.title);
      for (const category of mutation.categories ?? []) body.append("a", `user/-/label/${category}`);
      const response = await request(context, "/reader/api/0/subscription/edit", {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body,
      });
      if ((await response.text()).trim() !== "OK") throw new Error("subscription_write_failed");
    }
  },
};
