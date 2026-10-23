import { useEffect, useMemo } from 'react';
import { useGlobalSearchParams, usePathname } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { articleRepo, libraryRepo } from '@/api/repositories';
import { getLocale, t } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { LibraryCategory, LibraryFeed } from '@/types';
import { getArticleDisplayTitle } from '@/utils/articlePresentation';

const firstParam = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export function WebDocumentTitle({ enabled = true }: { enabled?: boolean }) {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ article?: string | string[]; id?: string | string[] }>();
  const languageMode = useAppStore((state) => state.languageMode);
  const articleId = firstParam(params.article) ?? (pathname.startsWith('/article/') ? firstParam(params.id) : undefined);
  const needsLibraryTree = pathname.startsWith('/feed/') || pathname.startsWith('/category/');
  const article = useQuery({
    queryKey: ['article', articleId, 'title-locale', languageMode, getLocale()],
    queryFn: () => articleRepo.get(articleId!),
    enabled: enabled && Boolean(articleId),
  });
  const tree = useQuery({
    queryKey: ['library-tree'],
    queryFn: libraryRepo.tree,
    staleTime: Infinity,
    enabled: enabled && needsLibraryTree,
  });

  const title = useMemo(() => {
    if (!enabled) return 'FeedMind';
    if (articleId && article.data) return getArticleDisplayTitle(article.data) || 'FeedMind';

    if (pathname.startsWith('/feed/')) {
      const sourceId = decodeURIComponent(pathname.slice('/feed/'.length).split('/')[0] ?? '');
      const feeds = [
        ...(tree.data?.categories.flatMap((category: LibraryCategory) => category.feeds) ?? []),
        ...(tree.data?.uncategorized.feeds ?? []),
      ] as LibraryFeed[];
      return feeds.find((feed) => feed.id === sourceId || feed.subscriptionId === sourceId)?.title ?? t('feeds');
    }

    if (pathname.startsWith('/category/')) {
      const categoryId = decodeURIComponent(pathname.slice('/category/'.length).split('/')[0] ?? '');
      if (categoryId === 'uncategorized') return t('uncategorized');
      return tree.data?.categories.find((category: LibraryCategory) => category.id === categoryId)?.name ?? t('categories');
    }

    if (pathname === '/all') return t('all');
    if (pathname === '/recent') return t('recentReading');
    if (pathname === '/saved') return t('saved');
    if (pathname === '/subscriptions') return t('feeds');
    if (pathname === '/settings') return t('settings');
    if (pathname === '/categories') return t('categories');
    if (pathname === '/help') return t('help');
    if (pathname === '/settings/sources' || pathname === '/source-connections') return '数据源连接';
    if (pathname === '/reader-access') return '第三方阅读器接入';
    return 'FeedMind';
  }, [article.data, articleId, enabled, languageMode, pathname, tree.data]);

  useEffect(() => {
    if (typeof document !== 'undefined') document.title = title;
  }, [title]);

  return null;
}
