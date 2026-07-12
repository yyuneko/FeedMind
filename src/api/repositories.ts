import { apiRequest } from './client';
import type { Article, ArticleFilter, Feed, Prompt } from '@/types';

const list = async <T>(path: string) => (await apiRequest<{ items: T[] }>(path)).items;
export const feedRepo = {
  list: () => list<Feed>('/subscriptions'),
  async get(id: string) { return (await list<Feed>('/subscriptions')).find((x) => x.id === id) ?? null; },
  async remove(id: string) { await apiRequest(`/subscriptions/${id}`, { method: 'DELETE' }); },
  async update(input: Pick<Feed, 'id' | 'title' | 'category'> & Partial<Feed>) { await apiRequest(`/subscriptions/${input.id}`, { method: 'PATCH', body: JSON.stringify({ title: input.title, category: input.category, sortOrder: 0, enabled: true }) }); },
};
export const articleRepo = {
  list: (filter: ArticleFilter = 'all', _category?: string, _feedId?: string) => list<Article>(`/articles?${filter === 'starred' ? 'starred=true' : filter === 'unread' ? 'unread=true' : ''}`),
  async get(id: string) { return (await list<Article>(`/articles/${id}`))[0] ?? null; },
  async search(query: string) { const items = await list<Article>('/articles'); const q = query.toLocaleLowerCase(); return items.filter((x) => x.title.toLocaleLowerCase().includes(q) || x.contentText?.toLocaleLowerCase().includes(q)); },
  async setRead(id: string, isRead: boolean) { const x = await articleRepo.get(id); if (x) await apiRequest(`/articles/${id}/state`, { method: 'PUT', body: JSON.stringify({ isRead, isStarred: x.isStarred, progress: 0, operationID: `${Date.now()}` }) }); },
  async setStarred(id: string, isStarred: boolean) { const x = await articleRepo.get(id); if (x) await apiRequest(`/articles/${id}/state`, { method: 'PUT', body: JSON.stringify({ isRead: x.isRead, isStarred, progress: 0, operationID: `${Date.now()}` }) }); },
};
export const promptRepo = {
  list: () => list<Prompt>('/prompts'),
  async get(id: string) { return (await list<Prompt>('/prompts')).find((x) => x.id === id) ?? null; },
  async save(input: Pick<Prompt, 'name' | 'content' | 'isDefault'> & { id?: string }) { if (input.id) { await apiRequest(`/prompts/${input.id}`, { method: 'PATCH', body: JSON.stringify({ name: input.name, content: input.content }) }); if (input.isDefault) await apiRequest(`/prompts/${input.id}/default`, { method: 'PUT' }); return input.id; } const x = await apiRequest<{ id: string }>('/prompts', { method: 'POST', body: JSON.stringify(input) }); return x.id; },
  async remove(id: string) { await apiRequest(`/prompts/${id}`, { method: 'DELETE' }); },
};
