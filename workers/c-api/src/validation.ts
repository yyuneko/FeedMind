import { ApiError } from "../../shared/src/http";

export interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

export function pagination(url: URL): Pagination {
  const page = integerParameter(url.searchParams.get("page"), 1, 1, 10_000, "page");
  const pageSize = integerParameter(url.searchParams.get("pageSize"), 20, 1, 100, "pageSize");
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function contentWindow(url: URL): { cursor: number; limit: number } {
  return {
    cursor: integerParameter(url.searchParams.get("cursor"), 0, 0, 20_000_000, "cursor"),
    limit: integerParameter(url.searchParams.get("limit"), 20_000, 1, 50_000, "limit"),
  };
}

export function sliceCodePoints(
  value: string,
  cursor: number,
  limit: number,
): { content: string; nextCursor: number | null; totalCharacters: number } {
  let characterIndex = 0;
  let codeUnitIndex = 0;
  let startCodeUnit: number | undefined;
  let endCodeUnit: number | undefined;
  for (const character of value) {
    if (characterIndex === cursor) startCodeUnit = codeUnitIndex;
    if (characterIndex === cursor + limit) endCodeUnit = codeUnitIndex;
    characterIndex++;
    codeUnitIndex += character.length;
  }
  if (cursor > characterIndex) throw new ApiError(416, "cursor_out_of_range", "Content cursor is outside the object");
  startCodeUnit ??= codeUnitIndex;
  endCodeUnit ??= codeUnitIndex;
  const consumed = Math.min(limit, characterIndex - cursor);
  return {
    content: value.slice(startCodeUnit, endCodeUnit),
    nextCursor: cursor + consumed < characterIndex ? cursor + consumed : null,
    totalCharacters: characterIndex,
  };
}

function integerParameter(
  raw: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ApiError(422, "validation_failed", `${field} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(422, "validation_failed", `${field} is outside the allowed range`);
  }
  return value;
}

export function normalizeHttpUrl(raw: unknown, field = "url"): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 4096) {
    throw new ApiError(422, "validation_failed", `${field} is required`);
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ApiError(422, "validation_failed", `${field} must be a valid URL`);
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new ApiError(422, "validation_failed", `${field} must be an HTTP or HTTPS URL without credentials`);
  }
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  return url.toString();
}

export async function readJsonObject(request: Request, maximumBytes = 32_768): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new ApiError(413, "request_too_large", "Request body is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function stringField(value: unknown, field: string, maximum: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(422, "validation_failed", `${field} is required`);
    return "";
  }
  if (typeof value !== "string" || value.length > maximum) {
    throw new ApiError(422, "validation_failed", `${field} must be a string of at most ${maximum} characters`);
  }
  const result = value.trim();
  if (required && !result) throw new ApiError(422, "validation_failed", `${field} is required`);
  return result;
}
