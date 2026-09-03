import { Platform } from 'react-native';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { QueryState } from '@/components/QueryState';
import { articleRepo, libraryRepo } from '@/api/repositories';
import type { LibraryCategory, LibraryFeed } from '@/types';
import { t } from '@/i18n';
import { collectionFromPath, collectionPath } from '@/utils/collectionRoute';

export default function ArticleRoute() {
  const { id, origin, from, fromUnread, fromQuery } = useLocalSearchParams<{ id: string; origin?: string; from?: string; fromUnread?: string; fromQuery?: string }>();
  const needsContext = Platform.OS === 'web' && (origin === 'feeds' || origin === 'category');
  const article = useQuery({ queryKey: ['article', id], queryFn: () => articleRepo.get(id), enabled: needsContext });
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity, enabled: needsContext });
  if (Platform.OS !== 'web') return <ArticleDetailScreen onTagPress={(tag) => {
    const sourceCollection = collectionFromPath(from ?? '') ?? { kind: 'all' as const };
    router.replace({ pathname: collectionPath(sourceCollection) as never, params: {
      unread: fromUnread === '1' ? '1' : undefined,
      q: fromQuery || undefined,
      tag: tag.key,
    } } as never);
  }} />;
  if (needsContext && (article.isLoading || tree.isLoading)) return <QueryState title={t('articlesLoading')} loading />;
  let pathname = origin === 'saved' ? '/saved' : origin === 'recent' ? '/recent' : '/all';
  if (origin === 'category' && article.data?.feedCategory) {
    const category = tree.data?.categories.find((item: LibraryCategory) => item.name.toLocaleLowerCase() === article.data!.feedCategory!.toLocaleLowerCase());
    if (category) pathname = `/category/${category.id}`;
  }
  if (origin === 'feeds' && article.data) {
    const feeds = [...(tree.data?.categories.flatMap((item: LibraryCategory) => item.feeds) ?? []), ...(tree.data?.uncategorized.feeds ?? [])] as LibraryFeed[];
    const feed = feeds.find((item) => item.id === article.data!.feedId || item.id === article.data!.feedRecordId || item.subscriptionId === article.data!.feedRecordId);
    if (feed) pathname = `/feed/${feed.id}`;
  }
  return <Redirect href={{ pathname: pathname as never, params: { article: id } }} />;
}
