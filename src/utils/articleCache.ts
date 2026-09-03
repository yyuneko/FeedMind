import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Page } from '@/api/repositories';
import type { Article, LibraryCategory, LibraryFeed, LibraryTree } from '@/types';

export function updateArticleCaches(queryClient: QueryClient, id: string, patch: Partial<Article>) {
  let previous = queryClient.getQueriesData<Article | null>({ queryKey: ['article', id] }).map(([, item]) => item).find(Boolean) ?? undefined;
  if (!previous) {
    for (const [, data] of queryClient.getQueriesData<InfiniteData<Page<Article>>>({ queryKey: ['articles', 'collection'] })) {
      previous = data?.pages.flatMap((page) => page.items).find((item) => item.id === id);
      if (previous) break;
    }
  }
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['articles', 'collection'] })) {
    const key = query.queryKey;
    const remove = (key[2] === 'saved' && patch.isStarred === false) || (key[5] === true && patch.isRead === true);
    queryClient.setQueryData<InfiniteData<Page<Article>>>(key, (data: InfiniteData<Page<Article>> | undefined) => {
      if (!data?.pages) return data;
      const contained = data.pages.some((page: Page<Article>) => page.items.some((item: Article) => item.id === id));
      return { ...data, pages: data.pages.map((page: Page<Article>) => {
        const items = remove ? page.items.filter((item: Article) => item.id !== id) : page.items.map((item: Article) => item.id === id ? { ...item, ...patch } : item);
        return { ...page, items, total: contained && remove ? Math.max(0, page.total - 1) : page.total };
      }) };
    });
  }
  queryClient.setQueriesData<Article | null>({ queryKey: ['article', id] }, (item: Article | null | undefined) => item ? { ...item, ...patch } : item);
  if (previous && typeof patch.isRead === 'boolean' && previous.isRead !== patch.isRead) {
    const delta = patch.isRead ? -1 : 1;
    queryClient.setQueryData<LibraryTree>(['library-tree'], (tree: LibraryTree | undefined) => tree ? {
      ...tree,
      unreadCount: Math.max(0, tree.unreadCount + delta),
      categories: tree.categories.map((category: LibraryCategory) => {
        const contains = category.feeds.some((feed: LibraryFeed) => feed.id === previous!.feedId);
        return { ...category, unreadCount: contains ? Math.max(0, category.unreadCount + delta) : category.unreadCount,
          feeds: category.feeds.map((feed: LibraryFeed) => feed.id === previous!.feedId ? { ...feed, unreadCount: Math.max(0, feed.unreadCount + delta) } : feed) };
      }),
      uncategorized: { ...tree.uncategorized,
        unreadCount: tree.uncategorized.feeds.some((feed: LibraryFeed) => feed.id === previous!.feedId) ? Math.max(0, tree.uncategorized.unreadCount + delta) : tree.uncategorized.unreadCount,
        feeds: tree.uncategorized.feeds.map((feed: LibraryFeed) => feed.id === previous!.feedId ? { ...feed, unreadCount: Math.max(0, feed.unreadCount + delta) } : feed) },
    } : tree);
  }
}
