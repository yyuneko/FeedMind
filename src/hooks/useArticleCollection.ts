import { useInfiniteQuery } from '@tanstack/react-query';
import { articleRepo, type Page } from '@/api/repositories';
import { getLocale } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { Article, ArticleListCriteria } from '@/types';

export const articleCollectionKey = (criteria: ArticleListCriteria) => [
  'articles', 'collection', criteria.collection.kind,
  criteria.collection.kind === 'category' ? criteria.collection.categoryId : '',
  criteria.collection.kind === 'feed' ? criteria.collection.sourceId : '',
  criteria.unreadOnly, criteria.tagKey ?? '', criteria.query.trim(), 'title-locale', getLocale(),
] as const;

export function useArticleCollection(criteria: ArticleListCriteria) {
  useAppStore((state) => state.languageMode);
  return useInfiniteQuery({
    queryKey: articleCollectionKey(criteria),
    queryFn: ({ pageParam }) => articleRepo.pageCollection(criteria, pageParam, 100),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
    placeholderData: (previousData) => previousData,
  });
}

export const collectionItems = (data?: { pages: Page<Article>[] }) => data?.pages.flatMap((item) => item.items) ?? [];
export const collectionTotal = (data?: { pages: Page<Article>[] }) => data?.pages[0]?.total ?? 0;
