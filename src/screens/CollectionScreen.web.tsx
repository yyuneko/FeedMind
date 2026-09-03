import { Alert, FlatList, StyleSheet, View } from 'react-native';
import { useMemo } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArticleRow } from '@/components/ArticleRow';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { QueryState } from '@/components/QueryState';
import { ListLoadingIndicator } from '@/components/ListLoadingIndicator';
import { ArticleCollectionToolbar } from '@/components/ArticleCollectionToolbar';
import { articleRepo } from '@/api/repositories';
import { collectionItems, useArticleCollection } from '@/hooks/useArticleCollection';
import { useRefreshOnFocus } from '@/hooks/useRefreshOnFocus';
import { updateArticleCaches } from '@/utils/articleCache';
import { collectionPath } from '@/utils/collectionRoute';
import { confirmDestructiveAction } from '@/utils/confirmAction';
import type { ArticleCollection, ArticleListCriteria } from '@/types';
import { t } from '@/i18n';
import { spacing, useThemeColors } from '@/utils/theme';

export function CollectionScreen({ collection }: { collection: ArticleCollection }) {
  const colors = useThemeColors();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{ unread?: string; tag?: string; q?: string; article?: string }>();
  const activeTagKey = params.tag && params.tag !== 'undefined' ? params.tag : undefined;
  const criteria: ArticleListCriteria = useMemo(() => ({ collection, unreadOnly: params.unread === '1', tagKey: activeTagKey, query: params.q ?? '' }), [activeTagKey, collection, params.q, params.unread]);
  const articles = useArticleCollection(criteria);
  const items = collectionItems(articles.data);
  useRefreshOnFocus([{ hasData: Boolean(articles.data), isFetching: articles.isFetching, refetch: articles.refetch }]);

  const toggleStar = useMutation({
    mutationFn: ({ id, next }: { id: string; next: boolean }) => articleRepo.setStarred(id, next),
    onMutate: ({ id, next }) => updateArticleCaches(queryClient, id, { isStarred: next }),
  });
  const removeArticle = useMutation({ mutationFn: articleRepo.remove, onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: ['articles'] });
    void queryClient.invalidateQueries({ queryKey: ['library-tree'] });
  }, onError: (error) => Alert.alert(t('deleteFailed'), error instanceof Error ? error.message : t('soonRetry')) });
  const confirmRemoveArticle = (id: string, title: string) => confirmDestructiveAction({ title: t('deleteArticle'), message: t('deleteArticleConfirm', { title }), cancelText: t('cancel'), confirmText: t('delete'), onConfirm: () => removeArticle.mutate(id) });
  const updateCriteria = (patch: Partial<Pick<ArticleListCriteria, 'unreadOnly' | 'tagKey'>>) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'tagKey') && !patch.tagKey) {
      router.replace({ pathname: collectionPath(collection), params: {
        ...(params.unread ? { unread: params.unread } : {}),
        ...(params.q ? { q: params.q } : {}),
        ...(params.article ? { article: params.article } : {}),
      } } as never);
      return;
    }
    router.setParams({
      unread: patch.unreadOnly === undefined ? params.unread : patch.unreadOnly ? '1' : undefined,
      tag: Object.prototype.hasOwnProperty.call(patch, 'tagKey') ? patch.tagKey : activeTagKey,
    });
  };
  const submitQuery = (query: string) => {
    const value = query.trim();
    if (value) {
      router.setParams({ q: value });
      return;
    }
    router.replace({ pathname: collectionPath(collection), params: {
      ...(params.unread ? { unread: params.unread } : {}),
      ...(activeTagKey ? { tag: activeTagKey } : {}),
      ...(params.article ? { article: params.article } : {}),
    } } as never);
  };
  const selectArticle = (id: string) => router.push({ pathname: collectionPath(collection), params: { ...params, article: id } } as never);
  const closeArticle = () => {
    const { article: _article, ...listParams } = params;
    router.replace({ pathname: collectionPath(collection), params: listParams } as never);
    void articles.refetch();
  };
  const selectedIndex = params.article ? items.findIndex((item) => item.id === params.article) : -1;
  const replaceArticle = (index: number) => { const item = items[index]; if (item) router.setParams({ article: item.id }); };
  const nextArticle = async () => {
    if (selectedIndex < items.length - 1) return replaceArticle(selectedIndex + 1);
    if (!articles.hasNextPage || articles.isFetchingNextPage) return;
    const result = await articles.fetchNextPage();
    const nextItems = collectionItems(result.data);
    const current = nextItems.findIndex((item) => item.id === params.article);
    if (current >= 0 && nextItems[current + 1]) router.setParams({ article: nextItems[current + 1].id });
  };
  const hasData = items.length > 0;
  const emptyTitle = collection.kind === 'recent' ? t('noRecentArticles') : collection.kind === 'saved' ? t('noSaved') : t('noArticles');
  return <View style={[styles.page, { backgroundColor: colors.background }]}>
    <View style={[styles.workspace, params.article && styles.workspaceWithReader]}>
      <View style={[styles.listPane, !params.article && styles.listPaneWide, params.article && { borderRightColor: colors.border }]}>
        <ArticleCollectionToolbar criteria={criteria} onCriteriaChange={updateCriteria} onQuerySubmit={submitQuery}
          onRefresh={() => void articles.refetch()} refreshing={articles.isFetching && !articles.isFetchingNextPage} />
        <View style={styles.listViewport}>
          {articles.isLoading && !hasData ? <QueryState title={t('articlesLoading')} loading /> : articles.isError && !hasData
            ? <QueryState title={t('articleLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
            : <FlatList data={items} {...({ dataSet: { scrollbar: 'feedmind' } } as any)} keyExtractor={(item) => item.id} contentContainerStyle={styles.listContent}
              onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }} onEndReachedThreshold={0.5}
              ListEmptyComponent={<QueryState title={emptyTitle} message={collection.kind === 'recent' ? t('recentThirtyDayHint') : undefined} />}
              renderItem={({ item }) => <ArticleRow article={item} compact={Boolean(params.article)} selected={params.article === item.id}
                query={criteria.query} hidePreviewActions={Boolean(params.article)} onPress={() => selectArticle(item.id)} onTagPress={(tag) => updateCriteria({ tagKey: tag.key })}
                onToggleStar={() => toggleStar.mutate({ id: item.id, next: !item.isStarred })} onDelete={() => confirmRemoveArticle(item.id, item.title)} />} />}
          {articles.isFetching && !articles.isFetchingNextPage && hasData ? <ListLoadingIndicator label={t('articlesLoading')} /> : null}
          {articles.isFetchingNextPage ? <ListLoadingIndicator label={t('articlesLoading')} pagination /> : null}
        </View>
      </View>
      {params.article ? <View style={styles.readerPane}>
        <ArticleDetailScreen key={params.article} articleId={params.article} embedded onClose={closeArticle}
          onPrevious={() => replaceArticle(selectedIndex - 1)} previousDisabled={selectedIndex <= 0}
          onNext={() => void nextArticle()} nextDisabled={selectedIndex < 0 || (selectedIndex >= items.length - 1 && !articles.hasNextPage)}
          onTagPress={(tag) => router.replace({ pathname: collectionPath(collection), params: { unread: params.unread, q: params.q, tag: tag.key } } as never)} />
      </View> : null}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, minWidth: 812 },
  workspace: { flex: 1, flexDirection: 'row', justifyContent: 'center' },
  workspaceWithReader: { justifyContent: 'flex-start' },
  listPane: { flex: 0, width: 420, minWidth: 380, borderRightWidth: StyleSheet.hairlineWidth },
  listPaneWide: { flex: 1, width: '100%', borderRightWidth: 0 },
  listViewport: { flex: 1, position: 'relative' },
  listContent: { width: '100%', paddingHorizontal: spacing.xl, paddingBottom: spacing.section },
  readerPane: { flex: 1, minWidth: 560 },
});
