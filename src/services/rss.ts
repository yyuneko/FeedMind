import { XMLParser } from 'fast-xml-parser';
import { articleRepo, feedRepo } from '@/db/repositories';
import type { Article, Feed } from '@/types';
import { serializeFeedCategories } from '@/utils/categories';
import { createArticleId, createLocalId } from '@/utils/id';
import { extractReadableArticleHtml, sanitizeArticleHtml, stripHtml } from '@/utils/html';
import { nowIso } from '@/utils/time';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
});

const pickText = (value: unknown): string => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value && 'text' in value) return pickText((value as { text?: unknown }).text);
  return '';
};

const asArray = <T>(value: T | T[] | undefined): T[] => {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
};

const pickArticleBody = (item: Record<string, unknown>) =>
  pickText(item['content:encoded']) || pickText(item.content) || pickText(item.summary) || pickText(item.description);

export const addFeed = async (input: { url: string; title?: string }, category = '') => {
  const url = input.url.trim();
  const title = input.title?.trim();
  const parsed = await fetchFeed(url);
  const ts = nowIso();
  const feed: Feed = {
    id: await createLocalId(`feed:${url}`),
    title: title || parsed.title || url,
    url,
    siteUrl: parsed.siteUrl || null,
    category: serializeFeedCategories(category),
    createdAt: ts,
    updatedAt: ts,
  };
  await feedRepo.upsert(feed);
  await saveArticles(feed, parsed.items);
  return feed;
};

export const updateFeed = async (input: { id: string; title: string; url: string; category: string }) => {
  const current = await feedRepo.get(input.id);
  if (!current) throw new Error('订阅源不存在');
  const url = input.url.trim();
  const parsed = await fetchFeed(url);
  const feed = {
    ...current,
    title: input.title.trim() || parsed.title || url,
    url,
    siteUrl: parsed.siteUrl || current.siteUrl,
    category: serializeFeedCategories(input.category),
  };
  await feedRepo.update(feed);
  await saveArticles(feed, parsed.items);
  return feed;
};

export const refreshFeed = async (feed: Feed) => {
  const parsed = await fetchFeed(feed.url);
  await saveArticles({ ...feed, title: feed.title || parsed.title, siteUrl: feed.siteUrl || parsed.siteUrl }, parsed.items);
};

export const refreshAllFeeds = async () => {
  const feeds = await feedRepo.list();
  const results = await Promise.allSettled(feeds.map(refreshFeed));
  if (feeds.length && results.every((item) => item.status === 'rejected')) {
    throw new Error('所有 RSS 源刷新失败');
  }
};

export const fetchArticleContentHtml = async (url: string) => {
  const html = await fetchLinkedArticleHtml(url);
  return html;
};

const fetchFeed = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`RSS 拉取失败：${response.status}`);
  const xml = await response.text();
  const data = parser.parse(xml);
  const channel = data.rss?.channel;
  if (channel) {
    return {
      title: pickText(channel.title),
      siteUrl: pickText(channel.link),
      items: asArray<Record<string, unknown>>(channel.item),
    };
  }
  const rdf = data['rdf:RDF'] ?? data.RDF;
  if (rdf?.channel) {
    return {
      title: pickText(rdf.channel.title),
      siteUrl: pickText(rdf.channel.link),
      items: asArray<Record<string, unknown>>(rdf.item),
    };
  }
  const feed = data.feed;
  return {
    title: pickText(feed?.title),
    siteUrl: pickAtomLink(feed?.link),
    items: asArray<Record<string, unknown>>(feed?.entry),
  };
};

const pickAtomLink = (link: unknown) => {
  const links = asArray<Record<string, unknown>>(link as Record<string, unknown> | Record<string, unknown>[] | undefined);
  const alternate = links.find((item) => item.rel === 'alternate') ?? links[0];
  return pickText(alternate?.href ?? alternate);
};

const saveArticles = async (feed: Feed, items: Record<string, unknown>[]) => {
  const ts = nowIso();
  await mapWithLimit(items, 4, async (item) => {
    const title = pickText(item.title) || 'Untitled';
    const url = pickArticleUrl(item);
    const publishedAt = pickText(item.pubDate) || pickText(item.published) || pickText(item.updated) || null;
    const body = pickArticleBody(item);
    const html = body ? sanitizeArticleHtml(body) : (url ? await fetchArticleContentHtml(url) : '') || sanitizeArticleHtml(title);
    const article: Article = {
      id: await createArticleId(feed.url, url, title, publishedAt),
      feedId: feed.id,
      title,
      url,
      author: pickText(item.author) || pickText((item.author as Record<string, unknown> | undefined)?.name) || null,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      contentHtml: html,
      contentText: stripHtml(html),
      isRead: false,
      isStarred: false,
      createdAt: ts,
      updatedAt: ts,
    };
    await articleRepo.upsert(article);
  });
};

const fetchLinkedArticleHtml = async (url: string) => {
  try {
    const response = await fetch(url);
    if (!response.ok) return '';
    const html = await response.text();
    return extractReadableArticleHtml(html);
  } catch {
    return '';
  }
};

const mapWithLimit = async <T>(items: T[], limit: number, mapper: (item: T) => Promise<void>) => {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      await mapper(item);
    }
  });
  await Promise.all(workers);
};

const pickArticleUrl = (item: Record<string, unknown>) => {
  const guid = item.guid;
  const link = item.link;
  if (typeof link === 'string') return link;
  if (link && typeof link === 'object' && 'href' in link) return String((link as { href: unknown }).href);
  if (typeof guid === 'string' && /^https?:/.test(guid)) return guid;
  return null;
};
