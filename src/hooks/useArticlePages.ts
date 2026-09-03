import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { articleRepo, type Page } from '@/api/repositories';
import { getLocale } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { Article, ArticleFilter } from '@/types';

const ARTICLE_PAGE_SIZE = 100;

type ArticlePagesOptions = {
  queryKey: QueryKey;
  filter?: ArticleFilter;
  category?: string;
  feedId?: string;
  query?: string;
  enabled?: boolean;
};

export const useArticlePages = ({
  queryKey,
  filter = 'all',
  category,
  feedId,
  query = '',
  enabled = true,
}: ArticlePagesOptions) => {
  useAppStore((state) => state.languageMode);
  const locale = getLocale();
  return useInfiniteQuery({
    queryKey: [...queryKey, 'title-locale', locale],
    queryFn: ({ pageParam }) => articleRepo.page(filter, category, feedId, query, pageParam, ARTICLE_PAGE_SIZE),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
    placeholderData: (previousData) => previousData,
    enabled,
  });
};

export const articlePageItems = (data?: { pages: Page<Article>[] }) => data?.pages.flatMap((page) => page.items) ?? [];

export const articlePageTotal = (data?: { pages: Page<Article>[] }) => data?.pages[0]?.total ?? 0;
