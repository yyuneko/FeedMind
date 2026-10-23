import { extractArticleImages, inspectStaticImage, type ArticleImage } from "../../shared/src/article-images";
import type { D1Database, R2Bucket } from "../../shared/src/cloudflare";
import { contentHtmlToText } from "../../shared/src/content-blocks";
import { ApiError, json } from "../../shared/src/http";
import { REQUEST_OWNER } from "../../shared/src/scoped-db";

interface ImageEnv {
  DB: D1Database;
  CONTENT: R2Bucket;
}

type ArticleImageContext = {
  articleId: string;
  sourceHash: string;
  sourceHtmlKey: string;
  canonicalUrl: string;
  title: string;
  summary: string;
  contentText: string;
  images: ArticleImage[];
};

type ImageSegment = {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  bg: string;
  color: string;
  fontSize: number;
};

const locales = new Set(["zh-CN", "en-US", "ja-JP"]);
const hexColor = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu;
const imageAccept = "image/webp,image/png,image/jpeg;q=0.9";
const userAgent = "Mozilla/5.0 (compatible; FeedMind/1.0; +https://github.com/yyuneko/FeedMind)";

function locale(value: unknown): "zh-CN" | "en-US" | "ja-JP" {
  const result = typeof value === "string" && value.trim() ? value.trim() : "zh-CN";
  if (!locales.has(result)) throw new ApiError(422, "validation_failed", "targetLocale must be zh-CN, en-US, or ja-JP");
  return result as "zh-CN" | "en-US" | "ja-JP";
}

async function articleContext(env: ImageEnv, articleId: string): Promise<ArticleImageContext> {
  const article = await env.DB.prepare(`SELECT id, source_hash AS sourceHash, source_html_key AS sourceHtmlKey,
      canonical_url AS canonicalUrl, title, summary FROM articles
    WHERE id = ?1 AND owner_id = ?2 AND parse_status = 'completed'
      AND source_hash IS NOT NULL AND source_html_key IS NOT NULL`)
    .bind(articleId, REQUEST_OWNER)
    .first<{ id: string; sourceHash: string; sourceHtmlKey: string; canonicalUrl: string; title: string; summary: string | null }>();
  if (!article) throw new ApiError(404, "article_images_unavailable", "Article images are not available");
  const object = await env.CONTENT.get(article.sourceHtmlKey);
  if (!object) throw new ApiError(404, "article_images_unavailable", "Article content object is missing");
  const html = await object.text();
  return {
    articleId: article.id,
    sourceHash: article.sourceHash,
    sourceHtmlKey: article.sourceHtmlKey,
    canonicalUrl: article.canonicalUrl,
    title: article.title,
    summary: article.summary ?? "",
    contentText: contentHtmlToText(html),
    images: await extractArticleImages(html, article.canonicalUrl, article.sourceHash),
  };
}

function imageFromContext(context: ArticleImageContext, imageId: string): ArticleImage {
  const image = context.images.find((item) => item.imageId === imageId);
  if (!image) throw new ApiError(404, "image_not_found", "Image is not part of the current article content");
  return image;
}

export async function listArticleImages(env: ImageEnv, articleId: string, requestId: string): Promise<Response> {
  const context = await articleContext(env, articleId);
  const translations = await env.DB.prepare(`SELECT image_id AS imageId, target_locale AS targetLocale
    FROM article_image_translations WHERE owner_id = ?1 AND article_id = ?2 AND source_hash = ?3`)
    .bind(REQUEST_OWNER, articleId, context.sourceHash).all<{ imageId: string; targetLocale: string }>();
  const translated = new Map<string, string[]>();
  for (const row of translations.results ?? []) {
    translated.set(row.imageId, [...(translated.get(row.imageId) ?? []), row.targetLocale]);
  }
  return json({
    data: {
      articleId,
      sourceHash: context.sourceHash,
      articleContext: {
        title: context.title,
        summary: context.summary,
        contentExcerpt: Array.from(context.contentText).slice(0, 6000).join(""),
        contentTruncated: Array.from(context.contentText).length > 6000,
        instruction: "Translate image text in the context of this article. Preserve article terminology, names, tone, and meaning; read more article content when this excerpt is insufficient.",
      },
      images: context.images.map((image) => ({ ...image, translatedLocales: translated.get(image.imageId) ?? [] })),
    },
    requestId,
  }, requestId);
}

function isPrivateHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (value === "localhost" || value.endsWith(".localhost") || value === "::1" || value === "0:0:0:0:0:0:0:1") return true;
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u);
  if (!ipv4) return value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  const [a, b] = ipv4.slice(1).map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function safeImageUrl(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new ApiError(422, "image_unavailable", "Image URL is not eligible for proxying");
  }
  if ((url.protocol === "http:" && url.port && url.port !== "80")
    || (url.protocol === "https:" && url.port && url.port !== "443")) {
    throw new ApiError(422, "image_unavailable", "Image URL uses an unsupported port");
  }
  return url;
}

async function responseBytes(response: Response, maximum = 10 * 1024 * 1024): Promise<Uint8Array> {
  const declared = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) throw new ApiError(413, "image_too_large", "Image exceeds 10 MB");
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel("image too large");
      throw new ApiError(413, "image_too_large", "Image exceeds 10 MB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function fetchImage(imageUrl: string, referer: string): Promise<{ bytes: Uint8Array; mimeType: string; width: number | null; height: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), 15_000);
  let current = imageUrl;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const url = safeImageUrl(current);
      let response: Response;
      try {
        response = await fetch(url, {
          redirect: "manual",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: imageAccept, Referer: referer, "User-Agent": userAgent, "Accept-Encoding": "identity" },
        });
      } catch {
        if (controller.signal.aborted) throw new ApiError(504, "image_fetch_failed", "Image request timed out");
        throw new ApiError(502, "image_fetch_failed", "Image request failed");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("Location");
        await response.body?.cancel();
        if (!location || redirects === 5) throw new ApiError(502, "image_fetch_failed", "Image redirect could not be followed");
        current = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(502, "image_fetch_failed", `Image server returned HTTP ${response.status}`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await responseBytes(response);
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (controller.signal.aborted) throw new ApiError(504, "image_fetch_failed", "Image request timed out");
        throw new ApiError(502, "image_fetch_failed", "Image response could not be read");
      }
      try {
        const info = inspectStaticImage(bytes, response.headers.get("Content-Type") ?? "");
        return { bytes, ...info };
      } catch {
        throw new ApiError(415, "unsupported_image_type", "Only static JPEG, PNG, and WebP images are supported");
      }
    }
    throw new ApiError(502, "image_fetch_failed", "Image redirect could not be followed");
  } finally {
    clearTimeout(timer);
  }
}

export async function readArticleImage(env: ImageEnv, articleId: string, imageId: string): Promise<Response> {
  const context = await articleContext(env, articleId);
  const image = imageFromContext(context, imageId);
  const fetched = await fetchImage(image.imageUrl, context.canonicalUrl);
  const body = new ArrayBuffer(fetched.bytes.byteLength);
  new Uint8Array(body).set(fetched.bytes);
  return new Response(body, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": fetched.mimeType,
      "X-FeedMind-MCP-Image": "1",
      "X-FeedMind-Image-Id": image.imageId,
      "X-FeedMind-Image-Url": encodeURIComponent(image.imageUrl),
      ...(fetched.width ? { "X-FeedMind-Image-Width": String(fetched.width) } : {}),
      ...(fetched.height ? { "X-FeedMind-Image-Height": String(fetched.height) } : {}),
    },
  });
}

function translationPayload(row: Record<string, unknown>) {
  return {
    articleId: row.articleId,
    imageId: row.imageId,
    imageUrl: row.imageUrl,
    targetLocale: row.targetLocale,
    referenceWidth: Number(row.referenceWidth),
    referenceHeight: Number(row.referenceHeight),
    segments: JSON.parse(String(row.segmentsJson ?? "[]")),
    updatedAt: row.updatedAt,
  };
}

