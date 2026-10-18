import type { D1Database } from "../../shared/src/cloudflare";
import { ApiError, json } from "../../shared/src/http";
import { readJsonObject, stringField } from "./validation";
import { REQUEST_OWNER } from "../../shared/src/scoped-db";

interface Env { DB: D1Database }
const OWNER = REQUEST_OWNER;
const timestamp = () => new Date().toISOString();

function number(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new ApiError(422, "validation_failed", `${field} is invalid`);
  return value;
}

function parseJson(value: unknown, fallback: unknown): unknown {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function preferences(row: { settingsJson?: string } | null) {
  const stored = parseJson(row?.settingsJson, {}) as Record<string, unknown>;
  return {
    languageMode: stored.languageMode ?? "system", themeMode: stored.themeMode ?? "system",
    fontSize: Number(stored.fontSize ?? 17), lineHeightRatio: Number(stored.lineHeightRatio ?? 1.7), version: Number(stored.version ?? 1),
  };
}

async function preferencesRoute(request: Request, env: Env, requestId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT settings_json AS settingsJson FROM preferences WHERE owner_id = ?1").bind(OWNER).first<{ settingsJson: string }>();
  const current = preferences(row);
  if (request.method === "GET") return json({ items: [current], requestId }, requestId);
  const input = await readJsonObject(request);
  const expectedVersion = number(input.Version, "Version", 1, Number.MAX_SAFE_INTEGER);
  if (current.version !== expectedVersion) throw new ApiError(409, "version_conflict", "Preferences were changed by another client");
  const languageMode = stringField(input.LanguageMode, "LanguageMode", 20, true);
  const themeMode = stringField(input.ThemeMode, "ThemeMode", 20, true);
  if (!['system','zh','en','ja'].includes(languageMode) || !['system','light','dark'].includes(themeMode)) throw new ApiError(422, "validation_failed", "Preference enum is invalid");
  const next = { languageMode, themeMode, fontSize: number(input.FontSize, "FontSize", 10, 42),
    lineHeightRatio: number(input.LineHeightRatio, "LineHeightRatio", 1, 3), version: current.version + 1 };
  await env.DB.prepare(`INSERT INTO preferences (owner_id, locale, target_locale, settings_json, updated_at)
    VALUES (?1, ?2, 'zh-CN', ?3, ?4) ON CONFLICT(owner_id) DO UPDATE SET locale = excluded.locale,
    settings_json = excluded.settings_json, updated_at = excluded.updated_at`).bind(OWNER, languageMode, JSON.stringify(next), timestamp()).run();
  return json({ items: [next], requestId }, requestId);
}

export async function routeClientState(request: Request, env: Env, requestId: string): Promise<Response | undefined> {
  const path = new URL(request.url).pathname;
  if (path === '/v1/preferences' && (request.method === 'GET' || request.method === 'PATCH')) return preferencesRoute(request, env, requestId);
  return undefined;
}
