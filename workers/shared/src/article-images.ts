/// <reference lib="dom" />
import { parseHTML } from "linkedom";

export type ArticleImage = {
  imageId: string;
  imageUrl: string;
  alt: string;
  contextText: string;
  declaredWidth: number | null;
  declaredHeight: number | null;
  formatHint: "jpeg" | "png" | "webp" | "unknown";
};

function normalizedText(element: Element | null, maximum = 1200): string {
  return (element?.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function imageContext(element: Element): string {
  const figure = element.closest("figure");
  const candidates = [
    normalizedText(figure?.querySelector("figcaption") ?? null),
    normalizedText(element.parentElement?.tagName.toLowerCase() === "body" ? null : element.parentElement),
    normalizedText(element.previousElementSibling),
    normalizedText(element.nextElementSibling),
  ].filter(Boolean);
  return Array.from(new Set(candidates)).join(" ").slice(0, 1200);
}

const animatedExtension = /\.(?:gif|apng)(?:$|[?#])/iu;

function positiveInteger(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sourceUrl(element: Element): string {
  const srcset = element.getAttribute("srcset") || element.getAttribute("data-srcset");
  const srcsetCandidates = (srcset ?? "").split(",")
    .map((candidate) => candidate.trim().split(/\s+/u)[0])
    .filter(Boolean);
  return element.getAttribute("data-src")
    || element.getAttribute("data-original")
    || srcsetCandidates.at(-1)
    || element.getAttribute("src")
    || "";
}

function resolveImageUrl(value: string, baseUrl: string): string | null {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (base.protocol === "https:" && url.protocol === "http:" && url.hostname === base.hostname) {
      url.protocol = "https:";
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    if ((url.protocol === "http:" && url.port && url.port !== "80")
      || (url.protocol === "https:" && url.port && url.port !== "443")) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function formatHint(url: string): ArticleImage["formatHint"] {
  const pathname = new URL(url).pathname.toLowerCase();
  if (/\.jpe?g$/u.test(pathname)) return "jpeg";
  if (/\.png$/u.test(pathname)) return "png";
  if (/\.webp$/u.test(pathname)) return "webp";
  return "unknown";
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function extractArticleImages(html: string, baseUrl: string, sourceHash: string): Promise<ArticleImage[]> {
  const { document } = parseHTML(`<body>${html}</body>`);
  const seen = new Set<string>();
  const images: ArticleImage[] = [];
  for (const element of Array.from(document.querySelectorAll("img"))) {
    const resolved = resolveImageUrl(sourceUrl(element), baseUrl);
    if (!resolved || seen.has(resolved) || animatedExtension.test(resolved)) continue;
    const declaredWidth = positiveInteger(element.getAttribute("width"));
    const declaredHeight = positiveInteger(element.getAttribute("height"));
    if ((declaredWidth !== null && declaredWidth < 32) || (declaredHeight !== null && declaredHeight < 32)) continue;
    seen.add(resolved);
    images.push({
      imageId: await digest(`${sourceHash}\n${resolved}`),
      imageUrl: resolved,
      alt: (element.getAttribute("alt") ?? "").trim().slice(0, 1000),
      contextText: imageContext(element),
      declaredWidth,
      declaredHeight,
      formatHint: formatHint(resolved),
    });
  }
  return images;
}

export type StaticImageInfo = {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number | null;
  height: number | null;
};

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));
const u16be = (bytes: Uint8Array, offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
const u24le = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
const u32be = (bytes: Uint8Array, offset: number) =>
  ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue; }
    const length = u16be(bytes, offset + 2);
    if (length < 2 || offset + length + 2 > bytes.length) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += length + 2;
  }
  return null;
}

export function inspectStaticImage(bytes: Uint8Array, contentType: string): StaticImageInfo {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")) {
    throw new Error("unsupported_image_type");
  }
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG" && ascii(bytes, 12, 4) === "IHDR") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = u32be(bytes, offset);
      const type = ascii(bytes, offset + 4, 4);
      if (type === "acTL") throw new Error("unsupported_image_type");
      if (length > bytes.length || offset + length + 12 > bytes.length) break;
      offset += length + 12;
    }
    if (mediaType !== "image/png") throw new Error("unsupported_image_type");
    return { mimeType: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    if (mediaType !== "image/jpeg" && mediaType !== "image/jpg") throw new Error("unsupported_image_type");
    const dimensions = jpegDimensions(bytes);
    return { mimeType: "image/jpeg", width: dimensions?.width ?? null, height: dimensions?.height ?? null };
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8X" && (bytes[20] & 0x02) !== 0) throw new Error("unsupported_image_type");
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunkKind = ascii(bytes, offset, 4);
      const chunkLength = (bytes[offset + 4] | (bytes[offset + 5] << 8)
        | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
      if (chunkKind === "ANIM" || chunkKind === "ANMF") throw new Error("unsupported_image_type");
      if (chunkLength > bytes.length || offset + 8 + chunkLength > bytes.length) break;
      offset += 8 + chunkLength + (chunkLength % 2);
    }
    if (mediaType !== "image/webp") throw new Error("unsupported_image_type");
    let width: number | null = null;
    let height: number | null = null;
    if (kind === "VP8X") {
      width = u24le(bytes, 24) + 1;
      height = u24le(bytes, 27) + 1;
    }
    return { mimeType: "image/webp", width, height };
  }
  throw new Error("unsupported_image_type");
}