export async function getArticleImageTranslation(
  env: ImageEnv,
  articleId: string,
  imageId: string,
  targetLocale: string,
  requestId: string,
): Promise<Response> {
  const context = await articleContext(env, articleId);
  imageFromContext(context, imageId);
  const row = await env.DB.prepare(`SELECT article_id AS articleId, image_id AS imageId, image_url AS imageUrl,
      target_locale AS targetLocale, reference_width AS referenceWidth, reference_height AS referenceHeight,
      segments_json AS segmentsJson, updated_at AS updatedAt
    FROM article_image_translations WHERE owner_id = ?1 AND article_id = ?2 AND source_hash = ?3
      AND image_id = ?4 AND target_locale = ?5`)
    .bind(REQUEST_OWNER, articleId, context.sourceHash, imageId, locale(targetLocale)).first<Record<string, unknown>>();
  if (!row) throw new ApiError(404, "image_translation_not_found", "Image translation was not found");
  return json({ data: translationPayload(row), requestId }, requestId);
}

export function validateReferenceDimension(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 20_000) {
    throw new ApiError(422, "validation_failed", `${key} must be an integer between 1 and 20000`);
  }
  return value;
}

export function validateImageSegments(value: unknown, width: number, height: number): ImageSegment[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new ApiError(422, "validation_failed", "segments must contain between 1 and 200 items");
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(422, "validation_failed", `segments[${index}] must be an object`);
    }
    const input = item as Record<string, unknown>;
    const number = (key: "x" | "y" | "w" | "h" | "fontSize") => {
      const result = input[key];
      if (typeof result !== "number" || !Number.isFinite(result) || result < 0) {
        throw new ApiError(422, "validation_failed", `segments[${index}].${key} must be a non-negative number`);
      }
      return result;
    };
    const x = number("x"); const y = number("y"); const w = number("w"); const h = number("h");
    const fontSize = number("fontSize");
    if (w <= 0 || h <= 0 || fontSize <= 0 || x + w > width || y + h > height) {
      throw new ApiError(422, "validation_failed", `segments[${index}] must fit inside the reference image`);
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 2000) throw new ApiError(422, "validation_failed", `segments[${index}].text is invalid`);
    const bg = typeof input.bg === "string" ? input.bg : "";
    const color = typeof input.color === "string" ? input.color : "";
    if (!hexColor.test(bg) || !hexColor.test(color)) {
      throw new ApiError(422, "validation_failed", `segments[${index}] colors must be hexadecimal`);
    }
    return { x, y, w, h, text, bg, color, fontSize };
  });
}

export async function saveArticleImageTranslation(
  request: Request,
  env: ImageEnv,
  articleId: string,
  imageId: string,
  requestId: string,
): Promise<Response> {
  let input: Record<string, unknown>;
  try { input = await request.json() as Record<string, unknown>; }
  catch { throw new ApiError(400, "invalid_json", "A JSON request body is required"); }
  const context = await articleContext(env, articleId);
  const image = imageFromContext(context, imageId);
  // Validate again at save time so direct model access cannot bypass the static-image policy.
  await fetchImage(image.imageUrl, context.canonicalUrl);
  const targetLocale = locale(input.targetLocale);
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    throw new ApiError(422, "validation_failed", "idempotencyKey must contain between 1 and 128 characters");
  }
  const referenceWidth = validateReferenceDimension(input.referenceWidth, "referenceWidth");
  const referenceHeight = validateReferenceDimension(input.referenceHeight, "referenceHeight");
  const validatedSegments = validateImageSegments(input.segments, referenceWidth, referenceHeight);
  const timestamp = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO article_image_translations
      (owner_id, article_id, source_hash, image_id, image_url, target_locale, reference_width,
       reference_height, segments_json, created_by, idempotency_key, request_id, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'mcp', ?10, ?11, ?12, ?12)
    ON CONFLICT(owner_id, article_id, source_hash, image_id, target_locale) DO UPDATE SET
      image_url = excluded.image_url, reference_width = excluded.reference_width,
      reference_height = excluded.reference_height, segments_json = excluded.segments_json,
      created_by = 'mcp', idempotency_key = excluded.idempotency_key,
      request_id = excluded.request_id, updated_at = excluded.updated_at`)
    .bind(REQUEST_OWNER, articleId, context.sourceHash, imageId, image.imageUrl, targetLocale,
      referenceWidth, referenceHeight, JSON.stringify(validatedSegments), idempotencyKey, requestId, timestamp).run();
  return json({ data: {
    articleId, imageId, imageUrl: image.imageUrl, targetLocale, referenceWidth, referenceHeight,
    segments: validatedSegments, updatedAt: timestamp,
  }, requestId }, requestId, 201);
}

