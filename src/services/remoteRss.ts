import { apiRequest } from '@/api/client';
import { feedRepo } from '@/api/repositories';
import type { Feed } from '@/types';
export const addFeed = async (input: { url: string; title?: string }, category = '') => apiRequest<{ feedId: string }>('/subscriptions', { method: 'POST', body: JSON.stringify({ URL: input.url, Title: input.title ?? '', Category: category }) });
export const updateFeed = async (input: { id: string; title: string; url: string; category: string }) => { await feedRepo.update({ ...input, siteUrl: null, createdAt: '', updatedAt: '' }); return input as unknown as Feed; };
export const refreshFeed = async (feed: Feed) => apiRequest(`/subscriptions/${feed.id}/refresh`, { method: 'POST' });
export const refreshFeedTitle = async (feed: Feed) => apiRequest(`/subscriptions/${feed.id}/refresh-title`, { method: 'POST' });
export const refreshAllFeeds = async () => { const feeds = await feedRepo.list(); await Promise.all(feeds.map(refreshFeed)); };
export const isOpmlUrl = (url: string) => /\.(opml|opnl)(?:$|[?#])/i.test(url);
export const importFeedsFromOpmlUrl = async (url: string, category: string, onProgress?: (value: OpmlImportProgress) => void): Promise<{ imported: number; failed: number }> => {
  onProgress?.({ total: 0, done: 0, imported: 0, failed: 0 });
  const result = await apiRequest<{ total: number; imported: number; failed: number }>('/opml/import', { method: 'POST', body: JSON.stringify({ url: url.trim(), category: category.trim() }) });
  onProgress?.({ total: result.total, done: result.total, imported: result.imported, failed: result.failed });
  return { imported: result.imported, failed: result.failed };
};
export type OpmlImportProgress = { total: number; done: number; imported: number; failed: number; currentTitle?: string };
