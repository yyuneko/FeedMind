import { apiRequest } from './client';
import { getLocale } from '@/i18n';
import type { Article, ArticleFilter, ArticleListCriteria, ArticleTagOption, Feed, LibraryTree, ReaderCredential, Source, SourceConnection, SourceSelection, SourceSwitchJob } from '@/types';
import type { TranslationBlockResult } from '@/utils/translationHtml';

const list = async <T>(path: string) => (await apiRequest<{ items: T[] }>(path)).items;
export type Page<T> = { items: T[]; page: number; pageSize: number; hasMore: boolean; total: number };
const page = <T>(path: string) => apiRequest<Page<T>>(path);
const queryParams = (values: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)])).toString();
const titleTargetLocale = () => ({ zh: 'zh-CN', en: 'en-US', ja: 'ja-JP' } as const)[getLocale()];
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
export const connectionRepo = {
  list: () => list<SourceConnection>('/connections'),
  create: (input: { name: string; baseUrl: string; username: string; password: string }) => apiRequest<{ data: SourceConnection }>('/connections', {
    method: 'POST', body: JSON.stringify({ type: 'google_reader', name: input.name, baseUrl: input.baseUrl,
      credentials: { username: input.username, password: input.password }, syncPolicy: 'bidirectional' }),
  }).then((response) => response.data),
  test: (id: string) => apiRequest(`/connections/${encodeURIComponent(id)}/test`, { method: 'POST', body: JSON.stringify({}) }),
  sync: (id: string) => apiRequest(`/connections/${encodeURIComponent(id)}/sync`, { method: 'POST', body: JSON.stringify({}) }),
  remove: (id: string) => apiRequest(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
export const sourceSelectionRepo = {
  get: () => apiRequest<{ data: SourceSelection }>('/source-selection').then((response) => response.data),
  select: (connectionId: string, migrateToTarget: boolean) => apiRequest<{ data: { connectionId: string; revision: number; jobId: string | null } }>('/source-selection', {
    method: 'PUT', body: JSON.stringify({ connectionId, migrateToTarget }),
  }).then((response) => response.data),
  job: (id: string) => apiRequest<{ data: SourceSwitchJob }>(`/source-switch-jobs/${encodeURIComponent(id)}`).then((response) => response.data),
  retry: (id: string) => apiRequest(`/source-switch-jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({}) }),
};
export const readerCredentialRepo = {
  list: () => apiRequest<{ items: ReaderCredential[]; loginName: string }>('/reader-credentials'),
  create: (name: string) => apiRequest<{ data: ReaderCredential & { appPassword: string } }>('/reader-credentials', {
    method: 'POST', body: JSON.stringify({ name }),
  }).then((response) => response.data),
  remove: (id: string) => apiRequest(`/reader-credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
export const sourceRepo = {
  list: (connectionId = '') => list<Source>(`/sources?${queryParams({ connectionId })}`),
  update: (id: string, enabled: boolean, categories: string[]) => apiRequest(`/sources/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify({ enabled, categories }),
  }),
};
const collectionParams = (criteria: ArticleListCriteria) => ({
  scope: criteria.collection.kind === 'recent' || criteria.collection.kind === 'saved' ? criteria.collection.kind : 'all',
  excludeSelected: criteria.collection.kind === 'all' || undefined,
  categoryId: criteria.collection.kind === 'category' ? criteria.collection.categoryId : undefined,
  feedId: criteria.collection.kind === 'feed' ? criteria.collection.sourceId : undefined,
  unread: criteria.unreadOnly || undefined,
  tag: criteria.tagKey,
  query: criteria.query.trim(),
});

export const libraryRepo = {
  tree: async () => (await apiRequest<{ data: LibraryTree }>('/library/tree')).data,
  createCategory: (name: string) => apiRequest('/library/categories', { method: 'POST', body: JSON.stringify({ name }) }),
  updateCategory: (id: string, patch: { name?: string; sortOrder?: number }) => apiRequest(`/library/categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeCategory: (id: string) => apiRequest(`/library/categories/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  updateFeed: (id: string, patch: { customTitle?: string; categoryId?: string | null; sortOrder?: number; enabled?: boolean; url?: string }) => apiRequest(`/library/feeds/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeFeed: (id: string) => apiRequest(`/library/feeds/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
export const articleRepo = {
  add: (input: { url: string; title?: string }) => apiRequest<{ articleId: string; feedId: string; status: string }>('/articles', { method: 'POST', body: JSON.stringify({ URL: input.url, Title: input.title ?? '' }) }),
  remove: (id: string) => apiRequest(`/articles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  page: (filter: ArticleFilter = 'all', category?: string, feedId?: string, query = '', pageNumber = 1, pageSize = 20, tag?: string, minInformationScore?: number) => page<Article>(`/articles?${queryParams({ starred: filter === 'starred' || undefined, unread: filter === 'unread' || undefined, feedId, category, query: query.trim(), tag, minInformationScore, targetLocale: titleTargetLocale(), page: pageNumber, pageSize })}`),
  pageCollection: (criteria: ArticleListCriteria, pageNumber = 1, pageSize = 100) => page<Article>(`/articles?${queryParams({ ...collectionParams(criteria), targetLocale: titleTargetLocale(), page: pageNumber, pageSize })}`),
  tags: (criteria: ArticleListCriteria, tagQuery = '', pageNumber = 1, pageSize = 50) => page<ArticleTagOption>(`/article-tags?${queryParams({ ...collectionParams({ ...criteria, tagKey: undefined }), tagQuery, targetLocale: titleTargetLocale(), page: pageNumber, pageSize })}`),
  tag: (tagKey: string) => apiRequest<{ data: ArticleTagOption }>(`/article-tags/${encodeURIComponent(tagKey)}?${queryParams({ targetLocale: titleTargetLocale() })}`).then((response) => response.data),
  list: (filter: ArticleFilter = 'all', _category?: string, feedId?: string) => {
    return articleRepo.page(filter, _category, feedId, '', 1, 100).then((result) => result.items);
  },
  async get(id: string) {
    const item = (await list<Article & { contentAvailable?: boolean }>(`/articles/${id}?${queryParams({ targetLocale: titleTargetLocale() })}`))[0] ?? null;
    if (!item?.contentAvailable) return item;
    const read = async (format: 'html' | 'text') => {
      let cursor = 0; let content = '';
      for (;;) {
        const response = await apiRequest<{ data: { content: string; nextCursor: number | null } }>(`/articles/${encodeURIComponent(id)}/content?format=${format}&cursor=${cursor}&limit=50000`);
        content += response.data.content;
        if (response.data.nextCursor == null) return content;
        cursor = response.data.nextCursor;
      }
    };
    const [contentHtml, contentText] = await Promise.all([read('html'), read('text')]);
    return { ...item, contentHtml, contentText };
  },
  async search(query: string, filter: ArticleFilter = 'all') { return (await articleRepo.page(filter, undefined, undefined, query, 1, 100)).items; },
  async setRead(id: string, isRead: boolean) { const x = await articleRepo.get(id); if (x) await apiRequest(`/articles/${id}/state`, { method: 'PUT', body: JSON.stringify({ isRead, isStarred: x.isStarred, progress: x.progress ?? 0, operationId: `${Date.now()}-${Math.random()}` }) }); },
  async setStarred(id: string, isStarred: boolean) { const x = await articleRepo.get(id); if (x) await apiRequest(`/articles/${id}/state`, { method: 'PUT', body: JSON.stringify({ isRead: x.isRead, isStarred, progress: x.progress ?? 0, operationId: `${Date.now()}-${Math.random()}` }) }); },
  readingActivity: (id: string, input: { operationId: string; sessionId: string; kind: 'engaged' | 'progress'; progress: number }) => apiRequest<{ data: { articleId: string; isRead: boolean; isStarred: boolean; progress: number; lastOpenedAt: string | null } }>(`/articles/${encodeURIComponent(id)}/reading-activity`, { method: 'POST', body: JSON.stringify(input) }),
};
export type RemoteTranslation = {
  id: string;
  articleId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancel_requested' | 'cancelled' | 'superseded';
  translatedTitle?: string;
  retryCount: number;
  content: string;
  partialBlocks: TranslationBlockResult[];
  error?: string;
};

async function translationContent(id: string): Promise<{ content: string; partialBlocks: TranslationBlockResult[] }> {
  let cursor = 0; let content = '';
  for (;;) {
    const response = await apiRequest<{ data: { content: string; partialBlocks?: TranslationBlockResult[]; nextCursor: number | null } }>(`/translations/${encodeURIComponent(id)}/content?cursor=${cursor}&limit=50000`);
    if (response.data.partialBlocks) return { content: '', partialBlocks: response.data.partialBlocks };
    content += response.data.content;
    if (response.data.nextCursor == null) return { content, partialBlocks: [] };
    cursor = response.data.nextCursor;
  }
}

export const translationRepo = {
  async get(articleId: string): Promise<RemoteTranslation | null> {
    const response = await apiRequest<{ items: Omit<RemoteTranslation, 'content' | 'partialBlocks'>[] }>(`/articles/${encodeURIComponent(articleId)}/translations?targetLocale=zh-CN`);
    const item = response.items.find((entry) => entry.status === 'completed')
      ?? response.items.find((entry) => ['pending','running','cancel_requested'].includes(entry.status))
      ?? response.items[0];
    if (!item) return null;
    return { ...item, ...await translationContent(item.id) };
  },
  async start(articleId: string): Promise<RemoteTranslation> {
    const response = await apiRequest<{ data: Omit<RemoteTranslation, 'content' | 'partialBlocks'> }>(`/articles/${encodeURIComponent(articleId)}/translations`, {
      method: 'POST', headers: { 'Idempotency-Key': `${articleId}:zh-CN:${Date.now()}` }, body: JSON.stringify({ targetLocale: 'zh-CN' }),
    });
    return { ...response.data, content: '', partialBlocks: [] };
  },
  async retry(translationId: string): Promise<RemoteTranslation> {
    const response = await apiRequest<{ data: Omit<RemoteTranslation, 'content' | 'partialBlocks'> }>(`/translations/${encodeURIComponent(translationId)}/retry`, {
      method: 'POST', headers: { 'Idempotency-Key': `${translationId}:retry:${Date.now()}` },
    });
    return { ...response.data, content: '', partialBlocks: [] };
  },
};
