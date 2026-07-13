import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { articleRepo, type Page } from '@/api/repositories';
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
}: ArticlePagesOptions) => useInfiniteQuery({
  queryKey,
  queryFn: ({ pageParam }) => articleRepo.page(filter, category, feedId, query, pageParam, ARTICLE_PAGE_SIZE),
  initialPageParam: 1,
  getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
  enabled,
});

export const articlePageItems = (data?: { pages: Page<Article>[] }) => data?.pages.flatMap((page) => page.items) ?? [];

export const articlePageTotal = (data?: { pages: Page<Article>[] }) => data?.pages[0]?.total ?? 0;
