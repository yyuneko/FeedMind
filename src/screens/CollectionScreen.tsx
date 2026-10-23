import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArticleRow } from '@/components/ArticleRow';
import { ArticleCollectionToolbar } from '@/components/ArticleCollectionToolbar';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { ListLoadingIndicator } from '@/components/ListLoadingIndicator';
import { articleRepo, libraryRepo } from '@/api/repositories';
import { collectionItems, useArticleCollection } from '@/hooks/useArticleCollection';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { updateArticleCaches } from '@/utils/articleCache';
import type { ArticleCollection, ArticleListCriteria, LibraryCategory, LibraryFeed } from '@/types';
import { t } from '@/i18n';
import { useThemeColors } from '@/utils/theme';
import { collectionPath } from '@/utils/collectionRoute';
import { confirmDestructiveAction } from '@/utils/confirmAction';
import { screenStyles } from './screenStyles';

export function CollectionScreen({ collection }: { collection: ArticleCollection }) {
  const colors = useThemeColors(); const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ unread?: string; tag?: string; q?: string }>();
  const activeTagKey = params.tag && params.tag !== 'undefined' ? params.tag : undefined;
  const criteria: ArticleListCriteria = { collection, unreadOnly: params.unread === '1', tagKey: activeTagKey, query: params.q ?? '' };
  const articles = useArticleCollection(criteria); const items = collectionItems(articles.data);
  const tree = useQuery({ queryKey: ['library-tree'], queryFn: libraryRepo.tree, staleTime: Infinity });
  useRefreshOnFocus([{ hasData: Boolean(articles.data), isFetching: articles.isFetching, refetch: articles.refetch }]);
  const toggleStar = useMutation({ mutationFn: ({ id, next }: { id: string; next: boolean }) => articleRepo.setStarred(id, next), onMutate: ({ id, next }) => updateArticleCaches(queryClient, id, { isStarred: next }) });
  const removeArticle = useMutation({ mutationFn: articleRepo.remove, onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['articles'] });
    void queryClient.invalidateQueries({ queryKey: ['library-tree'] });
  }, onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')) });
  const confirmRemoveArticle = (id: string, title: string) => confirmDestructiveAction({ title: t('deleteArticle'), message: t('deleteArticleConfirm', { title }), cancelText: t('cancel'), confirmText: t('delete'), onConfirm: () => removeArticle.mutate(id) });
  const title = collection.kind === 'all' ? t('all') : collection.kind === 'recent' ? t('recentReading') : collection.kind === 'saved' ? t('saved')
    : collection.kind === 'category' ? tree.data?.categories.find((item: LibraryCategory) => item.id === collection.categoryId)?.name ?? t('categories')
      : ([...(tree.data?.categories.flatMap((item: LibraryCategory) => item.feeds) ?? []), ...(tree.data?.uncategorized.feeds ?? [])] as LibraryFeed[]).find((item: LibraryFeed) => item.id === collection.sourceId)?.title ?? t('feeds');
  const updateCriteria = (patch: Partial<Pick<ArticleListCriteria, 'unreadOnly' | 'tagKey'>>) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'tagKey') && !patch.tagKey) {
      router.replace({ pathname: collectionPath(collection) as never, params: {
        ...(params.unread ? { unread: params.unread } : {}),
        ...(params.q ? { q: params.q } : {}),
      } } as never);
      return;
    }
    router.setParams({
      unread: patch.unreadOnly === undefined ? params.unread : patch.unreadOnly ? '1' : undefined,
      tag: Object.prototype.hasOwnProperty.call(patch, 'tagKey') ? patch.tagKey : activeTagKey,
    });
  };
  const openArticle = (id: string) => router.push({ pathname: '/article/[id]', params: {
    id, from: collectionPath(collection), fromUnread: params.unread, fromQuery: params.q,
  } });
  const submitQuery = (query: string) => {
    const value = query.trim();
    if (value) {
      router.setParams({ q: value });
      return;
    }
    router.replace({ pathname: collectionPath(collection) as never, params: {
      ...(params.unread ? { unread: params.unread } : {}),
      ...(activeTagKey ? { tag: activeTagKey } : {}),
    } } as never);
  };
  return <SafeAreaView style={[screenStyles.safe, { backgroundColor: colors.background }]}>
    <View style={screenStyles.header}>
      {collection.kind === 'category' || collection.kind === 'feed' ? <IconButton name="chevron-back" label={t('back')} onPress={() => router.back()} /> : null}
      <Text numberOfLines={1} style={[screenStyles.title, { color: colors.text }]}>{title}</Text>
    </View>
    <ArticleCollectionToolbar compact criteria={criteria} onCriteriaChange={updateCriteria}
      onQuerySubmit={submitQuery}
      onRefresh={() => void articles.refetch()} refreshing={articles.isFetching && !articles.isFetchingNextPage} />
    <View style={styles.viewport}>
      {articles.isLoading && !items.length ? <QueryState title={t('articlesLoading')} loading /> : <FlatList data={items} keyExtractor={(item) => item.id}
        contentContainerStyle={screenStyles.content} onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }} onEndReachedThreshold={0.5}
        ListEmptyComponent={<QueryState title={collection.kind === 'recent' ? t('noRecentArticles') : collection.kind === 'saved' ? t('noSaved') : t('noArticles')} message={collection.kind === 'recent' ? t('recentThirtyDayHint') : undefined} />}
        renderItem={({ item }) => <ArticleRow article={item} query={criteria.query} onPress={() => openArticle(item.id)}
          onToggleStar={() => toggleStar.mutate({ id: item.id, next: !item.isStarred })} onDelete={() => confirmRemoveArticle(item.id, item.title)} />} />}
      {articles.isFetching && !articles.isFetchingNextPage && items.length ? <ListLoadingIndicator label={t('articlesLoading')} /> : null}
      {articles.isFetchingNextPage ? <ListLoadingIndicator label={t('articlesLoading')} pagination /> : null}
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  viewport: { flex: 1, position: 'relative' },
});
