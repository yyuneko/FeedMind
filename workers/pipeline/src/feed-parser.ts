import { XMLParser } from "fast-xml-parser";
import { parseHTML } from "linkedom";

export interface ParsedFeed {
  title: string;
  siteUrl: string;
  description: string;
  items: ParsedFeedItem[];
}

export interface ParsedFeedItem {
  externalId: string;
  url: string;
  title: string;
  author: string;
  summary: string;
  publishedAt: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  // Escaped HTML in ordinary RSS descriptions can easily exceed the library's
  // default 1,000 entity-expansion limit. Keep a finite ceiling for untrusted
  // feeds while allowing realistic full-text feeds such as lethain.com.
  processEntities: {
    maxTotalExpansions: 10_000,
    maxExpandedLength: 1_000_000,
  },
});

function array<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return text(record["#text"] ?? record["#cdata"] ?? record.value ?? record.name);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
}

function decodedText(value: unknown): string {
  const candidate = text(value);
  if (!candidate || !/&(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);/iu.test(candidate)) return candidate;
  try {
    const escapedMarkup = candidate.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return (parseHTML(`<html><body>${escapedMarkup}</body></html>`).document.body.textContent ?? candidate).trim();
  } catch {
    return candidate;
  }
}

function firstDecodedText(...values: unknown[]): string {
  for (const value of values) {
    const candidate = decodedText(value);
    if (candidate) return candidate;
  }
  return "";
}

function httpUrl(value: unknown, baseUrl: string): string {
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const resolved = httpUrl(candidate, baseUrl);
      if (resolved) return resolved;
    }
    return "";
  }
  const candidate = text(value);
  if (!candidate) return "";
  try {
    const url = new URL(candidate, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function date(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  const parsed = new Date(candidate);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function atomLink(value: unknown, baseUrl: string, preferredRel = "alternate"): string {
  const links = array(value as Record<string, unknown> | Record<string, unknown>[]);
  const preferred = links.find((link) => (text(link?.["@rel"]) || "alternate") === preferredRel);
  const selected = preferred ?? links.find((link) => !text(link?.["@rel"]) || text(link?.["@rel"]) === "alternate") ?? links[0];
  return httpUrl(selected?.["@href"] ?? selected, baseUrl);
}

function author(value: unknown): string {
  if (Array.isArray(value)) return value.map(author).filter(Boolean).join(", ");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstText(record.name, record["#text"]);
  }
  return text(value);
}

function parseJsonFeed(source: string, baseUrl: string): ParsedFeed {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(source) as Record<string, unknown>;
  } catch {
    throw new Error("Feed is not valid JSON");
  }
  if (!Array.isArray(root.items)) throw new Error("JSON Feed does not contain items");
  return {
    title: decodedText(root.title),
    siteUrl: httpUrl(root.home_page_url, baseUrl),
    description: text(root.description),
    items: root.items.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const url = httpUrl(item.url ?? item.external_url, baseUrl);
      return {
        externalId: firstText(item.id, url),
        url,
        title: firstDecodedText(item.title, "Untitled"),
        author: author(item.authors ?? item.author),
        summary: firstText(item.summary, item.content_text, item.content_html),
        publishedAt: date(item.date_published ?? item.date_modified),
      };
    }).filter((item) => Boolean(item.url)),
  };
}

function parseXmlFeed(source: string, baseUrl: string): ParsedFeed {
  let document: Record<string, unknown>;
  try {
    document = parser.parse(source) as Record<string, unknown>;
  } catch {
    throw new Error("Feed is not valid XML");
  }
  const rss = (document.rss as Record<string, unknown> | undefined)?.channel as Record<string, unknown> | undefined;
  if (rss) {
    return {
      title: decodedText(rss.title),
      siteUrl: httpUrl(rss.link, baseUrl),
      description: text(rss.description),
      items: array(rss.item as Record<string, unknown> | Record<string, unknown>[]).map((item) => {
        const url = httpUrl(item.link ?? item.guid, baseUrl);
        return {
          externalId: firstText(item.guid, url),
          url,
          title: firstDecodedText(item.title, "Untitled"),
          author: firstText(item.creator, item.author),
          summary: firstText(item.description, item.encoded),
          publishedAt: date(item.pubDate ?? item.date),
        };
      }).filter((item) => Boolean(item.url)),
    };
  }
  const atom = document.feed as Record<string, unknown> | undefined;
  if (atom) {
    return {
      title: decodedText(atom.title),
      siteUrl: atomLink(atom.link, baseUrl),
      description: firstText(atom.subtitle, atom.tagline),
      items: array(atom.entry as Record<string, unknown> | Record<string, unknown>[]).map((item) => {
        const url = atomLink(item.link, baseUrl);
        return {
          externalId: firstText(item.id, url),
          url,
          title: firstDecodedText(item.title, "Untitled"),
          author: author(item.author),
          summary: firstText(item.summary, item.content),
          publishedAt: date(item.published ?? item.updated),
        };
      }).filter((item) => Boolean(item.url)),
    };
  }
  const rdf = (document.RDF ?? document.rdf) as Record<string, unknown> | undefined;
  if (rdf) {
    return {
      title: decodedText((rdf.channel as Record<string, unknown> | undefined)?.title),
      siteUrl: httpUrl((rdf.channel as Record<string, unknown> | undefined)?.link, baseUrl),
      description: text((rdf.channel as Record<string, unknown> | undefined)?.description),
      items: array(rdf.item as Record<string, unknown> | Record<string, unknown>[]).map((item) => {
        const url = httpUrl(item.link ?? item["@about"], baseUrl);
        return {
          externalId: firstText(item["@about"], url),
          url,
          title: firstDecodedText(item.title, "Untitled"),
          author: firstText(item.creator),
          summary: firstText(item.description, item.encoded),
          publishedAt: date(item.date),
        };
      }).filter((item) => Boolean(item.url)),
    };
  }
  throw new Error("Unsupported feed format");
}

export function parseFeed(source: string, contentType: string, baseUrl: string): ParsedFeed {
  const trimmed = source.trimStart();
  return contentType.toLowerCase().includes("json") || trimmed.startsWith("{")
    ? parseJsonFeed(source, baseUrl)
    : parseXmlFeed(source, baseUrl);
}
