import { Alert, FlatList, Keyboard, Pressable, StyleSheet, Text, View } from 'react-native';
import { SearchField } from '@/components/SearchField';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ArticleRow } from '@/components/ArticleRow';
import { IconButton } from '@/components/IconButton';
import { QueryState } from '@/components/QueryState';
import { ListLoadingIndicator } from '@/components/ListLoadingIndicator';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { articleRepo } from '@/api/repositories';
import { t } from '@/i18n';
import { refreshAllFeeds } from '@/services/remoteRss';
import { useAppStore } from '@/store/appStore';
import type { ArticleFilter } from '@/types';
import { useThemeColors } from '@/utils/theme';
import { screenStyles } from './screenStyles';
import { useDesktopLayout } from '@/hooks/useDesktopLayout';
import { DesktopArticleLayout } from '@/components/DesktopArticleLayout';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useRoutedArticleSelection } from '@/hooks/useRoutedArticleSelection';
import { ArticleDetailScreen } from '@/screens/ArticleDetailScreen';
import { articlePageItems, articlePageTotal, useArticlePages } from '@/hooks/useArticlePages';

export function TodayScreen() {
  const queryClient = useQueryClient();
  const { filter, setFilter } = useAppStore();
  const themeColors = useThemeColors();
  const desktop = useDesktopLayout();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const { selectedArticleId, selectArticle } = useRoutedArticleSelection('today');
  const debouncedQuery = useDebouncedValue(query);
  const articles = useArticlePages({
    queryKey: ['articles', filter, debouncedQuery],
    filter,
    query: debouncedQuery,
  });
  const refresh = useMutation({
    mutationFn: refreshAllFeeds,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['articles'] }),
    onError: (error) => Alert.alert(t('refreshFailed'), error instanceof Error ? error.message : t('soonRetry')),
  });
  const toggleStar = useMutation({
    mutationFn: async (id: string) => {
      const article = await articleRepo.get(id);
      if (article) await articleRepo.setStarred(id, !article.isStarred);
    },
    onSuccess: () => {
      
      queryClient.invalidateQueries({ queryKey: ['articles'] });
    },
  });
  const data = articlePageItems(articles.data);
  const total = articlePageTotal(articles.data);

  if (!desktop && selectedArticleId) {
    return <ArticleDetailScreen articleId={selectedArticleId} onClose={() => selectArticle(null)} />;
  }

  return (
    <SafeAreaView style={[screenStyles.safe, { backgroundColor: themeColors.background }]}>
      <View style={[screenStyles.header, desktop && screenStyles.desktopHeader]}>
        {searching && !desktop ? (
          <SearchField
            autoFocus
            value={query}
            onChangeText={setQuery}
            placeholder={t('search')}
            onEscape={() => { setQuery(''); setSearching(false); }}
          />
        ) : (
          <Text style={[screenStyles.title, { color: themeColors.text }]}>{t('today')}</Text>
        )}
        {searching && !desktop ? <Pressable style={styles.searchCancel} onPress={() => { setQuery(''); setSearching(false); }}><Text style={{ color: themeColors.blue }}>{t('cancel')}</Text></Pressable> : <IconButton name="refresh-outline" label={t('refresh')} loading={refresh.isPending} showFocusBorder={false} onPress={() => refresh.mutate()} />}
        {desktop ? <SearchField value={query} onChangeText={setQuery} placeholder={t('search')} style={styles.desktopSearch} /> : !searching ? <IconButton name="search-outline" label={t('search')} onPress={() => setSearching(true)} /> : null}
      </View>
      <DesktopArticleLayout enabled={desktop} selectedArticleId={selectedArticleId} onCloseArticle={() => selectArticle(null)}>
      <View style={screenStyles.flex} onTouchStart={() => searching && Keyboard.dismiss()}>
        <SegmentedTabs<ArticleFilter>
          value={filter}
          onChange={setFilter}
          items={[
            { label: t('all'), value: 'all', count: filter === 'all' ? total : undefined },
            { label: t('unread'), value: 'unread', count: filter === 'unread' ? total : undefined },
            { label: t('starred'), value: 'starred', count: filter === 'starred' ? total : undefined },
          ]}
        />
        {articles.isLoading ? (
          <QueryState title={t('articlesLoading')} loading />
        ) : articles.isError ? (
          <QueryState title={t('articleLoadFailed')} message={articles.error instanceof Error ? articles.error.message : t('soonRetry')} actionLabel={t('retry')} onAction={() => articles.refetch()} />
        ) : (
          <>{articles.isFetching && !articles.isFetchingNextPage && data.length > 0 && <ListLoadingIndicator label={t('articlesLoading')} />}
          <FlatList
            data={data}
            contentContainerStyle={[screenStyles.content, desktop && screenStyles.desktopContent]}
            keyExtractor={(item) => item.id}
            onEndReached={() => { if (articles.hasNextPage && !articles.isFetchingNextPage) void articles.fetchNextPage(); }}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={<QueryState title={t('noArticles')} message={t('noArticlesMessage')} actionLabel={refresh.isPending ? t('refreshing') : t('refresh')} onAction={() => refresh.mutate()} />}
            ListFooterComponent={articles.isFetchingNextPage ? <ListLoadingIndicator label={t('articlesLoading')} footer /> : null}
            renderItem={({ item }) => (
              <ArticleRow
                article={item}
                selected={selectedArticleId === item.id}
                hidePreviewActions={desktop && Boolean(selectedArticleId)}
                onPress={() => selectArticle(item.id)}
                onToggleStar={() => toggleStar.mutate(item.id)}
              />
            )}
          /></>
        )}
      </View>
      </DesktopArticleLayout>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  desktopSearch: { width: 280, flex: 0, marginLeft: 16 },
  searchCancel: { marginLeft: 12 },
});
