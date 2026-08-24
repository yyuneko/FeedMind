import { apiRequest } from './client';
import type { Article, ArticleFilter, Feed, Prompt, ThinkingCoachState, ThinkingCoverage, ThinkingEventKind, ThinkingReport, ThinkingSession, ThinkingSessionStatus } from '@/types';

const list = async <T>(path: string) => (await apiRequest<{ items: T[] }>(path)).items;
export type Page<T> = { items: T[]; page: number; pageSize: number; hasMore: boolean; total: number };
const page = <T>(path: string) => apiRequest<Page<T>>(path);
const queryParams = (values: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
export const feedRepo = {
  page: (pageNumber = 1, query = '', pageSize = 20) => page<Feed>(`/subscriptions?${queryParams({ page: pageNumber, pageSize, query: query.trim() })}`),
  list: async () => (await feedRepo.page(1, '', 100)).items,
  async listAll() {
    const items: Feed[] = [];
    let pageNumber = 1;
    let hasMore = true;
    while (hasMore) {
      const result = await feedRepo.page(pageNumber, '', 100);
      items.push(...result.items);
      hasMore = result.hasMore;
      pageNumber += 1;
    }
    return items;
  },
  async get(id: string) { return (await list<Feed>(`/subscriptions/${encodeURIComponent(id)}`))[0] ?? null; },
  async remove(id: string) { await apiRequest(`/subscriptions/${id}`, { method: 'DELETE' }); },
  async update(input: Pick<Feed, 'id' | 'title' | 'category'> & Partial<Feed>) { await apiRequest(`/subscriptions/${input.id}`, { method: 'PATCH', body: JSON.stringify({ title: input.title, category: input.category, sortOrder: 0, enabled: true }) }); },
};
export const articleRepo = {
  add: (input: { url: string; title?: string }) => apiRequest<{ articleId: string; feedId: string; status: string }>('/articles', { method: 'POST', body: JSON.stringify({ URL: input.url, Title: input.title ?? '' }) }),
  page: (filter: ArticleFilter = 'all', category?: string, feedId?: string, query = '', pageNumber = 1, pageSize = 20) => page<Article>(`/articles?${queryParams({ starred: filter === 'starred' || undefined, unread: filter === 'unread' || undefined, feedId, category, query: query.trim(), page: pageNumber, pageSize })}`),
  list: (filter: ArticleFilter = 'all', _category?: string, feedId?: string) => {
    return articleRepo.page(filter, _category, feedId, '', 1, 100).then((result) => result.items);
  },
  async get(id: string) { return (await list<Article>(`/articles/${id}`))[0] ?? null; },
  async search(query: string, filter: ArticleFilter = 'all') { return (await articleRepo.page(filter, undefined, undefined, query, 1, 100)).items; },
  async reparse(id: string) { await apiRequest(`/articles/${id}/reparse`, { method: 'POST' }); },
  async setRead(id: string, isRead: boolean) { const x = await articleRepo.get(id); if (x) await apiRequest(`/articles/${id}/state`, { method: 'PUT', body: JSON.stringify({ isRead, isStarred: x.isStarred, progress: 0, operationID: `${Date.now()}` }) }); },
  async setStarred(id: string, isStarred: boolean) { const x = await articleRepo.get(id); if (x) await apiRequest(`/articles/${id}/state`, { method: 'PUT', body: JSON.stringify({ isRead: x.isRead, isStarred, progress: 0, operationID: `${Date.now()}` }) }); },
};
export const promptRepo = {
  list: () => list<Prompt>('/prompts'),
  async get(id: string) { return (await list<Prompt>('/prompts')).find((x) => x.id === id) ?? null; },
  async save(input: Pick<Prompt, 'name' | 'content' | 'isDefault'> & { id?: string }) { if (input.id) { await apiRequest(`/prompts/${input.id}`, { method: 'PATCH', body: JSON.stringify({ name: input.name, content: input.content }) }); if (input.isDefault) await apiRequest(`/prompts/${input.id}/default`, { method: 'PUT' }); return input.id; } const x = await apiRequest<{ id: string }>('/prompts', { method: 'POST', body: JSON.stringify(input) }); return x.id; },
  async remove(id: string) { await apiRequest(`/prompts/${id}`, { method: 'DELETE' }); },
};

type ThinkingEventInput = { kind: ThinkingEventKind; content: string; metadata?: Record<string, unknown> };
export const thinkingRepo = {
  list: (articleId: string) => list<ThinkingSession>(`/articles/${encodeURIComponent(articleId)}/thinking-sessions`),
  get: (sessionId: string) => apiRequest<ThinkingSession>(`/thinking-sessions/${encodeURIComponent(sessionId)}`),
  create: (articleId: string, articleContentHash: string) => apiRequest<{ session: ThinkingSession; created: boolean }>(`/articles/${encodeURIComponent(articleId)}/thinking-sessions`, {
    method: 'POST', body: JSON.stringify({ articleContentHash }),
  }),
  append(sessionId: string, input: {
    expectedVersion: number;
    operationId: string;
    events: ThinkingEventInput[];
    stage: string;
    completedRounds: number;
    coverage: ThinkingCoverage;
    coachState: ThinkingCoachState;
    report?: ThinkingReport | null;
    status: ThinkingSessionStatus;
  }) {
    return apiRequest<ThinkingSession>(`/thinking-sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST', body: JSON.stringify(input),
    });
  },
  async abandon(sessionId: string, expectedVersion: number) {
    await apiRequest(`/thinking-sessions/${encodeURIComponent(sessionId)}/abandon`, {
      method: 'POST', body: JSON.stringify({ expectedVersion }),
    });
  },
};
